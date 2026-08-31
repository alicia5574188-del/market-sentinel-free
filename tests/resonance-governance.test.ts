import assert from "node:assert/strict";
import test from "node:test";
import {
  RESONANCE_REVALIDATION_MS,
  RESONANCE_V1_STARTED_AT,
  buildResonancePerformanceSample,
  evaluateResonanceCellGate,
  resonanceCellRows,
  type ResonanceTradeSample,
} from "../lib/resonance-governance.ts";

function trade(input: Partial<ResonanceTradeSample> = {}): ResonanceTradeSample {
  return {
    entryAt: RESONANCE_V1_STARTED_AT + 60_000,
    exitAt: RESONANCE_V1_STARTED_AT + 120_000,
    traderId: "raschke_pullback",
    assetRegime: "trend_down",
    side: "SHORT",
    netPnlUsdt: -40,
    riskBudgetUsdt: 40,
    exitCode: "stop_loss",
    ...input,
  };
}

test("legacy losses stay in history but cannot pause Resonance v1", () => {
  const legacy = Array.from({ length: 12 }, (_, index) => trade({
    entryAt: RESONANCE_V1_STARTED_AT - (index + 2) * 60_000,
    exitAt: RESONANCE_V1_STARTED_AT - (index + 1) * 60_000,
  }));
  const gate = evaluateResonanceCellGate(
    legacy,
    "raschke_pullback",
    "trend_down",
    "SHORT",
    RESONANCE_V1_STARTED_AT + 60 * 60_000,
  );
  assert.equal(gate.state, "ACTIVE");
  assert.equal(gate.sampleCount, 0);
  assert.match(gate.reason, /旧版本记录只作历史参考/);
});

test("a negative current-version cell pauses temporarily then automatically re-enters sampling", () => {
  const rows = [0, 1, 2].map((index) => trade({
    entryAt: RESONANCE_V1_STARTED_AT + (index + 1) * 60_000,
    exitAt: RESONANCE_V1_STARTED_AT + (index + 2) * 60_000,
  })).reverse();
  const latestExit = rows[0].exitAt!;
  const paused = evaluateResonanceCellGate(rows, "raschke_pullback", "trend_down", "SHORT", latestExit + 60_000);
  assert.equal(paused.state, "PAUSED");
  assert.equal(paused.sampleCount, 3);
  assert.equal(paused.retryAfter, latestExit + RESONANCE_REVALIDATION_MS);

  const revalidating = evaluateResonanceCellGate(
    rows,
    "raschke_pullback",
    "trend_down",
    "SHORT",
    latestExit + RESONANCE_REVALIDATION_MS + 1,
  );
  assert.equal(revalidating.state, "ACTIVE");
  assert.equal(revalidating.revalidating, true);
  assert.match(revalidating.reason, /重新取样/);
});

test("current performance sample excludes legacy and unrelated cells", () => {
  const rows = [
    trade({ netPnlUsdt: 80 }),
    trade({ entryAt: RESONANCE_V1_STARTED_AT - 1, netPnlUsdt: -400 }),
    trade({ traderId: "dennis_trend", netPnlUsdt: -40 }),
    trade({ assetRegime: "trend_up", netPnlUsdt: -40 }),
  ];
  const cell = resonanceCellRows(rows, "raschke_pullback", "trend_down", "SHORT");
  const sample = buildResonancePerformanceSample(cell);
  assert.equal(cell.length, 1);
  assert.equal(sample?.sampleCount, 1);
  assert.equal(sample?.wins, 1);
  assert.equal(sample?.expectancyR, 2);
});
