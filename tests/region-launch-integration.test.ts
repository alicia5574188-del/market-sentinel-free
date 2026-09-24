import test from "node:test";
import assert from "node:assert/strict";
import {advanceForward, forwardUrgentMinuteSymbols, forwardUrgentQuoteSymbols, forwardWatchSymbols, initialMultiTurnForward,
  type Contract, type ForwardState, type Quote} from "../lib/forward-relations.ts";
import {REGION_LIFECYCLE_VERSION, type RegionLifecycleState} from "../lib/region-lifecycle.ts";
import {REGION_LAUNCH_VERSION, advanceRegionLaunchUniverse} from "../lib/region-launch.ts";
import {REGION_LAUNCH_PROFIT_PROTECTION_VERSION} from "../lib/multi-turn-profit-protection.ts";
import {ANCHOR_FLOW_VERSION,type AnchorFlowState} from "../lib/anchor-flow.ts";

const BASE=Date.parse("2026-09-23T12:00:00Z");
const meta:Contract={quantoMultiplier:.001,leverageMax:50,maintenanceRate:.005,minContracts:1};
const quote=(mid:number,at:number):Quote=>({bestBid:mid*.99995,bestAsk:mid*1.00005,observedAt:at,fresh:true,entryReady:true});
const candle=(timeMs:number,o:number,h:number,l:number,c:number)=>({time:timeMs/1000,open:o,high:h,low:l,close:c,volume:1000});
const motherRows=(now:number)=>Array.from({length:36},(_,i)=>{
  const time=now-(36-i)*300_000,open=100+(i%2?-.08:.08),close=100+(i%2?.08:-.08);
  const high=i===4?101.18:Math.max(open,close)+.08+(i%3)*.01;
  const low=i===10?98.82:Math.min(open,close)-.08-(i%4)*.008;
  return candle(time,open,high,low,close);
});
const lifecycle=(symbol:string,now:number):RegionLifecycleState=>({
  version:REGION_LIFECYCLE_VERSION,symbol,initializedAt:now-4*3_600_000,observedAt:now,lastProcessedAt:now,
  zone:{id:`mother-${symbol}`,symbol,startAt:now-35*300_000,endAt:now,confirmedAt:now,bars:36,
    lower:99,upper:101,center:100,width:2,widthRate:.02,touchesUpper:8,touchesLower:8,crossings:9},
  status:"IN_REGION",probeStartedAt:null,probeExtreme:null,acceptedAt:null,detachedAt:null,upperConsumedAt:null,lowerConsumedAt:null,
  reason:"fixture mother"
});
const passiveAnchor=(symbol:string,now:number):AnchorFlowState=>({
  version:ANCHOR_FLOW_VERSION,symbol,regionId:`mother-${symbol}`,side:"LONG",boundary:"UPPER",phase:"READY",
  createdAt:now-20*60_000,expiresAt:now+40*60_000,lastProcessedAt:now,breakoutCompletedAt:now-20*60_000,
  regionConfirmedAt:now,regionLower:99,regionUpper:101,regionCenter:100,regionWidth:2,regionWidthRate:.02,
  excursionExtreme:101.2,retestAt:now-5*60_000,pullbackExtreme:100.7,restartLevel:101.1,readyAt:now,reacceptBars:0,retryCount:0,
  confirmationExtreme:101.05,firedAt:now,consumedAt:null,failedAt:null,reason:"retired fixture"
});
function seeded(now:number){
  const s=initialMultiTurnForward(now-60_000);
  s.lastCycleAt=now;s.lastQuoteCycleAt=now-10_000;
  s.daily=[{day:"2026-09-23",firstAt:now,lastAt:now,startEquity:1000,endEquity:1000,exactBoundary:false}];
  s.regionLifecycles={BCH_USDT:lifecycle("BCH_USDT",now)};s.regionSignals=[];
  s.anchorFlows={BCH_USDT:passiveAnchor("BCH_USDT",now)};
  s.regionLaunchVersion=REGION_LAUNCH_VERSION;
  s.regionLaunches=advanceRegionLaunchUniverse({paths:{BCH_USDT:motherRows(now)},lifecycles:s.regionLifecycles,prior:{},now:now+1,costRate:.0022}).states;
  s.regionLaunchSignals=[];return s;
}
function step(state:ForwardState,now:number,mid:number,minutePaths:Record<string,ReturnType<typeof candle>[]>={},
  paths:Record<string,ReturnType<typeof candle>[] >={}){
  return advanceForward({state,now,paths,minutePaths,quotes:{BCH_USDT:quote(mid,now)},contracts:{BCH_USDT:meta},
    entrySymbols:["BCH_USDT"],allowDataCycle:false});
}
function fastPath(now:number){
  const breakout=candle(now,101.02,102.52,101.00,102.46);
  const pullback=candle(now+60_000,102.46,102.48,101.94,102.00);
  const restart=candle(now+120_000,102.00,102.15,101.98,102.13);
  return{breakout,pullback,restart};
}
function driveFast(state:ForwardState,now:number){
  const m=fastPath(now);let s=state;
  s=step(s,now+60_000,102.46,{BCH_USDT:[m.breakout]}).state;
  s=step(s,now+120_000,102.00,{BCH_USDT:[m.breakout,m.pullback]}).state;
  s=step(s,now+180_000,102.13,{BCH_USDT:[m.breakout,m.pullback,m.restart]}).state;
  return{s,m};
}

