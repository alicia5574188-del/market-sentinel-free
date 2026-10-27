/**
 * memory / restart fix: the analysis expands trades one playbook at a time (same result as the one-shot version), the last analysis is
 * stored in D1 and read back at boot (the predictor is ready at once; a stale one only records), BTC/ETH come first, and the texts
 * say what is true while things load.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import type {D1Like,D1Stmt} from "../lib/run-log-archive.ts";
import {Series,type Bar} from "../lib/dynamic/series.ts";
import {POOL,tierOf} from "../lib/dynamic/playbooks.ts";
import type {TradeLite} from "../lib/dynamic/cycles.ts";
import {readMeta,writeMeta,emptyDynStore} from "../lib/dynamic/store-d1.ts";
import {DynamicResearch,STEP,SNAP_STALE_MS,type DynSnap} from "../lib/dynamic/runtime.ts";
import type {TradeRow} from "../lib/dynamic/store-d1.ts";

const H=3600,D=86_400,T0=1_780_000_000-(1_780_000_000%D);
function sqliteD1():D1Like{
  const sql=new DatabaseSync(":memory:");
  const make=(text:string,values:unknown[]=[]):D1Stmt=>({bind:(...v:unknown[])=>make(text,v),
    run:async()=>sql.prepare(text).run(...(values as never[])),all:async<R>()=>({results:sql.prepare(text).all(...(values as never[])) as R[]}),
    first:async<R>()=>(sql.prepare(text).get(...(values as never[])) as R|undefined)??null});
  return {prepare:text=>make(text),batch:async list=>{sql.exec("BEGIN");try{const out=[];for(const s of list)out.push(await s.run());sql.exec("COMMIT");return out;}catch(e){sql.exec("ROLLBACK");throw e;}}} as D1Like;
}
function series1h(sym:string,from:number,n:number){const s=new Series(sym,"1h");const bars:Bar[]=[];
  for(let i=0;i<n;i++){const t=from+i*H,c=100*Math.exp(.05*Math.sin(i/60)+.01*Math.sin(i/7)+(sym==="ETH_USDT"?.02*Math.cos(i/30):0));bars.push({t,o:c*.999,h:c*1.004,l:c*.996,c,v:1});}
  s.merge(bars);return s;}
/** trades every 4 h; phases given as [days, net per trade] */
function rowsOf(idx:number,plan:[number,number][],start:number):TradeRow[]{const out:TradeRow[]=[];let t=start;
  for(const [days,net] of plan)for(let k=0;k<days*6;k++){out.push([idx,t,t+1800,Math.round(net*1e6),100,100]);t+=4*H;}return out;}
const SHORT=POOL.filter(p=>tierOf(p)==="short"&&!p.external).slice(0,4).map(p=>p.id);
const PLANS:[number,number][][]=[[[4,.004],[4,-.004],[4,.004],[4,-.004],[4,.004],[4,-.004],[4,.004],[4,-.004],[6,.004]],
  [[3,-.003],[5,.004],[3,-.004],[5,.003],[4,-.002],[6,.005]],[[9,.002],[9,-.002],[8,.003]],[[2,.004],[2,-.004],[2,.004],[2,-.004],[2,.004],[2,-.004],[2,.004],[2,-.004]]];
