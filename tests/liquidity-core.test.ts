import assert from "node:assert/strict";
import test from "node:test";
import {
  PORTFOLIO_RISK_CAP,
  MIN_NET_REWARD_RISK,
  MAX_GENERIC_PLAN_DISTANCE_RATE,
  cascadeRatio,
  decideThreeState as rawDecideThreeState,
  hasCascade,
  planTriggered,
  remainingStressRisk,
  selectSafeLeverage,
  sizePaperPosition,
  stablePriceBin,
  tradeEconomics,
  updatePosition,
  wallPersistence,
  zoneUtility,
  type FlowEvidence,
  type LiquidationBand,
  type LiquidityRoute,
  type LiquidityZone,
  type PaperPlan,
  type PaperPosition,
} from "../lib/liquidity-core.ts";
import { PLAN_TTL_MS, aggregateFourHourCandles, ancillarySchedule, arbitrateDecision, buildLiquidityRoutes, deriveMinuteNoiseRate, deriveRangeStructure, deriveStructureZones, emptySymbolMemory, inferLiquidationBands, reconcilePaper, selectRouteDecision, updateOpenInterestCohorts, usableSnapshot } from "../lib/liquidity-runtime.ts";
import { drainPositionOutbox, enqueuePositionTransition } from "../lib/paper-outbox.ts";

const flow = (patch: Partial<FlowEvidence> = {}): FlowEvidence => ({ ofi: 0, micropriceDisplacementBps: 0, takerDelta: 0, openInterestDelta: 0, funding: 0, actualLiquidations: 0, priceResponseBps: 0, ...patch });
const decideThreeState = (input: Parameters<typeof rawDecideThreeState>[0]) => rawDecideThreeState({ timeframeBias: { m1: "NEUTRAL", m15: "NEUTRAL", h1: "NEUTRAL" }, ...input });
const zone = (side: "LONG" | "SHORT", price: number, scoreScale = 1): LiquidityZone => zoneUtility({
  identity: `BOOK:${side}:${price}`, side, price, liquidity: 1_000 * scoreScale, cascade: 0, pathCost: 1, distanceCost: 1,
  probabilityReach: 0.7, persistence: 0.9, source: "BOOK",
});
const band = (side: "LONG" | "SHORT", price: number, ratio: number): LiquidationBand => ({
  side, price, expectedForcedNotional: ratio * 1_000, opposingDepth: 1_000, leverage: 20, actualCalibration: 1,
});

test("utility is predictive reach times liquidity/cost times persistence", () => {
  const value = zoneUtility({ side: "LONG", price: 110, liquidity: 800, cascade: 200, pathCost: 2, distanceCost: 3, probabilityReach: 0.6, persistence: 0.75, source: "BOOK" });
  assert.equal(value.score, 90);
});

test("utility ordering is invariant when every USDT amount changes scale", () => {
  const one = zoneUtility({ side: "LONG", price: 110, liquidity: 800, cascade: 200, pathCost: 200, distanceCost: 50, probabilityReach: 0.6, persistence: 0.75, source: "BOOK" });
  const ten = zoneUtility({ side: "LONG", price: 110, liquidity: 8_000, cascade: 2_000, pathCost: 2_000, distanceCost: 500, probabilityReach: 0.6, persistence: 0.75, source: "BOOK" });
  assert.equal(one.score, ten.score);
});

test("completed 1h candles form 4h structure without another exchange request", () => {
  const rows = Array.from({ length: 9 }, (_, index) => ({ time: index * 3_600, open: 100 + index,
    close: 100.5 + index, high: 101 + index, low: 99 + index, volume: 10 + index }));
  const h4 = aggregateFourHourCandles(rows);
  assert.equal(h4.length, 2);
  assert.deepEqual(h4[0], { time: 0, open: 100, close: 103.5, high: 104, low: 99, volume: 46 });
});

test("15m balance creates two-sided local routes and a gated next-node leg", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ time: index * 900, open: 99.45,
    close: index % 2 ? 99.72 : 99.3, high: index % 3 === 0 ? 100 : 99.82,
    low: index % 3 === 1 ? 99 : 99.18, volume: 10 }));
  const range = deriveRangeStructure(rows);
  assert.ok(range && range.lower < 99.3 && range.upper > 99.7);
  const memory = emptySymbolMemory();
  memory.range15m = range;
  memory.flow = flow({ ofi: 0.55, takerDelta: 0.45, micropriceDisplacementBps: 2 });
  memory.timeframeBias = { m1: "UP", m15: "UP", h1: "UP", h4: "UP" };
  memory.structureByTimeframe.h4 = [zone("LONG", 101.2), zone("LONG", 102.4), zone("SHORT", 98.7)];
  const observedAt = range.observedAt + 1;
  const routes = buildLiquidityRoutes(memory, "BTC_USDT", observedAt, 99.9, 0.15);
  const first = routes.find((route) => route.kind === "LOCAL_BREAKOUT" && route.side === "LONG");
  const next = routes.find((route) => route.kind === "NODE_CONTINUATION" && route.side === "LONG");
  assert.ok(first && first.target < 101.2 && first.target > first.entryTrigger);
  assert.equal(first.targetTimeframe, "15m");
  assert.equal(first.nextTarget, 101.2);
  assert.equal(first?.executableNow, true);
  assert.equal(next?.executableNow, false);
  assert.equal(next?.target, 101.2);
  assert.equal(selectRouteDecision(routes, observedAt)?.routeId, first?.id);
  assert.ok(routes.some((route) => route.kind === "EDGE_REJECTION"));
});

test("completed one-minute noise sets a stop floor and edge rejection waits for a sweep-and-reclaim close", () => {
  const memory = emptySymbolMemory();
  memory.range15m = { lower: 99, upper: 101, midpoint: 100, widthRate: 0.02,
    touchesLower: 4, touchesUpper: 4, quality: 0.9, observedAt: 10_000 };
  memory.minuteNoiseRate = 0.002;
  memory.flow = flow({ ofi: 0.6, takerDelta: 0.8, micropriceDisplacementBps: 2 });
  memory.timeframeBias = { m1: "UP", m15: "NEUTRAL", h1: "NEUTRAL", h4: "NEUTRAL" };
  let routes = buildLiquidityRoutes(memory, "SOL_USDT", 10_001, 99.05, 0.9);
  let lowerLong = routes.find((route) => route.kind === "EDGE_REJECTION" && route.side === "LONG")!;
  assert.equal(lowerLong.executableNow, false);
  memory.lastCompletedMinuteCandle = { time: 0, open: 98.98, high: 99.2, low: 98.9, close: 99.12 };
  routes = buildLiquidityRoutes(memory, "SOL_USDT", 10_001, 99.05, 0.9);
  lowerLong = routes.find((route) => route.kind === "EDGE_REJECTION" && route.side === "LONG")!;
  assert.equal(lowerLong.executableNow, true);
  assert.ok((lowerLong.entryTrigger - lowerLong.invalidation) / lowerLong.entryTrigger >= 0.0022 - 1e-9);
  assert.ok(lowerLong.target <= 100.7 && lowerLong.target >= 100);
});

test("the robust one-minute noise estimate ignores tiny bars and caps a volatility spike", () => {
  const rows = Array.from({ length: 19 }, (_, time) => ({ time: time * 60, open: 100, high: 100.2, low: 100, close: 100.1, volume: 1 }));
  rows.push({ time: 19 * 60, open: 100, high: 105, low: 95, close: 100, volume: 1 });
  const rate = deriveMinuteNoiseRate(rows);
  assert.ok(rate >= 0.0019 && rate <= 0.0021);
});

