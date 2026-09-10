import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceStrategyArena, advanceStrategyShadowsFromCompletedCandle, applyStrategySleepStates,
  initialStrategyArena, normalizeStrategyArena, observeStrategyArena, resetStrategyArenaAccount,
  STRATEGY_CATALOG, type ArenaObservation, type StrategyArenaState,
} from "../lib/strategy-arena.ts";
import type { AdaptiveMechanism, AdaptivePolicyRecommendation } from "../lib/adaptive-policy.ts";

function recommendation(overrides: Partial<AdaptivePolicyRecommendation> = {}): AdaptivePolicyRecommendation {
  return { mechanism: "BREAKOUT_ACCEPTANCE", side: "LONG", horizonMinutes: 30,
    samples: 16, discoverySamples: 11, confirmationSamples: 5, confirmationNetReturnRate: 0.002,
    wins: 10, netExpectationRate: 0.003, conservativeNetReturnRate: 0.0015, profitFactor: 1.4,
    targetReachRate: 0.5, largestWinShare: 0.2, stopRate: 0.004, targetRate: 0.01,
    reachableRate: 0.015, opportunityRatePerDay: 3, objectiveScore: 0.018, approved: true,
    reason: "旧样本选择、最近独立样本确认成本后正期望", ...overrides };
}

function observation(event: number, now: number, policies: AdaptivePolicyRecommendation[] = [recommendation()],
  symbol = "BTC_USDT"): ArenaObservation {
  return { candidate: { id: `${symbol}:CANDLE5M:EXPANSION:LONG:${event}`, symbol, channel: "ANOMALY",
      regime: "EXPANSION", side: "LONG", score: 80, referencePrice: 100, moveRate: 0.01,
      trendRate: 0.006, trendEfficiency: 0.7, volatilityRatio: 1.5, rangePosition: 0.9,
      volume24hUsd: 1_000_000_000, fundingRate: 0.0001, openInterestChangeRate: 0,
      confirmations: 3, firstSeenAt: now - 300_000, observedAt: now, anomalyKind: null,
      adaptivePolicy: { version: 2, generatedAt: now, candleCount: 240, objectiveDailyReturnRate: 0.1,
        currentState: [0.3, 0.7, 0.2, 0.8, 0.4, 0.1, 0.6], recommendations: policies } },
    midpoint: 101, bestBid: 100.99, bestAsk: 101.01, alignedFlow: 0.4, minuteNoiseRate: 0.001,
    spreadRate: 0.0002, range15m: null, confirmationBySide: { LONG: 0.8, SHORT: 0.2 },
    fakeoutBySide: { LONG: 0.2, SHORT: 0.8 }, bidDepthUsd: 1_000_000, askDepthUsd: 1_000_000,
    quantoMultiplier: 0.001, maintenanceRate: 0.005, leverageMax: 50, dataFresh: true,
    contractReady: true, managementCapacity: true, routes: [], now };
}

const open = (state = initialStrategyArena(1), event = 1, now = 100_000,
  policies?: AdaptivePolicyRecommendation[], symbol?: string) => observeStrategyArena({ state,
  observation: observation(event, now, policies, symbol) });

test("V6 catalog contains six generated mechanisms and no legacy 12/48 playbooks", () => {
  assert.equal(STRATEGY_CATALOG.length, 6);
  assert.equal(new Set(STRATEGY_CATALOG.map((row) => row.mechanism)).size, 6);
  assert.deepEqual(new Set(STRATEGY_CATALOG.map((row) => row.mechanism)), new Set<AdaptiveMechanism>([
    "RANGE_ROTATION", "COMPRESSION_EXPANSION", "FAILED_AUCTION", "PULLBACK_RECOVERY",
    "MOMENTUM_CONTINUATION", "BREAKOUT_ACCEPTANCE",
  ]));
  assert.equal(STRATEGY_CATALOG.some((row) => row.id.includes(":")), false);
});

test("only completed-candle state policies may create effective routes", () => {
  const missing = observation(1, 100_000, []);
  missing.candidate.adaptivePolicy = null;
  assert.equal(Object.keys(observeStrategyArena({ state: initialStrategyArena(1), observation: missing }).open).length, 0);
  const realtime = observation(2, 100_001);
  realtime.candidate.id = "BTC_USDT:ANOMALY:2";
  assert.equal(Object.keys(observeStrategyArena({ state: initialStrategyArena(1), observation: realtime }).open).length, 0);
});

test("unapproved state route remains effective shadow and cannot enter PAPER", () => {
  const state = open(initialStrategyArena(1), 3, 100_000,
    [recommendation({ approved: false, conservativeNetReturnRate: -0.001, objectiveScore: -0.01 })]);
  assert.equal(Object.keys(state.open).length, 1);
  assert.equal(Object.keys(state.portfolioOpen).length, 0);
});

test("approved state route enters PAPER as an exact clone of its shadow", () => {
  const state = open();
  const shadow = Object.values(state.open)[0];
  const paper = state.portfolioOpen.BTC_USDT;
  assert.ok(shadow && paper);
  assert.equal(shadow.strategyId, "boundary_acceptance");
  assert.equal(shadow.strategyName, "边界有效接受");
  assert.equal(paper.context.adaptivePolicyVersion, 2);
  assert.equal(paper.orientation, "NORMAL");
  assert.equal(Object.values(state.open).some((row) => row.orientation === "REVERSE"), false);
  for (const key of ["eventId", "strategyId", "side", "openedAt", "entryPrice", "stopPrice", "targetPrice",
    "notional", "plannedRisk", "contracts", "quantoMultiplier", "leverage", "margin"] as const)
    assert.equal(paper[key], shadow[key], `${key} must be cloned exactly`);
  assert.equal(paper.context.maxHoldMs, 30 * 60_000);
  assert.equal(paper.context.noProgressMs, 18 * 60_000);
});

