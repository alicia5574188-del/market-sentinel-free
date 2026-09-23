import test from "node:test";
import assert from "node:assert/strict";
import {REGION_LAUNCH_VERSION,advanceRegionLaunchMinutes,advanceRegionLaunchQuotes,advanceRegionLaunchUniverse,
  regionLaunchValidationProofRate} from "../lib/region-launch.ts";
import {REGION_LIFECYCLE_VERSION,type RegionCandle,type RegionLifecycleState,type RegionZone} from "../lib/region-lifecycle.ts";

const START=Date.parse("2026-09-23T00:00:00Z")/1000;
const mother:RegionZone={id:"mother",symbol:"BCH_USDT",startAt:(START-7200)*1000,endAt:START*1000,confirmedAt:START*1000,bars:36,
  lower:99,upper:101,center:100,width:2,widthRate:.02,touchesUpper:6,touchesLower:6,crossings:7};
const lifecycle=(zone=mother):RegionLifecycleState=>({version:REGION_LIFECYCLE_VERSION,symbol:"BCH_USDT",initializedAt:START*1000,
  observedAt:(START+1800)*1000,lastProcessedAt:(START+1800)*1000,zone,status:"IN_REGION",probeStartedAt:null,probeExtreme:null,
  acceptedAt:null,detachedAt:null,upperConsumedAt:null,lowerConsumedAt:null,reason:"fixture"});
const bar=(offset:number,o:number,h:number,l:number,c:number):RegionCandle=>({time:START+offset,open:o,high:h,low:l,close:c,volume:1000});
const compression=[
  bar(300,100.68,100.94,100.48,100.78),bar(600,100.78,100.98,100.55,100.70),
  bar(900,100.70,100.96,100.52,100.84),bar(1200,100.84,101.00,100.58,100.73),
  bar(1500,100.73,100.97,100.57,100.86),bar(1800,100.86,101.01,100.60,100.79),
];
const q=(mid:number,at:number)=>({bestBid:mid-.005,bestAsk:mid+.005,observedAt:at,fresh:true,entryReady:true});
const armed=()=>advanceRegionLaunchUniverse({paths:{BCH_USDT:compression},lifecycles:{BCH_USDT:lifecycle()},prior:{},
  now:(START+2100)*1000,costRate:.0022}).states;

test("a 5m breakout cannot erase an already armed compression before the 1m lane evaluates it",()=>{
  const prior=armed(),box=prior.BCH_USDT!.compression!.id;
  const rows=[...compression,bar(2100,100.79,103,100.7,102.8)];
  const next=advanceRegionLaunchUniverse({paths:{BCH_USDT:rows},lifecycles:{BCH_USDT:lifecycle()},prior,
    now:(START+2400)*1000,costRate:.0022}).states;
  assert.equal(next.BCH_USDT!.phase,"ARMED");assert.equal(next.BCH_USDT!.compression!.id,box);
});

test("mature mother plus short boundary compression becomes ARMED without consuming AnchorFlow",()=>{
  const s=armed().BCH_USDT!;
  assert.equal(s.version,REGION_LAUNCH_VERSION);assert.equal(s.motherRegionId,mother.id);assert.equal(s.phase,"ARMED");
  assert.ok((s.compression?.bars??0)>=4);assert.equal(s.consumedAt,null);
});

test("a related later child region does not replace the long-lived mother memory",()=>{
  const first=armed();
  const child:RegionZone={...mother,id:"child",confirmedAt:(START+1800)*1000,startAt:(START+1200)*1000,endAt:(START+1800)*1000,bars:12,
    lower:100.45,upper:101.10,center:100.78,width:.65,widthRate:.00645,touchesUpper:3,touchesLower:3,crossings:3};
  const next=advanceRegionLaunchUniverse({paths:{BCH_USDT:compression},lifecycles:{BCH_USDT:lifecycle(child)},prior:first,
    now:(START+2400)*1000,costRate:.0022}).states.BCH_USDT!;
  assert.equal(next.motherRegionId,"mother");
});

test("late one-minute history can restore observation but can never create a post-hoc chase",()=>{
  const states=armed();
  const late=bar(2100,100.90,102.30,100.85,102.00);
  const r=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[late]},now:(START+2400)*1000,costRate:.0022});
  assert.equal(r.states.BCH_USDT?.phase,"ARMED");assert.match(r.states.BCH_USDT?.reason??"",/不历史补追/);
});

test("BCH-like strong 1m breakout, small pullback and first real restart becomes READY",()=>{
  let states=armed();
  const breakout=bar(2100,100.90,102.30,100.85,102.00);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout]},now:(START+2160)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"IGNITION");
  const pullback=bar(2160,102.00,102.05,101.65,101.75);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout,pullback]},now:(START+2220)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"IGNITION");assert.match(states.BCH_USDT?.reason??"",/小回调|重新顺向/);
  const restart=bar(2220,101.75,102.15,101.72,102.10);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout,pullback,restart]},now:(START+2280)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"READY");
  const ready=advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(102.11,(START+2281)*1000)},now:(START+2281)*1000,costRate:.0022});
  assert.equal(ready.signals.length,1);assert.equal(ready.signals[0]!.entryModel,"REGION_LAUNCH");
  assert.ok(ready.signals[0]!.stopPrice<ready.signals[0]!.signalPrice);
});

test("MET-like one-minute breakout with a large upper wick never reaches IGNITION",()=>{
  const states=armed(),fake=bar(2100,100.90,103.30,100.85,101.45);
  const r=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[fake]},now:(START+2160)*1000,costRate:.0022});
  assert.equal(r.states.BCH_USDT?.phase,"ARMED");assert.match(r.states.BCH_USDT?.reason??"",/突破K不够强/);
});

test("too much combined pullback invalidates the launch but keeps the mother under observation",()=>{
  let states=armed();const breakout=bar(2100,100.90,102.30,100.85,102.00);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout]},now:(START+2160)*1000,costRate:.0022}).states;
  const deep1=bar(2160,102.00,102.05,101.50,101.55),deep2=bar(2220,101.55,101.60,100.95,101.05);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout,deep1,deep2]},now:(START+2280)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"ARMED");assert.equal(states.BCH_USDT?.motherRegionId,"mother");
  assert.ok((states.BCH_USDT?.failedDepartures??0)>=1);
});

test("missing one-minute data simply preserves observation and creates no executable event",()=>{
  const states=armed();
  const minutes=advanceRegionLaunchMinutes({states,minutePaths:{},now:(START+2160)*1000,costRate:.0022});
  const quotes=advanceRegionLaunchQuotes({states:minutes.states,quotes:{BCH_USDT:q(101,(START+2161)*1000)},now:(START+2161)*1000,costRate:.0022});
  assert.equal(quotes.states.BCH_USDT?.phase,"ARMED");assert.equal(quotes.signals.length,0);
});

test("fast post-entry validation threshold remains above ordinary noise",()=>{
  assert.equal(regionLaunchValidationProofRate(.0022),.0015);assert.equal(regionLaunchValidationProofRate(.004),.0024);
  assert.equal(regionLaunchValidationProofRate(.010),.0025);
});
