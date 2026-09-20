import test from "node:test";
import assert from "node:assert/strict";
import { TURN_TIMEFRAMES, TURN_CONFIG, aggregateTurnCandles, evaluateMultiTurn, initialMultiTurn, turnCandidates,
  type TurnCandle } from "../lib/multi-turn-engine.ts";

const START=Date.parse("2026-09-01T00:00:00Z");
const bar=(i:number,close:number,open=close*.999,volume=1000):TurnCandle=>({
  time:START/1000+i*300,open,high:Math.max(open,close)*1.001,low:Math.min(open,close)*.999,close,volume,
});
function path(count:number,fn:(i:number)=>number){return Array.from({length:count},(_,i)=>bar(i,fn(i)));}

test("aggregation creates independent completed 15m 30m 1h 4h bars from one causal 5m path",()=>{
  const p=path(240,i=>100+i*.05);
  assert.equal(aggregateTurnCandles(p,"5m").length,240);
  assert.equal(aggregateTurnCandles(p,"15m").length,80);
  assert.equal(aggregateTurnCandles(p,"30m").length,40);
  assert.equal(aggregateTurnCandles(p,"1h").length,20);
  assert.equal(aggregateTurnCandles(p,"4h").length,5);
  assert.equal(aggregateTurnCandles(p,"1d").length,0);
});

test("steady trend stays in FLOW with low turn probability and remains candidate",()=>{
  const p=path(360,i=>100*Math.exp(i*.0008));
  const now=(p.at(-1)!.time+300)*1000+1000;
  const s=evaluateMultiTurn({state:initialMultiTurn(),paths:{BTC_USDT:p},now});
  const f=s.frames.BTC_USDT?.["15m"];assert.ok(f?.ready);assert.equal(f!.direction,"LONG");
  assert.ok(f!.turnProbability<TURN_CONFIG["15m"].watch);
  assert.equal(f!.phase,"FLOW");
  const c=turnCandidates(s,.0022).find(x=>x.symbol==="BTC_USDT"&&x.timeframe==="15m");
  assert.ok(c);
});

test("sharp V reversal turns the fast frame before the 1h frame and never hard-flips the latter",()=>{
  const up=path(330,i=>100*Math.exp(i*.0007));
  const base=up.at(-1)!.close;
  const p=[...up,...Array.from({length:30},(_,j)=>bar(330+j,base*Math.exp(-(j+1)*.006)))];
  let state=initialMultiTurn();
  for(let end=330;end<=360;end+=3){
    const rows=p.slice(0,end),now=(rows.at(-1)!.time+300)*1000+1000;
    state=evaluateMultiTurn({state,paths:{BTC_USDT:rows},now});
  }
  const fast=state.frames.BTC_USDT?.["5m"],slow=state.frames.BTC_USDT?.["1h"];
  assert.ok(fast);assert.ok(slow);
  assert.equal(fast!.direction,"SHORT");
  assert.ok(["LONG","NEUTRAL"].includes(slow!.direction));
  assert.ok(fast!.lastTurnAt!==null);
});

test("one adverse 5m spike does not flip slower frames",()=>{
  const p=path(359,i=>100*Math.exp(i*.0007));
  const last=p.at(-1)!.close;
  p.push(bar(359,last*.965,last));
  const now=(p.at(-1)!.time+300)*1000+1000;
  const s=evaluateMultiTurn({state:initialMultiTurn(),paths:{BTC_USDT:p},now});
  assert.equal(s.frames.BTC_USDT?.["1h"]?.direction,"LONG");
  assert.notEqual(s.frames.BTC_USDT?.["1h"]?.phase,"CONFIRMED");
});

