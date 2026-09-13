import assert from "node:assert/strict";
import test from "node:test";
import { CANONICAL_PAPER_REFERENCE_EQUITY, ENGINE_ORDER_COPY_RATE, canonicalLivePortfolio,
  canonicalPaperOpen, canonicalPaperSummary } from "../lib/dual-paper.ts";
import { initialStrategyArena, STRATEGY_CATALOG as CURRENT_CATALOG, type ArenaTrade } from "../lib/strategy-arena.ts";
import { initialStrategyArena as initialPreviousStrategyArena,
  STRATEGY_CATALOG as PREVIOUS_CATALOG } from "../lib/previous-strategy-arena.ts";
import { previousCompletedCandleStrategyCandidate } from "../lib/previous-market-regime.ts";

function trade(id: string, side: "LONG" | "SHORT", contracts: number, notional: number): ArenaTrade {
  return {
    id, strategyId: id.includes("previous") ? "tide_relay" : "range_reentry", strategyName: id,
    family: "TREND", lane: "PORTFOLIO", eventId: `event:${id}`, symbol: "BTC_USDT", side, status: "OPEN",
    openedAt: id.includes("previous") ? 2_000 : 1_000, closedAt: null, entryPrice: 100,
    stopPrice: side === "LONG" ? 98 : 102, targetPrice: side === "LONG" ? 104 : 96,
    exitPrice: null, outcome: null, grossReturnRate: null, netReturnRate: null, netPnl: null,
    notional, maxFavorableRate: 0, maxAdverseRate: 0, lastPrice: 100, selectedForPortfolio: true,
    reason: id, admissionTier: "NORMAL", plannedRisk: notional * 0.0214, contracts,
    quantoMultiplier: 0.001, leverage: 2, margin: notional / 2, accountEquityAtOpen: 1_000,
    context: { channel: "TREND", regime: "TREND", anomalyKind: null, entryStyle: "CONFIRM", exitProfile: "STRUCTURE",
      candidateScore: 80, trendRate: 0.01, trendEfficiency: 0.8, volatilityRatio: 1.2, rangePosition: 0.8,
      openInterestChangeRate: 0, volume24hUsd: 1_000_000_000, fundingRate: 0, alignedFlow: 0,
      confirmation: 0.8, fakeoutRisk: 0.1, rangeId: null, modeledCostRate: 0.0014, spreadRate: 0.0001,
      bidDepthUsd: 1_000_000, askDepthUsd: 1_000_000, structureSource: "ROUTE", grossRewardRate: 0.04,
      structuralStopRate: 0.02, netRewardRisk: 1.8, costShare: 0.04, empiricalExpectedReturnRate: 0.002,
      empiricalProfitFactor: 1.4, empiricalEvents: 12 },
  };
}

