import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHte31PaperPosition,
  HTE31_PAPER_POSITION_POLICY,
} from "../lib/hte31-position-sizing.ts";

function baseInput(overrides: Partial<Parameters<typeof buildHte31PaperPosition>[0]> = {}) {
  return {
    side: "LONG" as const,
    entryPrice: 100,
    stopLossPrice: 99,
    originalTakeProfit2Price: 102,
    accountEquityUsdt: 1_000,
    availableMarginUsdt: 1_000,
    riskMultiplier: 1,
    roundTripCostBps: 8,
    liquidityVolumeUsd: 1_000_000_000,
    atrPct: 0.7,
    dataQuality: 0.92,
    confidence: 84,
    ...overrides,
  };
}

test("paper sizing preserves the market target instead of pulling every trade toward 80U", () => {
  const result = buildHte31PaperPosition(baseInput());
  assert.equal(result.accepted, true);
  assert.ok(result.plannedRiskUsdt >= 39.99 && result.plannedRiskUsdt <= 40.01);
  assert.equal(result.takeProfit2Price, 102);
  assert.equal(result.riskReward, 2);
  assert.equal(result.tp2Adjusted, false);
  assert.ok(result.plannedTp2NetProfitUsdt >= 70 && result.plannedTp2NetProfitUsdt < 80);
});

test("safe leverage targets roughly fifteen percent margin without increasing stop risk", () => {
  const result = buildHte31PaperPosition(baseInput());
  assert.equal(result.accepted, true);
  assert.ok(result.leverage >= 20);
  assert.ok(result.marginUsdt <= 150.01);
  assert.ok(result.plannedRiskUsdt >= 39.99 && result.plannedRiskUsdt <= 40.01);
  assert.match(result.leverageReason, /目标≤15%/);
});

test("safe leverage fallback may use more than preferred margin instead of starving a valid setup", () => {
  const result = buildHte31PaperPosition(baseInput({
    dataQuality: 0.80,
    confidence: 75,
  }));
  assert.equal(result.leverageCap, 20);
  assert.equal(result.accepted, true);
  assert.ok(result.marginUsdt > 150);
  assert.ok(result.marginUsdt <= 300);
  assert.ok(result.plannedRiskUsdt >= 39.99 && result.plannedRiskUsdt <= 40.01);
});

test("50U is an economic floor, not a target that sizing manufactures", () => {
  const result = buildHte31PaperPosition(baseInput({ originalTakeProfit2Price: 101.2 }));
  assert.equal(result.accepted, false);
  assert.equal(result.takeProfit2Price, 101.2);
  assert.equal(result.tp2Adjusted, false);
  assert.match(result.reason, /低于最低 50U/);
  assert.match(result.reason, /不为凑利润人为抬高TP/);
});

test("a genuinely large market target can exceed 500U without a 200U profit ceiling", () => {
  const result = buildHte31PaperPosition(baseInput({ originalTakeProfit2Price: 115 }));
  assert.equal(result.accepted, true);
  assert.equal(result.riskReward, 15);
  assert.equal(result.takeProfit2Price, 115);
  assert.ok(result.plannedTp2NetProfitUsdt > 500);
  assert.equal(result.maximumTp2NetProfitUsdt, Number.MAX_VALUE);
});

test("risk governor still reduces normal 40U risk to the 30U account-risk floor", () => {
  const result = buildHte31PaperPosition(baseInput({
    originalTakeProfit2Price: 103,
    riskMultiplier: 0.35,
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.targetRiskUsdt, 30);
  assert.ok(result.plannedRiskUsdt >= 29.99 && result.plannedRiskUsdt <= 30.01);
});

test("fee-heavy narrow stop budgets fees inside 1R before choosing leverage", () => {
  const result = buildHte31PaperPosition(baseInput({
    side: "SHORT",
    entryPrice: 100,
    stopLossPrice: 100.10,
    originalTakeProfit2Price: 99.60,
    atrPct: 0.25,
    dataQuality: 0.94,
    confidence: 88,
  }));
  assert.equal(result.accepted, true);
  assert.ok(result.leverage > 1 && result.leverage <= 50);
  assert.ok(result.plannedRiskUsdt >= 39.99 && result.plannedRiskUsdt <= 40.01);
  assert.equal(result.riskReward, 4);
  assert.ok(result.plannedTp2NetProfitUsdt >= 50);
});

test("illiquid setup is rejected when safe leverage plus hard margin cap cannot express minimum risk", () => {
  const result = buildHte31PaperPosition(baseInput({
    stopLossPrice: 99.90,
    originalTakeProfit2Price: 101,
    liquidityVolumeUsd: 12_000_000,
    atrPct: 0.4,
  }));
  assert.equal(result.leverageCap, 10);
  assert.equal(result.accepted, false);
  assert.match(result.reason, /低于 30\.00U/);
});

test("paper sizing keeps stop risk bounded while using leverage for capital efficiency", () => {
  assert.equal(HTE31_PAPER_POSITION_POLICY.minimumRiskRate, 0.03);
  assert.equal(HTE31_PAPER_POSITION_POLICY.targetRiskRate, 0.04);
  assert.equal(HTE31_PAPER_POSITION_POLICY.maximumRiskRate, 0.05);
  assert.equal(HTE31_PAPER_POSITION_POLICY.minimumTp2NetProfitUsdt, 50);
  assert.equal(HTE31_PAPER_POSITION_POLICY.maximumMarketRiskReward, 20);
  assert.equal(HTE31_PAPER_POSITION_POLICY.preferredMarginAllocationRate, 0.15);
  assert.equal(HTE31_PAPER_POSITION_POLICY.maximumMarginAllocationRate, 0.30);
  assert.equal(HTE31_PAPER_POSITION_POLICY.maximumLeverage, 50);
});
