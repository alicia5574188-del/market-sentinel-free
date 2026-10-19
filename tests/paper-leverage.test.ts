import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DEFAULT_MAINTENANCE_RATE,PAPER_LEVERAGE_FIXED,fixedPaperLeverage,isolatedLiquidationPrice,liquidationHit,maintenanceRateOf} from "../lib/paper-leverage.ts";

const near=(a:number,b:number,eps=1e-9)=>Math.abs(a-b)<eps;

test("new paper trades: fixed 10x, whatever the stop or maintenance rate",()=>{
  assert.equal(PAPER_LEVERAGE_FIXED,10);
  for(const max of [10,12,20,50,100,125])assert.equal(fixedPaperLeverage(max),10,String(max));
});

test("contract max below 10 → the contract max (same as before 605fe2a0); unknown max → 10",()=>{
  assert.equal(fixedPaperLeverage(8),8);
  assert.equal(fixedPaperLeverage(5),5);
  assert.equal(fixedPaperLeverage(12.9),10);
  assert.equal(fixedPaperLeverage(9.7),9);
  for(const none of [0,null,undefined,Number.NaN])assert.equal(fixedPaperLeverage(none as never),10,String(none));
  assert.equal(fixedPaperLeverage(.5),1,"never below 1");
});

test("isolated liquidation is still modelled at 10x",()=>{
  // long: entry × (1 − 1/10) / (1 − mmr)
  assert.ok(near(isolatedLiquidationPrice({entry:100,leverage:10,side:"LONG",maintenanceRate:.005})!,90/.995));
  assert.ok(near(isolatedLiquidationPrice({entry:100,leverage:10,side:"SHORT",maintenanceRate:.005})!,110/1.005));
  // a high maintenance rate brings the liquidation price in: mmr 5% → 5.26% away for a long
  assert.ok(near(1-isolatedLiquidationPrice({entry:100,leverage:10,side:"LONG",maintenanceRate:.05})!/100,1-.9/.95));
  assert.equal(liquidationHit("LONG",90.4,90/.995),true);
  assert.equal(liquidationHit("SHORT",109,110/1.005),false);
});

test("implausible maintenance rates fall back to the conservative default",()=>{
  for(const mmr of [null,undefined,0,-1,Number.NaN,.9])assert.equal(maintenanceRateOf(mmr),DEFAULT_MAINTENANCE_RATE);
});

test("open path: fixed leverage, no liquidation-safe step-down; notional and risk sized before it",()=>{
  const core=readFileSync(new URL("../lib/forward-relations.ts",import.meta.url),"utf8");
  const open=core.slice(core.indexOf("function openIntelligenceTrade"),core.indexOf("export function extremeResidualConfirmationProfile"));
  assert.match(open,/leverage=fixedPaperLeverage\(contract\.leverageMax\)/);
  assert.doesNotMatch(core,/safePaperLeverage/);
  assert.ok(open.indexOf("rawNotional=riskBudget/")<open.indexOf("leverage=fixedPaperLeverage"),"notional does not depend on leverage");
  assert.match(open,/margin=notional\/leverage/);
  assert.match(open,/liquidationPrice=isolatedLiquidationPrice\(\{entry:price,leverage,side,maintenanceRate\}\)/);
});