test("two strategy engines retain separate 1000 U ledgers while canonical PAPER reports their full combined result", () => {
  const current = initialStrategyArena(1);
  const previous = initialPreviousStrategyArena(1);
  current.portfolioEquity = 1_075;
  previous.portfolioEquity = 940;
  const summary = canonicalPaperSummary({ current, previous });

  assert.equal(CANONICAL_PAPER_REFERENCE_EQUITY, 1_000);
  assert.equal(ENGINE_ORDER_COPY_RATE, 1);
  assert.equal(summary.dualPaperVersion, 2);
  assert.equal(summary.portfolioEquity, 1_015);
  assert.equal(summary.initialEquity, 1_000);
  assert.equal(summary.engines[0].portfolioEquity, 1_075);
  assert.equal(summary.engines[1].portfolioEquity, 940);
  assert.equal(current.portfolioEquity, 1_075);
  assert.equal(previous.portfolioEquity, 940);
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

test("same symbol can remain open in both engines without either ledger suppressing the other", () => {
  const current = initialStrategyArena(1);
  const previous = initialPreviousStrategyArena(1);
  current.portfolioOpen.BTC_USDT = trade("current", "LONG", 2_000, 200);
  previous.portfolioOpen.BTC_USDT = trade("previous", "LONG", 3_000, 300) as never;

  const logical = canonicalPaperOpen({ current, previous });
  const live = canonicalLivePortfolio({ current, previous });
  assert.equal(logical.length, 2, "canonical PAPER must preserve both logical trades");
  assert.deepEqual(logical.map((row) => row.engineId).sort(), ["CURRENT_V5", "PREVIOUS_V4"]);
  assert.equal(Object.keys(current.portfolioOpen).length, 1);
  assert.equal(Object.keys(previous.portfolioOpen).length, 1);
  assert.equal(logical[0].contracts + logical[1].contracts, 5_000,
    "canonical PAPER must copy both engine orders without reducing either one");
  assert.equal(live.BTC_USDT.contracts, 5_000, "single-mode LIVE mirrors the canonical full-size net contracts");
  assert.equal(live.BTC_USDT.notional, 500);
  assert.equal(live.BTC_USDT.accountEquityAtOpen, 1_000);
});

test("a lone current-version leg keeps its legacy LIVE lifecycle id during migration", () => {
  const current = initialStrategyArena(1);
  const previous = initialPreviousStrategyArena(1);
  current.portfolioOpen.BTC_USDT = trade("current-live-id", "LONG", 2_000, 200);
  const live = canonicalLivePortfolio({ current, previous });
  assert.equal(live.BTC_USDT.id, "current-live-id");
  assert.equal(live.BTC_USDT.notional, 200, "a lone order must reach canonical PAPER at its complete engine size");
});

test("canonical PAPER copies 100% from each engine without applying a third capital or risk gate", () => {
  const current = initialStrategyArena(1);
  const previous = initialPreviousStrategyArena(1);
  const currentTrade = trade("current", "LONG", 4_000, 400);
  const previousTrade = trade("previous", "LONG", 4_000, 400);
  currentTrade.plannedRisk = 65;
  previousTrade.plannedRisk = 65;
  current.portfolioOpen.BTC_USDT = currentTrade;
  previous.portfolioOpen.BTC_USDT = previousTrade as never;

  const logical = canonicalPaperOpen({ current, previous });
  assert.equal(logical.reduce((sum, row) => sum + row.plannedRisk, 0), 130);
  assert.equal(logical.reduce((sum, row) => sum + row.margin, 0), 400);
  assert.deepEqual(logical.map((row) => row.contracts).sort((left, right) => left - right), [4_000, 4_000]);
  assert.equal(current.portfolioOpen.BTC_USDT.plannedRisk, 65);
  assert.equal(previous.portfolioOpen.BTC_USDT.plannedRisk, 65);
});

test("opposite same-symbol decisions coexist logically and only their net reaches LIVE", () => {
  const current = initialStrategyArena(1);
  const previous = initialPreviousStrategyArena(1);
  current.portfolioOpen.BTC_USDT = trade("current", "LONG", 5_000, 500);
  previous.portfolioOpen.BTC_USDT = trade("previous", "SHORT", 2_000, 200) as never;

  assert.equal(canonicalPaperOpen({ current, previous }).length, 2);
  const live = canonicalLivePortfolio({ current, previous });
  assert.equal(live.BTC_USDT.side, "LONG");
  assert.equal(live.BTC_USDT.contracts, 3_000);

  previous.portfolioOpen.BTC_USDT = trade("previous", "SHORT", 5_000, 500) as never;
  assert.deepEqual(canonicalLivePortfolio({ current, previous }), {}, "equal opposite legs remain in PAPER but need no Gate exposure");
  assert.equal(canonicalPaperOpen({ current, previous }).length, 2);
});

test("canonical aggregation never writes back into either engine trajectory", () => {
  const current = initialStrategyArena(1);
  const previous = initialPreviousStrategyArena(1);
  current.portfolioOpen.BTC_USDT = trade("current", "LONG", 2_000, 200);
  previous.portfolioOpen.BTC_USDT = trade("previous", "SHORT", 1_000, 100) as never;
  const currentBefore = structuredClone(current);
  const previousBefore = structuredClone(previous);

  canonicalPaperSummary({ current, previous });
  canonicalLivePortfolio({ current, previous });

  assert.deepEqual(current, currentBefore);
  assert.deepEqual(previous, previousBefore);
});
