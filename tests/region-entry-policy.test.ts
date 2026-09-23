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
const run=(signal:RegionEntrySignal,bid:number,ask:number,anchorConfirmationReferencePrice?:number)=>evaluateRegionEntryPolicy({
  signal,bestBid:bid,bestAsk:ask,contract,equity:1000,peakEquity:1000,totalRisk:0,longRisk:0,shortRisk:0,
  grossNotional:0,usedMargin:0,tradeRisks:[],costRate:.0022,feeRate:.0007,slippageRate:.00025,
  anchorConfirmationReferencePrice});

test("direct migration no longer owns entry authority",()=>{
  const result=run(base(),101.19,101.21);assert.equal(result.ok,false);
  if(!result.ok)assert.match(result.reason,/已退役|AnchorFlow/);
});

test("AnchorFlow restart stays READY until a small executable-price confirmation appears",()=>{
  const signal=base({entryModel:"ANCHOR_FLOW",anchorExpectedMoveRate:.022});
  const waiting=run(signal,101.19,101.21);assert.equal(waiting.ok,false);
  if(!waiting.ok)assert.match(waiting.reason,/顺向确认/);
  const result=run(signal,101.34,101.36,101.21*(1+.00025));assert.equal(result.ok,true);
  if(result.ok){
    assert.ok(result.plan.leverage>=6&&result.plan.leverage<=12);
    assert.ok(result.plan.plannedRisk<=8.01);
    assert.ok(result.plan.notional<=600.01);
  }
});

test("rejection entry must still have enough room to the region center after costs and full risk",()=>{
  const good=base({kind:"REJECTION",side:"SHORT",boundary:"UPPER",signalPrice:101.2,stopPrice:101.45,targetPrice:100});
  assert.equal(run(good,101.18,101.20).ok,true);
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

test("the same MON structure is executable only after completed AnchorFlow restart plus live quote confirmation",()=>{
  const mon=base({symbol:"MON_USDT",side:"SHORT",boundary:"LOWER",signalPrice:.026405,stopPrice:.026542,
    regionLower:.02646,regionUpper:.02687,regionCenter:.026735,regionWidth:.00041,regionWidthRate:.00041/.026735,
    entryModel:"ANCHOR_FLOW",anchorExpectedMoveRate:.018});
  const waiting=run(mon,.026405,.026409);assert.equal(waiting.ok,false);
  const result=run(mon,.026370,.026374,.026405*(1+.00025));
  assert.equal(result.ok,true);
  if(result.ok){assert.ok(result.plan.remainingSpaceRate>result.plan.lossRate);assert.ok(result.plan.notional<=600.01);}
});


test("FOLKS-like rejection with positive target space but terrible reward versus full risk is rejected",()=>{
  const weak=base({kind:"REJECTION",side:"LONG",boundary:"LOWER",signalPrice:2.489,stopPrice:2.4548,targetPrice:2.4995,
    regionLower:2.476,regionUpper:2.516,regionCenter:2.4995,regionWidth:.04,regionWidthRate:.04/2.4995});
  const contractLike={quantoMultiplier:1,leverageMax:50,maintenanceRate:.005,minContracts:1};
  const result=evaluateRegionEntryPolicy({signal:weak,bestBid:2.486,bestAsk:2.487,contract:contractLike,
    equity:1000,peakEquity:1000,totalRisk:0,longRisk:0,shortRisk:0,grossNotional:0,usedMargin:0,tradeRisks:[],
    costRate:.0031,feeRate:.0007,slippageRate:.00025});
  assert.equal(result.ok,false);
  if(!result.ok)assert.match(result.reason,/完整结构风险/);
});
