import assert from "node:assert/strict";
import test from "node:test";
import { buildHte31OptimizationAnalysis, type Hte31OptimizationTrade } from "../lib/hte31-optimization-core.ts";

function trade(index: number, r: number, overrides: Partial<Hte31OptimizationTrade> = {}): Hte31OptimizationTrade {
  const entryPrice = 100;
  const initialStopPrice = 99;
  const riskBudgetUsdt = 40;
  return {
    id: `t-${index}`,
    symbol: "BTC_USDT",
    traderId: "dennis_trend",
    setupId: "trend_breakout",
    side: "LONG",
    assetRegime: "trend_up",
    entryPrice,
    initialStopPrice,
    riskBudgetUsdt,
    netPnlUsdt: r * riskBudgetUsdt,
    exitCode: r < 0 ? "stop_loss" : "take_profit",
    mfePct: r > 0 ? Math.max(0.5, r) : 0.25,
    maePct: r < 0 ? 1 : 0.2,
    holdMinutes: 90,
    target1HitAt: r > 0 ? 1_000 + index : null,
    stopRecovery: r < 0 ? false : null,
    postExitLabel: "退出合理",
    exitEfficiency: 70,
    exitAt: 10_000 + index,
    ...overrides,
  };
}

test("8-trade 50% win-rate negative payoff is diagnosed instead of hidden by win rate", () => {
  const rows = [0.4, -1, 0.35, -1, 0.45, -1, 0.3, -1].map((r, index) => trade(index, r));
  const report = buildHte31OptimizationAnalysis(rows);
  assert.equal(report.overall.samples, 8);
  assert.equal(report.overall.winRate, 0.5);
  assert.ok(report.overall.expectancyR < 0);
  assert.ok((report.overall.profitFactor ?? 99) < 1);
  assert.ok((report.overall.payoffRatio ?? 99) < 1);
  assert.ok(report.findings.some((item) => item.code === "negative_expectancy" && item.priority === "high"));
  assert.ok(report.findings.some((item) => item.code === "payoff_structure" && item.priority === "high"));
});

test("negative trader/regime/direction cells are isolated without globally penalizing profitable cells", () => {
  const bad = [-1, -0.8, -0.7, 0.1].map((r, index) => trade(index, r, { traderId: "raschke_pullback", setupId: "trend_pullback", assetRegime: "range", side: "SHORT" }));
  const good = [1.5, 1.2, -0.5, 1].map((r, index) => trade(index + 10, r));
  const report = buildHte31OptimizationAnalysis([...bad, ...good]);
  const badCell = report.cells.find((item) => item.id === "raschke_pullback|range|SHORT");
  const goodCell = report.cells.find((item) => item.id === "dennis_trend|trend_up|LONG");
  assert.equal(badCell?.performanceGate.state, "PAUSED");
  assert.equal(goodCell?.performanceGate.state, "ACTIVE");
  assert.ok(report.findings.some((item) => item.code === "negative_cell" && item.evidence.includes("raschke_pullback|range|SHORT")));
});

test("repeated sustained stop recovery is surfaced as an exit experiment, not an entry-frequency cut", () => {
  const rows = [-1, -1, -1, 1.6, 1.4, 1.2].map((r, index) => trade(index, r, r < 0 ? { stopRecovery: index < 2 } : {}));
  const report = buildHte31OptimizationAnalysis(rows);
  const stopFinding = report.findings.find((item) => item.code === "stop_recovery");
  assert.ok(stopFinding);
  assert.match(stopFinding?.action ?? "", /止损/);
  assert.doesNotMatch(stopFinding?.action ?? "", /提高入场门槛/);
});

test("healthy positive expectancy does not manufacture a negative-expectancy finding", () => {
  const rows = [1.5, -0.7, 1.3, -0.6, 1.1, -0.5, 1.4, -0.6].map((r, index) => trade(index, r));
  const report = buildHte31OptimizationAnalysis(rows);
  assert.ok(report.overall.expectancyR > 0);
  assert.ok((report.overall.profitFactor ?? 0) > 1);
  assert.ok(!report.findings.some((item) => item.code === "negative_expectancy"));
});
