import test from "node:test";
import assert from "node:assert/strict";
import { ADAPTIVE_LEARNING_FORWARD_EPOCH_MS } from "../lib/strategy-2-adaptive-learning.ts";
import { buildStrategy2LearningArena, type Strategy2ArenaTradeRow } from "../lib/strategy-2-learning-arena.ts";

function row(index: number, resultR: number, overrides: Partial<Strategy2ArenaTradeRow> = {}): Strategy2ArenaTradeRow {
  const plannedRiskPct = 1;
  return {
    id: `trade-${index}`,
    entryAt: ADAPTIVE_LEARNING_FORWARD_EPOCH_MS + index * 60_000 - 30_000,
    exitAt: ADAPTIVE_LEARNING_FORWARD_EPOCH_MS + index * 60_000,
    regime: "S2|P8_EXHAUSTION_REVERSAL|global:expansion|asset:expansion_up",
    side: "SHORT",
    netMovePct: resultR * plannedRiskPct,
    plannedRiskPct,
    netPnlUsdt: resultR * 10,
    exitCode: resultR > 0 ? "take_profit" : "stop_loss",
    target1HitAt: resultR > 0 ? ADAPTIVE_LEARNING_FORWARD_EPOCH_MS + index * 60_000 - 10_000 : null,
    mfePct: resultR > 0 ? Math.max(1, resultR) : 0.2,
    maePct: resultR < 0 ? resultR : -0.2,
    ...overrides,
  };
}

test("Learning Arena exposes rolling edge without changing trading authority", () => {
  const rows = Array.from({ length: 60 }, (_, index) => row(index, index < 40 ? -0.5 : 0.8));
  const arena = buildStrategy2LearningArena(rows, ADAPTIVE_LEARNING_FORWARD_EPOCH_MS + 10_000_000);

  assert.equal(arena.readOnly, true);
  assert.equal(arena.safety.changesTradingLogic, false);
  assert.equal(arena.safety.changesRisk, false);
  assert.equal(arena.safety.changesExecution, false);
  assert.equal(arena.champion.last20.sampleCount, 20);
  assert.ok((arena.champion.last20.expectancyR ?? 0) > 0);
  assert.ok((arena.champion.all.expectancyR ?? 0) < arena.champion.last20.expectancyR!);
  assert.equal(arena.learningProof.learningAlphaR, null);
  assert.equal(arena.learningProof.frozenBaseline, "NOT_RECORDED");
});

test("Learning Arena detects improving rolling edge from adjacent 20-trade windows", () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, index) => row(index, -0.6)),
    ...Array.from({ length: 20 }, (_, index) => row(index + 20, 0.6)),
  ];
  const arena = buildStrategy2LearningArena(rows);
  assert.equal(arena.trend.state, "IMPROVING");
  assert.ok((arena.trend.expectancyDeltaR ?? 0) > 1);
});

test("forward period delta is explicitly not presented as Learning Alpha", () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, index) => row(index, -0.4, {
      exitAt: ADAPTIVE_LEARNING_FORWARD_EPOCH_MS - (20 - index) * 60_000,
    })),
    ...Array.from({ length: 20 }, (_, index) => row(index + 20, 0.4)),
  ];
  const arena = buildStrategy2LearningArena(rows);
  assert.equal(arena.forwardEvidence.preForwardSampleCount, 20);
  assert.equal(arena.forwardEvidence.sampleCount, 20);
  assert.ok((arena.forwardEvidence.periodDeltaR ?? 0) > 0);
  assert.equal(arena.forwardEvidence.interpretation, "period_shift_only");
  assert.match(arena.forwardEvidence.note, /不等于 Learning Alpha/);
});

test("exit profile compares recent 50 with previous 50", () => {
  const rows = [
    ...Array.from({ length: 50 }, (_, index) => row(index, -0.5, { exitCode: "stop_loss" })),
    ...Array.from({ length: 50 }, (_, index) => row(index + 50, 0.5, { exitCode: "take_profit" })),
  ];
  const arena = buildStrategy2LearningArena(rows);
  const stop = arena.exits.find((item) => item.code === "stop_loss");
  const take = arena.exits.find((item) => item.code === "take_profit");
  assert.equal(stop?.recentCount, 0);
  assert.equal(stop?.previousCount, 50);
  assert.equal(take?.recentCount, 50);
  assert.equal(take?.previousCount, 0);
});

test("playbook scoreboard and heatmap preserve strategy and regime attribution", () => {
  const rows = [
    ...Array.from({ length: 8 }, (_, index) => row(index, 0.4)),
    ...Array.from({ length: 8 }, (_, index) => row(index + 8, -0.5, {
      regime: "S2|P6_LIQUIDATION_REVERSAL|global:leverage_liquidation|asset:leverage_liquidation",
      side: "LONG",
    })),
  ];
  const arena = buildStrategy2LearningArena(rows);
  assert.ok(arena.playbooks.some((item) => item.playbook === "P8_EXHAUSTION_REVERSAL"));
  assert.ok(arena.playbooks.some((item) => item.playbook === "P6_LIQUIDATION_REVERSAL"));
  assert.ok(arena.heatmap.some((item) => item.globalRegime === "leverage_liquidation" && item.playbook === "P6_LIQUIDATION_REVERSAL" && item.side === "LONG"));
});
