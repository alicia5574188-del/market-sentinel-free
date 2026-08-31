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
    volume: 1_000_000 * (1 + (index % 7) * 0.03),
  }));
}

function analog(bias: "LONG" | "SHORT" | "NEUTRAL", confidence: number, medianForwardPct: number) {
  return {
    label: "短线",
    sampleCount: 16,
    bias,
    confidence,
    bullishRatio: bias === "LONG" ? 0.72 : 0.18,
    bearishRatio: bias === "SHORT" ? 0.72 : 0.18,
    neutralRatio: 0.10,
    medianForwardPct,
    averageSimilarity: 0.82,
  } as any;
}

test("historical analog uses independent past episodes instead of overlapping slices of one story", () => {
  const closes: number[] = [];
  let base = 100;
  for (let cycle = 0; cycle < 24; cycle += 1) {
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
  assert.ok(result.sampleCount <= 12);
  assert.equal(result.bias, "LONG");
  assert.ok(result.bullishRatio >= 0.60);
  assert.ok(result.confidence > 50);
});

test("market memory keeps short swing and cycle evidence separate", () => {
  const rising = candlesFromCloses(Array.from({ length: 900 }, (_, index) => 100 * (1 + index * 0.002)));
  const memory = buildResonanceMarketMemory({ hourly: rising, fourHour: rising, daily: rising });
  assert.equal(memory.short.label, "短线");
  assert.equal(memory.swing.label, "波段");
  assert.equal(memory.cycle.label, "大周期");
  assert.match(memory.summary, /短线/);
  assert.match(memory.summary, /波段/);
  assert.match(memory.summary, /大周期/);
});

test("market brain uses 4h 1h 15m history and live flow as one direction consensus", () => {
  const packet = {
    market: {
      timeframeTrend4h: 0.8,
      timeframeTrend1h: 0.55,
      timeframeTrend15m: 0.35,
      spotCvdRatio: 0.008,
      orderBookImbalance: 0.12,
    },
  } as any;
  const memory = {
    short: analog("LONG", 74, 0.9),
    swing: { ...analog("LONG", 78, 2.1), label: "波段" },
    cycle: { ...analog("LONG", 70, 5.2), label: "大周期" },
    combinedBias: "LONG",
    combinedConfidence: 76,
    summary: "历史偏多",
  } as any;
  const view = buildResonanceMarketView(packet, memory);
  assert.equal(view.bias, "LONG");
  assert.equal(view.strongDirection, true);
  assert.ok(view.evidenceAgreement >= 3);
  assert.ok(view.expectedMovePct > 0);
});

test("market brain lowers conviction when history and four-hour structure disagree", () => {
  const packet = {
    market: {
      timeframeTrend4h: 0.8,
      timeframeTrend1h: 0.5,
      timeframeTrend15m: 0.25,
      spotCvdRatio: 0,
      orderBookImbalance: 0,
    },
  } as any;
  const agreeing = {
    short: analog("LONG", 75, 0.8),
    swing: { ...analog("LONG", 75, 1.6), label: "波段" },
    cycle: { ...analog("LONG", 75, 4), label: "大周期" },
    combinedBias: "LONG",
    combinedConfidence: 75,
    summary: "历史偏多",
  } as any;
  const disagreeing = {
    short: analog("SHORT", 75, -0.8),
    swing: { ...analog("SHORT", 75, -1.6), label: "波段" },
    cycle: { ...analog("SHORT", 75, -4), label: "大周期" },
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
