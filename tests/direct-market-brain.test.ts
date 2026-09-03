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
  const rows = candles(1);
  const packet = {
    observedAt: Date.now(),
    symbol: "BTC_USDT",
    market: {
      futuresPrice: rows.at(-1)!.close,
      timeframeTrend15m: 0.7,
      timeframeTrend1h: 0.8,
      timeframeTrend4h: 0.75,
      spotCvdRatio: 0.25,
      orderBookImbalance: 0.18,
      fundingRate: 0.0001,
    },
    decision: { dataQuality: 0.92 },
  } as Parameters<typeof buildDirectMarketCandidate>[0]["packet"];
  const candidate = buildDirectMarketCandidate({ packet, candles: rows, btcCandles: rows, volumeRank: 1, batchId: "batch:1" });
  assert.equal(Math.round((candidate.paths.up + candidate.paths.down + candidate.paths.rangeOrInvalid) * 10) / 10, 100);
  assert.equal(candidate.decision, "LONG");
  assert.equal(candidate.entryZone?.length, 2);
  assert.equal(candidate.targets.length, 2);
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
      timeframeTrend15m: 0.7,
      timeframeTrend1h: 0.8,
      timeframeTrend4h: 0.75,
      spotCvdRatio: 0.25,
      orderBookImbalance: 0.18,
      fundingRate: 0.0001,
    },
    decision: { dataQuality: 0.92 },
  } as Parameters<typeof buildDirectMarketCandidate>[0]["packet"];
  const candidate = buildDirectMarketCandidate({ packet, candles: rows, btcCandles: [], volumeRank: 2, batchId: "batch:2" });
  assert.equal(candidate.btcCorrelation, null);
  assert.equal(candidate.riskClusterId, "btc-correlation-unavailable");
});

test("risk state is loss-aware and groups correlated orders as one event", () => {
  const calibrating = evaluateDirectMarketRisk([
    { independentEventKey: "same", resultR: -1 },
    { independentEventKey: "same", resultR: -1 },
  ]);
  assert.equal(calibrating.sampleCount, 1);
  assert.equal(calibrating.state, "CALIBRATING");
  const defensive = evaluateDirectMarketRisk(Array.from({ length: 12 }, (_, index) => ({ independentEventKey: `e${index}`, resultR: -0.6 })));
  assert.ok(["DEFENSIVE", "PAUSED"].includes(defensive.state));
  assert.ok(defensive.riskRate <= 0.005);
});
