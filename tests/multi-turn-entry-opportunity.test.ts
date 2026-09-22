import test from "node:test";
import assert from "node:assert/strict";
import {evaluateMultiTurnEntryOpportunities,entryOpportunityCandidate,SHORT_ENTRY_TIMEFRAMES} from "../lib/multi-turn-entry-opportunity.ts";
import {initialMultiTurn,type TurnCandle} from "../lib/multi-turn-engine.ts";

const START=Date.parse("2026-09-01T00:00:00Z")/1000;
const candle=(i:number,open:number,close:number,high=Math.max(open,close)*1.0008,low=Math.min(open,close)*.9992):TurnCandle=>({
  time:START+i*300,open,high,low,close,volume:1000+i,
});
const longAnchorPath=()=>{
  const rows:TurnCandle[]=[];
  let px=99.7;
  for(let i=0;i<32;i++){const next=px*(1+(i%4===0?.0002:-.00005));rows.push(candle(i,px,next));px=next;}
  const i=rows.length;
  rows.push(candle(i,99.98,100,100.05,99.96));
  rows.push(candle(i+1,100,100.36,100.42,99.97));
  rows.push(candle(i+2,100.36,100.64,100.72,100.30));
  rows.push(candle(i+3,100.64,100.74,100.82,100.58));
  rows.push(candle(i+4,100.74,100.20,100.76,100.16));
  return rows;
};

test("proven long anchor becomes a short-term candidate near the validated entry area",()=>{
  const p=longAnchorPath(),now=(p.at(-1)!.time+300)*1000+1000;
  const rows=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:p},turnEngine:initialMultiTurn(),now,costRate:.0022});
  const row=rows.find(x=>x.symbol==="BTC_USDT"&&x.timeframe==="5m");
  assert.ok(row);assert.equal(row!.side,"LONG");
  assert.ok(row!.anchorQuality>=48);
  assert.ok(row!.anchorMfeRate>row!.anchorMaeRate);
  assert.ok(row!.anchorFirstProfitBars<=3);
  assert.ok(row!.distanceFromAnchorRate<=row!.maxEntryDistanceRate);
  assert.ok(row!.score>=0&&row!.score<=100);
});

test("4h and daily can never become executable entry candidates",()=>{
  const p=longAnchorPath(),now=(p.at(-1)!.time+300)*1000+1000;
  const rows=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:p},now,costRate:.0022});
  assert.deepEqual([...SHORT_ENTRY_TIMEFRAMES],["5m","15m","30m","1h"]);
  assert.equal(rows.some(x=>x.timeframe==="4h"||x.timeframe==="1d"),false);
});

test("a validated direction is not chased once price is too far from its anchor",()=>{
  const p=longAnchorPath();
  const last=p.at(-1)!;
  p[p.length-1]=candle(p.length-1,last.open,101.10,101.15,101.02);
  const now=(p.at(-1)!.time+300)*1000+1000;
  const row=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:p},now,costRate:.0022})
    .find(x=>x.symbol==="BTC_USDT"&&x.timeframe==="5m");
  assert.ok(row);
  assert.equal(row!.eligible,false);
  assert.ok(row!.distanceFromAnchorRate>row!.maxEntryDistanceRate);
});

test("candidate conversion preserves anchor direction and remaining gross space for execution sizing",()=>{
  const p=longAnchorPath(),now=(p.at(-1)!.time+300)*1000+1000;
  const row=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:p},now,costRate:.0022})[0];assert.ok(row);
  const candidate=entryOpportunityCandidate(row);
  assert.equal(candidate.side,row.side);
  assert.equal(candidate.expectedMoveRate,row.grossRemainingSpaceRate);
  assert.equal(candidate.signalPrice,row.price);
});
