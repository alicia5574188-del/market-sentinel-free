import test from "node:test";
import assert from "node:assert/strict";
import {REGION_LAUNCH_VERSION,advanceRegionLaunchMinutes,advanceRegionLaunchQuotes,advanceRegionLaunchUniverse,
  regionLaunchValidationProofRate} from "../lib/region-launch.ts";
import {REGION_LIFECYCLE_VERSION,type RegionCandle,type RegionLifecycleState,type RegionZone} from "../lib/region-lifecycle.ts";

const START=Date.parse("2026-09-23T00:00:00Z")/1000;
const bar=(offset:number,o:number,h:number,l:number,c:number):RegionCandle=>({time:START+offset,open:o,high:h,low:l,close:c,volume:1000});
const motherRows=Array.from({length:36},(_,i)=>{
  const offset=-10_800+i*300,open=100+(i%2?-.10:.10),close=100+(i%2?.10:-.10);
  const high=i===5?101.18:Math.max(open,close)+.08+(i%3)*.01;
  const low=i===12?98.82:Math.min(open,close)-.08-(i%4)*.008;
  return bar(offset,open,high,low,close);
});
const mother:RegionZone={id:"mother",symbol:"BCH_USDT",startAt:(START-10_500)*1000,endAt:START*1000,confirmedAt:START*1000,bars:36,
  lower:99,upper:101,center:100,width:2,widthRate:.02,touchesUpper:6,touchesLower:6,crossings:7};
const lifecycle=(zone=mother):RegionLifecycleState=>({version:REGION_LIFECYCLE_VERSION,symbol:"BCH_USDT",initializedAt:START*1000,
  observedAt:START*1000,lastProcessedAt:START*1000,zone,status:"IN_REGION",probeStartedAt:null,probeExtreme:null,
  acceptedAt:null,detachedAt:null,upperConsumedAt:null,lowerConsumedAt:null,reason:"fixture"});
const q=(mid:number,at:number)=>({bestBid:mid-.005,bestAsk:mid+.005,observedAt:at,fresh:true,entryReady:true});
const armed=()=>advanceRegionLaunchUniverse({paths:{BCH_USDT:motherRows},lifecycles:{BCH_USDT:lifecycle()},prior:{},
  now:(START+1)*1000,costRate:.0022}).states;

test("the executable burst box uses accepted-price region bounds and ignores isolated wick probes",()=>{
  const s=armed().BCH_USDT!;
  assert.equal(s.version,REGION_LAUNCH_VERSION);assert.equal(s.phase,"ARMED");
  assert.equal(s.motherRegionId,mother.id);assert.equal(s.compression?.bars,36);
  assert.equal(s.compression?.lower,mother.lower);assert.equal(s.compression?.upper,mother.upper);
  assert.equal(s.compression?.coreLower,mother.lower);assert.equal(s.compression?.coreUpper,mother.upper);
});

test("an inner move cannot launch while price has not left the accepted region",()=>{
  const states=armed(),inside=bar(0,100.7,100.98,100.65,100.95);
  const r=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[inside]},now:(START+60)*1000,costRate:.0022});
  assert.equal(r.states.BCH_USDT?.phase,"ARMED");
  assert.equal(advanceRegionLaunchQuotes({states:r.states,quotes:{BCH_USDT:q(101.08,(START+61)*1000)},now:(START+61)*1000,costRate:.0022}).signals.length,0);
});

test("a changed lifecycle zone replaces a persisted overlapping mother immediately",()=>{
  const old=armed().BCH_USDT!;
  const next:RegionZone={...mother,id:"mother-v2",lower:99.35,upper:100.85,center:100.1,width:1.5,widthRate:.014985,bars:48,confirmedAt:START*1000+300_000};
  const states=advanceRegionLaunchUniverse({paths:{BCH_USDT:motherRows},lifecycles:{BCH_USDT:lifecycle(next)},prior:{BCH_USDT:old},
    now:(START+301)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.motherRegionId,"mother-v2");
  assert.equal(states.BCH_USDT?.motherLower,99.35);assert.equal(states.BCH_USDT?.motherUpper,100.85);
  assert.equal(states.BCH_USDT?.compression?.lower,99.35);assert.equal(states.BCH_USDT?.compression?.upper,100.85);
});

test("unfinished 5m fast path requires a several-times-average full-box departure before 1m ignition",()=>{
  let states=armed();
  const breakout=bar(0,100.95,102.72,100.92,102.62);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout]},now:(START+60)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"IGNITION");
  assert.equal(states.BCH_USDT?.launchPath,"FAST");
  assert.ok((states.BCH_USDT?.fiveMinuteBodyMultiple??0)>=3);
});

test("a once-fast unfinished 5m move loses entry authority immediately when its body collapses",()=>{
  let states=armed();
  const first=bar(0,100.95,102.72,100.92,102.62);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[first]},now:(START+60)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"IGNITION");
  const fade=bar(60,103.20,103.22,101.35,101.42);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[first,fade]},now:(START+120)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"ARMED");
  assert.equal(states.BCH_USDT?.ignitionAt,null);
  assert.match(states.BCH_USDT?.reason??"",/失去异常强离区强度/);
});

