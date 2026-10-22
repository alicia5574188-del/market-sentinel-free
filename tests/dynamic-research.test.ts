/**
 * dynamic-v1 research layer: venue pages, paced / resumable backfill, D1 store, playbook pool simulator, BTC/ETH state monitor,
 * cycle analyzer, allocator, the runtime end to end (fake venue + node:sqlite D1, restart without duplicates) and the engine /
 * forward wiring (switch 10, allocator gating of pool and daily-breakout entries, own exits, slots, de-duplication).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import type {D1Like,D1Stmt} from "../lib/run-log-archive.ts";
import {Series,IV_SEC,aggregate,Memo,stdev,type Bar,type Iv} from "../lib/dynamic/series.ts";
import {pageUrl,parsePage,PAGE,HttpStatusError} from "../lib/dynamic/venues.ts";
import {BACKFILL,initialBackfill,normalizeBackfill,nextJob,onPage,onFailure,backfillView,trackedSymbols,trackedSeries,seriesKey,lastClosedStart,noteFeed,depthOf} from "../lib/dynamic/backfill.ts";
import {emptyDynStore,writeChunks,readSeries,writeTradeChunks,readTradeChunks,chunkStarts,pruneBars,DYN_DAILY_ROWS,CHUNK_SEC,dynCounts} from "../lib/dynamic/store-d1.ts";
import {POOL,POOL_BY_ID,simulate,manageLive,btcRegime,applies,tierOf,FEE,type Playbook,type Ctx} from "../lib/dynamic/playbooks.ts";
import {SHORT_POOL,MIN_STOP,usOpenMin} from "../lib/dynamic/playbooks-short.ts";
import {dailyStates,stateAt,intradayStates,intraAt,sessionOf} from "../lib/dynamic/state.ts";
import {analyzePlaybook,statDay,CYCLE,type TradeLite} from "../lib/dynamic/cycles.ts";
import {allocate,ALLOC} from "../lib/dynamic/allocator.ts";
import {synthMarket} from "./helpers-synthetic-market.ts";
import {DynamicResearch,MEM_KEEP,type DynPlanInput,type FeedBar} from "../lib/dynamic/runtime.ts";
import {LivingEngine,LIVING_KEYS,type PlanContext,type ForwardView} from "../lib/living/engine.ts";
import {defaultLivingConfig,LIVING_ITEMS,LIVING_ITEM_LABELS} from "../lib/living/config.ts";
import {htfPaperLeverage,isolatedLiquidationPrice} from "../lib/paper-leverage.ts";
import {HTF} from "../lib/living/htf-trend.ts";
import type {LivingNote} from "../lib/living/directive.ts";

const D=86_400,H=3_600;
function sqliteD1():D1Like{
  const sql=new DatabaseSync(":memory:");
  const make=(text:string,values:unknown[]=[]):D1Stmt=>({bind:(...v:unknown[])=>make(text,v),
    run:async()=>sql.prepare(text).run(...(values as never[])),all:async<R>()=>({results:sql.prepare(text).all(...(values as never[])) as R[]}),
    first:async<R>()=>(sql.prepare(text).get(...(values as never[])) as R|undefined)??null});
  return {prepare:text=>make(text),batch:async list=>{sql.exec("BEGIN");try{const out=[];for(const s of list)out.push(await s.run());sql.exec("COMMIT");return out;}catch(e){sql.exec("ROLLBACK");throw e;}}};
}
/** deterministic price path: trend phases + noise, per symbol */
function px(sym:string,t:number){let h=0;for(const ch of sym)h=(h*31+ch.charCodeAt(0))%997;
  const d=t/D;return (50+h)*Math.exp(.35*Math.sin(d/90+h)+.15*Math.sin(d/17+h/3)+.03*Math.sin(d*1.7+h)+.012*Math.sin(t/5200+h)+.006*Math.sin(t/1300+h/7)+.003*Math.sin(t/410));}
function barAt(sym:string,iv:Iv,t:number):Bar{const s=IV_SEC[iv],o=px(sym,t),c=px(sym,t+s),hi=Math.max(o,c)*(1+.004*(1+Math.sin(t/7e3))),lo=Math.min(o,c)*(1-.004*(1+Math.cos(t/9e3)));
  return {t,o,h:hi,l:lo,c,v:1000+(t/s)%37};}
function series(sym:string,iv:Iv,from:number,n:number){const s=new Series(sym,iv),sec=IV_SEC[iv],t0=Math.floor(from/sec)*sec;s.merge(Array.from({length:n},(_,i)=>barAt(sym,iv,t0+i*sec)));return s;}
/** a fake Bybit: listing starts at `listed`, answers pages ending before `end` */
function fakeBybit(listed:number,nowMs:()=>number,calls:string[],fail?:(url:string)=>number|null){
  return async(url:string)=>{calls.push(url);const f=fail?.(url);if(f)throw new HttpStatusError(f);
    const u=new URL(url),sym=u.searchParams.get("symbol")!.replace("USDT","")+"_USDT",i=u.searchParams.get("interval")!;
    const iv:Iv=({D:"1d","240":"4h","60":"1h","15":"15m","5":"5m","1":"1m"} as Record<string,Iv>)[i]!,sec=IV_SEC[iv];
    const lim=Number(u.searchParams.get("limit")),endMs=u.searchParams.get("end")?Number(u.searchParams.get("end")):nowMs();
    const last=Math.floor((endMs/1000)/sec)*sec,list:string[][]=[];
    for(let t=last;t>last-lim*sec&&t>=listed;t-=sec){const b=barAt(sym,iv,t);list.push([String(t*1000),String(b.o),String(b.h),String(b.l),String(b.c),String(b.v),"0"]);}
    return {retCode:0,result:{list}};};
}

