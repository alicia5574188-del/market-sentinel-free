/**
 * dynamic-v1: slow, resumable history backfill plan (pure). One request at a time, at most one every `minGapMs` (default 15 s,
 * 4 a minute), external venues only (Bybit → OKX → KuCoin on failure); a venue answering 429 / 403 is skipped for a while
 * (all three refusing → everything pauses), exponential backoff per series.
 * Order: first the newest page of every series (≈ 40 min for ~30 coins: the latest 3.5 days of 5m, 10 days of 15m, 6 weeks of
 * 1h, …), then each series backwards, short-term first: BTC/ETH daily + 1h → 15m → 5m → 1h → BTC/ETH 1m → 4h → daily.
 * Live tails: 5m bars come from the worker's own external 5m refresh (no request here) and 15m / 1h are built from them; a
 * request tail is made only when a series falls behind (no live feed for it), and for 4h / 1d / 1m after their bar closes.
 * The plan state is small JSON (saved in D1 meta), so a restart / redeploy resumes where it stopped.
 */
import {IV_SEC,type Iv} from "./series.ts";
import {PAGE,VENUES,type Venue} from "./venues.ts";
const MAJORS=new Set(["BTC_USDT","ETH_USDT"]);
export const BACKFILL={
  minGapMs:15_000,
  /** history depth per interval (days); BTC/ETH keep longer 5m and are the only ones with 1m */
  depthDays:{"1d":1500,"4h":730,"1h":180,"15m":150,"5m":75,"1m":14} as Record<Iv,number>,
  majorDepthDays:{"5m":120} as Partial<Record<Iv,number>>,
  /** phases: [interval, majors only] in order */
  phases:[["1d",true],["1h",true],["15m",false],["5m",false],["1h",false],["1m",true],["4h",false],["1d",false]] as [Iv,boolean][],
  /** a closed bar is fetched this long after it closed */
  tailGraceMs:90_000,
  /** request tails: how often at most per series (ms); short intervals only when they fell this far behind (the live feed covers them) */
  tailEveryMs:{"1d":0,"4h":0,"1h":3_600_000,"15m":30*60_000,"5m":20*60_000,"1m":30*60_000} as Record<Iv,number>,
  staleMs:{"1h":2*3_600_000,"15m":45*60_000,"5m":25*60_000} as Partial<Record<Iv,number>>,
  retryBaseMs:30_000,retryMaxMs:30*60_000,pause429Ms:120_000,pauseMaxMs:30*60_000,
  maxSymbols:40,
} as const;
export const ORDER_IV:readonly Iv[]=["1d","1h","15m","5m","1m","4h"];
export const depthOf=(sym:string,iv:Iv)=>(MAJORS.has(sym)?BACKFILL.majorDepthDays[iv]:undefined)??BACKFILL.depthDays[iv];
/** intervals tracked for a symbol */
export const ivsOf=(sym:string):Iv[]=>MAJORS.has(sym)?["1d","4h","1h","15m","5m","1m"]:["1d","4h","1h","15m","5m"];
export type SeriesPlan={sym:string;iv:Iv;oldest:number|null;newest:number|null;done:boolean;pages:number;bars:number;
  fails:number;retryAt:number;venue:number;lastError:string|null;doneAt:number|null;lastTailAt?:number};
export type BackfillState={v:1;series:Record<string,SeriesPlan>;lastReqAt:number;pauseUntil:number;pause429:number;
  day:string;reqToday:number;reqTotal:number;okTotal:number;errTotal:number;startedAt:number|null;
  /** a venue that answered 429 / 403 is skipped by every series until then (the others keep going) */
  venueBlock?:Partial<Record<Venue,number>>};
