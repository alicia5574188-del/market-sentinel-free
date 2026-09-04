import assert from "node:assert/strict";
import test from "node:test";
import { validateDirectMarketEntry } from "../lib/direct-market-entry.ts";
import { deriveDirectMarketLearningProfile, evaluateDirectMarketLearningAdmission } from "../lib/direct-market-learning.ts";
import { evaluateDirectPosition } from "../lib/direct-market-position-brain.ts";
import { directMarketRiskAdmission } from "../lib/direct-market-risk.ts";
import type { DirectMarketCandidate } from "../lib/direct-market-types.ts";

const now = 1_800_000_000_000;

function candidate(overrides: Partial<DirectMarketCandidate> = {}): DirectMarketCandidate {
  return {
    symbol: "BTC_USDT",
    batchId: "batch",
    observedAt: now - 10_000,
    freshness: "FRESH",
    scanStage: "DEEP",
    volumeRank: 1,
    volumeUsd: 1_000_000_000,
    decision: "LONG",
    confidence: 84,
    setup: "MULTI_TIMEFRAME_RESONANCE",
    setupLabel: "多周期综合共振",
    setupScore: 84,
    location: "BREAKOUT",
    entryZone: [99.5, 100.5],
    invalidationPrice: 98,
    targets: [102.5, 105],
    evidence: [],
    counterEvidence: [],
    checks: [],
    paths: { up: 0.62, down: 0.18, rangeOrInvalid: 0.2 },
    directionalScore: 0.62,
    assetRegime: "trend_up",
    riskClusterId: "btc",
    btcCorrelation: 0.8,
    netEdgeR: 1,
    candles5m: [],
    maxHoldingMinutes: 480,
    ...overrides,
  };
}

test("entry is allowed only from a fresh quote still inside the original setup", () => {
  assert.equal(validateDirectMarketEntry(candidate(), { symbol: "BTC_USDT", price: 100, observedAt: now - 1_000 }, now).allowed, true);
  assert.equal(validateDirectMarketEntry(candidate(), { symbol: "BTC_USDT", price: 101, observedAt: now - 1_000 }, now).allowed, false);
  assert.equal(validateDirectMarketEntry(candidate({ observedAt: now - 100_000 }), { symbol: "BTC_USDT", price: 100, observedAt: now - 1_000 }, now).allowed, false);
});

test("complete independent 12-hour failures block only the repeated signature", () => {
  const samples = Array.from({ length: 4 }, (_, index) => ({
    independentEventKey: `event-${index}`,
    resultR: -0.5,
    signature: "BREAKOUT|LONG|trend_up",
    exitAt: now - index * 60_000,
    complete: true,
  }));
  const profile = deriveDirectMarketLearningProfile(samples);
  assert.equal(profile.action, "BLOCK_FAILURE_SIGNATURE");
  assert.equal(evaluateDirectMarketLearningAdmission(profile, candidate(), now).allowed, false);
  assert.equal(evaluateDirectMarketLearningAdmission(profile, candidate({ location: "BOTTOM" }), now).allowed, true);
});

function candles(closes: number[]) {
  return closes.map((close, index) => ({
    time: now - (closes.length - index + 1) * 300_000,
    open: close + 0.1,
    high: close + 0.2,
    low: close - 0.2,
    close,
    volume: 1_000,
  }));
}

test("position brain can invalidate a losing direction before the original stop", () => {
  const result = evaluateDirectPosition({
    side: "LONG",
    entryPrice: 100,
    initialStopPrice: 98,
    currentStopPrice: 98,
    takeProfit1Price: 103,
    target1HitAt: null,
    entryAt: now - 60 * 60_000,
    maxHoldingMinutes: 480,
    currentPrice: 99.2,
    observedAt: now,
    roundTripCostBps: 8,
    candles5m: candles([101, 100.8, 100.5, 100.2, 100, 99.8, 99.5, 99.2, 98.9, 98.6]),
  });
  assert.equal(result.action, "EXIT");
  assert.equal(result.exitCode, "brain_invalidation");
});

test("TP1 protection moves beyond fee-aware breakeven and never loosens", () => {
  const result = evaluateDirectPosition({
    side: "LONG",
    entryPrice: 100,
    initialStopPrice: 98,
    currentStopPrice: 99,
    takeProfit1Price: 102,
    target1HitAt: now - 300_000,
    entryAt: now - 60 * 60_000,
    maxHoldingMinutes: 480,
    currentPrice: 103,
    observedAt: now,
    roundTripCostBps: 8,
    candles5m: candles([100, 100.5, 101, 101.4, 101.8, 102.2, 102.5, 102.8, 103, 103.1]),
  });
  assert.equal(result.action, "PROTECT");
  assert.ok((result.proposedStopPrice ?? 0) >= 100.08);
});

test("drawdown states change admission quality while keeping fixed risk sizing", () => {
  assert.equal(directMarketRiskAdmission({ state: "NORMAL", confidence: 84, netEdgeR: 1, location: "BREAKOUT" }).allowed, true);
  assert.equal(directMarketRiskAdmission({ state: "DEFENSIVE", confidence: 78, netEdgeR: 0.8, location: "BREAKOUT" }).allowed, false);
});
