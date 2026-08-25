import assert from "node:assert/strict";
import test from "node:test";
import { calculateStrategyStatistics, evaluateStrategyPromotion } from "../lib/strategy-promotion.ts";

const start = Date.UTC(2026, 0, 1);
const day = 24 * 60 * 60_000;

function samples(values: number[], regime = "trend", spreadDays = 1) {
  return values.map((netMovePct, index) => ({
    netMovePct,
    exitAt: start + (index % spreadDays) * day + Math.floor(index / spreadDays) * 60_000,
    regime: index % 2 ? regime : "range",
  }));
}

test("ten profitable-looking samples cannot promote a strategy", () => {
  const stats = calculateStrategyStatistics(samples([0.4, -0.2, 0.5, 0.3, -0.2, 0.6, -0.1, 0.4, 0.2, 0.3], "trend", 5));
  const promotion = evaluateStrategyPromotion("trend_pullback", stats);
  assert.equal(promotion.eligible, false);
  assert.equal(promotion.status, "collecting");
  assert.match(promotion.reasons.join("；"), /10\/50/);
});

test("fifty trades concentrated in one day cannot masquerade as robust evidence", () => {
  const values = Array.from({ length: 55 }, (_, index) => index % 4 === 0 ? -0.15 : 0.30);
  const stats = calculateStrategyStatistics(samples(values, "trend", 1));
  const promotion = evaluateStrategyPromotion("trend_pullback", stats);
  assert.equal(stats.activeDayCount, 1);
  assert.equal(promotion.eligible, false);
  assert.match(promotion.reasons.join("；"), /有效交易日 1\/7/);
});

test("relative-strength strategy requires eighty samples and ten active days", () => {
  const values = Array.from({ length: 60 }, (_, index) => index % 4 === 0 ? -0.2 : 0.35);
  const stats = calculateStrategyStatistics(samples(values, "trend", 10));
  const promotion = evaluateStrategyPromotion("relative_strength", stats);
  assert.equal(promotion.eligible, false);
  assert.equal(promotion.requiredSamples, 80);
  assert.equal(promotion.requiredActiveDays, 10);
});

test("promotion requires positive recent window, controlled drawdown and multi-day evidence", () => {
  const strong = Array.from({ length: 60 }, (_, index) => index % 4 === 0 ? -0.18 : 0.32);
  const stats = calculateStrategyStatistics(samples(strong, "trend", 8));
  const promotion = evaluateStrategyPromotion("trend_pullback", stats);
  assert.equal(stats.sampleCount, 60);
  assert.ok(stats.activeDayCount >= 7);
  assert.equal(promotion.eligible, true);
  assert.equal(promotion.status, "candidate");
});

test("no-loss sample set is not rejected merely because profit factor is mathematically infinite", () => {
  const values = Array.from({ length: 55 }, () => 0.22);
  const stats = calculateStrategyStatistics(samples(values, "trend", 8));
  const promotion = evaluateStrategyPromotion("trend_pullback", stats);
  assert.equal(stats.profitFactor, null);
  assert.doesNotMatch(promotion.reasons.join("；"), /Profit Factor/);
});

test("large loss streak blocks promotion even when average return stays positive", () => {
  const values = [
    ...Array.from({ length: 48 }, () => 0.35),
    -0.2, -0.2, -0.2, -0.2, -0.2, -0.2,
    ...Array.from({ length: 10 }, () => 0.35),
  ];
  const stats = calculateStrategyStatistics(samples(values, "compression", 8));
  const promotion = evaluateStrategyPromotion("volatility_breakout", stats);
  assert.ok(stats.averageNetPct != null && stats.averageNetPct > 0);
  assert.equal(promotion.eligible, false);
  assert.match(promotion.reasons.join("；"), /连续亏损/);
});