// ---------------------------------------------------------------- venues
test("venues: page URLs page backwards per venue (never Gate); parser keeps closed, valid, aligned bars only",()=>{
  const u1=pageUrl("BYBIT","SOL_USDT","4h",1_800_000_000,5000)!;assert.match(u1,/^https:\/\/api\.bybit\.com\/v5\/market\/kline\?category=linear&symbol=SOLUSDT&interval=240&limit=1000&end=1799999999999$/);
  assert.match(pageUrl("OKX","BTC_USDT","1d",null,100)!,/www\.okx\.com\/api\/v5\/market\/history-candles\?instId=BTC-USDT-SWAP&bar=1Dutc&limit=100$/);
  const k=pageUrl("KUCOIN","BTC_USDT","1h",1_800_000_000-1_800_000_000%3600,200)!;assert.match(k,/symbol=XBTUSDTM&granularity=60&from=\d+&to=\d+/);
  for(const v of ["BYBIT","OKX","KUCOIN"] as const)for(const iv of ["1d","4h","1h"] as const)assert.doesNotMatch(pageUrl(v,"ETH_USDT",iv,null,10)!,/gate/i);
  assert.equal(pageUrl("BYBIT","BTCUSDT","1d",null,1),null);
  const now=1_800_000_000,t=Math.floor(now/H)*H;
  const rows=parsePage("BYBIT","1h",{retCode:0,result:{list:[[String(t*1000),"1","2","0.5","1.5","10"],[String((t-H)*1000),"1","2","0.5","1.5","10"],[String((t-2*H)*1000),"1","0.5","0.5","1.5","10"],[String((t-3*H+7)*1000),"1","2","0.5","1.5","10"]]}},now);
  assert.deepEqual(rows.map(r=>r.t),[t-H],"open bar, invalid high and misaligned time dropped");
  assert.throws(()=>parsePage("OKX","1d",{code:"51000",data:[]},now));
  assert.deepEqual(parsePage("OKX","1d",{code:"0",data:[[String((t-2*D)*1000-((t-2*D)%D)*1000),"1","2","0.5","1.5","3","0","0","0"]]},now),[],"OKX unconfirmed row (confirm=0) dropped");
});

// ---------------------------------------------------------------- backfill plan
test("backfill: one request per 15 s at most; short-term first — BTC/ETH daily + 1h, then 15m, 5m, the rest of 1h, BTC/ETH 1m, 4h, daily",()=>{
  const st=initialBackfill(),uni=["SOL_USDT","BTC_USDT"],t=1_800_000_000_000;
  assert.deepEqual(trackedSymbols(uni),["BTC_USDT","ETH_USDT","SOL_USDT"]);
  const j=nextJob(st,t,uni)!;assert.deepEqual([j.sym,j.iv,j.kind,j.venue,j.endSec,j.limit],["BTC_USDT","1d","back","BYBIT",null,PAGE.BYBIT]);
  onPage(st,j,[{t:lastClosedStart("1d",t)-999*D},{t:lastClosedStart("1d",t)}],t);
  assert.equal(nextJob(st,t+14_999,uni),null,"pacing");
  const j2=nextJob(st,t+15_000,uni)!;assert.deepEqual([j2.sym,j2.iv,j2.endSec],["BTC_USDT","1d",lastClosedStart("1d",t)-999*D],"continues backwards from the oldest bar");
  onPage(st,j2,[{t:lastClosedStart("1d",t)-1600*D}],t+15_000);assert.ok(st.series[seriesKey("BTC_USDT","1d")]!.done,"depth reached → done");
  // finish every series with an empty page and record the order
  const order:string[]=[];let now=t+30_000;
  for(let k=0;k<40;k++){const x=nextJob(st,now,uni);if(!x)break;if(x.kind==="back"){order.push(`${x.sym.replace("_USDT","")} ${x.iv}`);onPage(st,x,[],now);}now+=15_000;}
  assert.deepEqual(order,["ETH 1d","BTC 1h","ETH 1h","BTC 15m","ETH 15m","SOL 15m","BTC 5m","ETH 5m","SOL 5m","SOL 1h","BTC 1m","ETH 1m","BTC 4h","ETH 4h","SOL 4h","SOL 1d"]);
  assert.equal(trackedSeries(uni).length,17,"1m only for BTC/ETH");
  assert.equal(depthOf("BTC_USDT","5m"),120);assert.equal(depthOf("SOL_USDT","5m"),75);assert.equal(depthOf("SOL_USDT","15m"),150);assert.equal(depthOf("ETH_USDT","1m"),14);
  // 5m back pages go to the venue's interval code
  assert.match(pageUrl("BYBIT","SOL_USDT","5m",null,1000)!,/interval=5&/);assert.match(pageUrl("OKX","SOL_USDT","15m",null,100)!,/bar=15m&/);
  assert.match(pageUrl("KUCOIN","SOL_USDT","5m",1_800_000_000,200)!,/granularity=5&/);assert.match(pageUrl("BYBIT","BTC_USDT","1m",null,1000)!,/interval=1&/);
});
test("backfill: the live 5m feed keeps short series current (request tails only when stale); 4h / 1d tail after the close; 429 skips a venue; resumes from JSON",()=>{
  const st=initialBackfill(),uni:string[]=[],day=Math.floor(1_800_000_000/D)*D,t=day*1000+10*60_000;
  for(const {sym,iv} of trackedSeries(uni))st.series[seriesKey(sym,iv)]={sym,iv,oldest:0,newest:lastClosedStart(iv,t),done:true,pages:1,bars:1,fails:0,retryAt:0,venue:0,lastError:null,doneAt:t,lastTailAt:t};
  assert.equal(nextJob(st,t,uni),null,"all current");
  assert.equal(nextJob(st,(day+15*60+90)*1000,uni),null,"a 5m / 15m bar closed, but the live feed is expected to bring it");
  const late=(day+36*60+90)*1000,j=nextJob(st,late,uni)!;assert.deepEqual([j.kind,j.sym,j.iv,j.endSec],["tail","BTC_USDT","5m",null],"no feed for 25 min → request tail");
  noteFeed(st,"BTC_USDT","5m",day,lastClosedStart("5m",late));
  const j1=nextJob(st,late,uni)!;assert.deepEqual([j1.sym,j1.iv],["ETH_USDT","5m"]);
  const t1=late;onFailure(st,j1,new HttpStatusError(429),t1);assert.equal(st.venueBlock!.BYBIT,t1+BACKFILL.pause429Ms,"429 blocks that venue");
  const j2=nextJob(st,t1+15_000,uni)!;assert.equal(j2.venue,"OKX","the next request goes to another venue");assert.equal(j2.key,j1.key);
  onFailure(st,j2,new HttpStatusError(429),t1+15_000);assert.equal(st.venueBlock!.OKX,t1+15_000+2*BACKFILL.pause429Ms,"doubling block");
  const j3=nextJob(st,t1+30_000,uni)!;assert.equal(j3.venue,"KUCOIN");onFailure(st,j3,new HttpStatusError(403),t1+30_000);
  assert.ok(st.pauseUntil>t1+30_000,"all three refusing → global pause");assert.equal(nextJob(st,t1+45_000,uni),null);
  const k=seriesKey("ETH_USDT","5m");assert.equal(st.series[k]!.fails,3);assert.ok(st.series[k]!.retryAt>t1+30_000,"a full rotation failed → series backs off");
  noteFeed(st,"ETH_USDT","5m",day,lastClosedStart("5m",late));
  const back=normalizeBackfill(JSON.parse(JSON.stringify(st)));assert.deepEqual(back,st);assert.deepEqual(normalizeBackfill({v:9}),initialBackfill());
  // 4h: a request tail 90 s after its close
  const s2=initialBackfill(),t4=(day+4*H)*1000;s2.series[seriesKey("BTC_USDT","4h")]={sym:"BTC_USDT",iv:"4h",oldest:0,newest:lastClosedStart("4h",t4-1),done:true,pages:1,bars:1,fails:0,retryAt:0,venue:0,lastError:null,doneAt:0};
  for(const {sym,iv} of trackedSeries([]))s2.series[seriesKey(sym,iv)]??={sym,iv,oldest:0,newest:lastClosedStart(iv,t4+90_000),done:true,pages:1,bars:1,fails:0,retryAt:0,venue:0,lastError:null,doneAt:0,lastTailAt:t4};
  assert.equal(nextJob(s2,t4+60_000,[]),null);const j4=nextJob(s2,t4+90_000,[])!;assert.deepEqual([j4.kind,j4.iv],["tail","4h"]);
  const v=backfillView(st,uni,late);assert.equal(v.done,v.total);assert.equal(v.pct,1);assert.equal(v.errTotal,3);assert.ok(v.byIv["5m"]&&v.byIv["1m"]);
});

