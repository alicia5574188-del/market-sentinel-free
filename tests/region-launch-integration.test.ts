import test from "node:test";
import assert from "node:assert/strict";
import {advanceForward, forwardUrgentQuoteSymbols, forwardWatchSymbols, initialMultiTurnForward,
  type Contract, type ForwardState, type Quote} from "../lib/forward-relations.ts";
import {REGION_LIFECYCLE_VERSION, type RegionLifecycleState} from "../lib/region-lifecycle.ts";
import {ANCHOR_FLOW_VERSION, type AnchorFlowState} from "../lib/anchor-flow.ts";
import {REGION_LAUNCH_VERSION, advanceRegionLaunchUniverse} from "../lib/region-launch.ts";
import {REGION_LAUNCH_PROFIT_PROTECTION_VERSION} from "../lib/multi-turn-profit-protection.ts";
import {MULTI_TURN_VERSION,type TurnFrameState} from "../lib/multi-turn-engine.ts";

const BASE=Date.parse("2026-09-23T12:00:00Z");
const meta:Contract={quantoMultiplier:.001,leverageMax:50,maintenanceRate:.005,minContracts:1};
const quote=(mid:number,at:number):Quote=>({bestBid:mid*.99995,bestAsk:mid*1.00005,observedAt:at,fresh:true,entryReady:true});
const lifecycle=(symbol:string,now:number):RegionLifecycleState=>({
  version:REGION_LIFECYCLE_VERSION,symbol,initializedAt:now-3_600_000,observedAt:now,lastProcessedAt:now,
  zone:{id:`mother-${symbol}`,symbol,startAt:now-4*3_600_000,endAt:now-30*60_000,confirmedAt:now-30*60_000,bars:36,
    lower:99,upper:101,center:100,width:2,widthRate:.02,touchesUpper:6,touchesLower:6,crossings:7},
  status:"IN_REGION",probeStartedAt:null,probeExtreme:null,acceptedAt:null,detachedAt:null,upperConsumedAt:null,lowerConsumedAt:null,
  reason:"fixture mother"
});
const compression=(now:number)=>[
  {time:(now-30*60_000)/1000,open:100.68,high:100.94,low:100.48,close:100.78,volume:1000},
  {time:(now-25*60_000)/1000,open:100.78,high:100.98,low:100.55,close:100.70,volume:1100},
  {time:(now-20*60_000)/1000,open:100.70,high:100.96,low:100.52,close:100.84,volume:1050},
  {time:(now-15*60_000)/1000,open:100.84,high:101.00,low:100.58,close:100.73,volume:1200},
  {time:(now-10*60_000)/1000,open:100.73,high:100.97,low:100.57,close:100.86,volume:1150},
  {time:(now-5*60_000)/1000,open:100.86,high:101.01,low:100.60,close:100.79,volume:1250},
];
const passiveAnchor=(symbol:string,now:number):AnchorFlowState=>({
  version:ANCHOR_FLOW_VERSION,symbol,regionId:`mother-${symbol}`,side:"LONG",boundary:"UPPER",phase:"WAIT_RETEST",
  createdAt:now-20*60_000,expiresAt:now+40*60_000,lastProcessedAt:now-5*60_000,breakoutCompletedAt:now-20*60_000,
  regionConfirmedAt:now-30*60_000,regionLower:99,regionUpper:101,regionCenter:100,regionWidth:2,regionWidthRate:.02,
  excursionExtreme:101.2,retestAt:null,pullbackExtreme:null,restartLevel:null,readyAt:null,reacceptBars:0,retryCount:0,
  confirmationExtreme:null,firedAt:null,consumedAt:null,failedAt:null,reason:"AnchorFlow stays independent"
});
const minute=(startMs:number,o:number,h:number,l:number,c:number)=>({time:startMs/1000,open:o,high:h,low:l,close:c,volume:1000});
function seeded(now:number){
  const s=initialMultiTurnForward(now-60_000);
  s.lastCycleAt=now;s.lastQuoteCycleAt=now-10_000;s.daily=[{day:"2026-09-23",firstAt:now,lastAt:now,startEquity:1000,endEquity:1000,exactBoundary:false}];
  s.regionLifecycles={BCH_USDT:lifecycle("BCH_USDT",now)};s.regionSignals=[];s.anchorFlows={BCH_USDT:passiveAnchor("BCH_USDT",now)};
  s.regionLaunchVersion=REGION_LAUNCH_VERSION;
  s.regionLaunches=advanceRegionLaunchUniverse({paths:{BCH_USDT:compression(now)},lifecycles:s.regionLifecycles,prior:{},now,costRate:.0022}).states;
  s.regionLaunchSignals=[];return s;
}
function step(state:ForwardState,now:number,mid:number,minutePaths:Record<string,ReturnType<typeof minute>[]>={}){
  return advanceForward({state,now,paths:{},minutePaths,quotes:{BCH_USDT:quote(mid,now)},contracts:{BCH_USDT:meta},
    entrySymbols:["BCH_USDT"],allowDataCycle:false});
}
function launchPath(now:number){
  const breakout=minute(now,100.90,102.30,100.85,102.00);
  const pullback=minute(now+60_000,102.00,102.05,101.65,101.75);
  const restart=minute(now+120_000,101.75,102.15,101.72,102.10);
  return{breakout,pullback,restart};
}
function driveLaunch(state:ForwardState,now:number){
  const m=launchPath(now);let s=state;
  s=step(s,now+60_000,102.00,{BCH_USDT:[m.breakout]}).state;
  s=step(s,now+120_000,101.75,{BCH_USDT:[m.breakout,m.pullback]}).state;
  s=step(s,now+180_000,102.11,{BCH_USDT:[m.breakout,m.pullback,m.restart]}).state;
  return{s,m};
}

