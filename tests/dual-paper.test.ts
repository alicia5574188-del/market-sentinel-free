import assert from "node:assert/strict";
import test from "node:test";
import { CANONICAL_PAPER_REFERENCE_EQUITY, canonicalLivePortfolio, canonicalPaperOpen, canonicalPaperSummary,
  initialCanonicalPaperState, reconcileCanonicalPaper, type CanonicalPaperState } from "../lib/dual-paper.ts";
import { initialStrategyArena, STRATEGY_CATALOG as CURRENT_CATALOG, type ArenaTrade } from "../lib/strategy-arena.ts";
import { initialStrategyArena as initialPreviousStrategyArena,
  STRATEGY_CATALOG as PREVIOUS_CATALOG } from "../lib/previous-strategy-arena.ts";
import { previousCompletedCandleStrategyCandidate } from "../lib/previous-market-regime.ts";
import { initialRegimePortfolio } from "../lib/regime-portfolio.ts";

const accounts = (current = initialStrategyArena(1), previous = initialPreviousStrategyArena(1)) =>
  ({ current, previous, regime: initialRegimePortfolio(1) });

function trade(id: string, side: "LONG" | "SHORT", contracts: number, notional: number,
  accountEquityAtOpen = 1_000): ArenaTrade {
  return {
    id, strategyId: id.includes("previous") ? "tide_relay" : "range_reentry", strategyName: id,
    family: "TREND", lane: "PORTFOLIO", eventId: `event:${id}`, symbol: "BTC_USDT", side, status: "OPEN",
    openedAt: id.includes("previous") ? 2_000 : 1_000, closedAt: null, entryPrice: 100,
    stopPrice: side === "LONG" ? 98 : 102, targetPrice: side === "LONG" ? 104 : 96,
    exitPrice: null, outcome: null, grossReturnRate: null, netReturnRate: null, netPnl: null,
    notional, maxFavorableRate: 0, maxAdverseRate: 0, lastPrice: 100, selectedForPortfolio: true,
    reason: id, admissionTier: "NORMAL", plannedRisk: notional * 0.0214, contracts,
    quantoMultiplier: 0.001, leverage: 2, margin: notional / 2, accountEquityAtOpen,
    context: { channel: "TREND", regime: "TREND", anomalyKind: null, entryStyle: "CONFIRM", exitProfile: "STRUCTURE",
      candidateScore: 80, trendRate: 0.01, trendEfficiency: 0.8, volatilityRatio: 1.2, rangePosition: 0.8,
      openInterestChangeRate: 0, volume24hUsd: 1_000_000_000, fundingRate: 0, alignedFlow: 0,
      confirmation: 0.8, fakeoutRisk: 0.1, rangeId: null, modeledCostRate: 0.0014, spreadRate: 0.0001,
      bidDepthUsd: 1_000_000, askDepthUsd: 1_000_000, structureSource: "ROUTE", grossRewardRate: 0.04,
      structuralStopRate: 0.02, netRewardRisk: 1.8, costShare: 0.04, empiricalExpectedReturnRate: 0.002,
      empiricalProfitFactor: 1.4, empiricalEvents: 12 },
  };
}

function reconcile(value: ReturnType<typeof accounts>, state: CanonicalPaperState = initialCanonicalPaperState(1), now = 3_000) {
  return reconcileCanonicalPaper({ state, accounts: value, now }).state;
}

test("five systems retain separate 1000 U ledgers while the canonical PAPER starts at 10000 U", () => {
  const value = accounts();
  const state = reconcile(value);
  const summary = canonicalPaperSummary(value, state);

  assert.equal(CANONICAL_PAPER_REFERENCE_EQUITY, 10_000);
  assert.equal(summary.dualPaperVersion, 4);
  assert.equal(summary.portfolioEquity, 10_000);
  assert.equal(summary.initialEquity, 10_000);
  assert.equal(summary.engines.length, 5);
  assert.ok(summary.engines.every((engine) => engine.portfolioEquity === 1_000));
  assert.equal(summary.rules.canonicalCopySizing, "SOURCE_EQUITY_FRACTION");
  assert.equal(summary.rules.canonicalEntryScaleFrozen, true);
});

