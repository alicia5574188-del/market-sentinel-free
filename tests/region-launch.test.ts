import test from "node:test";
import assert from "node:assert/strict";
import {REGION_LAUNCH_VERSION,advanceRegionLaunchQuotes,advanceRegionLaunchUniverse,regionLaunchValidationProofRate} from "../lib/region-launch.ts";
import {REGION_LIFECYCLE_VERSION,type RegionCandle,type RegionLifecycleState,type RegionZone} from "../lib/region-lifecycle.ts";

const START=Date.parse("2026-09-23T00:00:00Z")/1000;
const mother:RegionZone={id:"mother",symbol:"BCH_USDT",startAt:(START-7200)*1000,endAt:START*1000,confirmedAt:START*1000,bars:36,
  lower:99,upper:101,center:100,width:2,widthRate:.02,touchesUpper:6,touchesLower:6,crossings:7};
const lifecycle=(zone=mother):RegionLifecycleState=>({version:REGION_LIFECYCLE_VERSION,symbol:"BCH_USDT",initializedAt:START*1000,
  observedAt:(START+1800)*1000,lastProcessedAt:(START+1800)*1000,zone,status:"IN_REGION",probeStartedAt:null,probeExtreme:null,
  acceptedAt:null,detachedAt:null,upperConsumedAt:null,lowerConsumedAt:null,reason:"fixture"});
const bar=(offset:number,o:number,h:number,l:number,c:number):RegionCandle=>({time:START+offset,open:o,high:h,low:l,close:c,volume:1000});
const compression=[
  bar(300,100.68,100.94,100.48,100.78),
  bar(600,100.78,100.98,100.55,100.70),
  bar(900,100.70,100.96,100.52,100.84),
  bar(1200,100.84,101.00,100.58,100.73),
  bar(1500,100.73,100.97,100.57,100.86),
  bar(1800,100.86,101.01,100.60,100.79),
];
const q=(mid:number,at:number)=>({bestBid:mid-.005,bestAsk:mid+.005,observedAt:at,fresh:true,entryReady:true});

test("mature mother plus short boundary compression becomes ARMED without consuming AnchorFlow",()=>{
  const r=advanceRegionLaunchUniverse({paths:{BCH_USDT:compression},lifecycles:{BCH_USDT:lifecycle()},prior:{},
    now:(START+2100)*1000,costRate:.0022});
  const s=r.states.BCH_USDT!;
  assert.equal(s.version,REGION_LAUNCH_VERSION);
  assert.equal(s.motherRegionId,mother.id);
  assert.equal(s.phase,"ARMED");
  assert.ok((s.compression?.bars??0)>=4);
  assert.equal(s.consumedAt,null);
});

test("a related later child region does not replace the long-lived mother memory",()=>{
  const first=advanceRegionLaunchUniverse({paths:{BCH_USDT:compression},lifecycles:{BCH_USDT:lifecycle()},prior:{},
    now:(START+2100)*1000,costRate:.0022}).states;
  const child:RegionZone={...mother,id:"child",confirmedAt:(START+1800)*1000,startAt:(START+1200)*1000,endAt:(START+1800)*1000,bars:12,
    lower:100.45,upper:101.10,center:100.78,width:.65,widthRate:.00645,touchesUpper:3,touchesLower:3,crossings:3};
  const next=advanceRegionLaunchUniverse({paths:{BCH_USDT:compression},lifecycles:{BCH_USDT:lifecycle(child)},prior:first,
    now:(START+2400)*1000,costRate:.0022}).states.BCH_USDT!;
  assert.equal(next.motherRegionId,"mother");
});

test("RegionLaunch refuses post-hoc chase unless it observed the executable book before breakout",()=>{
  const states=advanceRegionLaunchUniverse({paths:{BCH_USDT:compression},lifecycles:{BCH_USDT:lifecycle()},prior:{},
    now:(START+2100)*1000,costRate:.0022}).states;
  const alreadyGone=advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(101.60,(START+2110)*1000)},now:(START+2110)*1000,costRate:.0022});
  assert.equal(alreadyGone.states.BCH_USDT?.phase,"ARMED");
  assert.equal(alreadyGone.states.BCH_USDT?.armedInsideObserved,false);
  assert.equal(alreadyGone.signals.length,0);
});

test("pre-armed book plus 20-60 second shallow-pullback impulse becomes READY",()=>{
  let states=advanceRegionLaunchUniverse({paths:{BCH_USDT:compression},lifecycles:{BCH_USDT:lifecycle()},prior:{},
    now:(START+2100)*1000,costRate:.0022}).states;
  states=advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(100.95,(START+2101)*1000)},now:(START+2101)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.armedInsideObserved,true);
  states=advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(101.40,(START+2110)*1000)},now:(START+2110)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"IGNITION");
  states=advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(101.55,(START+2125)*1000)},now:(START+2125)*1000,costRate:.0022}).states;
  const ready=advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(101.66,(START+2140)*1000)},now:(START+2140)*1000,costRate:.0022});
  assert.equal(ready.states.BCH_USDT?.phase,"READY");
  assert.equal(ready.signals.length,1);
  assert.equal(ready.signals[0]!.entryModel,"REGION_LAUNCH");
  assert.ok(ready.signals[0]!.launchImpulseRate>=.003);
  assert.ok(ready.signals[0]!.stopPrice<ready.signals[0]!.signalPrice);
});

test("an ignition that falls back through the trigger is remembered as a failed departure, not a dead mother",()=>{
  let states=advanceRegionLaunchUniverse({paths:{BCH_USDT:compression},lifecycles:{BCH_USDT:lifecycle()},prior:{},
    now:(START+2100)*1000,costRate:.0022}).states;
  states=advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(100.95,(START+2101)*1000)},now:(START+2101)*1000,costRate:.0022}).states;
  states=advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(101.40,(START+2110)*1000)},now:(START+2110)*1000,costRate:.0022}).states;
  const failed=advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(100.99,(START+2125)*1000)},now:(START+2125)*1000,costRate:.0022}).states.BCH_USDT!;
  assert.equal(failed.phase,"ARMED");
  assert.equal(failed.motherRegionId,"mother");
  assert.ok(failed.failedDepartures>=1);
});

test("fast validation threshold stays small but stricter than ordinary noise",()=>{
  assert.equal(regionLaunchValidationProofRate(.0022),.0015);
  assert.equal(regionLaunchValidationProofRate(.004),.0024);
  assert.equal(regionLaunchValidationProofRate(.010),.0025);
});