test("one coin can research several generated paths while PAPER selects the best objective", () => {
  const policies = [
    recommendation({ mechanism: "RANGE_ROTATION", side: "SHORT", objectiveScore: 0.011 }),
    recommendation({ mechanism: "MOMENTUM_CONTINUATION", objectiveScore: 0.015 }),
    recommendation({ mechanism: "BREAKOUT_ACCEPTANCE", objectiveScore: 0.021 }),
  ];
  const state = open(initialStrategyArena(1), 4, 100_000, policies);
  assert.equal(Object.keys(state.open).length, 3);
  assert.equal(Object.keys(state.portfolioOpen).length, 1);
  assert.equal(state.portfolioOpen.BTC_USDT.strategyId, "boundary_acceptance");
});

test("stale data and insufficient depth stay observation-only", () => {
  const stale = observation(5, 100_000); stale.dataFresh = false;
  const staleState = observeStrategyArena({ state: initialStrategyArena(1), observation: stale });
  assert.equal(Object.keys(staleState.open).length, 0);
  assert.ok(staleState.recentObservations.some((row) => row.blocker.includes("不新鲜")));
  const thin = observation(6, 100_001); thin.bidDepthUsd = 100; thin.askDepthUsd = 100;
  const thinState = observeStrategyArena({ state: initialStrategyArena(1), observation: thin });
  assert.equal(Object.keys(thinState.open).length, 0);
  assert.ok(thinState.recentObservations.some((row) => row.blocker.includes("深度不足")));
});

test("the same mechanism and coin cannot overlap an existing shadow", () => {
  const first = open();
  const second = open(first, 7, 100_001);
  assert.equal(Object.keys(second.open).length, 1);
  assert.ok(second.recentObservations.some((row) => row.blocker.includes("已有有效影子持仓")));
});

test("stale executable quotes cannot close; fresh bid can reach target", () => {
  let state = open();
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: { midpoint: 103, bestBid: 103, bestAsk: 103.01,
    observedAt: 1, fresh: true } }, now: 200_000 });
  assert.ok(state.portfolioOpen.BTC_USDT);
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: { midpoint: 103, bestBid: 103, bestAsk: 103.01,
    observedAt: 200_001, fresh: true } }, now: 200_001 });
  assert.equal(state.portfolioOpen.BTC_USDT, undefined);
  assert.equal(state.recentPortfolio.at(-1)?.outcome, "TARGET");
});

test("completed candle touching stop and target settles research stop-first", () => {
  const state = open(initialStrategyArena(1), 8, 100_000,
    [recommendation({ approved: false })]);
  const trade = Object.values(state.open)[0];
  const advanced = advanceStrategyShadowsFromCompletedCandle({ state, symbol: "BTC_USDT",
    candle: { low: trade.stopPrice - 1, high: trade.targetPrice + 1, close: trade.entryPrice, completedAt: 400_000 } });
  assert.equal(Object.keys(advanced.open).length, 0);
  assert.equal(advanced.recentShadow.at(-1)?.outcome, "STOP");
});

test("sizing uses executable ask, integer contracts and 10-20 U planned risk", () => {
  const trade = Object.values(open().open)[0];
  assert.equal(trade.entryPrice, 101.01);
  assert.ok(Number.isInteger(trade.contracts) && trade.contracts > 0);
  assert.ok(trade.plannedRisk >= 10 && trade.plannedRisk <= 20.01);
});

test("legacy sleep flags cannot restore fixed strategy authority", () => {
  const state = initialStrategyArena(1);
  for (const score of Object.values(state.strategies)) { score.enabled = true; score.reverseEnabled = true; score.lane = "ACTIVE"; }
  applyStrategySleepStates(state, new Set(["TREND"]), 100_000);
  assert.ok(Object.values(state.strategies).every((score) => score.lane === "SHADOW" && !score.enabled && !score.reverseEnabled));
});

test("account reset archives current cycle, uses fresh quotes and preserves research", () => {
  let state = open();
  const shadowCount = Object.keys(state.open).length;
  state = resetStrategyArenaAccount({ state, quotes: { BTC_USDT: { midpoint: 101.2, bestBid: 101.19,
    bestAsk: 101.21, observedAt: 110_000, fresh: true } }, now: 110_000, reason: "test reset" });
  assert.equal(state.portfolioEquity, 1_000);
  assert.equal(state.portfolioResolved, 0);
  assert.deepEqual(state.portfolioOpen, {});
  assert.equal(state.archivedPortfolioCycles.length, 1);
  assert.equal(state.portfolioCycle, 2);
  assert.equal(Object.keys(state.open).length, shadowCount);
});

test("V6 cutover archives a flat legacy cycle and starts a fresh 1000 U cycle", () => {
  const old = initialStrategyArena(1);
  (old as unknown as { version: number }).version = 6; old.portfolioCycle = 3; old.portfolioEquity = 895; old.portfolioResolved = 36;
  old.portfolioWins = 10; old.portfolioGrossPnl = -25; old.portfolioCosts = 80;
  const state = normalizeStrategyArena(old as unknown as StrategyArenaState, 200_000);
  assert.equal(state.version, 7);
  assert.equal(state.portfolioCycle, 4);
  assert.equal(state.portfolioEquity, 1_000);
  assert.equal(state.portfolioResolved, 0);
  assert.equal(state.archivedPortfolioCycles.at(-1)?.number, 3);
  assert.equal(Object.keys(state.strategies).length, 6);
});
