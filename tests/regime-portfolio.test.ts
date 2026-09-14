import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPaperOpen, canonicalPaperSummary, initialCanonicalPaperState, reconcileCanonicalPaper } from "../lib/dual-paper.ts";
import { initialStrategyArena, type ArenaTrade } from "../lib/strategy-arena.ts";
import { initialStrategyArena as initialPreviousStrategyArena } from "../lib/previous-strategy-arena.ts";
import { classifyRegime, evaluateRegimePortfolio, initialRegimePortfolio, REGIME_EXECUTION_UNIVERSE,
  REGIME_SATELLITE_ACCOUNT_RISK_CAP, REGIME_SATELLITE_DIRECTION_RISK_CAP, REGIME_SATELLITE_TRADE_RISK_RATE,
  REGIME_SATELLITE_UNIVERSE, REGIME_STRATEGIES, REGIME_UNIVERSE,
  normalizeRegimePortfolio, REGIME_SYSTEMS, type RegimeContractMeta } from "../lib/regime-portfolio.ts";

test("five exhaustive regimes use the frozen direct strategy catalog without shadow authorization", () => {
  assert.deepEqual(REGIME_SYSTEMS, ["SHOCK_TRANSITION", "COMPRESSION", "DIRECTIONAL_TREND",
    "NON_TREND_EXPANSION", "BALANCED_ROTATION"]);
  assert.deepEqual(REGIME_STRATEGIES.map((row) => row.id), [
    "shock_transition-aligned_downshock_reversal-14", "shock_transition-counter_downshock_survivor-15",
    "compression-false_release-4", "compression-quiet_pullback_resume-21",
    "directional_trend-bear-market_rebound-12", "directional_trend-bull-relative_momentum-7",
    "directional_trend-bear-breakdown_trail-2", "directional_trend-bear-defensive_relative-2",
    "non_trend_expansion-refined_breadth_continuation-10", "non_trend_expansion-expansion_defender-14",
    "balanced_rotation-relative_pullback_resume-4", "balanced_rotation-short_horizon_reversal-8",
  ]);
  const state = initialRegimePortfolio(1);
  assert.ok(REGIME_SYSTEMS.every((id) => state.accounts[id].equity === 1_000));
  assert.ok(REGIME_SYSTEMS.every((id) => Object.keys(state.accounts[id].open).length === 0));
});

test("market classification is mutually exclusive and always returns one owning system", () => {
  const common = { median7: 0, median30: 0, breadth7: .5, breadth30: .5, markets: 11 };
  assert.equal(classifyRegime({ ...common, median24: -.05, breadth24: .1, compression: 1 }), "SHOCK_TRANSITION");
  assert.equal(classifyRegime({ ...common, median24: .005, breadth24: .5, compression: .5 }), "COMPRESSION");
  assert.equal(classifyRegime({ ...common, median24: .005, median7: .02, median30: .1,
    breadth24: .5, breadth30: .7, compression: 1 }), "DIRECTIONAL_TREND");
  assert.equal(classifyRegime({ ...common, median24: .02, breadth24: .7, compression: 1 }), "NON_TREND_EXPANSION");
  assert.equal(classifyRegime({ ...common, median24: .005, breadth24: .5, compression: 1 }), "BALANCED_ROTATION");
});

test("the route-audit migration reevaluates once without resetting any system account", () => {
  const legacy = initialRegimePortfolio(1);
  legacy.accounts.COMPRESSION.equity = 1_234;
  legacy.lastEvaluatedHour = 99;
  delete legacy.auditVersion;
  const migrated = normalizeRegimePortfolio(legacy, 2);
  assert.equal(migrated.accounts.COMPRESSION.equity, 1_234);
  assert.equal(migrated.lastEvaluatedHour, null);
  assert.equal(migrated.auditVersion, 1);
});

function shockPath() {
  return Array.from({ length: 721 }, (_, index) => {
    const close = index <= 696 ? 100 : index <= 714 ? 100 - (index - 696) * (10 / 18) : 90 + (index - 714) * (1.2 / 6);
    return { time: index * 3_600, open: close, high: close * 1.001, low: close * .999, close, volume: 100 };
  });
}

