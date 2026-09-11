import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceStrategyArena, advanceStrategyShadowsFromCompletedCandle, applyStrategySleepStates,
  initialStrategyArena, normalizeStrategyArena, observeStrategyArena, resetStrategyArenaAccount,
  STRATEGY_CATALOG, type ArenaObservation, type StrategyArenaState, type StrategyResult,
} from "../lib/strategy-arena.ts";
import { EXTREME_SEQUENCE_NAME } from "../lib/extreme-sequence-mirror.ts";

const base = 1_789_100_000_000;

function result(index: number, netReturnRate: number): StrategyResult {
  const resolvedAt = base + index * 5 * 60_000;
  return { eventId: `BTC_USDT:CANDLE5M:ANOMALY:LONG:${resolvedAt}`, symbol: "BTC_USDT",
    regime: "EXPANSION", channel: "ANOMALY", netReturnRate, netPnl: netReturnRate * 1_000,
    won: netReturnRate > 0, resolvedAt };
}

function observation(eventAt = base + 30 * 60_000, now = eventAt + 1_000, symbol = "BTC_USDT"): ArenaObservation {
  return { candidate: { id: `${symbol}:CANDLE5M:ANOMALY:LONG:${eventAt}`, symbol, channel: "ANOMALY",
      regime: "EXPANSION", side: "LONG", score: 91, referencePrice: 100, moveRate: 0.012,
      trendRate: 0.018, trendEfficiency: 0.72, volatilityRatio: 1.8, rangePosition: 0.94,
      volume24hUsd: 1_000_000_000, fundingRate: 0.0001, openInterestChangeRate: 0,
      confirmations: 2, firstSeenAt: eventAt, observedAt: eventAt, anomalyKind: "PRICE_SHOCK",
      adaptivePolicy: null, extremeSequence: { version: 1, branch: "FISSION", baseSide: "LONG", score: 91,
        triggerPrice: 101, invalidationPrice: 100.45, profitArmPrice: 102.55,
        maxHoldMinutes: 360, noProgressMinutes: 75, structureId: `FISSION:${eventAt}:1:2`,
        reason: "测试裂变" } },
    midpoint: 101, bestBid: 100.99, bestAsk: 101.01, alignedFlow: 0.4, minuteNoiseRate: 0.001,
    spreadRate: 0.0002, range15m: null, confirmationBySide: { LONG: 0.8, SHORT: 0.2 },
    fakeoutBySide: { LONG: 0.2, SHORT: 0.8 }, bidDepthUsd: 1_000_000, askDepthUsd: 1_000_000,
    quantoMultiplier: 0.001, maintenanceRate: 0.005, leverageMax: 50, dataFresh: true,
    contractReady: true, managementCapacity: true, globalOpportunityRank: 1,
    globalOpportunityCount: 1, routes: [], now };
}

function authorizeNormal(state = initialStrategyArena(1)) {
  const score = state.strategies.extreme_sequence_mirror;
  score.recentResults = [result(1, 0.01), result(2, 0.012), result(3, 0.009)];
  return applyStrategySleepStates(state, new Set(["ANOMALY"]), base + 20 * 60_000);
}

function authorizeReverse(state = initialStrategyArena(1)) {
  const score = state.strategies.extreme_sequence_mirror;
  score.recentResults = [result(1, -0.01), result(2, -0.012), result(3, -0.009)];
  score.reverseRecentResults = [result(1, 0.006), result(2, 0.008), result(3, 0.005)];
  return applyStrategySleepStates(state, new Set(["ANOMALY"]), base + 20 * 60_000);
}

test("V9 contains the single original 极序·镜转 strategy", () => {
  assert.equal(STRATEGY_CATALOG.length, 1);
  assert.equal(STRATEGY_CATALOG[0].id, "extreme_sequence_mirror");
  assert.equal(STRATEGY_CATALOG[0].name, EXTREME_SEQUENCE_NAME);
});

