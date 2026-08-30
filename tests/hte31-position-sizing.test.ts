import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHte31PaperPosition,
  HTE31_PAPER_POSITION_POLICY,
} from "../lib/hte31-position-sizing.ts";

test("1,000U tight-stop BTC setup is enlarged to about 40U net risk and 80U TP2 net", () => {
  const result = buildHte31PaperPosition({
    side: "LONG",
    entryPrice: 78_040.10,
    stopLossPrice: 77_914.53,
    originalTakeProfit2Price: 78_247.29,
    accountEquityUsdt: 1_000,
    availableMarginUsdt: 1_000,
    riskMultiplier: 1,
    roundTripCostBps: 8,
    liquidityVolumeUsd: 1_500_000_000,
    atrPct: 0.22,
    dataQuality: 0.91,
    confidence: 84,
  });

  assert.equal(result.accepted, true);
  assert.ok(result.plannedRiskUsdt >= 39.99 && result.plannedRiskUsdt <= 40.01);
  assert.ok(result.plannedTp2NetProfitUsdt >= 79.99 && result.plannedTp2NetProfitUsdt <= 80.01);
  assert.ok(result.leverage > 3 && result.leverage <= 50);
  assert.equal(result.tp2Adjusted, true);
  assert.ok(result.takeProfit2Price > 78_247.29);
});

test("fee-heavy narrow stop budgets fees inside 1R before choosing leverage and TP2", () => {
  const result = buildHte31PaperPosition({
    side: "SHORT",
    entryPrice: 100,
    stopLossPrice: 100.10,
    originalTakeProfit2Price: 99.835,
    accountEquityUsdt: 1_000,
    availableMarginUsdt: 1_000,
    riskMultiplier: 1,
    roundTripCostBps: 8,
    liquidityVolumeUsd: 1_000_000_000,
    atrPct: 0.25,
    dataQuality: 0.94,
    confidence: 88,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.leverage, 38);
  assert.ok(result.plannedRiskUsdt >= 39.99 && result.plannedRiskUsdt <= 40.01);
  assert.equal(result.riskReward, 4);
  assert.ok(result.plannedTp2CostUsdt >= 17.77 && result.plannedTp2CostUsdt <= 17.79);
  assert.ok(result.plannedTp2NetProfitUsdt >= 71.10 && result.plannedTp2NetProfitUsdt <= 71.12);
});

test("risk governor reduces normal 40U risk only to the user's 30U economic floor", () => {
  const result = buildHte31PaperPosition({
    side: "LONG",
    entryPrice: 100,
    stopLossPrice: 99,
    originalTakeProfit2Price: 102.4,
    accountEquityUsdt: 1_000,
    availableMarginUsdt: 1_000,
    riskMultiplier: 0.35,
    roundTripCostBps: 8,
    liquidityVolumeUsd: 800_000_000,
    atrPct: 0.7,
    dataQuality: 0.9,
    confidence: 84,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.targetRiskUsdt, 30);
  assert.ok(result.plannedRiskUsdt >= 29.99 && result.plannedRiskUsdt <= 30.01);
  assert.ok(result.plannedTp2NetProfitUsdt >= 79.99);
});

test("a second paper position can still use reserved margin and reach the 40U net-risk target", () => {
  const result = buildHte31PaperPosition({
    side: "LONG",
    entryPrice: 100,
    stopLossPrice: 99.85,
    originalTakeProfit2Price: 100.36,
    accountEquityUsdt: 1_000,
    availableMarginUsdt: 400,
    riskMultiplier: 1,
    roundTripCostBps: 8,
    liquidityVolumeUsd: 1_000_000_000,
    atrPct: 0.25,
    dataQuality: 0.94,
    confidence: 88,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.leverage, 44);
  assert.ok(result.marginUsdt <= 400.01);
  assert.ok(result.plannedRiskUsdt >= 39.99 && result.plannedRiskUsdt <= 40.01);
  assert.ok(result.plannedTp2NetProfitUsdt >= 79.99);
});

test("illiquid setup is rejected only after its adaptive leverage cap cannot reach 30U net risk", () => {
  const result = buildHte31PaperPosition({
    side: "LONG",
    entryPrice: 100,
    stopLossPrice: 99.90,
    originalTakeProfit2Price: 100.24,
    accountEquityUsdt: 1_000,
    availableMarginUsdt: 1_000,
    riskMultiplier: 1,
    roundTripCostBps: 8,
    liquidityVolumeUsd: 12_000_000,
    atrPct: 0.4,
    dataQuality: 0.9,
    confidence: 84,
  });

  assert.equal(result.leverageCap, 10);
  assert.equal(result.accepted, false);
  assert.match(result.reason, /低于 30\.00U/);
});

test("paper sizing policy keeps the explicit 30–50U and 50–200U bounds", () => {
  assert.equal(HTE31_PAPER_POSITION_POLICY.minimumRiskRate, 0.03);
  assert.equal(HTE31_PAPER_POSITION_POLICY.targetRiskRate, 0.04);
  assert.equal(HTE31_PAPER_POSITION_POLICY.maximumRiskRate, 0.05);
  assert.equal(HTE31_PAPER_POSITION_POLICY.minimumTp2NetProfitRate, 0.05);
  assert.equal(HTE31_PAPER_POSITION_POLICY.maximumTp2NetProfitRate, 0.20);
  assert.equal(HTE31_PAPER_POSITION_POLICY.maximumMarginAllocationRate, 0.60);
  assert.equal(HTE31_PAPER_POSITION_POLICY.maximumLeverage, 50);
});
