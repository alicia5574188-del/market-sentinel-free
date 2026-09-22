import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMultiTurnHoldValue, multiTurnHoldWindows } from "../lib/multi-turn-hold-value.ts";
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

test("obvious early invalidation is allowed before the old minimum-hold gate",()=>{
  const weak=frame({directionConfidence:.2,continuationScore:.2,triggerProbability:.9,phase:"TURNING",
    expectedMoveRate:.01,rawDirection:"SHORT"});
  const d=evaluateMultiTurnHoldValue({timeframe:"1h",frame:weak,side:"LONG",
    openedAt:NOW-60*60_000,now:NOW,returnRate:-.009,favorableRate:.001,modeledCostRate:.0022,
    entryExpectedMoveRate:.03,plannedRiskRate:.022});
  assert.equal(d.action,"EXIT_RISK");
  assert.match(d.reason,/提前失效/);
});

test("KMNO-like 4h position with poor progress can free its slot before the 24h best-hold time",()=>{
  const weak=frame({timeframe:"4h",directionConfidence:.28,continuationScore:.15,triggerProbability:.34,
    phase:"FLOW",rawDirection:"LONG",atrRate:.054,expectedMoveRate:.162,stopRate:.08});
  const d=evaluateMultiTurnHoldValue({timeframe:"4h",frame:weak,side:"LONG",
    openedAt:NOW-14*60*60_000,now:NOW,returnRate:-.047,favorableRate:.016,modeledCostRate:.0022,
    entryExpectedMoveRate:.146,plannedRiskRate:.083});
  assert.equal(d.bestHoldMinutes,1440);
  assert.ok(d.ageRatio<1);
  assert.ok(d.progressEfficiency<.5);
  assert.equal(d.action,"EXIT_RISK");
  assert.match(d.reason,/进展明显落后/);
});

test("large-timeframe winner with strong continuation is never cut merely to free a slot",()=>{
  const strong=frame({timeframe:"4h",directionConfidence:.90,continuationScore:.82,triggerProbability:.10,
    phase:"FLOW",rawDirection:"LONG",atrRate:.03,expectedMoveRate:.12,stopRate:.08});
  const d=evaluateMultiTurnHoldValue({timeframe:"4h",frame:strong,side:"LONG",
    openedAt:NOW-14*60*60_000,now:NOW,returnRate:.065,favorableRate:.07,modeledCostRate:.0022,
    entryExpectedMoveRate:.10,plannedRiskRate:.083});
  assert.equal(d.action,"HOLD");
  assert.equal(d.strongContinuation,true);
});