// ---------------------------------------------------------------- D1 store
test("D1: chunks round-trip (all / newest / a window); prune drops old short history; trade groups upsert as a whole and page; daily row budget defers",async()=>{
  const db=sqliteD1(),st=emptyDynStore(),s=series("SOL_USDT","1h",1_790_000_000,1500);
  assert.ok(await writeChunks(db,st,s,s.rows().map(b=>b.t),1));
  const back=await readSeries(db,st,"SOL_USDT","1h");assert.equal(back.n,1500);assert.ok(Math.abs(back.c[1499]!/s.c[1499]!-1)<1e-6);
  const c=await dynCounts(db);assert.ok(c.dyn_bars!>=3&&c.dyn_bars!<=4);
  const starts=await chunkStarts(db,st,"SOL_USDT","1h");assert.equal(starts.length,c.dyn_bars);
  const lastTwo=await readSeries(db,st,"SOL_USDT","1h",{lastChunks:1});assert.ok(lastTwo.n>0&&lastTwo.n<=600&&lastTwo.last===s.last);
  const win=await readSeries(db,st,"SOL_USDT","1h",{from:s.t[100]!,to:s.t[200]!});assert.equal(win.n,100);assert.equal(win.first,s.t[100]);
  await pruneBars(db,st,"1h",starts[1]!,2);assert.equal((await chunkStarts(db,st,"SOL_USDT","1h")).length,starts.length-1,"the oldest chunk (ends before the cut) is dropped");
  const g={k:"u|SOL_USDT|5m|0",sym:"SOL_USDT",iv:"5m" as const,t0:0,pbs:["box5m-long"],trades:[[0,1,2,1000,1,1.01]] as [number,number,number,number,number,number][]};
  await writeTradeChunks(db,st,[g],3);await writeTradeChunks(db,st,[{...g,trades:[...g.trades,[0,5,6,-500,1,.99]]}],4);
  const rows=await readTradeChunks(db,st,"",10);assert.equal(rows.length,1);assert.equal(rows[0]!.trades.length,2,"rewritten whole, one row");
  await writeTradeChunks(db,st,[{...g,k:"u|SOL_USDT|5m|9"}],5);assert.equal((await readTradeChunks(db,st,"u|SOL_USDT|5m|0",10)).length,1,"pages by key");
  st.rowsToday=DYN_DAILY_ROWS;assert.equal(await writeTradeChunks(db,st,[g],7),false);assert.equal(st.deferred,1);
});

