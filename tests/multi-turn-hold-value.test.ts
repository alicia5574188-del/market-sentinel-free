import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMultiTurnHoldValue, evaluateMultiTurnTimeFallback, multiTurnHoldWindows } from "../lib/multi-turn-hold-value.ts";
import type { TurnFrameState } from "../lib/multi-turn-engine.ts";

const NOW=Date.parse("2026-09-22T00:00:00Z");
const frame=(overrides:Partial<TurnFrameState>={}):TurnFrameState=>({
  version:"multi-turn-v1",symbol:"BTC_USDT",timeframe:"1h",observedAt:NOW,completedAt:NOW,
  ready:true,direction:"LONG",rawDirection:"LONG",directionConfidence:.90,turnProbability:.10,
  triggerProbability:.10,continuationScore:.80,phase:"FLOW",candidateSide:"NEUTRAL",candidateBars:0,
  justTurned:false,lastTurnAt:null,signalAgeBars:1,atrRate:.01,expectedMoveRate:.03,stopRate:.02,
  price:100,breadthLong:.6,propagationPressure:.05,
  evidence:{structure:.10,momentum:.10,acceleration:.10,cusum:.10,changePoint:.10,failedExtension:.05,
    volatility:.2,volume:.2,breadth:.1,propagation:.05},
  reason:"test",...overrides,
});

test("six-bar best holding windows are explicit for every owning timeframe",()=>{
  assert.equal(multiTurnHoldWindows("5m").bestHoldMinutes,30);
  assert.equal(multiTurnHoldWindows("15m").bestHoldMinutes,90);
  assert.equal(multiTurnHoldWindows("30m").bestHoldMinutes,180);
  assert.equal(multiTurnHoldWindows("1h").bestHoldMinutes,360);
  assert.equal(multiTurnHoldWindows("4h").bestHoldMinutes,1440);
  assert.equal(multiTurnHoldWindows("1d").bestHoldMinutes,8640);
});

test("a strong owning direction may exceed its best holding time",()=>{
  const d=evaluateMultiTurnHoldValue({timeframe:"1h",frame:frame(),side:"LONG",
    openedAt:NOW-7*60*60_000,now:NOW,returnRate:.02,favorableRate:.025,modeledCostRate:.0022});
  assert.equal(d.bestHoldMinutes,360);
  assert.equal(d.action,"HOLD");
  assert.equal(d.strongContinuation,true);
});

test("a non-exceptional direction cannot drift past the strong-extension window",()=>{
  const d=evaluateMultiTurnHoldValue({timeframe:"1h",frame:frame({directionConfidence:.72,continuationScore:.57,
      triggerProbability:.30,phase:"WATCH"}),side:"LONG",
    openedAt:NOW-13*60*60_000,now:NOW,returnRate:.015,favorableRate:.02,modeledCostRate:.0022});
  assert.notEqual(d.action,"HOLD");
  assert.equal(d.strongExtensionMinutes,720);
});

test("exceptional continuation can extend beyond two best windows but never past the hard extension",()=>{
  const strong=frame({directionConfidence:.94,continuationScore:.86,triggerProbability:.08,phase:"FLOW"});
  const extended=evaluateMultiTurnHoldValue({timeframe:"1h",frame:strong,side:"LONG",
    openedAt:NOW-13*60*60_000,now:NOW,returnRate:.03,favorableRate:.035,modeledCostRate:.0022});
  assert.equal(extended.exceptionalContinuation,true);
  assert.equal(extended.action,"HOLD");

  const hard=evaluateMultiTurnHoldValue({timeframe:"1h",frame:strong,side:"LONG",
    openedAt:NOW-18*60*60_000,now:NOW,returnRate:.03,favorableRate:.035,modeledCostRate:.0022});
  assert.notEqual(hard.action,"HOLD");
  assert.equal(hard.hardExtensionMinutes,1080);
});

test("weak direction exits when pullback risk overwhelms remaining space after enough observation",()=>{
  const weak=frame({directionConfidence:.38,continuationScore:.28,triggerProbability:.68,phase:"TURNING",
    atrRate:.012,expectedMoveRate:.014,propagationPressure:.55,
    evidence:{structure:.70,momentum:.55,acceleration:.45,cusum:.60,changePoint:.58,failedExtension:.40,
      volatility:.4,volume:.3,breadth:.5,propagation:.55}});
  const d=evaluateMultiTurnHoldValue({timeframe:"1h",frame:weak,side:"LONG",
    openedAt:NOW-4*60*60_000,now:NOW,returnRate:.012,favorableRate:.026,modeledCostRate:.0022});
  assert.equal(d.action,"EXIT_PROFIT");
  assert.ok(d.pullbackRiskRate>d.remainingSpaceRate);
});

test("the hold-value layer never acts before the owning timeframe has enough observation",()=>{
  const weak=frame({directionConfidence:.2,continuationScore:.2,triggerProbability:.9,phase:"TURNING",
    expectedMoveRate:.01});
  const d=evaluateMultiTurnHoldValue({timeframe:"1h",frame:weak,side:"LONG",
    openedAt:NOW-60*60_000,now:NOW,returnRate:-.005,favorableRate:.001,modeledCostRate:.0022});
  assert.equal(d.action,"HOLD");
});

test("frame-independent fallback waits for the stable six-bar best-hold window",()=>{
  const input={timeframe:"4h" as const,openedAt:NOW-10*60*60_000,now:NOW,
    returnRate:-.01,favorableRate:.002,modeledCostRate:.0022,entryExpectedMoveRate:.08};
  assert.equal(evaluateMultiTurnTimeFallback(input),null);
});

test("a four-hour no-progress holding releases its slot even when the owning frame is unavailable",()=>{
  const input={timeframe:"4h" as const,openedAt:NOW-25*60*60_000,now:NOW,
    returnRate:-.006,favorableRate:.006,modeledCostRate:.0022,entryExpectedMoveRate:.08};
  const d=evaluateMultiTurnTimeFallback(input);
  assert.equal(d?.action,"EXIT_RISK");
  assert.match(d?.reason??"",/释放长期无进展仓位/);
});

test("meaningful progress or a cost-positive current return is not treated as a stalled slot",()=>{
  const input={timeframe:"4h" as const,openedAt:NOW-25*60*60_000,now:NOW,
    returnRate:-.004,favorableRate:.006,modeledCostRate:.0022,entryExpectedMoveRate:.08};
  assert.ok(evaluateMultiTurnTimeFallback(input));
  assert.equal(evaluateMultiTurnTimeFallback({...input,favorableRate:.04}),null);
  assert.equal(evaluateMultiTurnTimeFallback({...input,returnRate:.003}),null);
});

test("hard-extension safety ceiling does not depend on a fresh timeframe frame",()=>{
  const d=evaluateMultiTurnTimeFallback({timeframe:"1h",openedAt:NOW-19*60*60_000,now:NOW,
    returnRate:.01,favorableRate:.02,modeledCostRate:.0022,entryExpectedMoveRate:.03});
  assert.equal(d?.action,"EXIT_PROFIT");
  assert.match(d?.reason??"",/硬上限/);
});
