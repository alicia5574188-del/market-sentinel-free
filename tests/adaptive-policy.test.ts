import test from "node:test";
import assert from "node:assert/strict";
import { ADAPTIVE_DAILY_OBJECTIVE_RATE, ADAPTIVE_MIN_ANALOG_SAMPLES,
  buildAdaptivePolicySnapshot } from "../lib/adaptive-policy.ts";

test("completed-candle walk-forward selects a positive after-cost horizon without a trade quota", () => {
  const candles = Array.from({ length: 120 }, (_, index) => {
    const open = 100 + index * 0.25;
    return { time: (index + 1) * 300, open, high: open + 0.24, low: open - 0.04, close: open + 0.2, volume: 1_000 };
  });
  const snapshot = buildAdaptivePolicySnapshot(candles, 1_000_000);
  assert.ok(snapshot);
  assert.equal(snapshot.objectiveDailyReturnRate, ADAPTIVE_DAILY_OBJECTIVE_RATE);
  const continuation = snapshot.recommendations.find((row) => row.side === "LONG"
    && ["MOMENTUM_CONTINUATION", "BREAKOUT_ACCEPTANCE"].includes(row.mechanism));
  assert.ok(continuation);
  assert.ok(continuation.samples >= ADAPTIVE_MIN_ANALOG_SAMPLES);
  assert.ok(continuation.netExpectationRate > 0);
  assert.ok(continuation.conservativeNetReturnRate > 0);
  assert.ok(continuation.horizonMinutes >= 10);
  assert.equal(continuation.approved, true);
});

test("an adaptive policy never invents a route when the current candle has no mechanism trigger", () => {
  const candles = Array.from({ length: 120 }, (_, index) => ({ time: (index + 1) * 300,
    open: 100, high: 100.05, low: 99.95, close: 100, volume: 1_000 }));
  const snapshot = buildAdaptivePolicySnapshot(candles, 1_000_000);
  assert.ok(snapshot);
  assert.deepEqual(snapshot.recommendations, []);
});

test("insufficient completed-candle history cannot authorize a policy", () => {
  const candles = Array.from({ length: 47 }, (_, index) => ({ time: (index + 1) * 300,
    open: 100 + index * 0.1, high: 100.2 + index * 0.1, low: 99.9 + index * 0.1,
    close: 100.1 + index * 0.1, volume: 1_000 }));
  assert.equal(buildAdaptivePolicySnapshot(candles, 1_000_000), null);
});
