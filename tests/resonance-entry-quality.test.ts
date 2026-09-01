import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResonanceEntryQuality,
  buildResonanceEntryQualityPattern,
  type ResonanceEntryQualityClassification,
  type ResonanceEntryQualityReport,
} from "../lib/resonance-entry-quality.ts";
import type { Hte31Candle } from "../lib/hte31-types.ts";

const entryAt = Date.UTC(2026, 8, 1, 0, 0, 0);

function candles(closes: number[], lows: number[] = [], highs: number[] = [], startMinutes = -5): Hte31Candle[] {
  return closes.map((close, index) => ({
    time: Math.floor((entryAt + (startMinutes + index * 5) * 60_000) / 1000),
    open: close,
    high: highs[index] ?? close + 0.08,
    low: lows[index] ?? close - 0.08,
    close,
    volume: 1_000,
  }));
}

function trade(overrides: Partial<Parameters<typeof buildResonanceEntryQuality>[0]> = {}) {
  return {
    side: "LONG" as const,
    entryAt,
    entryPrice: 100,
    initialStopPrice: 99,
    maxHoldingMinutes: 120,
    ...overrides,
  };
}

test("entry quality records efficiency, first-passage time and 5/10/15 minute delays", () => {
  const report = buildResonanceEntryQuality(trade(), candles(
    [100, 99.6, 99.55, 100.2, 100.7, 101.1, 101.3, 101.4],
    [99.95, 99.55, 99.3, 100.0, 100.55, 100.95, 101.15, 101.25],
  ), 8, entryAt + 3 * 60 * 60_000);

  assert.equal(report.sampleSufficient, true);
  assert.equal(report.classification, "entry_too_early");
  assert.ok((report.entryEfficiency ?? 100) < 70);
  assert.ok((report.initialMaeR ?? 0) >= 0.7);
  assert.ok((report.timeToHalfRMinutes ?? 0) >= 15);
  assert.equal(report.delayedEntries.map((item) => item.delayMinutes).join(","), "5,10,15");
  assert.ok(report.delayedEntries.some((item) => item.valid && (item.improvementR ?? 0) >= 0.5));
});

test("entry quality distinguishes direction error from normal noise", () => {
  const wrongPath = [100, ...Array.from({ length: 50 }, (_, index) => 100 - (index + 1) * 0.05)];
  const wrong = buildResonanceEntryQuality(trade({ maxHoldingMinutes: 300 }), candles(wrongPath), 8, entryAt + 5 * 60 * 60_000);
  assert.equal(wrong.classification, "direction_wrong");
  assert.ok((wrong.oppositeFourHourR ?? 0) > 1);

  const normal = buildResonanceEntryQuality(trade(), candles([100, 100.1, 100.25, 100.45, 100.6, 100.8, 100.95]), 8, entryAt + 3 * 60 * 60_000);
  assert.equal(normal.classification, "normal_noise");
  assert.ok((normal.entryEfficiency ?? 0) > 70);
});

test("entry quality can identify late entry and tight-stop recovery without changing the trade", () => {
  const late = buildResonanceEntryQuality(trade(), candles([99.5, 100, 100.15, 100.4, 100.7, 101, 101.2]), 0, entryAt + 3 * 60 * 60_000);
  assert.equal(late.classification, "entry_too_late");
  assert.ok((late.earlierEntryAdvantageR ?? 0) >= 0.5);

  const tight = buildResonanceEntryQuality(trade({ stopRecovery: true }), candles([100, 100.05, 100.1, 100.15, 100.2, 100.25]), 0, entryAt + 3 * 60 * 60_000);
  assert.equal(tight.classification, "stop_too_tight");
});

test("entry quality refuses to classify fewer than four post-entry candles", () => {
  const report = buildResonanceEntryQuality(trade(), candles([100, 100.1, 100.2]), 0, entryAt + 30 * 60_000);
  assert.equal(report.sampleSufficient, false);
  assert.equal(report.classification, "insufficient_data");
  assert.equal(report.entryEfficiency, null);
});

function quality(classification: ResonanceEntryQualityClassification): ResonanceEntryQualityReport {
  return {
    generatedAt: entryAt,
    sampleSufficient: true,
    classification,
    classificationLabel: classification,
    entryEfficiency: 50,
    initialMaeR: 0.5,
    timeToHalfRMinutes: null,
    timeToOneRMinutes: null,
    originalTerminalR: 0,
    oppositeFourHourR: 0,
    delayedEntries: [],
    bestDelayBars: null,
    earlierEntryAdvantageR: null,
    evidence: [],
  };
}

test("entry confirmation only learns from repeated evidence in the same setup and regime", () => {
  const split = buildResonanceEntryQualityPattern([
    { setupId: "trend_breakout", assetRegime: "trend_up", entryQuality: quality("entry_too_early") },
    { setupId: "trend_breakout", assetRegime: "range", entryQuality: quality("entry_too_early") },
    { setupId: "trend_pullback", assetRegime: "trend_up", entryQuality: quality("entry_too_early") },
  ]);
  assert.equal(split?.qualifiesForEntryChange, false);

  const repeated = buildResonanceEntryQualityPattern([
    { setupId: "trend_breakout", assetRegime: "trend_up", entryQuality: quality("entry_too_early") },
    { setupId: "trend_breakout", assetRegime: "trend_up", entryQuality: quality("entry_too_early") },
    { setupId: "trend_breakout", assetRegime: "trend_up", entryQuality: quality("normal_noise") },
  ]);
  assert.deepEqual(repeated && {
    setupId: repeated.setupId,
    assetRegime: repeated.assetRegime,
    classification: repeated.classification,
    sampleSize: repeated.sampleSize,
    repeatedCount: repeated.repeatedCount,
    qualifiesForEntryChange: repeated.qualifiesForEntryChange,
  }, {
    setupId: "trend_breakout",
    assetRegime: "trend_up",
    classification: "entry_too_early",
    sampleSize: 3,
    repeatedCount: 2,
    qualifiesForEntryChange: true,
  });
});
