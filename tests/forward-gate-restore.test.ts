/**
 * forward gate restored: the forward analysis (shadow trades, predictor scoring, allow-list, good/bad cycles) keeps running while
 * the paper orders are reversed. Reversal only touches the order direction and hold downstream; it never reaches the forward stats.
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

const idle=()=>{const calls:string[]=[];return {calls,fetch:(async(u:string)=>{calls.push(u);throw new Error("no network in this test");}) as never};};
const allowedOf=(rt:DynamicResearch)=>Object.entries(rt.gates!).filter(([,g])=>g.ok).map(([k])=>k).sort();
const lastTrade=(rt:DynamicResearch)=>{let m=0;for(const s of rt.tsrc.values())for(const r of s.rows)m=Math.max(m,r[1]);return m;};
/** a source of `days` days of 4-hourly trades of one playbook, all with the same net */
function addSource(rt:DynamicResearch,pb:string,net:number,days:number,from:number){
  const k=`l|SOL_USDT|5m|${from}x${pb}`,rows:TradeRow[]=[];let t=from;for(let n=0;n<days*6;n++){rows.push([0,t,t+1800,Math.round(net*1e6),100,100]);t+=4*H;}
  rt.tsrc.set(k,{k,sym:"SOL_USDT",iv:"5m",t0:from,pbs:[pb],rows,dirty:false});
}

test("forward analysis keeps recomputing: hourly, never in between, snapshot saved on demand, and a new analysis does not need a venue request",async()=>{
  const db=sqliteD1(),net=idle(),rt=new DynamicResearch({analyzeEveryMs:3_600_000,metaEveryMs:1});
  await rt.step(AT,{universe:[],db,fetch:net.fetch});assert.ok(rt.booted);
  fill(rt);asAny(rt).recount();
  await rt.step(AT+5_000,{universe:[],db,fetch:net.fetch});
  assert.equal(rt.lastAnalyzeAt,AT+5_000,"first analysis right away (trades and BTC/ETH are in memory)");
  assert.ok(allowedOf(rt).length>0);
  assert.equal((await readMeta<DynSnap>(db,rt.store,"snap"))!.at,AT+5_000,"snapshot written after the analysis");
  await rt.step(AT+30*60_000,{universe:[],db,fetch:net.fetch});assert.equal(rt.lastAnalyzeAt,AT+5_000,"no new data, 30 min: no new analysis");
  await rt.step(AT+3_600_000+10_000,{universe:[],db,fetch:net.fetch});assert.equal(rt.lastAnalyzeAt,AT+3_600_000+10_000,"hourly recompute");
  assert.equal((await readMeta<DynSnap>(db,rt.store,"snap"))!.at,AT+3_600_000+10_000);
  const v=rt.view(AT+3_600_000+20_000);assert.equal(v.snapshot.stale,false);assert.ok(v.snapshot.ageMin<=1,`ageMin ${v.snapshot.ageMin}`);
});

test("allow-list follows the forward data: a playbook that starts losing drops out, one that starts winning comes in",()=>{
  const rt=new DynamicResearch();fill(rt);asAny(rt).recount();rt.analyze(AT);
  const a=allowedOf(rt);assert.ok(a.length>0&&a.length<SHORT.length+3);
  const from=lastTrade(rt)+3600;
  for(const pb of a)addSource(rt,pb,-.004,8,from);
  for(const pb of SHORT.filter(x=>!a.includes(x)))addSource(rt,pb,.004,8,from);
  asAny(rt).recount();rt.analyze(AT+9*86_400_000);
  const b=allowedOf(rt);assert.notDeepEqual(b,a,"the allow-list is not fixed");
  for(const pb of a.filter(x=>SHORT.includes(x)))assert.ok(!b.includes(pb),`${pb} was losing, must leave`);
});

