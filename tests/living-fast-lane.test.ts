/**
 * B2/B3 fast lane on the three recorded windows (fixture Gate 1m klines, 2s mids interpolated linearly inside each minute,
 * 6h warm-up). Timings are what the state machine produced on 2s data; with 1m-only data the spec estimated the alert ~1
 * minute later. Tolerance ±10s.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {runFast,fixtureBasket} from "./living/fast-sim.ts";
import {bj} from "./living/fixture.ts";
import {LivingTape} from "../lib/living/tape.ts";
import {initialFast,stepFast,fastFollowBlocked,bucketOf,fastMultiple,closeAt,type EpisodeRecord} from "../lib/living/fast-lane.ts";

const near=(at:number|undefined,want:string,tol=10_000)=>{assert.ok(at!=null,`missing event, wanted ${want}`);assert.ok(Math.abs(at-bj(want))<=tol,
  `${new Date(at+8*3600e3).toISOString().slice(5,19)} vs ${want}`);};

test("10-19 06:00 burst: alert within seconds, confirmed, ends as exhaustion (no fake)",()=>{
  const r=runFast({from:bj("10-19 05:50"),to:bj("10-19 06:30")});
  const ev=r.events.filter(e=>e.at<bj("10-19 06:25"));
  const alert=ev.find(e=>e.type==="ALERT"),confirm=ev.find(e=>e.type==="CONFIRM"),end=ev.find(e=>e.type==="EXHAUST"||e.type==="FAKE"||e.type==="TIMEOUT");
  near(alert?.at,"10-19 06:00:12");assert.equal(alert!.side,"LONG");
  near(confirm?.at,"10-19 06:00:22");assert.ok(confirm!.at-alert!.at<=120_000);
  assert.equal(end?.type,"EXHAUST");near(end?.at,"10-19 06:17:58",30_000);
  assert.ok(!ev.some(e=>e.type==="FAKE"&&e.at<bj("10-19 06:20")));
});
test("10-19 22:00 spike: alert, confirm, then a fake-out within 5 minutes",()=>{
  const r=runFast({from:bj("10-19 21:50"),to:bj("10-19 22:10")});
  const alert=r.events.find(e=>e.type==="ALERT"),confirm=r.events.find(e=>e.type==="CONFIRM"),fake=r.events.find(e=>e.type==="FAKE");
  near(alert?.at,"10-19 22:00:32");near(confirm?.at,"10-19 22:01:02");near(fake?.at,"10-19 22:04:30");
  assert.equal(fake!.episodeId,alert!.episodeId);assert.ok(fake!.at-alert!.at<=5*60_000);
});
test("10-18 21:29 drop: alert, confirm, rebound ends it as REVERSED (after the 5-minute fake window), opposite alert then fakes",()=>{
  const r=runFast({from:bj("10-18 21:15"),to:bj("10-18 21:45")});
  const alert=r.events.find(e=>e.type==="ALERT"),confirm=r.events.find(e=>e.type==="CONFIRM"),rev=r.events.find(e=>e.type==="REVERSED");
  near(alert?.at,"10-18 21:26:50");assert.equal(alert!.side,"SHORT");
  near(confirm?.at,"10-18 21:28:12");
  near(rev?.at,"10-18 21:36:32");assert.equal(rev!.episodeId,alert!.episodeId);
  const fake=r.events.find(e=>e.type==="FAKE"&&e.at>rev!.at);near(fake?.at,"10-18 21:40:02");
  // after the end, same-side follow is in cooldown
  assert.equal(fastFollowBlocked(r.state,"SHORT",rev!.at+60_000),true);
});
test("unhealthy data never alerts: fewer than 45 fresh basket coins",()=>{
  const at0=bj("10-19 06:00"),basket=fixtureBasket(at0),tape=new LivingTape();let s=initialFast();
  for(let t=at0-600_000;t<at0+120_000;t+=2_000){
    // only 30 coins quoted, all jumping together
    const k=t>=at0?1.01:1;tape.feed(basket.members.slice(0,30).map(m=>({symbol:m,mid:100*k,at:t-100})),t);
    const r=stepFast(s,tape,basket,t);s=r.state;assert.equal(r.events.length,0);
    if(t>=at0)assert.match(r.sample.reason??"",/新鲜报价币数/);
  }
});
test("B7 multiple: 1 until 8 confirmed records, 2 when positive and worst-3 ok, back down on a bad last 8",()=>{
  const rec=(v:number,i:number):EpisodeRecord=>({id:`e${i}`,side:"LONG",alertAt:i,alertKind:"z60",confirmAt:i,endAt:i,end:"EXHAUST",peakZ:4.2,extreme:.01,maxRetrace:.1,
    bucket:bucketOf(4.2),after:{},leaders:[],leadersAfter30:null,follow30Net:v,entries:0,protections:0});
  assert.equal(bucketOf(4.2),2);
  assert.equal(fastMultiple(Array.from({length:7},(_,i)=>rec(.004,i)),2),1);
  assert.equal(fastMultiple(Array.from({length:8},(_,i)=>rec(.004,i)),2),2);
  assert.equal(fastMultiple(Array.from({length:20},(_,i)=>rec(.004,i)),2),3);
  assert.equal(fastMultiple([...Array.from({length:20},(_,i)=>rec(.01,i)),...Array.from({length:8},(_,i)=>rec(-.004,20+i))],2),2);
  assert.equal(closeAt([{time:60,close:1},{time:120,close:2}],150_000,400_000),2);
});
