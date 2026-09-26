import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {buildPredictiveFeatures} from "../lib/predictive-path-features.ts";
import {forecastCausalPath} from "../lib/predictive-path-model.ts";
import {buildPredictivePathEngine,predictiveExitDecision} from "../lib/predictive-path-engine.ts";
import {PREDICTIVE_PATH_VERSION,type PredictiveBar,type PredictiveEngineState,type PredictiveQuote} from "../lib/predictive-path-types.ts";

const STEP=300,T0=1_790_000_000;
function trendBars(count:number,stepRate:number,start=100):PredictiveBar[]{
  const rows:PredictiveBar[]=[];let p=start;
  for(let i=0;i<count;i++){
    const open=p,wiggle=Math.sin(i*.71)*Math.abs(stepRate)*.18,close=open*(1+stepRate+wiggle),
      range=Math.max(Math.abs(close-open)*.45,open*.0007),high=Math.max(open,close)+range,low=Math.min(open,close)-range;
    rows.push({time:T0+i*STEP,open,high,low,close,volume:1_000+Math.abs(Math.sin(i*.31))*500});p=close;
  }
  return rows;
}
function quote(price:number,overrides:Partial<PredictiveQuote>={}):PredictiveQuote{
  return{bestBid:price*.99995,bestAsk:price*1.00005,observedAt:(T0+100*STEP)*1000,fresh:true,entryReady:true,
    sourceCount:4,disagreementRate:.0007,sourceBreadth:.8,directionalAgreement:.9,medianShortMove:.001,...overrides};
}
function ancillary(side:1|-1=1){
  return{fundingRate:side*.00008,basisRate:side*.0007,openInterestChangeRate:.045,
    liquidationImbalance:side*.35,liquidationLongNotionalRate:side<0?.01:.001,liquidationShortNotionalRate:side>0?.01:.001,
    takerLongShortLog:side*.30,accountLongShortLog:side*.15,topLongShortLog:side*.20,
    btcReturn15m:side*.004,btcReturn60m:side*.012,ethReturn15m:side*.005,ethReturn60m:side*.014,marketBreadth:side*.65};
}
function nowFor(rows:PredictiveBar[]){return (rows.at(-1)!.time+STEP)*1000;}

test("causal feature surface is finite and groups indicators instead of voting per indicator",()=>{
  const rows=trendBars(90,.0012),now=nowFor(rows),q=quote(rows.at(-1)!.close,{observedAt:now});
  const feature=buildPredictiveFeatures({symbol:"SOL_USDT",decisionAt:now,bars5m:rows,quote:q,ancillary:ancillary(1)});
  assert.ok(feature);assert.ok(feature!.names.length>=70);assert.equal(feature!.names.length,feature!.values.length);
  assert.ok(feature!.values.every(Number.isFinite));
  for(const key of ["price","technical","flow","state","derivatives","liquidation","multisource","context"])
    assert.ok((feature!.groups[key]?.length??0)>0,key);
});

test("strong persistent direction can become a stable LONG without any trained artifact",()=>{
  const rows=trendBars(90,.0015),now=nowFor(rows),q=quote(rows.at(-1)!.close,{observedAt:now});
  const built=buildPredictivePathEngine({paths:{SOL_USDT:rows},quotes:{SOL_USDT:q},ancillary:{SOL_USDT:ancillary(1)},now});
  const f=built.state.symbols.SOL_USDT;
  assert.equal(built.state.version,PREDICTIVE_PATH_VERSION);assert.ok(f);
  assert.equal(f.stableSide,"LONG");assert.ok(f.upProbability.m60>.5);assert.ok(f.upProbability.m120>.5);
  assert.ok(f.evidence.price>0);assert.ok(f.evidence.context>0);
});

