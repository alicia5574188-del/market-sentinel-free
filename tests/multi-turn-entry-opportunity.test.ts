import test from "node:test";
import assert from "node:assert/strict";
import {evaluateMultiTurnEntryOpportunities,entryOpportunityCandidate,SHORT_ENTRY_TIMEFRAMES} from "../lib/multi-turn-entry-opportunity.ts";
import {initialMultiTurn,type TurnCandle} from "../lib/multi-turn-engine.ts";

const START=Date.parse("2026-09-01T00:00:00Z")/1000;
const candle=(i:number,open:number,close:number,high=Math.max(open,close)*1.0007,low=Math.min(open,close)*.9993):TurnCandle=>({
  time:START+i*300,open,high,low,close,volume:1000+i,
});

const longWindingPath=(targetCenter=103.5,current=101.0)=>{
  const rows:TurnCandle[]=[];let prev=targetCenter;
  for(let i=0;i<44;i++){
    const close=targetCenter*(1+.0013*Math.sin(i*1.17));
    rows.push(candle(i,prev,close));prev=close;
  }
  for(let j=0;j<16;j++){
    const i=rows.length,close=targetCenter+(100.20-targetCenter)*(j+1)/16;
    rows.push(candle(i,prev,close));prev=close;
  }
  for(const close of[100.08,99.96,100.05,99.98,100.04,99.97]){
    const i=rows.length;rows.push(candle(i,prev,close,Math.max(prev,close)*1.00055,Math.min(prev,close)*.99945));prev=close;
  }
  for(const close of[100.35,100.68,current]){
    const i=rows.length;rows.push(candle(i,prev,close,Math.max(prev,close)*1.0007,Math.min(prev,close)*.9994));prev=close;
  }
  return rows;
};

test("recent winding center becomes anchor1 and departure direction becomes the trade direction",()=>{
  const p=longWindingPath(),now=(p.at(-1)!.time+300)*1000+1000;
  const rows=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:p},turnEngine:initialMultiTurn(),now,costRate:.0022});
  const row=rows.find(x=>x.symbol==="BTC_USDT"&&x.timeframe==="5m");
  assert.ok(row);assert.equal(row!.side,"LONG");
  assert.ok(row!.anchorPrice>99.8&&row!.anchorPrice<100.2);
  assert.ok((row!.windingBandRate??1)<.01);
  assert.ok((row!.breakoutBars??99)<=5);
  assert.ok(row!.targetPrice);
});

test("entry is allowed when the forward level is farther than the current price is from anchor1",()=>{
  const p=longWindingPath(103.5,101.0),now=(p.at(-1)!.time+300)*1000+1000;
  const row=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:p},now,costRate:.0022})
    .find(x=>x.symbol==="BTC_USDT"&&x.timeframe==="5m");
  assert.ok(row);assert.equal(row!.eligible,true);
  assert.ok((row!.targetDistanceRate??0)>row!.distanceFromAnchorRate);
  assert.ok(row!.edgeRatio>1);
  assert.equal(row!.maxEntryDistanceRate,row!.targetDistanceRate);
});

test("distance from anchor1 is no longer a chase cap when a still-farther target preserves the advantage",()=>{
  const p=longWindingPath(105.0,101.45),now=(p.at(-1)!.time+300)*1000+1000;
  const row=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:p},now,costRate:.0022})
    .find(x=>x.symbol==="BTC_USDT"&&x.timeframe==="5m");
  assert.ok(row);assert.ok(row!.distanceFromAnchorRate>.01);
  assert.ok((row!.targetDistanceRate??0)>row!.distanceFromAnchorRate);
  assert.equal(row!.eligible,true);
});

test("a forward level that is not farther than anchor1 cannot qualify the entry",()=>{
  const p=longWindingPath(101.45,101.0),now=(p.at(-1)!.time+300)*1000+1000;
  const row=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:p},now,costRate:.0022})
    .find(x=>x.symbol==="BTC_USDT"&&x.timeframe==="5m");
  assert.ok(row);assert.ok((row!.targetDistanceRate??0)<=row!.distanceFromAnchorRate);
  assert.equal(row!.eligible,false);
});

test("farther forward space receives a higher score when anchor structure is otherwise comparable",()=>{
  const near=longWindingPath(102.35,101.0),far=longWindingPath(104.5,101.0);
  const nearNow=(near.at(-1)!.time+300)*1000+1000,farNow=(far.at(-1)!.time+300)*1000+1000;
  const a=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:near},now:nearNow,costRate:.0022}).find(x=>x.timeframe==="5m");
  const b=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:far},now:farNow,costRate:.0022}).find(x=>x.timeframe==="5m");
  assert.ok(a&&b);assert.ok((b!.targetDistanceRate??0)>(a!.targetDistanceRate??0));assert.ok(b!.score>a!.score);
});

test("4h and daily can never become executable entry candidates",()=>{
  const p=longWindingPath(),now=(p.at(-1)!.time+300)*1000+1000;
  const rows=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:p},now,costRate:.0022});
  assert.deepEqual([...SHORT_ENTRY_TIMEFRAMES],["5m","15m","30m","1h"]);
  assert.equal(rows.some(x=>x.timeframe==="4h"||x.timeframe==="1d"),false);
});

test("candidate conversion preserves anchor direction and forward target space for execution sizing",()=>{
  const p=longWindingPath(),now=(p.at(-1)!.time+300)*1000+1000;
  const row=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:p},now,costRate:.0022})[0];assert.ok(row);
  const candidate=entryOpportunityCandidate(row);
  assert.equal(candidate.side,row.side);assert.equal(candidate.expectedMoveRate,row.grossRemainingSpaceRate);
  assert.equal(candidate.signalPrice,row.price);
});