test("720-hour synchronized evidence directly opens risk-capped orders and never needs a 3/6 gate", () => {
  const symbols = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT", "BNB_USDT", "DOGE_USDT", "ADA_USDT", "LINK_USDT"];
  const hourly = Object.fromEntries(symbols.map((symbol) => [symbol, shockPath()]));
  const now = 721 * 3_600_000;
  const quotes = Object.fromEntries(symbols.map((symbol) => [symbol,
    { midpoint: 91.2, bestBid: 91.19, bestAsk: 91.21, observedAt: now, fresh: true, completedMinuteAt: now }]));
  const meta: RegimeContractMeta = { quantoMultiplier: .001, maintenanceRate: .005, leverageMax: 50,
    fundingRate: 0, volume24hUsd: 1_000_000_000 };
  const contracts = Object.fromEntries(symbols.map((symbol) => [symbol, meta]));
  const state = evaluateRegimePortfolio({ state: initialRegimePortfolio(1), hourly, quotes, contracts, now });
  assert.equal(state.currentContext?.regime, "SHOCK_TRANSITION");
  assert.equal(state.warmMarkets, 8);
  assert.equal(Object.keys(state.accounts.SHOCK_TRANSITION.open).length, 4,
    "the independent 6.5% same-side cap admits four 1.5%-risk trades");
  assert.equal(state.routeChecks.filter((row) => row.status === "OPEN").length, 4);
  assert.ok(state.routeChecks.some((row) => row.status === "BLOCKED" && row.blocker === "RISK_CAP"));
  const accounts = { current: initialStrategyArena(1), previous: initialPreviousStrategyArena(1), regime: state };
  const summary = canonicalPaperSummary(accounts, initialCanonicalPaperState(1));
  assert.ok(summary.blockedCandidates.length > 0, "formed regime signals must reach the candidate audit");
  assert.equal(summary.blockedCandidates[0].stage, "ACCOUNT");
  assert.ok(summary.blockedCandidates[0].entryPrice! > 0);
  assert.equal(state.lastEvaluatedHour, 720 * 3_600_000);
});

function balancedPath(direction: 1 | -1) {
  return Array.from({ length: 721 }, (_, index) => ({
    time: index * 3_600,
    ...(() => { const close = 100 * (1 + direction * .001 * index / 720);
      return { open: close, high: close * 1.001, low: close * .999, close, volume: 100 }; })(),
  }));
}

test("an evaluated hour exposes the nearest frozen conditions without granting order authority", () => {
  const symbols = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT", "BNB_USDT", "DOGE_USDT", "ADA_USDT", "LINK_USDT"];
  const hourly = Object.fromEntries(symbols.map((symbol, index) => [symbol, balancedPath(index < 4 ? -1 : 1)]));
  const state = evaluateRegimePortfolio({ state: initialRegimePortfolio(1), hourly, quotes: {}, contracts: {},
    now: 721 * 3_600_000 });
  assert.equal(state.currentContext?.regime, "BALANCED_ROTATION");
  assert.equal(Object.keys(state.accounts.BALANCED_ROTATION.open).length, 0);
  assert.equal(state.routeChecks.length, 10);
  assert.ok(state.routeChecks.every((row) => row.status === "FORMING"));
  assert.ok(state.routeChecks.every((row) => row.score >= 0 && row.score < 100));
  assert.match(state.routeChecks[0].reason, /满足 \d+\/\d+ 项冻结条件；待满足/);
  assert.ok(state.routeChecks.every((row) => row.entryPrice == null && row.stopPrice == null && row.targetPrice == null));
  assert.equal(state.lastEvaluatedHour, 720 * 3_600_000);
});

