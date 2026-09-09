import test from "node:test";
import assert from "node:assert/strict";
import { advanceStrategyArena, ARENA_FRICTION_RATE, initialStrategyArena, observeStrategyArena,
  PAPER_DEMOTION_LOSSES, PROBATION_MIN_EVENTS, resetStrategyArenaAccount, STRATEGY_CATALOG,
  VERIFIED_PAPER_EVENTS, type ArenaObservation, type StrategyArenaState } from "../lib/strategy-arena.ts";

const strategyId = "anomaly_follow:confirm:fast";

function observation(event: number, now: number, symbol = "BTC_USDT", weakTarget = false): ArenaObservation {
  return {
    candidate: { id: `${symbol}:ANOMALY:${event}`, symbol, channel: "ANOMALY", regime: "EXPANSION", side: "LONG", score: 70,
      referencePrice: 100, moveRate: 0.01, trendRate: 0.005, trendEfficiency: 0.7, volatilityRatio: 2,
      rangePosition: 1, volume24hUsd: 1_000_000_000, fundingRate: 0, openInterestChangeRate: 0,
      confirmations: 3, firstSeenAt: now - 20_000, observedAt: now, anomalyKind: "PRICE_SHOCK" },
    midpoint: 101, bestBid: 100.99, bestAsk: 101.01, alignedFlow: 0.4, minuteNoiseRate: 0.003,
    spreadRate: 0.0002, range15m: null, confirmationBySide: { LONG: 0.8, SHORT: 0.1 },
    fakeoutBySide: { LONG: 0.2, SHORT: 0.8 }, bidDepthUsd: 1_000_000, askDepthUsd: 1_000_000,
    quantoMultiplier: 0.001, maintenanceRate: 0.005, leverageMax: 50,
    routes: [{ id: `route:${event}`, symbol, side: "LONG", kind: "LOCAL_BREAKOUT", stage: "LOCAL_TO_NODE",
      entryTrigger: 101, invalidation: 100.65, target: weakTarget ? 101.45 : 103, targetIdentity: `target:${event}`,
      targetTimeframe: "15m", nextTarget: null, confirmationScore: 0.8, fakeoutRisk: 0.2,
      activationDistanceRate: 0.01, score: 80, executableNow: true, reason: ["test structure"] }], now,
  };
}

function openEvent(state: StrategyArenaState, event: number, now: number, symbol = "BTC_USDT", weakTarget = false) {
  return observeStrategyArena({ state, observation: observation(event, now, symbol, weakTarget) });
}

function settleEvent(state: StrategyArenaState, now: number, winner: boolean, symbol = "BTC_USDT") {
  const trades = Object.values(state.open).filter((trade) => trade.symbol === symbol);
  assert.ok(trades.length);
  const price = winner ? Math.max(...trades.map((trade) => trade.targetPrice)) : Math.min(...trades.map((trade) => trade.stopPrice));
  return advanceStrategyArena({ state, quotes: { [symbol]: price }, now });
}

function qualifyProbation(state = initialStrategyArena(1), start = 10_000) {
  for (let index = 0; index < PROBATION_MIN_EVENTS; index += 1) {
    state = openEvent(state, index + 1, start + index * 20_000);
    state = settleEvent(state, start + index * 20_000 + 10_000, true);
  }
  return state;
}

test("catalog keeps 12 playbooks and 48 parallel execution variants", () => {
  assert.equal(STRATEGY_CATALOG.length, 48);
  assert.equal(new Set(STRATEGY_CATALOG.map((item) => item.id.split(":")[0])).size, 12);
});

test("one lucky shadow win cannot promote a strategy", () => {
  let state = openEvent(initialStrategyArena(1), 1, 10_000);
  state = settleEvent(state, 20_000, true);
  assert.equal(state.strategies[strategyId].lane, "SHADOW");
  assert.equal(state.transitions.length, 0);
});

test("four independent profitable events promote one best playbook variant to probation", () => {
  const state = qualifyProbation();
  assert.equal(state.playbookResults.anomaly_follow.length, PROBATION_MIN_EVENTS,
    "four variants from one event must count as one independent event");
  assert.equal(Object.values(state.strategies).filter((score) => score.id.startsWith("anomaly_follow:") && score.lane === "TRIAL").length, 1);
  assert.equal(state.strategies[strategyId].lane, "TRIAL");
  assert.match(state.transitions.at(-1)?.reason ?? "", /4个独立事件/);
});

