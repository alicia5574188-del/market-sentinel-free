import test from "node:test";
import assert from "node:assert/strict";
import { advanceStrategyArena, applyStrategySleepStates, ARENA_FRICTION_RATE, initialStrategyArena,
  observeStrategyArena, PAPER_DEMOTION_LOSSES, PROMOTION_WIN_STREAK, resetStrategyArenaAccount,
  STRATEGY_CATALOG, type ArenaObservation, type StrategyArenaState } from "../lib/strategy-arena.ts";

const strategyId = "anomaly_follow:confirm:fast";

function observation(event: number, now: number, symbol = "BTC_USDT", weakTarget = false): ArenaObservation {
  return {
    candidate: { id: `${symbol}:ANOMALY:${event}`, symbol, channel: "ANOMALY", regime: "EXPANSION", side: "LONG", score: 70,
      referencePrice: 100, moveRate: 0.01, trendRate: 0.005, trendEfficiency: 0.7, volatilityRatio: 2,
      rangePosition: 1, volume24hUsd: 1_000_000_000, fundingRate: 0.0001, openInterestChangeRate: 0,
      confirmations: 3, firstSeenAt: now - 20_000, observedAt: now, anomalyKind: "PRICE_SHOCK" },
    midpoint: 101, bestBid: 100.99, bestAsk: 101.01, alignedFlow: 0.4, minuteNoiseRate: 0.003,
    spreadRate: 0.0002, range15m: null, confirmationBySide: { LONG: 0.8, SHORT: 0.1 },
    fakeoutBySide: { LONG: 0.2, SHORT: 0.8 }, bidDepthUsd: 1_000_000, askDepthUsd: 1_000_000,
    quantoMultiplier: 0.001, maintenanceRate: 0.005, leverageMax: 50, dataFresh: true, contractReady: true,
    managementCapacity: true,
    routes: [{ id: `route:${event}`, symbol, side: "LONG", kind: "LOCAL_BREAKOUT", stage: "LOCAL_TO_NODE",
      entryTrigger: 100.82, invalidation: 100.65, target: weakTarget ? 101.45 : 103, targetIdentity: `target:${event}`,
      targetTimeframe: "15m", nextTarget: null, confirmationScore: 0.8, fakeoutRisk: 0.2,
      activationDistanceRate: 0.01, score: 80, executableNow: true, reason: ["test structure"] }], now,
  };
}

function openEvent(state: StrategyArenaState, event: number, now: number, symbol = "BTC_USDT", weakTarget = false) {
  return observeStrategyArena({ state, observation: observation(event, now, symbol, weakTarget) });
}

function settleEvent(state: StrategyArenaState, now: number, winner: boolean, symbol = "BTC_USDT") {
  const trades = [...Object.values(state.open), ...Object.values(state.portfolioOpen)].filter((trade) => trade.symbol === symbol);
  assert.ok(trades.length);
  const price = winner ? Math.max(...trades.map((trade) => trade.targetPrice)) + 0.01
    : Math.min(...trades.map((trade) => trade.stopPrice)) - 0.01;
  return advanceStrategyArena({ state, quotes: { [symbol]: { midpoint: price, bestBid: price, bestAsk: price + 0.01, fresh: true } }, now });
}

function qualify(state = initialStrategyArena(1), start = 10_000) {
  for (let index = 0; index < PROMOTION_WIN_STREAK; index += 1) {
    state = openEvent(state, index + 1, start + index * 20_000);
    state = settleEvent(state, start + index * 20_000 + 10_000, true);
  }
  return state;
}

test("V4 keeps 12 playbooks and 48 genuinely distinct execution variants", () => {
  assert.equal(STRATEGY_CATALOG.length, 48);
  assert.equal(new Set(STRATEGY_CATALOG.map((item) => item.id.split(":")[0])).size, 12);
  assert.equal(new Set(STRATEGY_CATALOG.map((item) => `${item.id}:${item.entryStyle}:${item.exitProfile}`)).size, 48);
});

test("confirmation/retest and fast/structure variants freeze different locations or targets", () => {
  const state = openEvent(initialStrategyArena(1), 1, 10_000);
  const variants = Object.values(state.open).filter((trade) => trade.strategyId.startsWith("anomaly_follow:"));
  assert.equal(variants.length, 4);
  assert.equal(new Set(variants.map((trade) => trade.context.entryTrigger)).size, 2);
  assert.equal(new Set(variants.map((trade) => trade.targetPrice)).size, 2);
});

test("observation shadow is separate and never counts toward promotion", () => {
  const thin = observation(1, 10_000); thin.bidDepthUsd = 100; thin.askDepthUsd = 100;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: thin });
  assert.equal(Object.keys(state.open).length, 0);
  assert.ok(state.recentObservations.length > 0);
  assert.equal(state.strategies[strategyId].shadowResolved, 0);
});

