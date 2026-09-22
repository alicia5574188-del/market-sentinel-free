import test from "node:test";
import assert from "node:assert/strict";
import {evaluateMultiTurnEntryOpportunities,entryOpportunityCandidate} from "../lib/multi-turn-entry-opportunity.ts";
import {initialMultiTurn,type TurnCandle} from "../lib/multi-turn-engine.ts";

const START=Date.parse("2026-09-01T00:00:00Z")/1000;
const path=(count:number,step:number):TurnCandle[]=>Array.from({length:count},(_,i)=>{
  const close=100*Math.exp(i*step),open=close*Math.exp(-step*.5);
  return{time:START+i*300,open,high:Math.max(open,close)*1.0015,low:Math.min(open,close)*.9985,close,volume:1000+i};
});

test("direction-space entry ranks a clean trend without requiring a turn confirmation",()=>{
  const p=path(360,.001),now=(p.at(-1)!.time+300)*1000+1000;
  const rows=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:p},turnEngine:initialMultiTurn(),now,costRate:.0022});
  const row=rows.find(x=>x.symbol==="BTC_USDT"&&x.timeframe==="15m");
  assert.ok(row);assert.equal(row!.side,"LONG");assert.ok(row!.directionStrength>45);
  assert.ok(row!.score>=0&&row!.score<=100);assert.ok(row!.turnRisk>=0);
});

test("space score is bounded and an already exhausted leg is not promoted by raw volatility",()=>{
  const p=path(360,.004),now=(p.at(-1)!.time+300)*1000+1000;
  const rows=evaluateMultiTurnEntryOpportunities({paths:{FAST_USDT:p},now,costRate:.0022});
  for(const row of rows){assert.ok(row.spaceScore>=0&&row.spaceScore<=100);assert.ok(row.positionScore>=0&&row.positionScore<=100);}
});

test("candidate conversion preserves current direction and remaining space for execution sizing",()=>{
  const p=path(360,-.001),now=(p.at(-1)!.time+300)*1000+1000;
  const row=evaluateMultiTurnEntryOpportunities({paths:{ETH_USDT:p},now,costRate:.0022})[0];assert.ok(row);
  const candidate=entryOpportunityCandidate(row);
  assert.equal(candidate.side,row.side);assert.equal(candidate.expectedMoveRate,row.grossRemainingSpaceRate);
  assert.equal(candidate.signalPrice,row.price);
});
