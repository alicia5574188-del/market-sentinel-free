import test from "node:test";
import assert from "node:assert/strict";
import {evaluateMultiTurnExitOverlay,MULTI_TURN_EXIT_OVERLAY_VERSION} from "../lib/multi-turn-exit.ts";
import type {TurnFrameState} from "../lib/multi-turn-engine.ts";

const NOW=Date.parse("2026-09-22T12:00:00Z");
const frame=(overrides:Partial<TurnFrameState>={}):TurnFrameState=>({
  version:"multi-turn-v1",symbol:"BTC_USDT",timeframe:"4h",observedAt:NOW,completedAt:NOW,
  ready:true,direction:"LONG",rawDirection:"LONG",directionConfidence:.80,turnProbability:.15,
  triggerProbability:.15,continuationScore:.70,phase:"FLOW",candidateSide:"NEUTRAL",candidateBars:0,
  justTurned:false,lastTurnAt:null,signalAgeBars:1,atrRate:.02,expectedMoveRate:.08,stopRate:.08,
  price:100,breadthLong:.6,propagationPressure:.05,
  evidence:{structure:.1,momentum:.1,acceleration:.1,cusum:.1,changePoint:.1,failedExtension:.05,
    volatility:.2,volume:.2,breadth:.1,propagation:.05},reason:"fixture",...overrides,
});

test("overlay contains the additive exit logic without a persistence or LIVE state version",()=>{
  const r=evaluateMultiTurnExitOverlay({timeframe:"4h",side:"LONG",openedAt:NOW-60_000,now:NOW,
    returnRate:.01,favorableRate:.03,riskRate:.08,modeledCostRate:.0022,entryExpectedMoveRate:.08,frame:frame()});
  assert.equal(r.version,MULTI_TURN_EXIT_OVERLAY_VERSION);
  assert.equal(r.profitProtection?.version,"multi-turn-profit-floor-v3");
  assert.equal(r.decision,null);
});

test("a deployed v4 floor remains readable and monotonic while new computation stays v3",()=>{
  const prior={version:"multi-turn-profit-floor-v4" as const,reachedR:.8,lockedR:.5,floorRate:.04,retentionRate:.5,
    activationRate:.02,checkpointBand:2,mode:"NORMAL" as const,peakR:.8,updatedAt:NOW-1000};
  const r=evaluateMultiTurnExitOverlay({timeframe:"4h",side:"LONG",openedAt:NOW-60_000,now:NOW,
    returnRate:.06,favorableRate:.08,riskRate:.08,modeledCostRate:.0022,entryExpectedMoveRate:.08,frame:null,priorProtection:prior});
  assert.ok((r.profitProtection?.floorRate??0)>=prior.floorRate);
  assert.equal(r.profitProtection?.version,"multi-turn-profit-floor-v3");
});

test("four-hour no-progress holding releases on the faster management clock even without a frame",()=>{
  const r=evaluateMultiTurnExitOverlay({timeframe:"4h",side:"LONG",openedAt:NOW-25*60*60_000,now:NOW,
    returnRate:-.006,favorableRate:.003,riskRate:.08,modeledCostRate:.0022,entryExpectedMoveRate:.08,frame:null});
  assert.equal(r.bestHoldMinutes,360);
  assert.equal(r.decision?.trigger,"HOLD_VALUE");
  assert.match(r.decision?.reason??"",/释放长期无进展仓位/);
});

test("meaningful favorable progress preserves the baseline hold-value decision",()=>{
  const r=evaluateMultiTurnExitOverlay({timeframe:"4h",side:"LONG",openedAt:NOW-25*60*60_000,now:NOW,
    returnRate:.01,favorableRate:.04,riskRate:.08,modeledCostRate:.0022,entryExpectedMoveRate:.08,frame:null});
  assert.equal(r.decision,null);
});

test("hard time ceiling is frame-independent",()=>{
  const r=evaluateMultiTurnExitOverlay({timeframe:"1h",side:"LONG",openedAt:NOW-19*60*60_000,now:NOW,
    returnRate:.001,favorableRate:.01,riskRate:.05,modeledCostRate:.0022,entryExpectedMoveRate:.03,frame:null});
  assert.equal(r.hardExtensionMinutes,720);
  assert.equal(r.decision?.trigger,"HOLD_VALUE");
  assert.match(r.decision?.reason??"",/硬上限/);
});
