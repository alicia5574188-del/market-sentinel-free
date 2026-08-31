import assert from "node:assert/strict";
import test from "node:test";
import { buildHistoricalAnalog, buildResonanceMarketMemory } from "../lib/resonance-market.ts";
import { buildResonanceMarketView } from "../lib/resonance-brain.ts";
import type { Hte31Candle } from "../lib/hte31-types.ts";

function candlesFromCloses(closes: number[], step = 3_600): Hte31Candle[] {
  return closes.map((close, index) => ({
    time: index * step,
    open: close * 0.998,
    high: close * 1.003,
    low: close * 0.997,
    close,
    volume: 1_000_000,
  }));
}

test("historical analog uses many past windows instead of one story", () => {
  const closes: number[] = [];
  let base = 100;
  for (let cycle = 0; cycle < 18; cycle += 1) {
    const shape = [1, 1.01, 1.018, 1.012, 1.025, 1.035, 1.03, 1.044, 1.052, 1.048, 1.061, 1.07, 1.082, 1.09, 1.1, 1.11];
    for (const factor of shape) closes.push(base * factor);
    base *= 1.12;
  }
  const result = buildHistoricalAnalog(candlesFromCloses(closes), {
    label: "短线",
    windowSize: 12,
    horizon: 4,
    topK: 12,
    neutralThresholdPct: 0.2,
  });
  assert.ok(result.sampleCount >= 8);
  assert.equal(result.bias, "LONG");
  assert.ok(result.bullishRatio >= 0.62);
  assert.ok(result.confidence > 50);
});

test("market memory keeps short swing and cycle evidence separate", () => {
  const rising = candlesFromCloses(Array.from({ length: 360 }, (_, index) => 100 * (1 + index * 0.002)));
  const memory = buildResonanceMarketMemory({ hourly: rising, fourHour: rising, daily: rising });
  assert.equal(memory.short.label, "短线");
  assert.equal(memory.swing.label, "波段");
  assert.equal(memory.cycle.label, "大周期");
  assert.match(memory.summary, /短线/);
  assert.match(memory.summary, /波段/);
  assert.match(memory.summary, /大周期/);
});

test("market brain lowers conviction when history and four-hour structure disagree", () => {
  const packet = {
    market: { timeframeTrend4h: 0.8, timeframeTrend1h: 0.5 },
  } as any;
  const agreeing = {
    combinedBias: "LONG",
    combinedConfidence: 75,
    summary: "历史偏多",
  } as any;
  const disagreeing = {
    combinedBias: "SHORT",
    combinedConfidence: 75,
    summary: "历史偏空",
  } as any;
  const agreeView = buildResonanceMarketView(packet, agreeing);
  const disagreeView = buildResonanceMarketView(packet, disagreeing);
  assert.equal(agreeView.bias, "LONG");
  assert.ok(agreeView.confidence > disagreeView.confidence);
  assert.match(disagreeView.reason, /冲突/);
});