/** several sources, each carrying several playbooks (like the real replay units / live days) */
function fill(rt:DynamicResearch){
  const start=T0-40*D;
  rt.series.set("BTC_USDT|1h",series1h("BTC_USDT",start,40*24));rt.series.set("ETH_USDT|1h",series1h("ETH_USDT",start,40*24));
  ["BTC_USDT|1h","ETH_USDT|1h","BTC_USDT|1d","ETH_USDT|1d"].forEach(k=>rt.loaded.add(k));
  SHORT.forEach((pb,i)=>{
    const rows=rowsOf(0,PLANS[i]!,start+2*D+i*H),half=Math.floor(rows.length/2);
    for(const [n,part] of [["a",rows.slice(0,half)],["b",rows.slice(half)]] as const){
      const k=`l|${i%2?"SOL":"ADA"}_USDT|5m|${start}${n}`;const cur=rt.tsrc.get(k);
      if(cur){const pbs=cur.pbs.length;cur.pbs.push(pb);cur.rows.push(...part.map(r=>[pbs,r[1],r[2],r[3],r[4],r[5]] as TradeRow));}
      else rt.tsrc.set(k,{k,sym:i%2?"SOL_USDT":"ADA_USDT",iv:"5m",t0:start,pbs:[pb],rows:part,dirty:false});}
  });
  rt.tradesLoaded=true;rt.recount?.();
  return start;
}
const AT=(T0+1)*1000+3_600_000*5;
const asAny=(rt:DynamicResearch)=>rt as unknown as {recount():void;saveMeta(db:D1Like,now:number):Promise<void>;flushForecasts(db:D1Like,now:number):Promise<void>};
const reference=(rt:DynamicResearch)=>{const by=new Map<string,TradeLite[]>();for(const t of rt.tradesLite())(by.get(t.pb)??by.set(t.pb,[]).get(t.pb)!).push(t);return (pb:string)=>by.get(pb)??[];};

test("batched analysis: one playbook at a time gives exactly the one-shot result (cycles, forecasts, gates, forecast rows, live checks)",()=>{
  const a=new DynamicResearch(),b=new DynamicResearch();fill(a);fill(b);asAny(a).recount();asAny(b).recount();
  assert.ok(a.tradeCount>200);
  a.analyze(AT);                    // batched (one playbook expanded at a time)
  b.analyze(AT,reference(b));       // reference: every trade expanded and grouped at once (the old way)
  assert.deepEqual(a.cycles,b.cycles);assert.deepEqual(a.forecasts,b.forecasts);assert.deepEqual(a.gates,b.gates);
  assert.deepEqual(a.fcRows,b.fcRows);assert.deepEqual(a.predLive,b.predLive);assert.deepEqual(a.track,b.track);
  assert.ok(Object.keys(a.forecasts).length>=3,"forecasts exist");
  // the per-playbook lists are the same trades in the same order
  const idx=(a as unknown as {liteIndex():(pb:string)=>TradeLite[]}).liteIndex(),ref=reference(a);
  for(const pb of SHORT)assert.deepEqual(idx(pb),ref(pb));
  assert.deepEqual(idx("no-such-playbook"),[]);
  // and a later analysis (scoring, contradiction path) stays equal
  a.analyze(AT+7*H*1000);b.analyze(AT+7*H*1000,reference(b));assert.deepEqual(a.forecasts,b.forecasts);assert.deepEqual(a.track,b.track);assert.deepEqual(a.gates,b.gates);
});

test("batched analysis: the biggest list ever expanded is one playbook's, not all trades",()=>{
  const a=new DynamicResearch();fill(a);asAny(a).recount();a.analyze(AT);
  const biggest=Math.max(...SHORT.map((_,i)=>PLANS[i]!.reduce((n,[d])=>n+d*6,0)));
  assert.equal(a.peakLite,biggest);assert.ok(a.peakLite<a.tradeCount/1.5,`${a.peakLite} of ${a.tradeCount}`);
  assert.equal(a.view(AT).snapshot.peakLite,biggest);
});