test("ETH local routing rejects a distant 4h node and uses the nearest segment", () => {
  const memory = emptySymbolMemory();
  memory.range15m = { lower: 2491, upper: 2502.29, midpoint: 2496.645, widthRate: 0.004522068616082769,
    touchesLower: 4, touchesUpper: 7, quality: 0.8125, observedAt: 10_000 };
  memory.flow = flow({ ofi: -0.2, takerDelta: -0.15 });
  memory.timeframeBias = { m1: "NEUTRAL", m15: "NEUTRAL", h1: "NEUTRAL", h4: "NEUTRAL" };
  memory.structureByTimeframe.m15 = [zone("SHORT", 2480.63)];
  memory.structureByTimeframe.h4 = [zone("SHORT", 2430), zone("SHORT", 2419.7), zone("LONG", 2515.16)];
  const routes = buildLiquidityRoutes(memory, "ETH_USDT", 10_001, 2500.54, 0.2);
  const short = routes.find((route) => route.kind === "LOCAL_BREAKOUT" && route.side === "SHORT");
  assert.equal(short?.target, 2480.63);
  assert.equal(short?.targetTimeframe, "15m");
  assert.ok(!routes.some((route) => route.kind === "LOCAL_BREAKOUT" && [2430, 2419.7].includes(route.target)));
});

test("a valid 15m route map blocks the legacy all-timeframe fallback", () => {
  const fallback = { symbol: "ETH_USDT", observedAt: 1, marketState: "RANGE" as const, side: "LONG" as const,
    entryTrigger: 2419.4973, invalidation: 2394.45617, target: 2500.9, targetIdentity: "local-target", score: 1, oppositeScore: 0.9,
    reason: [], activationDistanceRate: MAX_GENERIC_PLAN_DISTANCE_RATE };
  const observingRoute: LiquidityRoute = { id: "local", symbol: "ETH_USDT", side: "LONG", kind: "LOCAL_BREAKOUT",
    stage: "LOCAL_TO_NODE", entryTrigger: 2502.97, invalidation: 2499.58, target: 2515.16, targetIdentity: "route-target",
    targetTimeframe: "1h", nextTarget: null, confirmationScore: 0.4, fakeoutRisk: 0.7,
    activationDistanceRate: 0.003, score: 0.8, executableNow: false, reason: [] };
  assert.equal(arbitrateDecision([observingRoute], 1, fallback), null);
  assert.equal(arbitrateDecision([], 1, fallback), fallback);
});

test("an existing nonlocal fallback plan is cancelled immediately", () => {
  const plan: PaperPlan = { symbol: "ETH_USDT", observedAt: 1, marketState: "RANGE", side: "LONG",
    entryTrigger: 2419.4973, invalidation: 2394.45617, target: 2500.9, targetIdentity: "legacy-target", score: 1, oppositeScore: 0.9,
    reason: [], id: "legacy-far", state: "PREPARED", createdAt: 1, expiresAt: PLAN_TTL_MS + 1,
    plannedRisk: 12, notional: 1_000 };
  const observingRoute: LiquidityRoute = { id: "local", symbol: "ETH_USDT", side: "LONG", kind: "LOCAL_BREAKOUT",
    stage: "LOCAL_TO_NODE", entryTrigger: 2502.97, invalidation: 2499.58, target: 2515.16, targetIdentity: "route-target",
    targetTimeframe: "1h", nextTarget: null, confirmationScore: 0.4, fakeoutRisk: 0.7,
    activationDistanceRate: 0.003, score: 0.8, executableNow: false, reason: [] };
  const result = reconcilePaper({ now: 2, midpoint: 2500.54, fresh: true, sequenceFault: false, decision: null,
    plan, position: null, zones: [], activeRoutes: [observingRoute], absorption: 0, equity: 1_000, openRisk: 0 });
  assert.equal(result.plan?.state, "CANCELLED");
  assert.deepEqual(result.events, ["NONLOCAL_FALLBACK_CANCEL"]);
});

test("a frozen local breakout is not vetoed by one transient trigger-time score", () => {
  const memory = emptySymbolMemory();
  memory.range15m = { lower: 99, upper: 100, midpoint: 99.5, widthRate: 1 / 99.5,
    touchesLower: 3, touchesUpper: 3, quality: 0.9, observedAt: 10_000 };
  memory.flow = flow({ ofi: 0.6, takerDelta: 0.5, micropriceDisplacementBps: 2 });
  memory.timeframeBias = { m1: "UP", m15: "UP", h1: "UP", h4: "UP" };
  memory.structureByTimeframe.h4 = [zone("LONG", 101.2), zone("SHORT", 98.7)];
  const routes = buildLiquidityRoutes(memory, "BTC_USDT", 10_001, 99.9, 0.1);
  const decision = selectRouteDecision(routes, 10_001);
  assert.ok(decision?.routeKind === "LOCAL_BREAKOUT");
  const prepared = reconcilePaper({ now: 10_001, midpoint: 99.9, fresh: true, sequenceFault: false,
    decision, plan: null, position: null, zones: [], activeRoutes: routes, absorption: 0.1,
    equity: 1_000, openRisk: 0, allowOpen: false });
  assert.equal(prepared.plan?.state, "PREPARED");
  const crossed = reconcilePaper({ now: 10_002, midpoint: prepared.plan!.entryTrigger + 0.01, fresh: true,
    sequenceFault: false, decision, plan: prepared.plan, position: null, zones: [], activeRoutes: routes,
    breakoutConfirmation: 0.3, absorption: 0.1, equity: 1_000, openRisk: 0, allowOpen: true });
  assert.equal(crossed.plan?.state, "TRIGGERED");
  assert.equal(crossed.position?.status, "OPEN");
  assert.ok(crossed.events.includes("PAPER_OPEN"));
});

test("a prepared route needs two completed minutes below its hysteresis floor before cancellation", () => {
  const decision = { symbol: "BTC_USDT", observedAt: 1, marketState: "BREAKOUT" as const, side: "LONG" as const,
    entryTrigger: 101, invalidation: 99, target: 110, targetIdentity: "HTF:LONG:110", score: 2, oppositeScore: 1,
    reason: [], routeId: "local-long", routeKind: "LOCAL_BREAKOUT" as const, routeStage: "LOCAL_TO_NODE" as const,
    targetTimeframe: "4h" as const, confirmationScore: 0.6, fakeoutRisk: 0.4, activationDistanceRate: 0.01 };
  const plan: PaperPlan = { ...decision, id: "route-warning", state: "PREPARED", createdAt: 1,
    expiresAt: PLAN_TTL_MS + 1, plannedRisk: 10, notional: 1_000 };
  const weakRoute: LiquidityRoute = { id: "local-long", symbol: "BTC_USDT", side: "LONG", kind: "LOCAL_BREAKOUT",
    stage: "LOCAL_TO_NODE", entryTrigger: 101, invalidation: 99, target: 110, targetIdentity: "HTF:LONG:110",
    targetTimeframe: "4h", nextTarget: null, confirmationScore: 0.39, fakeoutRisk: 0.74,
    activationDistanceRate: 0.01, score: 2, executableNow: false, reason: [] };
  const first = reconcilePaper({ now: 60_001, midpoint: 100, fresh: true, sequenceFault: false, decision: null,
    plan, position: null, zones: [], activeRoutes: [weakRoute], absorption: 0, confirmationMinute: 60_000,
    equity: 1_000, openRisk: 0 });
  assert.equal(first.plan?.state, "PREPARED");
  assert.equal(first.plan?.invalidationSignalReason, "ROUTE_WEAK_CANCEL");
  assert.equal(first.plan?.invalidationSignalCount, 1);
  const cancelled = reconcilePaper({ now: 120_001, midpoint: 100, fresh: true, sequenceFault: false, decision: null,
    plan: first.plan, position: null, zones: [], activeRoutes: [weakRoute], absorption: 0,
    confirmationMinute: 120_000, equity: 1_000, openRisk: 0 });
  assert.equal(cancelled.plan?.state, "CANCELLED");
  assert.deepEqual(cancelled.events, ["ROUTE_WEAK_CANCEL"]);
});

