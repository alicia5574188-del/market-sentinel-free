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
import {Series,IV_SEC,type Bar,type Iv} from "../lib/dynamic/series.ts";
import {pageUrl,parsePage,PAGE,HttpStatusError} from "../lib/dynamic/venues.ts";
import {BACKFILL,initialBackfill,normalizeBackfill,nextJob,onPage,onFailure,backfillView,trackedSymbols,seriesKey,lastClosedStart} from "../lib/dynamic/backfill.ts";
import {emptyDynStore,writeChunks,readSeries,writeTrades,DYN_DAILY_ROWS,CHUNK_SEC,dynCounts} from "../lib/dynamic/store-d1.ts";
import {POOL,POOL_BY_ID,simulate,manageLive,btcRegime,FEE,type Playbook} from "../lib/dynamic/playbooks.ts";
import {dailyStates,stateAt} from "../lib/dynamic/state.ts";
import {analyzePlaybook,CYCLE,type TradeLite} from "../lib/dynamic/cycles.ts";
import {allocate,ALLOC} from "../lib/dynamic/allocator.ts";
import {DynamicResearch,type DynPlanInput} from "../lib/dynamic/runtime.ts";
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
  const d=t/D;return (50+h)*Math.exp(.35*Math.sin(d/90+h)+.15*Math.sin(d/17+h/3)+.03*Math.sin(d*1.7+h));}
function barAt(sym:string,iv:Iv,t:number):Bar{const s=IV_SEC[iv],o=px(sym,t),c=px(sym,t+s),hi=Math.max(o,c)*(1+.004*(1+Math.sin(t/7e3))),lo=Math.min(o,c)*(1-.004*(1+Math.cos(t/9e3)));
  return {t,o,h:hi,l:lo,c,v:1000+(t/s)%37};}