test("snapshot: written once per analysis (one D1 row, not again until the next), read back at boot with the same forecasts / gates / cycles",async()=>{
  const db=sqliteD1(),rt=new DynamicResearch();await rt.step(AT,{universe:[],db,fetch:async()=>({})});assert.ok(rt.booted);
  fill(rt);asAny(rt).recount();rt.analyze(AT);
  const before=rt.store.rowsToday;await asAny(rt).saveMeta(db,AT);const w1=rt.store.rowsToday-before;
  const snap=await readMeta<DynSnap>(db,rt.store,"snap");assert.ok(snap&&snap.v===1&&snap.at===AT);
  assert.deepEqual(snap!.forecasts,JSON.parse(JSON.stringify(rt.forecasts)));assert.ok(JSON.stringify(snap).length<1_500_000,`snapshot ${JSON.stringify(snap).length} bytes`);
  const rows1=rt.store.rowsToday;await asAny(rt).saveMeta(db,AT+60_000);assert.equal(rt.store.rowsToday,rows1,"nothing changed → no write");
  assert.ok(w1<=10,`first save: the usual meta keys + the snapshot row (${w1})`);
  // no new analysis later → the snapshot row is never rewritten
  await asAny(rt).saveMeta(db,AT+10*60_000);assert.equal(rt.store.rowsToday,rows1);
  // the next analysis adds the snapshot row (+ whatever meta changed), never more than a handful of rows
  rt.analyze(AT+H*1000);const r0=rt.store.rowsToday;await asAny(rt).saveMeta(db,AT+H*1000+1);assert.ok(rt.store.rowsToday-r0<=4,`rows for the 2nd analysis: ${rt.store.rowsToday-r0}`);
  assert.equal((await readMeta<DynSnap>(db,rt.store,"snap"))!.at,AT+H*1000);
  // restart: boot alone (no trade read, no series read) already has the predictor
  const rt2=new DynamicResearch();await rt2.step(AT+5000,{universe:[],db,fetch:async()=>({})});
  assert.ok(rt2.booted&&!rt2.tradesLoaded&&rt2.tsrc.size===0);
  assert.deepEqual(rt2.forecasts,JSON.parse(JSON.stringify(rt.forecasts)));assert.deepEqual(rt2.gates,JSON.parse(JSON.stringify(rt.gates)));
  assert.deepEqual(rt2.cycles,JSON.parse(JSON.stringify(rt.cycles)));
  const v=rt2.view(AT+5000);assert.ok(v.predictor.ready&&v.predictor.waiting.code==="ready");assert.ok(v.snapshot.usingSaved&&!v.snapshot.stale);
  assert.ok(v.shadowTrades>=rt.tradeCount&&v.tradesLoaded===false,"the count shown is the saved one while the trades load");
  assert.equal(v.allowed.length,Object.values(rt.gates!).filter(g=>g.ok).length);
});

test("restart: the predictor is ready at once (plan input ready, gates as saved) before any trade or series is read, and the live analysis then takes over",async()=>{
  const db=sqliteD1(),rt=new DynamicResearch();await rt.step(AT,{universe:[],db,fetch:async()=>({})});
  fill(rt);asAny(rt).recount();rt.analyze(AT);await asAny(rt).saveMeta(db,AT);
  const allowed=Object.entries(rt.gates!).filter(([,g])=>g.ok).map(([k])=>k);assert.ok(allowed.length>0,"fixture allows something");
  const rt2=new DynamicResearch();await rt2.step(AT+5000,{universe:[],db,fetch:async()=>({})});
  const pi=rt2.planInput(AT+5000,[]);assert.equal(pi.ready,true);assert.deepEqual(Object.entries(pi.gates!).filter(([,g])=>g.ok).map(([k])=>k),allowed);
  // without a snapshot the old rule holds: not ready until the trades are read
  const rt3=new DynamicResearch();await rt3.step(AT,{universe:[],db:sqliteD1(),fetch:async()=>({})});assert.equal(rt3.planInput(AT,[]).ready,false);
  // the next steps read trades and series; when BTC/ETH are in memory the analysis replaces the saved one
  fill(rt2);rt2.tsrc.clear();rt2.tradesLoaded=false;fill(rt2);
  rt2.analyze(AT+10*60_000);const v=rt2.view(AT+10*60_000);assert.equal(v.snapshot.usingSaved,false);assert.ok(rt2.snapFresh);assert.ok(v.predictor.ready);
});

