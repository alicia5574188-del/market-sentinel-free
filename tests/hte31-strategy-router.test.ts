import assert from "node:assert/strict";
import test from "node:test";
import { buildHte31StrategyRouterDecision, type Hte31RouterEvidence } from "../lib/hte31-strategy-router.ts";
import type { Hte31Signal, Hte31StrategyId } from "../lib/hte31-types.ts";
import type { Hte31TraderId } from "../lib/hte31-strategy-catalog.ts";

function signal(strategyId: Hte31StrategyId, side: "LONG" | "SHORT", score: number, lane: "paper"): Hte31Signal {
  return {
    strategyId,
    label: strategyId,
    shadowOnly: true,
    state: "ready",
    side,
    score: side === "LONG" ? score / 100 : -score / 100,
    confidence: score,
    regime: { kind: "trend", trendScore: side === "LONG" ? 0.5 : -0.5, atrPct: 1, compressionRatio: 1, rangeWidthPct: 3, relativeStrength24h: 1, reason: "test" },
    thesis: "test",
    reasons: [],
    blockers: [],
    entryPlan: {
      ready: true, side, entryPrice: 100, entryZone: [99.9, 100.1], stopLossPrice: side === "LONG" ? 99 : 101,
      takeProfit1Price: side === "LONG" ? 101 : 99, takeProfit2Price: side === "LONG" ? 102 : 98,
      riskPerUnit: 1, plannedRiskPct: 1, riskReward: 2, maxHoldingMinutes: 180, checks: [], exitRules: [],
    },
    metrics: [],
    strategyMeta: { playbookId: strategyId, assetRegime: side === "LONG" ? "trend_up" : "trend_down", setupScore: score, evidenceScore: score, triggerActive: true, hardGatePassed: true, candidateSide: side, executionLane: lane },
  };
}

function evidence(traderId: Hte31TraderId, patch: Partial<Hte31RouterEvidence> = {}): Hte31RouterEvidence {
  return { traderId, sampleCount: 0, expectancyR: 0, profitFactor: null, maximumDrawdownR: 0, qualified: false, ...patch };
}

test("same-side strategies cooperate while the brain selects one executable paper strategy", () => {
  const result = buildHte31StrategyRouterDecision({
    observedAt: 1,
    symbol: "PROM_USDT",
    signals: [signal("trend_breakout", "LONG", 80, "paper"), signal("momentum_continuation", "LONG", 78, "paper")],
    evidence: [],
  });
  assert.equal(result.mode, "COOPERATE");
  assert.equal(result.supporting.length, 1);
  assert.equal(result.selectedForExecution?.traderId, "dennis_trend");
  assert.equal(result.authority, "paper_brain_live_parity");
});

test("similar variants are merged into one family candidate per symbol and cycle", () => {
  const result = buildHte31StrategyRouterDecision({
    observedAt: 1,
    symbol: "PROM_USDT",
    signals: [signal("trend_breakout", "LONG", 80, "paper"), signal("trend_breakout_challenger", "LONG", 82, "paper")],
    evidence: [],
  });
  assert.equal(result.mode, "SINGLE");
  assert.equal(result.primary?.traderId, "dennis_trend_v2");
  assert.equal(result.primary?.familyId, "SF01");
  assert.equal(result.familyAlternatives.length, 1);
  assert.equal(result.familyAlternatives[0]?.traderId, "dennis_trend");
});

test("recent degradation reduces routing score equally for every strategy", () => {
  const result = buildHte31StrategyRouterDecision({
    observedAt: 1,
    symbol: "ETH_USDT",
    signals: [signal("trend_exhaustion_reversal", "SHORT", 84, "paper"), signal("momentum_continuation", "SHORT", 80, "paper")],
    evidence: [evidence("exhaustion_reversal", {
      sampleCount: 20,
      expectancyR: 0.3,
      profitFactor: 1.5,
      recentSampleCount: 6,
      recentExpectancyR: -0.5,
      baselineSampleCount: 14,
      baselineExpectancyR: 0.4,
      everProfitable: true,
    })],
  });
  assert.equal(result.primary?.traderId, "momentum_continuation");
  assert.ok((result.opposing.length === 0));
});

test("opposite strategies remain separate hypotheses instead of being averaged into an order", () => {
  const result = buildHte31StrategyRouterDecision({
    observedAt: 1,
    symbol: "BTC_USDT",
    signals: [signal("trend_exhaustion_reversal", "SHORT", 82, "paper"), signal("momentum_continuation", "LONG", 84, "paper")],
    evidence: [],
  });
  assert.equal(result.mode, "CONFLICT");
  assert.equal(result.opposing.length, 1);
  assert.equal(result.selectedForExecution, null);
  assert.match(result.executionRule, /本轮不下单/);
});

test("a few profitable HT4 samples do not create a permanent priority boost", () => {
  const result = buildHte31StrategyRouterDecision({
    observedAt: 1,
    symbol: "ETH_USDT",
    signals: [signal("trend_exhaustion_reversal", "SHORT", 70, "paper"), signal("momentum_continuation", "SHORT", 82, "paper")],
    evidence: [evidence("exhaustion_reversal", { sampleCount: 3, expectancyR: 2, profitFactor: 99 })],
  });
  assert.equal(result.primary?.traderId, "momentum_continuation");
  assert.equal(result.primary?.evidenceScore, 0);
});

test("thesis invalidation never auto-flips into an unqualified replacement", () => {
  const result = buildHte31StrategyRouterDecision({
    observedAt: 1,
    symbol: "SOL_USDT",
    activePosition: { traderId: "exhaustion_reversal", side: "SHORT" },
    signals: [signal("trend_exhaustion_reversal", "LONG", 75, "paper"), signal("momentum_continuation", "LONG", 86, "paper")],
    evidence: [evidence("momentum_continuation", { sampleCount: 12, expectancyR: 0.3, profitFactor: 1.8, qualified: false })],
  });
  assert.equal(result.mode, "SWITCH_WATCH");
  assert.equal(result.currentThesisState, "invalidated");
  assert.equal(result.replacementEligible, false);
  assert.equal(result.selectedForExecution, null);
  assert.match(result.executionRule, /不把退出与反手合并/);
});

test("a clear score lead lets the brain resolve a directional conflict without hedging", () => {
  const result = buildHte31StrategyRouterDecision({
    observedAt: 1,
    symbol: "BTC_USDT",
    signals: [signal("trend_breakout", "LONG", 92, "paper"), signal("failed_breakout", "SHORT", 70, "paper")],
    evidence: [],
  });
  assert.equal(result.mode, "CONFLICT");
  assert.equal(result.selectedForExecution?.traderId, "dennis_trend");
  assert.match(result.executionRule, /领先差达到 8 分/);
});