test("latest three independent effective shadow wins activate only the next signal", () => {
  let state = qualify();
  assert.equal(state.strategies[strategyId].lane, "ACTIVE");
  assert.equal(Object.keys(state.portfolioOpen).length, 0, "completed winners are never backfilled");
  state = openEvent(state, 20, 120_000);
  assert.equal(state.portfolioOpen.BTC_USDT.strategyId, strategyId);
  assert.equal(state.portfolioOpen.BTC_USDT.admissionTier, "NORMAL");
});

test("a low-win-rate variant can activate from a positive latest-six window", () => {
  let state = initialStrategyArena(1);
  const outcomes = [true, false, true, false, true, true];
  for (let index = 0; index < outcomes.length; index += 1) {
    state = openEvent(state, 300 + index, 200_000 + index * 20_000);
    state = settleEvent(state, 210_000 + index * 20_000, outcomes[index]);
  }
  assert.equal(state.strategies[strategyId].lane, "ACTIVE");
  assert.match(state.strategies[strategyId].lastTransitionReason, /最新6笔/);
});

test("latest three simulation losses demote the strategy", () => {
  let state = qualify();
  for (let index = 0; index < PAPER_DEMOTION_LOSSES; index += 1) {
    const symbol = index % 2 ? "ETH_USDT" : "BTC_USDT";
    state = openEvent(state, 30 + index, 120_000 + index * 20_000, symbol);
    state = settleEvent(state, 130_000 + index * 20_000, false, symbol);
  }
  assert.equal(state.strategies[strategyId].lane, "SHADOW");
  assert.equal(state.strategies[strategyId].enabled, false);
  assert.equal(state.strategies[strategyId].paperResults.length, 3);
});

test("sleep preserves rolling results and wakes to its prior enabled state", () => {
  let state = qualify();
  const before = structuredClone(state.strategies[strategyId].recentResults);
  state = applyStrategySleepStates(state, new Set(["RANGE"]), 100_000);
  assert.equal(state.strategies[strategyId].lane, "SLEEPING");
  assert.deepEqual(state.strategies[strategyId].recentResults, before);
  state = applyStrategySleepStates(state, new Set(["ANOMALY"]), 110_000);
  assert.equal(state.strategies[strategyId].lane, "ACTIVE");
});

test("effective shadow uses bid/ask, integer contracts, frozen exits and complete costs", () => {
  let state = openEvent(initialStrategyArena(1), 1, 10_000);
  const trade = state.open[`${strategyId}:BTC_USDT`];
  assert.equal(trade.entryPrice, 101.01);
  assert.ok(Number.isInteger(trade.contracts) && trade.contracts > 0);
  assert.ok(trade.plannedRisk >= 10 && trade.plannedRisk <= 20.1);
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: { midpoint: 103.02, bestBid: 103.01, bestAsk: 103.03, fresh: true } }, now: 8 * 60 * 60_000 });
  const closed = state.recentShadow.find((item) => item.strategyId === strategyId);
  assert.ok(closed && (closed.context.fundingCostRate ?? 0) > 0);
  assert.equal(Number((closed!.grossReturnRate! - closed!.netReturnRate!).toFixed(8)),
    Number((ARENA_FRICTION_RATE + (closed!.context.fundingCostRate ?? 0)).toFixed(8)));
});

test("stale prices cannot close and soft exits require a new completed minute", () => {
  let state = openEvent(initialStrategyArena(1), 1, 10_000);
  const count = Object.keys(state.open).length;
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: {
    midpoint: 99, bestBid: 99, bestAsk: 99.01, observedAt: 1, fresh: true,
  } }, now: 20_000 });
  assert.equal(Object.keys(state.open).length, count);
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: {
    midpoint: 101, bestBid: 101, bestAsk: 101.01, observedAt: 9 * 60_000, fresh: true,
  } }, now: 9 * 60_000 });
  assert.equal(Object.keys(state.open).length, count);
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: {
    midpoint: 101, bestBid: 101, bestAsk: 101.01, observedAt: 9 * 60_000, fresh: true, completedMinuteAt: 8 * 60_000,
  } }, now: 9 * 60_000 });
  assert.ok(Object.keys(state.open).length < count);
});

test("account reset uses executable quotes, archives the cycle and starts at 1000 U", () => {
  let state = openEvent(qualify(), 200, 500_000);
  state = resetStrategyArenaAccount({ state,
    quotes: { BTC_USDT: { midpoint: 101.2, bestBid: 101.19, bestAsk: 101.21, fresh: true } }, now: 510_000 });
  assert.equal(state.portfolioEquity, 1_000);
  assert.deepEqual(state.portfolioOpen, {});
  assert.equal(state.archivedPortfolioCycles.length, 1);
});
