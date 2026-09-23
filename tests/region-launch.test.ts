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
const bar=(offset:number,o:number,h:number,l:number,c:number,volume=1000):RegionCandle=>({time:START+offset,open:o,high:h,low:l,close:c,volume});
const compression=[
  bar(300,100.68,100.94,100.48,100.78),
  bar(600,100.78,100.98,100.55,100.70),
  bar(900,100.70,100.96,100.52,100.84),
  bar(1200,100.84,101.00,100.58,100.73),
  bar(1500,100.73,100.97,100.57,100.86),
  bar(1800,100.86,101.01,100.60,100.79),
];
const q=(mid:number,at:number)=>({bestBid:mid-.005,bestAsk:mid+.005,observedAt:at,fresh:true,entryReady:true});
const armed=()=>advanceRegionLaunchUniverse({paths:{BCH_USDT:compression},lifecycles:{BCH_USDT:lifecycle()},prior:{},
  now:(START+2100)*1000,costRate:.0022}).states;

test("mature mother plus short boundary compression becomes ARMED without consuming AnchorFlow",()=>{
  const s=armed().BCH_USDT!;
  assert.equal(s.version,REGION_LAUNCH_VERSION);
  assert.equal(s.motherRegionId,mother.id);
  assert.equal(s.phase,"ARMED");
  assert.ok((s.compression?.bars??0)>=4);
  assert.equal(s.consumedAt,null);
});

test("a related later child region does not replace the long-lived mother memory",()=>{
  const first=armed();
  const child:RegionZone={...mother,id:"child",confirmedAt:(START+1800)*1000,startAt:(START+1200)*1000,endAt:(START+1800)*1000,bars:12,
    lower:100.45,upper:101.10,center:100.78,width:.65,widthRate:.00645,touchesUpper:3,touchesLower:3,crossings:3};
  const next=advanceRegionLaunchUniverse({paths:{BCH_USDT:compression},lifecycles:{BCH_USDT:lifecycle(child)},prior:first,
    now:(START+2400)*1000,costRate:.0022}).states.BCH_USDT!;
  assert.equal(next.motherRegionId,"mother");
});

test("BCH-like strong 1m breakout waits through a small pullback and becomes READY only on the first restart candle",()=>{
  let states=armed();
  const breakout=bar(2100,100.95,102.20,100.90,102.00,5000);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout]},now:(START+2160)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"IGNITION");

  const pull1=bar(2160,102.00,102.05,101.45,101.60,2200);
  const pull2=bar(2220,101.60,101.72,101.30,101.45,1700);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout,pull1,pull2]},now:(START+2280)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"IGNITION","small pullback is allowed regardless of candle count");

  const restart=bar(2280,101.45,102.10,101.42,101.98,2600);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout,pull1,pull2,restart]},now:(START+2340)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"READY");
  const ready=advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(101.99,(START+2341)*1000)},now:(START+2341)*1000,costRate:.0022});
  assert.equal(ready.signals.length,1);
  assert.equal(ready.signals[0]!.entryModel,"REGION_LAUNCH");
  assert.ok(ready.signals[0]!.stopPrice<ready.signals[0]!.signalPrice);
});

test("MET-like 1m breakout with obvious upper wick stays under observation and never becomes IGNITION",()=>{
  const states=advanceRegionLaunchMinutes({states:armed(),minutePaths:{BCH_USDT:[
    bar(2100,100.95,103.30,100.90,101.28,5000)
  ]},now:(START+2160)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"ARMED");
  assert.match(states.BCH_USDT?.reason??"",/突破K不够强/);
});

test("pullback is rejected once its cumulative opposite movement is no longer small relative to the breakout",()=>{
  let states=advanceRegionLaunchMinutes({states:armed(),minutePaths:{BCH_USDT:[
    bar(2100,100.95,102.20,100.90,102.00,5000)
  ]},now:(START+2160)*1000,costRate:.0022}).states;
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[
    bar(2100,100.95,102.20,100.90,102.00,5000),
    bar(2160,102.00,102.05,101.42,101.48,2000),
    bar(2220,101.48,101.50,100.86,100.92,2000),
  ]},now:(START+2280)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"ARMED");
  assert.ok((states.BCH_USDT?.failedDepartures??0)>=1);
  assert.match(states.BCH_USDT?.reason??"",/不再属于小回调|启动失败/);
});

test("late 1m history never creates a retroactive chase after the move already happened",()=>{
  const states=advanceRegionLaunchMinutes({states:armed(),minutePaths:{BCH_USDT:[
    bar(2100,100.95,102.20,100.90,102.00,5000)
  ]},now:(START+2400)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"ARMED");
  assert.match(states.BCH_USDT?.reason??"",/迟到/);
});

test("fast post-fill validation threshold stays small but stricter than ordinary noise",()=>{
  assert.equal(regionLaunchValidationProofRate(.0022),.0015);
  assert.equal(regionLaunchValidationProofRate(.004),.0024);
  assert.equal(regionLaunchValidationProofRate(.010),.0025);
});