export type Job={key:string;sym:string;iv:Iv;kind:"back"|"tail";venue:Venue;endSec:number|null;limit:number};
export const seriesKey=(sym:string,iv:Iv)=>`${sym}|${iv}`;
export const initialBackfill=():BackfillState=>({v:1,series:{},lastReqAt:0,pauseUntil:0,pause429:0,day:"",reqToday:0,reqTotal:0,okTotal:0,errTotal:0,startedAt:null,venueBlock:{}});
export function normalizeBackfill(raw:unknown):BackfillState{
  const b=raw as BackfillState|null;if(!b||b.v!==1||typeof b.series!=="object")return initialBackfill();
  return {...initialBackfill(),...b,series:Object.fromEntries(Object.entries(b.series).filter(([,s])=>s&&typeof s.sym==="string"&&s.iv in IV_SEC))};
}
/** BTC, ETH first, then the given universe (deduplicated, capped) */
export function trackedSymbols(universe:readonly string[]){
  return [...new Set(["BTC_USDT","ETH_USDT",...universe.filter(s=>s.endsWith("_USDT"))])].slice(0,BACKFILL.maxSymbols);
}
/** every tracked (symbol, interval) in backfill order */
export function trackedSeries(universe:readonly string[]):{sym:string;iv:Iv}[]{
  const syms=trackedSymbols(universe),out:{sym:string;iv:Iv}[]=[],seen=new Set<string>();
  for(const [iv,majors] of BACKFILL.phases)for(const sym of syms){if(majors&&!MAJORS.has(sym))continue;if(!ivsOf(sym).includes(iv))continue;
    const k=seriesKey(sym,iv);if(!seen.has(k)){seen.add(k);out.push({sym,iv});}}
  return out;
}
/** start (s) of the last bar that is closed at `nowMs` */
export const lastClosedStart=(iv:Iv,nowMs:number)=>Math.floor(nowMs/1000/IV_SEC[iv])*IV_SEC[iv]-IV_SEC[iv];
const plan=(st:BackfillState,sym:string,iv:Iv)=>st.series[seriesKey(sym,iv)]??=({sym,iv,oldest:null,newest:null,done:false,pages:0,bars:0,fails:0,retryAt:0,venue:0,lastError:null,doneAt:null});
function venueFor(st:BackfillState,p:{venue:number},nowMs:number):Venue|null{
  for(let k=0;k<VENUES.length;k++){const v=VENUES[(p.venue+k)%VENUES.length]!;if((st.venueBlock?.[v]??0)<=nowMs)return v;}return null;
}
/** the live feed delivered bars (no request): keeps the series' newest current so no request tail is made */
export function noteFeed(st:BackfillState,sym:string,iv:Iv,first:number,last:number){
  const p=st.series[seriesKey(sym,iv)];if(!p)return;p.newest=p.newest==null?last:Math.max(p.newest,last);p.oldest=p.oldest==null?first:Math.min(p.oldest,first);
}
/** the next request, or null while pacing / paused / nothing due. Tail refreshes come before older history. */
export function nextJob(st:BackfillState,nowMs:number,universe:readonly string[],opts:{minGapMs?:number}={}):Job|null{
  if(nowMs<st.pauseUntil||nowMs-st.lastReqAt<(opts.minGapMs??BACKFILL.minGapMs))return null;
  const list=trackedSeries(universe);
  for(const {sym,iv} of list){
    const p=st.series[seriesKey(sym,iv)];if(!p||p.newest==null||p.retryAt>nowMs)continue;
    const want=lastClosedStart(iv,nowMs),closedAt=(want+IV_SEC[iv])*1000,grace=Math.min(BACKFILL.tailGraceMs,IV_SEC[iv]*1000/3);
    if(!(p.newest<want&&nowMs>=closedAt+grace))continue;
    const stale=BACKFILL.staleMs[iv];
    if(stale!=null&&nowMs-(p.newest+IV_SEC[iv])*1000<stale)continue;// the live feed is expected to bring it
    if(nowMs-(p.lastTailAt??0)<BACKFILL.tailEveryMs[iv])continue;
    const venue=venueFor(st,p,nowMs);if(!venue)return null;const gap=Math.ceil((want-p.newest)/IV_SEC[iv])+2;
    return {key:seriesKey(sym,iv),sym,iv,kind:"tail",venue,endSec:null,limit:Math.min(PAGE[venue],Math.max(3,gap))};
  }
  // newest first everywhere: the first (most recent) page of every series before any deeper page, so the latest regimes are
  // learned within the first hour; then each series backwards in the short-term-first order
  for(const pass of [0,1])for(const {sym,iv} of list){
    const p=plan(st,sym,iv);if(p.done||p.retryAt>nowMs||(pass===0&&p.pages>0))continue;
    const venue=venueFor(st,p,nowMs);if(!venue)return null;
    return {key:seriesKey(sym,iv),sym,iv,kind:"back",venue,endSec:p.oldest,limit:PAGE[venue]};
  }
  return null;
}
function count(st:BackfillState,nowMs:number){const d=new Date(nowMs).toISOString().slice(0,10);if(st.day!==d){st.day=d;st.reqToday=0;}
  st.reqToday++;st.reqTotal++;st.lastReqAt=nowMs;st.startedAt??=nowMs;}
