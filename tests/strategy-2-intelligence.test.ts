import test from "node:test";
import assert from "node:assert/strict";
import { buildStrategy2Intelligence } from "../lib/strategy-2-intelligence.ts";
import type { V2MarketContext } from "../lib/sentinel-v2-core.ts";
import type { Strategy2LearningDashboard } from "../lib/strategy-2-learning.ts";
import type { Strategy2Opportunity } from "../lib/sentinel-v2-strategy.ts";

function market(overrides: Partial<V2MarketContext> = {}): V2MarketContext {
  return {
    version: "sentinel-v2",
    observedAt: 2_000_000,
    regime: "expansion",
    regimeLabel: "波动扩张",
    confidence: 82,
    stability: 72,
    regimeScore: 78,
    regimeMargin: 11,
    transitionRisk: 48,
    transitionVelocity: 6,
    riskAcceleration: 2,
    developingRegime: "compression",
    permission: "YELLOW",
    bias: "NEUTRAL",
    breadth: { sampleSize: 20, advancingRatio: 0.5, decliningRatio: 0.5, medianChangePct: 0, bullishParticipation: 50, bearishParticipation: 50 },
    volatility: { dispersionPct: 3.2, ivPercentile: 0.7, state: "expanding" },
    leverage: { crowdedRatio: 0.1, averageFundingAbs: 0.0001, state: "healthy" },
    transition: {
      trendDeterioration: 30,
      breadthDeterioration: 35,
      flowDivergence: 20,
      leverageStress: 15,
      volatilityTransition: 62,
      breakoutFailure: 25,
      strategyHealthDeterioration: 15,
    },
    warnings: [],
    topDrivers: [],
    dataIntegrity: { valid: true, universeSize: 20, stale: false, reason: null },
    ...overrides,
  };
}

function opportunity(overrides: Partial<Strategy2Opportunity> = {}): Strategy2Opportunity {
  return {
    symbol: "BTC_USDT",
    observedAt: 1_900_000,
    playbook: "P5_EXPANSION_MOMENTUM",
    playbookLabel: "P5 扩张动量",
    strategyId: "expansion_momentum",
    side: "LONG",
    state: "WATCH",
    tradeMode: "standard",
    opportunityScore: 76,
    environmentFit: 82,
    playbookFit: 84,
    structure: 78,
    timing: 72,
    confirmation: 70,
    riskReward: 2,
    portfolioImpact: 80,
    riskMultiplier: 0,
    globalRegime: "expansion",
    assetRegime: "expansion_up",
    learningScore: 66,
    learningConfidence: 64,
    learningState: "positive",
    explorationValue: 20,
    experienceSamples: 18,
    expectancyR: 0.24,
    recentExpectancyR: 0.18,
    t1HitRate: 0.6,
    directionFailureRate: 0.2,
    inverseT1PotentialRate: 0.1,
    supportingPlaybooks: [],
    strategyConflict: 18,
    waitingFor: ["等待确认"],
    rejectReasons: [],
    reasons: ["测试"],
    maxRisk: null,
    ...overrides,
  };
}

function learning(overrides: Partial<Strategy2LearningDashboard> = {}): Strategy2LearningDashboard {
  return {
    totalSamples: 120,
    playbookCoverage: 12,
    exactCellCount: 30,
    positiveCells: 6,
    negativeCells: 2,
    degradingCells: 1,
    forwardSamples: 40,
    activeSession: "morning",
    activeSessionLabel: "上午 06:00–12:00",
    activeSessionSamples: 24,
    sessionProfiles: [],
    cells: [],
    recentTrades: [],
    ...overrides,
  };
}

test("surfaces a candidate regime without forcing the current regime to switch", () => {
  const result = buildStrategy2Intelligence({
    observedAt: 2_000_000,
    market: market(),
    opportunities: [opportunity()],
    learning: learning(),
    openTrades: [],
  });
  assert.equal(result.regimeMigration?.currentRegime, "expansion");
  assert.equal(result.regimeMigration?.candidateRegime, "compression");
  assert.ok((result.regimeMigration?.transitionProbability ?? 0) > 0);
  assert.ok(["forming", "developing", "switch_watch"].includes(result.regimeMigration?.stage ?? ""));
});

test("uncertainty layer is conservative and can only advise reducing or blocking", () => {
  const result = buildStrategy2Intelligence({
    observedAt: 2_000_000,
    market: market({ transitionRisk: 82, stability: 20, volatility: { dispersionPct: 6, ivPercentile: 0.95, state: "extreme" } }),
    opportunities: [opportunity({
      strategyConflict: 94,
      learningConfidence: 5,
      experienceSamples: 0,
      expectancyR: -0.2,
      opportunityScore: 64,
    })],
    learning: learning(),
    openTrades: [],
  });
  assert.equal(result.decisions[0].advisoryState, "BLOCK");
  assert.ok(result.decisions[0].outOfDistributionRisk >= 80 || result.decisions[0].modelDisagreement >= 90);
  assert.ok(result.decisions[0].advisoryReasons.length > 0);
});

test("expert weights rank stronger learned environment fits ahead of weaker experts", () => {
  const result = buildStrategy2Intelligence({
    observedAt: 2_000_000,
    market: market(),
    opportunities: [
      opportunity(),
      opportunity({
        symbol: "ETH_USDT",
        playbook: "P3_RANGE_REVERSAL",
        playbookLabel: "P3 震荡边缘反转",
        strategyId: "range_reversion",
        playbookFit: 45,
        environmentFit: 42,
        learningScore: 38,
        learningConfidence: 22,
        learningState: "degrading",
      }),
    ],
    learning: learning(),
    openTrades: [],
  });
  assert.equal(result.experts[0].playbook, "P5_EXPANSION_MOMENTUM");
  assert.ok(result.experts[0].weight > result.experts[1].weight);
});

test("portfolio intelligence detects regime and direction concentration without pretending it is correlation", () => {
  const result = buildStrategy2Intelligence({
    observedAt: 2_000_000,
    market: market(),
    opportunities: [opportunity()],
    learning: learning(),
    openTrades: [
      { side: "SHORT", regime: "S2|P1|global:bear_trend|asset:trend_down" },
      { side: "SHORT", regime: "S2|P5|global:bear_trend|asset:expansion_down" },
      { side: "SHORT", regime: "S2|P9|global:bear_trend|asset:trend_down" },
      { side: "LONG", regime: "S2|P4|global:compression|asset:compression" },
    ],
  });
  assert.equal(result.portfolio.directionConcentration, 75);
  assert.equal(result.portfolio.regimeSideConcentration, 75);
  assert.equal(result.portfolio.dominantFactor, "SHORT · bear_trend");
  assert.equal(result.portfolio.riskState, "HIGH");
});

test("learning update makes degrading and negative cells explicit", () => {
  const result = buildStrategy2Intelligence({
    observedAt: 2_000_000,
    market: market(),
    opportunities: [opportunity()],
    learning: learning(),
    openTrades: [],
  });
  assert.match(result.learningUpdate?.headline ?? "", /优势衰退/);
  assert.match(result.learningUpdate?.riskNote ?? "", /负优势/);
  assert.equal(result.governance.automaticPromotion, false);
});