// ---------------------------------------------------------------- pool
test("pool: ≥ 25 short-term playbooks (both sides per family, tagged) + daily/4h record-only tier; unique ids; labels match the order card; deterministic simulator nets 0.19% fees, fills gaps at the open, no re-entry on the exit bar",()=>{
  const short=POOL.filter(p=>tierOf(p)==="short"),long=POOL.filter(p=>tierOf(p)==="long");
  assert.ok(short.length>=25,`${short.length} short`);assert.ok(SHORT_POOL.length>=50);assert.equal(new Set(POOL.map(p=>p.id)).size,POOL.length);
  assert.deepEqual(long.map(p=>p.iv).sort(),["1d","1d","4h","4h","4h","4h"]);
  for(const p of short){assert.ok(["5m","15m","1h"].includes(p.iv),p.id);assert.ok(p.family&&p.familyLabel&&p.rule,p.id);assert.equal(p.minStop,MIN_STOP);}
  const fams=new Map<string,Set<string>>();for(const p of short)(fams.get(p.family!)??fams.set(p.family!,new Set()).get(p.family!)!).add(p.side);
  for(const [f,sides] of fams)assert.equal(sides.size,2,`${f} has both sides`);assert.ok(fams.size>=25,`${fams.size} families`);
  const card=readFileSync(new URL("../app/order-card.tsx",import.meta.url),"utf8");
  for(const p of POOL)assert.ok(card.includes(`"${p.id}":"${p.label}"`),p.id);
  const s=series("ETH_USDT","1d",1_650_000_000,900),btc=series("BTC_USDT","1d",1_650_000_000,900),ctx=btcRegime(btc);
  for(const pb of POOL.filter(p=>p.iv==="1d")){const a=simulate(pb,s,ctx),b=simulate(pb,s,ctx);assert.deepEqual(a,b);
    for(const t of a.trades){const d=pb.side==="LONG"?1:-1;assert.ok(Math.abs(t.net-(d*(t.xp/t.ep-1)-FEE))<1e-12);assert.ok(t.xt>t.et);}
    for(let i=1;i<a.trades.length;i++)assert.ok(a.trades[i]!.et>a.trades[i-1]!.xt,"next entry after the previous exit bar");}
  const toy:Playbook={id:"toy",label:"t",iv:"1d",side:"LONG",warm:1,rule:"",prep:()=>({}),enter:(_x,q,i)=>i===2?{stop:q.c[i]!*.9,why:"t"}:null};
  const z=new Series("Z_USDT","1d");z.merge([100,100,100,100,80].map((c,i)=>({t:i*D,o:i===4?80:100,h:Math.max(c,100)*1.001,l:Math.min(c,100)*.999,c,v:1})));
  const r=simulate(toy,z,ctx);assert.equal(r.trades.length,1);assert.equal(r.trades[0]!.xp,80,"gap fill at the open, not the stop");assert.equal(r.trades[0]!.exit,"止损");
  // short tier: a too-tight stop is widened to the minimum, not skipped
  const toyS:Playbook={...toy,id:"toyS",iv:"5m",tier:"short",minStop:MIN_STOP,enter:(_x,q,i)=>i===2?{stop:q.c[i]!*.999,maxBars:3,why:"t"}:null};
  const z5=new Series("Z_USDT","5m");z5.merge([100,100,100,100.2,100.1,100.3,100.2].map((c,i)=>({t:(i+1)*300,o:100,h:Math.max(c,100)*1.0005,l:Math.min(c,100)*.9995,c,v:1})));
  const rs=simulate(toyS,z5,{btcBull:()=>null});assert.equal(rs.trades.length,1);assert.ok(Math.abs(rs.trades[0]!.stop0-100*(1-MIN_STOP))<1e-9);assert.equal(rs.trades[0]!.exit,"到时");
});
const MKT=synthMarket();
test("short pool: every family trades on a synthetic market and every trade is sane — stop ≥ max(0.8%, ATR15m-ish), hold ≤ 24 h, exit = stop / target / time, net = side × move − fees, entry on a closed bar",()=>{
  const byFam:Record<string,number>={};
  for(const pb of POOL.filter(p=>tierOf(p)==="short")){
    for(const [sym,ss] of Object.entries(MKT)){if(!applies(pb,sym))continue;const s=ss[pb.iv as "5m"|"15m"|"1h"];
      const ctx:Ctx={btcBull:()=>null,btc:MKT.BTC_USDT![pb.iv as "5m"|"15m"|"1h"],memo:new Memo()};
      const a=simulate(pb,s,ctx);assert.deepEqual(simulate(pb,s,{...ctx,memo:new Memo()}).trades,a.trades,`${pb.id} deterministic (memo is only a cache)`);
      const d=pb.side==="LONG"?1:-1;
      for(const t of a.trades){
        assert.ok(d*(t.ep-t.stop0)/t.ep>=MIN_STOP*.999,`${pb.id} stop ${(d*(t.ep-t.stop0)/t.ep*100).toFixed(2)}%`);
        assert.ok(t.xt-t.et<=24*H+IV_SEC[pb.iv],`${pb.id} held ${(t.xt-t.et)/H} h`);
        assert.ok(["止损","目标","到时","跟踪止损"].includes(t.exit)||t.exit.length>0,t.exit);
        assert.ok(Math.abs(t.net-(d*(t.xp/t.ep-1)-FEE))<1e-12);assert.equal(t.et%IV_SEC[pb.iv],0,"entry at a bar close");
        if(t.exit==="止损")assert.ok(d*(t.xp-t.stop0)<=1e-9*t.ep,"stop exit at or beyond the stop");}
      for(let i=1;i<a.trades.length;i++)assert.ok(a.trades[i]!.et>a.trades[i-1]!.xt);
      byFam[pb.family!]=(byFam[pb.family!]??0)+a.trades.length;}}
  for(const [f,n] of Object.entries(byFam))assert.ok(n>0,`${f} produced no trade on the synthetic market`);
});
test("short pool signals: box breakout, opening range (US open follows daylight saving), majors / alts only, cross-asset rules need BTC",()=>{
  // a 5m box (48 bars within 1%) then the first close above it
  const z=new Series("SOL_USDT","5m"),t0=Date.UTC(2026,6,1,2,0)/1000;const rows:Bar[]=[];
  for(let i=0;i<60;i++){const c=100+.4*Math.sin(i/3);rows.push({t:t0+i*300,o:c,h:c+.2,l:c-.2,c,v:100});}
  rows.push({t:t0+60*300,o:100.3,h:101.6,l:100.2,c:101.5,v:300});for(let i=61;i<80;i++)rows.push({t:t0+i*300,o:101.5,h:101.7,l:101.3,c:101.5,v:100});
  z.merge(rows);const pb=POOL_BY_ID["box5m-long"]!,r=simulate(pb,z,{btcBull:()=>null,memo:new Memo()});
  const tr=[...r.trades,...(r.open?[r.open]:[])];assert.equal(tr.length,1);assert.equal(tr[0]!.et,t0+61*300,"entry at the breakout bar's close");
  assert.ok((101.5-tr[0]!.stop0)/101.5>=MIN_STOP*.999);
  assert.equal(simulate(POOL_BY_ID["box5m-short"]!,z,{btcBull:()=>null}).trades.length,0);
  assert.equal(usOpenMin(Date.UTC(2026,6,1)/1000),13*60+30,"summer: 13:30 UTC");assert.equal(usOpenMin(Date.UTC(2026,0,15)/1000),14*60+30,"winter: 14:30 UTC");
  assert.equal(sessionOf(Date.UTC(2026,6,1,3)/1000),"ASIA");assert.equal(sessionOf(Date.UTC(2026,6,1,14)/1000),"US");
  assert.equal(applies(POOL_BY_ID["ny90-long"]!,"SOL_USDT"),false);assert.equal(applies(POOL_BY_ID["ny90-long"]!,"BTC_USDT"),true);
  assert.equal(applies(POOL_BY_ID["laggard15m-long"]!,"BTC_USDT"),false);
  const alt=MKT.AAA_USDT!["15m"];assert.equal(simulate(POOL_BY_ID["laggard15m-long"]!,alt,{btcBull:()=>null,btc:null}).trades.length,0,"no BTC bars → no cross-asset signal");
  // stdev ignores leading NaN (returns) instead of poisoning the whole series
  const sd=stdev([NaN,1,2,3,4],2);assert.ok(Number.isNaN(sd[1]!));assert.ok(sd[4]!>0);
  // aggregation builds only complete higher bars
  const s5=MKT.BTC_USDT!["5m"],h=aggregate(s5,"1h");assert.equal(h[0]!.t%H,0);const j=s5.t.indexOf(h[1]!.t);
  assert.equal(h[1]!.o,s5.o[j]);assert.equal(h[1]!.c,s5.c[j+11]);assert.equal(h[1]!.h,Math.max(...s5.h.subarray(j,j+12)));
  const part=new Series("X_USDT","5m");part.merge(s5.rows(0,11));assert.equal(aggregate(part,"1h").length,0,"11 of 12 bars → no 1h bar");
});
test("pool: live management follows the same rule — donch trail only up, target / time exits at a close, stop touches left to the forward core",()=>{
  const btc=series("BTC_USDT","1d",1_650_000_000,600),s=series("SOL_USDT","1d",1_650_000_000,600),pb=POOL_BY_ID["htf-donch20"]!;
  const openedAt=(s.t[400]!+D)*1000+60_000,entry=s.c[400]!,stop0=entry*.8;
  const m=manageLive(pb,s,{openedAtMs:openedAt,entry,stop0,stop:stop0})!;assert.ok(m);assert.ok(m.stop>=stop0);assert.equal(m.exit,null,"trail-only rule has no close exit");
  const tp=POOL_BY_ID["burst1h-long"]!,h=series("SOL_USDT","1h",1_700_000_000,200),oa=(h.t[150]!+H)*1000+30_000;
  const m2=manageLive(tp,h,{openedAtMs:oa,entry:h.c[150]!,stop0:h.c[150]!*.5,stop:h.c[150]!*.5,maxBars:6})!;assert.equal(m2.exit!.why,"到时");assert.equal(m2.bars,6);
  const m3=manageLive(tp,h,{openedAtMs:oa,entry:h.c[150]!,stop0:h.c[150]!*.5,stop:h.c[150]!*.5,target:h.c[150]!*1.0001,maxBars:60})!;assert.equal(m3.exit!.why,"目标");
  void btc;
});

