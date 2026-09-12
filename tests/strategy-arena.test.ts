import assert from "node:assert/strict";
import test from "node:test";
import { advanceStrategyArena, advanceStrategyShadowsFromCompletedCandle, applyStrategySleepStates,
  initialStrategyArena, normalizeStrategyArena, observeStrategyArena, resetStrategyArenaAccount,
  STRATEGY_CATALOG, type ArenaObservation, type StrategyArenaState, type StrategyResult } from "../lib/strategy-arena.ts";

function observation(now = 2_000_000): ArenaObservation {
  return { candidate: { id: `BTC_USDT:CANDLE5M:ANOMALY:SHORT:${now}`, symbol: "BTC_USDT", channel: "ANOMALY",
      regime: "EXPANSION", side: "SHORT", score: 90, referencePrice: 100, moveRate: 0.01, trendRate: 0.01,
      trendEfficiency: 0.7, volatilityRatio: 1.5, rangePosition: 0.9, volume24hUsd: 2_000_000_000,
      fundingRate: 0, openInterestChangeRate: 0, confirmations: 2, firstSeenAt: now, observedAt: now,
      anomalyKind: null, adaptivePolicy: null, extremeSequence: null, dominantEnvironment: "EXHAUSTION",
      allRegimeRoutes: [{ version: 3, strategyId: "exhaustion_turn", strategyName: "竭转", environment: "EXHAUSTION",
        side: "SHORT", score: 90, triggerPrice: 100, invalidationPrice: 102, profitArmPrice: 97,
        maxHoldMinutes: 120, noProgressMinutes: 35, structureId: `turn:${now}`, reason: "推进枯竭" }] },
    midpoint: 100, bestBid: 99.99, bestAsk: 100.01, alignedFlow: 0, minuteNoiseRate: 0.002,
    spreadRate: 0.0002, range15m: null, confirmationBySide: { LONG: 0.8, SHORT: 0.8 },
    fakeoutBySide: { LONG: 0.1, SHORT: 0.1 }, routes: [], bidDepthUsd: 1_000_000, askDepthUsd: 1_000_000,
    quantoMultiplier: 0.001, maintenanceRate: 0.005, leverageMax: 50, now, dataFresh: true,
    contractReady: true, managementCapacity: true, globalOpportunityRank: 1, globalOpportunityCount: 1,
    globalBreadth: 0.8, globalMedianMove: 0.01, globalMarkets: 20 };
}

const result = (index: number, value: number): StrategyResult => ({ eventId: `event:${index}`, symbol: `S${index}_USDT`,
  regime: "TREND", channel: "TREND", netReturnRate: value, netPnl: value * 1_000, won: value > 0, resolvedAt: index * 1_000 });

test("V12 owns six original strategies and starts only validated routes", () => {
  assert.deepEqual(STRATEGY_CATALOG.map((row) => row.name), ["势承", "衡返", "压跃", "竭转", "脉折", "缓续"]);
  const state = initialStrategyArena(1);
  assert.equal(state.version, 12);
  assert.equal(state.strategies.momentum_carry.enabled, true);
  assert.equal(state.strategies.exhaustion_turn.enabled, true);
  assert.equal(state.strategies.balance_return.enabled, false);
  assert.equal(state.strategies.pressure_release.enabled, false);
  assert.equal(state.strategies.pulse_fold.enabled, true);
  assert.equal(state.strategies.slow_carry.enabled, true);
});

test("crowded apparent exhaustion routes through 势承 and opens paired shadows plus one account trade", () => {
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: observation() });
  assert.equal(Object.keys(state.open).length, 2);
  const paper = state.portfolioOpen.BTC_USDT;
  assert.ok(paper); assert.equal(paper.strategyId, "momentum_carry");
  assert.equal(paper.strategyName, "势承"); assert.equal(paper.side, "LONG");
});

test("neutral isolated exhaustion routes through 竭转", () => {
  const input = observation(); input.globalBreadth = 0.5; input.globalMedianMove = 0.0002;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  assert.equal(state.portfolioOpen.BTC_USDT?.strategyId, "exhaustion_turn");
  assert.equal(state.portfolioOpen.BTC_USDT?.side, "SHORT");
});

