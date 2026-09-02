import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHte31PaperPosition,
  hte31PaperPortfolioBlockReason,
  HTE31_PAPER_PORTFOLIO_POLICY,
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
  assert.ok(result.marginUsdt <= 350.01);
  assert.ok(result.leverage >= 3);
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

test("fee-heavy narrow stop stays inside the 50x and 35% margin safety caps", () => {
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
  assert.ok(result.plannedRiskUsdt >= 31.49 && result.plannedRiskUsdt <= 31.51);
  assert.equal(result.marginUsdt, 350);
  assert.equal(result.riskReward, 4);
  assert.ok(result.plannedTp2NetProfitUsdt >= 50);
});

test("illiquid setup is rejected when its leverage cap cannot express minimum account risk", () => {
  const result = buildHte31PaperPosition(baseInput({
    stopLossPrice: 99.90,
    originalTakeProfit2Price: 101,
    liquidityVolumeUsd: 12_000_000,
    atrPct: 0.4,
  }));
  assert.equal(result.leverageCap, 15);
  assert.equal(result.accepted, false);
  assert.match(result.reason, /低于 30\.00U/);
});

test("paper sizing keeps risk bounded while market targets may range from 50U to large runners", () => {
  assert.equal(HTE31_PAPER_POSITION_POLICY.minimumRiskRate, 0.03);
  assert.equal(HTE31_PAPER_POSITION_POLICY.targetRiskRate, 0.04);
  assert.equal(HTE31_PAPER_POSITION_POLICY.maximumRiskRate, 0.05);
  assert.equal(HTE31_PAPER_POSITION_POLICY.minimumTp2NetProfitUsdt, 50);
  assert.equal(HTE31_PAPER_POSITION_POLICY.maximumMarketRiskReward, 20);
  assert.equal(HTE31_PAPER_POSITION_POLICY.targetMarginAllocationRate, 0.08);
  assert.equal(HTE31_PAPER_POSITION_POLICY.maximumMarginAllocationRate, 0.35);
  assert.equal(HTE31_PAPER_POSITION_POLICY.maximumLeverage, 50);
});

test("paper portfolio permits five diversified learning positions inside a 20% stop-risk envelope", () => {
  assert.equal(HTE31_PAPER_PORTFOLIO_POLICY.maxOpenPositions, 5);
  assert.equal(HTE31_PAPER_PORTFOLIO_POLICY.maxSameSidePositions, 3);
  assert.equal(HTE31_PAPER_PORTFOLIO_POLICY.maximumTotalPlannedRiskRate, 0.20);
  const open = [
    { side: "LONG" as const, riskBudgetUsdt: 40 },
    { side: "SHORT" as const, riskBudgetUsdt: 40 },
    { side: "LONG" as const, riskBudgetUsdt: 40 },
    { side: "SHORT" as const, riskBudgetUsdt: 40 },
  ];
  assert.equal(hte31PaperPortfolioBlockReason({ open, nextSide: "LONG", nextRiskUsdt: 40, accountEquityUsdt: 1_000 }), null);
  assert.match(hte31PaperPortfolioBlockReason({ open: [...open, { side: "LONG", riskBudgetUsdt: 40 }], nextSide: "SHORT", nextRiskUsdt: 30, accountEquityUsdt: 1_000 }) ?? "", /最多 5 笔/);
  assert.match(hte31PaperPortfolioBlockReason({ open: open.slice(0, 3), nextSide: "LONG", nextRiskUsdt: 81, accountEquityUsdt: 1_000 }) ?? "", /20% 上限/);
  assert.match(hte31PaperPortfolioBlockReason({ open: [{ side: "LONG", riskBudgetUsdt: 30 }, { side: "LONG", riskBudgetUsdt: 30 }, { side: "LONG", riskBudgetUsdt: 30 }], nextSide: "LONG", nextRiskUsdt: 30, accountEquityUsdt: 1_000 }) ?? "", /同方向同时最多 3 笔/);
});
