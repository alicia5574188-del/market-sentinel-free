/**
 * dynamic-v1: slow, resumable history backfill plan (pure). One request at a time, at most one every `minGapMs` (default 15 s,
 * 4 a minute), external venues only (Bybit → OKX → KuCoin on failure), exponential backoff per series, a global pause on 429.
 * Order: BTC, ETH, then the universe — daily first (years), then 4h, then 1h. Once a series reached its depth (or the
 * listing start) it only refreshes its tail after each bar close. The plan state is small JSON (saved in D1 meta), so a
 * restart / redeploy resumes where it stopped.
 */
import {IV_SEC,type Iv} from "./series.ts";
import {PAGE,VENUES,type Venue} from "./venues.ts";
export const BACKFILL={
  minGapMs:15_000,
  /** history depth per interval (days) */
  depthDays:{"1d":1500,"4h":730,"1h":180} as Record<Iv,number>,
  order:["1d","4h","1h"] as Iv[],
  /** a bar is fetched this long after it closed (venues publish the closed bar within seconds) */
  tailGraceMs:90_000,
  retryBaseMs:30_000,retryMaxMs:30*60_000,pause429Ms:120_000,pauseMaxMs:30*60_000,
  maxSymbols:40,
} as const;
export type SeriesPlan={sym:string;iv:Iv;oldest:number|null;newest:number|null;done:boolean;pages:number;bars:number;
  fails:number;retryAt:number;venue:number;lastError:string|null;doneAt:number|null};
export type BackfillState={v:1;series:Record<string,SeriesPlan>;lastReqAt:number;pauseUntil:number;pause429:number;
  day:string;reqToday:number;reqTotal:number;okTotal:number;errTotal:number;startedAt:number|null;
  /** a venue that answered 429 / 403 is skipped by every series until then (the others keep going) */
  venueBlock?:Partial<Record<Venue,number>>};
export type Job={key:string;sym:string;iv:Iv;kind:"back"|"tail";venue:Venue;endSec:number|null;limit:number};
export const seriesKey=(sym:string,iv:Iv)=>`${sym}|${iv}`;
export const initialBackfill=():BackfillState=>({v:1,series:{},lastReqAt:0,pauseUntil:0,pause429:0,day:"",reqToday:0,reqTotal:0,okTotal:0,errTotal:0,startedAt:null,venueBlock:{}});
/** the series' venue, or the next one that is not blocked; null when all three are */
function venueFor(st:BackfillState,p:{venue:number},nowMs:number):Venue|null{
  for(let k=0;k<VENUES.length;k++){const v=VENUES[(p.venue+k)%VENUES.length]!;if((st.venueBlock?.[v]??0)<=nowMs)return v;}return null;
}
export function normalizeBackfill(raw:unknown):BackfillState{
  const b=raw as BackfillState|null;if(!b||b.v!==1||typeof b.series!=="object")return initialBackfill();
  return {...initialBackfill(),...b,series:Object.fromEntries(Object.entries(b.series).filter(([,s])=>s&&typeof s.sym==="string"&&s.iv in IV_SEC))};
}
/** BTC, ETH first, then the given universe (deduplicated, capped) */
export function trackedSymbols(universe:readonly string[]){
  return [...new Set(["BTC_USDT","ETH_USDT",...universe.filter(s=>s.endsWith("_USDT"))])].slice(0,BACKFILL.maxSymbols);
}
/** start (s) of the last bar that is closed at `nowMs` */
export const lastClosedStart=(iv:Iv,nowMs:number)=>Math.floor(nowMs/1000/IV_SEC[iv])*IV_SEC[iv]-IV_SEC[iv];
const plan=(st:BackfillState,sym:string,iv:Iv)=>st.series[seriesKey(sym,iv)]??=({sym,iv,oldest:null,newest:null,done:false,pages:0,bars:0,fails:0,retryAt:0,venue:0,lastError:null,doneAt:null});
/** the next request, or null while pacing / paused / nothing due. Tail refreshes come before older history. */
export function nextJob(st:BackfillState,nowMs:number,universe:readonly string[],opts:{minGapMs?:number}={}):Job|null{
  if(nowMs<st.pauseUntil||nowMs-st.lastReqAt<(opts.minGapMs??BACKFILL.minGapMs))return null;
  const syms=trackedSymbols(universe);
  // live tail for every series that has started (current universe only)
  for(const iv of BACKFILL.order)for(const sym of syms){
    const p=st.series[seriesKey(sym,iv)];if(!p||p.newest==null||p.retryAt>nowMs)continue;
    const want=lastClosedStart(iv,nowMs);
    if(p.newest<want&&nowMs>=(want+IV_SEC[iv])*1000+BACKFILL.tailGraceMs){
      const venue=venueFor(st,p,nowMs);if(!venue)return null;const gap=Math.ceil((want-p.newest)/IV_SEC[iv])+2;
      return {key:seriesKey(sym,iv),sym,iv,kind:"tail",venue,endSec:null,limit:Math.min(PAGE[venue],Math.max(3,gap))};
    }
  }
  // older history: one series at a time, in order
  for(const iv of BACKFILL.order)for(const sym of syms){
    const p=plan(st,sym,iv);if(p.done||p.retryAt>nowMs)continue;
    const venue=venueFor(st,p,nowMs);if(!venue)return null;
    return {key:p.sym+"|"+iv,sym,iv,kind:"back",venue,endSec:p.oldest,limit:PAGE[venue]};
  }
  return null;
}
function count(st:BackfillState,nowMs:number){const d=new Date(nowMs).toISOString().slice(0,10);if(st.day!==d){st.day=d;st.reqToday=0;}
  st.reqToday++;st.reqTotal++;st.lastReqAt=nowMs;st.startedAt??=nowMs;}