test("the online and previous strategy catalogs stay frozen as two distinct decision systems", () => {
  assert.deepEqual(CURRENT_CATALOG.map((row) => row.id),
    ["range_reentry", "channel_break", "trend_pullback", "bear_squeeze", "bull_pullback"]);
  assert.deepEqual(PREVIOUS_CATALOG.map((row) => row.id),
    ["momentum_carry", "tide_catchup", "quiet_drift", "impulse_recoil", "impulse_fold", "tide_relay"]);
});

test("the previous engine builds its own frozen V4 route from the shared candle stream", () => {
  const now = 60_000_000;
  const last = now / 1_000 - 300;
  const candles = Array.from({ length: 120 }, (_, index) => {
    const base = 100 + index * 0.1;
    return { time: last - (119 - index) * 300, open: base, high: base + 0.15, low: base - 0.05,
      close: base + 0.08, volume: 1 };
  });
  Object.assign(candles[115], { open: 111.4, close: 111.45, high: 111.5, low: 111.3 });
  Object.assign(candles[116], { open: 111.45, close: 111.5, high: 111.55, low: 111.35 });
  Object.assign(candles[117], { open: 111.5, close: 111.55, high: 111.6, low: 111.4 });
  Object.assign(candles[118], { open: 111.55, close: 111.6, high: 111.65, low: 111.45 });
  Object.assign(candles[119], { open: 111.6, close: 112.2, high: 112.25, low: 111.55 });

  const result = previousCompletedCandleStrategyCandidate({ symbol: "BTC_USDT", candles,
    volume24hUsd: 1_000_000_000, fundingRate: 0, now });
  assert.equal(result?.candidate.allRegimeRoutes?.[0].version, 4);
  assert.equal(result?.candidate.allRegimeRoutes?.[0].strategyId, "momentum_carry");
});

test("same symbol remains independent and each source fraction is copied against 10000 U", () => {
  const current = initialStrategyArena(1);
  const previous = initialPreviousStrategyArena(1);
  current.portfolioOpen.BTC_USDT = trade("current", "LONG", 2_000, 200);
  previous.portfolioOpen.BTC_USDT = trade("previous", "LONG", 3_000, 300) as never;
  const value = accounts(current, previous);
  const state = reconcile(value);

  const logical = canonicalPaperOpen(value, state);
  const live = canonicalLivePortfolio(value, state);
  assert.equal(logical.length, 2);
  assert.deepEqual(logical.map((row) => row.engineId).sort(), ["CURRENT_V5", "PREVIOUS_V4"]);
  assert.equal(logical[0].contracts + logical[1].contracts, 50_000);
  assert.equal(logical.reduce((sum, row) => sum + row.notional, 0), 5_000);
  assert.equal(live.BTC_USDT.contracts, 50_000);
  assert.equal(live.BTC_USDT.notional, 5_000);
  assert.equal(live.BTC_USDT.accountEquityAtOpen, 10_000);
  assert.equal(current.portfolioOpen.BTC_USDT.contracts, 2_000);
  assert.equal(previous.portfolioOpen.BTC_USDT.contracts, 3_000);
});

test("a lone current-version leg keeps its legacy LIVE lifecycle id", () => {
  const current = initialStrategyArena(1);
  current.portfolioOpen.BTC_USDT = trade("current-live-id", "LONG", 2_000, 200);
  const value = accounts(current);
  const live = canonicalLivePortfolio(value, reconcile(value));
  assert.equal(live.BTC_USDT.id, "current-live-id");
  assert.equal(live.BTC_USDT.notional, 2_000);
});

test("canonical PAPER applies no third risk gate while scaling every order fraction", () => {
  const current = initialStrategyArena(1);
  const previous = initialPreviousStrategyArena(1);
  const currentTrade = trade("current", "LONG", 4_000, 400);
  const previousTrade = trade("previous", "LONG", 4_000, 400);
  currentTrade.plannedRisk = 65;
  previousTrade.plannedRisk = 65;
  current.portfolioOpen.BTC_USDT = currentTrade;
  previous.portfolioOpen.BTC_USDT = previousTrade as never;
  const value = accounts(current, previous);

  const logical = canonicalPaperOpen(value, reconcile(value));
  assert.equal(logical.reduce((sum, row) => sum + row.plannedRisk, 0), 1_300);
  assert.equal(logical.reduce((sum, row) => sum + row.margin, 0), 4_000);
  assert.deepEqual(logical.map((row) => row.contracts).sort((left, right) => left - right), [40_000, 40_000]);
  assert.equal(current.portfolioOpen.BTC_USDT.plannedRisk, 65);
  assert.equal(previous.portfolioOpen.BTC_USDT.plannedRisk, 65);
});