function sampleTrade(id: string): ArenaTrade {
  return { id, strategyId: id, strategyName: id, family: "TREND", lane: "PORTFOLIO", eventId: id,
    symbol: "BTC_USDT", side: "LONG", status: "OPEN", openedAt: 1, closedAt: null, entryPrice: 100,
    stopPrice: 95, targetPrice: 110, exitPrice: null, outcome: null, grossReturnRate: null, netReturnRate: null,
    netPnl: null, notional: 200, maxFavorableRate: 0, maxAdverseRate: 0, lastPrice: 100,
    selectedForPortfolio: true, reason: "test", admissionTier: "NORMAL", plannedRisk: 10, contracts: 2_000,
    quantoMultiplier: .001, leverage: 2, margin: 100, accountEquityAtOpen: 1_000,
    context: { channel: "TREND", regime: "TREND", anomalyKind: null, entryStyle: "CONFIRM", exitProfile: "FAST",
      candidateScore: 1, trendRate: 0, trendEfficiency: 0, volatilityRatio: 1, rangePosition: 0,
      openInterestChangeRate: 0, volume24hUsd: 1e9, fundingRate: 0, alignedFlow: 0, confirmation: 1,
      fakeoutRisk: 0, rangeId: null, modeledCostRate: .0014, spreadRate: 0, bidDepthUsd: 0, askDepthUsd: 0,
      structureSource: "CANDLE_5M", grossRewardRate: .1, structuralStopRate: .05, netRewardRisk: 1.9,
      costShare: .014, empiricalExpectedReturnRate: 0, empiricalProfitFactor: 0, empiricalEvents: 0 } };
}

test("canonical PAPER retains the same symbol in multiple regime accounts at the same equity fraction", () => {
  const regime = initialRegimePortfolio(1);
  regime.accounts.SHOCK_TRANSITION.open.BTC_USDT = sampleTrade("one");
  regime.accounts.BALANCED_ROTATION.open.BTC_USDT = sampleTrade("two");
  const accounts = { current: initialStrategyArena(1), previous: initialPreviousStrategyArena(1), regime };
  const canonical = reconcileCanonicalPaper({ state: initialCanonicalPaperState(1), accounts, now: 2 }).state;
  const logical = canonicalPaperOpen(accounts, canonical);
  assert.equal(logical.length, 2);
  assert.deepEqual(logical.map((row) => row.engineId).sort(), ["BALANCED_ROTATION", "SHOCK_TRANSITION"]);
  assert.equal(logical.reduce((total, row) => total + row.contracts, 0), 40_000);
});


test("V1.1 keeps the frozen 11-market context and adds only SUI/UNI as satellite execution symbols", () => {
  assert.equal(REGIME_UNIVERSE.length, 11);
  assert.deepEqual(REGIME_SATELLITE_UNIVERSE, ["SUI_USDT", "UNI_USDT"]);
  assert.equal(REGIME_EXECUTION_UNIVERSE.length, 13);
  assert.equal(REGIME_SATELLITE_TRADE_RISK_RATE, .005);
  assert.equal(REGIME_SATELLITE_ACCOUNT_RISK_CAP, .02);
  assert.equal(REGIME_SATELLITE_DIRECTION_RISK_CAP, .015);

  const core = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT", "BNB_USDT", "DOGE_USDT", "ADA_USDT", "LINK_USDT"];
  const hourly = Object.fromEntries([
    ...core.map((symbol) => [symbol, shockPath()] as const),
    ["SUI_USDT", balancedPath(1)], ["UNI_USDT", balancedPath(1)],
  ]);
  const now = 721 * 3_600_000;
  const quotes = Object.fromEntries(Object.keys(hourly).map((symbol) => [symbol,
    { midpoint: 91.2, bestBid: 91.19, bestAsk: 91.21, observedAt: now, fresh: true, completedMinuteAt: now }]));
  const meta: RegimeContractMeta = { quantoMultiplier: .001, maintenanceRate: .005, leverageMax: 50,
    fundingRate: 0, volume24hUsd: 1_000_000_000 };
  const contracts = Object.fromEntries(Object.keys(hourly).map((symbol) => [symbol, meta]));
  const state = evaluateRegimePortfolio({ state: initialRegimePortfolio(1), hourly, quotes, contracts, now });
  assert.equal(state.currentContext?.markets, 8, "satellites must never change core breadth/median sample size");
  assert.equal(state.currentContext?.regime, "SHOCK_TRANSITION");
  assert.equal(state.warmMarkets, 8, "warmMarkets reports core context readiness only");
});
