import test from "node:test";
import assert from "node:assert/strict";
import {evaluateMultiTurnEntryMemory,MULTI_TURN_MIN_REENTRY_MS,MULTI_TURN_OPPOSITE_REENTRY_MS,MULTI_TURN_SAME_SIDE_LOSS_COOLDOWN_MS,
  MULTI_TURN_LOSS_CLUSTER_COOLDOWN_MS} from "../lib/multi-turn-entry-memory.ts";
const NOW=Date.parse("2026-09-22T12:00:00Z");
const row=(ago:number,netPnl:number,side:"LONG"|"SHORT"="LONG")=>({symbol:"AKE_USDT",side,timeframe:"5m" as const,
  closedAt:NOW-ago,netPnl,exitReason:netPnl<0?"HARD_STOP":"PROFIT_GIVEBACK"});
test("opposite direction can be re-evaluated after two minutes instead of inheriting the old ten-minute block",()=>{
  const d=evaluateMultiTurnEntryMemory({now:NOW,symbol:"AKE_USDT",side:"SHORT",recent:[row(60_000,2)]});
  assert.equal(d.allowed,false);assert.equal(d.blockedUntil,NOW-60_000+MULTI_TURN_OPPOSITE_REENTRY_MS);
  assert.equal(evaluateMultiTurnEntryMemory({now:NOW,symbol:"AKE_USDT",side:"SHORT",recent:[row(3*60_000,2)]}).allowed,true);
});
test("same direction still keeps the ten-minute anti-churn separation after a winner",()=>{
  const d=evaluateMultiTurnEntryMemory({now:NOW,symbol:"AKE_USDT",side:"LONG",recent:[row(2*60_000,2)]});
  assert.equal(d.allowed,false);assert.equal(d.blockedUntil,NOW-2*60_000+MULTI_TURN_MIN_REENTRY_MS);
});
test("same-side loss blocks the repeated chase for thirty minutes",()=>{
  const d=evaluateMultiTurnEntryMemory({now:NOW,symbol:"AKE_USDT",side:"LONG",recent:[row(12*60_000,-4)]});
  assert.equal(d.allowed,false);assert.equal(d.blockedUntil,NOW-12*60_000+MULTI_TURN_SAME_SIDE_LOSS_COOLDOWN_MS);
});
test("three recent losses create only a temporary one-hour cluster cooldown",()=>{
  const recent=[row(15*60_000,-4,"SHORT"),row(40*60_000,-3,"SHORT"),row(70*60_000,-2,"SHORT"),row(90*60_000,1,"LONG")];
  const d=evaluateMultiTurnEntryMemory({now:NOW,symbol:"AKE_USDT",side:"SHORT",recent});
  assert.equal(d.allowed,false);assert.equal(d.blockedUntil,NOW-15*60_000+MULTI_TURN_LOSS_CLUSTER_COOLDOWN_MS);
  assert.equal(d.scoreMultiplier,.45);
});
test("old losses do not become a permanent admission gate",()=>{
  const recent=[row(7*60*60_000,-4),row(8*60*60_000,-3),row(9*60*60_000,-2)];
  assert.equal(evaluateMultiTurnEntryMemory({now:NOW,symbol:"AKE_USDT",side:"LONG",recent}).allowed,true);
});
