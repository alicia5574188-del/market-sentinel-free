import assert from "node:assert/strict";
import test from "node:test";
import { ALL_REGIME_STRATEGIES, detectAllRegimeRoutes, dominantAllRegimeEnvironment } from "../lib/all-regime-engine.ts";

const candle = (index: number, close: number, spread = 1) => ({ time: index * 300, open: close - 0.2, high: close + spread / 2, low: close - spread / 2, close });

test("the system owns six original strategies across four environments", () => {
  assert.deepEqual(ALL_REGIME_STRATEGIES.map((row) => row.name), ["势承", "衡返", "压跃", "竭转", "脉折", "缓折"]);
  assert.equal(new Set(ALL_REGIME_STRATEGIES.map((row) => row.environment)).size, 4);
});

test("medium and slow phase folds add separately identified completed-candle routes", () => {
  const rows = Array.from({ length: 54 }, (_, index) => candle(index, 100 + index * 0.42 + Math.sin(index) * 0.03));
  for (let index = 54; index < 59; index += 1) rows.push(candle(index, 122.4 + (index - 54) * 0.005, 1));
  rows.push({ time: 59 * 300, open: 122.35, high: 122.55, low: 121.35, close: 121.55 });
  const routes = detectAllRegimeRoutes(rows);
  assert.ok(routes.some((row) => row.strategyId === "pulse_fold"));
  assert.ok(routes.some((row) => row.strategyId === "slow_fold"));
  assert.ok(routes.filter((row) => row.strategyId === "pulse_fold" || row.strategyId === "slow_fold")
    .every((row) => row.version === 3 && row.side === "SHORT" && row.invalidationPrice > row.triggerPrice
      && row.continuationInvalidationPrice! < row.triggerPrice && row.continuationProfitArmPrice! > row.triggerPrice));
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