test("脉折 owns both neutral reversal and crowded continuation decisions", () => {
  const neutral = observation();
  neutral.candidate.allRegimeRoutes = [{ ...neutral.candidate.allRegimeRoutes![0], strategyId: "pulse_fold",
    strategyName: "脉折", structureId: "pulse:neutral" }];
  neutral.globalBreadth = 0.5; neutral.globalMedianMove = 0.0002;
  let state = observeStrategyArena({ state: initialStrategyArena(1), observation: neutral });
  assert.equal(state.portfolioOpen.BTC_USDT?.strategyId, "pulse_fold");
  assert.equal(state.portfolioOpen.BTC_USDT?.side, "SHORT");

  const crowded = observation(3_000_000);
  crowded.candidate.allRegimeRoutes = [{ ...crowded.candidate.allRegimeRoutes![0], strategyId: "pulse_fold",
    strategyName: "脉折", structureId: "pulse:crowded", continuationInvalidationPrice: 98,
    continuationProfitArmPrice: 103.6, continuationMaxHoldMinutes: 200, continuationNoProgressMinutes: 50 }];
  state = observeStrategyArena({ state: initialStrategyArena(1), observation: crowded });
  assert.equal(state.portfolioOpen.BTC_USDT?.strategyId, "pulse_fold");
  assert.equal(state.portfolioOpen.BTC_USDT?.side, "LONG");
  assert.equal(state.portfolioOpen.BTC_USDT?.stopPrice, 98);
  assert.equal(state.portfolioOpen.BTC_USDT?.context.maxHoldMs, 200 * 60_000);
});

test("缓续 executes only when broad-market crowding confirms the original direction", () => {
  const neutral = observation();
  neutral.candidate.allRegimeRoutes = [{ ...neutral.candidate.allRegimeRoutes![0], strategyId: "slow_carry",
    strategyName: "缓续", structureId: "slow:neutral", continuationInvalidationPrice: 98,
    continuationProfitArmPrice: 103.6, continuationMaxHoldMinutes: 210, continuationNoProgressMinutes: 50 }];
  neutral.globalBreadth = 0.5; neutral.globalMedianMove = 0.0002;
  let state = observeStrategyArena({ state: initialStrategyArena(1), observation: neutral });
  assert.equal(state.portfolioOpen.BTC_USDT, undefined);

  const crowded = observation(3_000_000);
  crowded.candidate.allRegimeRoutes = [{ ...crowded.candidate.allRegimeRoutes![0], strategyId: "slow_carry",
    strategyName: "缓续", structureId: "slow:crowded", continuationInvalidationPrice: 98,
    continuationProfitArmPrice: 103.6, continuationMaxHoldMinutes: 210, continuationNoProgressMinutes: 50 }];
  state = observeStrategyArena({ state: initialStrategyArena(1), observation: crowded });
  assert.equal(state.portfolioOpen.BTC_USDT?.strategyId, "slow_carry");
  assert.equal(state.portfolioOpen.BTC_USDT?.side, "LONG");
});

test("range double reclaim stays paired-shadow until current polarity evidence activates it", () => {
  const input = observation();
  input.candidate.channel = "RANGE"; input.candidate.regime = "RANGE";
  input.candidate.allRegimeRoutes = [{ version: 3, strategyId: "balance_return", strategyName: "衡返", environment: "RANGE",
    side: "LONG", score: 86, triggerPrice: 100, invalidationPrice: 98, profitArmPrice: 103.6,
    maxHoldMinutes: 150, noProgressMinutes: 40, structureId: `double-reclaim:${input.now}`, reason: "同一外沿双拒绝并收回" }];
  input.globalBreadth = 0.5; input.globalMedianMove = 0.0002;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  assert.equal(Object.keys(state.open).length, 2);
  assert.equal(state.portfolioOpen.BTC_USDT, undefined);
  assert.equal(state.currentRouteChecks["BTC_USDT:balance_return"]?.status, "BLOCKED");
  state.strategies.balance_return.recentResults = [result(1, 0.01), result(2, 0.008), result(3, 0.012)]
    .map((row) => ({ ...row, regime: "RANGE" as const, channel: "RANGE" as const }));
  applyStrategySleepStates(state, new Set(["RANGE"]), 4_000);
  assert.equal(state.strategies.balance_return.enabled, true);
});