test("opposite same-symbol decisions coexist logically and LIVE receives normalized net only", () => {
  const current = initialStrategyArena(1);
  const previous = initialPreviousStrategyArena(1);
  current.portfolioOpen.BTC_USDT = trade("current", "LONG", 5_000, 500);
  previous.portfolioOpen.BTC_USDT = trade("previous", "SHORT", 2_000, 200) as never;
  const value = accounts(current, previous);
  let state = reconcile(value);

  assert.equal(canonicalPaperOpen(value, state).length, 2);
  const live = canonicalLivePortfolio(value, state);
  assert.equal(live.BTC_USDT.side, "LONG");
  assert.equal(live.BTC_USDT.notional, 3_000);
  assert.equal(live.BTC_USDT.contracts, 30_000);

  previous.portfolioOpen.BTC_USDT = trade("previous", "SHORT", 5_000, 500) as never;
  state = reconcile(value, initialCanonicalPaperState(1));
  assert.deepEqual(canonicalLivePortfolio(value, state), {});
  assert.equal(canonicalPaperOpen(value, state).length, 2);
});

test("a closed copy compounds canonical equity and later orders use the new frozen snapshot", () => {
  const current = initialStrategyArena(1);
  const value = accounts(current);
  current.portfolioOpen.BTC_USDT = trade("first", "LONG", 5_000, 500);
  let state = reconcile(value);
  assert.equal(canonicalPaperOpen(value, state)[0].notional, 5_000);

  const closed = { ...current.portfolioOpen.BTC_USDT, status: "CLOSED" as const, closedAt: 4_000,
    exitPrice: 106, outcome: "TARGET" as const, grossReturnRate: .06, netReturnRate: .05, netPnl: 50 };
  current.portfolioOpen = {};
  current.recentPortfolio = [closed];
  state = reconcile(value, state, 4_001);
  assert.equal(state.equity, 10_500);
  assert.equal(state.recent[0].netPnl, 500);

  current.portfolioOpen.BTC_USDT = trade("second", "LONG", 5_250, 525, 1_050);
  state = reconcile(value, state, 5_000);
  const second = canonicalPaperOpen(value, state)[0];
  assert.equal(second.notional, 5_250);
  assert.equal(second.accountEquityAtOpen, 10_500);
});

test("an existing copy never resizes when another trade changes canonical equity", () => {
  const current = initialStrategyArena(1);
  const previous = initialPreviousStrategyArena(1);
  current.portfolioOpen.BTC_USDT = trade("current", "LONG", 2_000, 200);
  const value = accounts(current, previous);
  let state = reconcile(value);
  const frozen = canonicalPaperOpen(value, state)[0];

  previous.portfolioOpen.BTC_USDT = trade("previous", "LONG", 3_000, 300) as never;
  state.equity = 12_000;
  state = reconcile(value, state, 4_000);
  const logical = canonicalPaperOpen(value, state);
  assert.equal(logical.find((row) => row.engineTradeId === "current")?.notional, frozen.notional);
  assert.equal(logical.find((row) => row.engineTradeId === "previous")?.notional, 3_600);
});

test("canonical aggregation never writes back into any source trajectory", () => {
  const current = initialStrategyArena(1);
  const previous = initialPreviousStrategyArena(1);
  current.portfolioOpen.BTC_USDT = trade("current", "LONG", 2_000, 200);
  previous.portfolioOpen.BTC_USDT = trade("previous", "SHORT", 1_000, 100) as never;
  const value = accounts(current, previous);
  const currentBefore = structuredClone(current);
  const previousBefore = structuredClone(previous);
  const state = reconcile(value);

  canonicalPaperSummary(value, state);
  canonicalLivePortfolio(value, state);

  assert.deepEqual(current, currentBefore);
  assert.deepEqual(previous, previousBefore);
});
