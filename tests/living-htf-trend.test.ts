/** research-htf-v1: daily trend breakout helpers (pure; not wired into the engine). */
import test from "node:test";
import assert from "node:assert/strict";
import {HTF,atrOf,priorHigh,trailLow,smaClose,bullRegime,htfSignal,htfOrder,htfExitLevel,htfPick,type DailyBar} from "../lib/living/htf-trend.ts";
const D=86_400;
function bars(closes:number[],spread=.02,t0=1_700_000_000):DailyBar[]{
  return closes.map((c,i)=>({time:t0+i*D,open:i?closes[i-1]!:c,high:c*(1+spread/2),low:c*(1-spread/2),close:c}));
}
test("ATR, prior high, trail low and SMA use only closed bars",()=>{
  const r=bars([100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121]);
  assert.ok(Math.abs(atrOf(r,20)!-r.slice(-20).reduce((s,x,i,a)=>s+Math.max(x.high-x.low,Math.abs(x.high-r[r.length-21+i]!.close),Math.abs(x.low-r[r.length-21+i]!.close)),0)/20)<1e-9);
  assert.equal(priorHigh(r,20),Math.max(...r.slice(-21,-1).map(x=>x.high)));
  assert.equal(trailLow(r,10),Math.min(...r.slice(-10).map(x=>x.low)));
  assert.equal(smaClose(r,5),(117+118+119+120+121)/5);
  assert.equal(atrOf(r.slice(0,10),20),null);
});
test("BTC regime needs 200 closed days and compares the last close with the 200-day SMA",()=>{
  assert.equal(bullRegime(bars(Array(150).fill(100))).ok,null);
  assert.equal(bullRegime(bars([...Array(199).fill(100),120])).ok,true);
  assert.equal(bullRegime(bars([...Array(199).fill(100),90])).ok,false);
});
test("signal: close above the prior 20-day high and a top-25 liquidity rank",()=>{
  const flat=bars([...Array(30).fill(100),110]);
  assert.equal(htfSignal("A_USDT",flat,3).ok,true);
  assert.equal(htfSignal("A_USDT",flat,30).ok,false);
  assert.equal(htfSignal("A_USDT",bars([...Array(30).fill(100),100.5]),3).ok,false);
});
test("order: stop 2 ATR below entry, size = 1% risk, notional capped at 1x equity",()=>{
  const o=htfOrder(100,5,1000)!;assert.equal(o.stop,90);assert.ok(Math.abs(o.notional-100)<1e-9);assert.ok(Math.abs(o.riskUsd-10)<1e-9);
  assert.equal(htfOrder(100,.1,1000)!.notional,1000*HTF.notionalCap);
});
test("exit level: initial stop until a closed day after entry, then max(stop, 10-day low), never lower",()=>{
  const r=bars([...Array(15).fill(100),110,115,120]),entryT=r[15]!.time;
  assert.equal(htfExitLevel(80,r.slice(0,15),entryT),80);
  const l=htfExitLevel(80,r,entryT);assert.equal(l,Math.min(...r.slice(-10).map(x=>x.low)));
  assert.equal(htfExitLevel(80,r,entryT,l+5),l+5);
});
test("pick: free slots only, most liquid first, skip held coins",()=>{
  const s=(sym:string)=>({sym,ok:true,why:"",breakout:1,atr:1,close:1});
  const got=htfPick([s("C"),s("A"),s("B"),s("D")],x=>({A:1,B:2,C:3,D:4} as Record<string,number>)[x]!,new Set(["B"]),HTF.maxOpen-2);
  assert.deepEqual(got.map(x=>x.sym),["A","C"]);
});
