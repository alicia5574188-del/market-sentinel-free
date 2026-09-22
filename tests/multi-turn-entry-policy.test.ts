import test from "node:test";
import assert from "node:assert/strict";
import {evaluateMultiTurnEntryPolicy,multiTurnEntryLeverage,MULTI_TURN_MIN_LEVERAGE,MULTI_TURN_TARGET_LEVERAGE} from "../lib/multi-turn-entry-policy.ts";
import type {TurnCandidate} from "../lib/multi-turn-engine.ts";
const candidate:TurnCandidate={symbol:"BTC_USDT",timeframe:"15m",side:"LONG",completedAt:1,signalPrice:100,turnProbability:.8,continuationScore:.75,confidence:.8,expectedMoveRate:.03,stopRate:.02,riskCap:.02,score:.8,reason:"fixture"};
const base={candidate,bestBid:100,bestAsk:100.02,contract:{quantoMultiplier:.001,leverageMax:50,maintenanceRate:.005,minContracts:1},equity:1000,peakEquity:1000,totalRisk:0,longRisk:0,shortRisk:0,sleeveRisks:{},grossNotional:0,usedMargin:0,tradeRisks:[],costRate:.0022,feeRate:.0007,slippageRate:.00025};
test("entry policy keeps target notional while using materially more isolated margin",()=>{const r=evaluateMultiTurnEntryPolicy(base);assert.equal(r.ok,true);if(r.ok){assert.ok(r.plan.notional>=50);assert.ok(r.plan.leverage>=MULTI_TURN_MIN_LEVERAGE&&r.plan.leverage<=MULTI_TURN_TARGET_LEVERAGE);assert.ok(r.plan.margin>=r.plan.notional/MULTI_TURN_TARGET_LEVERAGE-1e-8);assert.ok(r.plan.plannedRisk<=15+1e-8);}});
test("entry policy rejects excessive spread without account side effects",()=>{const r=evaluateMultiTurnEntryPolicy({...base,bestAsk:100.3});assert.equal(r.ok,false);if(!r.ok)assert.equal(r.reason,"当前买卖价差过大");});
test("entry leverage uses 6-12x structural tiers",()=>{
  assert.equal(multiTurnEntryLeverage(.01,.005,.0022,50),12);
  assert.equal(multiTurnEntryLeverage(.02,.005,.0022,50),10);
  assert.equal(multiTurnEntryLeverage(.03,.005,.0022,50),8);
  assert.equal(multiTurnEntryLeverage(.05,.005,.0022,50),6);
});
test("an entry that would require below 6x is rejected instead of forcing unsafe leverage",()=>{
  assert.equal(multiTurnEntryLeverage(.14,.02,.01,50),0);
  const r=evaluateMultiTurnEntryPolicy({...base,candidate:{...candidate,stopRate:.14}});
  assert.equal(r.ok,false);if(!r.ok)assert.match(r.reason,/6倍逐仓杠杆/);
});
test("lower leverage never silently turns a target order into a tiny notional",()=>{
  const normal=evaluateMultiTurnEntryPolicy(base);assert.equal(normal.ok,true);
  const constrained=evaluateMultiTurnEntryPolicy({...base,usedMargin:730});
  assert.equal(constrained.ok,false);if(!constrained.ok)assert.match(constrained.reason,/不缩成小单|保证金/);
});

test("exact anchor stop cannot be pulled inward when execution slippage makes it too wide",()=>{
  const r=evaluateMultiTurnEntryPolicy({...base,candidate:{...candidate,stopRate:.01,stopPrice:94}});
  assert.equal(r.ok,false);if(!r.ok)assert.match(r.reason,/不把止损往锚点内移动/);
});
