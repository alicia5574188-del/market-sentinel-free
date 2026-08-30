import assert from "node:assert/strict";
import test from "node:test";
import { buildHte31Counterfactual } from "../lib/hte31-counterfactual.ts";
import type { Hte31Candle } from "../lib/hte31-types.ts";

const entryAt = Date.UTC(2026, 7, 30, 0, 0, 0);

function path(): Hte31Candle[] {
  const rows: Hte31Candle[] = [];
  for (let index = 0; index < 110; index += 1) {
    const minutes = index * 5;
    let close = 100;
    if (minutes <= 45) close = 100 + minutes / 45 * 0.9;
    else close = 100.9 - (minutes - 45) / 240 * 3.0;
    rows.push({
      time: Math.floor((entryAt + minutes * 60_000) / 1000),
      open: close + 0.02,
      high: close + 0.08,
      low: close - 0.08,
      close,
      volume: 1000,
    });
  }
  return rows;
}

test("counterfactual observer compares original and opposite direction without rewriting trade", () => {
  const report = buildHte31Counterfactual({
    side: "LONG",
    entryAt,
    entryPrice: 100,
    initialStopPrice: 99,
    exitAt: entryAt + 180 * 60_000,
    exitPrice: 99,
    exitCode: "stop_loss",
  }, path(), 8, entryAt + 9 * 60 * 60_000);
  assert.ok(report);
  const fourHour = report!.horizons.find((item) => item.minutes === 240)!;
  assert.ok(fourHour.originalR < 0);
  assert.ok(fourHour.oppositeR > 0);
  assert.ok(report!.reversals.some((item) => item.key === "after_half_r"));
  assert.ok(report!.reversals.some((item) => item.key === "after_stop"));
  assert.match(report!.summary, /原方向/);
  assert.match(report!.summary, /入场直接反向/);
});

test("counterfactual reversal starts after trigger candle instead of assuming impossible intrabar order", () => {
  const rows = path();
  const report = buildHte31Counterfactual({
    side: "LONG",
    entryAt,
    entryPrice: 100,
    initialStopPrice: 99,
  }, rows, 0, entryAt + 8 * 60 * 60_000)!;
  const half = report.reversals.find((item) => item.key === "after_half_r")!;
  assert.ok(half.triggeredAt > entryAt);
  assert.ok(half.observedMinutes > 0);
  assert.equal(half.side, "SHORT");
});
