import test from "node:test";
import assert from "node:assert/strict";
import {REGION_LAUNCH_VERSION,advanceRegionLaunchMinutes,advanceRegionLaunchQuotes,advanceRegionLaunchUniverse,
  consumeRegionLaunch,rearmRegionLaunchAfterExit,regionLaunchValidationProofRate} from "../lib/region-launch.ts";
import {REGION_LIFECYCLE_VERSION,type RegionCandle,type RegionLifecycleState,type RegionZone} from "../lib/region-lifecycle.ts";

const START=Date.parse("2026-09-23T00:00:00Z")/1000;
const bar=(offset:number,o:number,h:number,l:number,c:number):RegionCandle=>({time:START+offset,open:o,high:h,low:l,close:c,volume:1000});
const motherRows=Array.from({length:36},(_,i)=>{
  const offset=-10_800+i*300,open=100+(i%2?-.10:.10),close=100+(i%2?.10:-.10);
  return bar(offset,open,Math.max(open,close)+.10+(i%3)*.01,Math.min(open,close)-.10-(i%4)*.008,close);
});
const barrierRows=motherRows.map((row,i)=>i===7?{...row,high:102.05}:i===18?{...row,high:102.08}:row);
const mother:RegionZone={id:"mother",symbol:"BCH_USDT",startAt:(START-10_500)*1000,endAt:START*1000,confirmedAt:START*1000,bars:36,
  lower:99,upper:101,center:100,width:2,widthRate:.02,touchesUpper:6,touchesLower:6,crossings:7};
const lifecycle=(zone=mother):RegionLifecycleState=>({version:REGION_LIFECYCLE_VERSION,symbol:"BCH_USDT",initializedAt:START*1000,
  observedAt:START*1000,lastProcessedAt:START*1000,zone,status:"IN_REGION",probeStartedAt:null,probeExtreme:null,
  acceptedAt:null,detachedAt:null,upperConsumedAt:null,lowerConsumedAt:null,reason:"fixture"});
const q=(mid:number,at:number)=>({bestBid:mid-.005,bestAsk:mid+.005,observedAt:at,fresh:true,entryReady:true});
const armed=(rows=motherRows)=>advanceRegionLaunchUniverse({paths:{BCH_USDT:rows},lifecycles:{BCH_USDT:lifecycle()},prior:{},
  now:(START+1)*1000,costRate:.0022}).states;

test("v4 keeps accepted-price region bounds and opens three price-behavior modes",()=>{
  const s=armed().BCH_USDT!;
  assert.equal(s.version,REGION_LAUNCH_VERSION);assert.equal(REGION_LAUNCH_VERSION,"region-launch-v4");
  assert.equal(s.phase,"ARMED");assert.equal(s.compression?.lower,99);assert.equal(s.compression?.upper,101);
  assert.equal(s.effectiveLongTrigger,101);assert.equal(s.effectiveShortTrigger,99);
});

test("repeated prior rejection highs become a front barrier instead of an immediate region breakout trigger",()=>{
  const s=armed(barrierRows).BCH_USDT!;
  assert.ok(s.longBarrier);assert.ok(s.effectiveLongTrigger>101.9,s.reason);
  assert.ok((s.longBarrier?.touches??0)>=2);
  const regionOnly=bar(0,100.9,101.65,100.88,101.55);
  const r=advanceRegionLaunchMinutes({states:{BCH_USDT:s},minutePaths:{BCH_USDT:[regionOnly]},now:(START+60)*1000,costRate:.0022});
  assert.equal(r.states.BCH_USDT?.phase,"ARMED","price above the region but below the front barrier must not release");
});

test("lower-edge rejection can create a ROTATION trade toward the region center",()=>{
  let states=armed();
  const probe=bar(0,99.18,99.24,98.95,99.05),reclaim=bar(60,99.04,99.24,99.02,99.20);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[probe,reclaim]},now:(START+120)*1000,costRate:.0022}).states;
  const s=states.BCH_USDT!;
  assert.equal(s.phase,"READY",s.reason);assert.equal(s.readyMode,"ROTATION");assert.equal(s.readySide,"LONG");
  const ready=advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(99.21,(START+121)*1000)},now:(START+121)*1000,costRate:.0022});
  assert.equal(ready.signals.length,1);assert.equal(ready.signals[0]!.entryMode,"ROTATION");assert.equal(ready.signals[0]!.targetPrice,100);
});

