import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHte31ResearchStrategies } from "../lib/hte31-research-strategies.ts";
import type { Hte31Candle, Hte31Input } from "../lib/hte31-types.ts";

const observedAt = Date.UTC(2026, 8, 2, 12, 0, 0);

function trendWithShallowPause(count = 90): Hte31Candle[] {
  const rows: Hte31Candle[] = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const open = close;
    if (index < count - 18) close += 0.025;
    else if (index < count - 5) close += 0.22;
    else if (index < count - 1) close += index % 2 === 0 ? -0.025 : 0.015;
    else close += 0.28;
    rows.push({
      time: Math.floor((observedAt - (count - index) * 300_000) / 1000),
      open,
      high: Math.max(open, close) + 0.055,
      low: Math.min(open, close) - 0.055,
      close,
      volume: index === count - 1 ? 1_500 : 1_200 + (index % 3) * 20,
    });
  }
  return rows;
}

function input(rows: Hte31Candle[], patch: Partial<Hte31Input> = {}): Hte31Input {
  return {
    symbol: "PROM_USDT",
    observedAt,
    futuresPrice: rows.at(-1)!.close,
    volumeUsd: 380_000_000,
    changePercentage: 5.2,
    fundingRate: 0.00008,
    openInterestChangePct: 1.1,
    spotCvdRatio: 0.014,
    orderBookImbalance: 0.022,
    liquidationImbalance: 0.05,
    multiTimeframeTrend: 0.48,
    timeframeTrend15m: 0.42,
    timeframeTrend1h: 0.50,
    timeframeTrend4h: 0.55,
    benchmarkMomentum: 1.2,
    optionsIvPercentile: 0.55,
    macroEventRisk: 0.1,
    dataQuality: 0.94,
    candles5m: rows,
    crossSectionRank: 0.88,
    rotationVelocity: 0.02,
    marketAdvancingRatio: 0.62,
    marketDecliningRatio: 0.38,
    ...patch,
  };
}

test("HTE31 evaluates the four revised setups and HT6-HT9 inside the unified paper pool", () => {
  const signals = evaluateHte31ResearchStrategies(input(trendWithShallowPause()));
  assert.equal(signals.length, 8);
  assert.deepEqual(signals.map((signal) => signal.strategyId), [
    "trend_breakout_challenger",
    "trend_pullback_challenger",
    "failed_breakout_challenger",
    "higher_timeframe_swing_challenger",
    "range_rotation",
    "compression_expansion",
    "relative_strength",
    "momentum_continuation",
  ]);
  assert.ok(signals.every((signal) => signal.strategyMeta.executionLane === "paper"));
  assert.ok(signals.every((signal) => signal.entryPlan?.checks.some((check) => check.key === "hte-unified-paper-lane")));
  assert.ok(signals.every((signal) => signal.strategyId !== "trend_exhaustion_reversal"));
});

test("HT9 recognizes an impulse, shallow pause and renewed acceleration without requiring an EMA20 touch", () => {
  const signals = evaluateHte31ResearchStrategies(input(trendWithShallowPause()));
  const momentum = signals.find((signal) => signal.strategyId === "momentum_continuation")!;
  assert.equal(momentum.side, "LONG");
  assert.equal(momentum.state, "ready");
  assert.equal(momentum.strategyMeta.playbookId, "HT9_MOMENTUM_CONTINUATION");
  assert.ok(momentum.entryPlan?.checks.find((check) => check.key === "ht9-pause")?.passed);
  assert.ok(momentum.entryPlan?.checks.find((check) => check.key === "ht9-resume")?.passed);
});

test("HT3 challenger explicitly models breakout force, reclaim force and higher-timeframe opposition", () => {
  const signal = evaluateHte31ResearchStrategies(input(trendWithShallowPause()))
    .find((item) => item.strategyId === "failed_breakout_challenger")!;
  const keys = new Set(signal.entryPlan?.checks.map((check) => check.key));
  for (const key of ["ht3r-sweep", "ht3r-breakout-force", "ht3r-reclaim", "ht3r-reversal-force", "ht3r-trend", "ht3r-router"]) {
    assert.ok(keys.has(key), key);
  }
  assert.match(signal.thesis, /突破量能、延伸力度、反向冲击和微观资金流/);
});

test("emergency data or event risk blocks every research challenger", () => {
  const rows = trendWithShallowPause();
  const signals = evaluateHte31ResearchStrategies(input(rows, { macroEventRisk: 1 }));
  assert.equal(signals.length, 8);
  assert.ok(signals.every((signal) => signal.state === "blocked"));
  assert.ok(signals.every((signal) => signal.side === "WAIT"));
});