test("a move inside the mature full-wick region cannot create a trade even when old AnchorFlow is READY",()=>{
  let s=seeded(BASE);
  const inside=candle(BASE,100.7,101.10,100.65,101.05);
  s=step(s,BASE+60_000,101.05,{BCH_USDT:[inside]}).state;
  assert.equal(s.positions.length,0);
  assert.equal(s.regionLaunches?.BCH_USDT?.phase,"ARMED");
  assert.equal(s.anchorFlows?.BCH_USDT?.phase,"READY","legacy state may exist until data-cycle cleanup but has no entry authority");
});

test("full RegionLaunch path opens only after current 5m strength, a small pullback and real restart",()=>{
  const now=BASE,{s,m}=driveFast(seeded(now),now);
  assert.equal(s.positions.length,1);
  const t=s.positions[0]!;
  assert.equal(t.entryContext?.version,"region-launch-entry-v1");assert.equal(t.rule.grammar,REGION_LAUNCH_VERSION);
  assert.equal(t.entryValidation?.version,"region-launch-entry-validation-v1");assert.equal(t.entryValidation?.dueAt,t.openedAt+60_000);
  assert.equal(s.regionLaunches?.BCH_USDT?.phase,"CONSUMED");
  assert.equal(s.regionLifecycles?.BCH_USDT?.upperConsumedAt,null);
  assert.ok(t.stopPrice<t.entryPrice);assert.ok(t.notional<=600.01);
  assert.ok(m.restart.close<t.entryPrice*1.001,"real quote/slippage may be slightly above the restart but not a distant chase");
});

test("a long upper wick with weak 5m body cannot create a RegionLaunch position",()=>{
  const now=BASE,fake=candle(now,101.02,103.30,100.98,101.42);let s=seeded(now);
  s=step(s,now+60_000,101.42,{BCH_USDT:[fake]}).state;
  assert.equal(s.positions.length,0);assert.equal(s.regionLaunches?.BCH_USDT?.phase,"ARMED");
});

test("RegionLaunch without prompt executable profit exits after sixty seconds and preserves the mother",()=>{
  const now=BASE,{s:opened,m}=driveFast(seeded(now),now);let s=opened;
  assert.equal(s.positions.length,1);
  const t=s.positions[0]!,due=t.entryValidation!.dueAt;
  s=step(s,due+1,t.entryPrice*1.0005,{BCH_USDT:[m.breakout,m.pullback,m.restart]}).state;
  assert.equal(s.positions.length,0);assert.equal(s.history[0]?.entryValidation?.passed,false);
  assert.match(s.history[0]?.exitReason??"",/RegionLaunch入场验证失败/);
  assert.equal(s.regionLaunches?.BCH_USDT?.phase,"WATCH");assert.equal(s.regionLaunches?.BCH_USDT?.motherRegionId,"mother-BCH_USDT");
});

