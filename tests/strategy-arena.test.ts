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

function openForStrategy(state: StrategyArenaState, wanted: string, eventStart: number, now: number, symbol = "BTC_USDT") {
  for (let offset = 0; offset < 100; offset += 1) {
    const candidate = openEvent(structuredClone(state), eventStart + offset, now + offset, symbol);
    if (Object.values(candidate.open).some((trade) => trade.strategyId === wanted))
      return { state: candidate, event: eventStart + offset, now: now + offset };
  }
  throw new Error(`no event selected ${wanted}`);
}

function qualify(state = initialStrategyArena(1), start = 10_000) {
  let eventStart = 1;
  for (let index = 0; index < PROMOTION_WIN_STREAK; index += 1) {
    const opened = openForStrategy(state, strategyId, eventStart, start + index * 20_000);
    state = settleEvent(opened.state, opened.now + 10_000, true);
    eventStart = opened.event + 1;
  }
  return state;
}

test("V4 keeps 12 playbooks and 48 genuinely distinct execution variants", () => {
  assert.equal(STRATEGY_CATALOG.length, 48);
  assert.equal(new Set(STRATEGY_CATALOG.map((item) => item.id.split(":")[0])).size, 12);
  assert.equal(new Set(STRATEGY_CATALOG.map((item) => `${item.id}:${item.entryStyle}:${item.exitProfile}`)).size, 48);
});

test("confirmation/retest and fast/structure variants freeze different locations or targets", () => {
  const byStrategy = new Map();
  for (let event = 1; event <= 40; event += 1) {
    const state = openEvent(initialStrategyArena(1), event, 10_000 + event);
    for (const trade of Object.values(state.open).filter((row) => row.strategyId.startsWith("anomaly_follow:")))
      byStrategy.set(trade.strategyId, trade);
  }
  const variants = [...byStrategy.values()];
  assert.equal(variants.length, 4);
  assert.equal(new Set(variants.map((trade) => trade.context.entryTrigger)).size, 2);
  assert.equal(new Set(variants.map((trade) => trade.targetPrice)).size, 2);
});

test("one market event creates and scores only one effective shadow trade", () => {
  const first = openEvent(initialStrategyArena(1), 1, 10_000);
  assert.equal(Object.keys(first.open).length, 1);
  assert.ok(first.recentObservations.some((row) => row.blocker.includes("同一市场事件已由")));
  const repeated = openEvent(first, 1, 10_001);
  assert.equal(Object.keys(repeated.open).length, 1);
  const closed = settleEvent(repeated, 20_000, true);
  assert.equal(closed.recentShadow.length, 1);
  assert.equal(Object.values(closed.strategies).reduce((total, score) => total + score.shadowResolved, 0), 1);
});

test("a new event id cannot overlap an existing effective shadow on the same symbol", () => {
  const first = openEvent(initialStrategyArena(1), 1, 10_000);
  const existing = Object.values(first.open)[0];
  const second = openEvent(first, 2, 10_001);
  assert.equal(Object.keys(second.open).length, 1);
  assert.equal(Object.values(second.open)[0].id, existing.id);
  assert.ok(second.recentObservations.some((row) => row.eventId.endsWith(":2")
    && row.blocker.includes("同币种已有") && row.blocker.includes("仅观察")));
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
  assert.equal(Object.values(state.strategies).filter((row) => row.id.startsWith("anomaly_follow:") && row.enabled).length, 4,
    "promotion belongs to the base playbook while its four geometries remain selectable");
  assert.equal(Object.keys(state.portfolioOpen).length, 0, "completed winners are never backfilled");
  state = openEvent(state, 20, 120_000);
  assert.equal(state.portfolioOpen.BTC_USDT.strategyId, strategyId);
  assert.equal(state.portfolioOpen.BTC_USDT.admissionTier, "NORMAL");
});

test("a low-win-rate variant can activate from a positive latest-six window", () => {
  let state = initialStrategyArena(1);
  const outcomes = [true, false, true, false, true, true];
  let eventStart = 300;
  for (let index = 0; index < outcomes.length; index += 1) {
    const opened = openForStrategy(state, strategyId, eventStart, 200_000 + index * 20_000);
    state = settleEvent(opened.state, opened.now + 10_000, outcomes[index]);
    eventStart = opened.event + 1;
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
  assert.equal(Object.values(state.strategies).filter((row) => row.id.startsWith("anomaly_follow:") && row.enabled).length, 0);
});

test("unproven playbooks remain in shadow instead of sleeping when their channel is absent", () => {
  const state = applyStrategySleepStates(initialStrategyArena(1), new Set(["RANGE"]), 100_000);
  assert.equal(Object.values(state.strategies).filter((row) => row.lane === "SLEEPING").length, 0);
  assert.equal(Object.values(state.strategies).filter((row) => row.lane === "SHADOW").length, 48);
});

test("completed five-minute structure can create a valid shadow route without radar route geometry", () => {
  const input = observation(1, 10_000);
  input.candidate = { ...input.candidate, id: "BTC_USDT:CANDLE5M:TREND:LONG:1", channel: "TREND", regime: "TREND",
    trendEfficiency: 0.8, trendRate: 0.01, rangePosition: 0.9, anomalyKind: null };
  input.routes = [];
  input.range15m = null;
  input.candleStructure = { id: "BTC_USDT:5m:1", observedAt: 10_000, lower: 98, upper: 101.2,
    midpoint: 99.6, recentLower: 99.2, recentUpper: 101.2 };
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  const trade = Object.values(state.open)[0];
  assert.ok(trade);
  assert.equal(trade.context.structureSource, "CANDLE_5M");
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
