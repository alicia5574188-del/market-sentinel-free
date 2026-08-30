import assert from "node:assert/strict";
import test from "node:test";
import { classifyHte31AssetRegime, classifyHte31MarketRegime } from "../lib/hte31-regime.ts";
import type { Hte31Candle, Hte31Input } from "../lib/hte31-types.ts";
import { classifyShadowRegime } from "../lib/shadow-strategy-engine.ts";
import { classifyStrategy2AssetRegime, type Strategy2Input } from "../lib/strategy-2-engine.ts";

const FIVE_MINUTES = 300_000;

function candles(options: {
  start?: number;
  count?: number;
  startPrice?: number;
  step?: number;
  range?: number;
  volume?: number;
  recentRangeMultiplier?: number;
  recentVolumeMultiplier?: number;
} = {}): Hte31Candle[] {
  const count = options.count ?? 60;
  const start = options.start ?? 1_700_000_000_000;
  const startPrice = options.startPrice ?? 100;
  const step = options.step ?? 0;
  const range = options.range ?? 0.8;
  const volume = options.volume ?? 1_000;
  return Array.from({ length: count }, (_, index) => {
    const open = startPrice + index * step;
    const close = open + step * 0.55;
    const recent = index >= count - 18;
    const candleRange = range * (recent ? (options.recentRangeMultiplier ?? 1) : 1);
    const candleVolume = volume * (index === count - 1 ? (options.recentVolumeMultiplier ?? 1) : 1);
    return {
      time: start + index * FIVE_MINUTES,
      open,
      high: Math.max(open, close) + candleRange / 2,
      low: Math.min(open, close) - candleRange / 2,
      close,
      volume: candleVolume,
    };
  });
}

function input(overrides: Partial<Hte31Input> = {}): Hte31Input {
  const rows = overrides.candles5m ?? candles();
  return {
    symbol: "TEST_USDT",
    observedAt: rows.at(-1)!.time + FIVE_MINUTES + 1,
    futuresPrice: rows.at(-1)!.close,
    volumeUsd: 100_000_000,
    changePercentage: 0.4,
    fundingRate: 0.0001,
    openInterestChangePct: 0.2,
    spotCvdRatio: 0.01,
    orderBookImbalance: 0.02,
    liquidationImbalance: 0.05,
    multiTimeframeTrend: 0.1,
    benchmarkMomentum: 0.1,
    macroEventRisk: 0.1,
    dataQuality: 0.95,
    candles5m: rows,
    crossSectionRank: 0.5,
    rotationVelocity: 0.1,
    marketAdvancingRatio: 0.55,
    marketDecliningRatio: 0.45,
    ...overrides,
  };
}

const scenarios: Array<[string, Hte31Input]> = [
  ["neutral-range", input({ multiTimeframeTrend: 0.1, candles5m: candles({ range: 0.5 }) })],
  ["up-trend", input({ multiTimeframeTrend: 0.65, candles5m: candles({ step: 0.18, range: 0.9 }) })],
  ["down-trend", input({ multiTimeframeTrend: -0.62, candles5m: candles({ step: -0.16, range: 0.9 }) })],
  ["stress-data", input({ dataQuality: 0.6 })],
  ["stress-funding", input({ fundingRate: 0.0012 })],
  ["stress-event", input({ macroEventRisk: 0.9 })],
  ["liquidation", input({ liquidationImbalance: 0.7, multiTimeframeTrend: 0.05 })],
  ["expansion-up", input({ multiTimeframeTrend: 0.3, candles5m: candles({ step: 0.08, range: 0.7, recentRangeMultiplier: 2.1 }) })],
  ["expansion-volume", input({ multiTimeframeTrend: -0.3, candles5m: candles({ step: -0.08, range: 0.7, recentVolumeMultiplier: 1.8 }) })],
  ["compression", input({ multiTimeframeTrend: 0.05, candles5m: candles({ range: 1.2, recentRangeMultiplier: 0.35 }) })],
];

for (const [name, sample] of scenarios) {
  test(`HTE31 extracted regime stays identical to legacy classifiers: ${name}`, () => {
    const legacyInput = sample as Strategy2Input;
    assert.deepEqual(classifyHte31MarketRegime(sample), classifyShadowRegime(legacyInput));
    assert.equal(classifyHte31AssetRegime(sample), classifyStrategy2AssetRegime(legacyInput));
  });
}