test("only a completed extreme event creates paired shadows", () => {
  const missing = observation(); missing.candidate.extremeSequence = null;
  assert.equal(Object.keys(observeStrategyArena({ state: initialStrategyArena(1), observation: missing }).open).length, 0);
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: observation() });
  assert.equal(Object.keys(state.open).length, 2);
  assert.deepEqual(new Set(Object.values(state.open).map((row) => row.orientation)), new Set(["NORMAL", "REVERSE"]));
  assert.equal(Object.keys(state.portfolioOpen).length, 0);
});

test("three normal wins authorize the next event in the base direction", () => {
  const state = observeStrategyArena({ state: authorizeNormal(), observation: observation() });
  const paper = state.portfolioOpen.BTC_USDT;
  assert.ok(paper);
  assert.equal(paper.orientation, "NORMAL");
  assert.equal(paper.side, "LONG");
  assert.equal(paper.strategyName, EXTREME_SEQUENCE_NAME);
  assert.deepEqual(paper.context.polarityEvidence, [0.01, 0.012, 0.009]);
});

test("three normal losses authorize reverse only when all paired reverse shadows won after cost", () => {
  const state = observeStrategyArena({ state: authorizeReverse(), observation: observation() });
  const paper = state.portfolioOpen.BTC_USDT;
  assert.ok(paper);
  assert.equal(paper.orientation, "REVERSE");
  assert.equal(paper.side, "SHORT");
  const mixed = initialStrategyArena(1);
  mixed.strategies.extreme_sequence_mirror.recentResults = [result(1, -0.01), result(2, -0.01), result(3, -0.01)];
  mixed.strategies.extreme_sequence_mirror.reverseRecentResults = [result(1, 0.01), result(2, -0.001), result(3, 0.01)];
  applyStrategySleepStates(mixed, new Set(["ANOMALY"]), base + 20 * 60_000);
  assert.equal(mixed.strategies.extreme_sequence_mirror.reverseEnabled, false);
});

test("mixed outcomes cannot enter PAPER", () => {
  const state = initialStrategyArena(1);
  state.strategies.extreme_sequence_mirror.recentResults = [result(1, 0.01), result(2, -0.01), result(3, 0.01)];
  applyStrategySleepStates(state, new Set(["ANOMALY"]), base + 20 * 60_000);
  const observed = observeStrategyArena({ state, observation: observation() });
  assert.equal(Object.keys(observed.portfolioOpen).length, 0);
});

test("stale data and insufficient depth remain observation only", () => {
  const stale = observation(); stale.dataFresh = false;
  const staleState = observeStrategyArena({ state: initialStrategyArena(1), observation: stale });
  assert.equal(Object.keys(staleState.open).length, 0);
  assert.ok(staleState.recentObservations.some((row) => row.blocker.includes("不新鲜")));
  const thin = observation(base + 35 * 60_000); thin.bidDepthUsd = 100; thin.askDepthUsd = 100;
  const thinState = observeStrategyArena({ state: initialStrategyArena(1), observation: thin });
  assert.equal(Object.keys(thinState.open).length, 0);
  assert.ok(thinState.recentObservations.some((row) => row.blocker.includes("深度不足")));
});

test("profit arm starts an uncapped runner and later protection closes it", () => {
  let state = observeStrategyArena({ state: authorizeNormal(), observation: observation() });
  const paper = state.portfolioOpen.BTC_USDT;
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: { midpoint: paper.targetPrice + 0.2,
    bestBid: paper.targetPrice + 0.2, bestAsk: paper.targetPrice + 0.21, observedAt: base + 31 * 60_000, fresh: true,
    completedMinuteAt: base + 31 * 60_000 } }, now: base + 31 * 60_000 });
  const runner = state.portfolioOpen.BTC_USDT;
  assert.ok(runner);
  assert.ok(runner.profitArmedAt);
  assert.ok((runner.activeStopPrice ?? 0) > runner.entryPrice);
  const exit = (runner.activeStopPrice ?? runner.stopPrice) - 0.01;
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: { midpoint: exit, bestBid: exit, bestAsk: exit + 0.01,
    observedAt: base + 32 * 60_000, fresh: true, completedMinuteAt: base + 32 * 60_000 } }, now: base + 32 * 60_000 });
  assert.equal(state.portfolioOpen.BTC_USDT, undefined);
  assert.equal(state.recentPortfolio.at(-1)?.outcome, "RUNNER_EXIT");
});

