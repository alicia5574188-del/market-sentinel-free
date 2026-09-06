import assert from "node:assert/strict";
import test from "node:test";
import { buildBankruptcyReport, diagnoseClosedPosition, paperCycleSummary, recordCycleTrade, startPaperCycle } from "../lib/paper-cycle.ts";
import type { PaperPosition } from "../lib/liquidity-core.ts";

function closed(patch: Partial<PaperPosition> = {}): PaperPosition {
  return {
    id: "SOL_USDT:1", symbol: "SOL_USDT", side: "LONG", scenario: "BREAKOUT",
    entryAt: 1_000, exitAt: 121_000, entryPrice: 100, exitPrice: 102,
    initialStop: 95, currentStop: 95, currentTarget: 110, plannedRisk: 20,
    notional: 1_000, targetScore: 2, status: "CLOSED", realizedPnl: 18.2,
    feesAndSlippage: 1.8, maxFavorablePrice: 105, maxAdversePrice: 98,
    exitReason: "TARGET_ABSORBED", ...patch,
  };
}

test("closed-order diagnostics preserve direction, excursion, costs and target progress", () => {
  const long = diagnoseClosedPosition(closed());
  assert.equal(long.directionCorrectAtExit, true);
  assert.equal(long.feeCoveringMove, true);
  assert.equal(long.holdingSeconds, 120);
  assert.ok(Math.abs(long.mfeRate - 0.05) < 1e-9);
  assert.ok(Math.abs(long.maeRate - 0.02) < 1e-9);
  assert.ok(Math.abs(long.targetProgress - 0.5) < 1e-9);

  const short = diagnoseClosedPosition(closed({ id: "BTC_USDT:2", symbol: "BTC_USDT", side: "SHORT",
    entryPrice: 100, exitPrice: 98, initialStop: 105, currentStop: 105, currentTarget: 90,
    maxFavorablePrice: 95, maxAdversePrice: 102 }));
  assert.ok(Math.abs(short.mfeRate - 0.05) < 1e-9);
  assert.ok(Math.abs(short.maeRate - 0.02) < 1e-9);
});

test("bankruptcy report is a detailed permanent analysis package", () => {
  let cycle = startPaperCycle(1_000, 1_000, 3);
  cycle = recordCycleTrade(cycle, closed(), 900);
  cycle = recordCycleTrade(cycle, closed({ id: "ETH_USDT:2", symbol: "ETH_USDT", side: "SHORT", scenario: "RANGE",
    entryAt: 200_000, exitAt: 220_000, entryPrice: 100, exitPrice: 101,
    initialStop: 103, currentStop: 103, currentTarget: 95, maxFavorablePrice: 99.9, maxAdversePrice: 101,
    realizedPnl: -11.8, exitReason: "STRUCTURAL_STOP" }), 888.2);
  const report = buildBankruptcyReport(cycle, 300_000, 299);
  assert.equal(report.cycleNumber, 3);
  assert.equal(report.performance.trades, 2);
  assert.equal(report.performance.costs, 3.6);
  assert.equal(report.exits.underOneMinute, 1);
  assert.equal(report.breakdown.symbols.SOL_USDT.trades, 1);
  assert.equal(report.breakdown.scenarios.RANGE.trades, 1);
  assert.equal(report.trades.length, 2);
  assert.ok(report.rootCauses.length > 0);
});

test("current cycle summary exposes only aggregate state", () => {
  const summary = paperCycleSummary(startPaperCycle(1_000, 889, 1), 850);
  assert.deepEqual({ ...summary, drawdownRate: 0 }, { number: 1, startedAt: 1_000, startingEquity: 889, currentEquity: 850,
    bankruptcyLine: 300, peakEquity: 889, trades: 0, drawdownRate: 0 });
  assert.ok(Math.abs(summary.drawdownRate - 39 / 889) < 1e-12);
});