test("dynamic leverage targets ten-percent margin but preserves liquidation distance", () => {
  const sized = selectSafeLeverage({ notional: 4_000, equity: 1_000, entry: 100, invalidation: 99.7,
    maintenanceRate: 0.005, leverageMax: 50 });
  assert.equal(sized.leverage, 40);
  assert.equal(sized.margin, 100);
  const wideStop = selectSafeLeverage({ notional: 4_000, equity: 1_000, entry: 100, invalidation: 97,
    maintenanceRate: 0.005, leverageMax: 50 });
  assert.ok(wideStop.leverage < sized.leverage);
});

test("wall needs 70% of 30 snapshots and is rejected above 50% approach cancellations", () => {
  assert.equal(wallPersistence({ snapshots: 29, seen: 29, approachCancels: 0, approachObservations: 10 }), 0);
  assert.equal(wallPersistence({ snapshots: 30, seen: 21, approachCancels: 5, approachObservations: 10 }), 0.7);
  assert.equal(wallPersistence({ snapshots: 30, seen: 30, approachCancels: 6, approachObservations: 10 }), 0);
});

test("cascade requires two consecutive reachable bands above depth", () => {
  assert.equal(cascadeRatio(band("LONG", 101, 1.2)), 1.2);
  assert.equal(hasCascade([band("LONG", 100.1, 1.2), band("LONG", 100.2, 1.1)], "LONG", 100), true);
  assert.equal(hasCascade([band("LONG", 100.1, 1.2), band("LONG", 100.2, 0.9)], "LONG", 100), false);
  assert.equal(hasCascade([band("LONG", 101, 2), band("LONG", 105, 2)], "LONG", 100), false);
});

test("three states are mutually exclusive", () => {
  const zones = [zone("LONG", 110), zone("SHORT", 90)];
  const breakout = decideThreeState({ symbol: "BTC_USDT", observedAt: 1, mid: 100, zones, bands: [band("LONG", 100.1, 2), band("LONG", 100.2, 2)], flow: flow({ ofi: 0.8, takerDelta: 0.7 }), absorption: 0.1 });
  const reversal = decideThreeState({ symbol: "BTC_USDT", observedAt: 1, mid: 100, zones: [zone("LONG", 100.3), zone("SHORT", 99.7)], bands: [], flow: flow({ ofi: 0.8, takerDelta: 0.4 }), absorption: 0.8 });
  const range = decideThreeState({ symbol: "BTC_USDT", observedAt: 1, mid: 100, zones: [zone("LONG", 110, 1.1), zone("SHORT", 90)], bands: [], flow: flow(), absorption: 0.4 });
  assert.equal(breakout?.marketState, "BREAKOUT");
  assert.equal(reversal?.marketState, "REVERSAL");
  assert.equal(range?.marketState, "RANGE");
  assert.equal(range?.activationDistanceRate, MAX_GENERIC_PLAN_DISTANCE_RATE);
  assert.equal(new Set([breakout?.marketState, reversal?.marketState, range?.marketState]).size, 3);
});

test("default is WAIT and RANGE is forbidden while a cascade exists", () => {
  const unbalanced = [zone("LONG", 110, 2), zone("SHORT", 90)];
  assert.equal(decideThreeState({ symbol: "X_USDT", observedAt: 1, mid: 100, zones: unbalanced, bands: [], flow: flow(), absorption: 0 }), null);
  const balanced = [zone("LONG", 110), zone("SHORT", 90)];
  assert.equal(decideThreeState({ symbol: "X_USDT", observedAt: 1, mid: 100, zones: balanced,
    bands: [band("LONG", 101, 2), band("LONG", 102, 2)], flow: flow(), absorption: 0 }), null);
});

test("missing timeframe evidence fails closed and stable target bins do not depend on current midpoint", () => {
  const zones = [zone("LONG", 110, 2), zone("SHORT", 90)];
  assert.equal(rawDecideThreeState({ symbol: "X", observedAt: 1, mid: 100, zones, bands: [band("LONG", 100.1, 2), band("LONG", 100.2, 2)], flow: flow({ ofi: 1 }), absorption: 0 }), null);
  assert.equal(stablePriceBin(110), stablePriceBin(110));
});

test("explicit multi-timeframe conflict avoids chasing the small-cycle breakout", () => {
  const zones = [zone("LONG", 110, 1.3), zone("SHORT", 90)];
  const result = decideThreeState({ symbol: "BTC_USDT", observedAt: 1, mid: 100, zones,
    bands: [], flow: flow({ ofi: 0.8, takerDelta: 0.7 }),
    absorption: 0.3, timeframeBias: { m1: "UP", m15: "UP", h1: "DOWN" } });
  assert.equal(result?.marketState, "RANGE");
  assert.match(result?.reason.join("/") ?? "", /显式矩阵冲突/);
});

test("reversal and range pre-position at the opposite liquidity edge", () => {
  const zones = [zone("LONG", 100.3), zone("SHORT", 99.7)];
  const reversal = decideThreeState({ symbol: "ETH_USDT", observedAt: 1, mid: 100, zones, bands: [], flow: flow({ ofi: 0.8, takerDelta: 0.5, priceResponseBps: 0 }), absorption: 0.8 })!;
  assert.equal(reversal.side, "SHORT");
  assert.ok(reversal.entryTrigger > 100);
  const plan: PaperPlan = { ...reversal, id: "p", state: "PREPARED", createdAt: 1, expiresAt: 100, plannedRisk: 10, notional: 1_000 };
  assert.equal(planTriggered(plan, reversal.entryTrigger + 0.01), true);
});

test("position sizing never breaches five percent portfolio structural loss", () => {
  const sized = sizePaperPosition({ equity: 1_000, entry: 100, invalidation: 98, feeBps: 10, stressSlippageBps: 8, confidence: 1, openRisk: 44 });
  assert.equal(PORTFOLIO_RISK_CAP, 0.05);
  assert.equal(sized.allowedLoss, 6);
  assert.ok(sized.portfolioRiskAfter <= 50);
});

test("single-entry risk is capped at 1.8% and notional is capped at four times equity", () => {
  const single = sizePaperPosition({ equity: 1_000, entry: 100, invalidation: 98, feeBps: 10, stressSlippageBps: 8, confidence: 1, openRisk: 0 });
  assert.equal(single.allowedLoss, 18);
  assert.ok(single.notional <= 4_000);
  assert.ok(single.notional * 0.0018 <= 7.2);
  const next = sizePaperPosition({ equity: 1_000, entry: 100, invalidation: 98, feeBps: 10, stressSlippageBps: 8, confidence: 1, openRisk: single.allowedLoss });
  assert.equal(next.allowedLoss, 18);
  assert.ok(single.portfolioRiskAfter <= 50 && next.portfolioRiskAfter <= 50);
});

