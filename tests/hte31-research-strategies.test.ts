import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHte31ResearchStrategies } from "../lib/hte31-research-strategies.ts";
import { HTE31_RESEARCH_TRADER_IDS } from "../lib/hte31-strategy-catalog.ts";
import type { Hte31Candle, Hte31Input } from "../lib/hte31-types.ts";

function trendCandles(): Hte31Candle[] {
  const rows: Hte31Candle[] = [];
  let price = 100;
  for (let index = 0; index < 60; index += 1) {
    let next = price + 0.10;
    if (index >= 48 && index < 55) next = price + 0.22;
    if (index >= 55 && index < 59) next = price + (index % 2 ? -0.03 : 0.02);
    if (index === 59) next = price + 0.18;
    rows.push({
      time: index * 300,
      open: price,
      high: Math.max(price, next) + 0.08,
      low: Math.min(price, next) - 0.08,
      close: next,
      volume: index === 59 ? 1_250 : 1_000,
    });
    price = next;
  }
  return rows;
}

function rangeCandles(): Hte31Candle[] {
  const rows: Hte31Candle[] = [];
  for (let index = 0; index < 59; index += 1) {
    const center = 100 + Math.sin(index / 2.3) * 0.72;
    const next = center + Math.sin((index + 1) / 2.3) * 0.08;
    rows.push({
      time: index * 300,
      open: center,
      high: Math.max(center, next) + 0.18,
      low: Math.min(center, next) - 0.18,
      close: next,
      volume: 1_000,
    });
  }
  rows.push({ time: 59 * 300, open: 99.08, high: 99.48, low: 98.98, close: 99.42, volume: 1_080 });
  return rows;
}

function input(candles5m: Hte31Candle[], overrides: Partial<Hte31Input> = {}): Hte31Input {
  const latest = candles5m.at(-1)!;
  return {
    symbol: "TEST_USDT",
    observedAt: latest.time * 1000 + 300_001,
    futuresPrice: latest.close,
    volumeUsd: 250_000_000,
    changePercentage: 4.2,
    fundingRate: 0.00003,
    openInterestChangePct: 0.4,
    spotCvdRatio: 0.01,
    orderBookImbalance: 0.02,
    liquidationImbalance: 0.05,
    multiTimeframeTrend: 0.65,
    timeframeTrend15m: 0.58,
    timeframeTrend1h: 0.70,
    timeframeTrend4h: 0.55,
    benchmarkMomentum: 1.2,
    optionsIvPercentile: 0.45,
    macroEventRisk: 0.10,
    dataQuality: 0.92,
    candles5m,
    crossSectionRank: 0.90,
    rotationVelocity: 0,
    marketAdvancingRatio: 0.58,
    marketDecliningRatio: 0.42,
    ...overrides,
  };
}

test("research layer evaluates eight isolated strategy challengers", () => {
  const signals = evaluateHte31ResearchStrategies(input(trendCandles()));
  assert.equal(signals.length, 8);
  assert.deepEqual(new Set(signals.map((signal) => signal.traderId)), new Set(HTE31_RESEARCH_TRADER_IDS));
  assert.ok(signals.every((signal) => signal.entryPlan == null || signal.entryPlan.side === signal.side));
});

test("HT9 covers strong trends that only offer a shallow pause instead of a deep pullback", () => {
  const signals = evaluateHte31ResearchStrategies(input(trendCandles()));
  const ht9 = signals.find((signal) => signal.traderId === "shallow_pullback");
  assert.ok(ht9);
  assert.equal(ht9.side, "LONG");
  assert.ok(ht9.confidence >= 60);
  assert.match(ht9.thesis, /不给深回踩|浅整理/);
});

test("HT6 treats range rotation as a separate market story instead of forcing a trend setup", () => {
  const signals = evaluateHte31ResearchStrategies(input(rangeCandles(), {
    changePercentage: 0.2,
    multiTimeframeTrend: 0.04,
    timeframeTrend15m: 0.03,
    timeframeTrend1h: 0.02,
    timeframeTrend4h: 0.05,
    crossSectionRank: 0.5,
    marketAdvancingRatio: 0.50,
    marketDecliningRatio: 0.50,
  }));
  const ht6 = signals.find((signal) => signal.traderId === "range_rotation");
  assert.ok(ht6);
  assert.match(ht6.thesis, /区间中部没有优势/);
  assert.notEqual(ht6.side, "WAIT");
});

test("research signals stay blocked by the same hard data and liquidity safety floor", () => {
  const signals = evaluateHte31ResearchStrategies(input(trendCandles(), { dataQuality: 0.5, volumeUsd: 5_000_000 }));
  assert.ok(signals.every((signal) => signal.state === "blocked"));
  assert.ok(signals.every((signal) => signal.side === "WAIT"));
});