test("stale snapshot (the freeze left one): gates only record until the first fresh analysis, which restores the forward allow-list; the stopped period's shadow trades are found again once, without duplicates",async()=>{
  const db=sqliteD1(),src=new DynamicResearch();await src.step(AT,{universe:[],db,fetch:idle().fetch});
  fill(src);asAny(src).recount();src.analyze(AT);
  const allowed=allowedOf(src);assert.ok(allowed.length>0);
  // the live evaluation kept moving its watermark for a day without storing trades (the freeze)
  src.wm={"box5m-long|SOL_USDT":[Math.floor(AT/1000)+86_400,null],"box5m-short|ADA_USDT":[Math.floor(AT/1000)-600,null]};
  await asAny(src).saveMeta(db,AT);
  const later=AT+30*3_600_000,net=idle(),rt=new DynamicResearch({metaEveryMs:1});
  await rt.step(later,{universe:[],db,fetch:net.fetch});
  assert.equal(rt.snapStale,true);assert.equal(allowedOf(rt).length,0,"stale: record-only");
  assert.deepEqual(rt.wm["box5m-long|SOL_USDT"],[Math.floor(AT/1000),null],"watermark started back at the snapshot");
  assert.deepEqual(rt.wm["box5m-short|ADA_USDT"],[Math.floor(AT/1000)-600,null],"an older watermark is left alone");
  // trades load, BTC/ETH are there → the next step analyzes and the forward allow-list is back
  fill(rt);asAny(rt).recount();
  await rt.step(later+5_000,{universe:[],db,fetch:net.fetch});
  assert.equal(rt.snapStale,false);assert.equal(rt.lastAnalyzeAt,later+5_000);assert.deepEqual(allowedOf(rt),allowed);
  assert.equal((await readMeta<DynSnap>(db,rt.store,"snap"))!.at,later+5_000);
  assert.equal(rt.view(later+6_000).predictor.waiting.code,"ready");
  // re-found trades are merged by playbook + entry time: a second pass adds nothing
  const key="l|SOL_USDT|5m|d",rows:TradeRow[]=[[0,1_000,2_000,5,1,1]];
  const put=(asAny(rt) as unknown as {putTrades(k:string,sym:string,iv:"5m",t0:number,t:unknown[],r:boolean):void}).putTrades.bind(rt);
  const tr={id:"x",pb:"box5m-long",side:"LONG",sym:"SOL_USDT",iv:"5m",et:1_000,xt:2_000,ep:1,xp:1,stop0:1,net:5e-6,r:0,bars:1,why:"",exit:""};
  put(key,"SOL_USDT","5m",0,[tr],false);put(key,"SOL_USDT","5m",0,[tr],false);void rows;
  assert.equal(rt.tsrc.get(key)!.rows.length,1);
});

test("history pages: full = tail refresh + deep pages, tail = only newest bars of series that already have history; both ≤1 request / 15 s, external venues only",async()=>{
  const net=idle();
  for(const mode of ["full","tail"] as const){
    const db=sqliteD1(),rt=new DynamicResearch({history:mode,minGapMs:15_000});
    await rt.step(AT,{universe:["SOL_USDT"],db,fetch:net.fetch});
    for(let i=0;i<14;i++)await rt.step(AT+5_000+i*5_000,{universe:["SOL_USDT"],db,fetch:net.fetch});
    // backfill plan: BTC 1h finished earlier, last bar a few days old → needs a tail refresh
    const bf=rt.bf.series;bf["BTC_USDT|1h"]={sym:"BTC_USDT",iv:"1h",oldest:1,newest:Math.floor(AT/1000)-6*86_400,done:true,pages:5,bars:100,fails:0,retryAt:0,venue:0,lastError:null,doneAt:1} as never;
    const t=AT+10*60_000,before=net.calls.length;
    for(let i=0;i<120;i++)await rt.backfillTick(t+i*5_000,{universe:["SOL_USDT"],db,fetch:net.fetch});
    const n=net.calls.length-before;
    assert.ok(n<=41,`${mode}: ${n} requests in 10 min`);
    assert.ok(net.calls.slice(before).every(u=>/bybit|okx|kucoin/.test(u)&&!/gate/i.test(u)),"external venues only");
    if(mode==="tail")assert.ok(net.calls.slice(before).every(u=>/BTCUSDT|BTC-USDT|XBT/.test(u)),"tail mode asks only for the series that fell behind");
    else assert.ok(n>=1);
  }
});

test("worker wiring: no freeze mode left, history pages ≤4/min by default, step gap restored, research layer takes no live-order results",()=>{
  const w=readFileSync(new URL("../worker/index-clean.ts",import.meta.url),"utf8"),r=readFileSync(new URL("../lib/dynamic/runtime.ts",import.meta.url),"utf8");
  assert.doesNotMatch(w,/lean:true|opts\.lean/);assert.doesNotMatch(r,/opts\.lean/);
  assert.match(w,/new DynamicResearch\(\{history:DYN_HISTORY/);assert.match(w,/const DYN_HISTORY:"full"\|"tail"="tail"/);
  assert.match(w,/dynamic\.stepGapMs\(\)/);
  // nothing the live paper account produces can reach the research layer: the worker only hands it the 5m feed, the daily bars and
  // the engine's own forward-side shadow burst trades
  const used=new Set([...w.matchAll(/this\.dynamic\.(\w+)/g)].map(m=>m[1]));
  const allowed=new Set(["planInput","view","step","backfillTick","addExternal","events","poolRecs","poolSeq","booted","tradesLoaded","stepGapMs","lastStepAt","lastStepMs","maxStepMs","lastError","bootError","store","bf","tradeCount","allowed","opts"]);
  const extra=[...used].filter(x=>!allowed.has(x!));assert.deepEqual(extra,[],`unexpected research-layer inputs: ${extra}`);
  assert.match(w,/dynamic\.addExternal\(xs,now\)/);
});
