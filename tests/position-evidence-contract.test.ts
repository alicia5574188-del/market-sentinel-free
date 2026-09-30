import test from "node:test";
import assert from "node:assert/strict";
import {advancePositionReview,capturePositionBaseline,positionAdvantage,validPositionBaseline,
  POSITION_EVIDENCE_CONTRACT,type PositionReviewMemory} from "../lib/position-evidence-contract.ts";
import type {MarketSymbolState} from "../lib/market-intelligence-engine.ts";

const OPEN=1790783978945,REVIEW=1790784008188,EXIT=1790784010276,BAR=1790784000000;
const state={longScore:80,shortScore:20,pathLong:.8,pathShort:.2,residualZ:1,venuePressure:.3} as MarketSymbolState;
const step=(now:number,barAt:number,previous?:PositionReviewMemory,concern=true,recovering=false,dataReady=true)=>
  advancePositionReview({now,openedAt:OPEN,barAt,previous,concern,recovering,dataReady});

test("ENA recorded 2.088-second rollover cannot create two causal confirmations",()=>{
  const first=step(REVIEW,BAR-300_000),second=step(EXIT,BAR,first);
  assert.equal(first.confirmations,1);assert.equal(second.confirmations,1);
  assert.equal(second.since,REVIEW);assert.equal(EXIT-REVIEW,2088);
  const after=step(BAR+300_010,BAR+300_000,second);
  assert.equal(after.confirmations,2,"a genuinely new full post-entry candle can confirm");
});
test("entry-straddling candle and repeated/reordered/future bars are not new confirmations",()=>{
  let p=step(OPEN+100, BAR-300_000);
  p=step(BAR+100,BAR,p);assert.equal(p.confirmations,1);
  for(const bar of [BAR,BAR-300_000,BAR+600_000]){
    p=step(BAR+200,bar,p);assert.equal(p.confirmations,1);assert.equal(p.lastBarAt,BAR);
  }
});
test("BR-style alternating neutral ticks keep the original review episode",()=>{
  const first=step(REVIEW,BAR);
  const neutral=step(REVIEW+2000,BAR,first,false);
  const resumed=step(REVIEW+4000,BAR,neutral);
  assert.equal(neutral.since,REVIEW);assert.equal(resumed.since,REVIEW);
  assert.equal(resumed.confirmations,1);
  assert.equal(step(BAR+300_020,BAR+300_000,resumed).confirmations,2);
});
test("recovery must survive a later completed candle and renewed concern cancels recovery",()=>{
  let p=step(REVIEW,BAR);
  p=step(REVIEW+2000,BAR,p,false,true);const since=p.recoverySince;
  p=step(REVIEW+4000,BAR,p,false,true);assert.equal(p.recoverySince,since);assert.equal(p.since,REVIEW);
  const restarted=step(REVIEW+6000,BAR,p);assert.equal(restarted.recoverySince,null);
  const recovered=step(BAR+300_020,BAR+300_000,p,false,true);
  assert.equal(recovered.since,null);assert.equal(recovered.confirmations,0);
  const newEpisode=step(BAR+301_000,BAR+300_000,recovered);
  assert.equal(newEpisode.since,BAR+301_000);assert.equal(newEpisode.confirmations,1);
});
test("missing data, isolated neutral ticks and low-confidence recovery never clear or mature review",()=>{
  const p=step(REVIEW,BAR);
  const missing=step(BAR+300_010,BAR+300_000,p,false,true,false);
  assert.equal(missing.since,REVIEW);assert.equal(missing.confirmations,1);
  const later=step(BAR+301_000,BAR+300_000,missing,true);
  assert.equal(later.confirmations,1,"a previously consumed incomplete-data bar is not counted again");
});
test("legacy review counts are not silently relabelled as causal confirmations",()=>{
  const bad={version:"old",since:REVIEW,confirmations:2,lastBarAt:BAR,recoverySince:null} as unknown as PositionReviewMemory;
  const p=step(EXIT,BAR,bad);assert.equal(p.since,EXIT);assert.equal(p.confirmations,1);
});
test("one unchanged advantage formula supports both sides and bounded immutable baselines",()=>{
  const a=capturePositionBaseline("LONG",state,OPEN)!;
  assert.equal(a.version,POSITION_EVIDENCE_CONTRACT);assert.equal(a.source,"ENTRY");
  assert.equal(a.score,positionAdvantage("LONG",state));assert.ok(Math.abs(a.score-74.55)<1e-10);
  assert.ok(validPositionBaseline(a,OPEN));assert.equal(validPositionBaseline({...a,at:OPEN+1},OPEN),false);
  assert.equal(positionAdvantage("LONG",undefined),null);
  assert.equal(capturePositionBaseline("LONG",undefined,OPEN),undefined);
  assert.ok(Math.abs(positionAdvantage("SHORT",state)!-25.45)<1e-10);
  assert.ok(JSON.stringify(a).length<200);
});
test("review and baseline survive JSON restart without inventing historical observations",()=>{
  const p=JSON.parse(JSON.stringify(step(REVIEW,BAR)));
  assert.deepEqual(step(EXIT,BAR,p),p);
  const recovered=capturePositionBaseline("LONG",state,EXIT,"RECOVERED")!;
  assert.equal(recovered.at,EXIT);assert.equal(recovered.source,"RECOVERED");
});