test("MET-style top compression can launch SHORT inside the mother while higher frames remain LONG",()=>{
  let s=seeded(BASE);
  const trend:TurnFrameState={version:MULTI_TURN_VERSION,symbol:"BCH_USDT",timeframe:"15m",observedAt:BASE,completedAt:BASE,
    ready:true,direction:"LONG",rawDirection:"LONG",directionConfidence:.95,turnProbability:.05,triggerProbability:.05,
    continuationScore:.9,phase:"FLOW",candidateSide:"NEUTRAL",candidateBars:0,justTurned:false,lastTurnAt:BASE-600_000,
    signalAgeBars:10,atrRate:.01,expectedMoveRate:.03,stopRate:.01,price:100.8,breadthLong:.8,propagationPressure:0,
    evidence:{structure:0,momentum:0,acceleration:0,cusum:0,changePoint:0,failedExtension:0,volatility:0,volume:0,breadth:0,propagation:0},reason:"old uptrend"};
  s.turnEngine!.frames.BCH_USDT={"15m":trend,"1h":{...trend,timeframe:"1h"}};
  const first=minute(BASE,100.8,100.82,99.95,100.0),second=minute(BASE+60_000,100,100.02,99.45,99.5);
  s=step(s,BASE+60_000,100,{BCH_USDT:[first]}).state;
  assert.equal(s.regionLaunches?.BCH_USDT?.phase,"IGNITION");
  s=step(s,BASE+120_000,99.5,{BCH_USDT:[first,second]}).state;
  assert.equal(s.positions.length,1);assert.equal(s.positions[0]!.side,"SHORT");
  assert.ok(s.positions[0]!.entryPrice>99,"short launched before breaking the old mother low");
  assert.ok(s.positions[0]!.stopPrice>100,"full continuation support is retained");
  s=step(s,BASE+126_000,99.48,{BCH_USDT:[first,second]}).state;
  assert.equal(s.positions.length,1,"the pre-existing bullish frame cannot instantly close a new countertrend launch");
});

