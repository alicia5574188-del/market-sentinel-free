import assert from "node:assert/strict";
import test from "node:test";
import { buildDirectMarketCandidate, pearsonCorrelation } from "../lib/direct-market-brain.ts";
import { evaluateDirectMarketRisk } from "../lib/direct-market-risk.ts";
import { chooseDirectMarketTarget, rankDirectMarketUniverse } from "../lib/direct-market-universe.ts";
import type { Hte31Candle } from "../lib/hte31-types.ts";

function candles(direction = 1): Hte31Candle[] {
  return Array.from({ length: 96 }, (_, index) => {
    const open = 100 + direction * index * 0.18;
    const close = open + direction * 0.14;
    return { time: 1_800_000_000 + index * 300, open, close, high: Math.max(open, close) + 0.12, low: Math.min(open, close) - 0.12, volume: 100 + index };
  });
}

test("direct brain emits normalized mutually exclusive paths and a replayable plan", () => {
  const rows = Array.from({ length: 96 }, (_, index) => ({
    time: 1_800_000_000 + index * 300, open: 100, close: 100 + (index % 2 ? 0.03 : -0.03), high: 100.2, low: 99.8, volume: 100 + index,
  }));
  rows[rows.length - 1] = { ...rows.at(-1)!, open: 99.95, close: 100.18, high: 100.24, low: 99.9, volume: 160 };
  const packet = {
    observedAt: Date.now(),
    symbol: "BTC_USDT",
    market: {
      futuresPrice: rows.at(-1)!.close,
      volumeUsd: 1_000_000_000,
      changePercentage: 3,
      timeframeTrend15m: 0.2,
      timeframeTrend1h: 0.8,
      timeframeTrend4h: 0.75,
      spotCvdRatio: 0.25,
      orderBookImbalance: 0.18,
      fundingRate: 0.0001,
      liquidationImbalance: 0.05,
      macroEventRisk: 0.1,
    },
    decision: { dataQuality: 0.92 },
  } as Parameters<typeof buildDirectMarketCandidate>[0]["packet"];
  const candidate = buildDirectMarketCandidate({ packet, candles: rows, btcCandles: rows, volumeRank: 1, batchId: "batch:1" });
  assert.equal(Math.round((candidate.paths.up + candidate.paths.down + candidate.paths.rangeOrInvalid) * 10) / 10, 100);
  assert.equal(candidate.decision, "LONG");
  assert.equal(candidate.setup, "MULTI_TIMEFRAME_RESONANCE");
  assert.equal(candidate.entryZone?.length, 2);
  assert.equal(candidate.targets.length, 2);
  assert.equal(candidate.setupEvaluations?.length, 3);
  assert.equal(candidate.setupEvaluations?.filter((row) => row.selected).length, 1);
  assert.ok(candidate.setupEvaluations?.every((row) => typeof row.triggered === "boolean" && typeof row.qualified === "boolean"));
  assert.ok(candidate.invalidationPrice! < candidate.entryZone![0]);
  assert.ok(candidate.targets[1] > candidate.targets[0]);
  assert.equal(candidate.riskClusterId, "btc-positive");
});

test("correlation and dynamic top-fifteen rotation are deterministic", () => {
  assert.ok((pearsonCorrelation(candles(1), candles(1)) ?? 0) > 0.99);
  const universe = Array.from({ length: 20 }, (_, index) => ({
    symbol: `COIN${index}_USDT`, price: 1, changePercentage: index, volumeUsd: 1000 - index,
    fundingRate: 0, basisPct: 0, coarseScore: index % 2 ? 0.8 : -0.7, confidence: 60,
    state: "pre_alert" as const, stateLabel: "", side: "LONG" as const,
  }));
  const ranked = rankDirectMarketUniverse(universe);
  assert.equal(ranked.length, 15);
  assert.equal(ranked[0].volumeRank, 1);
  assert.equal(chooseDirectMarketTarget(ranked, 0)?.symbol, chooseDirectMarketTarget(ranked, 6)?.symbol);
});

test("missing BTC correlation stays in one conservative risk cluster", () => {
  const rows = candles(1);
  const packet = {
    observedAt: Date.now(),
    symbol: "ETH_USDT",
    market: {
      futuresPrice: rows.at(-1)!.close,
      volumeUsd: 1_000_000_000,
      changePercentage: 3,
      timeframeTrend15m: 0.7,
      timeframeTrend1h: 0.8,
      timeframeTrend4h: 0.75,
      spotCvdRatio: 0.25,
      orderBookImbalance: 0.18,
      fundingRate: 0.0001,
      liquidationImbalance: 0.05,
      macroEventRisk: 0.1,
    },
    decision: { dataQuality: 0.92 },
  } as Parameters<typeof buildDirectMarketCandidate>[0]["packet"];
  const candidate = buildDirectMarketCandidate({ packet, candles: rows, btcCandles: [], volumeRank: 2, batchId: "batch:2" });
  assert.equal(candidate.btcCorrelation, null);
  assert.equal(candidate.riskClusterId, "btc-correlation-unavailable");
});

