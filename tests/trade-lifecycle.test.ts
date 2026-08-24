import test from "node:test";
import assert from "node:assert/strict";
import { accumulateMemory, evaluatePosition, experienceEdge, type ExitAnalysisInput, type TradePositionSnapshot } from "../lib/trade-lifecycle.ts";

function position(patch: Partial<TradePositionSnapshot> = {}): TradePositionSnapshot {
  return {
    id: "trade-1",
    symbol: "SOL_USDT",
    side: "LONG",
    entryAt: 1_700_000_000_000,
    entryPrice: 100,
    initialStopPrice: 98,
    currentStopPrice: 98,
    takeProfit1Price: 102,
    takeProfit2Price: 104,
    target1HitAt: null,
    maxHoldingMinutes: 120,
    maxPriceSeen: 100,
    minPriceSeen: 100,
    adverseFlowCount: 0,
    confidence: 78,
    regime: "上升趋势 · 常态波动",
    ...patch,
  };
}

function market(price: number, patch: Partial<ExitAnalysisInput> = {}): ExitAnalysisInput {
  return {
    observedAt: 1_700_000_600_000,
    price,
    directionalScore: 0.3,
    confirmationCount: 4,
    macroEventRisk: 0.1,
    metrics: [],
    roundTripCostBps: 8,
    ...patch,
  };
}

test("到达 TP1 只把保护止损移到入场价，不提前完成订单", () => {
  const result = evaluatePosition(position(), market(102.1));
  assert.equal(result.close, false);
  assert.equal(result.target1ReachedNow, true);
  assert.equal(result.currentStopPrice, 100);
  assert.ok(result.target1HitAt);
});

test("到达 TP2 后按计划完成平仓", () => {
  const result = evaluatePosition(position(), market(104.1));
  assert.equal(result.close, true);
  assert.equal(result.exitCode, "take_profit");
  assert.ok(result.netMovePct > 3.9);
});

test("轮询间隔内 5m 高低价触发目标或止损时不会漏掉出场", () => {
  const target = evaluatePosition(position(), market(101, { highPrice: 104.2, lowPrice: 100.5 }));
  assert.equal(target.exitCode, "take_profit");
  assert.equal(target.exitPrice, 104);
  const stop = evaluatePosition(position(), market(99, { highPrice: 100.2, lowPrice: 97.8 }));
  assert.equal(stop.exitCode, "stop_loss");
  assert.equal(stop.exitPrice, 98);
});

test("同一 5m 窗口同时跨过止损与 TP2 时按保守止损归因", () => {
  const result = evaluatePosition(position(), market(101, { highPrice: 104.2, lowPrice: 97.8 }));
  assert.equal(result.exitCode, "stop_loss");
  assert.equal(result.exitPrice, 98);
  assert.match(result.exitReason ?? "", /保守原则/);
});

test("触及初始结构止损时完成订单，不以时间到期代替平仓", () => {
  const result = evaluatePosition(position(), market(97.9));
  assert.equal(result.close, true);
  assert.equal(result.exitCode, "stop_loss");
  assert.ok(result.maePct < 0);
});

test("TP1 后回到入场价按保本规则平仓", () => {
  const result = evaluatePosition(position({ currentStopPrice: 100, target1HitAt: 1_700_000_300_000, maxPriceSeen: 102.2 }), market(99.95));
  assert.equal(result.close, true);
  assert.equal(result.exitCode, "breakeven");
  assert.equal(result.exitPrice, 100);
  assert.equal(result.grossMovePct, 0);
  assert.equal(result.netMovePct, -0.08);
});

test("现货流与独立结构源必须连续两轮反向才平仓", () => {
  const adverse = [
    { key: "spot-flow", label: "现货主动流", score: -0.5, detail: "Spot CVD 转负", available: true },
    { key: "order-book", label: "订单簿深度", score: -0.4, detail: "卖盘占优", available: true },
  ];
  const first = evaluatePosition(position(), market(100.2, { directionalScore: 0.05, confirmationCount: 1, metrics: adverse }));
  assert.equal(first.close, false);
  assert.equal(first.adverseFlowCount, 1);
  const second = evaluatePosition(position({ adverseFlowCount: first.adverseFlowCount }), market(100.1, { observedAt: 1_700_000_900_000, directionalScore: 0.04, confirmationCount: 1, metrics: adverse }));
  assert.equal(second.close, true);
  assert.equal(second.exitCode, "flow_reversal");
});

test("达到最长持仓时间且未到 TP2 时按时间规则退出", () => {
  const result = evaluatePosition(position(), market(101, { observedAt: 1_700_007_300_000, directionalScore: 0.1, confirmationCount: 1 }));
  assert.equal(result.close, true);
  assert.equal(result.exitCode, "timeout");
});

test("完成订单会累计记忆，少样本经验必须经过贝叶斯收缩", () => {
  const first = accumulateMemory(null, { netMovePct: 1.2, mfePct: 1.6, maePct: -0.3, exitCode: "take_profit" });
  const second = accumulateMemory(first, { netMovePct: -0.8, mfePct: 0.2, maePct: -0.9, exitCode: "stop_loss" });
  assert.equal(second.sampleCount, 2);
  assert.equal(second.wins, 1);
  assert.equal(second.losses, 1);
  assert.equal(second.targetExits, 1);
  assert.equal(second.stopExits, 1);
  const edge = experienceEdge({ sampleCount: 2, wins: 1, losses: 1, bayesianWinRate: 0.5, averageNetPct: second.averageNetPct, averageMfePct: second.averageMfePct, averageMaePct: second.averageMaePct, profitFactor: 1.5, stopRate: 0.5 });
  assert.ok(Math.abs(edge) < 0.1);
});