test("overextended price can keep LONG direction while forcing WAIT for a better entry",()=>{
  const base=trendBars(86,.0009),last=base.at(-1)!;let p=last.close;
  for(let i=0;i<4;i++){const open=p,close=open*1.009,high=close*1.002,low=open*.9995;base.push({time:last.time+(i+1)*STEP,open,high,low,close,volume:5_000});p=close;}
  const now=nowFor(base),q=quote(base.at(-1)!.close,{observedAt:now}),prior:PredictiveEngineState={
    version:PREDICTIVE_PATH_VERSION,updatedAt:now-STEP*1000,symbols:{},directionMemory:{SOL_USDT:{side:"LONG",since:now-3_600_000,
      lastBarTime:(base.at(-2)!.time+STEP)*1000,oppositeBars:0,weakBars:0}}};
  const built=buildPredictivePathEngine({paths:{SOL_USDT:base},quotes:{SOL_USDT:q},ancillary:{SOL_USDT:ancillary(1)},previous:prior,now});
  const f=built.state.symbols.SOL_USDT;assert.equal(f.stableSide,"LONG");
  assert.equal(f.enterNow,false);assert.ok(f.long.entryRegret10>0);
  assert.match(f.waitReason??"",/入场|延伸|等待/);
});

test("one contrary 5m decision cannot flip an established direction; two can",()=>{
  const down=trendBars(90,-.0017),now1=nowFor(down),q1=quote(down.at(-1)!.close,{observedAt:now1,sourceBreadth:-.85,medianShortMove:-.0015}),
    prior:PredictiveEngineState={version:PREDICTIVE_PATH_VERSION,updatedAt:now1-STEP*1000,symbols:{},
      directionMemory:{SOL_USDT:{side:"LONG",since:now1-7_200_000,lastBarTime:(down.at(-2)!.time+STEP)*1000,oppositeBars:0,weakBars:0}}};
  const first=buildPredictivePathEngine({paths:{SOL_USDT:down},quotes:{SOL_USDT:q1},ancillary:{SOL_USDT:ancillary(-1)},previous:prior,now:now1});
  assert.equal(first.state.directionMemory.SOL_USDT.side,"LONG");assert.equal(first.state.directionMemory.SOL_USDT.oppositeBars,1);
  const nextOpen=down.at(-1)!.close,nextClose=nextOpen*.9975,next:PredictiveBar={time:down.at(-1)!.time+STEP,open:nextOpen,
    high:nextOpen*1.0004,low:nextClose*.9994,close:nextClose,volume:2_000},rows=[...down,next],now2=nowFor(rows),
    q2=quote(nextClose,{observedAt:now2,sourceBreadth:-.9,medianShortMove:-.0018});
  const second=buildPredictivePathEngine({paths:{SOL_USDT:rows},quotes:{SOL_USDT:q2},ancillary:{SOL_USDT:ancillary(-1)},previous:first.state,now:now2});
  assert.equal(second.state.directionMemory.SOL_USDT.side,"SHORT");
});

test("multi-venue disagreement and missing independent sources are hard entry blockers",()=>{
  const rows=trendBars(90,.0015),now=nowFor(rows);
  for(const overrides of [{sourceCount:4,disagreementRate:.03},{sourceCount:1,disagreementRate:.0003}]){
    const q=quote(rows.at(-1)!.close,{observedAt:now,...overrides});
    const feature=buildPredictiveFeatures({symbol:"SOL_USDT",decisionAt:now,bars5m:rows,quote:q,ancillary:ancillary(1)})!;
    const f=forecastCausalPath(feature,q);assert.equal(f.enterNow,false);
  }
});

test("sideways noisy market does not manufacture a directional candidate",()=>{
  const rows:PredictiveBar[]=[];let p=100;
  for(let i=0;i<90;i++){const open=p,close=100*(1+Math.sin(i*1.7)*.0012),high=Math.max(open,close)*1.001,low=Math.min(open,close)*.999;
    rows.push({time:T0+i*STEP,open,high,low,close,volume:1_000});p=close;}
  const now=nowFor(rows),q=quote(rows.at(-1)!.close,{observedAt:now,sourceBreadth:0,medianShortMove:0,directionalAgreement:.55});
  const built=buildPredictivePathEngine({paths:{SOL_USDT:rows},quotes:{SOL_USDT:q},ancillary:{SOL_USDT:{marketBreadth:0}},now});
  assert.equal(built.candidates.filter(x=>x.eligible).length,0);
});

