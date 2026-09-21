import test from "node:test";
import assert from "node:assert/strict";
import { predictMultiTurnExit, RBE_EXIT_CONFIGS } from "../lib/turn-exit-predictor.ts";
import type { TurnFrameState, TurnTimeframe } from "../lib/multi-turn-engine.ts";

const frame=(timeframe:TurnTimeframe,patch:Partial<TurnFrameState>={}):TurnFrameState=>({
  version:"multi-turn-v1",symbol:"BTC_USDT",timeframe,observedAt:1,completedAt:1,ready:true,
  direction:"LONG",rawDirection:"LONG",directionConfidence:.75,turnProbability:.12,triggerProbability:.12,
  continuationScore:.60,phase:"FLOW",candidateSide:"NEUTRAL",candidateBars:0,justTurned:false,lastTurnAt:null,
  signalAgeBars:1,atrRate:.01,expectedMoveRate:.025,stopRate:.03,price:110,breadthLong:.70,propagationPressure:0,
  evidence:{structure:.08,momentum:.05,acceleration:.08,cusum:.10,changePoint:.10,failedExtension:0,
    volatility:.15,volume:.20,breadth:.05,propagation:.05},reason:"test",...patch,
});

test("one noisy lower timeframe does not cut a healthy higher-timeframe runner",()=>{
  const decision=predictMultiTurnExit({side:"LONG",timeframe:"1h",entryPrice:100,stopPrice:96,currentPrice:112,favorable:.13,
    frames:{
      "5m":frame("5m",{direction:"SHORT",rawDirection:"SHORT",continuationScore:.42,triggerProbability:.35}),
      "15m":frame("15m",{continuationScore:.50}),
      "30m":frame("30m",{continuationScore:.50}),
      "1h":frame("1h",{continuationScore:.62}),
      "4h":frame("4h",{continuationScore:.68}),
      "1d":frame("1d",{continuationScore:.72}),
    }},RBE_EXIT_CONFIGS.balanced);
  assert.ok(decision);
  assert.equal(decision.shouldExit,false);
  assert.notEqual(decision.phase,"PRE_TURN_EXIT");
  assert.ok(decision.extensionSurvival>.45);
});

test("multi-timeframe propagation plus own decay can exit before formal own-timeframe reversal",()=>{
  const stressed=(tf:TurnTimeframe)=>frame(tf,{direction:"SHORT",rawDirection:"SHORT",continuationScore:.12,
    triggerProbability:.72,phase:"TURNING",candidateSide:"LONG",
    evidence:{structure:.68,momentum:.65,acceleration:.78,cusum:.70,changePoint:.76,failedExtension:.55,
      volatility:.55,volume:.45,breadth:.72,propagation:.78}});
  const own=frame("1h",{direction:"LONG",rawDirection:"SHORT",continuationScore:.08,triggerProbability:.72,
    turnProbability:.72,phase:"TURNING",candidateSide:"SHORT",
    evidence:{structure:.70,momentum:.66,acceleration:.75,cusum:.72,changePoint:.74,failedExtension:.62,
      volatility:.50,volume:.40,breadth:.68,propagation:.75}});
  const decision=predictMultiTurnExit({side:"LONG",timeframe:"1h",entryPrice:100,stopPrice:96,currentPrice:105,favorable:.11,
    frames:{"5m":stressed("5m"),"15m":stressed("15m"),"30m":stressed("30m"),"1h":own,
      "4h":frame("4h",{direction:"NEUTRAL",rawDirection:"SHORT",continuationScore:0,triggerProbability:.45}),
      "1d":frame("1d",{continuationScore:.22})}},RBE_EXIT_CONFIGS.balanced);
  assert.ok(decision);
  assert.equal(own.direction,"LONG");
  assert.equal(decision.shouldExit,true);
  assert.equal(decision.phase,"PRE_TURN_EXIT");
  assert.ok(decision.evidenceFamilies>=3);
  assert.ok(decision.holdValueRate<0);
});

test("large profit alone never triggers an exit while continuation remains healthy",()=>{
  const decision=predictMultiTurnExit({side:"LONG",timeframe:"30m",entryPrice:100,stopPrice:95,currentPrice:145,favorable:.47,
    frames:{"5m":frame("5m",{continuationScore:.60}),"15m":frame("15m",{continuationScore:.62}),
      "30m":frame("30m",{continuationScore:.66}),"1h":frame("1h",{continuationScore:.68}),
      "4h":frame("4h",{continuationScore:.70}),"1d":frame("1d",{continuationScore:.75})}},RBE_EXIT_CONFIGS.responsive);
  assert.ok(decision);
  assert.equal(decision.shouldExit,false);
  assert.equal(decision.phase,"HEALTHY");
});
