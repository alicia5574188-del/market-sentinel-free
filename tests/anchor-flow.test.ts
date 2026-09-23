import test from "node:test";
import assert from "node:assert/strict";
import { ANCHOR_FLOW_VERSION, advanceAnchorFlowUniverse } from "../lib/anchor-flow.ts";
import { MULTI_TURN_VERSION, type MultiTurnState, type TurnEvidence, type TurnFrameState } from "../lib/multi-turn-engine.ts";
import { REGION_LIFECYCLE_VERSION, type RegionCandle, type RegionEntrySignal, type RegionLifecycleState } from "../lib/region-lifecycle.ts";

const START=Date.parse("2026-09-23T00:00:00Z")/1000;
const evidence:TurnEvidence={structure:0,momentum:0,acceleration:0,cusum:0,changePoint:0,failedExtension:0,volatility:0,volume:0,breadth:0,propagation:0};
const frame=(tf:"15m"|"1h",side:"LONG"|"SHORT"|"NEUTRAL",completedAt:number):TurnFrameState=>({
  version:MULTI_TURN_VERSION,symbol:"BTC_USDT",timeframe:tf,observedAt:completedAt,completedAt,ready:true,
  direction:side,rawDirection:side,directionConfidence:side==="NEUTRAL"?.18:.72,turnProbability:.18,triggerProbability:.18,
  continuationScore:side==="NEUTRAL"?0:.62,phase:"FLOW",candidateSide:"NEUTRAL",candidateBars:0,justTurned:false,lastTurnAt:null,signalAgeBars:1,
  atrRate:.008,expectedMoveRate:tf==="15m"?.018:.035,stopRate:.015,price:101.5,breadthLong:.55,propagationPressure:0,
  evidence,reason:"fixture"
});
const frames=(side:"LONG"|"SHORT"|"NEUTRAL"="LONG",at=START*1000):MultiTurnState["frames"]=>({
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

test("a strong first retest becomes READY, not consumed",()=>{
  const rows=[bar(300,101.4,101.85,101.2,101.8)];
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:rows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+600)*1000),
    prior:{},migrationSignals:[raw],consumed:{},now:(START+600)*1000+1,costRate:.0022});
  assert.equal(result.signals.length,1);
  assert.equal(result.states.BTC_USDT?.phase,"READY");
  assert.equal(result.states.BTC_USDT?.consumedAt,null);
  assert.equal(result.signals[0]!.entryModel,"ANCHOR_FLOW");
  assert.equal(result.signals[0]!.anchorExpectedMoveRate,.018);
});

test("NEUTRAL higher frames are context only and do not veto a 5m migration",()=>{
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:[]},lifecycles:{BTC_USDT:lifecycle},frames:frames("NEUTRAL",START*1000),
    prior:{},migrationSignals:[raw],consumed:{},now:(START+300)*1000+1,costRate:.0022});
  assert.equal(result.states.BTC_USDT?.phase,"WAIT_RETEST");
});

test("a clearly established confident opposite 1h direction still vetoes the 5m opportunity",()=>{
  const disagree:MultiTurnState["frames"]={BTC_USDT:{"15m":frame("15m","LONG",START*1000),"1h":frame("1h","SHORT",START*1000)}};
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:[]},lifecycles:{BTC_USDT:lifecycle},frames:disagree,
    prior:{},migrationSignals:[raw],consumed:{},now:(START+300)*1000+1,costRate:.0022});
  assert.equal(result.signals.length,0);
  assert.equal(result.states.BTC_USDT,undefined);
});

test("a weak opposite higher-timeframe state no longer kills an otherwise valid 5m setup",()=>{
  const weak1h={...frame("1h","SHORT",START*1000),phase:"FLOW" as const,directionConfidence:.30,continuationScore:.22};
  const weak15={...frame("15m","LONG",START*1000),phase:"WATCH" as const,continuationScore:.20};
  const context:MultiTurnState["frames"]={BTC_USDT:{"15m":weak15,"1h":weak1h}};
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:[]},lifecycles:{BTC_USDT:lifecycle},frames:context,
    prior:{},migrationSignals:[raw],consumed:{},now:(START+300)*1000+1,costRate:.0022});
  assert.equal(result.states.BTC_USDT?.phase,"WAIT_RETEST");
});

test("one shallow close inside the outer part of the old region is a normal retest, not failure",()=>{
  const rows=[bar(300,101.25,101.5,100.55,100.65)];
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:rows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+600)*1000),
    prior:{},migrationSignals:[raw],consumed:{},now:(START+600)*1000+1,costRate:.0022});
  assert.equal(result.rejections.length,0);
  assert.equal(result.states.BTC_USDT?.phase,"RETEST");
  assert.equal(result.states.BTC_USDT?.failedAt,null);
});

test("two consecutive closes clearly reaccepted inside the old region convert the failed breakout into REJECTION",()=>{
  const rows=[
    bar(300,101.25,101.5,100.40,100.45),
    bar(600,100.45,100.6,100.25,100.30),
  ];
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:rows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+900)*1000),
    prior:{},migrationSignals:[raw],consumed:{},now:(START+900)*1000+1,costRate:.0022});
  assert.equal(result.signals.length,0);
  assert.equal(result.rejections.length,1);
  assert.equal(result.rejections[0]!.kind,"REJECTION");
  assert.equal(result.rejections[0]!.side,"SHORT");
  assert.equal(result.rejections[0]!.targetPrice,zone.center);
  assert.equal(result.states.BTC_USDT?.phase,"FAILED");
  assert.match(result.states.BTC_USDT?.reason??"",/转换为反向REJECTION/);
});

test("a move already through the region center kills the trend route without creating a late rejection",()=>{
  const rows=[bar(300,101.25,101.5,99.7,99.9)];
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:rows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+600)*1000),
    prior:{},migrationSignals:[raw],consumed:{},now:(START+600)*1000+1,costRate:.0022});
  assert.equal(result.rejections.length,0);
  assert.equal(result.states.BTC_USDT?.phase,"FAILED");
  assert.match(result.states.BTC_USDT?.reason??"",/区域中心/);
});

test("legacy FIRED without a real fill is recovered as READY instead of being silently consumed",()=>{
  const first=advanceAnchorFlowUniverse({paths:{BTC_USDT:[bar(300,101.4,101.85,101.2,101.8)]},lifecycles:{BTC_USDT:lifecycle},
    frames:frames("LONG",(START+600)*1000),prior:{},migrationSignals:[raw],consumed:{},now:(START+600)*1000+1,costRate:.0022});
  const old={...first.states.BTC_USDT!,phase:"FIRED" as const,consumedAt:null};
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:[]},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+600)*1000),
    prior:{BTC_USDT:old},migrationSignals:[],consumed:{},now:(START+600)*1000+2,costRate:.0022});
  assert.equal(result.states.BTC_USDT?.phase,"READY");
});

test("a real consumed region-side pair cannot charge the account twice",()=>{
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:[]},lifecycles:{BTC_USDT:lifecycle},frames:frames(),
    prior:{},migrationSignals:[raw],consumed:{[zone.id+":LONG"]:START*1000},now:(START+300)*1000+1,costRate:.0022});
  assert.equal(result.signals.length,0);
  assert.equal(result.states.BTC_USDT,undefined);
});

assert.equal(ANCHOR_FLOW_VERSION,"anchor-flow-v1");
