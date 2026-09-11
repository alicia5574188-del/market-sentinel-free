import test from "node:test";
import assert from "node:assert/strict";
import { anomalyCandidate, completedCandleStrategyCandidate, completedFiveMinuteCandles, initialMarketRegimes, residentCandleCandidate, selectDiverseMarketPool, updateMarketRegimes,
  type MarketRegimeCandidate } from "../lib/market-regime.ts";
import type { RadarTicker } from "../lib/market-radar.ts";

const ticker = (symbol: string, last: number, openInterest = 1_000): RadarTicker => ({
  symbol, last, openInterest, volume24hUsd: 100_000_000, fundingRate: 0,
});

test("streaming full-market state identifies a persistent quiet trend without a shock prerequisite", () => {
  let state = initialMarketRegimes();
  for (let index = 0; index < 50; index += 1) {
    state = updateMarketRegimes({ state, rows: [ticker("TREND_USDT", 100 + index * 0.03)],
      eligible: new Set(["TREND_USDT"]), now: index * 10_000 });
  }
  assert.equal(state.profiles.TREND_USDT.regime, "TREND");
  assert.ok(state.candidates.some((candidate) => candidate.symbol === "TREND_USDT" && candidate.channel === "TREND"));
});

test("anomaly remains one explicit channel instead of defining every market state", () => {
  const candidate = anomalyCandidate({ id: "X:1", symbol: "X_USDT", side: "SHORT", strength: 80, moveRate: -0.01,
    movementMultiple: 4, volume24hUsd: 50_000_000, confirmations: 3, firstSeenAt: 1, observedAt: 2,
    kind: "LIQUIDATION", openInterestChangeRate: -0.001, referencePrice: 100 });
  assert.equal(candidate.channel, "ANOMALY");
  assert.equal(candidate.regime, "EXPANSION");
  assert.equal(candidate.anomalyKind, "LIQUIDATION");
});

test("three deep-analysis slots diversify trend, rotation and event candidates", () => {
  const row = (symbol: string, channel: MarketRegimeCandidate["channel"], score: number): MarketRegimeCandidate => ({
    id: `${symbol}:1`, symbol, channel, regime: channel === "TREND" ? "TREND" : channel === "ANOMALY" ? "EXPANSION" : channel,
    side: "LONG", score, referencePrice: 100, moveRate: 0.001, trendRate: 0.001, trendEfficiency: 0.5,
    volatilityRatio: 1, rangePosition: 0.5, volume24hUsd: 100_000_000, fundingRate: 0,
    openInterestChangeRate: 0, confirmations: 3, firstSeenAt: 1, observedAt: 2, anomalyKind: null,
  });
  const candidates = [row("T1_USDT", "TREND", 99), row("T2_USDT", "TREND", 98),
    row("R_USDT", "RANGE", 70), row("A_USDT", "ANOMALY", 60)];
  const selected = selectDiverseMarketPool({ locked: [], current: [], candidates, fallback: [], limit: 3 });
  assert.deepEqual(new Set(selected), new Set(["T1_USDT", "R_USDT", "A_USDT"]));
});

test("single-channel warmup preserves all current residents instead of churning deep slots", () => {
  const row = (symbol: string, score: number): MarketRegimeCandidate => ({
    id: `${symbol}:1`, symbol, channel: "ANOMALY", regime: "EXPANSION", side: "LONG", score,
    referencePrice: 100, moveRate: 0.01, trendRate: 0.01, trendEfficiency: 0.8, volatilityRatio: 2,
    rangePosition: 1, volume24hUsd: 100_000_000, fundingRate: 0, openInterestChangeRate: 0,
    confirmations: 3, firstSeenAt: 1, observedAt: 2, anomalyKind: "PRICE_SHOCK",
  });
  const candidates = [row("NEW_USDT", 100), row("A_USDT", 90), row("B_USDT", 80), row("C_USDT", 70)];
  const selected = selectDiverseMarketPool({ locked: [], current: ["A_USDT", "B_USDT", "C_USDT"], candidates, fallback: [], limit: 3 });
  assert.deepEqual(selected, ["A_USDT", "B_USDT", "C_USDT"]);
});

