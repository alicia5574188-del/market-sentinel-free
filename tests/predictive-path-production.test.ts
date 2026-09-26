import test from "node:test";
import assert from "node:assert/strict";
import {buildPredictiveFeatures} from "../lib/predictive-path-features.ts";
import {forecastPredictivePath} from "../lib/predictive-path-model.ts";
import type {PredictivePathArtifact} from "../lib/predictive-path-types.ts";

function bars(){
  const out=[];let p=100;
  for(let i=0;i<80;i++){const open=p,close=open*(1+(i%7===0?-.001:.0005)),high=Math.max(open,close)*1.001,low=Math.min(open,close)*.999,volume=1000+i*10;
    out.push({time:1_790_000_000+i*300,open,high,low,close,volume});p=close;}
  return out;
}
test("production feature vector is stable and finite",()=>{
  const feature=buildPredictiveFeatures({symbol:"SOL_USDT",decisionAt:1_790_000_000_000,bars5m:bars(),
    quote:{bestBid:101,bestAsk:101.01,observedAt:1_790_000_000_000,fresh:true,sourceCount:3,disagreementRate:.0005,sourceBreadth:.5,directionalAgreement:.8,medianShortMove:.001},
    ancillary:{fundingRate:.0001,openInterestChangeRate:.02,liquidationImbalance:.2,btcReturn15m:.001,btcReturn60m:.004,marketBreadth:.3}});
  assert.ok(feature);assert.ok(feature!.names.length>40);assert.equal(feature!.names.length,feature!.values.length);
  assert.ok(feature!.values.every(Number.isFinite));assert.ok(feature!.groups.multisource?.length);
});
test("inference returns WAIT rather than inventing a trade when the model has no edge",()=>{
  const feature=buildPredictiveFeatures({symbol:"SOL_USDT",decisionAt:1_790_000_000_000,bars5m:bars(),
    quote:{bestBid:101,bestAsk:101.01,observedAt:1_790_000_000_000,fresh:true,sourceCount:3,disagreementRate:.0005,sourceBreadth:0,directionalAgreement:.7,medianShortMove:0}})!;
  const zero={bias:0,weights:Array(feature.names.length).fill(0)},artifact:PredictivePathArtifact={
    version:"predictive-path-v1",trainedAt:1,source:"fixture",featureNames:feature.names,mean:Array(feature.names.length).fill(0),scale:Array(feature.names.length).fill(1),
    costRate:.0019,horizons:[15,30,60,120],direction:{"15":{...zero},"30":{...zero},"60":{...zero},"120":{...zero}},
    expectedReturn:{"15":{...zero},"30":{...zero},"60":{...zero},"120":{...zero}},longMfe60:{...zero},longMae60:{...zero},shortMfe60:{...zero},shortMae60:{...zero},
    longTargetBeforeRisk60:{...zero},shortTargetBeforeRisk60:{...zero},longEntryRegret10:{...zero},shortEntryRegret10:{...zero},metrics:{}};
  const forecast=forecastPredictivePath(feature,artifact);assert.equal(forecast.preferredSide,null);assert.equal(forecast.enterNow,false);assert.ok(forecast.waitReason);
});
