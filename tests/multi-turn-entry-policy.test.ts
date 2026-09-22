import test from "node:test";
import assert from "node:assert/strict";
import {evaluateMultiTurnEntryPolicy,multiTurnEntryLeverage,MULTI_TURN_TARGET_LEVERAGE} from "../lib/multi-turn-entry-policy.ts";
import type {TurnCandidate} from "../lib/multi-turn-engine.ts";
const candidate:TurnCandidate={symbol:"BTC_USDT",timeframe:"15m",side:"LONG",completedAt:1,signalPrice:100,turnProbability:.8,continuationScore:.75,confidence:.8,expectedMoveRate:.03,stopRate:.02,riskCap:.02,reason:"fixture"};
const base={candidate,bestBid:100,bestAsk:100.02,contract:{quantoMultiplier:.001,leverageMax:50,maintenanceRate:.005,minContracts:1},equity:1000,peakEquity:1000,totalRisk:0,longRisk:0,shortRisk:0,sleeveRisks:{},grossNotional:0,usedMargin:0,tradeRisks:[],costRate:.0022,feeRate:.0007,slippageRate:.00025};
test("entry policy returns a bounded executable plan",()=>{const r=evaluateMultiTurnEntryPolicy(base);assert.equal(r.ok,true);if(r.ok){assert.ok(r.plan.notional>=50);assert.ok(r.plan.leverage<=MULTI_TURN_TARGET_LEVERAGE);assert.ok(r.plan.plannedRisk<=15+1e-8);}});
test("entry policy rejects excessive spread without account side effects",()=>{const r=evaluateMultiTurnEntryPolicy({...base,bestAsk:100.3});assert.equal(r.ok,false);if(!r.ok)assert.equal(r.reason,"当前买卖价差过大");});
test("entry leverage remains bounded by structural loss",()=>{assert.equal(multiTurnEntryLeverage(.02,.005,.0022,50),20);assert.ok(multiTurnEntryLeverage(.08,.01,.003,50)<20);});
