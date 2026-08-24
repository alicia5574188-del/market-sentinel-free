import test from "node:test";
import assert from "node:assert/strict";
import { assessTakeProfitViability, buildContractPlan, calculateContractPnl, MIN_TP2_NET_PROFIT_USDT } from "../lib/contract-simulation.ts";

test("高流动性低波动合约按止损风险和20%保证金上限选择杠杆", () => {
  const plan = buildContractPlan({
    side: "LONG",
    entryPrice: 100,
    stopLossPrice: 99,
    atrPct: 0.7,
    dataQuality: 0.92,
    confidence: 82,
    liquidityVolumeUsd: 900_000_000,
    accountEquityUsdt: 1000,
    availableMarginUsdt: 1000,
    requestedRiskUsdt: 10,
  });
  assert.equal(plan.leverage, 5);
  assert.equal(plan.contractNotionalUsdt, 1000);
  assert.equal(plan.marginUsdt, 200);
  assert.equal(plan.plannedLossUsdt, 10);
  assert.ok(plan.estimatedLiquidationPrice < 99);
});

test("小币高波动时杠杆封顶并主动缩仓，不突破10U风险", () => {
  const plan = buildContractPlan({
    side: "SHORT",
    entryPrice: 10,
    stopLossPrice: 10.1,
    atrPct: 3.4,
    dataQuality: 0.9,
    confidence: 84,
    liquidityVolumeUsd: 8_000_000,
    accountEquityUsdt: 1000,
    availableMarginUsdt: 1000,
    requestedRiskUsdt: 10,
  });
  assert.equal(plan.leverage, 2);
  assert.equal(plan.marginUsdt, 200);
  assert.equal(plan.contractNotionalUsdt, 400);
  assert.ok(plan.plannedLossUsdt <= 4.000001);
  assert.ok(plan.estimatedLiquidationPrice > 10.1);
});

test("低数据质量把杠杆限制在3倍以内", () => {
  const plan = buildContractPlan({
    side: "LONG",
    entryPrice: 50,
    stopLossPrice: 49.5,
    atrPct: 0.5,
    dataQuality: 0.72,
    confidence: 78,
    liquidityVolumeUsd: 1_000_000_000,
    accountEquityUsdt: 1000,
    availableMarginUsdt: 1000,
    requestedRiskUsdt: 10,
  });
  assert.equal(plan.leverage, 3);
  assert.equal(plan.contractNotionalUsdt, 600);
  assert.match(plan.leverageReason, /质量\/可信度限制3x/);
});

test("合约盈亏金额强制扣除往返成本", () => {
  assert.deepEqual(calculateContractPnl(800, 1.25, 0.08), {
    grossPnlUsdt: 10,
    estimatedCostUsdt: 0.64,
    netPnlUsdt: 9.36,
  });
});

test("QQQX式微小TP2即使使用3倍杠杆也被15U净利润闸门拒绝", () => {
  const result = assessTakeProfitViability({
    side: "SHORT",
    entryPrice: 711.08,
    takeProfitPrice: 709.830685714286,
    notionalUsdt: 595.65791728,
    roundTripCostBps: 8,
  });
  assert.equal(result.minimumNetProfitUsdt, MIN_TP2_NET_PROFIT_USDT);
  assert.equal(result.netPnlUsdt, 0.57);
  assert.equal(result.passed, false);
});

test("预计TP2扣成本后达到15U才允许开仓", () => {
  const atThreshold = assessTakeProfitViability({
    side: "LONG",
    entryPrice: 100,
    takeProfitPrice: 101.58,
    notionalUsdt: 1000,
    roundTripCostBps: 8,
  });
  const worthwhileOneX = assessTakeProfitViability({
    side: "LONG",
    entryPrice: 100,
    takeProfitPrice: 111.75,
    notionalUsdt: 170,
    roundTripCostBps: 8,
  });
  assert.equal(atThreshold.netPnlUsdt, 15);
  assert.equal(atThreshold.passed, true);
  assert.ok(worthwhileOneX.netPnlUsdt > 15);
  assert.equal(worthwhileOneX.passed, true);
});