// ---------------------------------------------------------------- state
test("state monitor: up / down trend and volatility buckets from BTC daily; known only after the bar closed",()=>{
  const mk=(f:(i:number)=>number,vol:(i:number)=>number)=>{const s=new Series("BTC_USDT","1d");s.merge(Array.from({length:500},(_,i)=>{const c=f(i),w=vol(i);return {t:i*D,o:c,h:c*(1+w),l:c*(1-w),c,v:1};}));return s;};
  const up=dailyStates(mk(i=>100*1.004**i,i=>i>400?.04:.01),null,[]);assert.equal(up.at(-1)!.trend,"UP");assert.equal(up.at(-1)!.vol,"HIGH");
  const mid=up.find(x=>x.t===300*D)!;assert.equal(mid.vol,"MID","flat volatility sits in the middle");
  const dn=dailyStates(mk(i=>100*.996**i,()=>.01),null,[]);assert.equal(dn.at(-1)!.trend,"DOWN");assert.ok(dn.at(-1)!.dd90<-.2);
  assert.equal(stateAt(up,up[10]!.t+D-1)?.t,up[9]!.t);assert.equal(stateAt(up,up[10]!.t+D)?.t,up[10]!.t);
});

test("intraday state: BTC 1h trend × 24 h volatility percentile, ETH's 1h trend, session; known only after the hour closed, stale after 3 h",()=>{
  const b=new Series("BTC_USDT","1h");b.merge(Array.from({length:900},(_,i)=>{const c=100*1.001**i,w=i>850?.02:.004;return {t:i*H,o:c/1.001,h:c*(1+w),l:c/1.001*(1-w),c,v:1};}));
  const st=intradayStates(b,null);const last=st.at(-1)!;assert.equal(last.trend,"UP");assert.equal(last.vol,"HIGH");assert.equal(last.bucket,"UP/HIGH");
  assert.equal(intraAt(st,last.t+H-1)?.t,st.at(-2)!.t);assert.equal(intraAt(st,last.t+H)?.t,last.t);assert.equal(intraAt(st,last.t+5*H),null,"stale");
});
// ---------------------------------------------------------------- cycles + allocator
function cycleTrades(pb:string,weeks:number,phaseWeeks:number,good=.02,bad=-.015):TradeLite[]{
  const out:TradeLite[]=[];for(let w=0;w<weeks;w++)for(let k=0;k<3;k++){const g=Math.floor(w/phaseWeeks)%2===0,t=w*7*D+k*2*D+D;
    out.push({pb,sym:"X",et:t-D,xt:t,net:(g?good:bad)+(k-1)*.002});}return out;
}
test("cycles: weekly 4-week phases with hysteresis; pattern only after ≥3 good and ≥3 bad phases and ≥40 trades; persistence on non-overlapping windows",()=>{
  const now=60*7*D;
  const c=analyzePlaybook("p",cycleTrades("p",60,8),[],now);
  assert.ok(c.good>=3&&c.bad>=3);assert.equal(c.pattern,true);assert.ok(c.persistence!>.5,"8-week phases persist");
  assert.ok(c.meanGoodWeeks>=5);assert.equal(c.rolling["8w"]!.n>0,true);
  const short=analyzePlaybook("p",cycleTrades("p",14,4),[],14*7*D);assert.equal(short.pattern,false);assert.match(short.patternWhy,/还不够/);
  assert.equal(analyzePlaybook("p",[],[],now).current.label,null);
});
test("allocator: no state / no pattern / thin or losing bucket / persistent bad phase → record only; else risk 0.375–0.75% by confidence",()=>{
  const state={t:0,btc:1,trend:"UP" as const,strength:.1,atrPct:.02,volPct:.5,vol:"MID" as const,dd90:0,eff20:.3,eth:null,altVsBtc:null,lead:null,corr30:null,bucket:"UP/MID"};
  const base=analyzePlaybook("htf-donch20",cycleTrades("htf-donch20",60,8),[],60*7*D);
  const st=(n:number,mean:number,t:number)=>({n,sum:n*mean,mean,win:.5,t});
  assert.match(allocate({},null)["htf-donch20"]!.why,/算不出/);
  assert.match(allocate({"htf-donch20":{...base,pattern:false}},state)["htf-donch20"]!.why,/规律未确认/);
  assert.match(allocate({"htf-donch20":{...base,byBucket:{"UP/MID":st(10,.05,3)}}},state)["htf-donch20"]!.why,/样本 10\/20/);
  assert.match(allocate({"htf-donch20":{...base,byBucket:{"UP/MID":st(50,.001,3)}}},state)["htf-donch20"]!.why,/不赚钱/);
  assert.match(allocate({"htf-donch20":{...base,byBucket:{"UP/MID":st(50,.01,2)},current:{label:"BAD",weeks:2,since:0},persistence:.7}},state)["htf-donch20"]!.why,/亏钱段/);
  const ok=allocate({"htf-donch20":{...base,byBucket:{"UP/MID":st(50,.01,1.5)},current:{label:"GOOD",weeks:2,since:0}}},state)["htf-donch20"]!;
  assert.equal(ok.ok,true);assert.equal(ok.conf,.5);assert.ok(Math.abs(ok.risk-ALLOC.baseRisk/2)<1e-12);
  const hi=allocate({"htf-donch20":{...base,byBucket:{"UP/MID":st(50,.01,6)},current:{label:"BAD",weeks:2,since:0},persistence:.4}},state)["htf-donch20"]!;
  assert.equal(hi.ok,true,"a bad phase that does not persist does not block");assert.equal(hi.risk,ALLOC.baseRisk);
  assert.equal(CYCLE.minPhases,3);
});