/** a page arrived (bars already parsed / closed only). Returns true when this page finished the series' history. */
export function onPage(st:BackfillState,job:Job,bars:{t:number}[],nowMs:number){
  count(st,nowMs);st.okTotal++;st.pause429=0;
  const p=plan(st,job.sym,job.iv);p.venue=VENUES.indexOf(job.venue);p.fails=0;p.retryAt=0;p.lastError=null;p.pages++;p.bars+=bars.length;
  if(bars.length){const lo=bars[0]!.t,hi=bars.at(-1)!.t;p.oldest=p.oldest==null?lo:Math.min(p.oldest,lo);p.newest=p.newest==null?hi:Math.max(p.newest,hi);}
  if(job.kind==="tail"){p.lastTailAt=nowMs;return false;}
  const floor=nowMs/1000-depthOf(job.sym,job.iv)*86_400;
  const before=job.endSec,reached=p.oldest!=null&&p.oldest<=floor,stuck=bars.length===0||(before!=null&&p.oldest!=null&&p.oldest>=before);
  if(reached||stuck){p.done=true;p.doneAt=nowMs;return true;}
  return false;
}
export function onFailure(st:BackfillState,job:Job,error:unknown,nowMs:number){
  count(st,nowMs);st.errTotal++;
  const p=plan(st,job.sym,job.iv),status=(error as {status?:number})?.status;
  p.lastError=String((error as Error)?.message??error).slice(0,120);
  if(status===429||status===403){st.pause429++;const until=nowMs+Math.min(BACKFILL.pauseMaxMs,BACKFILL.pause429Ms*2**(st.pause429-1));
    (st.venueBlock??={})[job.venue]=until;
    if(VENUES.every(v=>(st.venueBlock?.[v]??0)>nowMs))st.pauseUntil=Math.min(...VENUES.map(v=>st.venueBlock![v]!));}
  p.fails++;p.venue=(VENUES.indexOf(job.venue)+1)%VENUES.length;
  p.retryAt=p.fails%VENUES.length===0?nowMs+Math.min(BACKFILL.retryMaxMs,BACKFILL.retryBaseMs*2**Math.min(8,p.fails/VENUES.length)):nowMs;
}
export type BackfillView={pct:number;done:number;total:number;bars:number;byIv:Record<string,{done:number;total:number;bars:number;from:string|null}>;
  reqToday:number;reqTotal:number;errTotal:number;pausedUntil:number|null;blocked:Venue[];startedAt:number|null;etaMin:number|null;working:string|null};
export function backfillView(st:BackfillState,universe:readonly string[],nowMs:number,minGapMs:number=BACKFILL.minGapMs):BackfillView{
  const byIv:BackfillView["byIv"]={};let done=0,total=0,bars=0,pagesLeft=0,working:string|null=null;
  for(const {sym,iv} of trackedSeries(universe)){const p=st.series[seriesKey(sym,iv)],x=(byIv[iv]??={done:0,total:0,bars:0,from:null});total++;x.total++;
    if(p?.done){done++;x.done++;}else{const covered=p?.oldest!=null?Math.max(0,(p.newest??nowMs/1000)-p.oldest)/IV_SEC[iv]:0,need=depthOf(sym,iv)*86_400/IV_SEC[iv];
      pagesLeft+=Math.ceil(Math.max(0,need-covered)/PAGE[VENUES[(p?.venue??0)%3]!]);working??=`${sym} ${iv}`;}
    const n=p?.oldest!=null&&p.newest!=null?Math.round((p.newest-p.oldest)/IV_SEC[iv])+1:0;x.bars+=n;bars+=n;
    if(p?.oldest!=null){const d=new Date(p.oldest*1000).toISOString().slice(0,10);if(!x.from||d<x.from)x.from=d;}}
  return {pct:total?done/total:0,done,total,bars,byIv,reqToday:st.reqToday,reqTotal:st.reqTotal,errTotal:st.errTotal,
    pausedUntil:st.pauseUntil>nowMs?st.pauseUntil:null,blocked:VENUES.filter(v=>(st.venueBlock?.[v]??0)>nowMs),startedAt:st.startedAt,
    etaMin:pagesLeft?Math.ceil(pagesLeft*minGapMs/60_000):0,working};
}