test("same symbol and branch cannot immediately re-enter after close", () => {
  let state = observeStrategyArena({ state: authorizeNormal(), observation: observation() });
  const paper = state.portfolioOpen.BTC_USDT;
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: { midpoint: paper.stopPrice - 0.1,
    bestBid: paper.stopPrice - 0.1, bestAsk: paper.stopPrice - 0.09, observedAt: base + 31 * 60_000, fresh: true } },
    now: base + 31 * 60_000 });
  state.strategies.extreme_sequence_mirror.recentResults = [result(1, 0.01), result(2, 0.012), result(3, 0.009)];
  applyStrategySleepStates(state, new Set(["ANOMALY"]), base + 34 * 60_000);
  const next = observation(base + 35 * 60_000, base + 35 * 60_000 + 1_000);
  state = observeStrategyArena({ state, observation: next });
  assert.equal(state.portfolioOpen.BTC_USDT, undefined);
  assert.ok((state.admissionRejects.SYMBOL_COOLDOWN ?? 0) >= 1);
});

test("global ranking gives all top-three extremes admission eligibility and rejects lower ranks", () => {
  const topState = authorizeNormal();
  const topAt = base + 40 * 5 * 60_000;
  const top = observation(topAt, topAt + 1_000, "SOL_USDT");
  top.globalOpportunityRank = 3;
  top.globalOpportunityCount = 4;
  const admitted = observeStrategyArena({ state: topState, observation: top });
  assert.ok(admitted.portfolioOpen.SOL_USDT);
  assert.equal(admitted.admissionRejects.GLOBAL_RANK, undefined);

  const lowerState = authorizeNormal();
  const lowerAt = base + 50 * 5 * 60_000;
  const lower = observation(lowerAt, lowerAt + 1_000, "XRP_USDT");
  lower.globalOpportunityRank = 4;
  lower.globalOpportunityCount = 4;
  const rejected = observeStrategyArena({ state: lowerState, observation: lower });
  assert.equal(Object.keys(rejected.portfolioOpen).length, 0);
  assert.ok((rejected.admissionRejects.GLOBAL_RANK ?? 0) >= 1);
});

test("completed candle resolves an initial stop before a same-candle profit arm", () => {
  let state = observeStrategyArena({ state: initialStrategyArena(1), observation: observation() });
  const normal = Object.values(state.open).find((row) => row.orientation === "NORMAL")!;
  state = advanceStrategyShadowsFromCompletedCandle({ state, symbol: "BTC_USDT", candle: {
    low: normal.stopPrice - 1, high: normal.targetPrice + 1, close: normal.entryPrice, completedAt: base + 40 * 60_000 } });
  assert.equal(state.recentShadow.find((row) => row.orientation === "NORMAL")?.outcome, "STOP");
});

test("V9 cutover archives the old account and begins a fresh 1000 U cycle", () => {
  const old = initialStrategyArena(1);
  (old as unknown as { version: number }).version = 8; old.portfolioCycle = 6; old.portfolioEquity = 958; old.portfolioResolved = 2;
  const state = normalizeStrategyArena(old as unknown as StrategyArenaState, base);
  assert.equal(state.version, 9);
  assert.equal(state.portfolioCycle, 7);
  assert.equal(state.portfolioEquity, 1_000);
  assert.equal(state.archivedPortfolioCycles.at(-1)?.number, 6);
});

test("manual reset archives the current cycle and preserves shadows", () => {
  let state = observeStrategyArena({ state: initialStrategyArena(1), observation: observation() });
  const shadowCount = Object.keys(state.open).length;
  state = resetStrategyArenaAccount({ state, quotes: {}, now: base + 40 * 60_000, reason: "test reset" });
  assert.equal(state.portfolioEquity, 1_000);
  assert.equal(state.portfolioResolved, 0);
  assert.equal(Object.keys(state.open).length, shadowCount);
});
