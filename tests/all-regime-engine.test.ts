import assert from "node:assert/strict";
import test from "node:test";
import { ALL_REGIME_STRATEGIES, detectAllRegimeRoutes, dominantAllRegimeEnvironment } from "../lib/all-regime-engine.ts";

const candle = (index: number, close: number, spread = 1) => ({ time: index * 300, open: close - 0.2, high: close + spread / 2, low: close - spread / 2, close });

test("the system owns four distinct project strategies", () => {
  assert.deepEqual(ALL_REGIME_STRATEGIES.map((row) => row.name), ["势承", "衡返", "压跃", "竭转"]);
  assert.equal(new Set(ALL_REGIME_STRATEGIES.map((row) => row.environment)).size, 4);
});

test("trend ownership remains available without an entry trigger", () => {
  const rows = Array.from({ length: 60 }, (_, index) => candle(index, 100 + index * 0.35 + Math.sin(index) * 0.08));
  assert.equal(dominantAllRegimeEnvironment(rows), "TREND");
});

test("a completed compression release creates a pressure route", () => {
  const rows = Array.from({ length: 50 }, (_, index) => candle(index, 100 + Math.sin(index) * (index < 31 ? 0.7 : 0.12), index < 31 ? 1.4 : 0.35));
  rows.push({ time: 50 * 300, open: 100.05, low: 99.95, high: 101.5, close: 101.35 });
  const route = detectAllRegimeRoutes(rows).find((row) => row.strategyId === "pressure_release");
  assert.ok(route);
  assert.equal(route.side, "LONG");
  assert.ok(route.invalidationPrice < route.triggerPrice);
  assert.ok(route.profitArmPrice > route.triggerPrice);
});