/** a page arrived (bars already parsed / closed only). Returns true when this page finished the series' history. */
export function onPage(st:BackfillState,job:Job,bars:{t:number}[],nowMs:number){
  count(st,nowMs);st.okTotal++;st.pause429=0;
  const p=plan(st,job.sym,job.iv);p.venue=VENUES.indexOf(job.venue);p.fails=0;p.retryAt=0;p.lastError=null;p.pages++;
  if(bars.length){const lo=bars[0]!.t,hi=bars.at(-1)!.t;p.oldest=p.oldest==null?lo:Math.min(p.oldest,lo);p.newest=p.newest==null?hi:Math.max(p.newest,hi);}
  if(job.kind==="tail")return false;
  const floor=nowMs/1000-BACKFILL.depthDays[job.iv]*86_400;
  // empty page = before the listing; a page that did not reach further back = the venue has no older bars
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
    // all three refusing → everything waits
    if(VENUES.every(v=>(st.venueBlock?.[v]??0)>nowMs))st.pauseUntil=Math.min(...VENUES.map(v=>st.venueBlock![v]!));}
  p.fails++;p.venue=(VENUES.indexOf(job.venue)+1)%VENUES.length;
  // a full venue rotation that failed backs off; a single failure just tries the next venue at the next slot
  p.retryAt=p.fails%VENUES.length===0?nowMs+Math.min(BACKFILL.retryMaxMs,BACKFILL.retryBaseMs*2**Math.min(8,p.fails/VENUES.length)):nowMs;
}
export type BackfillView={pct:number;done:number;total:number;bars:number;byIv:Record<string,{done:number;total:number;bars:number;from:string|null}>;
  reqToday:number;reqTotal:number;errTotal:number;pausedUntil:number|null;blocked:Venue[];startedAt:number|null;etaMin:number|null;working:string|null};
export function backfillView(st:BackfillState,universe:readonly string[],nowMs:number,minGapMs:number=BACKFILL.minGapMs):BackfillView{
  const syms=trackedSymbols(universe),byIv:BackfillView["byIv"]={};let done=0,total=0,bars=0,pagesLeft=0,working:string|null=null;
  for(const iv of BACKFILL.order){let d=0,b=0,from:number|null=null;
    for(const sym of syms){const p=st.series[seriesKey(sym,iv)];total++;
      if(p?.done)d++;else{const covered=p?.oldest!=null?Math.max(0,(p.newest??nowMs/1000)-p.oldest)/IV_SEC[iv]:0,need=BACKFILL.depthDays[iv]*86_400/IV_SEC[iv];
        pagesLeft+=Math.ceil(Math.max(0,need-covered)/PAGE[VENUES[(p?.venue??0)%3]!]);working??=`${sym} ${iv}`;}
      const n=p?.oldest!=null&&p.newest!=null?Math.round((p.newest-p.oldest)/IV_SEC[iv])+1:0;b+=n;
      if(p?.oldest!=null)from=from==null?p.oldest:Math.min(from,p.oldest);}
    done+=d;bars+=b;byIv[iv]={done:d,total:syms.length,bars:b,from:from==null?null:new Date(from*1000).toISOString().slice(0,10)};}
  return {pct:total?done/total:0,done,total,bars,byIv,reqToday:st.reqToday,reqTotal:st.reqTotal,errTotal:st.errTotal,
    pausedUntil:st.pauseUntil>nowMs?st.pauseUntil:null,blocked:VENUES.filter(v=>(st.venueBlock?.[v]??0)>nowMs),startedAt:st.startedAt,etaMin:pagesLeft?Math.ceil(pagesLeft*minGapMs/60_000):0,working};
}
