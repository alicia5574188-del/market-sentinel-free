import test from "node:test";
import assert from "node:assert/strict";
import { ANCHOR_FLOW_VERSION, advanceAnchorFlowUniverse, anchorFlowExecutableProofRate } from "../lib/anchor-flow.ts";
import { MULTI_TURN_VERSION, type MultiTurnState, type TurnEvidence, type TurnFrameState, type TurnSide } from "../lib/multi-turn-engine.ts";
import { REGION_LIFECYCLE_VERSION, type RegionCandle, type RegionEntrySignal, type RegionLifecycleState } from "../lib/region-lifecycle.ts";

const START=Date.parse("2026-09-23T00:00:00Z")/1000;
const evidence:TurnEvidence={structure:0,momentum:0,acceleration:0,cusum:0,changePoint:0,failedExtension:0,volatility:0,volume:0,breadth:0,propagation:0};
const frame=(tf:"15m"|"1h",side:TurnSide,completedAt:number):TurnFrameState=>({
  version:MULTI_TURN_VERSION,symbol:"BTC_USDT",timeframe:tf,observedAt:completedAt,completedAt,ready:true,
  direction:side,rawDirection:side,directionConfidence:side==="NEUTRAL"?0:.72,turnProbability:.18,triggerProbability:.18,
  continuationScore:side==="NEUTRAL"?0:.62,phase:"FLOW",candidateSide:"NEUTRAL",candidateBars:0,justTurned:false,lastTurnAt:null,signalAgeBars:1,
  atrRate:.008,expectedMoveRate:tf==="15m"?.018:.035,stopRate:.015,price:101.5,breadthLong:.55,propagationPressure:0,
  evidence,reason:"fixture"
});
const frames=(side:TurnSide="LONG",at=START*1000):MultiTurnState["frames"]=>({
  BTC_USDT:{"15m":frame("15m",side,at),"1h":frame("1h",side,at)}
});
const zone={id:"rg-btc",symbol:"BTC_USDT",startAt:(START-3600)*1000,endAt:START*1000,confirmedAt:START*1000,bars:24,
  lower:99,upper:101,center:100,width:2,widthRate:.02,touchesUpper:5,touchesLower:5,crossings:6};
const lifecycle:RegionLifecycleState={version:REGION_LIFECYCLE_VERSION,symbol:"BTC_USDT",initializedAt:START*1000,observedAt:START*1000,
  lastProcessedAt:START*1000,zone,status:"ACCEPTED_UP",probeStartedAt:null,probeExtreme:null,acceptedAt:START*1000,
  detachedAt:null,upperConsumedAt:null,lowerConsumedAt:null,reason:"fixture"};
const raw:RegionEntrySignal={version:REGION_LIFECYCLE_VERSION,id:"raw",symbol:"BTC_USDT",kind:"MIGRATION",side:"LONG",boundary:"UPPER",
  completedAt:(START+300)*1000,expiresAt:(START+1500)*1000,signalPrice:101.3,stopPrice:100.6,targetPrice:null,
  regionId:zone.id,regionConfirmedAt:zone.confirmedAt,regionLower:zone.lower,regionUpper:zone.upper,regionCenter:zone.center,
  regionWidth:zone.width,regionWidthRate:zone.widthRate,reason:"raw accepted migration"};
const bar=(offset:number,o:number,h:number,l:number,c:number):RegionCandle=>({time:START+offset,open:o,high:h,low:l,close:c,volume:1000});

test("accepted migration waits for a good 5m location and becomes READY rather than consumed",()=>{
  const firstRows=[bar(300,101.3,102,101.7,101.8)];
  const first=advanceAnchorFlowUniverse({paths:{BTC_USDT:firstRows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+600)*1000),
    prior:{},migrationSignals:[raw],consumed:{},now:(START+600)*1000+1,costRate:.0022});
  assert.equal(first.signals.length,0);
  assert.equal(first.states.BTC_USDT?.phase,"RETEST");

  const full=[...firstRows,bar(600,101.75,101.95,101.25,101.9)];
  const next=advanceAnchorFlowUniverse({paths:{BTC_USDT:full},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+900)*1000),
    prior:first.states,migrationSignals:[],consumed:{},now:(START+900)*1000+1,costRate:.0022});
  assert.equal(next.signals.length,1);
  assert.equal(next.signals[0]!.entryModel,"ANCHOR_FLOW");
  assert.equal(next.signals[0]!.contextTimeframe,"15m");
  assert.ok(next.signals[0]!.stopPrice<next.signals[0]!.signalPrice);
  assert.equal(next.states.BTC_USDT?.phase,"READY");
  assert.equal(next.states.BTC_USDT?.consumedAt,null);
});