test("dynamic protection tightens only and target absorption exits without fixed TP", () => {
  const position: PaperPosition = { id: "x", symbol: "SOL_USDT", side: "LONG", scenario: "BREAKOUT", entryAt: 1, entryPrice: 100, initialStop: 95, currentStop: 95, currentTarget: 110, plannedRisk: 10, notional: 1_000, targetScore: 20, status: "OPEN" };
  const held = updatePosition(position, { now: 60_001, price: 105, bestTarget: zone("LONG", 112), oppositeTarget: zone("SHORT", 90, 0.2),
    absorption: 0.2, confirmationMinute: 60_000, confirmationPrice: 105 });
  assert.ok(held.currentStop > position.currentStop);
  assert.ok(held.currentStop > position.entryPrice);
  const closed = updatePosition(held, { now: 120_001, price: 112, bestTarget: zone("LONG", 112), oppositeTarget: zone("SHORT", 90, 0.2), absorption: 0.8 });
  assert.equal(closed.status, "CLOSED");
  assert.ok(Number.isFinite(closed.realizedPnl));
});

test("the observed ETH path cannot move protection to entry before one confirmed R", () => {
  const position: PaperPosition = { id: "eth-regression", symbol: "ETH_USDT", side: "SHORT", scenario: "BREAKOUT",
    entryAt: 1, entryPrice: 2496.725, initialStop: 2498.8252, currentStop: 2498.8252, currentTarget: 2452.93,
    plannedRisk: 10, notional: 3_500, targetScore: 20, status: "OPEN" };
  const favorableTick = updatePosition(position, { now: 44_001, price: 2495.94, bestTarget: zone("SHORT", 2452.93),
    oppositeTarget: zone("LONG", 2510), absorption: 0.2 });
  assert.equal(favorableTick.currentStop, position.initialStop);
  const completedBelowOneR = updatePosition(favorableTick, { now: 60_001, price: 2495.05,
    bestTarget: zone("SHORT", 2452.93), oppositeTarget: zone("LONG", 2510), absorption: 0.2,
    confirmationMinute: 60_000, confirmationPrice: 2495.05 });
  assert.equal(completedBelowOneR.currentStop, position.initialStop);
  const normalPullback = updatePosition(completedBelowOneR, { now: 70_001, price: 2497.015,
    bestTarget: zone("SHORT", 2452.93), oppositeTarget: zone("LONG", 2510), absorption: 0.2 });
  assert.equal(normalPullback.status, "OPEN");
});

test("the observed BTC breakout exits after a completed candle gives back most of a two-R-plus excursion", () => {
  const position: PaperPosition = { id: "btc-profit-rejection", symbol: "BTC_USDT", side: "SHORT", scenario: "BREAKOUT",
    entryAt: 45_000, entryPrice: 79_476.3, initialStop: 79_577.834, currentStop: 79_577.834,
    currentTarget: 78_609.1, plannedRisk: 10.66, notional: 3_462.81, targetScore: 20, status: "OPEN" };
  const closed = updatePosition(position, { now: 120_001, price: 79_441.1, bestTarget: zone("SHORT", 78_609.1),
    oppositeTarget: zone("LONG", 80_000), absorption: 0.1, confirmationMinute: 120_000,
    confirmationPrice: 79_441.1,
    confirmationCandle: { time: 60, open: 79_512.8, high: 79_543.5, low: 79_170, close: 79_441.1 } });
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.exitReason, "BREAKOUT_PROFIT_REJECTION");
  assert.equal(closed.maxFavorablePrice, 79_170);
  assert.ok((closed.realizedPnl ?? -Infinity) > -10.75);
});

test("a tightened stop is reported as dynamic protection instead of structural invalidation", () => {
  const position: PaperPosition = { id: "dynamic-stop", symbol: "BTC_USDT", side: "LONG", scenario: "BREAKOUT",
    entryAt: 1, entryPrice: 100, initialStop: 95, currentStop: 97.5, currentTarget: 115,
    plannedRisk: 10, notional: 1_000, targetScore: 20, status: "OPEN" };
  const stopped = updatePosition(position, { now: 180_001, price: 97.4, bestTarget: zone("LONG", 115),
    oppositeTarget: zone("SHORT", 90), absorption: 0 });
  assert.equal(stopped.exitReason, "DYNAMIC_PROTECTION_STOP");
});

test("a route position exits at its liquidity node when continuation is not confirmed", () => {
  const position: PaperPosition = { id: "node-exit", symbol: "BTC_USDT", side: "LONG", scenario: "BREAKOUT",
    entryAt: 1, entryPrice: 100, initialStop: 98, currentStop: 99, currentTarget: 110, plannedRisk: 10,
    notional: 1_000, targetScore: 20, targetIdentity: "HTF:LONG:110", routeId: "local-long",
    routeKind: "LOCAL_BREAKOUT", targetTimeframe: "4h", status: "OPEN" };
  const closed = updatePosition(position, { now: 2, price: 110, bestTarget: zone("LONG", 110),
    oppositeTarget: zone("SHORT", 95), absorption: 0.2, continuationRoute: null });
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.exitReason, "TARGET_NODE_EXIT");
});

test("a confirmed node continuation hands the position to the next liquidity target", () => {
  const position: PaperPosition = { id: "node-handoff", symbol: "BTC_USDT", side: "LONG", scenario: "BREAKOUT",
    entryAt: 1, entryPrice: 100, initialStop: 98, currentStop: 99, currentTarget: 110, plannedRisk: 10,
    notional: 1_000, targetScore: 20, targetIdentity: "HTF:LONG:110", routeId: "local-long",
    routeKind: "LOCAL_BREAKOUT", targetTimeframe: "4h", status: "OPEN" };
  const continuation: LiquidityRoute = { id: "node-long", symbol: "BTC_USDT", side: "LONG",
    kind: "NODE_CONTINUATION", stage: "AT_NODE", entryTrigger: 110.1, invalidation: 109.4,
    target: 118, targetIdentity: "HTF:LONG:118", targetTimeframe: "4h", nextTarget: null,
    confirmationScore: 0.7, fakeoutRisk: 0.3, activationDistanceRate: 0.004, score: 25,
    executableNow: true, reason: ["node confirmed"] };
  const continued = updatePosition(position, { now: 2, price: 110, bestTarget: zone("LONG", 110),
    oppositeTarget: zone("SHORT", 95), absorption: 0.2, continuationRoute: continuation });
  assert.equal(continued.status, "OPEN");
  assert.equal(continued.currentTarget, 118);
  assert.equal(continued.currentStop, 109.4);
  assert.equal(continued.routeId, "node-long");
  assert.equal(continued.routeKind, "NODE_CONTINUATION");
});

test("stale or sequence-fault data cancels only prepared plan and cannot close a position", () => {
  const decision = { symbol: "BNB_USDT", observedAt: 1, marketState: "RANGE" as const, side: "LONG" as const,
    entryTrigger: 95, invalidation: 93, target: 110, targetIdentity: "target", score: 2, oppositeScore: 1, reason: [] };
  const plan: PaperPlan = { ...decision, id: "p", state: "PREPARED", createdAt: 1, expiresAt: 99_999, plannedRisk: 10, notional: 1_000 };
  const position: PaperPosition = { id: "x", symbol: "BNB_USDT", side: "LONG", scenario: "RANGE", entryAt: 1, entryPrice: 100, initialStop: 95, currentStop: 95, currentTarget: 110, plannedRisk: 10, notional: 1_000, targetScore: 20, status: "OPEN" };
  const result = reconcilePaper({ now: 2, midpoint: 90, fresh: false, sequenceFault: false, decision: null, plan, position, zones: [], absorption: 0, equity: 1_000, openRisk: 10 });
  assert.equal(result.plan?.state, "CANCELLED");
  assert.equal(result.position?.status, "OPEN");
  assert.equal(usableSnapshot({ symbol: "X_USDT", observedAt: 9_000, sequence: 9, tickSize: 1, bids: [], asks: [] }, 10_001, 10, 10_000).sequenceFault, true);
});

