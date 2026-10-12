import test from "node:test";
import assert from "node:assert/strict";
import {placeEntry} from "../lib/entry-place.ts";

const DAY=86_400;
const start=1_700_000_000;
function daily(highs:number[],lows:number[],closes:number[]){
  return highs.map((high,i)=>({time:start+i*DAY,open:closes[i]??high,high,low:lows[i]??high,close:closes[i]??high,volume:1}));
}
const now=(start+40*DAY)*1000+5_000;

test("a long fills in the upper middle and a short fills in the lower middle",()=>{
  const highs=Array(40).fill(110),lows=Array(40).fill(90),closes=Array(40).fill(100);
  highs[5]=120;lows[6]=80;
  const rows=daily(highs,lows,closes);
  assert.equal(placeEntry({side:"LONG",price:110,now,daily:rows,invalidation:100}).action,"ALLOW");
  assert.equal(placeEntry({side:"LONG",price:110,now,daily:rows,invalidation:100}).location.cycles[0]?.zone,"中间偏上");
  assert.equal(placeEntry({side:"SHORT",price:90,now,daily:rows,invalidation:100}).action,"ALLOW");
  assert.match(placeEntry({side:"LONG",price:90,now,daily:rows,invalidation:80}).reason,/中间偏上/);
  assert.match(placeEntry({side:"SHORT",price:110,now,daily:rows,invalidation:120}).reason,/中间偏下/);
});

test("the first touch of a prior high is not a long fill, and repeated touches are not either",()=>{
  const highs=Array(40).fill(110),lows=Array(40).fill(90),closes=Array(40).fill(100);
  highs[5]=120;lows[6]=80;
  const first=daily(highs,lows,closes);
  assert.match(placeEntry({side:"LONG",price:119.8,now,daily:first,invalidation:110}).reason,/第一次接近前高/);
  highs[20]=119.8;closes[20]=112;highs[25]=119.9;closes[25]=112;
  const again=daily(highs,lows,closes);
  assert.match(placeEntry({side:"LONG",price:119.8,now,daily:again,invalidation:110}).reason,/多次接近/);
});

test("a held break becomes a new long leg, and the same place is not a short",()=>{
  const highs=Array(40).fill(110),lows=Array(40).fill(90),closes=Array(40).fill(100);
  highs[5]=120;lows[6]=80;highs[30]=126;closes[30]=124;
  const rows=daily(highs,lows,closes);
  assert.equal(placeEntry({side:"LONG",price:123,now,daily:rows,invalidation:118}).action,"ALLOW");
  assert.match(placeEntry({side:"SHORT",price:123,now,daily:rows,invalidation:130}).reason,/不做空/);
});

test("a fill inside the last minute of noise waits instead of being cancelled by missing history",()=>{
  const highs=Array(40).fill(110),lows=Array(40).fill(90),closes=Array(40).fill(100);
  highs[5]=120;lows[6]=80;
  const rows=daily(highs,lows,closes);
  const minute=Array.from({length:8},(_,i)=>({time:Math.floor(now/1000)-120+i*60,open:110,high:110.8,low:109.2,close:110,volume:1}));
  assert.match(placeEntry({side:"LONG",price:110,now,daily:rows,minute,invalidation:109.9}).reason,/离失效位/);
  const few=Array.from({length:10},(_,i)=>({time:Math.floor(now/1000)-3_000+i*300,open:110,high:111,low:109,close:110,volume:1}));
  assert.equal(placeEntry({side:"LONG",price:110,now,fiveMinute:few,invalidation:100}).action,"ALLOW");
});
