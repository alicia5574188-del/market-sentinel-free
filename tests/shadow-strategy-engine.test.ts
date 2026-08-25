import assert from "node:assert/strict";
import test from "node:test";
import { classifyShadowRegime, evaluateShadowStrategies, type ShadowStrategyInput } from "../lib/shadow-strategy-engine.ts";
import type { Candle } from "../lib/signal-engine.ts";

const observedAt = Date.UTC(2026, 7, 25, 10, 0, 0);

function candles(options: { trend?: number; count?: number; base?: number; incompleteSpike?: boolean } = {}): Candle[] {
  const count = options.count ?? 90;
  const base = options.base ?? 100;
  const trend = options.trend ?? 0.04;
  const rows: Candle[] = [];
  for (let index = 0; index < count; index += 1) {
    const close = base + index * trend + Math.sin(index / 3) * 0.08;
    const open = close - trend * 0.45;
    rows.push({
      time: Math.floor((observedAt - (count - index) * 5 * 60_000) / 1000),
      open,
      high: Math.max(open, close) + 0.12,
      low: Math.min(open, close) - 0.12,
      close,
      volume: 1000 + (index % 5) * 40,
    });
  }
  if (options.incompleteSpike) {
    rows.push({
      time: Math.floor((observedAt - 2 * 60_000) / 1000),
      open: 100,
      high: 150,
      low: 50,
      close: 149,
      volume: 100_000,
    });
  }
  return rows;
}

function input(patch: Partial<ShadowStrategyInput> = {}): ShadowStrategyInput {
  return {
    symbol: "BTC_USDT",
    observedAt,
    futuresPrice: 103.5,
    volumeUsd: 600_000_000,
    changePercentage: 3.2,
    fundingRate: 0.0001,
    openInterestChangePct: 1.2,
    spotCvdRatio: 0.05,
    orderBookImbalance: 0.08,
    liquidationImbalance: 0.1,
    multiTimeframeTrend: 0.58,
    benchmarkMomentum: 1.0,
    macroEventRisk: 0.2,
    dataQuality: 0.9,
    candles5m: candles(),
    ...patch,
  };
}

test("shadow engine always exposes four isolated research strategies", () => {
  const signals = evaluateShadowStrategies(input());
  assert.deepEqual(signals.map((signal) => signal.strategyId), ["trend_pullback", "volatility_breakout", "range_reversion", "relative_strength"]);
  assert.ok(signals.every((signal) => signal.shadowOnly));
});

test("stress regime blocks every new shadow entry", () => {
  const signals = evaluateShadowStrategies(input({ macroEventRisk: 0.92 }));
  assert.equal(classifyShadowRegime(input({ macroEventRisk: 0.92 })).kind, "stress");
  assert.ok(signals.every((signal) => signal.state === "blocked"));
  assert.ok(signals.every((signal) => signal.side === "WAIT"));
});

test("incomplete 5m candle cannot manufacture a volatility regime change", () => {
  const normal = classifyShadowRegime(input({ candles5m: candles({ incompleteSpike: false }) }));
  const withIncompleteSpike = classifyShadowRegime(input({ candles5m: candles({ incompleteSpike: true }) }));
  assert.equal(withIncompleteSpike.kind, normal.kind);
  assert.equal(withIncompleteSpike.atrPct, normal.atrPct);
  assert.equal(withIncompleteSpike.rangeWidthPct, normal.rangeWidthPct);
});

test("relative-strength research can become a real ready shadow candidate", () => {
  const signal = evaluateShadowStrategies(input({
    changePercentage: 9,
    benchmarkMomentum: 1,
    multiTimeframeTrend: 0.7,
    spotCvdRatio: 0.08,
  })).find((item) => item.strategyId === "relative_strength");
  assert.ok(signal);
  assert.equal(signal?.state, "ready");
  assert.equal(signal?.side, "LONG");
  assert.equal(signal?.entryPlan?.ready, true);
  assert.ok((signal?.confidence ?? 999) <= 76);
});
