import test from "node:test";
import assert from "node:assert/strict";
import {assessStrongBreakout,evaluateMicroRestart} from "../lib/micro-restart.ts";

const bar=(time:number,open:number,high:number,low:number,close:number)=>({time,open,high,low,close,volume:1000});

for(const side of ["LONG","SHORT"] as const){
  const mirror=(r:ReturnType<typeof bar>)=>side==="LONG"?r:{...r,open:200-r.open,high:200-r.low,low:200-r.high,close:200-r.close};
  test(`${side}: a second consecutive strong 1m extreme break confirms without a pullback`,()=>{
    const result=evaluateMicroRestart({breakout:mirror(bar(0,100,102.2,99.9,102)),
      following:[mirror(bar(60,102,103.05,101.98,103))],side,triggerPrice:side==="LONG"?100.8:99.2,costRate:.0022,regionWidthRate:.02});
    assert.equal(result.state,"READY");assert.equal(result.confirmation,"CONTINUATION");assert.equal(result.restartAt,120_000);
  });
  test(`${side}: a weak second extreme break cannot masquerade as a strong continuation`,()=>{
    const result=evaluateMicroRestart({breakout:mirror(bar(0,100,102.2,99.9,102)),
      following:[mirror(bar(60,102.16,102.29,102.15,102.27))],side,triggerPrice:side==="LONG"?100.8:99.2,costRate:.0022,regionWidthRate:.02});
    assert.equal(result.state,"WAIT");
  });
}

test("missing intervening minute does not create a false two-bar confirmation",()=>{
  const result=evaluateMicroRestart({breakout:bar(0,100,102.2,99.9,102),following:[bar(120,102,103.05,101.98,103)],
    side:"LONG",triggerPrice:100.8,costRate:.0022,regionWidthRate:.02});
  assert.equal(result.state,"WAIT");assert.match(result.reason,/不跨缺口/);
});

test("BCH-like strong 1m impulse plus small pullback waits, then accepts the first real restart",()=>{
  const breakout=bar(0,100,102.2,99.9,102.0);
  const q=assessStrongBreakout({bar:breakout,side:"LONG",triggerPrice:100.8,costRate:.0022,regionWidthRate:.02});
  assert.equal(q.ok,true);
  const waiting=evaluateMicroRestart({breakout,side:"LONG",triggerPrice:100.8,costRate:.0022,regionWidthRate:.02,
    following:[bar(60,102,102.05,101.45,101.60),bar(120,101.60,101.72,101.30,101.45)]});
  assert.equal(waiting.state,"WAIT");
  const ready=evaluateMicroRestart({breakout,side:"LONG",triggerPrice:100.8,costRate:.0022,regionWidthRate:.02,
    following:[bar(60,102,102.05,101.45,101.60),bar(120,101.60,101.72,101.30,101.45),bar(180,101.45,102.05,101.42,101.95)]});
  assert.equal(ready.state,"READY");
  assert.ok(ready.cumulativeAdverseBodyRate<q.bodyRate);
  assert.ok((ready.restartPrice??0)>101.72);
});

test("MET-like breakout with a large upper wick is not a launch even before later weakness is considered",()=>{
  const fake=bar(0,100,103.3,99.9,101.25);
  const q=assessStrongBreakout({bar:fake,side:"LONG",triggerPrice:100.8,costRate:.0022,regionWidthRate:.02});
  assert.equal(q.ok,false);
  assert.ok(q.wickToBody>.38||q.closeLocation<.74);
});

test("several small red candles become invalid when their combined giveback is too large",()=>{
  const breakout=bar(0,100,102.2,99.9,102.0);
  const result=evaluateMicroRestart({breakout,side:"LONG",triggerPrice:100.8,costRate:.0022,regionWidthRate:.02,
    following:[bar(60,102,102.05,101.25,101.30),bar(120,101.30,101.35,100.35,100.40)]});
  assert.equal(result.state,"FAIL");
  assert.match(result.reason,/不再属于小回调/);
});

test("breakout strength must remain clearly larger than cumulative opposite candle bodies",()=>{
  const breakout=bar(0,100,101.65,99.95,101.50);
  const result=evaluateMicroRestart({breakout,side:"LONG",triggerPrice:100.5,costRate:.0015,regionWidthRate:.012,
    following:[bar(60,101.50,101.52,100.85,100.90),bar(120,100.90,100.95,100.25,100.30)]});
  assert.equal(result.state,"FAIL");
  assert.ok(result.cumulativeAdverseBodyRate>0);
});
