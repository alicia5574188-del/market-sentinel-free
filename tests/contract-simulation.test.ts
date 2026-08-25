import test from "node:test";
import assert from "node:assert/strict";
import {
  assessTakeProfitViability,
  buildContractPlan,
  calculateContractPnl,
  minimumTp2NetProfitUsdt,
  MIN_TP2_NET_PROFIT_EQUITY_RATE,
} from "../lib/contract-simulation.ts";

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

test("TP2最低净利润按当前账户权益1.5%计算", () => {
  assert.equal(MIN_TP2_NET_PROFIT_EQUITY_RATE, 0.015);
  assert.equal(minimumTp2NetProfitUsdt(1000), 15);
  assert.equal(minimumTp2NetProfitUsdt(500), 7.5);
  assert.equal(minimumTp2NetProfitUsdt(1250), 18.75);
});

test("QQQX式微小TP2即使使用3倍杠杆也被权益比例净利润闸门拒绝", () => {
  const result = assessTakeProfitViability({
    side: "SHORT",
    entryPrice: 711.08,
    takeProfitPrice: 709.830685714286,
    notionalUsdt: 595.65791728,
    accountEquityUsdt: 1000,
    roundTripCostBps: 8,
  });
  assert.equal(result.minimumNetProfitUsdt, 15);
  assert.equal(result.netPnlUsdt, 0.57);
  assert.equal(result.passed, false);
});

test("权益变化时TP2净利润门槛同步变化而不是固定15U", () => {
  const fiveHundredEquity = assessTakeProfitViability({
    side: "LONG",
    entryPrice: 100,
    takeProfitPrice: 101.58,
    notionalUsdt: 500,
    accountEquityUsdt: 500,
    roundTripCostBps: 8,
  });
  const oneThousandEquity = assessTakeProfitViability({
    side: "LONG",
    entryPrice: 100,
    takeProfitPrice: 101.58,
    notionalUsdt: 1000,
    accountEquityUsdt: 1000,
    roundTripCostBps: 8,
  });
  assert.equal(fiveHundredEquity.minimumNetProfitUsdt, 7.5);
  assert.equal(fiveHundredEquity.netPnlUsdt, 7.5);
  assert.equal(fiveHundredEquity.passed, true);
  assert.equal(oneThousandEquity.minimumNetProfitUsdt, 15);
  assert.equal(oneThousandEquity.netPnlUsdt, 15);
  assert.equal(oneThousandEquity.passed, true);
});