test("crossing the frozen structural invalidation still cancels a prepared plan immediately", () => {
  const decision = { symbol: "BTC_USDT", observedAt: 1, marketState: "BREAKOUT" as const, side: "LONG" as const,
    entryTrigger: 101, invalidation: 99, target: 110, targetIdentity: "target", score: 20, oppositeScore: 1, reason: [] };
  const plan: PaperPlan = { ...decision, id: "invalid-before-entry", state: "PREPARED", createdAt: 1,
    expiresAt: PLAN_TTL_MS + 1, plannedRisk: 10, notional: 1_000 };
  const result = reconcilePaper({ now: 2, midpoint: 98.9, fresh: true, sequenceFault: false, decision: null,
    plan, position: null, zones: [zone("LONG", 110)], absorption: 0, equity: 1_000, openRisk: 0 });
  assert.equal(result.plan?.state, "CANCELLED");
  assert.deepEqual(result.events, ["PRE_ENTRY_INVALIDATION_CANCEL"]);
});

test("a vanished target needs two distinct completed-minute confirmations", () => {
  const decision = { symbol: "BTC_USDT", observedAt: 1, marketState: "BREAKOUT" as const, side: "LONG" as const,
    entryTrigger: 101, invalidation: 99, target: 110, targetIdentity: "old-target", score: 2, oppositeScore: 1, reason: [] };
  const plan: PaperPlan = { ...decision, id: "gone", state: "PREPARED", createdAt: 1, expiresAt: PLAN_TTL_MS + 1, plannedRisk: 10, notional: 1_000 };
  const first = reconcilePaper({ now: 60_001, midpoint: 100, fresh: true, sequenceFault: false, decision: null, plan,
    position: null, zones: [], absorption: 0, confirmationMinute: 60_000, equity: 1_000, openRisk: 0 });
  assert.equal(first.plan?.state, "PREPARED");
  assert.equal(first.plan?.invalidationSignalCount, 1);
  const duplicate = reconcilePaper({ now: 61_001, midpoint: 100, fresh: true, sequenceFault: false, decision: null,
    plan: first.plan, position: null, zones: [], absorption: 0, confirmationMinute: 60_000, equity: 1_000, openRisk: 0 });
  assert.equal(duplicate.plan?.invalidationSignalCount, 1);
  const cancelled = reconcilePaper({ now: 120_001, midpoint: 100, fresh: true, sequenceFault: false, decision: null,
    plan: duplicate.plan, position: null, zones: [], absorption: 0, confirmationMinute: 120_000, equity: 1_000, openRisk: 0 });
  assert.equal(cancelled.plan?.state, "CANCELLED");
  assert.deepEqual(cancelled.events, ["TARGET_GONE_CANCEL"]);
});

test("a replacement decision neither replaces nor instantly cancels the frozen thesis", () => {
  const oldDecision = { symbol: "BTC_USDT", observedAt: 1, marketState: "RANGE" as const, side: "LONG" as const,
    entryTrigger: 95, invalidation: 93, target: 110, targetIdentity: "old-target", score: 2, oppositeScore: 1, reason: [] };
  const plan: PaperPlan = { ...oldDecision, id: "old", state: "PREPARED", createdAt: 1, expiresAt: 9_999, plannedRisk: 10, notional: 1_000 };
  const changed = { ...oldDecision, target: 112, score: oldDecision.score * 1.3 };
  const result = reconcilePaper({ now: 2, midpoint: 100, fresh: true, sequenceFault: false, decision: changed, plan, position: null,
    zones: [zone("LONG", 112), zone("SHORT", 90)], absorption: 0, equity: 1_000, openRisk: 0 });
  assert.equal(result.plan?.state, "PREPARED");
  assert.equal(result.plan?.id, "old");
  assert.equal(result.plan?.target, 110);
  assert.deepEqual(result.events, []);
});

test("a prepared plan survives neutral ticks without chasing recalculated levels", () => {
  const decision = { symbol: "BTC_USDT", observedAt: 1, marketState: "BREAKOUT" as const, side: "LONG" as const,
    entryTrigger: 101, invalidation: 99, target: 110, targetIdentity: "BOOK:LONG:110", score: 2, oppositeScore: 1, reason: [] };
  const plan: PaperPlan = { ...decision, id: "frozen", state: "PREPARED", createdAt: 1, expiresAt: PLAN_TTL_MS + 1, plannedRisk: 10, notional: 1_000 };
  const neutral = reconcilePaper({ now: 2, midpoint: 100, fresh: true, sequenceFault: false, decision: null, plan, position: null,
    zones: [zone("LONG", 110), zone("SHORT", 90)], absorption: 0, equity: 1_000, openRisk: 0 });
  assert.equal(neutral.plan?.state, "PREPARED");
  assert.equal(neutral.plan?.entryTrigger, 101);
  assert.deepEqual(neutral.events, []);
});

test("a frozen prepared plan can trigger during a neutral tick", () => {
  const decision = { symbol: "BTC_USDT", observedAt: 1, marketState: "BREAKOUT" as const, side: "LONG" as const,
    entryTrigger: 101, invalidation: 99, target: 110, targetIdentity: "BOOK:LONG:110", score: 100, oppositeScore: 1, reason: [] };
  const plan: PaperPlan = { ...decision, id: "cross", state: "PREPARED", createdAt: 1, expiresAt: PLAN_TTL_MS + 1, plannedRisk: 10, notional: 1_000 };
  const result = reconcilePaper({ now: 2, midpoint: 101.1, fresh: true, sequenceFault: false, decision: null, plan, position: null,
    zones: [zone("LONG", 110), zone("SHORT", 90)], absorption: 0, equity: 1_000, openRisk: 0 });
  assert.equal(result.plan?.state, "TRIGGERED");
  assert.equal(result.position?.status, "OPEN");
  assert.ok(result.events.includes("PAPER_OPEN"));
});

test("an opposite recalculation cannot replace a frozen prepared plan", () => {
  const shortDecision = { symbol: "SOL_USDT", observedAt: 1, marketState: "RANGE" as const, side: "SHORT" as const,
    entryTrigger: 101, invalidation: 102, target: 95, targetIdentity: "BOOK:SHORT:95", score: 10, oppositeScore: 1, reason: [] };
  const plan: PaperPlan = { ...shortDecision, id: "short-frozen", state: "PREPARED", createdAt: 1,
    expiresAt: PLAN_TTL_MS + 1, plannedRisk: 10, notional: 1_000 };
  const longDecision = { ...shortDecision, side: "LONG" as const, entryTrigger: 99, invalidation: 98,
    target: 110, targetIdentity: "BOOK:LONG:110", score: 100 };
  const result = reconcilePaper({ now: 2, midpoint: 100.9, fresh: true, sequenceFault: false, decision: longDecision,
    plan, position: null, zones: [zone("SHORT", 95), zone("LONG", 110)], absorption: 0, equity: 1_000,
    openRisk: 0, allowOpen: false });
  assert.equal(result.plan?.id, "short-frozen");
  assert.equal(result.plan?.side, "SHORT");
  assert.equal(result.plan?.entryTrigger, 101);
  assert.equal(result.plan?.state, "PREPARED");
  assert.deepEqual(result.events, []);
});