test("fewer than twelve synchronized markets cannot authorize a new route", () => {
  const input = observation(); input.globalMarkets = 8;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  assert.equal(Object.keys(state.open).length, 0); assert.equal(Object.keys(state.portfolioOpen).length, 0);
});

test("three wins select normal while mixed results retain the last orientation", () => {
  const state = initialStrategyArena(1); const score = state.strategies.momentum_carry;
  score.recentResults = [result(1, 0.01), result(2, 0.008), result(3, 0.012)];
  applyStrategySleepStates(state, new Set(["TREND"]), 4_000);
  assert.equal(score.enabled, true); assert.equal(score.reverseEnabled, false);
  score.recentResults.push(result(4, -0.003));
  applyStrategySleepStates(state, new Set(["TREND"]), 5_000);
  assert.equal(score.enabled, true); assert.equal(score.reverseEnabled, false);
});

test("three losses switch when the same three fully costed reverse shadows all win", () => {
  const state = initialStrategyArena(1); const score = state.strategies.momentum_carry;
  score.recentResults = Array.from({ length: 3 }, (_, index) => result(index + 1, -0.01));
  score.reverseRecentResults = Array.from({ length: 3 }, (_, index) => result(index + 1, 0.006));
  applyStrategySleepStates(state, new Set(["TREND"]), 20_000);
  assert.equal(score.enabled, false); assert.equal(score.reverseEnabled, true);
});

test("stale execution data remains observation-only", () => {
  const input = observation(); input.dataFresh = false;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  assert.equal(Object.keys(state.open).length, 0);
  assert.ok(state.recentObservations.some((row) => row.blocker.includes("不新鲜")));
  assert.equal(state.currentRouteChecks["BTC_USDT:momentum_carry"]?.status, "BLOCKED");
  assert.match(state.currentRouteChecks["BTC_USDT:momentum_carry"]?.blocker ?? "", /不新鲜/);
});

test("valid routes shrink to current book capacity instead of requiring a fixed 10,000 U floor", () => {
  const input = observation(); input.bidDepthUsd = 500; input.askDepthUsd = 600;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  const paper = state.portfolioOpen.BTC_USDT;
  assert.ok(paper, "a valid route should trade when the book can hold at least one Gate contract");
  assert.ok(paper.notional <= 500 * 0.2 + 1e-8);
  assert.equal(paper.contracts, Math.floor(paper.notional / (paper.entryPrice * paper.quantoMultiplier)));
  const shadow = Object.values(state.open)[0];
  assert.ok(shadow.notional <= 500 * 0.2 + 1e-8, "shadow and PAPER use the same market-capacity rule");
});

test("account equity changes order size but does not impose a minimum-dollar entry gate", () => {
  const state = initialStrategyArena(1); state.portfolioEquity = 500;
  const observed = observeStrategyArena({ state, observation: observation() });
  const paper = observed.portfolioOpen.BTC_USDT;
  assert.ok(paper, "the same valid market route should remain eligible at lower equity");
  assert.ok(paper.notional <= 250 + 1e-8);
  assert.ok(paper.plannedRisk < 10, "10 U is a sizing target, not an order-eligibility minimum");
});

test("depth rejects a route only when one Gate contract cannot fit", () => {
  const input = observation(); input.bidDepthUsd = 0.4; input.askDepthUsd = 0.5;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  assert.equal(state.portfolioOpen.BTC_USDT, undefined);
  assert.equal(Object.keys(state.open).length, 0);
  assert.match(state.currentRouteChecks["BTC_USDT:momentum_carry"]?.blocker ?? "", /一张Gate合约/);
});