test("cycles (short tier): daily steps on a 7-day window, rolling 1/2/4 weeks and last 50/100/200 trades, by-day clustered t, intraday bucket + session split",()=>{
  const tr:TradeLite[]=[];for(let d=0;d<120;d++)for(let k=0;k<4;k++){const good=Math.floor(d/14)%2===0;tr.push({pb:"box5m-long",sym:"X",et:d*D+k*3*H+H,xt:d*D+k*3*H+2*H,net:(good?.004:-.0035)+(k-1.5)*.001});}
  const intra=Array.from({length:120*24},(_,i)=>({t:i*H,btc:1,trend:"UP" as const,trend4h:"UP" as const,atrPct:.01,volPct:.5,vol:"MID" as const,eth:null,bucket:"UP/MID"}));
  const c=analyzePlaybook("box5m-long",tr,[],120*D,{tier:"short",intra});
  assert.equal(c.unit,"day");assert.ok(c.good>=3&&c.bad>=3&&c.pattern,c.patternWhy);assert.ok(c.meanGoodWeeks>=7&&c.meanGoodWeeks<=21,"phase length in days");
  assert.ok(c.rolling["1w"]&&c.rolling["2w"]&&c.rolling["4w"]);assert.equal(c.counts!["200"]!.n,200);assert.ok(c.byBucket["UP/MID"]!.n>0);assert.ok(c.bySession!.ASIA!.n>0);
  // clustering: 50 identical trades on one day are one observation, not 50
  const one=statDay(Array.from({length:50},(_,i)=>({et:5*D+i,net:.01+(i%2)*.001})));assert.equal(one.days,1);assert.equal(one.tDay,0);assert.ok(one.t>10);
});
test("allocator (short tier): intraday bucket, needs t(by day) ≥ 2 over ≥ 10 days; daily / 4h playbooks record-only except the daily breakout",()=>{
  const intra={t:0,btc:1,trend:"UP" as const,trend4h:"UP" as const,atrPct:.01,volPct:.5,vol:"MID" as const,eth:null,bucket:"UP/MID"};
  const base=analyzePlaybook("box5m-long",cycleTrades("box5m-long",60,8),[],60*7*D);
  const st=(n:number,mean:number,t:number,days:number,tDay:number)=>({n,sum:n*mean,mean,win:.5,t,days,tDay});
  const g=(c:object,ic:typeof intra|null=intra)=>allocate({"box5m-long":{...base,...c} as never},null,ic)["box5m-long"]!;
  assert.match(g({},null).why,/日内状态还算不出/);
  assert.match(g({byBucket:{"UP/MID":st(80,.004,4,6,3)}}).why,/按天算不够显著/);
  assert.match(g({byBucket:{"UP/MID":st(80,.004,4,30,1.2)}}).why,/按天算不够显著/);
  const ok=g({byBucket:{"UP/MID":st(80,.004,4,30,2.5)},current:{label:"GOOD",weeks:3,since:0},unit:"day"});assert.equal(ok.ok,true);assert.ok(ok.risk<=ALLOC.shortRisk&&ok.risk>=ALLOC.shortRisk*ALLOC.minConf);
  const all=allocate({},{t:0,btc:1,trend:"UP",strength:.1,atrPct:.02,volPct:.5,vol:"MID",dd90:0,eff20:.3,eth:null,altVsBtc:null,lead:null,corr30:null,bucket:"UP/MID"},intra);
  for(const id of ["htf-down20","ema4h-long","pull4h-short"])assert.match(all[id]!.why,/只记录/);assert.doesNotMatch(all["htf-donch20"]!.why,/日线\/4小时打法：只记录/);
});

// ---------------------------------------------------------------- runtime end to end
function feedOf(syms:string[],nowMs:number):Record<string,FeedBar[]>{const last=Math.floor(nowMs/1000/300)*300-300,out:Record<string,FeedBar[]>={};
  for(const sym of syms){out[sym]=[];for(let t=last-119*300;t<=last;t+=300){const b=barAt(sym,"5m",t);out[sym]!.push({time:t,open:b.o,high:b.h,low:b.l,close:b.c,volume:b.v});}}return out;}
