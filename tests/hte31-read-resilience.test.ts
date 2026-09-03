import assert from "node:assert/strict";
import test from "node:test";
import { boundedRead } from "../lib/bounded-read.ts";
import { GateHistoricalDataError, parseGateHistoricalCandles } from "../lib/gate-history.ts";
import { buildResonanceMarketMemory, RESONANCE_MEMORY_STALE_MS } from "../lib/resonance-market.ts";
import type { Hte31Candle } from "../lib/hte31-types.ts";

function candles(count: number, step = 3_600): Hte31Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + Math.sin(index / 8) * 2 + index * .025;
    return { time: (index + 1) * step, open: close - .2, high: close + .5, low: close - .5, close, volume: 1_000 + index };
  });
}

test("bounded read returns a source-scoped timeout instead of waiting forever", async () => {
  const startedAt = Date.now();
  const result = await boundedRead("scanner", new Promise<never>(() => {}), 20);
  assert.deepEqual(result, { ok: false, error: "scanner_TIMEOUT_20MS" });
  assert.ok(Date.now() - startedAt < 250);
});

test("Gate historical parser rejects empty and malformed payloads instead of returning a fake empty sample", () => {
  assert.throws(() => parseGateHistoricalCandles([]), (error) => error instanceof GateHistoricalDataError && error.code === "EMPTY_HISTORY");
  assert.throws(() => parseGateHistoricalCandles({}), (error) => error instanceof GateHistoricalDataError && error.code === "MALFORMED_PAYLOAD");
  const parsed = parseGateHistoricalCandles([[1, "10", "100", "102", "98", "99"]]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].close, 100);
});

test("one failed memory interval stays isolated while valid horizons become ready", () => {
  const rows = candles(900);
  const memory = buildResonanceMarketMemory({
    hourly: rows, fourHour: [], daily: rows,
    failures: { swing: "UPSTREAM_TIMEOUT" },
    observedAt: 10_000_000,
  });
  assert.equal(memory.short.sourceState, "READY");
  assert.equal(memory.swing.sourceState, "UNAVAILABLE");
  assert.equal(memory.swing.failureReason, "UPSTREAM_TIMEOUT");
  assert.equal(memory.cycle.sourceState, "READY");
});

test("last-good memory is explicitly stale and cannot contribute decision weight", () => {
  const rows = candles(900);
  const previous = buildResonanceMarketMemory({ hourly: rows, fourHour: rows, daily: rows, observedAt: 1_000_000 });
  const stale = buildResonanceMarketMemory({
    hourly: [], fourHour: [], daily: [],
    failures: { short: "UPSTREAM_TIMEOUT", swing: "UPSTREAM_TIMEOUT", cycle: "UPSTREAM_TIMEOUT" },
    previous,
    observedAt: 1_060_000,
  });
  assert.equal(stale.short.sourceState, "STALE");
  assert.equal(stale.swing.sourceState, "STALE");
  assert.equal(stale.cycle.sourceState, "STALE");
  assert.equal(stale.combinedBias, "NEUTRAL");
  assert.equal(stale.combinedConfidence, 0);

  const expired = buildResonanceMarketMemory({
    hourly: [], fourHour: [], daily: [],
    failures: { short: "UPSTREAM_TIMEOUT", swing: "UPSTREAM_TIMEOUT", cycle: "UPSTREAM_TIMEOUT" },
    previous,
    observedAt: 1_000_000 + RESONANCE_MEMORY_STALE_MS + 1,
  });
  assert.equal(expired.short.sourceState, "UNAVAILABLE");
});
