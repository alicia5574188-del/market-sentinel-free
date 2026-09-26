import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {buildPredictiveLabels} from "../research/predictive-path-engine/labels.ts";
import {assertCausalFeatureRow,joinFeatureAndLabels} from "../research/predictive-path-engine/dataset.ts";
import {assertNoLabelOverlap,buildPurgedWalkForward} from "../research/predictive-path-engine/walk-forward.ts";
import {brierScore,calibrationBins,meanAbsoluteError,pinballLoss} from "../research/predictive-path-engine/metrics.ts";
import type {FeatureRow,GatePathBar} from "../research/predictive-path-engine/types.ts";

const MIN=60_000,DAY=86_400_000,T0=Date.parse("2026-01-01T00:00:00Z");
function bars(count:number,step:(i:number,open:number)=>{close:number;high?:number;low?:number}):GatePathBar[]{
  const out:GatePathBar[]=[];let open=100;
  for(let i=0;i<count;i++){
    const x=step(i,open),close=x.close,high=x.high??Math.max(open,close),low=x.low??Math.min(open,close);
    out.push({symbol:"SOL_USDT",openTime:T0+i*MIN,closeTime:T0+(i+1)*MIN,open,high,low,close,volume:100+i});
    open=close;
  }
  return out;
}

test("feature evidence must have been observable by decision time",()=>{
  const good:FeatureRow={symbol:"SOL_USDT",decisionAt:T0,features:{oi_velocity:.2},evidence:[
    {key:"oi_velocity",value:.2,source:"BYBIT",eventAt:T0-2000,observedAt:T0-1000},
  ]};
  assert.doesNotThrow(()=>assertCausalFeatureRow(good));
  assert.throws(()=>assertCausalFeatureRow({...good,evidence:[{...good.evidence[0]!,observedAt:T0+1}]}),/lookahead feature rejected/);
  assert.throws(()=>assertCausalFeatureRow({...good,evidence:[{...good.evidence[0]!,eventAt:T0,observedAt:T0-1}]}),/observed before source event/);
});

test("future labels are symmetric for LONG and SHORT and ignore a partially-open decision bar",()=>{
  const preDecision:GatePathBar={symbol:"SOL_USDT",openTime:T0-MIN/2,closeTime:T0+MIN/2,open:100,high:150,low:50,close:100,volume:1};
  const future=bars(5,(i,open)=>({close:open+1,high:open+1.2,low:open-.2}));
  const labels=buildPredictiveLabels({symbol:"SOL_USDT",decisionAt:T0,entryPrice:100,futureGateBars:[preDecision,...future],
    horizonsMinutes:[5],firstTouchSpecs:[],entryRegretWaitMinutes:[5],reversalHazardSpecs:[],coverageToleranceMs:0});
  assert.equal(labels.horizons.length,1);
  const h=labels.horizons[0]!;
  assert.ok(h.longMfeRate>.05&&h.longMfeRate<.07);
  assert.equal(h.shortMaeRate,h.longMfeRate);
  assert.equal(h.shortMfeRate,h.longMaeRate);
  assert.ok(h.terminalPrice>100);
  assert.ok(labels.entryRegret[0]!.longBestPrice>99,"pre-decision low must not leak into entry-regret label");
});

test("same-bar target and risk touch is ambiguous rather than invented",()=>{
  const future=bars(1,()=>({close:100,high:101,low:99}));
  const labels=buildPredictiveLabels({symbol:"SOL_USDT",decisionAt:T0,entryPrice:100,futureGateBars:future,horizonsMinutes:[1],
    firstTouchSpecs:[{id:"x",rewardRate:.005,riskRate:.005,maxMinutes:1}],entryRegretWaitMinutes:[],reversalHazardSpecs:[],coverageToleranceMs:0});
  assert.equal(labels.firstTouch.find(x=>x.side==="LONG")?.outcome,"AMBIGUOUS");
  assert.equal(labels.firstTouch.find(x=>x.side==="SHORT")?.outcome,"AMBIGUOUS");
});

test("incomplete future coverage is censored, never mislabeled as NONE",()=>{
  const future=bars(2,(_,open)=>({close:open+0.01}));
  const labels=buildPredictiveLabels({symbol:"SOL_USDT",decisionAt:T0,entryPrice:100,futureGateBars:future,horizonsMinutes:[5],
    firstTouchSpecs:[{id:"x",rewardRate:.02,riskRate:.02,maxMinutes:5}],entryRegretWaitMinutes:[],
    reversalHazardSpecs:[{id:"r",activationRate:.01,reversalRate:.005,maxMinutes:5}],coverageToleranceMs:0});
  assert.equal(labels.horizons.length,0);
  assert.ok(labels.firstTouch.every(x=>x.outcome==="CENSORED"));
  assert.ok(labels.reversalHazard.every(x=>x.outcome==="CENSORED"));
});

