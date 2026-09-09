import test from "node:test";
import assert from "node:assert/strict";
import { advanceStrategyArena, ARENA_FRICTION_RATE, initialStrategyArena, observeStrategyArena,
  PAPER_DEMOTION_LOSSES, STRATEGY_CATALOG, VERIFIED_PAPER_EVENTS, type ArenaObservation,
  type StrategyArenaState } from "../lib/strategy-arena.ts";

const strategyId = "anomaly_follow:confirm:fast";

function observation(event: number, now: number, symbol = "BTC_USDT"): ArenaObservation {
  return {
    candidate: {
      id: `${symbol}:ANOMALY:${event}`, symbol, channel: "ANOMALY", regime: "EXPANSION", side: "LONG", score: 70,
      referencePrice: 100, moveRate: 0.01, trendRate: 0.005, trendEfficiency: 0.7, volatilityRatio: 2,
      rangePosition: 1, volume24hUsd: 1_000_000_000, fundingRate: 0, openInterestChangeRate: 0,
      confirmations: 3, firstSeenAt: now - 20_000, observedAt: now, anomalyKind: "PRICE_SHOCK",
    },
    midpoint: 101, alignedFlow: 0.4, minuteNoiseRate: 0.003, spreadRate: 0.0001, range15m: null,
    confirmationBySide: { LONG: 0.8, SHORT: 0.1 }, fakeoutBySide: { LONG: 0.2, SHORT: 0.8 }, routes: [], now,
  };
}

function openSignal(state: StrategyArenaState, event: number, now: number, symbol = "BTC_USDT") {
  return observeStrategyArena({ state, observation: observation(event, now, symbol) });
}

function closeSignal(state: StrategyArenaState, now: number, winner: boolean, symbol = "BTC_USDT") {
  const trade = state.open[`${strategyId}:${symbol}`];
  assert.ok(trade);
  return advanceStrategyArena({ state, quotes: { [symbol]: winner ? trade.targetPrice : trade.stopPrice }, now });
}

test("catalog contains 12 playbooks expanded into 48 contextual strategy cells", () => {
  assert.equal(STRATEGY_CATALOG.length, 48);
  assert.equal(new Set(STRATEGY_CATALOG.map((item) => item.id.split(":")[0])).size, 12);
  assert.deepEqual(new Set(STRATEGY_CATALOG.map((item) => item.family)), new Set(["TREND", "RANGE", "COMPRESSION", "EVENT"]));
});

test("the first after-cost shadow win promotes only to trial simulation", () => {
  let state = initialStrategyArena(1);
  state = openSignal(state, 1, 10_000);
  state = closeSignal(state, 20_000, true);
  assert.equal(state.strategies[strategyId].lane, "TRIAL");
  assert.equal(state.strategies[strategyId].shadowResolved, 1);
  assert.equal(state.transitions.at(-1)?.to, "TRIAL");
});

test("two consecutive trial losses demote and a new shadow win reactivates", () => {
  let state = initialStrategyArena(1);
  state = closeSignal(openSignal(state, 1, 10_000), 20_000, true);
  for (let index = 0; index < PAPER_DEMOTION_LOSSES; index += 1) {
    state = openSignal(state, 10 + index, 30_000 + index * 30_000);
    assert.equal(state.open[`${strategyId}:BTC_USDT`].lane, "TRIAL");
    state = closeSignal(state, 40_000 + index * 30_000, false);
  }
  assert.equal(state.strategies[strategyId].lane, "SHADOW");
  assert.equal(state.strategies[strategyId].paperResolved, 2);
  state = closeSignal(openSignal(state, 20, 100_000), 110_000, true);
  assert.equal(state.strategies[strategyId].lane, "TRIAL");
});

test("verified simulation requires twelve distinct events across four symbols", () => {
  let state = initialStrategyArena(1);
  state = closeSignal(openSignal(state, 1, 10_000), 20_000, true);
  for (let index = 0; index < VERIFIED_PAPER_EVENTS; index += 1) {
    const symbol = [`BTC_USDT`, `ETH_USDT`, `SOL_USDT`, `SUI_USDT`][index % 4];
    state = openSignal(state, 100 + index, 30_000 + index * 30_000, symbol);
    state = closeSignal(state, 40_000 + index * 30_000, true, symbol);
  }
  assert.equal(state.strategies[strategyId].lane, "VERIFIED");
});

test("isolated strategy simulation and non-duplicating portfolio simulation stay separate", () => {
  let state = initialStrategyArena(1);
  state = closeSignal(openSignal(state, 1, 10_000), 20_000, true);
  state = openSignal(state, 2, 30_000);
  assert.ok(Object.values(state.open).some((trade) => trade.lane === "TRIAL"));
  assert.equal(Object.keys(state.portfolioOpen).length, 1);
  const count = Object.keys(state.portfolioOpen).length;
  state = openSignal(state, 2, 32_000);
  assert.equal(Object.keys(state.portfolioOpen).length, count);
});

test("records freeze regime context, path excursion and conservative modeled cost", () => {
  let state = initialStrategyArena(1);
  state = openSignal(state, 1, 10_000);
  const trade = state.open[`${strategyId}:BTC_USDT`];
  assert.equal(trade.context.channel, "ANOMALY");
  assert.equal(trade.context.regime, "EXPANSION");
  assert.ok(trade.context.modeledCostRate >= ARENA_FRICTION_RATE);
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: trade.targetPrice }, now: 20_000 });
  const closed = state.recentShadow.find((item) => item.strategyId === strategyId);
  assert.ok(closed);
  assert.ok(closed.maxFavorableRate > 0);
  assert.equal(Number((closed.grossReturnRate! - closed.netReturnRate!).toFixed(8)), ARENA_FRICTION_RATE);
});