test("runtime: short-term-first paced backfill (5m / 15m / 1h / 1m / 4h / 1d) into D1, history units replayed in chunks, live 5m feed without requests, restart resumes without duplicates",async()=>{
  const db=sqliteD1(),calls:string[]=[];const t0=Date.UTC(2026,9,1,0,10);let now=t0;const listed=Math.floor(Date.UTC(2023,0,1)/1000);
  const fetch=fakeBybit(listed,()=>now,calls);
  const rt=new DynamicResearch({minGapMs:15_000,analyzeEveryMs:3_600_000,metaEveryMs:60_000});
  const uni=["SOL_USDT"],syms=["BTC_USDT","ETH_USDT","SOL_USDT"];
  let steps=0;while(steps<4000){await rt.step(now,{universe:uni,db,fetch,feed:feedOf(syms,now)});steps++;now+=5_000;
    if(Object.values(rt.bf.series).length===17&&Object.values(rt.bf.series).every(s=>s.done)&&rt.unitQueue.length===0&&rt.unitsListed.size>=9&&[...rt.tsrc.values()].every(s=>!s.dirty))break;}
  assert.ok(Object.values(rt.bf.series).every(s=>s.done),"all 17 series done");
  assert.ok(calls.length>0&&calls.every(u=>/api\.bybit\.com/.test(u)));
  const ivOf=(u:string)=>new URL(u).searchParams.get("interval");
  const first=(i:string)=>calls.findIndex(u=>ivOf(u)===i);
  assert.ok(first("5")<first("240")&&first("15")<first("240")&&first("5")<calls.findIndex(u=>ivOf(u)==="D"&&/SOLUSDT/.test(u)),"short-term history before 4h and the alts' daily");
  const req=calls.length,minutes=(now-t0)/60_000;assert.ok((req-1)/minutes<=4,`≤ 4 requests a minute (${req} in ${minutes.toFixed(0)} min)`);
  const m5=rt.get("BTC_USDT","5m")!;assert.ok(m5.n<=MEM_KEEP["5m"],"memory keeps only the newest 5m bars");
  const stored5=await readSeries(db,rt.store,"BTC_USDT","5m");assert.ok(stored5.n>=120*288-300,`D1 holds BTC 5m history (${stored5.n})`);
  assert.ok((await readSeries(db,rt.store,"SOL_USDT","15m")).n>=150*96-200);assert.ok((await readSeries(db,rt.store,"ETH_USDT","1m")).n>=14*1440-100);
  assert.equal(Object.keys(rt.unitsDone).length,Object.values(rt.unitsTotal).reduce((a,b)=>a+b,0),"every history unit replayed");
  rt.analyze(now);assert.ok(rt.states.length>500);assert.ok(rt.intra.length>1000,"intraday state from BTC 1h");assert.ok(rt.tradeCount>0);
  const shortTrades=rt.tradesLite().filter(t=>tierOf(POOL_BY_ID[t.pb]!)==="short");assert.ok(shortTrades.length>50,`${shortTrades.length} short-term shadow trades`);
  assert.ok(new Set(shortTrades.map(t=>POOL_BY_ID[t.pb]!.family)).size>=10,"many families trade");
  // live: two more hours, the feed brings the 5m bars (no 5m / 15m / 1h request), live trades are evaluated on new bars only
  const before=calls.length,evals=rt.liveEvals;
  for(let i=0;i<24*60;i++){now+=5_000;await rt.step(now,{universe:uni,db,fetch,feed:feedOf(syms,now)});}
  const liveCalls=calls.slice(before).map(ivOf);assert.ok(!liveCalls.some(i=>i==="5"||i==="15"||i==="60"),`no short request tails while the feed runs (${liveCalls.join(",")})`);
  assert.ok(rt.get("BTC_USDT","5m")!.last!>=Math.floor(now/1000/300)*300-600,"5m current from the feed");assert.ok(rt.get("SOL_USDT","1h")!.last!>=Math.floor(now/1000/H)*H-2*H,"1h built from 5m");
  assert.ok(rt.liveEvals>evals&&rt.liveEvals-evals<=24*60*6,"evaluated when bars closed");
  await rt.step(now+60_000,{universe:uni,db,fetch});now+=120_000;
  for(let i=0;i<40&&[...rt.tsrc.values()].some(s=>s.dirty);i++){now+=5_000;await rt.step(now,{universe:uni,db,fetch});}
  const n1=rt.tradeCount,rows1=(await dynCounts(db)).dyn_trade_chunks!;assert.equal(rows1,rt.tsrc.size);
  await rt.step(now+130_000,{universe:uni,db,fetch});now+=140_000;// meta (watermarks, units)
  // restart
  const rt2=new DynamicResearch({minGapMs:15_000});const b2=calls.length;
  for(let i=0;i<60;i++){await rt2.step(now+i*5_000,{universe:uni,db,fetch,feed:feedOf(syms,now+i*5_000)});}
  assert.ok(rt2.booted&&rt2.tradesLoaded);assert.ok(Object.values(rt2.bf.series).every(s=>s.done));
  assert.ok(calls.length-b2<=8,`only tail refreshes after restart, no re-download (${calls.length-b2})`);
  assert.equal(rt2.unitQueue.length,0,"history units are not replayed again");
  assert.ok(rt2.tradeCount>=n1&&rt2.tradeCount<=n1+20,`no duplicates after restart (${n1} → ${rt2.tradeCount})`);
  // live management of an open pool trade (daily breakout trail) from the same bars; cached between ticks
  const b1d=rt2.get("BTC_USDT","1d")!,oa=(b1d.t[b1d.n-30]!+D)*1000+60_000,e0=b1d.c[b1d.n-30]!;
  const pos={id:"lv-x",symbol:"BTC_USDT",side:"LONG" as const,entryPrice:e0,stopPrice:e0*.5,openedAt:oa,guard:null,pb:"htf-down20",inv:e0*.5,target:null,maxBars:null};
  const pin=rt2.planInput(now+700_000,[{...pos,pb:"htf-donch20"}]);assert.equal(pin.exits.length,1);assert.equal(pin.exits[0]!.act,"GUARD");assert.ok(pin.exits[0]!.stop!>e0*.5);
  assert.deepEqual(rt2.planInput(now+701_000,[{...pos,pb:"htf-donch20"}]).exits,pin.exits,"same result from the cache");
  assert.equal(rt2.planInput(now+700_000,[{...pos,pb:"nope"}]).exits.length,0);
  rt2.analyze(now+700_000);const v=rt2.view(now+700_000);assert.equal(v.backfill.done,17);assert.equal(v.playbooks.length,POOL.length);assert.ok(v.state);assert.ok(v.intraday,"intraday state in the view");
  assert.ok(v.playbooks.filter(p=>p.tier==="long").every(p=>!p.gate?.ok||p.id==="htf-donch20"));
});
test("runtime: errors never throw; a missing D1 binding or a failing venue is recorded, and the venue is rotated",async()=>{
  const rt=new DynamicResearch();await rt.step(1,{universe:[],db:null,fetch:async()=>({})});assert.equal(rt.lastError,"D1 binding missing");
  const db=sqliteD1(),calls:string[]=[];let now=Date.UTC(2026,9,1);
  const rt2=new DynamicResearch({minGapMs:1});
  for(let i=0;i<10;i++){await rt2.step(now,{universe:[],db,fetch:async(u:string)=>{calls.push(u);throw new HttpStatusError(500);}});now+=10;}
  assert.ok(calls.some(u=>/bybit/.test(u))&&calls.some(u=>/okx/.test(u))&&calls.some(u=>/kucoin/.test(u)));
  assert.ok(rt2.bf.errTotal>=3);
});