test("a real burst winner passes cost-aware sixty-second validation and raises the monotonic profit stop",()=>{
  const now=BASE,{s:opened,m}=driveFast(seeded(now),now);let s=opened;
  const entry=s.positions[0]!.entryPrice;
  s=step(s,now+190_000,entry*1.020,{BCH_USDT:[m.breakout,m.pullback,m.restart]}).state;
  assert.equal(s.positions[0]?.profitProtection?.version,REGION_LAUNCH_PROFIT_PROTECTION_VERSION);
  assert.ok((s.positions[0]?.profitProtection?.retentionRate??0)>=.84);assert.ok((s.positions[0]?.stopPrice??0)>entry);
  const due=s.positions[0]!.entryValidation!.dueAt;
  s=step(s,due+1,entry*1.019,{BCH_USDT:[m.breakout,m.pullback,m.restart]}).state;
  assert.equal(s.positions.length,1);assert.equal(s.positions[0]!.entryValidation?.passed,true);
});

test("ARMED and IGNITION RegionLaunch states own scarce minute/book priority instead of retired AnchorFlow",()=>{
  const now=BASE,s=seeded(now);
  const urgentMinute=forwardUrgentMinuteSymbols(s,["BCH_USDT"]);
  const urgentQuote=forwardUrgentQuoteSymbols(s,now,["BCH_USDT"]);
  assert.ok(urgentMinute.includes("BCH_USDT"));assert.ok(urgentQuote.includes("BCH_USDT"));
  const ordinary=Array.from({length:14},(_,i)=>`R${i}_USDT`);
  for(const symbol of ordinary)s.regionLifecycles![symbol]=lifecycle(symbol,now);
  const watched=forwardWatchSymbols(s,now,["BCH_USDT",...ordinary]);
  assert.ok(watched.includes("BCH_USDT"));assert.ok(watched.length<=11);
});

test("slow route needs a real outside 5m close and fresh first-minute continuation before opening",()=>{
  const now=BASE;let s=seeded(now);
  const closed=candle(now,101.00,102.06,100.98,102.02),paths={BCH_USDT:[...motherRows(now),closed]};
  s=step(s,now+300_000,102.02,{},paths).state;
  assert.equal(s.positions.length,0);assert.equal(s.regionLaunches!.BCH_USDT!.launchPath,"CLOSED");
  const continuation=candle(now+300_000,102.02,102.15,102.00,102.14);
  s=step(s,now+360_000,102.14,{BCH_USDT:[continuation]},paths).state;
  assert.equal(s.positions.length,1);assert.equal(s.regionLaunches!.BCH_USDT!.phase,"CONSUMED");
  assert.match(s.positions[0]!.rule.reason,/第一根完整1分钟K继续突破/);
});

test("weakening an unfinished fast 5m move revokes its old micro ignition and never opens on stale strength",()=>{
  const now=BASE;let s=seeded(now);
  const first=candle(now,101.02,102.52,101.00,102.46),fade=candle(now+60_000,102.46,102.48,101.35,101.42);
  s=step(s,now+60_000,102.46,{BCH_USDT:[first]}).state;assert.equal(s.regionLaunches!.BCH_USDT!.phase,"IGNITION");
  s=step(s,now+120_000,101.42,{BCH_USDT:[first,fade]}).state;
  assert.equal(s.positions.length,0);assert.equal(s.regionLaunches!.BCH_USDT!.phase,"ARMED");
  assert.match(s.regionLaunches!.BCH_USDT!.reason,/失去异常强离区强度/);
});