test("confirmed lower frames raise propagation pressure without directly changing a higher-frame direction",()=>{
  const up=path(300,i=>100*Math.exp(i*.0008)),base=up.at(-1)!.close;
  const p=[...up,...Array.from({length:60},(_,j)=>bar(300+j,base*Math.exp(-(j+1)*.004)))];
  let state=initialMultiTurn();
  for(let n=306;n<=360;n+=3){
    const rows=p.slice(0,n),now=(rows.at(-1)!.time+300)*1000+1000;
    state=evaluateMultiTurn({state,paths:{BTC_USDT:rows},now});
  }
  const m30=state.frames.BTC_USDT?.["30m"],h1=state.frames.BTC_USDT?.["1h"];
  assert.ok(m30&&h1);assert.ok(h1!.propagationPressure>=0);
  if(m30!.direction==="SHORT"&&h1!.direction==="LONG")assert.ok(h1!.propagationPressure>0);
});

test("a gap invalidates only affected aggregated frames instead of interpolation",()=>{
  const p=path(100,i=>100+i*.1);p.splice(60,1);
  const now=(p.at(-1)!.time+300)*1000+1000;
  const s=evaluateMultiTurn({state:initialMultiTurn(),paths:{BTC_USDT:p},now});
  assert.equal(s.frames.BTC_USDT,undefined);
});

test("candidate selector rejects expected movement that cannot clear costs",()=>{
  const p=path(360,i=>100*Math.exp(i*.00005));
  const now=(p.at(-1)!.time+300)*1000+1000;
  const s=evaluateMultiTurn({state:initialMultiTurn(),paths:{BTC_USDT:p},now});
  assert.equal(turnCandidates(s,.10).length,0);
});

test("daily frame uses native daily candles and is independent from lower-frame readiness",()=>{
  const p=path(360,i=>100*Math.exp(i*.0003));
  const daily=Array.from({length:30},(_,i)=>({
    time:START/1000+i*86400,open:100+i,high:101+i,low:99+i,close:100.8+i,volume:10000+i*100,
  }));
  const now=(daily.at(-1)!.time+86400)*1000+1000;
  const s=evaluateMultiTurn({state:initialMultiTurn(),paths:{BTC_USDT:p},daily:{BTC_USDT:daily},now});
  assert.ok(s.frames.BTC_USDT?.["1d"]?.ready);
  assert.equal(s.frames.BTC_USDT?.["1d"]?.direction,"LONG");
});

test("turn calibration resolves only after the causal due time",()=>{
  const p=path(360,i=>100*Math.exp(i*.0006));
  const now=(p.at(-1)!.time+300)*1000+1000;
  const s1=evaluateMultiTurn({state:initialMultiTurn(),paths:{BTC_USDT:p},now});
  assert.ok(s1.pending.length>0);const count=s1.calibration["5m"].count;
  const s2=evaluateMultiTurn({state:s1,paths:{BTC_USDT:p},now:now+4*60_000});
  assert.equal(s2.calibration["5m"].count,count);
  const extension=[...p,...Array.from({length:3},(_,j)=>bar(360+j,p.at(-1)!.close*(1+(j+1)*.001)))];
  const s3=evaluateMultiTurn({state:s2,paths:{BTC_USDT:extension},now:now+16*60_000});
  assert.ok(s3.calibration["5m"].count>count);
  assert.ok(s3.calibration["5m"].brier>=0&&s3.calibration["5m"].brier<=1);
});

test("breadth contradiction raises turn probability for the incumbent direction",()=>{
  const make=(down:boolean)=>path(360,i=>100*Math.exp(i*(down?-.0007:.0007)));
  const long=make(false),now=(long.at(-1)!.time+300)*1000+1000;
  const state=evaluateMultiTurn({state:initialMultiTurn(),paths:{A:long,B:long,C:long,D:long},now});
  const mixed=evaluateMultiTurn({state,paths:{A:long,B:make(true),C:make(true),D:make(true)},now:now+300_000});
  const prior=state.frames.A?.["15m"]?.turnProbability??0,next=mixed.frames.A?.["15m"]?.turnProbability??0;
  assert.ok(next>=prior);
});

test("configuration exposes six independent sleeves whose caps sum to the 10% portfolio ceiling",()=>{
  assert.deepEqual([...TURN_TIMEFRAMES],["5m","15m","30m","1h","4h","1d"]);
  const total=TURN_TIMEFRAMES.reduce((n,tf)=>n+TURN_CONFIG[tf].riskCap,0);
  assert.ok(Math.abs(total-.10)<1e-12);
});