// ---------------------------------------------------------------- engine wiring
const quotesAt=(now:number,px:Record<string,number>)=>Object.fromEntries(Object.entries(px).map(([s,p])=>[s,{bestBid:p*.9999,bestAsk:p*1.0001,observedAt:now-500,entryReady:true}]));
const emptyForward=():ForwardView=>({positions:[],history:[],opportunities:[]});
function engine(items:Partial<Record<string,boolean>>={},mode:"paper-enabled"|"compute-only"="paper-enabled",at=0){
  const e=new LivingEngine(at),cfg=defaultLivingConfig(at);e.restore(new Map([[LIVING_KEYS.config,{...cfg,mode,items:{...cfg.items,...items}}]]),at);return e;
}
const NOW=Date.UTC(2026,9,22,8,5);
const sig=(pb:string,sym:string,side:"LONG"|"SHORT"="LONG")=>({id:`ld-${pb}-${sym}-${NOW/1000-300}`,pb,label:POOL_BY_ID[pb]!.label,sym,side,iv:"1h" as const,et:NOW/1000-300,ep:10,stop:side==="LONG"?9.5:10.5,target:null,maxBars:48,why:"t",until:NOW+15*60_000});
const dynIn=(over:Partial<DynPlanInput>={}):DynPlanInput=>({ready:true,gates:{"box1h-long":{ok:true,risk:.005,conf:2/3,why:"ok"},"box1h-short":{ok:false,risk:0,conf:0,why:"规律未确认"}},signals:[],exits:[],state:"UP/MID",...over});
const ctx=(dyn:DynPlanInput,forward:ForwardView=emptyForward()):PlanContext=>({now:NOW,forward,quotes:quotesAt(NOW,{AAA_USDT:10,BBB_USDT:10,CCC_USDT:10}),contracts:{},funding:{},candles:{},dyn});
test("switch 10 dynAllocator: 10th item, default on, labelled",()=>{
  assert.equal(LIVING_ITEMS.length,10);assert.equal(LIVING_ITEMS[9],"dynAllocator");assert.match(LIVING_ITEM_LABELS.dynAllocator,/^10 动态分配/);
  assert.equal(defaultLivingConfig(0).items.dynAllocator,true);
});
test("engine: an allowed pool signal → order (hx+dp, allocator risk, absolute stop); not allowed / switch off → recorded only; sent once",()=>{
  const e=engine({},"paper-enabled",NOW);
  const d=e.plan(ctx(dynIn({signals:[sig("box1h-long","AAA_USDT"),sig("box1h-short","BBB_USDT","SHORT")]})))!;
  assert.equal(d.orders.length,1);const o=d.orders[0]!;
  assert.deepEqual([o.symbol,o.side,o.stop,o.riskRate,o.note.pb,o.note.hx,o.note.dp],["AAA_USDT","LONG",9.5,.005,"box1h-long",1,1]);
  assert.ok(e.log.some(r=>r.k==="DYN_SIGNAL"&&r.pb==="box1h-short"&&/分配器不允许/.test(String(r.reason))));
  e.afterForward({opened:[{orderId:o.id,tradeId:"lv-d",symbol:"AAA_USDT",side:"LONG",risk:5,notional:100}],rejected:[],applied:[]},emptyForward(),NOW);
  assert.equal(e.plan(ctx(dynIn({signals:[sig("box1h-long","AAA_USDT")]})))!.orders.length,0,"already sent");
  const off=engine({dynAllocator:false},"paper-enabled",NOW);assert.equal(off.plan(ctx(dynIn({signals:[sig("box1h-long","AAA_USDT")]})))!.orders.length,0);
  assert.ok(off.log.some(r=>r.k==="DYN_SIGNAL"&&/开关 10 关着/.test(String(r.reason))));
  const burst=engine({burstLeader:true},"paper-enabled",NOW);assert.equal(burst.plan(ctx(dynIn({signals:[sig("box1h-long","AAA_USDT")]})))!.orders.length,1,"burst-leader record-only filter does not drop pool orders");
});
test("engine: pool slots (8 total incl. daily breakout, 4 per playbook, one per coin); exits of open pool trades pass as LIVING_DYN_* actions",()=>{
  const mk=(i:number,pb:string)=>({id:`p${i}`,symbol:`X${i}_USDT`,side:"LONG" as const,entryPrice:1,stopPrice:.9,openedAt:NOW-D*1000,favorable:0,
    entryContext:{living:{v:"living-v2",k:"N",pb,inv:.9,hx:1,...(pb===HTF.pb?{}:{dp:1})} as LivingNote}});
  const four=Array.from({length:4},(_,i)=>mk(i,"box1h-long"));
  assert.equal(engine({},"paper-enabled",NOW).plan(ctx(dynIn({signals:[sig("box1h-long","AAA_USDT")]}),{...emptyForward(),positions:four}))!.orders.length,0,"4 per playbook");
  const eight=Array.from({length:8},(_,i)=>mk(i,HTF.pb));
  assert.equal(engine({},"paper-enabled",NOW).plan(ctx(dynIn({signals:[sig("box1h-long","AAA_USDT")]}),{...emptyForward(),positions:eight}))!.orders.length,0,"8 in the pool");
  const held=[{...mk(0,"x"),symbol:"AAA_USDT",entryContext:{living:{v:"living-v2",k:"N",pb:"x"} as LivingNote}}];
  assert.equal(engine({},"paper-enabled",NOW).plan(ctx(dynIn({signals:[sig("box1h-long","AAA_USDT")]}),{...emptyForward(),positions:held}))!.orders.length,0,"one per coin");
  const e=engine({dynAllocator:false},"paper-enabled",NOW);
  const d=e.plan(ctx(dynIn({exits:[{tradeId:"p1",act:"GUARD",stop:.95,why:"trail",code:"LIVING_DYN_TRAIL"},{tradeId:"p2",act:"EXIT",why:"到时",code:"LIVING_DYN_EXIT"},{tradeId:"nope",act:"EXIT",why:"x",code:"LIVING_DYN_EXIT"}]}),
    {...emptyForward(),positions:[mk(1,"box1h-long"),mk(2,"box1h-long")]}))!;
  assert.deepEqual(d.actions.filter(a=>a.code.startsWith("LIVING_DYN_")).map(a=>[a.tradeId,a.action]),[["p1","GUARD"],["p2","EXIT"]],"own trades only; pass with switch 10 off");
});
test("engine: switch 10 on gates the daily breakout — record only until the allocator allows it, then sized by its risk",()=>{
  const day=Math.floor(NOW/1000/D)*D,rows=(cs:number[])=>cs.map((c,i)=>({time:day-(cs.length-i)*D,open:i?cs[i-1]!:c,high:c*1.01,low:c*.99,close:c}));
  const htf={daily:{BTC_USDT:rows([...Array(109).fill(100),120]),AAA_USDT:rows([...Array(109).fill(10),11])},volume:{AAA_USDT:1e8},universe:["AAA_USDT"],notExternal:[]};
  const at=day*1000+5*60_000,q=quotesAt(at,{AAA_USDT:11,BTC_USDT:120});
  const c=(dyn?:DynPlanInput):PlanContext=>({now:at,forward:emptyForward(),quotes:q,contracts:{},funding:{},candles:{},htf,...(dyn?{dyn}:{})});
  const gated=engine({},"paper-enabled",at);assert.equal(gated.plan(c())!.orders.length,0);
  assert.ok(gated.log.some(r=>r.k==="DYN_GATE"&&/规律没确认前全部只记录/.test(String(r.reason))));
  const allowed=engine({},"paper-enabled",at);const d=allowed.plan(c(dynIn({gates:{[HTF.pb]:{ok:true,risk:.005,conf:2/3,why:"ok"}}})))!;
  assert.equal(d.orders.length,1);assert.equal(d.orders[0]!.riskRate,.005);assert.equal(d.orders[0]!.note.cf,.6667);
  const legacy=engine({dynAllocator:false},"paper-enabled",at);const l=legacy.plan(c())!;assert.equal(l.orders.length,1);assert.equal(l.orders[0]!.riskRate,HTF.riskRate);
});
test("leverage: the wide-stop rule holds for shorts too (stop within 40% of the liquidation distance)",()=>{
  for(const r of [.03,.08,.15,.3]){const lev=htfPaperLeverage(r,20,.005,.40,"SHORT")!;assert.ok(lev>=1&&lev<=10);
    if(lev>1){const liq=isolatedLiquidationPrice({entry:1,leverage:lev,side:"SHORT",maintenanceRate:.005})!;assert.ok(r<=.4*(liq-1)+1e-12);}}
  assert.equal(htfPaperLeverage(.5,20,.005,.40,"SHORT"),null);
});
test("worker wiring: the research step is launched off the tick, its view is in /living-status and the run-log export, requests never go to Gate",()=>{
  const w=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");
  assert.match(w,/this\.launchDynamicWork\(Date\.now\(\)\);/);assert.match(w,/dynamic=this\.dynamic\.view\(now\)/);assert.match(w,/status=\{\.\.\.\(status\?\?\{\}\),dynamic:/);
  const rt=readFileSync(new URL("../lib/dynamic/runtime.ts",import.meta.url),"utf8")+readFileSync(new URL("../lib/dynamic/venues.ts",import.meta.url),"utf8");
  assert.doesNotMatch(rt,/gateio|gate\.io|api\.gateio/i);
});