test("a trigger crossing cannot override a vanished frozen target", () => {
  const shortDecision = { symbol: "SOL_USDT", observedAt: 1, marketState: "RANGE" as const, side: "SHORT" as const,
    entryTrigger: 101, invalidation: 102, target: 95, targetIdentity: "BOOK:SHORT:95", score: 100, oppositeScore: 1, reason: [] };
  const plan: PaperPlan = { ...shortDecision, id: "short-cross", state: "PREPARED", createdAt: 1,
    expiresAt: PLAN_TTL_MS + 1, plannedRisk: 10, notional: 1_000 };
  const longDecision = { ...shortDecision, side: "LONG" as const, entryTrigger: 99, invalidation: 98,
    target: 110, targetIdentity: "BOOK:LONG:110", score: 1_000 };
  const warned = reconcilePaper({ now: 60_001, midpoint: 100.5, fresh: true, sequenceFault: false, decision: longDecision,
    plan, position: null, zones: [zone("LONG", 110)], absorption: 0, confirmationMinute: 60_000,
    equity: 1_000, openRisk: 0, allowOpen: false });
  assert.equal(warned.plan?.state, "PREPARED");
  const firstPass = reconcilePaper({ now: 120_001, midpoint: 101.1, fresh: true, sequenceFault: false, decision: longDecision,
    plan: warned.plan, position: null, zones: [zone("LONG", 110)], absorption: 0, confirmationMinute: 120_000,
    equity: 1_000, openRisk: 0, allowOpen: true });
  assert.equal(firstPass.plan?.id, "short-cross");
  assert.equal(firstPass.plan?.state, "CANCELLED");
  assert.equal(firstPass.position, null);
  assert.deepEqual(firstPass.events, ["TARGET_GONE_CANCEL"]);
});

test("an economically untradeable target is rejected before it reaches the order page", () => {
  const decision = { symbol: "SOL_USDT", observedAt: 1, marketState: "BREAKOUT" as const, side: "LONG" as const,
    entryTrigger: 100, invalidation: 99.9, target: 100.1, targetIdentity: "BOOK:LONG:100.1", score: 100, oppositeScore: 0.1, reason: [] };
  const result = reconcilePaper({ now: 2, midpoint: 99.9, fresh: true, sequenceFault: false, decision, plan: null, position: null,
    zones: [zone("LONG", 100.1), zone("SHORT", 90)], absorption: 0, equity: 1_000, openRisk: 0, allowOpen: false });
  assert.equal(result.plan, null);
  assert.ok(result.events.includes("PLAN_REJECTED_ECONOMICS"));
});

test("trade economics require at least 1.2R after round-trip costs", () => {
  assert.equal(MIN_NET_REWARD_RISK, 1.2);
  const weak = tradeEconomics({ entry: 100, target: 100.4, lossRate: 0.003, confidence: 0.8, notional: 4_000, equity: 1_000 });
  assert.ok(weak.netRewardRisk < MIN_NET_REWARD_RISK);
  assert.equal(weak.executable, false);
  const healthy = tradeEconomics({ entry: 100, target: 101, lossRate: 0.003, confidence: 0.8, notional: 4_000, equity: 1_000 });
  assert.ok(healthy.netRewardRisk > MIN_NET_REWARD_RISK);
  assert.ok(healthy.netTargetProfit >= 15);
  assert.equal(healthy.executable, true);
});

test("a mathematically acceptable R multiple is still rejected when its net profit is immaterial", () => {
  const result = tradeEconomics({ entry: 100, target: 100.6, lossRate: 0.003, confidence: 0.8, notional: 1_000, equity: 1_000 });
  assert.ok(result.netRewardRisk >= MIN_NET_REWARD_RISK);
  assert.ok(result.netTargetProfit < result.minimumNetTargetProfit);
  assert.equal(result.executable, false);
});

test("a frozen range entry is not vetoed by one transient absorption dip", () => {
  const decision = { symbol: "SOL_USDT", observedAt: 1, marketState: "RANGE" as const, side: "SHORT" as const,
    entryTrigger: 101, invalidation: 102, target: 95, targetIdentity: "BOOK:SHORT:95", score: 100, oppositeScore: 1, reason: [] };
  const plan: PaperPlan = { ...decision, id: "range-without-absorption", state: "PREPARED", createdAt: 1,
    expiresAt: PLAN_TTL_MS + 1, plannedRisk: 10, notional: 1_000 };
  const result = reconcilePaper({ now: 2, midpoint: 101.1, fresh: true, sequenceFault: false, decision: null,
    plan, position: null, zones: [zone("SHORT", 95), zone("LONG", 110)], absorption: 0.2, equity: 1_000,
    openRisk: 0, allowOpen: true });
  assert.equal(result.plan?.state, "TRIGGERED");
  assert.equal(result.position?.status, "OPEN");
  assert.ok(result.events.includes("PAPER_OPEN"));
});

test("new executable plans remain valid for fifteen minutes", () => {
  const decision = { symbol: "ETH_USDT", observedAt: 1, marketState: "BREAKOUT" as const, side: "LONG" as const,
    entryTrigger: 101, invalidation: 99, target: 110, targetIdentity: "BOOK:LONG:110", score: 100, oppositeScore: 1, reason: [] };
  const result = reconcilePaper({ now: 10, midpoint: 100, fresh: true, sequenceFault: false, decision, plan: null, position: null,
    zones: [zone("LONG", 110), zone("SHORT", 90)], absorption: 0, equity: 1_000, openRisk: 0, allowOpen: false });
  assert.equal(result.plan?.expiresAt, 10 + PLAN_TTL_MS);
});

test("jump trigger recalculates actual-fill notional and keeps aggregate risk at five percent", () => {
  const decision = decideThreeState({ symbol: "BTC_USDT", observedAt: 1, mid: 100, zones: [zone("LONG", 110, 2), zone("SHORT", 90)], bands: [band("LONG", 105, 2), band("LONG", 106, 2)], flow: flow({ ofi: 0.8 }), absorption: 0.1 })!;
  const plan: PaperPlan = { ...decision, id: "gap", state: "PREPARED", createdAt: 1, expiresAt: 9_999, plannedRisk: 15, notional: 1_000 };
  const result = reconcilePaper({ now: 2, midpoint: decision.entryTrigger + 3, fresh: true, sequenceFault: false, decision, plan, position: null, zones: [zone("LONG", 110), zone("SHORT", 90)], absorption: 0.1, equity: 1_000, openRisk: 20 });
  assert.equal(result.position?.status, "OPEN");
  assert.ok(20 + (result.position?.plannedRisk ?? 99) <= 50);
});

test("a jump beyond the target is cancelled on economics, never opened", () => {
  const decision = decideThreeState({ symbol: "BTC_USDT", observedAt: 1, mid: 100, zones: [zone("LONG", 110, 2), zone("SHORT", 90)], bands: [band("LONG", 105, 2), band("LONG", 106, 2)], flow: flow({ ofi: 0.8 }), absorption: 0.1 })!;
  const plan: PaperPlan = { ...decision, id: "too-late", state: "PREPARED", createdAt: 1, expiresAt: 9_999, plannedRisk: 10, notional: 1_000 };
  const result = reconcilePaper({ now: 2, midpoint: 111, fresh: true, sequenceFault: false, decision, plan, position: null,
    zones: [zone("LONG", 110), zone("SHORT", 90)], absorption: 0, equity: 1_000, openRisk: 0 });
  assert.equal(result.position, null);
  assert.ok(result.events.includes("GAP_ECONOMICS_CANCEL"));
});