test("a clean market with no front barrier can RELEASE on the first strong 1m/unfinished-5m move",()=>{
  let states=armed();
  const breakout=bar(0,100.80,101.36,100.78,101.32);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout]},now:(START+60)*1000,costRate:.0022}).states;
  const s=states.BCH_USDT!;
  assert.equal(s.phase,"READY",s.reason);assert.equal(s.readyMode,"RELEASE");assert.equal(s.launchPath,"EARLY");
  const ready=advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(101.34,(START+61)*1000)},now:(START+61)*1000,costRate:.0022});
  assert.equal(ready.signals.length,1);assert.equal(ready.signals[0]!.entryMode,"RELEASE");
});

test("late price is measured from the effective trigger and becomes RETEST instead of a late fill",()=>{
  let states=armed();
  const breakout=bar(0,100.80,101.36,100.78,101.32);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout]},now:(START+60)*1000,costRate:.0022}).states;
  const late=advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(102.0,(START+61)*1000)},now:(START+61)*1000,costRate:.0022});
  assert.equal(late.signals.length,0);assert.equal(late.states.BCH_USDT?.phase,"RETEST");
  assert.match(late.states.BCH_USDT?.reason??"",/超过最佳参与区/);
});

test("a first pullback that holds the effective trigger can create the second RETEST participation",()=>{
  let states=armed();
  const breakout=bar(0,100.80,101.36,100.78,101.32);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout]},now:(START+60)*1000,costRate:.0022}).states;
  states=advanceRegionLaunchQuotes({states,quotes:{BCH_USDT:q(102.0,(START+61)*1000)},now:(START+61)*1000,costRate:.0022}).states;
  const pullback=bar(60,101.34,101.38,101.04,101.10),restart=bar(120,101.10,101.46,101.08,101.42);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout,pullback,restart]},now:(START+180)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.phase,"READY",states.BCH_USDT?.reason);assert.equal(states.BCH_USDT?.readyMode,"RETEST");
});

test("a losing first RELEASE rearms RETEST immediately without a fixed five-minute cooldown",()=>{
  let states=armed();
  const breakout=bar(0,100.80,101.36,100.78,101.32);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout]},now:(START+60)*1000,costRate:.0022}).states;
  const opened=consumeRegionLaunch(states.BCH_USDT!,"LONG",(START+61)*1000,"RELEASE");
  assert.equal(opened.releaseAttemptsLong,1);
  const rearmed=rearmRegionLaunchAfterExit(opened,{mode:"RELEASE",side:"LONG",at:(START+121)*1000,netPnl:-1,structuralFailure:false});
  assert.equal(rearmed.phase,"RETEST");assert.equal(rearmed.cooldownUntil,0);
});

test("two failed release participations exhaust only that release episode, not the mother region",()=>{
  let states=armed();
  const breakout=bar(0,100.80,101.36,100.78,101.32);
  states=advanceRegionLaunchMinutes({states,minutePaths:{BCH_USDT:[breakout]},now:(START+60)*1000,costRate:.0022}).states;
  let s=consumeRegionLaunch(states.BCH_USDT!,"LONG",(START+61)*1000,"RELEASE");
  s=rearmRegionLaunchAfterExit(s,{mode:"RELEASE",side:"LONG",at:(START+121)*1000,netPnl:-1,structuralFailure:false});
  s.readyEffectiveTrigger=s.releaseTrigger;s.readySignalPrice=101.15;
  s=consumeRegionLaunch(s,"LONG",(START+181)*1000,"RETEST");
  const ended=rearmRegionLaunchAfterExit(s,{mode:"RETEST",side:"LONG",at:(START+241)*1000,netPnl:-1,structuralFailure:false});
  assert.equal(ended.releaseAttemptsLong,2);assert.notEqual(ended.phase,"RETEST");assert.equal(ended.motherRegionId,"mother");
});

test("a changed lifecycle zone replaces the persisted opportunity episode",()=>{
  const old=armed().BCH_USDT!;
  const next:RegionZone={...mother,id:"mother-v2",lower:99.35,upper:100.85,center:100.1,width:1.5,widthRate:.014985,bars:48,confirmedAt:START*1000+300_000};
  const states=advanceRegionLaunchUniverse({paths:{BCH_USDT:motherRows},lifecycles:{BCH_USDT:lifecycle(next)},prior:{BCH_USDT:old},
    now:(START+301)*1000,costRate:.0022}).states;
  assert.equal(states.BCH_USDT?.motherRegionId,"mother-v2");assert.equal(states.BCH_USDT?.motherLower,99.35);assert.equal(states.BCH_USDT?.motherUpper,100.85);
});

test("60-second proof threshold remains available as a diagnostic, not an automatic exit command",()=>{
  assert.ok(Math.abs(regionLaunchValidationProofRate(.0022)-.00275)<1e-12);
  assert.equal(regionLaunchValidationProofRate(.004),.005);assert.equal(regionLaunchValidationProofRate(.010),.006);
});