test("a fourth account trade is admitted when risk, margin and data capacity still fit", () => {
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: observation(2_000_000) });
  const template = state.portfolioOpen.BTC_USDT;
  delete state.portfolioOpen.BTC_USDT;
  for (const symbol of ["AAA_USDT", "BBB_USDT", "CCC_USDT"]) {
    state.portfolioOpen[symbol] = { ...template, id: `PORTFOLIO:${symbol}`, symbol,
      plannedRisk: 1, notional: 10, margin: 1 };
  }
  const input = observation(3_000_000);
  input.candidate.id = "UNI_USDT:CANDLE5M:ANOMALY:SHORT:3000000";
  input.candidate.symbol = "UNI_USDT";
  input.candidate.allRegimeRoutes![0] = { ...input.candidate.allRegimeRoutes![0], structureId: "turn:3000000" };
  input.globalOpportunityRank = 7;
  const admitted = observeStrategyArena({ state, observation: input });
  assert.ok(admitted.portfolioOpen.UNI_USDT, "position count and global rank must not override available account capacity");
});

test("profit arm starts a runner and a later protection closes it", () => {
  let state = observeStrategyArena({ state: initialStrategyArena(1), observation: observation() });
  const trade = state.portfolioOpen.BTC_USDT;
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: { midpoint: trade.targetPrice + 0.1,
    bestBid: trade.targetPrice + 0.1, bestAsk: trade.targetPrice + 0.11 } }, now: trade.openedAt + 60_000 });
  assert.ok(state.portfolioOpen.BTC_USDT.profitArmedAt);
  const protection = state.portfolioOpen.BTC_USDT.activeStopPrice!;
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: { midpoint: protection - 0.1,
    bestBid: protection - 0.1, bestAsk: protection - 0.09 } }, now: trade.openedAt + 120_000 });
  assert.equal(state.portfolioOpen.BTC_USDT, undefined);
  assert.equal(state.recentPortfolio.at(-1)?.outcome, "RUNNER_EXIT");
});

test("completed candle resolves an initial stop before a same-candle profit arm", () => {
  let state = observeStrategyArena({ state: initialStrategyArena(1), observation: observation() });
  const shadow = Object.values(state.open)[0];
  state = advanceStrategyShadowsFromCompletedCandle({ state, symbol: "BTC_USDT",
    candle: { high: Math.max(shadow.stopPrice, shadow.targetPrice) + 1, low: Math.min(shadow.stopPrice, shadow.targetPrice) - 1,
      close: shadow.entryPrice, completedAt: shadow.openedAt + 300_000 } });
  assert.ok(state.recentShadow.some((row) => row.outcome === "STOP"));
});

test("a pre-V11 account is archived and reset preserves shadow research", () => {
  const old = initialStrategyArena(1) as unknown as Record<string, unknown>;
  old.version = 9; old.portfolioResolved = 4; old.portfolioEquity = 940;
  const state = normalizeStrategyArena(old as unknown as StrategyArenaState, 10_000);
  assert.equal(state.version, 12); assert.equal(state.portfolioEquity, 1_000);
  assert.equal(state.archivedPortfolioCycles.at(-1)?.resolved, 4);
  state.strategies.momentum_carry.shadowResolved = 7;
  const reset = resetStrategyArenaAccount({ state, quotes: {}, now: 20_000 });
  assert.equal(reset.strategies.momentum_carry.shadowResolved, 7);
});

test("V11 to V12 migration preserves account, positions, and history while adding both routes", () => {
  const seeded = observeStrategyArena({ state: initialStrategyArena(1), observation: observation() });
  const openId = seeded.portfolioOpen.BTC_USDT.id;
  const old = seeded as unknown as Record<string, unknown>;
  old.version = 11; old.portfolioEquity = 991.25; old.portfolioResolved = 2;
  old.recentPortfolio = [{ id: "kept" }];
  const state = normalizeStrategyArena(old as unknown as StrategyArenaState, 10_000);
  assert.equal(state.version, 12); assert.equal(state.portfolioEquity, 991.25); assert.equal(state.portfolioResolved, 2);
  assert.equal(state.portfolioOpen.BTC_USDT.id, openId);
  assert.equal(state.recentPortfolio[0]?.id, "kept");
  assert.equal(state.strategies.pulse_fold.enabled, true); assert.equal(state.strategies.slow_carry.enabled, true);
});
