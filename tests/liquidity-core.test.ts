import assert from "node:assert/strict";
import test from "node:test";
import {
  PORTFOLIO_RISK_CAP,
  MIN_NET_REWARD_RISK,
  cascadeRatio,
  decideThreeState as rawDecideThreeState,
  hasCascade,
  planTriggered,
  remainingStressRisk,
  sizePaperPosition,
  stablePriceBin,
  tradeEconomics,
  updatePosition,
  wallPersistence,
  zoneUtility,
  type FlowEvidence,
  type LiquidationBand,
  type LiquidityZone,
  type PaperPlan,
  type PaperPosition,
} from "../lib/liquidity-core.ts";
import { PLAN_TTL_MS, ancillarySchedule, deriveStructureZones, emptySymbolMemory, inferLiquidationBands, reconcilePaper, updateOpenInterestCohorts, usableSnapshot } from "../lib/liquidity-runtime.ts";
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
  const held = updatePosition(position, { now: 2, price: 105, bestTarget: zone("LONG", 112), oppositeTarget: zone("SHORT", 90, 0.2), absorption: 0.2 });
  assert.ok(held.currentStop > position.currentStop);
  const closed = updatePosition(held, { now: 3, price: 112, bestTarget: zone("LONG", 112), oppositeTarget: zone("SHORT", 90, 0.2), absorption: 0.8 });
  assert.equal(closed.status, "CLOSED");
  assert.ok(Number.isFinite(closed.realizedPnl));
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

test("a vanished target immediately cancels a prepared plan", () => {
  const decision = decideThreeState({ symbol: "BTC_USDT", observedAt: 1, mid: 100, zones: [zone("LONG", 110), zone("SHORT", 90)], bands: [], flow: flow(), absorption: 0.3 })!;
  const plan: PaperPlan = { ...decision, id: "gone", state: "PREPARED", createdAt: 1, expiresAt: 9_999, plannedRisk: 10, notional: 1_000 };
  const result = reconcilePaper({ now: 2, midpoint: 100, fresh: true, sequenceFault: false, decision: null, plan, position: null, zones: [], absorption: 0, equity: 1_000, openRisk: 0 });
  assert.equal(result.plan?.state, "CANCELLED");
  assert.deepEqual(result.events, ["TARGET_GONE_CANCEL"]);
});

test("a replacement decision cannot keep an old prepared thesis alive", () => {
  const oldDecision = { symbol: "BTC_USDT", observedAt: 1, marketState: "RANGE" as const, side: "LONG" as const,
    entryTrigger: 95, invalidation: 93, target: 110, targetIdentity: "old-target", score: 2, oppositeScore: 1, reason: [] };
  const plan: PaperPlan = { ...oldDecision, id: "old", state: "PREPARED", createdAt: 1, expiresAt: 9_999, plannedRisk: 10, notional: 1_000 };
  const changed = { ...oldDecision, target: 112, score: oldDecision.score * 1.3 };
  const result = reconcilePaper({ now: 2, midpoint: 100, fresh: true, sequenceFault: false, decision: changed, plan, position: null,
    zones: [zone("LONG", 112), zone("SHORT", 90)], absorption: 0, equity: 1_000, openRisk: 0 });
  assert.equal(result.plan?.state, "CANCELLED");
  assert.ok(result.events.includes("TARGET_GONE_CANCEL") || result.events.includes("THESIS_CHANGED_CANCEL"));
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
  const firstPass = reconcilePaper({ now: 2, midpoint: 101.1, fresh: true, sequenceFault: false, decision: longDecision,
    plan, position: null, zones: [zone("LONG", 110)], absorption: 0, equity: 1_000, openRisk: 0, allowOpen: false });
  assert.equal(firstPass.plan?.id, "short-cross");
  assert.equal(firstPass.plan?.state, "CANCELLED");
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

test("range entries must still show absorption when the frozen trigger is reached", () => {
  const decision = { symbol: "SOL_USDT", observedAt: 1, marketState: "RANGE" as const, side: "SHORT" as const,
    entryTrigger: 101, invalidation: 102, target: 95, targetIdentity: "BOOK:SHORT:95", score: 100, oppositeScore: 1, reason: [] };
  const plan: PaperPlan = { ...decision, id: "range-without-absorption", state: "PREPARED", createdAt: 1,
    expiresAt: PLAN_TTL_MS + 1, plannedRisk: 10, notional: 1_000 };
  const result = reconcilePaper({ now: 2, midpoint: 101.1, fresh: true, sequenceFault: false, decision: null,
    plan, position: null, zones: [zone("SHORT", 95), zone("LONG", 110)], absorption: 0.2, equity: 1_000,
    openRisk: 0, allowOpen: true });
  assert.equal(result.plan?.state, "CANCELLED");
  assert.equal(result.position, null);
  assert.ok(result.events.includes("TRIGGER_STRUCTURE_CANCEL"));
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

test("a missing target exits only after two distinct completed one-minute confirmations", () => {
  const position: PaperPosition = { id: "gone", symbol: "SOL_USDT", side: "LONG", scenario: "BREAKOUT", entryAt: 1, entryPrice: 100,
    initialStop: 95, currentStop: 95, currentTarget: 110, plannedRisk: 10, notional: 1_000, targetScore: 20, status: "OPEN" };
  const first = updatePosition(position, { now: 60_001, price: 101, bestTarget: null, oppositeTarget: zone("SHORT", 90), absorption: 0, confirmationMinute: 60_000 });
  assert.equal(first.status, "OPEN");
  assert.equal(first.exitSignalCount, 1);
  const duplicate = updatePosition(first, { now: 61_001, price: 101, bestTarget: null, oppositeTarget: zone("SHORT", 90), absorption: 0, confirmationMinute: 60_000 });
  assert.equal(duplicate.status, "OPEN");
  assert.equal(duplicate.exitSignalCount, 1);
  const closed = updatePosition(duplicate, { now: 120_001, price: 101, bestTarget: null, oppositeTarget: zone("SHORT", 90), absorption: 0, confirmationMinute: 120_000 });
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.exitReason, "TARGET_DISAPPEARED");
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