test("the next qualified signal enters the single account at one-third probation risk", () => {
  let state = qualifyProbation();
  state = openEvent(state, 20, 100_000);
  const isolated = state.open[`${strategyId}:BTC_USDT`];
  const portfolio = state.portfolioOpen.BTC_USDT;
  assert.equal(isolated.lane, "TRIAL");
  assert.equal(portfolio.admissionTier, "PROBATION");
  assert.ok(portfolio.context.netRewardRisk >= 1.2);
  assert.ok(portfolio.context.costShare <= 0.25);
  assert.ok(portfolio.contracts >= 1 && portfolio.margin > 0 && portfolio.leverage >= 1);
  assert.ok(portfolio.plannedRisk <= portfolio.accountEquityAtOpen * 0.01 / 3 + 0.01);
});

test("a promoted strategy stays out when current structure cannot pay for risk and cost", () => {
  let state = qualifyProbation();
  state = openEvent(state, 21, 100_000, "ETH_USDT", true);
  assert.equal(state.portfolioOpen.ETH_USDT, undefined);
  assert.ok((state.admissionRejects.NET_RR ?? 0) > 0);
});

test("a promoted strategy stays out when executable two-sided depth cannot absorb its order", () => {
  let state = qualifyProbation();
  const thin = observation(22, 100_000, "SOL_USDT");
  thin.bidDepthUsd = 100; thin.askDepthUsd = 100;
  state = observeStrategyArena({ state, observation: thin });
  assert.equal(state.portfolioOpen.SOL_USDT, undefined);
  assert.ok((state.admissionRejects.DEPTH ?? 0) > 0);
});

test("two consecutive isolated trial losses demote the strategy", () => {
  let state = qualifyProbation();
  for (let index = 0; index < PAPER_DEMOTION_LOSSES; index += 1) {
    state = openEvent(state, 30 + index, 120_000 + index * 20_000);
    state = settleEvent(state, 130_000 + index * 20_000, false);
  }
  assert.equal(state.strategies[strategyId].lane, "SHADOW");
  assert.equal(state.strategies[strategyId].paperResolved, 2);
});

test("eight profitable isolated trial events with two symbols reach normal tier", () => {
  let state = qualifyProbation();
  for (let index = 0; index < VERIFIED_PAPER_EVENTS; index += 1) {
    const symbol = index % 2 ? "ETH_USDT" : "BTC_USDT";
    state = openEvent(state, 100 + index, 200_000 + index * 20_000, symbol);
    state = settleEvent(state, 210_000 + index * 20_000, true, symbol);
  }
  assert.equal(state.strategies[strategyId].lane, "VERIFIED");
});

test("account reset archives the cycle and preserves strategy research", () => {
  let state = openEvent(qualifyProbation(), 200, 500_000);
  const researchEvents = state.playbookResults.anomaly_follow.length;
  state = resetStrategyArenaAccount({ state,
    quotes: { BTC_USDT: { midpoint: 101.2, bestBid: 101.19, bestAsk: 101.21 } }, now: 510_000 });
  assert.equal(state.portfolioEquity, 1_000);
  assert.equal(state.portfolioResolved, 0);
  assert.deepEqual(state.portfolioOpen, {});
  assert.equal(state.recentPortfolio.length, 0);
  assert.equal(state.archivedPortfolioCycles.length, 1);
  assert.equal(state.playbookResults.anomaly_follow.length, researchEvents);
});

test("records freeze executable spread, structure, excursion and full modeled cost", () => {
  let state = openEvent(initialStrategyArena(1), 1, 10_000);
  const trade = state.open[`${strategyId}:BTC_USDT`];
  assert.equal(trade.entryPrice, 101.01);
  assert.equal(trade.context.structureSource, "ROUTE");
  assert.equal(trade.context.spreadRate, 0.0002);
  state = advanceStrategyArena({ state,
    quotes: { BTC_USDT: { midpoint: 103.01, bestBid: 103, bestAsk: 103.02 } }, now: 20_000 });
  const closed = state.recentShadow.find((item) => item.strategyId === strategyId);
  assert.ok(closed && closed.maxFavorableRate > 0);
  assert.equal(Number((closed.grossReturnRate! - closed.netReturnRate!).toFixed(8)), ARENA_FRICTION_RATE);
});
