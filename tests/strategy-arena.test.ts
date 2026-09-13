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
      allRegimeRoutes: [{ version: 5, strategyId: "bull_pullback", strategyName: "牛接", environment: "TREND",
        side: "LONG", score: 90, triggerPrice: 100, invalidationPrice: 99, profitArmPrice: 102.2,
        maxHoldMinutes: 720, noProgressMinutes: 180, structureId: `bull-pullback:${now}`,
        researchVariant: "squeeze_b:LONG:up:daily_pullback", reason: "强势日线环境内的压缩回撤恢复", hardTarget: true }] },
    midpoint: 100, bestBid: 99.99, bestAsk: 100.01, alignedFlow: 0, minuteNoiseRate: 0.002,
    spreadRate: 0.0002, range15m: null, confirmationBySide: { LONG: 0.8, SHORT: 0.8 },
    fakeoutBySide: { LONG: 0.1, SHORT: 0.1 }, routes: [], bidDepthUsd: 1_000_000, askDepthUsd: 1_000_000,
    quantoMultiplier: 0.001, maintenanceRate: 0.005, leverageMax: 50, now, dataFresh: true,
    contractReady: true, managementCapacity: true, globalOpportunityRank: 1, globalOpportunityCount: 1,
    globalBreadth: 0.8, globalMedianMove: 0.01, globalMarkets: 20,
    marketBreadth4h: 0.4, marketMedianMove4h: -0.005, marketBreadth24h: 0.8,
    marketMedianMove24h: 0.02, btcMove24h: 0.02, regimeMarkets: 20 };
}

const result = (index: number, value: number): StrategyResult => ({ eventId: `event:${index}`, symbol: `S${index}_USDT`,
  regime: "TREND", channel: "TREND", netReturnRate: value, netPnl: value * 1_000, won: value > 0, resolvedAt: index * 1_000 });

test("V12 owns the five cross-market validated mechanisms", () => {
  assert.deepEqual(STRATEGY_CATALOG.map((row) => row.name), ["界返", "渠破", "势回", "熊缩", "牛接"]);
  const state = initialStrategyArena(1);
  assert.equal(state.version, 12);
  assert.ok(Object.values(state.strategies).every((row) => row.enabled));
});

test("a validated bull-pullback opens paired shadows plus one account trade", () => {
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: observation() });
  assert.equal(Object.keys(state.open).length, 2);
  const paper = state.portfolioOpen.BTC_USDT;
  assert.ok(paper); assert.equal(paper.strategyId, "bull_pullback");
  assert.equal(paper.strategyName, "牛接"); assert.equal(paper.side, "LONG");
  assert.ok(Math.abs(paper.plannedRisk - 30) < 0.1);
});

test("a V5 route outside its frozen broad-market cell remains forming", () => {
  const input = observation(); input.marketBreadth24h = 0.6;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  assert.equal(Object.keys(state.portfolioOpen).length, 0);
  assert.equal(Object.keys(state.open).length, 0);
  assert.equal(state.currentRouteChecks["BTC_USDT:bull_pullback"]?.status, "FORMING");
});

test("fewer than twelve synchronized markets cannot authorize a new route", () => {
  const input = observation(); input.regimeMarkets = 8;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  assert.equal(Object.keys(state.open).length, 0); assert.equal(Object.keys(state.portfolioOpen).length, 0);
});

test("three wins retain normal direction while three paired reverse wins can switch direction", () => {
  const normal = initialStrategyArena(1); const normalScore = normal.strategies.bull_pullback;
  normalScore.recentResults = [result(1, 0.01), result(2, 0.008), result(3, 0.012)];
  applyStrategySleepStates(normal, new Set(["TREND"]), 4_000);
  assert.equal(normalScore.enabled, true); assert.equal(normalScore.reverseEnabled, false);

  const reverse = initialStrategyArena(1); const reverseScore = reverse.strategies.bull_pullback;
  reverseScore.recentResults = Array.from({ length: 3 }, (_, index) => result(index + 1, -0.01));
  reverseScore.reverseRecentResults = Array.from({ length: 3 }, (_, index) => result(index + 1, 0.006));
  applyStrategySleepStates(reverse, new Set(["TREND"]), 20_000);
  assert.equal(reverseScore.enabled, false); assert.equal(reverseScore.reverseEnabled, true);
});

test("stale execution data records an explicit blocked candidate", () => {
  const input = observation(); input.dataFresh = false;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  assert.equal(Object.keys(state.open).length, 0);
  assert.ok(state.recentObservations.some((row) => row.blocker.includes("不新鲜")));
  assert.equal(state.currentRouteChecks["BTC_USDT:bull_pullback"]?.status, "BLOCKED");
  assert.equal(state.blockedCandidates[0]?.stage, "EXECUTION");
});

test("fixed three-percent risk scales with account equity without book-depth haircut", () => {
  const input = observation(); input.bidDepthUsd = 500; input.askDepthUsd = 600;
  let state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  assert.ok(Math.abs(state.portfolioOpen.BTC_USDT.plannedRisk - 30) < 0.1);
  assert.ok(state.portfolioOpen.BTC_USDT.notional > 500);

  const half = initialStrategyArena(1); half.portfolioEquity = 500;
  state = observeStrategyArena({ state: half, observation: observation(3_000_000) });
  assert.ok(Math.abs(state.portfolioOpen.BTC_USDT.plannedRisk - 15) < 0.1);
  assert.ok(state.portfolioOpen.BTC_USDT.notional <= 2_000 + 1e-8);
});