test("strong 1m impulse plus genuinely small pullback and full restart becomes READY",()=>{
  let states=armed();
  const breakout=bar(0,100.95,102.72,100.92,102.62);
  const pullback=bar(60,102.62,102.63,102.28,102.32);
  const restart=bar(120,102.32,102.78,102.30,102.74);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout]},now:(START+60)*1000,costRate:.0022}).states;
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout,pullback]},now:(START+120)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"IGNITION",states.BCH_USDT?.reason);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout,pullback,restart]},now:(START+180)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"READY",states.BCH_USDT?.reason);
  const ready=advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(102.53,(START+181)*1000)},now:(START+181)*1000,costRate:.0022});
  assert.equal(ready.signals.length,1);assert.equal(ready.signals[0]!.entryModel,"REGION_LAUNCH");
});

test("deep or cumulative opposite pullback cancels the ignition but preserves the mature region",()=>{
  let states=armed();
  const breakout=bar(0,100.95,102.72,100.92,102.62),deep=bar(60,103.20,103.22,101.55,101.62);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout]},now:(START+60)*1000,costRate:.0022}).states;
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout,deep]},now:(START+120)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"ARMED");assert.equal(states.BCH_USDT?.motherRegionId,"mother");
  assert.ok((states.BCH_USDT?.failedDepartures??0)>=1);
});

test("a large wick with weak body never becomes ignition",()=>{
  const states=armed(),fake=bar(0,101.02,103.3,100.98,101.40);
  const r=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[fake]},now:(START+60)*1000,costRate:.0022});
  assert.equal(r.states.BCH_USDT?.phase,"ARMED");
  assert.equal(advanceRegionLaunchQuotes({states:r.states,quotes:{BCH_USDT:q(101.4,(START+61)*1000)},now:(START+61)*1000,costRate:.0022}).signals.length,0);
});

test("slow path waits for a long-body 5m close outside the entire region and then fresh 1m evidence",()=>{
  let states=armed();
  const closed=bar(0,101.00,102.10,100.98,102.02);
  states=advanceRegionLaunchMinutes({states,minutePaths:{},fiveMinutePaths:{BCH_USDT:[...motherRows,closed]},
    now:(START+300)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.launchPath,"CLOSED",states.BCH_USDT?.reason);assert.equal(states.BCH_USDT?.phase,"IGNITION",states.BCH_USDT?.reason);
  const continuation=bar(300,102.02,102.34,102.00,102.31);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[continuation]},fiveMinutePaths:{BCH_USDT:[...motherRows,closed]},
    now:(START+360)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"READY",states.BCH_USDT?.reason);
});

test("missing or late 1m data never creates a retroactive chase",()=>{
  let states=armed();
  const late=bar(0,100.95,102.72,100.92,102.62);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[late]},now:(START+240)*1000,costRate:.0022}).states;
  assert.notEqual(states.BCH_USDT?.phase,"READY");
  assert.equal(advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(102.35,(START+241)*1000)},now:(START+241)*1000,costRate:.0022}).signals.length,0);
});

test("post-entry burst validation must clear modeled round-trip cost rather than ordinary noise",()=>{
  assert.ok(Math.abs(regionLaunchValidationProofRate(.0022)-.00275)<1e-12);
  assert.equal(regionLaunchValidationProofRate(.004),.005);
  assert.equal(regionLaunchValidationProofRate(.010),.006);
});

test("an inside-closing new wick extends the same full box while the first outside close freezes it",()=>{
  let states=armed();const old=states.BCH_USDT!.compression!;
  const inside=bar(0,100.1,101.12,98.70,100.2);
  states=advanceRegionLaunchUniverse({paths:{BCH_USDT:[...motherRows,inside]},lifecycles:{BCH_USDT:lifecycle()},prior:states,
    now:(START+300)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT!.compression!.lower,98.70);
  const frozenUpper=states.BCH_USDT!.compression!.upper,frozenLower=states.BCH_USDT!.compression!.lower;
  const outside=bar(300,100.2,103.2,100.15,102.9);
  states=advanceRegionLaunchUniverse({paths:{BCH_USDT:[...motherRows,inside,outside]},lifecycles:{BCH_USDT:lifecycle()},prior:states,
    now:(START+600)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT!.compression!.lower,frozenLower);
  assert.equal(states.BCH_USDT!.compression!.upper,frozenUpper);
  assert.notEqual(old.lower,98.70);
});

test("a restored READY without current minute evidence is demoted and cannot emit an order",()=>{
  let states=armed();
  Object.assign(states.BCH_USDT!,{phase:"READY",readyAt:(START+1)*1000,readySide:"LONG",readySignalPrice:102,
    readyStopPrice:100.5,readyImpulseRate:.01,readyExpectedMoveRate:.03,readyMaxChaseRate:.01,readyConfirmationMs:60_000});
  states=advanceRegionLaunchMinutes({states,minutePaths:{},now:(START+2)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT!.phase,"IGNITION");
  assert.equal(advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(102,(START+2)*1000)},now:(START+2)*1000,costRate:.0022}).signals.length,0);
});