test("confidence and actual-fill sizing are invariant to utility score scale", () => {
  const make = (scale: number) => {
    const decision = { symbol: "X_USDT", observedAt: 1, marketState: "BREAKOUT" as const, side: "LONG" as const,
      entryTrigger: 101, invalidation: 98, target: 110, targetIdentity: "BOOK:LONG:110", score: 0.02 * scale, oppositeScore: 0.01 * scale, reason: [] };
    const plan: PaperPlan = { ...decision, id: `scale-${scale}`, state: "PREPARED", createdAt: 1, expiresAt: 99, plannedRisk: 10, notional: 1_000 };
    return reconcilePaper({ now: 2, midpoint: 102, fresh: true, sequenceFault: false, decision, plan, position: null,
      zones: [zone("LONG", 110), zone("SHORT", 90)], absorption: 0, equity: 1_000, openRisk: 0 }).position?.notional;
  };
  assert.ok(Math.abs((make(1) ?? 0) - (make(10) ?? 0)) < 1e-9);
});

test("a structural stop blocks the same route until two completed minutes rebuild and reclaim it", () => {
  const decision = { symbol: "SOL_USDT", observedAt: 1, marketState: "RANGE" as const, side: "LONG" as const,
    entryTrigger: 100, invalidation: 99.8, target: 101, targetIdentity: "RANGE_SEGMENT:LONG:101",
    score: 2, oppositeScore: 1, reason: [], routeId: "same-range-long", routeKind: "EDGE_REJECTION" as const };
  const stopped: PaperPosition = { id: "stopped", symbol: "SOL_USDT", side: "LONG", scenario: "RANGE",
    entryAt: 1, entryPrice: 100, initialStop: 99.8, currentStop: 99.8, currentTarget: 101,
    plannedRisk: 10, notional: 3_000, targetScore: 2, targetIdentity: decision.targetIdentity,
    routeId: decision.routeId, routeKind: "EDGE_REJECTION", status: "CLOSED", exitAt: 61_000,
    exitPrice: 99.79, exitReason: "STRUCTURAL_STOP", realizedPnl: -10 };
  const blocked = reconcilePaper({ now: 62_000, midpoint: 99.95, fresh: true, sequenceFault: false, decision,
    plan: null, position: stopped, zones: [], absorption: 0.8, confirmationMinute: 120_000,
    confirmationPrice: 99.95, equity: 1_000, openRisk: 0, allowOpen: false });
  assert.equal(blocked.plan, null);
  assert.ok(blocked.events.includes("WAIT_STRUCTURE_REBUILD"));
  const rebuilt = reconcilePaper({ now: 180_001, midpoint: 100.1, fresh: true, sequenceFault: false, decision,
    plan: null, position: stopped, zones: [], absorption: 0.8, confirmationMinute: 180_000,
    confirmationPrice: 100.1, equity: 1_000, openRisk: 0, allowOpen: false });
  assert.equal(rebuilt.plan?.state, "PREPARED");
});

test("an expired plan is not rebuilt in the same reconciliation", () => {
  const decision = { symbol: "X_USDT", observedAt: 1, marketState: "BREAKOUT" as const, side: "LONG" as const,
    entryTrigger: 101, invalidation: 98, target: 110, targetIdentity: "BOOK:LONG:110", score: 2, oppositeScore: 1, reason: [] };
  const plan: PaperPlan = { ...decision, id: "expired", state: "PREPARED", createdAt: 1, expiresAt: 1, plannedRisk: 10, notional: 1_000 };
  const result = reconcilePaper({ now: 2, midpoint: 100, fresh: true, sequenceFault: false, decision, plan, position: null,
    zones: [zone("LONG", 110), zone("SHORT", 90)], absorption: 0, equity: 1_000, openRisk: 0 });
  assert.equal(result.plan?.id, "expired");
  assert.equal(result.plan?.state, "CANCELLED");
});

test("position outbox keeps the latest complete authority snapshot and retries it", async () => {
  const open: PaperPosition = { id: "o", symbol: "BTC_USDT", side: "LONG", scenario: "BREAKOUT", entryAt: 1, entryPrice: 100, initialStop: 95, currentStop: 95, currentTarget: 110, plannedRisk: 10, notional: 1_000, targetScore: 1, status: "OPEN" };
  const closed: PaperPosition = { ...open, status: "CLOSED", exitAt: 2, exitPrice: 110, realizedPnl: 98.2 };
  const entryCandles = [{ time: 1, open: 99, high: 101, low: 98, close: 100, volume: 7 }];
  let outbox = enqueuePositionTransition([], null, open, 1_000, 0, entryCandles);
  outbox = enqueuePositionTransition(outbox, open, closed);
  outbox = enqueuePositionTransition(outbox, open, closed);
  assert.deepEqual(outbox[0].entryCandles, entryCandles);
  let fail = true; const writes: string[] = [];
  outbox = await drainPositionOutbox(outbox, async ({ position }) => { if (fail) { fail = false; throw new Error("D1 down"); } writes.push(position.status); });
  assert.equal(outbox.length, 1);
  outbox = await drainPositionOutbox(outbox, async ({ position }) => { writes.push(position.status); });
  assert.deepEqual(writes, ["CLOSED"]);
  assert.equal(outbox.length, 0);
});

test("multi-scale repeated extremes and volume edges create compressed stop pools", () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({ volume: index % 9 === 0 ? 100 : 10, close: 100, high: index % 5 === 2 ? 105 : 101, low: index % 5 === 2 ? 95 : 99 }));
  const zones = deriveStructureZones(rows, "1h", 100);
  assert.ok(zones.some((item) => item.source === "STOP_POOL" && item.side === "LONG"));
  assert.ok(zones.some((item) => item.source === "STOP_POOL" && item.side === "SHORT"));
  assert.deepEqual(deriveStructureZones(rows, "1h", 100.01).map((item) => item.identity), zones.map((item) => item.identity));
});

test("OI cohorts allocate by current price/taker direction and shrink as OI falls", () => {
  const memory = emptySymbolMemory();
  memory.lastMid = 100; memory.quantoMultiplier = 0.01; memory.lastOpenInterest = 1_000; memory.midpoints = [99, 100]; memory.flow.takerDelta = 0.5;
  updateOpenInterestCohorts(memory, 1_100);
  assert.ok(memory.longCohortNotional > 0);
  assert.ok(memory.shortCohortNotional > 0, "OI growth is paired and cannot be assigned 100% to one side");
  memory.lastMid = 110; memory.midpoints = [109, 110]; memory.flow.takerDelta = -0.8;
  updateOpenInterestCohorts(memory, 1_200);
  assert.equal(memory.oiCohorts.length, 2);
  const snapshot = { symbol: "BTC_USDT", observedAt: 1, sequence: 1, tickSize: 0.1,
    bids: Array.from({ length: 50 }, (_, index) => ({ price: 109 - index, size: 1_000 })),
    asks: Array.from({ length: 50 }, (_, index) => ({ price: 111 + index, size: 1_000 })) };
  const levels = inferLiquidationBands(memory, snapshot);
  assert.ok(new Set(levels.map((item) => item.price)).size > 8, "different entry bins must project different liquidation levels");
  const before = memory.longCohortNotional;
  updateOpenInterestCohorts(memory, 990);
  assert.ok(memory.longCohortNotional < before);
});

test("HTTP 200 data with an old timestamp stays stale and a clear REST sequence epoch reset is accepted", () => {
  const stale = usableSnapshot({ symbol: "X_USDT", observedAt: 1_000, sequence: 101, tickSize: 1, bids: [], asks: [] }, 5_001, 100, 900);
  assert.equal(stale.fresh, false);
  const future = usableSnapshot({ symbol: "X_USDT", observedAt: 20_000, sequence: 102, tickSize: 1, bids: [], asks: [] }, 10_000, 101, 9_000);
  assert.equal(future.fresh, false);
  const unchanged = usableSnapshot({ symbol: "X_USDT", observedAt: 10_000, sequence: 100, tickSize: 1, bids: [], asks: [] }, 10_001, 100, 10_000);
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.sequenceFault, false);
  const sameMillisecondAdvance = usableSnapshot({ symbol: "X_USDT", observedAt: 10_000, sequence: 101, tickSize: 1, bids: [], asks: [] }, 10_001, 100, 10_000);
  assert.equal(sameMillisecondAdvance.advanced, true);
  assert.equal(sameMillisecondAdvance.sequenceFault, false);
  const reset = usableSnapshot({ symbol: "X_USDT", observedAt: 12_000, sequence: 10, tickSize: 1, bids: [], asks: [] }, 12_001, 100, 10_000);
  assert.equal(reset.sequenceReset, true);
  assert.equal(reset.sequenceFault, false);
});