test("NEUTRAL higher frames are context only and do not veto a 5m opportunity",()=>{
  const neutral:MultiTurnState["frames"]={BTC_USDT:{"15m":frame("15m","NEUTRAL",START*1000),"1h":frame("1h","NEUTRAL",START*1000)}};
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:[]},lifecycles:{BTC_USDT:lifecycle},frames:neutral,
    prior:{},migrationSignals:[raw],consumed:{},now:(START+300)*1000+1,costRate:.0022});
  assert.equal(result.states.BTC_USDT?.phase,"WAIT_RETEST");
});

test("a low-confidence opposite FLOW does not veto, but a confident established opposite flow does",()=>{
  const weak1h={...frame("1h","SHORT",START*1000),directionConfidence:.35,continuationScore:.25};
  const weak:MultiTurnState["frames"]={BTC_USDT:{"15m":frame("15m","LONG",START*1000),"1h":weak1h}};
  const allowed=advanceAnchorFlowUniverse({paths:{BTC_USDT:[]},lifecycles:{BTC_USDT:lifecycle},frames:weak,
    prior:{},migrationSignals:[raw],consumed:{},now:(START+300)*1000+1,costRate:.0022});
  assert.equal(allowed.states.BTC_USDT?.phase,"WAIT_RETEST");

  const strong:MultiTurnState["frames"]={BTC_USDT:{"15m":frame("15m","LONG",START*1000),"1h":frame("1h","SHORT",START*1000)}};
  const vetoed=advanceAnchorFlowUniverse({paths:{BTC_USDT:[]},lifecycles:{BTC_USDT:lifecycle},frames:strong,
    prior:{},migrationSignals:[raw],consumed:{},now:(START+300)*1000+1,costRate:.0022});
  assert.equal(vetoed.states.BTC_USDT,undefined);
});

test("WATCH or TURNING opposite states are warnings rather than established vetoes",()=>{
  const warning1h={...frame("1h","SHORT",START*1000),phase:"WATCH" as const,directionConfidence:.90,continuationScore:.80,turnProbability:.58};
  const warning15={...frame("15m","SHORT",START*1000),phase:"TURNING" as const,directionConfidence:.90,continuationScore:.80,turnProbability:.70};
  const context:MultiTurnState["frames"]={BTC_USDT:{"15m":warning15,"1h":warning1h}};
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:[]},lifecycles:{BTC_USDT:lifecycle},frames:context,
    prior:{},migrationSignals:[raw],consumed:{},now:(START+300)*1000+1,costRate:.0022});
  assert.equal(result.states.BTC_USDT?.phase,"WAIT_RETEST");
});

test("a strong first-retest candle may become READY on the same completed 5m bar",()=>{
  const rows=[bar(300,101.4,101.85,101.2,101.8)];
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:rows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+600)*1000),
    prior:{},migrationSignals:[raw],consumed:{},now:(START+600)*1000+1,costRate:.0022});
  assert.equal(result.signals.length,1);
  assert.equal(result.states.BTC_USDT?.phase,"READY");
  assert.equal(result.signals[0]!.anchorExpectedMoveRate,.018);
});

test("the first retest may close inside the outer part of the old region and recover",()=>{
  const firstRows=[bar(300,101.2,101.4,100.5,100.7)];
  const first=advanceAnchorFlowUniverse({paths:{BTC_USDT:firstRows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+600)*1000),
    prior:{},migrationSignals:[raw],consumed:{},now:(START+600)*1000+1,costRate:.0022});
  assert.notEqual(first.states.BTC_USDT?.phase,"FAILED");
  assert.equal(first.states.BTC_USDT?.phase,"RETEST");

  const recovered=advanceAnchorFlowUniverse({paths:{BTC_USDT:[...firstRows,bar(600,100.7,101.35,100.6,101.2)]},
    lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+900)*1000),prior:first.states,migrationSignals:[],consumed:{},
    now:(START+900)*1000+1,costRate:.0022});
  assert.equal(recovered.states.BTC_USDT?.phase,"READY");
  assert.equal(recovered.signals.length,1);
});

test("two confirmed reacceptance closes convert a failed breakout into opposite REJECTION",()=>{
  const rows=[bar(300,101.2,101.45,100.3,100.45),bar(600,100.45,101.2,100.2,100.35)];
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:rows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+900)*1000),
    prior:{},migrationSignals:[raw],consumed:{},now:(START+900)*1000+1,costRate:.0022});
  assert.equal(result.signals.length,0);
  assert.equal(result.rejections.length,1);
  assert.equal(result.rejections[0]!.kind,"REJECTION");
  assert.equal(result.rejections[0]!.side,"SHORT");
  assert.equal(result.rejections[0]!.targetPrice,zone.center);
  assert.equal(result.states.BTC_USDT?.phase,"FAILED");
  assert.match(result.states.BTC_USDT?.reason??"",/REJECTION/);
});

