import assert from "node:assert/strict";
import test from "node:test";
import { calculateStrategyStatistics, evaluateStrategyPromotion } from "../lib/strategy-promotion.ts";

const start = Date.UTC(2026, 0, 1);

function samples(values: number[], regime = "trend") {
  return values.map((netMovePct, index) => ({ netMovePct, exitAt: start + index * 60_000, regime: index % 2 ? regime : "range" }));
}

test("ten profitable-looking samples cannot promote a strategy", () => {
  const stats = calculateStrategyStatistics(samples([0.4, -0.2, 0.5, 0.3, -0.2, 0.6, -0.1, 0.4, 0.2, 0.3]));
  const promotion = evaluateStrategyPromotion("trend_pullback", stats);
  assert.equal(promotion.eligible, false);
  assert.equal(promotion.status, "collecting");
  assert.match(promotion.reasons.join("；"), /10\/50/);
});

test("relative-strength strategy requires eighty complete samples", () => {
  const values = Array.from({ length: 60 }, (_, index) => index % 4 === 0 ? -0.2 : 0.35);
  const stats = calculateStrategyStatistics(samples(values));
  const promotion = evaluateStrategyPromotion("relative_strength", stats);
  assert.equal(promotion.eligible, false);
  assert.equal(promotion.requiredSamples, 80);
});

test("promotion requires positive recent out-of-sample-like window and controlled drawdown", () => {
  const strong = Array.from({ length: 60 }, (_, index) => index % 4 === 0 ? -0.18 : 0.32);
  const stats = calculateStrategyStatistics(samples(strong));
  const promotion = evaluateStrategyPromotion("trend_pullback", stats);
  assert.equal(stats.sampleCount, 60);
  assert.equal(promotion.eligible, true);
  assert.equal(promotion.status, "candidate");
});

test("large loss streak blocks promotion even when average return stays positive", () => {
  const values = [
    ...Array.from({ length: 48 }, () => 0.35),
    -0.2, -0.2, -0.2, -0.2, -0.2, -0.2,
    ...Array.from({ length: 10 }, () => 0.35),
  ];
  const stats = calculateStrategyStatistics(samples(values));
  const promotion = evaluateStrategyPromotion("volatility_breakout", stats);
  assert.ok(stats.averageNetPct != null && stats.averageNetPct > 0);
  assert.equal(promotion.eligible, false);
  assert.match(promotion.reasons.join("；"), /连续亏损/);
});