test("entry-regret labels measure a better future price without deciding direction",()=>{
  const future=bars(3,(i,open)=>i===0?{close:99.5,high:100.2,low:99}:{close:100+i,high:100.5+i,low:Math.min(open,99.4+i*.2)});
  const labels=buildPredictiveLabels({symbol:"SOL_USDT",decisionAt:T0,entryPrice:100,futureGateBars:future,horizonsMinutes:[3],
    firstTouchSpecs:[],entryRegretWaitMinutes:[3],reversalHazardSpecs:[],coverageToleranceMs:0});
  assert.equal(labels.entryRegret[0]!.longImprovementRate,.01);
  assert.ok(labels.entryRegret[0]!.shortImprovementRate>.02);
});

test("reversal-hazard label requires a favorable activation before a reversal",()=>{
  const future=bars(4,(i)=>i===0?{close:101,high:101.2,low:99.9}
    :i===1?{close:101.5,high:102,low:100.8}
    :i===2?{close:100.8,high:101.6,low:100.2}
    :{close:100.5,high:101,low:100.1});
  const labels=buildPredictiveLabels({symbol:"SOL_USDT",decisionAt:T0,entryPrice:100,futureGateBars:future,horizonsMinutes:[4],
    firstTouchSpecs:[],entryRegretWaitMinutes:[],reversalHazardSpecs:[{id:"r",activationRate:.01,reversalRate:.01,maxMinutes:4}],coverageToleranceMs:0});
  const long=labels.reversalHazard.find(x=>x.side==="LONG")!;
  assert.equal(long.outcome,"REVERSED");assert.ok(long.activatedAt);assert.ok(long.reversedAt);
  const short=labels.reversalHazard.find(x=>x.side==="SHORT")!;
  assert.equal(short.outcome,"NOT_ACTIVATED");
});

test("feature and label identities must join exactly",()=>{
  const future=bars(2,(_,open)=>({close:open+1}));
  const labels=buildPredictiveLabels({symbol:"SOL_USDT",decisionAt:T0,entryPrice:100,futureGateBars:future,horizonsMinutes:[2],
    firstTouchSpecs:[],entryRegretWaitMinutes:[],reversalHazardSpecs:[],coverageToleranceMs:0});
  const feature:FeatureRow={symbol:"SOL_USDT",decisionAt:T0,features:{x:1},evidence:[{key:"x",value:1,source:"OKX",eventAt:T0-2,observedAt:T0-1}]};
  assert.doesNotThrow(()=>joinFeatureAndLabels(feature,labels));
  assert.throws(()=>joinFeatureAndLabels({...feature,symbol:"BTC_USDT"},labels),/identity mismatch/);
});

test("purged walk-forward never lets a label window overlap the next partition",()=>{
  const samples=[] as {decisionAt:number;maxLabelEndAt:number;id:number}[];
  for(let hour=0;hour<12*24;hour++)samples.push({id:hour,decisionAt:T0+hour*60*MIN,maxLabelEndAt:T0+hour*60*MIN+120*MIN});
  const folds=buildPurgedWalkForward(samples,{trainDays:3,validationDays:1,testDays:1,stepDays:1,embargoMinutes:120,mode:"ROLLING"});
  assert.ok(folds.length>=3);
  for(const fold of folds){
    assert.doesNotThrow(()=>assertNoLabelOverlap(fold));
    assert.ok(fold.train.every(x=>x.maxLabelEndAt<fold.validationStart));
    assert.ok(fold.validation.every(x=>x.maxLabelEndAt<fold.testStart));
  }
});

test("offline scoring primitives expose calibration and distribution errors",()=>{
  assert.equal(brierScore([0,1],[0,1]),0);
  assert.equal(meanAbsoluteError([1,2],[2,2]),.5);
  assert.equal(pinballLoss([1],[2],.5),.5);
  const bins=calibrationBins([.1,.2,.8,.9],[0,0,1,1],2);
  assert.equal(bins[0]!.observedRate,0);assert.equal(bins[1]!.observedRate,1);
});

test("research framework is strategy-reset: no import of existing trading engines",async()=>{
  const names=["types.ts","labels.ts","dataset.ts","walk-forward.ts","metrics.ts","feature-catalog.ts"];
  const bodies=await Promise.all(names.map(n=>readFile(new URL(`../research/predictive-path-engine/${n}`,import.meta.url),"utf8")));
  for(const body of bodies){
    const imports=body.split("\n").filter(line=>/^import\s/.test(line)).join("\n");
    assert.doesNotMatch(imports,/forward-relations|extremum-regime|region-launch|structural-interrupt|forward-relation-v/i);
  }
});