test("locked portfolio exposure keeps its slot while shadow observations do not enter this API", () => {
  const selected = selectDiverseMarketPool({ locked: ["LOCKED_USDT"], current: [], candidates: [],
    fallback: ["BTC_USDT", "ETH_USDT", "SOL_USDT"], limit: 3 });
  assert.deepEqual(selected, ["LOCKED_USDT", "BTC_USDT", "ETH_USDT"]);
});

test("six liquid realtime residents remain stable while four slots follow new opportunities", () => {
  const row = (symbol: string, channel: MarketRegimeCandidate["channel"], score: number): MarketRegimeCandidate => ({
    id: `${symbol}:1`, symbol, channel, regime: channel === "ANOMALY" ? "EXPANSION" : channel,
    side: "LONG", score, referencePrice: 100, moveRate: 0.01, trendRate: 0.01, trendEfficiency: 0.8,
    volatilityRatio: 1.5, rangePosition: 0.9, volume24hUsd: 100_000_000, fundingRate: 0,
    openInterestChangeRate: 0, confirmations: 2, firstSeenAt: 1, observedAt: 2, anomalyKind: null,
  });
  const current = ["A_USDT", "B_USDT", "C_USDT", "D_USDT", "E_USDT", "F_USDT", "OLD1_USDT", "OLD2_USDT"];
  const fallback = [...current.slice(0, 6), "G_USDT", "H_USDT"];
  const candidates = [row("NEW_T_USDT", "TREND", 99), row("NEW_R_USDT", "RANGE", 98),
    row("NEW_A_USDT", "ANOMALY", 97), row("NEW_C_USDT", "COMPRESSION", 96)];
  const selected = selectDiverseMarketPool({ locked: [], current, candidates, fallback, limit: 10 });
  assert.deepEqual(selected.slice(0, 6), current.slice(0, 6));
  assert.deepEqual(new Set(selected.slice(6)), new Set(candidates.map((candidate) => candidate.symbol)));
});

test("resident fallback uses only contiguous completed one-minute candles to build five-minute state", () => {
  const candles = Array.from({ length: 60 }, (_, index) => ({ time: index * 60, open: 100 + index * 0.08,
    high: 100.12 + index * 0.08, low: 99.96 + index * 0.08, close: 100.08 + index * 0.08 }));
  assert.equal(completedFiveMinuteCandles(candles).length, 12);
  const result = residentCandleCandidate({ symbol: "BTC_USDT", candles, volume24hUsd: 1_000_000_000,
    fundingRate: 0.0001, now: 3_600_000 });
  assert.equal(result?.candidate.channel, "TREND");
  assert.equal(result?.candidate.observedAt, 3_600_000);
  assert.ok(result?.structure.upper && result.structure.upper > result.structure.lower);
  const gapped = candles.filter((row) => row.time !== 1_500);
  assert.equal(completedFiveMinuteCandles(gapped).length, 11, "an incomplete five-minute bucket must be discarded");
});


test("completed five-minute OHLCV classifies a liquid market without optional high-frequency feeds", () => {
  const candles = Array.from({ length: 24 }, (_, index) => ({ time: index * 300, open: 100 + index * 0.12,
    high: 100.2 + index * 0.12, low: 99.9 + index * 0.12, close: 100.12 + index * 0.12, volume: 1_000 }));
  const result = completedCandleStrategyCandidate({ symbol: "BTC_USDT", candles, volume24hUsd: 1_000_000_000,
    fundingRate: 0.0001, now: (candles.at(-1)!.time + 300) * 1_000 });
  assert.equal(result?.candidate.channel, "TREND");
  assert.equal(result?.candidate.anomalyKind, null);
  assert.equal(result?.candidate.openInterestChangeRate, 0);
  const expectedThirtyMinuteMove = candles.at(-1)!.close / candles.at(-7)!.close - 1;
  assert.ok(Math.abs((result?.candidate.broadMoveRate ?? 0) - expectedThirtyMinuteMove) < 1e-12,
    "broad-market context must use the same six-bar/30-minute window as acceptance replay");
});
