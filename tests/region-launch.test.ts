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
  bar(300,100.78,100.90,100.68,100.82),bar(600,100.82,100.94,100.70,100.76),
  bar(900,100.76,100.95,100.72,100.84),bar(1200,100.84,100.96,100.73,100.77),
  bar(1500,100.77,100.97,100.73,100.86),bar(1800,100.86,100.98,100.74,100.79),
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
  assert.equal(r.states.BCH_USDT?.phase,"ARMED");assert.equal(advanceRegionLaunchQuotes({states:r.states,quotes:{},now:(START+2400)*1000,costRate:.0022}).signals.length,0);
});

test("BCH-like strong 1m breakout, small pullback and first real restart becomes READY",()=>{
  let states=armed();
  const breakout=bar(2100,100.90,102.30,100.85,102.00);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout]},now:(START+2160)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"IGNITION");
  const pullback=bar(2160,102.00,102.05,101.65,101.75);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout,pullback]},now:(START+2220)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"IGNITION");assert.match(states.BCH_USDT?.reason??"",/小回调|重新顺向|5分钟/);
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
  assert.equal(r.states.BCH_USDT?.phase,"ARMED");assert.match(r.states.BCH_USDT?.reason??"",/5分钟|突破K不够强/);
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

test("full compression includes the earlier rejection wick and never shrinks it away as the window rolls",()=>{
  const withWick=compression.map((r,i)=>i===0?{...r,low:100.1}:r);
  let states=advanceRegionLaunchUniverse({paths:{BCH_USDT:withWick},lifecycles:{BCH_USDT:lifecycle()},now:(START+2100)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT!.compression!.lower,100.1);
  const old=states.BCH_USDT!.compression!.id;
  const later=Array.from({length:12},(_,i)=>bar(2100+i*300,100.8,100.94,100.70,i%2?100.77:100.83));
  states=advanceRegionLaunchUniverse({paths:{BCH_USDT:[...withWick,...later]},lifecycles:{BCH_USDT:lifecycle()},prior:states,
    now:(START+5700)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT!.compression!.lower,100.1);assert.equal(states.BCH_USDT!.compression!.id,old);
  const inner=bar(5700,100.82,100.84,100.3,100.35);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[inner]},now:(START+5760)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT!.phase,"ARMED","a sharp local move above the earlier low is not a SHORT breakout");
});

test("new rejection wick extends the same box while an outside closing breakout cannot stretch it",()=>{
  let states=armed();const old=states.BCH_USDT!.compression!;
  const wick=bar(2100,100.79,101.1,100.3,100.8);
  states=advanceRegionLaunchUniverse({paths:{BCH_USDT:[...compression,wick]},lifecycles:{BCH_USDT:lifecycle()},prior:states,
    now:(START+2400)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT!.compression!.lower,100.3);assert.equal(states.BCH_USDT!.compression!.id,old.id);
  const breakout=bar(2400,100.8,103,100.79,102.9);
  states=advanceRegionLaunchUniverse({paths:{BCH_USDT:[...compression,wick,breakout]},lifecycles:{BCH_USDT:lifecycle()},prior:states,
    now:(START+2700)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT!.compression!.upper,101.1);
});

test("pending READY is revoked if the current 5m quote has returned inside before execution",()=>{
  let states=armed();
  const rows=[bar(2100,100.90,102.30,100.85,102),bar(2160,102,102.05,101.65,101.75),bar(2220,101.75,102.15,101.72,102.10)];
  for(let i=1;i<=3;i++)states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:rows.slice(0,i)},now:(START+2100+i*60)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT!.phase,"READY");
  const now=(START+2281)*1000;
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:rows},quotes:{BCH_USDT:q(100.8,now)},now,costRate:.0022}).states;
  assert.equal(states.BCH_USDT!.phase,"ARMED");
  assert.equal(advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(100.8,now)},now,costRate:.0022}).signals.length,0);
});

test("v2 pending permissions are rebuilt without consuming or forgetting the mother; consumed state stays consumed",()=>{
  const states=armed(),old=states.BCH_USDT!;
  Object.assign(old,{version:"region-launch-v2",phase:"READY",failedDepartures:3});
  assert.equal(advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(102,(START+2101)*1000)},now:(START+2101)*1000,costRate:.0022}).signals.length,0);
  const upgraded=advanceRegionLaunchUniverse({paths:{BCH_USDT:compression},lifecycles:{BCH_USDT:lifecycle()},prior:states,
    now:(START+2101)*1000,costRate:.0022}).states.BCH_USDT!;
  assert.equal(upgraded.version,REGION_LAUNCH_VERSION);assert.equal(upgraded.phase,"ARMED");assert.equal(upgraded.failedDepartures,3);
  Object.assign(old,{version:"region-launch-v2",phase:"CONSUMED",consumedSide:"LONG",consumedAt:(START+2100)*1000});
  const consumed=advanceRegionLaunchUniverse({paths:{BCH_USDT:compression},lifecycles:{BCH_USDT:lifecycle()},prior:states,
    now:(START+2101)*1000,costRate:.0022}).states.BCH_USDT!;
  assert.equal(consumed.phase,"CONSUMED");assert.equal(consumed.consumedAt,(START+2100)*1000);
});
