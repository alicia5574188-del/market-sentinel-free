import assert from "node:assert/strict";
import test from "node:test";
import { ALL_REGIME_STRATEGIES, allRegimePaperApproved, detectAllRegimeRoutes,
  dominantAllRegimeEnvironment } from "../lib/all-regime-engine.ts";

const candle = (index: number, close: number, spread = 1) => ({
  time: index * 300, open: close - 0.2, high: close + spread / 2, low: close - spread / 2, close,
});

test("the system owns the five cross-market validated V5 mechanisms", () => {
  assert.deepEqual(ALL_REGIME_STRATEGIES.map((row) => row.name), ["界返", "渠破", "势回", "熊缩", "牛接"]);
  assert.equal(new Set(ALL_REGIME_STRATEGIES.map((row) => row.environment)).size, 3);
});

test("an unknown persisted strategy key fails closed instead of stopping the runtime", () => {
  assert.equal(allRegimePaperApproved("retired_strategy"), false);
});

test("a completed 48-bar downside break creates the causal 渠破 route", () => {
  const rows = Array.from({ length: 329 }, (_, index) => candle(index, 200 - index * 0.02, 0.2));
  rows.push(candle(329, rows.at(-1)!.close - 1, 0.2));
  const route = detectAllRegimeRoutes(rows, "BTC_USDT").find((row) => row.strategyId === "channel_break");
  assert.ok(route);
  assert.equal(route.version, 5);
  assert.equal(route.side, "SHORT");
  assert.ok(route.invalidationPrice > route.triggerPrice);
  assert.ok(route.profitArmPrice < route.triggerPrice);
  assert.equal(route.hardTarget, true);
});

test("trend ownership remains available without an entry trigger", () => {
  const rows = Array.from({ length: 60 }, (_, index) => candle(index, 100 + index * 0.35 + Math.sin(index) * 0.08));
  assert.equal(dominantAllRegimeEnvironment(rows), "TREND");
});