test("full RegionLaunch path opens only after strong 1m impulse, small pullback and real restart; AnchorFlow remains independent",()=>{
  const now=BASE;const m=launchPath(BASE);let s=seeded(now);
  s=step(s,now+60_000,102.00,{BCH_USDT:[m.breakout]}).state;
  assert.equal(s.regionLaunches?.BCH_USDT?.phase,"IGNITION");assert.equal(s.positions.length,0);
  s=step(s,now+120_000,101.75,{BCH_USDT:[m.breakout,m.pullback]}).state;
  assert.equal(s.regionLaunches?.BCH_USDT?.phase,"IGNITION");assert.equal(s.positions.length,0);
  s=step(s,now+180_000,102.11,{BCH_USDT:[m.breakout,m.pullback,m.restart]}).state;
  assert.equal(s.positions.length,1);
  const t=s.positions[0]!;
  assert.equal(t.entryContext?.version,"region-launch-entry-v1");assert.equal(t.rule.grammar,REGION_LAUNCH_VERSION);
  assert.equal(t.entryValidation?.version,"region-launch-entry-validation-v1");assert.equal(t.entryValidation?.dueAt,t.openedAt+60_000);
  assert.equal(s.regionLaunches?.BCH_USDT?.phase,"CONSUMED");
  assert.equal(s.regionLifecycles?.BCH_USDT?.upperConsumedAt,null,"RegionLaunch must not consume AnchorFlow/region boundary authority");
  assert.equal(s.anchorFlows?.BCH_USDT?.phase,"WAIT_RETEST","existing AnchorFlow state remains independent");
});

test("MET-like upper-wick breakout never creates a RegionLaunch position",()=>{
  const now=BASE;const fake=minute(BASE,100.90,103.30,100.85,101.45);let s=seeded(now);
  s=step(s,now+60_000,101.45,{BCH_USDT:[fake]}).state;
  assert.equal(s.positions.length,0);assert.equal(s.regionLaunches?.BCH_USDT?.phase,"ARMED");
  assert.match(s.regionLaunches?.BCH_USDT?.reason??"",/突破K不够强/);
});

test("RegionLaunch with no prompt executable profit still exits after sixty seconds and keeps the mother for future observation",()=>{
  const now=BASE,{s:opened,m}=driveLaunch(seeded(now),now);let s=opened;
  assert.equal(s.positions.length,1);
  const t=s.positions[0]!,due=t.entryValidation!.dueAt;
  s=step(s,due+1,t.entryPrice*1.0004,{BCH_USDT:[m.breakout,m.pullback,m.restart]}).state;
  assert.equal(s.positions.length,0);assert.equal(s.history[0]?.entryValidation?.passed,false);
  assert.match(s.history[0]?.exitReason??"",/RegionLaunch入场验证失败/);
  assert.equal(s.regionLaunches?.BCH_USDT?.phase,"WATCH");assert.equal(s.regionLaunches?.BCH_USDT?.motherRegionId,"mother-BCH_USDT");
});

test("a fast RegionLaunch winner passes sixty-second validation and raises the high-retention source stop",()=>{
  const now=BASE,{s:opened,m}=driveLaunch(seeded(now),now);let s=opened;
  assert.equal(s.positions.length,1);
  const entry=s.positions[0]!.entryPrice;
  s=step(s,now+190_000,entry*1.020,{BCH_USDT:[m.breakout,m.pullback,m.restart]}).state;
  assert.equal(s.positions[0]?.profitProtection?.version,REGION_LAUNCH_PROFIT_PROTECTION_VERSION);
  assert.ok((s.positions[0]?.profitProtection?.retentionRate??0)>=.84);assert.ok((s.positions[0]?.stopPrice??0)>entry);
  const due=s.positions[0]!.entryValidation!.dueAt;
  s=step(s,due+1,entry*1.019,{BCH_USDT:[m.breakout,m.pullback,m.restart]}).state;
  assert.equal(s.positions.length,1);assert.equal(s.positions[0]!.entryValidation?.passed,true);
});

test("ARMED/IGNITION/READY are explicit urgent quote priorities inside the same bounded realtime pool",()=>{
  const now=BASE,s=seeded(now);
  const urgent=forwardUrgentQuoteSymbols(s,now,["BCH_USDT"]);
  assert.ok(urgent.includes("BCH_USDT"));
  const ordinary=Array.from({length:14},(_,i)=>`R${i}_USDT`);
  for(const symbol of ordinary)s.regionLifecycles![symbol]=lifecycle(symbol,now);
  const watched=forwardWatchSymbols(s,now,["BCH_USDT",...ordinary]);
  assert.ok(watched.includes("BCH_USDT"));assert.ok(watched.length<=11);
});
