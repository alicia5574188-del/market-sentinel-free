import assert from "node:assert/strict";
import test from "node:test";
import { buildDirectMarketCandidate, pearsonCorrelation } from "../lib/direct-market-brain.ts";
import { evaluateDirectMarketRisk } from "../lib/direct-market-risk.ts";
import { chooseDirectMarketTarget, rankDirectMarketUniverse } from "../lib/direct-market-universe.ts";
import type { Hte31Candle } from "../lib/hte31-types.ts";

const auditNow = Date.UTC(2026, 8, 5, 12);

function candles(direction = 1): Hte31Candle[] {
  return Array.from({ length: 96 }, (_, index) => {
    const open = 100 + direction * index * 0.18;
    const close = open + direction * 0.14;
    return { time: (auditNow - (96 - index) * 300_000) / 1000, open, close, high: Math.max(open, close) + 0.12, low: Math.min(open, close) - 0.12, volume: 100 + index };
  });
}

test("all configured symbols receive deep evaluation even when the top six dominate", () => {
  assert.ok((pearsonCorrelation(candles(1), candles(1)) ?? 0) > 0.99);
  const universe = Array.from({ length: 20 }, (_, index) => ({
    symbol: `COIN${index}_USDT`, price: 1, changePercentage: index, volumeUsd: 1000 - index,
    fundingRate: 0, basisPct: 0, coarseScore: index % 2 ? 0.8 : -0.7, confidence: 60,
    state: "pre_alert" as const, stateLabel: "", side: "LONG" as const,
  }));
  const ranked = rankDirectMarketUniverse(universe);
  assert.equal(ranked.length, 20);
  assert.equal(ranked[0].volumeRank, 1);
  const observed: Record<string, number> = {};
  const seen = new Set<string>();
  for (let turn = 0; turn < 20; turn++) {
    const target = chooseDirectMarketTarget(ranked, turn, observed)!;
    assert.equal(seen.has(target.symbol), false);
    seen.add(target.symbol);
    observed[target.symbol] = auditNow + turn;
  }
  assert.equal(seen.size, ranked.length);
  const oldest = Object.entries(observed).sort((a, b) => a[1] - b[1])[0][0];
  assert.equal(chooseDirectMarketTarget([...ranked].reverse(), 20, observed)?.symbol, oldest);
  const newcomer = { ...universe[0], symbol: "NEW_USDT", volumeUsd: 1 };
  assert.equal(chooseDirectMarketTarget([...ranked, newcomer], 21, observed)?.symbol, "NEW_USDT");
  assert.equal(chooseDirectMarketTarget([], 0), null);
});

test("missing BTC correlation stays in one conservative risk cluster", () => {
  const rows = candles(1);
  const packet = {
    observedAt: auditNow,
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
    observedAt: auditNow, symbol: "BTC_USDT",
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
