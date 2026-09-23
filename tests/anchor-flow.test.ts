import test from "node:test";
import assert from "node:assert/strict";
import { ANCHOR_FLOW_VERSION, advanceAnchorFlowUniverse } from "../lib/anchor-flow.ts";
import { MULTI_TURN_VERSION, type MultiTurnState, type TurnEvidence, type TurnFrameState } from "../lib/multi-turn-engine.ts";
import { REGION_LIFECYCLE_VERSION, type RegionCandle, type RegionEntrySignal, type RegionLifecycleState } from "../lib/region-lifecycle.ts";

const START=Date.parse("2026-09-23T00:00:00Z")/1000;
const evidence:TurnEvidence={structure:0,momentum:0,acceleration:0,cusum:0,changePoint:0,failedExtension:0,volatility:0,volume:0,breadth:0,propagation:0};
const frame=(tf:"15m"|"1h",side:"LONG"|"SHORT",completedAt:number):TurnFrameState=>({
  version:MULTI_TURN_VERSION,symbol:"BTC_USDT",timeframe:tf,observedAt:completedAt,completedAt,ready:true,
  direction:side,rawDirection:side,directionConfidence:.72,turnProbability:.18,triggerProbability:.18,continuationScore:.62,
  phase:"FLOW",candidateSide:"NEUTRAL",candidateBars:0,justTurned:false,lastTurnAt:null,signalAgeBars:1,
  atrRate:.008,expectedMoveRate:tf==="15m"?.018:.035,stopRate:.015,price:101.5,breadthLong:.55,propagationPressure:0,
  evidence,reason:"fixture"
});
const frames=(side:"LONG"|"SHORT"="LONG",at=START*1000):MultiTurnState["frames"]=>({
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

test("raw accepted migration creates no order until extension, first retest and restart all occur",()=>{
  const partial=[bar(300,101.3,102,101.7,101.8)];
  const first=advanceAnchorFlowUniverse({paths:{BTC_USDT:partial},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+600)*1000),
    prior:{},migrationSignals:[raw],consumed:{},now:(START+600)*1000+1,costRate:.0022});
  assert.equal(first.signals.length,0);
  assert.equal(first.states.BTC_USDT?.phase,"WAIT_RETEST");

  const full=[...partial,bar(600,101.8,101.65,101.2,101.4),bar(900,101.4,101.85,101.3,101.75)];
  const next=advanceAnchorFlowUniverse({paths:{BTC_USDT:full},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+1200)*1000),
    prior:first.states,migrationSignals:[],consumed:{},now:(START+1200)*1000+1,costRate:.0022});
  assert.equal(next.signals.length,1);
  assert.equal(next.signals[0]!.entryModel,"ANCHOR_FLOW");
  assert.equal(next.signals[0]!.contextTimeframe,"15m");
  assert.ok(next.signals[0]!.stopPrice<next.signals[0]!.signalPrice);
  assert.equal(next.states.BTC_USDT?.phase,"FIRED");
});

test("1h and 15m must agree before a raw migration can arm AnchorFlow",()=>{
  const disagree:MultiTurnState["frames"]={BTC_USDT:{"15m":frame("15m","LONG",START*1000),"1h":frame("1h","SHORT",START*1000)}};
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:[]},lifecycles:{BTC_USDT:lifecycle},frames:disagree,
    prior:{},migrationSignals:[raw],consumed:{},now:(START+300)*1000+1,costRate:.0022});
  assert.equal(result.signals.length,0);
  assert.equal(result.states.BTC_USDT,undefined);
});

test("deep reacceptance of the old region kills the candidate instead of re-entering",()=>{
  const rows=[bar(300,101.3,102,101.2,101.8),bar(600,101.8,101.9,100.6,100.7)];
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:rows},lifecycles:{BTC_USDT:lifecycle},frames:frames("LONG",(START+900)*1000),
    prior:{},migrationSignals:[raw],consumed:{},now:(START+900)*1000+1,costRate:.0022});
  assert.equal(result.signals.length,0);
  assert.equal(result.states.BTC_USDT?.phase,"FAILED");
  assert.match(result.states.BTC_USDT?.reason??"",/重新被旧区域接受/);
});

test("a consumed region-side pair cannot charge the account twice",()=>{
  const result=advanceAnchorFlowUniverse({paths:{BTC_USDT:[]},lifecycles:{BTC_USDT:lifecycle},frames:frames(),
    prior:{},migrationSignals:[raw],consumed:{[zone.id+":LONG"]:START*1000},now:(START+300)*1000+1,costRate:.0022});
  assert.equal(result.signals.length,0);
  assert.equal(result.states.BTC_USDT,undefined);
});
