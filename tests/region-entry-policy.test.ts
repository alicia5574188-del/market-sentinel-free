import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRegionEntryPolicy } from "../lib/region-entry-policy.ts";
import type { RegionEntrySignal } from "../lib/region-lifecycle.ts";

const contract={quantoMultiplier:.001,leverageMax:50,maintenanceRate:.005,minContracts:1};
type TestSignal=RegionEntrySignal&{entryModel?:"ANCHOR_FLOW";anchorExpectedMoveRate?:number};
const base=(overrides:Partial<TestSignal>={}):TestSignal=>({
  version:"region-lifecycle-v1",id:"s1",symbol:"BTC_USDT",kind:"MIGRATION",side:"LONG",boundary:"UPPER",
  completedAt:1_000,expiresAt:601_000,signalPrice:101.2,stopPrice:100.6,targetPrice:null,
  regionId:"r1",regionConfirmedAt:500,regionLower:99,regionUpper:101,regionCenter:100,regionWidth:2,regionWidthRate:.02,
  reason:"fixture",...overrides,
});
const run=(signal:RegionEntrySignal,bid:number,ask:number)=>evaluateRegionEntryPolicy({signal,bestBid:bid,bestAsk:ask,contract,
  equity:1000,peakEquity:1000,totalRisk:0,longRisk:0,shortRisk:0,grossNotional:0,usedMargin:0,tradeRisks:[],
  costRate:.0022,feeRate:.0007,slippageRate:.00025});

test("direct migration no longer owns entry authority",()=>{
  const result=run(base(),101.19,101.21);assert.equal(result.ok,false);
  if(!result.ok)assert.match(result.reason,/已退役|AnchorFlow/);
});

test("AnchorFlow restart may enter only after structural retest has produced an executable event",()=>{
  const result=run(base({entryModel:"ANCHOR_FLOW",anchorExpectedMoveRate:.022}),101.19,101.21);assert.equal(result.ok,true);
  if(result.ok){
    assert.ok(result.plan.leverage>=6&&result.plan.leverage<=12);
    assert.ok(result.plan.plannedRisk<=8.01);
    assert.ok(result.plan.notional<=600.01);
  }
});

test("rejection entry must still have enough room to the region center after costs",()=>{
  const good=base({kind:"REJECTION",side:"SHORT",boundary:"UPPER",signalPrice:100.65,stopPrice:101.5,targetPrice:100});
  assert.equal(run(good,100.59,100.61).ok,true);
  const thin=base({kind:"REJECTION",side:"SHORT",boundary:"UPPER",signalPrice:100.24,stopPrice:100.8,targetPrice:100,
    regionLower:99.5,regionUpper:100.5,regionCenter:100,regionWidth:1,regionWidthRate:.01});
  const result=run(thin,100.22,100.24);assert.equal(result.ok,false);
  if(!result.ok)assert.match(result.reason,/交易成本/);
});

test("structural invalidation is never pulled inward to fit the 5m risk boundary",()=>{
  const wide=base({stopPrice:97});
  const result=run(wide,101.19,101.21);assert.equal(result.ok,false);
  if(!result.ok)assert.match(result.reason,/风险边界/);
});




test("a raw MON-like migration is rejected even if the quote is close to its region",()=>{
  const mon=base({symbol:"MON_USDT",side:"SHORT",boundary:"LOWER",signalPrice:.02640,stopPrice:.026542,
    regionLower:.02646,regionUpper:.02687,regionCenter:.026735,regionWidth:.00041,regionWidthRate:.00041/.026735});
  const result=run(mon,.026405,.026409);
  assert.equal(result.ok,false);
  if(!result.ok)assert.match(result.reason,/已退役|AnchorFlow/);
});

test("the same MON structure is executable only as a completed AnchorFlow restart",()=>{
  const mon=base({symbol:"MON_USDT",side:"SHORT",boundary:"LOWER",signalPrice:.026405,stopPrice:.026542,
    regionLower:.02646,regionUpper:.02687,regionCenter:.026735,regionWidth:.00041,regionWidthRate:.00041/.026735,
    entryModel:"ANCHOR_FLOW",anchorExpectedMoveRate:.018});
  const result=run(mon,.026405,.026409);
  assert.equal(result.ok,true);
  if(result.ok){assert.ok(result.plan.remainingSpaceRate>result.plan.lossRate);assert.ok(result.plan.notional<=600.01);}
});