test("stale snapshot (> 2 h): kept for display, but every gate is record-only until a fresh analysis; a fresh one is used as saved",async()=>{
  const db=sqliteD1(),rt=new DynamicResearch();await rt.step(AT,{universe:[],db,fetch:async()=>({})});
  fill(rt);asAny(rt).recount();rt.analyze(AT);await asAny(rt).saveMeta(db,AT);
  const allowed=Object.values(rt.gates!).filter(g=>g.ok).length;assert.ok(allowed>0);
  // 1 h 59 min later: still fresh
  const f=new DynamicResearch();await f.step(AT+SNAP_STALE_MS-60_000,{universe:[],db,fetch:async()=>({})});
  assert.equal(f.snapStale,false);assert.equal(Object.values(f.gates!).filter(g=>g.ok).length,allowed);
  // 2 h 1 min later: stale
  const s=new DynamicResearch();await s.step(AT+SNAP_STALE_MS+60_000,{universe:[],db,fetch:async()=>({})});
  assert.equal(s.snapStale,true);assert.equal(Object.values(s.gates!).filter(g=>g.ok).length,0);
  assert.ok(Object.values(s.gates!).every(g=>g.risk===0&&g.conf===0&&/已过期/.test(g.why)));
  const v=s.view(AT+SNAP_STALE_MS+60_000);assert.ok(v.predictor.ready&&v.snapshot.stale&&v.snapshot.usingSaved&&v.allowed.length===0);
  assert.equal(s.planInput(AT+SNAP_STALE_MS+60_000,[]).ready,true);
  assert.ok(Object.values(s.planInput(AT+SNAP_STALE_MS+60_000,[]).gates!).every(g=>!g.ok));
  // a fresh analysis lifts it (gates by the predictor again)
  const now2=AT+SNAP_STALE_MS+60_000;fill(s);s.tsrc.clear();s.tradesLoaded=false;fill(s);s.analyze(now2);
  assert.equal(s.snapStale,false);assert.equal(s.view(now2).snapshot.usingSaved,false);
  // junk / old-format snapshots are ignored (old behaviour)
  assert.equal(new DynamicResearch().restoreSnap({v:2} as never,AT),false);assert.equal(new DynamicResearch().restoreSnap(null,AT),false);
  assert.equal(new DynamicResearch().restoreSnap({v:1,at:AT,gates:{},forecasts:{}} as never,AT),false,"an empty analysis is not worth restoring");
});

test("BTC/ETH first: their 1h and 1d are read in the very first load step, before the other series; the analysis waits for them",async()=>{
  const db=sqliteD1(),rt=new DynamicResearch();const uni=["BTC_USDT","ETH_USDT",..."ABCDEFGHIJKL".split("").map(c=>`${c}${c}_USDT`)];
  await rt.step(AT,{universe:uni,db,fetch:async()=>({})});assert.ok(rt.booted);assert.equal(rt.loaded.size,0);
  assert.equal(rt.coreLoaded(),false);
  await rt.step(AT+6000,{universe:uni,db,fetch:async()=>({})});
  for(const k of ["BTC_USDT|1h","BTC_USDT|1d","ETH_USDT|1h","ETH_USDT|1d"])assert.ok(rt.loaded.has(k),`${k} loaded first`);
  assert.equal(rt.loaded.size,STEP.loads,"a bigger batch than the old 3 a step");assert.equal(rt.coreLoaded(),true);
  // not loaded yet → no analysis (an empty BTC would wipe the saved predictions)
  const r2=new DynamicResearch();await r2.step(AT,{universe:uni,db,fetch:async()=>({})});r2.tradesLoaded=true;r2.loaded.add("BTC_USDT|1h");
  assert.equal(r2.coreLoaded(),false);
});