test("profit giveback alone cannot close a predictive position while direction remains alive",()=>{
  const forecast:any={version:PREDICTIVE_PATH_VERSION,symbol:"SOL_USDT",at:1,lastBarTime:1,
    upProbability:{m15:.55,m30:.62,m60:.68,m120:.70},expectedReturn:{m15:.002,m30:.005,m60:.012,m120:.018},
    long:{mfe60:.025,mae60:.006,targetBeforeRisk60:.66,entryRegret10:.001,netEv60:.009},
    short:{mfe60:.006,mae60:.025,targetBeforeRisk60:.28,entryRegret10:.004,netEv60:-.01},
    crossVenue:{sourceCount:4,agreement:.8,breadth:.7,disagreementRate:.001},evidence:{price:.7,technical:.6,derivatives:.4,liquidation:.2,multiVenue:.6,context:.5,persistence:.8,uncertainty:.8},
    rawSide:"LONG",stableSide:"LONG",directionProbability:.68,entryQuality:.8,enterNow:true,waitReason:null,confidence:.75};
  const decision=predictiveExitDecision({side:"LONG",forecast,memory:{side:"LONG",since:1,lastBarTime:1,oppositeBars:0,weakBars:0},stopped:false,ageMinutes:90});
  assert.equal(decision.reason,null);assert.equal(decision.hold,true);
});

test("predictive exit requires catastrophic stop, established reversal, or sustained edge death",()=>{
  const base:any={version:PREDICTIVE_PATH_VERSION,symbol:"SOL_USDT",at:1,lastBarTime:1,
    upProbability:{m15:.38,m30:.34,m60:.30,m120:.28},expectedReturn:{m15:-.003,m30:-.006,m60:-.012,m120:-.018},
    long:{mfe60:.004,mae60:.02,targetBeforeRisk60:.28,entryRegret10:.004,netEv60:-.008},
    short:{mfe60:.02,mae60:.004,targetBeforeRisk60:.70,entryRegret10:.001,netEv60:.009},
    crossVenue:{sourceCount:4,agreement:.85,breadth:-.8,disagreementRate:.001},evidence:{price:-.7,technical:-.6,derivatives:-.4,liquidation:-.2,multiVenue:-.7,context:-.5,persistence:.8,uncertainty:.8},
    rawSide:"SHORT",stableSide:"SHORT",directionProbability:.7,entryQuality:.8,enterNow:true,waitReason:null,confidence:.76};
  assert.equal(predictiveExitDecision({side:"LONG",forecast:base,memory:{side:"SHORT",since:1,lastBarTime:1,oppositeBars:0,weakBars:0},stopped:false,ageMinutes:30}).reason,"PREDICTIVE_REVERSAL");
  assert.equal(predictiveExitDecision({side:"LONG",forecast:base,memory:{side:"LONG",since:1,lastBarTime:1,oppositeBars:0,weakBars:2},stopped:false,ageMinutes:30}).reason,"PREDICTIVE_EDGE_GONE");
  assert.equal(predictiveExitDecision({side:"LONG",forecast:base,memory:{side:"LONG",since:1,lastBarTime:1,oppositeBars:0,weakBars:0},stopped:true,ageMinutes:1}).reason,"CATASTROPHIC_STOP");
});

test("production predictive core has no trained-model or artifact dependency",async()=>{
  const files=["../lib/predictive-path-types.ts","../lib/predictive-path-model.ts","../lib/predictive-path-engine.ts"];
  const text=(await Promise.all(files.map(x=>readFile(new URL(x,import.meta.url),"utf8")))).join("\n");
  assert.doesNotMatch(text,/lightgbm|catboost|transformer|predictive-path-artifact|trainedAt|calibration/i);
});
