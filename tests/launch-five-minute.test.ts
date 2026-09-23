import test from "node:test";
import assert from "node:assert/strict";
import {launchFiveMinuteEvidence,evaluateSlowLaunchRestart} from "../lib/launch-five-minute.ts";
import type {MicroCandle,MicroSide} from "../lib/micro-restart.ts";
const T=Date.parse("2026-09-23T12:00:00Z")/1000;
const bar=(t:number,o:number,h:number,l:number,c:number):MicroCandle=>({time:T+t,open:o,high:h,low:l,close:c,volume:1});
const box={endAt:T*1000,lower:99,upper:100,center:99.5,width:1,averageRange:.2,averageBody:.1};
const flip=(b:MicroCandle):MicroCandle=>({...b,open:200-b.open,close:200-b.close,high:200-b.low,low:200-b.high});
for(const side of ["LONG","SHORT"] as MicroSide[]){
  const b=(...args:Parameters<typeof bar>)=>side==="LONG"?bar(...args):flip(bar(...args));
  const bounds=side==="LONG"?box:{...box,lower:100,upper:101,center:100.5};
  test(`${side}: unfinished 5m permits entry observation only after three average ranges of body`,()=>{
    const weak=launchFiveMinuteEvidence({box:bounds,minutes:[b(0,99.9,100.45,99.88,100.4)],now:(T+60)*1000,costRate:.0022});
    assert.equal(weak.state,"WAIT");
    const strong=launchFiveMinuteEvidence({box:bounds,minutes:[b(0,99.9,100.67,99.88,100.65)],now:(T+60)*1000,costRate:.0022});
    assert.equal(strong.state,"FAST");assert.equal(strong.side,side);assert.ok(strong.bodyMultiple!>=3);
  });
  test(`${side}: long rejection wick and price back inside never authorize departure`,()=>{
    const fake=b(0,99.9,101,99.85,99.96);
    assert.equal(launchFiveMinuteEvidence({box:bounds,minutes:[fake],now:(T+60)*1000,costRate:.0022}).state,"WAIT");
    assert.equal(launchFiveMinuteEvidence({box:bounds,minutes:[],fiveMinutes:[fake],now:(T+300)*1000,costRate:.0022}).state,"WAIT");
  });
  test(`${side}: slower departure waits for the actual 5m close`,()=>{
    const slow=b(0,99.9,100.32,99.88,100.3);
    assert.equal(launchFiveMinuteEvidence({box:bounds,minutes:[slow],now:(T+60)*1000,costRate:.0022}).state,"WAIT");
    assert.equal(launchFiveMinuteEvidence({box:bounds,minutes:[],fiveMinutes:[slow],now:(T+299)*1000,costRate:.0022}).state,"WAIT");
    assert.equal(launchFiveMinuteEvidence({box:bounds,minutes:[],fiveMinutes:[slow],now:(T+300)*1000,costRate:.0022}).state,"CLOSED");
  });
  test(`${side}: outside 5m close plus shallow pullback then full pullback break becomes ready`,()=>{
    const anchor=b(0,99.9,100.32,99.88,100.3),pull=b(300,100.3,100.31,100.22,100.24),resume=b(360,100.24,100.36,100.23,100.35);
    const assess=(following:MicroCandle[])=>evaluateSlowLaunchRestart({bar:anchor,following,side,boundary:side==="LONG"?100:100,costRate:.0022});
    assert.equal(assess([]).state,"WAIT");assert.equal(assess([pull]).state,"WAIT");
    assert.equal(assess([pull,resume]).state,"READY");
    assert.equal(assess([b(300,100.3,100.31,100.02,100.05)]).state,"FAIL");
    assert.equal(assess([b(300,100.3,100.32,100.28,100.31)]).state,"WAIT","slow continuation with no pullback is not enough");
  });
  test(`${side}: a later sudden acceleration switches the slow observation to fast`,()=>{
    const prior=b(0,99.9,100.32,99.88,100.3),fast=b(300,100.3,101.1,100.29,101.05);
    const r=launchFiveMinuteEvidence({box:bounds,minutes:[fast],fiveMinutes:[prior],now:(T+360)*1000,costRate:.0022});
    assert.equal(r.state,"FAST");assert.equal(r.bar!.time,T+300);
  });
}
test("missing the first minute cannot turn a mid-candle bounce into the 5m open",()=>{
  const r=launchFiveMinuteEvidence({box,minutes:[bar(60,99.9,100.67,99.88,100.65)],now:(T+120)*1000,costRate:.0022});
  assert.equal(r.state,"WAIT");
});
test("live return inside cancels an armed micro signal, and observed wicks survive quote refresh",()=>{
  const m=bar(0,99.9,100.67,99.88,100.65);
  const failed=launchFiveMinuteEvidence({box,minutes:[m],now:(T+61)*1000,costRate:.0022,livePrice:99.99,activeSide:"LONG",activeAt:(T+60)*1000});
  assert.equal(failed.state,"FAIL");
  const prior={...m,high:102};
  assert.equal(launchFiveMinuteEvidence({box,minutes:[m],now:(T+62)*1000,costRate:.0022,livePrice:100.65,previousCurrent:prior}).state,"WAIT");
});
test("slow restart must clear the whole pullback, not just the latest tiny candle",()=>{
  const anchor=bar(0,99.9,100.52,99.88,100.5);
  const a=bar(300,100.5,100.51,100.3,100.35),b=bar(360,100.35,100.38,100.30,100.34),fake=bar(420,100.34,100.46,100.33,100.45);
  assert.equal(evaluateSlowLaunchRestart({bar:anchor,following:[a,b,fake],side:"LONG",boundary:100,costRate:.0022}).state,"WAIT");
});
test("an unclosed/future 5m candle and a gapped micro pullback cannot create evidence",()=>{
  const a=bar(0,99.9,100.7,99.88,100.65);
  assert.equal(launchFiveMinuteEvidence({box,minutes:[],fiveMinutes:[a],now:(T+60)*1000,costRate:.0022}).state,"WAIT");
  const r=evaluateSlowLaunchRestart({bar:a,following:[bar(360,100.65,100.67,100.55,100.6)],side:"LONG",boundary:100,costRate:.0022});
  assert.equal(r.state,"WAIT");assert.match(r.reason,/连续/);
});
