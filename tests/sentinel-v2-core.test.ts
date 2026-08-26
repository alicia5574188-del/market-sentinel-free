import assert from "node:assert/strict";
import test from "node:test";
import { buildSentinelV2MarketContext, evaluateSentinelV2Opportunity } from "../lib/sentinel-v2-core.ts";
import type { UniverseTicker } from "../lib/gate-client.ts";
import type { ShadowStrategySignal } from "../lib/shadow-strategy-engine.ts";

function universe(changes: number[], funding = 0.0001): UniverseTicker[] {
  return changes.map((changePercentage, index) => ({
    symbol: `C${index + 10}_USDT`,
    price: 100 + index,
    changePercentage,
    volumeUsd: 100_000_000 - index * 100_000,
    fundingRate: funding,
    basisPct: 0,
    coarseScore: Math.max(-1, Math.min(1, changePercentage / 7)),
    confidence: 60,
    state: "observing",
    stateLabel: "持续观察",
    side: "WAIT",
  }));
}

function signal(side: "LONG" | "SHORT" = "LONG"): ShadowStrategySignal {
  const entry = 100;
  const stop = side === "LONG" ? 98 : 102;
  return {
    strategyId: "trend_pullback",
    label: "趋势回踩",
    shadowOnly: true,
    state: "ready",
    side,
    score: side === "LONG" ? 0.82 : -0.82,
    confidence: 82,
    regime: {
      kind: "trend",
      trendScore: side === "LONG" ? 0.68 : -0.68,
      atrPct: 0.8,
      compressionRatio: 1,
      rangeWidthPct: 4,
      relativeStrength24h: 2,
      reason: "test",
    },
    thesis: "test thesis",
    reasons: ["结构完整", "现货流确认"],
    blockers: [],
    entryPlan: {
      ready: true,
      side,
      entryPrice: entry,
      entryZone: [99.8, 100.2],
      stopLossPrice: stop,
      takeProfit1Price: side === "LONG" ? 102 : 98,
      takeProfit2Price: side === "LONG" ? 104 : 96,
      riskPerUnit: 2,
      plannedRiskPct: 2,
      riskReward: 2,
      maxHoldingMinutes: 480,
      checks: [],
      exitRules: [],
    },
    metrics: [],
  };
}

test("healthy broad rally remains trade-permitted rather than transition-red", () => {
  const market = buildSentinelV2MarketContext({
    observedAt: Date.UTC(2026, 7, 26, 1),
    universe: universe([4.1, 3.8, 3.4, 2.9, 2.7, 2.5, 2.2, 1.9, 1.7, 1.4, 1.2, 0.9]),
    benchmarkMomentum: 3.2,
    optionsIvPercentile: 0.48,
    macroEventRisk: 0.1,
  });
  assert.notEqual(market.permission, "RED");
  assert.equal(market.bias, "LONG");
  assert.ok(market.transitionRisk < 61);
  assert.ok(market.breadth.advancingRatio > 0.9);
});

test("benchmark strength with collapsing breadth raises transition risk", () => {
  const market = buildSentinelV2MarketContext({
    observedAt: Date.UTC(2026, 7, 26, 2),
    universe: universe([2.4, 0.5, -0.2, -0.5, -0.8, -1.0, -1.2, -1.5, -1.8, -2.0, -2.2, -2.5]),
    benchmarkMomentum: 4.5,
    optionsIvPercentile: 0.78,
    macroEventRisk: 0.2,
  });
  assert.ok(market.transition.breadthDeterioration >= 60);
  assert.ok(market.transitionRisk >= 40);
  assert.ok(market.warnings.some((warning) => warning.type === "breadth_shock"));
});

test("V2 rejects adding another highly concentrated same-direction position", () => {
  const market = buildSentinelV2MarketContext({
    observedAt: Date.UTC(2026, 7, 26, 3),
    universe: universe([3.5, 3.1, 2.8, 2.5, 2.2, 2.0, 1.7, 1.5, 1.3, 1.1, 0.9, 0.7]),
    benchmarkMomentum: 3,
    optionsIvPercentile: 0.4,
    macroEventRisk: 0.1,
  });
  const opportunity = evaluateSentinelV2Opportunity({
    signal: signal("LONG"),
    asset: {
      symbol: "HYPE_USDT",
      observedAt: market.observedAt,
      dataQuality: 0.94,
      changePercentage: 3.5,
      fundingRate: 0.0001,
      openInterestChangePct: 1.1,
      spotCvdRatio: 0.08,
      orderBookImbalance: 0.12,
      liquidationImbalance: 0.05,
      multiTimeframeTrend: 0.72,
      volumeUsd: 500_000_000,
    },
    market,
    portfolio: {
      candidateSide: "LONG",
      candidateSymbol: "HYPE_USDT",
      openTrades: [
        { symbol: "BTC_USDT", side: "LONG" },
        { symbol: "ETH_USDT", side: "LONG" },
        { symbol: "SOL_USDT", side: "LONG" },
      ],
    },
  });
  assert.equal(opportunity.state, "REJECT");
  assert.ok(opportunity.rejectReasons.includes("PORTFOLIO_CONCENTRATION"));
  assert.equal(opportunity.riskMultiplier, 0);
});

test("RED permission cannot create a TRADE opportunity", () => {
  const market = buildSentinelV2MarketContext({
    observedAt: Date.UTC(2026, 7, 26, 4),
    universe: universe([7, -7, 6, -6, 5, -5, 4, -4, 3, -3, 2, -2], 0.0012),
    benchmarkMomentum: 0.2,
    optionsIvPercentile: 0.98,
    macroEventRisk: 0.99,
  });
  assert.equal(market.permission, "RED");
  const opportunity = evaluateSentinelV2Opportunity({
    signal: signal("LONG"),
    asset: {
      symbol: "BTC_USDT",
      observedAt: market.observedAt,
      dataQuality: 0.95,
      changePercentage: 2,
      fundingRate: 0.0001,
      openInterestChangePct: 1,
      spotCvdRatio: 0.1,
      orderBookImbalance: 0.1,
      liquidationImbalance: 0,
      multiTimeframeTrend: 0.8,
      volumeUsd: 2_000_000_000,
    },
    market,
    portfolio: { candidateSide: "LONG", candidateSymbol: "BTC_USDT", openTrades: [] },
  });
  assert.equal(opportunity.state, "REJECT");
  assert.ok(opportunity.rejectReasons.includes("TRANSITION_HIGH"));
});
