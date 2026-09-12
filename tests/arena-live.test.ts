import test from "node:test";
import assert from "node:assert/strict";
import { arenaProtectionStop, arenaScenario, arenaTradePlan, eligibleForLiveMirror, liveMirrorExitRequired } from "../lib/arena-live.ts";
import type { ArenaTrade } from "../lib/strategy-arena.ts";

const trade = (openedAt = 10_000): ArenaTrade => ({
  id: "PORTFOLIO:steady_trend:ONE", strategyId: "steady_trend:confirm:fast", strategyName: "平稳趋势延续",
  family: "TREND", lane: "PORTFOLIO", eventId: "ONE", symbol: "BTC_USDT", side: "LONG", status: "OPEN",
  openedAt, closedAt: null, entryPrice: 100, stopPrice: 99.5, targetPrice: 101, exitPrice: null, outcome: null,
  grossReturnRate: null, netReturnRate: null, netPnl: null, notional: 300, maxFavorableRate: 0,
  maxAdverseRate: 0, lastPrice: 100, selectedForPortfolio: true, reason: "趋势确认",
  admissionTier: "NORMAL", plannedRisk: 1.86, contracts: 3_000, quantoMultiplier: 0.001,
  leverage: 3, margin: 100, accountEquityAtOpen: 1_000,
  context: { channel: "TREND", regime: "TREND", anomalyKind: null, entryStyle: "CONFIRM", exitProfile: "FAST",
    candidateScore: 70, trendRate: 0.01, trendEfficiency: 0.8, volatilityRatio: 1.2, rangePosition: 0.9,
    openInterestChangeRate: 0.01, volume24hUsd: 100_000_000, fundingRate: 0, alignedFlow: 0.2,
    confirmation: 0.8, fakeoutRisk: 0.1, rangeId: null, modeledCostRate: 0.0012, spreadRate: 0.0001,
    bidDepthUsd: 1_000_000, askDepthUsd: 1_000_000,
    structureSource: "ROUTE", grossRewardRate: 0.01, structuralStopRate: 0.005, netRewardRisk: 1.44,
    costShare: 0.12, empiricalExpectedReturnRate: 0.001, empiricalProfitFactor: 1.3, empiricalEvents: 8 },
});

test("selected portfolio trade freezes identical LIVE direction, stop and target geometry", () => {
  const selected = trade();
  const plan = arenaTradePlan(selected);
  assert.equal(arenaScenario(selected), "BREAKOUT");
  assert.equal(plan.id, selected.id);
  assert.equal(plan.side, selected.side);
  assert.equal(plan.entryTrigger, selected.entryPrice);
  assert.equal(plan.invalidation, selected.stopPrice);
  assert.equal(plan.target, selected.targetPrice);
  assert.equal(plan.state, "TRIGGERED");
});

test("LIVE preserves reversal identity and follows the PAPER active protection stop", () => {
  const selected = trade(10_000);
  selected.family = "REVERSAL";
  selected.strategyId = "exhaustion_turn";
  selected.activeStopPrice = 100.4;
  selected.profitArmedAt = 10_500;
  assert.equal(arenaScenario(selected), "REVERSAL");
  assert.equal(arenaProtectionStop(selected), 100.4);
  assert.equal(arenaProtectionStop({ ...selected, activeStopPrice: undefined }), selected.stopPrice);
});

test("LIVE continuously mirrors every currently open PAPER portfolio trade while owner-enabled", () => {
  const selected = trade(10_000);
  assert.equal(eligibleForLiveMirror(selected, 10_001, 10_002), true, "enabling LIVE backfills an already-open PAPER holding");
  assert.equal(eligibleForLiveMirror(selected, 9_999, 20_001), true, "an open PAPER holding remains eligible after the old ten-second window");
  assert.equal(eligibleForLiveMirror({ ...selected, status: "CLOSED" }, 9_999, 20_001), false);
  assert.equal(eligibleForLiveMirror(selected, null, 20_001), false);
});

test("LIVE exits when the one PAPER account closes or replaces its selected trade", () => {
  const selected = trade();
  assert.equal(liveMirrorExitRequired(selected.id, selected), false);
  assert.equal(liveMirrorExitRequired(selected.id, null), true);
  assert.equal(liveMirrorExitRequired(selected.id, { ...selected, id: "replacement" }), true);
});