test("core setup cannot bypass liquidity, while volume remains setup-specific", () => {
  const rows = candles(1);
  rows[rows.length - 2] = { ...rows.at(-2)!, volume: 20 };
  rows[rows.length - 1] = { ...rows.at(-1)!, volume: 20 };
  const packet = {
    observedAt: Date.now(), symbol: "BTC_USDT",
    market: {
      futuresPrice: rows.at(-1)!.close, volumeUsd: 5_000_000, changePercentage: 3,
      timeframeTrend15m: 0.7, timeframeTrend1h: 0.8, timeframeTrend4h: 0.75,
      spotCvdRatio: 0.25, orderBookImbalance: 0.18, fundingRate: 0.0001,
      liquidationImbalance: 0.05, macroEventRisk: 0.1,
    },
    decision: { dataQuality: 0.92 },
  } as Parameters<typeof buildDirectMarketCandidate>[0]["packet"];
  const candidate = buildDirectMarketCandidate({ packet, candles: rows, btcCandles: rows, volumeRank: 1, batchId: "batch:hard-gate" });
  assert.equal(candidate.decision, "WAIT");
  assert.equal(candidate.checks.find((check) => check.key === "liquidity")?.passed, false);
  assert.equal(candidate.checks.find((check) => check.key === "volume"), undefined);
});

test("volume-force failed breakout is selected only after a sweep, reclaim and reverse force", () => {
  const rows = Array.from({ length: 96 }, (_, index) => ({
    time: 1_800_000_000 + index * 300, open: 100, close: 100 + (index % 2 ? 0.03 : -0.03), high: 100.2, low: 99.8, volume: 100,
  }));
  rows[rows.length - 2] = { ...rows.at(-2)!, open: 100.1, close: 100.30, high: 100.62, low: 99.95, volume: 180 };
  rows[rows.length - 1] = { ...rows.at(-1)!, open: 100.3, close: 99.95, high: 100.35, low: 99.8, volume: 180 };
  const packet = {
    observedAt: Date.now(), symbol: "ETH_USDT",
    market: { futuresPrice: 99.95, volumeUsd: 800_000_000, changePercentage: 1, timeframeTrend15m: 0, timeframeTrend1h: 0, timeframeTrend4h: 0, spotCvdRatio: -0.12, orderBookImbalance: -0.18, fundingRate: 0.0001, liquidationImbalance: 0.05, macroEventRisk: 0.1 },
    decision: { dataQuality: 0.95 },
  } as Parameters<typeof buildDirectMarketCandidate>[0]["packet"];
  const candidate = buildDirectMarketCandidate({ packet, candles: rows, btcCandles: rows, volumeRank: 2, batchId: "batch:failed" });
  assert.equal(candidate.setup, "VOLUME_FORCE_FAILED_BREAKOUT");
  assert.equal(candidate.decision, "SHORT");
});

test("exhaustion reversal wins over chasing an overheated trend", () => {
  const rows = candles(1);
  rows[rows.length - 1] = { ...rows.at(-1)!, open: 118, close: 116.8, high: 119.2, low: 116.6, volume: 230 };
  const packet = {
    observedAt: Date.now(), symbol: "SOL_USDT",
    market: { futuresPrice: 116.8, volumeUsd: 900_000_000, changePercentage: 9, timeframeTrend15m: 0.7, timeframeTrend1h: 0.8, timeframeTrend4h: 0.75, spotCvdRatio: -0.08, orderBookImbalance: -0.12, fundingRate: 0.0008, liquidationImbalance: 0.55, macroEventRisk: 0.1 },
    decision: { dataQuality: 0.94 },
  } as Parameters<typeof buildDirectMarketCandidate>[0]["packet"];
  const candidate = buildDirectMarketCandidate({ packet, candles: rows, btcCandles: rows, volumeRank: 3, batchId: "batch:exhaustion" });
  assert.equal(candidate.setup, "EXHAUSTION_REVERSAL");
  assert.equal(candidate.decision, "SHORT");
});

test("a large 24-hour move alone never qualifies as exhaustion", () => {
  const rows = candles(0);
  const packet = {
    observedAt: Date.now(), symbol: "SOL_USDT",
    market: { futuresPrice: rows.at(-1)!.close, volumeUsd: 900_000_000, changePercentage: -18, timeframeTrend15m: 0.1, timeframeTrend1h: -0.05, timeframeTrend4h: -0.1, spotCvdRatio: 0, orderBookImbalance: 0, fundingRate: 0, liquidationImbalance: 0, macroEventRisk: 0.1 },
    decision: { dataQuality: 0.94 },
  } as Parameters<typeof buildDirectMarketCandidate>[0]["packet"];
  const candidate = buildDirectMarketCandidate({ packet, candles: rows, btcCandles: rows, volumeRank: 3, batchId: "batch:not-exhausted" });
  const exhaustion = candidate.setupEvaluations?.find((row) => row.setup === "EXHAUSTION_REVERSAL");
  assert.equal(exhaustion?.triggered, false);
  assert.equal(exhaustion?.qualified, false);
});

test("risk state is loss-aware and groups correlated orders as one event", () => {
  const calibrating = evaluateDirectMarketRisk([
    { independentEventKey: "same", resultR: -1 },
    { independentEventKey: "same", resultR: -1 },
  ]);
  assert.equal(calibrating.sampleCount, 1);
  assert.equal(calibrating.state, "CALIBRATING");
  assert.equal(calibrating.riskRate, 0.035);
  const defensive = evaluateDirectMarketRisk(Array.from({ length: 12 }, (_, index) => ({ independentEventKey: `e${index}`, resultR: -0.6 })));
  assert.ok(["DEFENSIVE", "PAUSED"].includes(defensive.state));
  assert.equal(defensive.riskRate, defensive.state === "PAUSED" ? 0 : 0.035);
});

test("active learning states improve decisions without silently shrinking simulation risk", () => {
  const caution = evaluateDirectMarketRisk(Array.from({ length: 8 }, (_, index) => ({ independentEventKey: `c${index}`, resultR: index === 0 ? 0.1 : -0.2 })));
  assert.equal(caution.state, "CAUTION");
  assert.equal(caution.riskRate, 0.035);
});
