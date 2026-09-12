import assert from "node:assert/strict";
import test from "node:test";
import { ALL_REGIME_STRATEGIES, detectAllRegimeRoutes, dominantAllRegimeEnvironment } from "../lib/all-regime-engine.ts";

const candle = (index: number, close: number, spread = 1) => ({
  time: index * 300, open: close - 0.2, high: close + spread / 2, low: close - spread / 2, close,
});

test("the system owns six state-conditioned mechanisms across three structural route classes", () => {
  assert.deepEqual(ALL_REGIME_STRATEGIES.map((row) => row.name), ["势承", "潮补", "静移", "冲衡", "脉折", "潮接"]);
  assert.equal(new Set(ALL_REGIME_STRATEGIES.map((row) => row.environment)).size, 3);
});

test("a completed impulse rejection creates the causal 冲衡 route", () => {
  const rows = Array.from({ length: 48 }, (_, index) => candle(index, 100 + Math.sin(index) * 0.08));
  rows.push({ time: 48 * 300, open: 100, high: 103.2, low: 99.8, close: 103 });
  rows.push({ time: 49 * 300, open: 103, high: 103.2, low: 101.5, close: 101.7 });
  const route = detectAllRegimeRoutes(rows).find((row) => row.strategyId === "impulse_recoil");
  assert.ok(route);
  assert.equal(route.version, 4);
  assert.equal(route.side, "SHORT");
  assert.ok(route.invalidationPrice > route.triggerPrice);
  assert.ok(route.profitArmPrice < route.triggerPrice);
});

test("a completed multi-bar extreme failure creates the 脉折 route", () => {
  const rows = Array.from({ length: 48 }, (_, index) => candle(index, 100 + Math.sin(index) * 0.05));
  for (let index = 48; index <= 56; index += 1) rows.push(candle(index, 100 + (index - 48) * 0.5));
  rows.push({ time: 57 * 300, open: 104, high: 105, low: 103.8, close: 104.7 });
  rows.push({ time: 58 * 300, open: 104.7, high: 105.5, low: 104, close: 105 });
  rows.push({ time: 59 * 300, open: 105, high: 105.1, low: 102.5, close: 103 });
  const route = detectAllRegimeRoutes(rows).find((row) => row.strategyId === "impulse_fold");
  assert.ok(route);
  assert.equal(route.version, 4);
  assert.equal(route.side, "SHORT");
  assert.equal(route.researchVariant, "impulse_fold:0");
});

test("a completed compressed directional migration creates the 静移 route", () => {
  const rows = Array.from({ length: 54 }, (_, index) => candle(index, 100 + Math.sin(index) * 0.04));
  for (let index = 54; index < 60; index += 1) {
    const close = 100 + (index - 53) * 0.12;
    rows.push({ time: index * 300, open: close - 0.08, high: close + 0.02, low: close - 0.12, close });
  }
  const route = detectAllRegimeRoutes(rows).find((row) => row.strategyId === "quiet_drift");
  assert.ok(route);
  assert.equal(route.side, "LONG");
  assert.equal(route.researchVariant, "quiet_drift:2");
});

test("trend ownership remains available without an entry trigger", () => {
  const rows = Array.from({ length: 60 }, (_, index) => candle(index, 100 + index * 0.35 + Math.sin(index) * 0.08));
  assert.equal(dominantAllRegimeEnvironment(rows), "TREND");
});