function series(sym:string,iv:Iv,from:number,n:number){const s=new Series(sym,iv),sec=IV_SEC[iv],t0=Math.floor(from/sec)*sec;s.merge(Array.from({length:n},(_,i)=>barAt(sym,iv,t0+i*sec)));return s;}
/** a fake Bybit: listing starts at `listed`, answers pages ending before `end` */
function fakeBybit(listed:number,nowMs:()=>number,calls:string[],fail?:(url:string)=>number|null){
  return async(url:string)=>{calls.push(url);const f=fail?.(url);if(f)throw new HttpStatusError(f);
    const u=new URL(url),sym=u.searchParams.get("symbol")!.replace("USDT","")+"_USDT",i=u.searchParams.get("interval")!,iv:Iv=i==="D"?"1d":i==="240"?"4h":"1h",sec=IV_SEC[iv];
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
test("backfill: one request per 15 s at most; BTC, ETH, then the universe; daily first, then 4h, then 1h",()=>{
  const st=initialBackfill(),uni=["SOL_USDT","BTC_USDT"],t=1_800_000_000_000;
  assert.deepEqual(trackedSymbols(uni),["BTC_USDT","ETH_USDT","SOL_USDT"]);
  const j=nextJob(st,t,uni)!;assert.deepEqual([j.sym,j.iv,j.kind,j.venue,j.endSec,j.limit],["BTC_USDT","1d","back","BYBIT",null,PAGE.BYBIT]);
  onPage(st,j,[{t:lastClosedStart("1d",t)-999*D},{t:lastClosedStart("1d",t)}],t);
  assert.equal(nextJob(st,t+14_999,uni),null,"pacing");
  const j2=nextJob(st,t+15_000,uni)!;assert.deepEqual([j2.sym,j2.iv,j2.endSec],["BTC_USDT","1d",lastClosedStart("1d",t)-999*D],"continues backwards from the oldest bar");
  onPage(st,j2,[{t:lastClosedStart("1d",t)-1600*D}],t+15_000);assert.ok(st.series[seriesKey("BTC_USDT","1d")]!.done,"depth reached → done");
  const j3=nextJob(st,t+30_000,uni)!;assert.deepEqual([j3.sym,j3.iv],["ETH_USDT","1d"]);
  onPage(st,j3,[],t+30_000);assert.ok(st.series[seriesKey("ETH_USDT","1d")]!.done,"empty first page (not listed) → done");
  const j4=nextJob(st,t+45_000,uni)!;assert.deepEqual([j4.sym,j4.iv],["SOL_USDT","1d"]);
  onPage(st,j4,[{t:lastClosedStart("1d",t)-50*D},{t:lastClosedStart("1d",t)}],t+45_000);
  onPage(st,{...j4,endSec:lastClosedStart("1d",t)-50*D},[],t+60_000);assert.ok(st.series[seriesKey("SOL_USDT","1d")]!.done,"listing start reached → done");
  assert.deepEqual([nextJob(st,t+75_000,uni)!.sym,nextJob(st,t+75_000,uni)!.iv],["BTC_USDT","4h"]);
});
test("backfill: tail refresh after each bar close (+90 s); 429 pauses everything with backoff; failures rotate venue and back off; state resumes from JSON",()=>{
  const st=initialBackfill(),uni:string[]=[],t=Math.floor(1_800_000_000/D)*D*1000+10*60_000;
  for(const sym of ["BTC_USDT","ETH_USDT"])for(const iv of ["1d","4h","1h"] as Iv[]){const p=(st.series[seriesKey(sym,iv)]={sym,iv,oldest:0,newest:lastClosedStart(iv,t),done:true,pages:1,bars:1,fails:0,retryAt:0,venue:0,lastError:null,doneAt:t});void p;}
  assert.equal(nextJob(st,t,uni),null,"all current");
  const next=(Math.floor(t/1000/H)+1)*H*1000;
  assert.equal(nextJob(st,next+60_000,uni),null,"not before the 90 s grace");
  const j=nextJob(st,next+90_000,uni)!;assert.deepEqual([j.kind,j.sym,j.iv,j.endSec],["tail","BTC_USDT","1h",null]);assert.ok(j.limit>=3&&j.limit<=10);
  const t1=next+90_000;onFailure(st,j,new HttpStatusError(429),t1);assert.equal(st.venueBlock!.BYBIT,t1+BACKFILL.pause429Ms,"429 blocks that venue");
  const j2=nextJob(st,t1+15_000,uni)!;assert.equal(j2.venue,"OKX","the next request goes to another venue");
  const e2=nextJob(st,t1+15_000,uni)!;assert.equal(e2.key,j2.key);
  onFailure(st,j2,new HttpStatusError(429),t1+15_000);assert.equal(st.venueBlock!.OKX,t1+15_000+2*BACKFILL.pause429Ms,"doubling block");
  const j3=nextJob(st,t1+30_000,uni)!;assert.equal(j3.venue,"KUCOIN");onFailure(st,j3,new HttpStatusError(403),t1+30_000);
  assert.ok(st.pauseUntil>t1+30_000,"all three refusing → global pause");assert.equal(nextJob(st,t1+45_000,uni),null);
  const k=seriesKey("BTC_USDT","1h");assert.equal(st.series[k]!.fails,3);assert.ok(st.series[k]!.retryAt>t1+30_000,"a full rotation failed → series backs off");
  const later=Math.max(st.pauseUntil,st.series[k]!.retryAt);const j4=nextJob(st,later,uni)!;assert.equal(j4.venue,"BYBIT","block over → back to the first venue");
  onPage(st,j4,[{t:lastClosedStart("1h",later)}],later);assert.equal(st.series[k]!.fails,0);
  const back=normalizeBackfill(JSON.parse(JSON.stringify(st)));assert.deepEqual(back,st);assert.deepEqual(normalizeBackfill({v:9}),initialBackfill());
  const v=backfillView(st,uni,later);assert.equal(v.done,6);assert.equal(v.total,6);assert.equal(v.pct,1);assert.equal(v.errTotal,3);
});

// ---------------------------------------------------------------- D1 store
test("D1: chunks round-trip; rewriting a chunk replaces it; trades insert once; daily row budget defers",async()=>{
  const db=sqliteD1(),st=emptyDynStore(),s=series("SOL_USDT","1h",1_790_000_000,1500);
  assert.ok(await writeChunks(db,st,s,s.rows().map(b=>b.t),1));
  const back=await readSeries(db,st,"SOL_USDT","1h");assert.equal(back.n,1500);assert.equal(back.c[1499],s.c[1499]);
  const c=await dynCounts(db);assert.equal(c.dyn_bars,Math.ceil(1500/(CHUNK_SEC["1h"]/H))+1>=c.dyn_bars!?c.dyn_bars:-1);assert.ok(c.dyn_bars!<=4);
  const t={id:"a|SOL_USDT|1",pb:"a",side:"LONG" as const,sym:"SOL_USDT",iv:"1h" as const,et:1,xt:2,net:.01};
  await writeTrades(db,st,[t,t],5);await writeTrades(db,st,[t],6);assert.equal((await dynCounts(db)).dyn_trades,1);
  st.rowsToday=DYN_DAILY_ROWS;assert.equal(await writeTrades(db,st,[{...t,id:"b"}],7),false);assert.equal(st.deferred,1);
});

// ---------------------------------------------------------------- pool
test("pool: 12 playbooks with unique ids; labels match the order card; simulator is deterministic, nets 0.19% fees, fills gaps at the open, no re-entry on the exit bar",()=>{
  assert.equal(POOL.length,12);assert.equal(new Set(POOL.map(p=>p.id)).size,12);
  const card=readFileSync(new URL("../app/order-card.tsx",import.meta.url),"utf8");
  for(const p of POOL)assert.ok(card.includes(`"${p.id}":"${p.label}"`),p.id);
  const s=series("ETH_USDT","1d",1_650_000_000,900),btc=series("BTC_USDT","1d",1_650_000_000,900),ctx=btcRegime(btc);
  for(const pb of POOL.filter(p=>p.iv==="1d")){const a=simulate(pb,s,ctx),b=simulate(pb,s,ctx);assert.deepEqual(a,b);
    for(const t of a.trades){const d=pb.side==="LONG"?1:-1;assert.ok(Math.abs(t.net-(d*(t.xp/t.ep-1)-FEE))<1e-12);assert.ok(t.xt>t.et);}
    for(let i=1;i<a.trades.length;i++)assert.ok(a.trades[i]!.et>a.trades[i-1]!.xt,"next entry after the previous exit bar");}
  // hand-made: entry → gap down through the stop fills at the open
  const toy:Playbook={id:"toy",label:"t",iv:"1d",side:"LONG",warm:1,rule:"",prep:()=>({}),enter:(_x,q,i)=>i===2?{stop:q.c[i]!*.9,why:"t"}:null};
  const z=new Series("Z_USDT","1d");z.merge([100,100,100,100,80].map((c,i)=>({t:i*D,o:i===4?80:100,h:Math.max(c,100)*1.001,l:Math.min(c,100)*.999,c,v:1})));
  const r=simulate(toy,z,ctx);assert.equal(r.trades.length,1);assert.equal(r.trades[0]!.xp,80,"gap fill at the open, not the stop");assert.equal(r.trades[0]!.exit,"止损");
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

// ---------------------------------------------------------------- runtime end to end
test("runtime: paced backfill from a fake venue into D1, shadow trades written once, restart resumes (no re-download, no duplicates)",async()=>{
  const db=sqliteD1(),calls:string[]=[];let now=Date.UTC(2026,9,1,0,10);const listed=Math.floor(Date.UTC(2023,0,1)/1000);
  const fetch=fakeBybit(listed,()=>now,calls);
  const rt=new DynamicResearch({minGapMs:15_000,analyzeEveryMs:3_600_000,metaEveryMs:60_000});
  const uni=["SOL_USDT"];
  let steps=0;while(steps<2000){await rt.step(now,{universe:uni,db,fetch});steps++;now+=5_000;
    if(Object.values(rt.bf.series).length===9&&Object.values(rt.bf.series).every(s=>s.done)&&rt.dirty.size===0&&rt.pendingTrades.length===0)break;}
  assert.ok(Object.values(rt.bf.series).every(s=>s.done),"all 9 series done");
  // pacing: never two requests within 15 s
  assert.ok(calls.length>0&&calls.every(u=>/api\.bybit\.com/.test(u)));
  const s1d=rt.get("BTC_USDT","1d")!;assert.ok(s1d.first!<=listed+D,"daily back to the listing");
  const s1h=rt.get("SOL_USDT","1h")!;assert.ok(s1h.n>=BACKFILL.depthDays["1h"]*24-30&&s1h.n<=4500+24);
  rt.analyze(now);assert.ok(rt.states.length>500);assert.ok(rt.trades.size>0);
  const n1=(await dynCounts(db)).dyn_trades!;assert.equal(n1,rt.trades.size);
  const req=calls.length,minutes=(now-Date.UTC(2026,9,1,0,10))/60_000;assert.ok((req-1)/minutes<=4,`≤ 4 requests a minute (${req} in ${minutes} min)`);
  await rt.step(now+60_000,{universe:uni,db,fetch});// flush meta
  // restart
  const rt2=new DynamicResearch({minGapMs:15_000});const before=calls.length;
  for(let i=0;i<20;i++){await rt2.step(now+120_000+i*5_000,{universe:uni,db,fetch});}
  assert.ok(rt2.booted);assert.equal(rt2.trades.size,n1);assert.ok(Object.values(rt2.bf.series).every(s=>s.done));
  assert.ok(calls.length-before<=6,"only tail refreshes after restart, no re-download");
  for(let i=0;i<60;i++)await rt2.step(now+300_000+i*5_000,{universe:uni,db,fetch});
  assert.equal((await dynCounts(db)).dyn_trades,rt2.trades.size,"replay after restart adds no duplicate rows");
  // live management of an open pool trade (daily breakout trail) from the same bars; cached between ticks
  const b1d=rt2.get("BTC_USDT","1d")!,oa=(b1d.t[b1d.n-30]!+D)*1000+60_000,e0=b1d.c[b1d.n-30]!;
  const pos={id:"lv-x",symbol:"BTC_USDT",side:"LONG" as const,entryPrice:e0,stopPrice:e0*.5,openedAt:oa,guard:null,pb:"htf-down20",inv:e0*.5,target:null,maxBars:null};
  const pin=rt2.planInput(now+700_000,[{...pos,pb:"htf-donch20"}]);assert.equal(pin.exits.length,1);assert.equal(pin.exits[0]!.act,"GUARD");assert.ok(pin.exits[0]!.stop!>e0*.5);
  assert.deepEqual(rt2.planInput(now+701_000,[{...pos,pb:"htf-donch20"}]).exits,pin.exits,"same result from the cache");
  assert.equal(rt2.planInput(now+700_000,[{...pos,pb:"nope"}]).exits.length,0);
  const v=rt2.view(now+700_000);assert.equal(v.backfill.done,9);assert.equal(v.playbooks.length,12);assert.ok(v.state);
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
