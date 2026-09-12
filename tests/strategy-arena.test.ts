import assert from "node:assert/strict";
import test from "node:test";
import { advanceStrategyArena, advanceStrategyShadowsFromCompletedCandle, applyStrategySleepStates,
  initialStrategyArena, normalizeStrategyArena, observeStrategyArena, resetStrategyArenaAccount,
  STRATEGY_CATALOG, type ArenaObservation, type StrategyArenaState, type StrategyResult } from "../lib/strategy-arena.ts";

function observation(now = 2_000_000): ArenaObservation {
  return { candidate: { id: `BTC_USDT:CANDLE5M:TREND:LONG:${now}`, symbol: "BTC_USDT", channel: "TREND",
      regime: "EXPANSION", side: "LONG", score: 90, referencePrice: 100, moveRate: 0.01, trendRate: 0.01,
      trendEfficiency: 0.7, volatilityRatio: 1.5, rangePosition: 0.9, volume24hUsd: 2_000_000_000,
      fundingRate: 0, openInterestChangeRate: 0, confirmations: 2, firstSeenAt: now, observedAt: now,
      anomalyKind: null, adaptivePolicy: null, extremeSequence: null, dominantEnvironment: "TREND",
      allRegimeRoutes: [{ version: 4, strategyId: "tide_relay", strategyName: "潮接", environment: "TREND",
        side: "LONG", score: 90, triggerPrice: 100, invalidationPrice: 99, profitArmPrice: 103,
        maxHoldMinutes: 120, noProgressMinutes: 30, structureId: `relay:${now}`, sourceDirection: 1,
        researchVariant: "tide_relay:2", reason: "主潮扰动后重新接回" }] },
    midpoint: 100, bestBid: 99.99, bestAsk: 100.01, alignedFlow: 0, minuteNoiseRate: 0.002,
    spreadRate: 0.0002, range15m: null, confirmationBySide: { LONG: 0.8, SHORT: 0.8 },
    fakeoutBySide: { LONG: 0.1, SHORT: 0.1 }, routes: [], bidDepthUsd: 1_000_000, askDepthUsd: 1_000_000,
    quantoMultiplier: 0.001, maintenanceRate: 0.005, leverageMax: 50, now, dataFresh: true,
    contractReady: true, managementCapacity: true, globalOpportunityRank: 1, globalOpportunityCount: 1,
    globalBreadth: 0.8, globalMedianMove: 0.01, globalMarkets: 20 };
}

const result = (index: number, value: number): StrategyResult => ({ eventId: `event:${index}`, symbol: `S${index}_USDT`,
  regime: "TREND", channel: "TREND", netReturnRate: value, netPnl: value * 1_000, won: value > 0, resolvedAt: index * 1_000 });

test("V12 owns six state-conditioned mechanisms and starts only stable validated routes", () => {
  assert.deepEqual(STRATEGY_CATALOG.map((row) => row.name), ["势承", "潮补", "静移", "冲衡", "脉折", "潮接"]);
  const state = initialStrategyArena(1);
  assert.equal(state.version, 12);
  assert.equal(state.strategies.momentum_carry.enabled, false);
  assert.equal(state.strategies.tide_catchup.enabled, true);
  assert.equal(state.strategies.quiet_drift.enabled, true);
  assert.equal(state.strategies.impulse_recoil.enabled, true);
  assert.equal(state.strategies.impulse_fold.enabled, false);
  assert.equal(state.strategies.tide_relay.enabled, true);
});

test("validated broad expansion routes through 潮接 and opens paired shadows plus one account trade", () => {
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: observation() });
  assert.equal(Object.keys(state.open).length, 2);
  const paper = state.portfolioOpen.BTC_USDT;
  assert.ok(paper); assert.equal(paper.strategyId, "tide_relay");
  assert.equal(paper.strategyName, "潮接"); assert.equal(paper.side, "LONG");
});

test("transition state is explicit capital-preservation WAIT", () => {
  const input = observation(); input.globalBreadth = 0.5; input.globalMedianMove = 0.0002;
  input.candidate.trendRate = 0.001; input.candidate.trendEfficiency = 0.35;
  input.candidate.volatilityRatio = 1; input.candidate.rangePosition = 0.5;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  assert.equal(state.portfolioOpen.BTC_USDT, undefined);
  assert.equal(Object.keys(state.open).length, 0);
});

