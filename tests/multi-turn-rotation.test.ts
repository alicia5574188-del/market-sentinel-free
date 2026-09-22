import test from "node:test";
import assert from "node:assert/strict";
import { type TurnCandidate, type TurnFrameState } from "../lib/multi-turn-engine.ts";
import { type MultiTurnHoldValue } from "../lib/multi-turn-hold-value.ts";
import { MULTI_TURN_ROTATION_COOLDOWN_MS, evaluateRotationOpportunity, multiTurnRotationReentryCooldownMs,
  rankWeakRotationHoldings, rotationAdvantageEnough, rotationRiskSaturated } from "../lib/multi-turn-rotation.ts";

const NOW=Date.parse("2026-09-22T00:00:00Z");
const frame=(overrides:Partial<TurnFrameState>={}):TurnFrameState=>({
  version:"multi-turn-v1",symbol:"NEW_USDT",timeframe:"1h",observedAt:NOW,completedAt:NOW,
  ready:true,direction:"LONG",rawDirection:"LONG",directionConfidence:.88,turnProbability:.10,
  triggerProbability:.12,continuationScore:.78,phase:"FLOW",candidateSide:"NEUTRAL",candidateBars:0,
  justTurned:false,lastTurnAt:null,signalAgeBars:1,atrRate:.006,expectedMoveRate:.032,stopRate:.012,
  price:100,breadthLong:.62,propagationPressure:.08,
  evidence:{structure:.08,momentum:.10,acceleration:.08,cusum:.08,changePoint:.08,failedExtension:.05,
    volatility:.25,volume:.25,breadth:.08,propagation:.08},reason:"test",...overrides,
});
const candidate=(overrides:Partial<TurnCandidate>={}):TurnCandidate=>({
  symbol:"NEW_USDT",timeframe:"1h",side:"LONG",score:3,riskCap:.02,stopRate:.012,
  expectedMoveRate:.032,turnProbability:.10,confidence:.88,continuationScore:.78,
  completedAt:NOW,signalPrice:100,reason:"strong candidate",...overrides,
});
const hold=(overrides:Partial<MultiTurnHoldValue>={}):MultiTurnHoldValue=>({
  version:"multi-turn-time-space-v2",action:"HOLD",evaluatedAt:NOW,bestHoldMinutes:360,strongExtensionMinutes:720,
  hardExtensionMinutes:1080,heldMinutes:150,ageRatio:.42,directionStrength:.42,turnRisk:.58,
  remainingSpaceRate:.004,pullbackRiskRate:.012,edgeRatio:.33,requiredEdgeRatio:.70,
  entryExpectedMoveRate:.03,expectedProgressRate:.012,progressEfficiency:.40,currentReturnRate:0,
  strongContinuation:false,exceptionalContinuation:false,reason:"weak hold",...overrides,
});

test("rotation is considered only when an existing risk cap is genuinely near full",()=>{
  assert.equal(rotationRiskSaturated({equity:1000,totalRisk:94,sideRisk:20,sleeveRisk:5,riskCap:.02}),false);
  assert.equal(rotationRiskSaturated({equity:1000,totalRisk:95,sideRisk:20,sleeveRisk:5,riskCap:.02}),true);
  assert.equal(rotationRiskSaturated({equity:1000,totalRisk:40,sideRisk:61.75,sleeveRisk:5,riskCap:.02}),true);
  assert.equal(rotationRiskSaturated({equity:1000,totalRisk:40,sideRisk:20,sleeveRisk:19,riskCap:.02}),true);
});

test("only a distinctly strong candidate qualifies for full-risk replacement",()=>{
  const strong=evaluateRotationOpportunity({candidate:candidate(),frame:frame(),remainingSpaceRate:.026,costRate:.0022});
  assert.equal(strong.eligible,true);
  assert.ok(strong.edgeRatio>=1.45);
  const ordinary=evaluateRotationOpportunity({
    candidate:candidate({confidence:.61,continuationScore:.48,expectedMoveRate:.016}),
    frame:frame({directionConfidence:.61,continuationScore:.48,triggerProbability:.35,expectedMoveRate:.016}),
    remainingSpaceRate:.012,costRate:.0022});
  assert.equal(ordinary.eligible,false);
});

test("only mature weak holdings are eligible to be sacrificed; strong holdings are protected",()=>{
  const rows=rankWeakRotationHoldings({now:NOW,holdings:[
    {id:"weak",symbol:"WEAK_USDT",side:"LONG",timeframe:"1h",openedAt:NOW-150*60_000,holdValue:hold()},
    {id:"strong",symbol:"STRONG_USDT",side:"LONG",timeframe:"1h",openedAt:NOW-400*60_000,
      holdValue:hold({edgeRatio:1.8,directionStrength:.84,turnRisk:.12,strongContinuation:true,exceptionalContinuation:true})},
    {id:"young",symbol:"YOUNG_USDT",side:"LONG",timeframe:"1h",openedAt:NOW-40*60_000,holdValue:hold({heldMinutes:40})},
  ]});
  assert.deepEqual(rows.map(row=>row.holding.id),["weak"]);
});

test("replacement needs a large score and space advantage, not a marginal ranking win",()=>{
  const weak=rankWeakRotationHoldings({now:NOW,holdings:[
    {id:"weak",symbol:"WEAK_USDT",side:"LONG",timeframe:"1h",openedAt:NOW-150*60_000,holdValue:hold()},
  ]})[0];
  const strong=evaluateRotationOpportunity({candidate:candidate(),frame:frame(),remainingSpaceRate:.026,costRate:.0022});
  assert.equal(rotationAdvantageEnough(strong,weak),true);
  const marginal={...strong,score:weak.score+.2,edgeRatio:weak.holding.holdValue.edgeRatio+.2};
  assert.equal(rotationAdvantageEnough(marginal,weak),false);
});

test("rotation churn controls are deliberately slow",()=>{
  assert.equal(MULTI_TURN_ROTATION_COOLDOWN_MS,60*60_000);
  assert.equal(multiTurnRotationReentryCooldownMs("5m"),60*60_000);
  assert.equal(multiTurnRotationReentryCooldownMs("1h"),2*60*60_000);
  assert.equal(multiTurnRotationReentryCooldownMs("4h"),8*60*60_000);
  assert.equal(multiTurnRotationReentryCooldownMs("1d"),8*60*60_000);
});