test("a close that has already reached the region center fails without chasing a late reversal",()=>{
  const rows=[bar(300,101.2,101.45,99.8,99.95)];
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:rows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+600)*1000),
    prior:{},migrationSignals:[raw],consumed:{},now:(START+600)*1000+1,costRate:.0022});
  assert.equal(result.signals.length,0);
  assert.equal(result.rejections.length,0);
  assert.equal(result.states.BTC_USDT?.phase,"FAILED");
  assert.match(result.states.BTC_USDT?.reason??"",/中心/);
});

test("READY survives an unfilled signal and can issue a later fresh boundary reaction",()=>{
  const firstRows=[bar(300,101.4,101.85,101.2,101.8)];
  const first=advanceAnchorFlowUniverse({paths:{BTC_USDT:firstRows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+600)*1000),
    prior:{},migrationSignals:[raw],consumed:{},now:(START+600)*1000+1,costRate:.0022});
  assert.equal(first.states.BTC_USDT?.phase,"READY");
  const nextRows=[...firstRows,bar(600,101.0,101.55,100.8,101.4)];
  const next=advanceAnchorFlowUniverse({paths:{BTC_USDT:nextRows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+900)*1000),
    prior:first.states,migrationSignals:[],consumed:{},now:(START+900)*1000+1,costRate:.0022});
  assert.equal(next.states.BTC_USDT?.phase,"READY");
  assert.equal(next.signals.length,1);
  assert.ok(next.signals[0]!.completedAt>first.signals[0]!.completedAt);
});

test("legacy FIRED means signal-emitted only and is recovered as READY after upgrade",()=>{
  const rows=[bar(300,101.4,101.85,101.2,101.8)];
  const ready=advanceAnchorFlowUniverse({paths:{BTC_USDT:rows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+600)*1000),
    prior:{},migrationSignals:[raw],consumed:{},now:(START+600)*1000+1,costRate:.0022});
  const legacy=structuredClone(ready.states);legacy.BTC_USDT!.phase="FIRED";
  const next=advanceAnchorFlowUniverse({paths:{BTC_USDT:rows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+600)*1000),
    prior:legacy,migrationSignals:[],consumed:{},now:(START+600)*1000+2,costRate:.0022});
  assert.equal(next.states.BTC_USDT?.phase,"READY");
});

test("an existing READY state becomes CONSUMED only after the order layer records a fill",()=>{
  const rows=[bar(300,101.4,101.85,101.2,101.8)];
  const ready=advanceAnchorFlowUniverse({paths:{BTC_USDT:rows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+600)*1000),
    prior:{},migrationSignals:[raw],consumed:{},now:(START+600)*1000+1,costRate:.0022});
  const consumedAt=(START+610)*1000;
  const next=advanceAnchorFlowUniverse({paths:{BTC_USDT:rows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+600)*1000),
    prior:ready.states,migrationSignals:[],consumed:{[zone.id+":LONG"]:consumedAt},now:consumedAt+1,costRate:.0022});
  assert.equal(next.states.BTC_USDT?.phase,"CONSUMED");
  assert.equal(next.states.BTC_USDT?.consumedAt,consumedAt);
  assert.equal(next.signals.length,0);
});


test("READY stays executable between completed 5m bars instead of requiring another reaction candle",()=>{
  const rows=[bar(300,101.4,101.85,101.2,101.8)];
  const ready=advanceAnchorFlowUniverse({paths:{BTC_USDT:rows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+600)*1000),
    prior:{},migrationSignals:[raw],consumed:{},now:(START+600)*1000+1,costRate:.0022});
  assert.equal(ready.states.BTC_USDT?.phase,"READY");
  const between=advanceAnchorFlowUniverse({paths:{BTC_USDT:rows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+600)*1000),
    prior:ready.states,migrationSignals:[],consumed:{},now:(START+720)*1000,costRate:.0022});
  assert.equal(between.signals.length,1);
  assert.equal(between.signals[0]!.id,`af-${zone.id}-LONG-READY`);
  assert.equal(between.signals[0]!.expiresAt,between.states.BTC_USDT!.expiresAt);
});

test("executable confirmation threshold is deliberately small and cost-bounded",()=>{
  assert.equal(anchorFlowExecutableProofRate(.0022),.001);
  assert.equal(anchorFlowExecutableProofRate(.004),.0015);
  assert.equal(anchorFlowExecutableProofRate(.0005),.001);
});