test("exchange freshness uses actual invocation time, never the two-second slot floor", () => {
  const snapshot = { symbol: "X_USDT", observedAt: 10_350, sequence: 1, tickSize: 1, bids: [], asks: [] };
  assert.equal(usableSnapshot(snapshot, 10_400, 0).fresh, true);
  assert.equal(usableSnapshot(snapshot, 8_000, 0).fresh, false);
});

test("independent ancillary cursor covers every symbol and evidence kind", () => {
  const symbols = ["A", "B", "C", "D"];
  const seen = new Set(Array.from({ length: 20 }, (_, cursor) => {
    const value = ancillarySchedule(cursor, symbols)!;
    return `${value.symbol}:${value.feature}`;
  }));
  assert.equal(seen.size, 20);
});

test("remaining structural stress risk falls as a persisted stop tightens", () => {
  const base: PaperPosition = { id: "risk", symbol: "X", side: "LONG", scenario: "BREAKOUT", entryAt: 1, entryPrice: 100,
    initialStop: 95, currentStop: 95, currentTarget: 110, plannedRisk: 50, notional: 1_000, targetScore: 1, status: "OPEN" };
  assert.ok(remainingStressRisk({ ...base, currentStop: 99 }, 100) < remainingStressRisk(base, 100));
  const equityAfterLoss = 800;
  const remaining = remainingStressRisk({ ...base, currentStop: 98.2 }, 100);
  assert.ok(remaining <= equityAfterLoss * 0.05);
});

test("higher timeframe vetoes an opposing reversal and exact balance waits", () => {
  const near = [zone("LONG", 100.3), zone("SHORT", 99.7)];
  const reversal = decideThreeState({ symbol: "X", observedAt: 1, mid: 100, zones: near, bands: [],
    flow: flow({ ofi: 0.8, takerDelta: 0.8, priceResponseBps: 0 }), absorption: 0.9,
    timeframeBias: { m1: "DOWN", m15: "DOWN", h1: "UP" } });
  assert.equal(reversal, null);
  assert.equal(decideThreeState({ symbol: "X", observedAt: 1, mid: 100, zones: [zone("LONG", 110), zone("SHORT", 90)], bands: [], flow: flow(), absorption: 0 }), null);
});

test("a missing target exits only after protection time, adverse price, and three completed minutes", () => {
  const position: PaperPosition = { id: "gone", symbol: "SOL_USDT", side: "LONG", scenario: "BREAKOUT", entryAt: 1, entryPrice: 100,
    initialStop: 95, currentStop: 95, currentTarget: 110, plannedRisk: 10, notional: 1_000, targetScore: 20, status: "OPEN" };
  const first = updatePosition(position, { now: 60_001, price: 98, bestTarget: null, oppositeTarget: zone("SHORT", 90), absorption: 0, confirmationMinute: 60_000 });
  assert.equal(first.status, "OPEN");
  assert.equal(first.exitSignalCount, 1);
  const duplicate = updatePosition(first, { now: 61_001, price: 98, bestTarget: null, oppositeTarget: zone("SHORT", 90), absorption: 0, confirmationMinute: 60_000 });
  assert.equal(duplicate.status, "OPEN");
  assert.equal(duplicate.exitSignalCount, 1);
  const second = updatePosition(duplicate, { now: 120_001, price: 98, bestTarget: null, oppositeTarget: zone("SHORT", 90), absorption: 0, confirmationMinute: 120_000 });
  assert.equal(second.status, "OPEN");
  assert.equal(second.exitSignalCount, 2);
  const closed = updatePosition(second, { now: 180_001, price: 98, bestTarget: null, oppositeTarget: zone("SHORT", 90), absorption: 0, confirmationMinute: 180_000 });
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.exitReason, "TARGET_DISAPPEARED");
});

test("three soft warnings cannot close a position while price still confirms its direction", () => {
  const position: PaperPosition = { id: "profitable", symbol: "BTC_USDT", side: "SHORT", scenario: "BREAKOUT", entryAt: 1,
    entryPrice: 100, initialStop: 105, currentStop: 105, currentTarget: 90, plannedRisk: 10, notional: 1_000,
    targetScore: 20, status: "OPEN" };
  const first = updatePosition(position, { now: 60_001, price: 99, bestTarget: null, oppositeTarget: zone("LONG", 110), absorption: 0, confirmationMinute: 60_000 });
  const second = updatePosition(first, { now: 120_001, price: 98.5, bestTarget: null, oppositeTarget: zone("LONG", 110), absorption: 0, confirmationMinute: 120_000 });
  const third = updatePosition(second, { now: 180_001, price: 98, bestTarget: null, oppositeTarget: zone("LONG", 110), absorption: 0, confirmationMinute: 180_000 });
  assert.equal(third.status, "OPEN");
  assert.equal(third.exitSignalCount, 3);
});

test("a one-minute opposite-utility spike clears instead of forcing an exit", () => {
  const position: PaperPosition = { id: "noise", symbol: "BTC_USDT", side: "SHORT", scenario: "BREAKOUT", entryAt: 1, entryPrice: 100,
    initialStop: 105, currentStop: 105, currentTarget: 90, plannedRisk: 10, notional: 1_000, targetScore: 20, status: "OPEN" };
  const warned = updatePosition(position, { now: 60_001, price: 99, bestTarget: zone("SHORT", 90, 1), oppositeTarget: zone("LONG", 110, 40), absorption: 0, confirmationMinute: 60_000 });
  assert.equal(warned.status, "OPEN");
  assert.equal(warned.exitSignalCount, 1);
  const recovered = updatePosition(warned, { now: 120_001, price: 98, bestTarget: zone("SHORT", 90, 1), oppositeTarget: zone("LONG", 110, 1), absorption: 0, confirmationMinute: 120_000 });
  assert.equal(recovered.status, "OPEN");
  assert.equal(recovered.exitSignalCount, 0);
  assert.equal(recovered.exitSignalReason, undefined);
});

test("sequence-reset warmup keeps an open position under structural-stop-only protection", () => {
  const position: PaperPosition = { id: "warm", symbol: "SOL_USDT", side: "LONG", scenario: "BREAKOUT", entryAt: 1, entryPrice: 100,
    initialStop: 95, currentStop: 95, currentTarget: 110, plannedRisk: 10, notional: 1_000, targetScore: 20, status: "OPEN" };
  const held = reconcilePaper({ now: 2, midpoint: 100, fresh: true, sequenceFault: false, decision: null, plan: null, position,
    zones: [], absorption: 0, equity: 1_000, openRisk: 10, protectOnly: true, allowOpen: false });
  assert.equal(held.position?.status, "OPEN");
  const stopped = reconcilePaper({ now: 3, midpoint: 94, fresh: true, sequenceFault: false, decision: null, plan: null, position,
    zones: [], absorption: 0, equity: 1_000, openRisk: 10, protectOnly: true, allowOpen: false });
  assert.equal(stopped.position?.exitReason, "STRUCTURAL_STOP");
});
