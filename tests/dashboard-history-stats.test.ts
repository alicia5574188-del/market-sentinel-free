import test from "node:test";
import assert from "node:assert/strict";
import { calculateContractV2HistoryStats, type ContractV2HistoryRow } from "../lib/dashboard-history-stats.ts";

function row(index: number): ContractV2HistoryRow {
  const win = index % 3 === 0;
  return {
    confidence: 72,
    grossMovePct: win ? 1.8 : -0.9,
    estimatedCostPct: 0.08,
    netMovePct: win ? 1.72 : -0.98,
    netPnlUsdt: win ? 4 : -2,
    mfePct: win ? 1.9 : 0.2,
    maePct: win ? -0.3 : -1,
    holdMinutes: 30,
    exitCode: win ? "take_profit" : "stop_loss",
  };
}

test("dashboard statistics count all closed trades beyond the recent 120-row UI window", () => {
  const rows = Array.from({ length: 137 }, (_, index) => row(index));
  const stats = calculateContractV2HistoryStats(rows, 1);
  assert.equal(stats.closed, 137);
  assert.equal(stats.open, 1);
  assert.equal(stats.emitted, 138);
  assert.equal(stats.targetExits + stats.stopExits, 137);
});

test("full-history statistics keep breakeven exits in the stop/protection bucket", () => {
  const rows = [
    row(0),
    { ...row(1), netMovePct: -0.08, netPnlUsdt: -0.2, exitCode: "breakeven" },
  ];
  const stats = calculateContractV2HistoryStats(rows, 0);
  assert.equal(stats.closed, 2);
  assert.equal(stats.targetExits, 1);
  assert.equal(stats.stopExits, 1);
});
