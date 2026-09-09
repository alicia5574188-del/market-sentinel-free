import test from "node:test";
import assert from "node:assert/strict";
import { anomalyCandidate, initialMarketRegimes, selectDiverseMarketPool, updateMarketRegimes,
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
