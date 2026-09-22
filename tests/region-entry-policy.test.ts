import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRegionEntryPolicy } from "../lib/region-entry-policy.ts";
import type { RegionEntrySignal } from "../lib/region-lifecycle.ts";

const contract={quantoMultiplier:.001,leverageMax:50,maintenanceRate:.005,minContracts:1};
const base=(overrides:Partial<RegionEntrySignal>={}):RegionEntrySignal=>({
  version:"region-lifecycle-v1",id:"s1",symbol:"BTC_USDT",kind:"MIGRATION",side:"LONG",boundary:"UPPER",
  completedAt:1_000,expiresAt:601_000,signalPrice:101.2,stopPrice:100.6,targetPrice:null,
  regionId:"r1",regionConfirmedAt:500,regionLower:99,regionUpper:101,regionCenter:100,regionWidth:2,regionWidthRate:.02,
  reason:"fixture",...overrides,
});
const run=(signal:RegionEntrySignal,bid:number,ask:number)=>evaluateRegionEntryPolicy({signal,bestBid:bid,bestAsk:ask,contract,
  equity:1000,peakEquity:1000,totalRisk:0,longRisk:0,shortRisk:0,grossNotional:0,usedMargin:0,tradeRisks:[],
  costRate:.0022,feeRate:.0007,slippageRate:.00025});

test("migration can enter while price remains close to the accepted region",()=>{
  const result=run(base(),101.19,101.21);assert.equal(result.ok,true);
  if(result.ok){assert.ok(result.plan.leverage>=6&&result.plan.leverage<=12);assert.ok(result.plan.plannedRisk<=15.01);}
});

test("migration refuses to chase after price is more than 0.6 region widths away",()=>{
  const result=run(base(),102.30,102.32);assert.equal(result.ok,false);
  if(!result.ok)assert.match(result.reason,/不追/);
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
