import test from "node:test";
import assert from "node:assert/strict";
import {evaluateMultiTurnEntryOpportunities,entryOpportunityCandidate,MULTI_TURN_ENTRY_OPPORTUNITY_VERSION,
  SHORT_ENTRY_TIMEFRAMES} from "../lib/multi-turn-entry-opportunity.ts";
import type {TurnCandle} from "../lib/multi-turn-engine.ts";

const START=Date.parse("2026-09-01T00:00:00Z")/1000;
const candle=(i:number,open:number,close:number,range=.0016):TurnCandle=>({
  time:START+i*300,open,high:Math.max(open,close)*(1+range/2),low:Math.min(open,close)*(1-range/2),close,volume:1000+i,
});

function trendPath(side:"LONG"|"SHORT",step=.0018,bars=48){
  const rows:TurnCandle[]=[];let prev=100;
  for(let i=0;i<bars;i++){
    const drift=side==="LONG"?1+step:1-step;
    const close=prev*drift;
    rows.push(candle(i,prev,close,.0014));
    prev=close;
  }
  return rows;
}

function withLateChase(rows:TurnCandle[],side:"LONG"|"SHORT"){
  const out=structuredClone(rows),d=side==="LONG"?1:-1;
  for(let n=3;n>=1;n--){
    const i=out.length-n,prior=out[i-1]!.close,move=1+d*.018;
    out[i]=candle(i,prior,prior*move,.003);
  }
  return out;
}

test("broad 5m direction-space participation does not require a winding anchor",()=>{
  const p=trendPath("LONG"),now=(p.at(-1)!.time+300)*1000+1000;
  const rows=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:p},now,costRate:.0022});
  const row=rows.find(x=>x.symbol==="BTC_USDT");
  assert.ok(row);assert.equal(row!.version,MULTI_TURN_ENTRY_OPPORTUNITY_VERSION);
  assert.equal(row!.timeframe,"5m");assert.equal(row!.side,"LONG");
  assert.equal(row!.anchorPrice,undefined);
  assert.ok(row!.directionStrength>=38);assert.ok(row!.netRemainingSpaceRate>0);
  assert.equal(row!.eligible,true,row!.reason);
});

test("falling 5m path produces a SHORT participation candidate",()=>{
  const p=trendPath("SHORT"),now=(p.at(-1)!.time+300)*1000+1000;
  const row=evaluateMultiTurnEntryOpportunities({paths:{ETH_USDT:p},now,costRate:.0022})[0];
  assert.ok(row);assert.equal(row!.side,"SHORT");assert.equal(row!.eligible,true,row!.reason);
});

test("flat noise does not become a forced ten-seat order",()=>{
  const rows:TurnCandle[]=[];let prev=100;
  for(let i=0;i<48;i++){
    const close=100*(1+.00015*Math.sin(i*1.7));
    rows.push(candle(i,prev,close,.0016));prev=close;
  }
  const now=(rows.at(-1)!.time+300)*1000+1000;
  const candidates=evaluateMultiTurnEntryOpportunities({paths:{XRP_USDT:rows},now,costRate:.0022});
  assert.equal(candidates.filter(x=>x.eligible).length,0);
});

test("late acceleration lowers location quality instead of rewarding a chase",()=>{
  const steady=trendPath("LONG",.0012),chased=withLateChase(steady,"LONG");
  const now=(steady.at(-1)!.time+300)*1000+1000;
  const a=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:steady},now,costRate:.0022})[0];
  const b=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:chased},now,costRate:.0022})[0];
  assert.ok(a&&b);assert.ok(b.positionScore<a.positionScore);
  assert.ok(b.positionScore<20,"late three-bar extension should lose entry-location quality");
});

test("after-cost space remains mandatory even for a strong direction",()=>{
  const p=trendPath("LONG"),now=(p.at(-1)!.time+300)*1000+1000;
  const cheap=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:p},now,costRate:.0022})[0];
  const expensive=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:p},now,costRate:.03})[0];
  assert.ok(cheap&&expensive);assert.equal(cheap.eligible,true);
  assert.equal(expensive.eligible,false);assert.equal(expensive.netRemainingSpaceRate,0);
});

test("participation authority is 5m only",()=>{
  const p=trendPath("LONG"),now=(p.at(-1)!.time+300)*1000+1000;
  const rows=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:p},now,costRate:.0022});
  assert.deepEqual([...SHORT_ENTRY_TIMEFRAMES],["5m"]);
  assert.ok(rows.every(x=>x.timeframe==="5m"));
});

test("candidate conversion preserves direction and remaining-space economics",()=>{
  const p=trendPath("LONG"),now=(p.at(-1)!.time+300)*1000+1000;
  const row=evaluateMultiTurnEntryOpportunities({paths:{BTC_USDT:p},now,costRate:.0022})[0];assert.ok(row);
  const candidate=entryOpportunityCandidate(row);
  assert.equal(candidate.timeframe,"5m");assert.equal(candidate.side,row.side);
  assert.equal(candidate.expectedMoveRate,row.grossRemainingSpaceRate);
  assert.equal(candidate.signalPrice,row.price);
});
