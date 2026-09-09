import test from "node:test";
import assert from "node:assert/strict";
import { advanceStrategyArena, ARENA_FRICTION_RATE, initialStrategyArena, observeStrategyArena,
  PAPER_DEMOTION_LOSSES, SHADOW_PROMOTION_SAMPLE, STRATEGY_CATALOG, type ArenaObservation,
  type StrategyArenaState } from "../lib/strategy-arena.ts";

function observation(event: number, now: number): ArenaObservation {
  return {
    candidate: {
      id: `BTC_USDT:${event}`,
      symbol: "BTC_USDT",
      side: "LONG",
      strength: 70,
      moveRate: 0.01,
      movementMultiple: 4,
      volume24hUsd: 1_000_000_000,
      confirmations: 3,
      firstSeenAt: now - 20_000,
      observedAt: now,
      kind: "PRICE_SHOCK",
      openInterestChangeRate: 0,
      referencePrice: 100,
    },
    midpoint: 101,
    alignedFlow: 0.4,
    minuteNoiseRate: 0.003,
    range15m: null,
    confirmationBySide: { LONG: 0.8, SHORT: 0.1 },
    fakeoutBySide: { LONG: 0.2, SHORT: 0.8 },
    routes: [],
    now,
  };
}

function openImpulse(state: StrategyArenaState, event: number, now: number) {
  return observeStrategyArena({ state, observation: observation(event, now) });
}

function closeImpulse(state: StrategyArenaState, now: number, winner: boolean) {
  const trade = state.open["impulse_follow:BTC_USDT"];
  assert.ok(trade);
  return advanceStrategyArena({ state, quotes: { BTC_USDT: winner ? trade.targetPrice : trade.stopPrice }, now });
}

test("catalog contains every strategy family supported by the existing market data", () => {
  assert.equal(STRATEGY_CATALOG.length, 10);
  assert.deepEqual(new Set(STRATEGY_CATALOG.map((item) => item.family)),
    new Set(["MOMENTUM", "PULLBACK", "ORDER_FLOW", "STRUCTURE", "MEAN_REVERSION"]));
});

test("a single lucky shadow win cannot promote a strategy", () => {
  let state = initialStrategyArena(1);
  state = openImpulse(state, 1, 10_000);
  state = closeImpulse(state, 20_000, true);
  assert.equal(state.strategies.impulse_follow.lane, "SHADOW");
  assert.equal(state.strategies.impulse_follow.shadowResolved, 1);
  assert.ok(state.strategies.impulse_follow.shadowNetReturnRate > 0);
});

test("six profitable after-cost observations promote, then two paper losses demote", () => {
  let state = initialStrategyArena(1);
  for (let index = 0; index < SHADOW_PROMOTION_SAMPLE; index += 1) {
    state = openImpulse(state, index, 10_000 + index * 30_000);
    state = closeImpulse(state, 20_000 + index * 30_000, true);
  }
  assert.equal(state.strategies.impulse_follow.lane, "PAPER");
  assert.equal(state.strategies.impulse_follow.shadowWins, SHADOW_PROMOTION_SAMPLE);
  assert.equal(state.transitions.at(-1)?.to, "PAPER");

  for (let index = 0; index < PAPER_DEMOTION_LOSSES; index += 1) {
    state = openImpulse(state, 100 + index, 300_000 + index * 30_000);
    assert.equal(state.open["impulse_follow:BTC_USDT"].lane, "PAPER");
    state = closeImpulse(state, 310_000 + index * 30_000, false);
  }
  const score = state.strategies.impulse_follow;
  assert.equal(score.lane, "SHADOW");
  assert.equal(score.paperResolved, 2);
  assert.equal(score.transitions, 2);
  assert.equal(state.transitions.at(-1)?.reason, "模拟连续亏损2笔");
  assert.equal(state.recentPaper.filter((item) => item.strategyId === "impulse_follow").length, 2);
  assert.ok(score.paperEquity < 1_000);
});

test("one event can open each eligible strategy only once and costs are included", () => {
  let state = initialStrategyArena(1);
  state = openImpulse(state, 1, 10_000);
  const count = Object.keys(state.open).length;
  state = openImpulse(state, 1, 12_000);
  assert.equal(Object.keys(state.open).length, count);
  const trade = state.open["impulse_follow:BTC_USDT"];
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: trade.targetPrice }, now: 20_000 });
  const closed = state.recentShadow.find((item) => item.strategyId === "impulse_follow");
  assert.ok(closed);
  assert.equal(Number((closed.grossReturnRate! - closed.netReturnRate!).toFixed(8)), ARENA_FRICTION_RATE);
});