test("脉折 remains paired shadow-only after its discovery window drifted negative", () => {
  const blocked = observation();
  blocked.candidate.allRegimeRoutes = [{ ...blocked.candidate.allRegimeRoutes![0], strategyId: "impulse_fold",
    strategyName: "脉折", environment: "EXHAUSTION", side: "SHORT", invalidationPrice: 101,
    profitArmPrice: 97, structureId: "fold:blocked", sourceDirection: 1 }];
  assert.equal(observeStrategyArena({ state: initialStrategyArena(1), observation: blocked }).portfolioOpen.BTC_USDT, undefined);

  const accepted = observation(3_000_000);
  accepted.candidate.trendRate = 0.001; accepted.candidate.trendEfficiency = 0.2;
  accepted.candidate.volatilityRatio = 1; accepted.candidate.rangePosition = 0.9;
  accepted.globalBreadth = 0.5; accepted.globalMedianMove = 0;
  accepted.candidate.allRegimeRoutes = [{ ...blocked.candidate.allRegimeRoutes![0], structureId: "fold:accepted" }];
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: accepted });
  assert.equal(state.portfolioOpen.BTC_USDT, undefined);
  assert.equal(Object.keys(state.open).length, 2);
  assert.ok(Object.values(state.open).every((trade) => trade.strategyId === "impulse_fold"));
});

test("潮补 executes only when a broad-market tide leaves sufficient relative lag", () => {
  const neutral = observation();
  neutral.candidate.volatilityRatio = 0.7; neutral.candidate.rangePosition = 0.2;
  neutral.candidate.allRegimeRoutes = [{ ...neutral.candidate.allRegimeRoutes![0], strategyId: "tide_catchup",
    strategyName: "潮补", structureId: "catchup:neutral", localMoveRate: -0.001 }];
  neutral.globalBreadth = 0.5; neutral.globalMedianMove = 0.0002;
  let state = observeStrategyArena({ state: initialStrategyArena(1), observation: neutral });
  assert.equal(state.portfolioOpen.BTC_USDT, undefined);

  const crowded = observation(3_000_000);
  crowded.candidate.volatilityRatio = 0.7; crowded.candidate.rangePosition = 0.2;
  crowded.candidate.allRegimeRoutes = [{ ...neutral.candidate.allRegimeRoutes![0], structureId: "catchup:crowded" }];
  state = observeStrategyArena({ state: initialStrategyArena(1), observation: crowded });
  assert.equal(state.portfolioOpen.BTC_USDT?.strategyId, "tide_catchup");
  assert.equal(state.portfolioOpen.BTC_USDT?.side, "LONG");
});

test("historically validated 冲衡 enters PAPER only in its accepted broad expansion cell", () => {
  const input = observation();
  input.candidate.channel = "ANOMALY"; input.candidate.regime = "RANGE";
  input.candidate.trendRate = 0.001; input.candidate.trendEfficiency = 0.2;
  input.candidate.volatilityRatio = 1.5; input.candidate.rangePosition = 0.9;
  input.candidate.allRegimeRoutes = [{ version: 4, strategyId: "impulse_recoil", strategyName: "冲衡", environment: "EXHAUSTION",
    side: "SHORT", score: 86, triggerPrice: 100, invalidationPrice: 101, profitArmPrice: 98,
    maxHoldMinutes: 100, noProgressMinutes: 25, structureId: `recoil:${input.now}`, sourceDirection: 1,
    researchVariant: "impulse_recoil:0", reason: "孤立脉冲回收" }];
  input.globalBreadth = 0.8; input.globalMedianMove = 0.01;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  assert.equal(Object.keys(state.open).length, 2);
  assert.equal(state.portfolioOpen.BTC_USDT?.strategyId, "impulse_recoil");
  assert.equal(state.portfolioOpen.BTC_USDT?.side, "SHORT");
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
  assert.equal(state.currentRouteChecks["BTC_USDT:tide_relay"]?.status, "BLOCKED");
  assert.match(state.currentRouteChecks["BTC_USDT:tide_relay"]?.blocker ?? "", /不新鲜/);
  assert.equal(state.blockedCandidates.length, 1, "only an authorized formed route enters the blocked-candidate audit");
  assert.equal(state.blockedCandidates[0].stage, "EXECUTION");
  assert.equal(state.blockedCandidates[0].side, "LONG");
});