test("one Gate contract that breaches the account geometry is rejected", () => {
  const input = observation(); input.bidDepthUsd = 0.05; input.askDepthUsd = 0.08;
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: input });
  assert.equal(state.portfolioOpen.BTC_USDT, undefined);
  assert.equal(Object.keys(state.open).length, 0);
  assert.match(state.currentRouteChecks["BTC_USDT:bull_pullback"]?.blocker ?? "", /一张Gate合约/);
});

test("portfolio governor admits at most one open trade per direction", () => {
  const state = observeStrategyArena({ state: initialStrategyArena(1), observation: observation() });
  const second = observation(3_000_000); second.candidate.symbol = "ETH_USDT";
  second.candidate.id = "ETH_USDT:CANDLE5M:TREND:LONG:3000000";
  second.candidate.allRegimeRoutes![0] = { ...second.candidate.allRegimeRoutes![0], strategyId: "trend_pullback",
    strategyName: "势回", structureId: "trend-pullback:3000000" };
  second.marketBreadth24h = 0.4; second.marketMedianMove24h = -0.005;
  second.marketMedianMove4h = -0.002; second.btcMove24h = -0.01;
  const blocked = observeStrategyArena({ state, observation: second });
  assert.equal(blocked.portfolioOpen.ETH_USDT, undefined);
  assert.equal(blocked.admissionRejects.DIRECTION_CAPACITY, 1);
});

test("route cooldown matches the two/four-hour research signal spacing", () => {
  let state = observeStrategyArena({ state: initialStrategyArena(1), observation: observation() });
  state.portfolioOpen = {}; state.open = {};
  const repeated = observation(3_000_000); repeated.candidate.id = "BTC_USDT:CANDLE5M:TREND:LONG:3000000";
  repeated.candidate.allRegimeRoutes![0] = { ...repeated.candidate.allRegimeRoutes![0], structureId: "bull-pullback:3000000" };
  state = observeStrategyArena({ state, observation: repeated });
  assert.equal(state.portfolioOpen.BTC_USDT, undefined);
  assert.equal(state.blockedCandidates.at(-1)?.code, "ROUTE_COOLDOWN");
});

test("hard target exits immediately and a same-candle stop is resolved first", () => {
  let state = observeStrategyArena({ state: initialStrategyArena(1), observation: observation() });
  const trade = state.portfolioOpen.BTC_USDT;
  state = advanceStrategyArena({ state, quotes: { BTC_USDT: { midpoint: trade.targetPrice + 0.1,
    bestBid: trade.targetPrice + 0.1, bestAsk: trade.targetPrice + 0.11 } }, now: trade.openedAt + 60_000 });
  assert.equal(state.portfolioOpen.BTC_USDT, undefined);
  assert.equal(state.recentPortfolio.at(-1)?.outcome, "TARGET");

  state = observeStrategyArena({ state: initialStrategyArena(1), observation: observation(4_000_000) });
  const shadow = Object.values(state.open)[0];
  state = advanceStrategyShadowsFromCompletedCandle({ state, symbol: "BTC_USDT",
    candle: { high: Math.max(shadow.stopPrice, shadow.targetPrice) + 1, low: Math.min(shadow.stopPrice, shadow.targetPrice) - 1,
      close: shadow.entryPrice, completedAt: shadow.openedAt + 300_000 } });
  assert.ok(state.recentShadow.some((row) => row.outcome === "STOP"));
});

test("legacy reset archives account state and preserves current strategy research", () => {
  const old = initialStrategyArena(1) as unknown as Record<string, unknown>;
  old.version = 9; old.portfolioResolved = 4; old.portfolioEquity = 940;
  const state = normalizeStrategyArena(old as unknown as StrategyArenaState, 10_000);
  assert.equal(state.version, 12); assert.equal(state.portfolioEquity, 1_000);
  assert.equal(state.archivedPortfolioCycles.at(-1)?.resolved, 4);
  state.strategies.bull_pullback.shadowResolved = 7;
  const reset = resetStrategyArenaAccount({ state, quotes: {}, now: 20_000 });
  assert.equal(reset.strategies.bull_pullback.shadowResolved, 7);
});

test("V11 to V12 normalization preserves account, positions and history", () => {
  const seeded = observeStrategyArena({ state: initialStrategyArena(1), observation: observation() });
  const openId = seeded.portfolioOpen.BTC_USDT.id;
  const old = seeded as unknown as Record<string, unknown>;
  old.version = 11; old.portfolioEquity = 991.25; old.portfolioResolved = 2;
  old.recentPortfolio = [{ id: "kept" }];
  const state = normalizeStrategyArena(old as unknown as StrategyArenaState, 10_000);
  assert.equal(state.version, 12); assert.equal(state.portfolioEquity, 991.25); assert.equal(state.portfolioResolved, 2);
  assert.equal(state.portfolioOpen.BTC_USDT.id, openId);
  assert.equal(state.recentPortfolio[0]?.id, "kept");
  assert.ok(Object.values(state.strategies).every((row) => row.enabled));
});
