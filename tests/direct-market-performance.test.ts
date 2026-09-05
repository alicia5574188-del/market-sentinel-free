import assert from "node:assert/strict";
import test from "node:test";
import { buildDirectSetupPerformance } from "../lib/direct-market-performance.ts";

function trade(setupId: string, index: number, resultR: number) {
  return {
    setupId,
    status: "closed" as const,
    entryAt: index * 10,
    exitAt: index * 10 + 5,
    exitCode: resultR === 0 ? "breakeven" : "target",
    netPnlUsdt: resultR * 10,
    riskBudgetUsdt: 10,
  };
}

test("per-setup performance identifies contributors and drag without inventing evidence", () => {
  const trades = [
    ...Array.from({ length: 8 }, (_, index) => trade("VOLUME_FORCE_FAILED_BREAKOUT", index, index < 4 ? 2 : -1)),
    ...Array.from({ length: 8 }, (_, index) => trade("EXHAUSTION_REVERSAL", index + 20, index < 2 ? 1 : -1)),
  ];
  const rows = buildDirectSetupPerformance(trades);
  assert.equal(rows.find((row) => row.setup === "VOLUME_FORCE_FAILED_BREAKOUT")?.status, "发力");
  assert.equal(rows.find((row) => row.setup === "VOLUME_FORCE_FAILED_BREAKOUT")?.averageWinR, 2);
  assert.equal(rows.find((row) => row.setup === "VOLUME_FORCE_FAILED_BREAKOUT")?.averageLossR, -1);
  assert.equal(rows.find((row) => row.setup === "VOLUME_FORCE_FAILED_BREAKOUT")?.realizedPayoffRatio, 2);
  assert.equal(rows.find((row) => row.setup === "EXHAUSTION_REVERSAL")?.status, "拖后腿");
  assert.equal(rows.find((row) => row.setup === "HISTORICAL_ANALOG")?.status, "暂无机会");
});

test("windowed setup performance uses exits for results and entries for openings", () => {
  const rows = buildDirectSetupPerformance([
    trade("MULTI_TIMEFRAME_RESONANCE", 1, 2),
    trade("MULTI_TIMEFRAME_RESONANCE", 5, -1),
  ], { from: 40, to: 80 });
  const resonance = rows.find((row) => row.setup === "MULTI_TIMEFRAME_RESONANCE")!;
  assert.equal(resonance.openedTrades, 1);
  assert.equal(resonance.sampleCount, 1);
  assert.equal(resonance.averageR, -1);
});