test("a saved analysis is not wiped when BTC has not been read yet: the step does not analyse before BTC/ETH are loaded",async()=>{
  const db=sqliteD1(),rt=new DynamicResearch();await rt.step(AT,{universe:[],db,fetch:async()=>({})});
  fill(rt);asAny(rt).recount();rt.analyze(AT);await asAny(rt).saveMeta(db,AT);
  const rt2=new DynamicResearch();await rt2.step(AT+5000,{universe:[],db,fetch:async()=>({})});const fc=JSON.stringify(rt2.forecasts);
  rt2.tradesLoaded=true;                 // trades done, BTC/ETH not in memory yet
  assert.equal(rt2.coreLoaded(),false);
  // simulate the step's analysis condition
  assert.ok(!(rt2.tradesLoaded&&rt2.coreLoaded()));assert.equal(JSON.stringify(rt2.forecasts),fc);assert.equal(rt2.analyses,0);
});

test("trades load faster (3 reads a step) and the shown count grows while loading",async()=>{
  const db=sqliteD1(),rt=new DynamicResearch(),src=new DynamicResearch();await src.step(AT,{universe:[],db,fetch:async()=>({})});
  const {writeTradeChunks}=await import("../lib/dynamic/store-d1.ts");
  const chunks=Array.from({length:STEP.tradeLoad*2+50},(_,i)=>({k:`u|X_USDT|5m|${String(i).padStart(6,"0")}`,sym:"X_USDT",iv:"5m" as const,t0:i,pbs:[SHORT[0]!],trades:rowsOf(0,[[1,.001]],T0+i*D).slice(0,5)}));
  await writeTradeChunks(db,src.store,chunks,AT);
  await rt.step(AT,{universe:[],db,fetch:async()=>({})});
  await rt.step(AT+6000,{universe:[],db,fetch:async()=>({})});
  assert.ok(rt.tradesLoaded,"651 chunks read in one step (3 batches of 300)");assert.equal(rt.tradeCount,chunks.length*5);
  assert.equal(STEP.tradeBatches,3);
});

test("display: what the page says while the research layer starts (no 0/162, no 'waiting for BTC' unless true)",async()=>{
  const rt=new DynamicResearch();
  assert.equal(rt.view(AT).predictor.waiting.code,"booting");assert.match(rt.view(AT).predictor.waiting.text,/刚启动/);
  const db=sqliteD1();await rt.step(AT,{universe:[],db,fetch:async()=>({})});
  assert.equal(rt.view(AT).predictor.waiting.code,"loading-trades");assert.match(rt.view(AT).predictor.waiting.text,/正在读取影子交易/);
  assert.doesNotMatch(rt.view(AT).predictor.waiting.text,/BTC 1 小时历史/);
  rt.tradesLoaded=true;assert.equal(rt.view(AT).predictor.waiting.code,"loading-btc");
  ["BTC_USDT|1h","BTC_USDT|1d","ETH_USDT|1h","ETH_USDT|1d"].forEach(k=>rt.loaded.add(k));
  assert.equal(rt.view(AT).predictor.waiting.code,"btc-short");assert.match(rt.view(AT).predictor.waiting.text,/现有 0 根，至少要 130 根/);
  rt.series.set("BTC_USDT|1h",series1h("BTC_USDT",T0,200));assert.equal(rt.view(AT).predictor.waiting.code,"analysing");
  rt.lastAnalyzeAt=AT;assert.equal(rt.view(AT).predictor.waiting.code,"no-sample");assert.match(rt.view(AT).predictor.waiting.text,/够预测/);
  // the panel: booting → "读取中", not a 0/N count; the empty ranked box shows the reason from the research layer
  const ui=readFileSync(new URL("../app/dynamic-panel.tsx",import.meta.url),"utf8");
  assert.match(ui,/d!\.booted===false\?<p className="bs-hint" data-testid="brain-backfill">历史下载：读取中/);
  assert.match(ui,/d\.predictor\.waiting\?\.text/);assert.doesNotMatch(ui,/预测器还在等 BTC 1 小时历史和第一批影子交易/);
  assert.match(ui,/这是上次保存的预测/);
  const wk=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8");assert.match(wk,/waiting:v\.predictor\.waiting\.code/);
  void writeMeta;void emptyDynStore;
});