test("valid small-account routes are not haircut by transient five-level book depth", () => {
  const input = observation(); input.bidDepthUsd = 500; input.askDepthUsd = 600;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  const paper = state.portfolioOpen.BTC_USDT;
  assert.ok(paper, "a valid route should trade when the book can hold at least one Gate contract");
  assert.ok(paper.notional > 500, "the old 20% book haircut and 0.5x-equity ceiling must not compress a valid derivatives order");
  assert.equal(paper.contracts, Math.floor(paper.notional / (paper.entryPrice * paper.quantoMultiplier)));
  const shadow = Object.values(state.open)[0];
  assert.ok(shadow.notional > 500, "shadow and PAPER use the same non-haircut execution rule");
});

test("account equity scales the meaningful-notional floor proportionally", () => {
  const state = initialStrategyArena(1); state.portfolioEquity = 500;
  const observed = observeStrategyArena({ state, observation: observation() });
  const paper = observed.portfolioOpen.BTC_USDT;
  assert.ok(paper, "the same valid market route should remain eligible at lower equity");
  assert.ok(paper.notional >= 500, "a new account order must retain at least 1x current-equity notional");
  assert.ok(paper.notional <= 500 * 4 + 1e-8);
  assert.ok(paper.plannedRisk < 10, "10 U is a sizing target, not an order-eligibility minimum");
});

test("the observed 龙虾 24.41% stop is rejected instead of opening a 69 U PAPER position", () => {
  const input = observation();
  input.candidate = { ...input.candidate,
    id: "龙虾_USDT:CANDLE5M:ANOMALY:SHORT:1789188300000:-957:-781", symbol: "龙虾_USDT",
    referencePrice: 0.115, trendRate: 0.001, trendEfficiency: 0.2, volatilityRatio: 1.5, rangePosition: 0.9,
    allRegimeRoutes: [{ version: 4, strategyId: "impulse_recoil", strategyName: "冲衡",
      environment: "EXHAUSTION", side: "SHORT", score: 90, triggerPrice: 0.115,
      invalidationPrice: 0.14307075, profitArmPrice: 0.07229305, maxHoldMinutes: 140,
      noProgressMinutes: 35, structureId: "impulse_recoil:SHORT:-957:1789188300000", sourceDirection: 1,
      researchVariant: "impulse_recoil:0", reason: "孤立脉冲被反向收复" }] };
  input.midpoint = 0.115; input.bestBid = 0.115; input.bestAsk = 0.115001;
  input.spreadRate = (input.bestAsk - input.bestBid) / input.midpoint;
  input.quantoMultiplier = 100; input.maintenanceRate = 0.08; input.leverageMax = 10;
  input.globalBreadth = 0.8; input.globalMedianMove = 0.01;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  assert.equal(state.portfolioOpen.龙虾_USDT, undefined);
  assert.equal(state.admissionRejects.MEANINGFUL_SIZE, 1);
  assert.match(state.currentRouteChecks["龙虾_USDT:impulse_recoil"]?.blocker ?? "", /名义价值低于账户权益1倍/);
  assert.equal(state.blockedCandidates.at(-1)?.code, "MEANINGFUL_SIZE");
  assert.equal(state.blockedCandidates.at(-1)?.stage, "ACCOUNT");
});

test("depth rejects a route only when one Gate contract cannot fit", () => {
  const input = observation(); input.bidDepthUsd = 0.05; input.askDepthUsd = 0.08;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  assert.equal(state.portfolioOpen.BTC_USDT, undefined);
  assert.equal(Object.keys(state.open).length, 0);
  assert.match(state.currentRouteChecks["BTC_USDT:tide_relay"]?.blocker ?? "", /一张Gate合约/);
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

test("V11 to V12 migration preserves account, positions, and history while applying frozen authority", () => {
  const seeded = observeStrategyArena({ state: initialStrategyArena(1), observation: observation() });
  const openId = seeded.portfolioOpen.BTC_USDT.id;
  const old = seeded as unknown as Record<string, unknown>;
  old.version = 11; old.portfolioEquity = 991.25; old.portfolioResolved = 2;
  old.recentPortfolio = [{ id: "kept" }];
  const state = normalizeStrategyArena(old as unknown as StrategyArenaState, 10_000);
  assert.equal(state.version, 12); assert.equal(state.portfolioEquity, 991.25); assert.equal(state.portfolioResolved, 2);
  assert.equal(state.portfolioOpen.BTC_USDT.id, openId);
  assert.equal(state.recentPortfolio[0]?.id, "kept");
  assert.equal(state.strategies.impulse_fold.enabled, false); assert.equal(state.strategies.tide_relay.enabled, true);
  assert.equal(state.strategies.impulse_recoil.enabled, true);
});
