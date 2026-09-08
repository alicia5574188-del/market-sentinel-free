import type { RadarCandidate } from "./market-radar.ts";

export const REACTION_OBSERVATION_MS = 3 * 60_000;
export const REACTION_MAX_HOLD_MS = 20 * 60_000;
export const MAX_ACTIVE_REACTIONS = 36;
export const MAX_RECENT_REACTIONS = 160;
export const MAX_SEEN_REACTION_EVENTS = 512;

export type ReactionBranch = "CONTINUATION" | "REVERSAL";
export type ReactionOutcome = "TARGET_FIRST" | "STOP_FIRST" | "STALLED_EXIT" | "TIME_EXPIRED" | "NO_TRIGGER";
export type ReactionRoute = {
  branch: ReactionBranch;
  side: "LONG" | "SHORT";
  status: "WATCHING" | "OPEN" | "RESOLVED" | "NO_TRIGGER";
  conditionStreak: number;
  triggerAt: number | null;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  expiresAt: number | null;
  lastPrice: number;
  bestGrossReturnRate: number;
  worstGrossReturnRate: number;
  outcome: ReactionOutcome | null;
  resolvedAt: number | null;
  exitPrice: number | null;
  grossReturnRate: number | null;
  netReturnRate: number | null;
  feeCovered: boolean | null;
  profitableAfterCost: boolean | null;
};

export type ReactionExperiment = {
  id: string;
  eventId: string;
  symbol: string;
  impulseSide: "LONG" | "SHORT";
  kind: RadarCandidate["kind"];
  strength: number;
  confirmations: number;
  startedAt: number;
  observationExpiresAt: number;
  referencePrice: number;
  initialPrice: number;
  initialImpulseRate: number;
  extremePrice: number;
  lastPrice: number;
  retraceRatio: number;
  pullbackSeen: boolean;
  stopRate: number;
  targetRate: number;
  alignedFlow: number;
  continuation: ReactionRoute;
  reversal: ReactionRoute;
};

export type ReactionBranchStats = {
  opportunities: number;
  triggered: number;
  noTrigger: number;
  resolved: number;
  profitableAfterCost: number;
  feeCovered: number;
  targetFirst: number;
  stopFirst: number;
  stalledExit: number;
  timeExpired: number;
  netReturnRateSum: number;
};

export type ReactionLabState = {
  version: 1;
  startedAt: number;
  active: Record<string, ReactionExperiment>;
  recent: ReactionExperiment[];
  seenEventIds: string[];
  completed: number;
  dropped: number;
  stats: Record<ReactionBranch, ReactionBranchStats>;
};

const emptyStats = (): ReactionBranchStats => ({ opportunities: 0, triggered: 0, noTrigger: 0, resolved: 0,
  profitableAfterCost: 0, feeCovered: 0, targetFirst: 0, stopFirst: 0, stalledExit: 0, timeExpired: 0,
  netReturnRateSum: 0 });

export function initialReactionLab(now = Date.now()): ReactionLabState {
  return { version: 1, startedAt: now, active: {}, recent: [], seenEventIds: [], completed: 0, dropped: 0,
    stats: { CONTINUATION: emptyStats(), REVERSAL: emptyStats() } };
}

const direction = (side: "LONG" | "SHORT") => side === "LONG" ? 1 : -1;
const opposite = (side: "LONG" | "SHORT") => side === "LONG" ? "SHORT" as const : "LONG" as const;
const directionalReturn = (side: "LONG" | "SHORT", entry: number, price: number) =>
  direction(side) * (price - entry) / Math.max(entry, 1e-9);
const route = (branch: ReactionBranch, side: "LONG" | "SHORT", price: number): ReactionRoute => ({ branch, side,
  status: "WATCHING", conditionStreak: 0, triggerAt: null, entryPrice: null, stopPrice: null, targetPrice: null,
  expiresAt: null, lastPrice: price, bestGrossReturnRate: 0, worstGrossReturnRate: 0, outcome: null,
  resolvedAt: null, exitPrice: null, grossReturnRate: null, netReturnRate: null, feeCovered: null,
  profitableAfterCost: null });

export function recordReactionEvent(input: { state: ReactionLabState; candidate: RadarCandidate; midpoint: number;
  stopRate: number; targetRate: number; now: number }) {
  if (input.state.seenEventIds.includes(input.candidate.id)) return input.state;
  if (Object.values(input.state.active).some((item) => item.symbol === input.candidate.symbol
    && (item.continuation.status === "WATCHING" || item.reversal.status === "WATCHING"))) return input.state;
  const seenEventIds = [...input.state.seenEventIds, input.candidate.id].slice(-MAX_SEEN_REACTION_EVENTS);
  if (Object.keys(input.state.active).length >= MAX_ACTIVE_REACTIONS) return { ...input.state, seenEventIds,
    dropped: input.state.dropped + 1 };
  const d = direction(input.candidate.side);
  const inferredReference = input.midpoint / Math.max(0.01, 1 + d * input.candidate.moveRate);
  const referencePrice = input.candidate.referencePrice > 0 ? input.candidate.referencePrice : inferredReference;
  const initialImpulseRate = Math.max(0.001, Math.abs(input.midpoint - referencePrice) / Math.max(referencePrice, 1e-9),
    Math.abs(input.candidate.moveRate));
  const experiment: ReactionExperiment = { id: `reaction:${input.candidate.id}`, eventId: input.candidate.id,
    symbol: input.candidate.symbol, impulseSide: input.candidate.side, kind: input.candidate.kind,
    strength: input.candidate.strength, confirmations: input.candidate.confirmations, startedAt: input.now,
    observationExpiresAt: input.now + REACTION_OBSERVATION_MS, referencePrice, initialPrice: input.midpoint,
    initialImpulseRate, extremePrice: input.midpoint, lastPrice: input.midpoint, retraceRatio: 0, pullbackSeen: false,
    stopRate: input.stopRate, targetRate: input.targetRate, alignedFlow: 0,
    continuation: route("CONTINUATION", input.candidate.side, input.midpoint),
    reversal: route("REVERSAL", opposite(input.candidate.side), input.midpoint) };
  return { ...input.state, active: { ...input.state.active, [experiment.id]: experiment }, seenEventIds,
    stats: { CONTINUATION: { ...input.state.stats.CONTINUATION, opportunities: input.state.stats.CONTINUATION.opportunities + 1 },
      REVERSAL: { ...input.state.stats.REVERSAL, opportunities: input.state.stats.REVERSAL.opportunities + 1 } } };
}

function openRoute(routeBefore: ReactionRoute, price: number, stopRate: number, targetRate: number, now: number) {
  const d = direction(routeBefore.side);
  return { ...routeBefore, status: "OPEN" as const, triggerAt: now, entryPrice: price,
    stopPrice: price * (1 - d * stopRate), targetPrice: price * (1 + d * targetRate),
    expiresAt: now + REACTION_MAX_HOLD_MS, lastPrice: price, conditionStreak: 2 };
}

function expireWatching(state: ReactionLabState, experiment: ReactionExperiment) {
  let next = state;
  const expire = (branch: ReactionBranch, before: ReactionRoute) => {
    if (before.status !== "WATCHING") return before;
    next = { ...next, stats: { ...next.stats, [branch]: { ...next.stats[branch], noTrigger: next.stats[branch].noTrigger + 1 } } };
    return { ...before, status: "NO_TRIGGER" as const, outcome: "NO_TRIGGER" as const };
  };
  const continuation = expire("CONTINUATION", experiment.continuation);
  const reversal = expire("REVERSAL", experiment.reversal);
  return { state: next, experiment: { ...experiment, continuation, reversal } };
}

function finishExperimentIfDone(state: ReactionLabState, experiment: ReactionExperiment) {
  const terminal = (item: ReactionRoute) => item.status === "RESOLVED" || item.status === "NO_TRIGGER";
  if (!terminal(experiment.continuation) || !terminal(experiment.reversal)) {
    return { ...state, active: { ...state.active, [experiment.id]: experiment } };
  }
  const active = { ...state.active };
  delete active[experiment.id];
  return { ...state, active, recent: [...state.recent, experiment].slice(-MAX_RECENT_REACTIONS), completed: state.completed + 1 };
}

export function observeReaction(input: { state: ReactionLabState; experimentId: string; midpoint: number;
  alignedFlow: number; now: number; roundTripFrictionRate?: number }) {
  const prior = input.state.active[input.experimentId];
  if (!prior || !(input.midpoint > 0)) return input.state;
  const d = direction(prior.impulseSide);
  const extremePrice = d > 0 ? Math.max(prior.extremePrice, input.midpoint) : Math.min(prior.extremePrice, input.midpoint);
  const impulseDistance = Math.max(Math.abs(extremePrice - prior.referencePrice), prior.referencePrice * prior.initialImpulseRate);
  const retraceRatio = Math.max(0, d * (extremePrice - input.midpoint) / Math.max(impulseDistance, 1e-9));
  const pullbackSeen = prior.pullbackSeen || retraceRatio >= 0.2;
  const displacement = d * (input.midpoint - prior.referencePrice) / Math.max(prior.referencePrice, 1e-9);
  const step = d * (input.midpoint - prior.lastPrice) / Math.max(prior.lastPrice, 1e-9);
  let continuation = prior.continuation;
  let reversal = prior.reversal;
  let state = input.state;
  if (input.now < prior.observationExpiresAt && continuation.status === "WATCHING") {
    const met = pullbackSeen && retraceRatio <= 0.7 && displacement >= prior.initialImpulseRate * 0.35
      && input.alignedFlow >= 0.18 && step > 0;
    const conditionStreak = met ? continuation.conditionStreak + 1 : 0;
    continuation = { ...continuation, conditionStreak, lastPrice: input.midpoint };
    if (conditionStreak >= 2) {
      continuation = openRoute(continuation, input.midpoint, prior.stopRate, prior.targetRate, input.now);
      state = { ...state, stats: { ...state.stats, CONTINUATION: { ...state.stats.CONTINUATION,
        triggered: state.stats.CONTINUATION.triggered + 1 } } };
    }
  }
  if (input.now < prior.observationExpiresAt && reversal.status === "WATCHING") {
    const met = retraceRatio >= 0.7 && input.alignedFlow <= -0.18 && step < 0;
    const conditionStreak = met ? reversal.conditionStreak + 1 : 0;
    reversal = { ...reversal, conditionStreak, lastPrice: input.midpoint };
    if (conditionStreak >= 2) {
      reversal = openRoute(reversal, input.midpoint, prior.stopRate, prior.targetRate, input.now);
      state = { ...state, stats: { ...state.stats, REVERSAL: { ...state.stats.REVERSAL,
        triggered: state.stats.REVERSAL.triggered + 1 } } };
    }
  }
  let experiment = { ...prior, extremePrice, lastPrice: input.midpoint, retraceRatio, pullbackSeen,
    alignedFlow: input.alignedFlow, continuation, reversal };
  const continuationResult = resolveRoute(state, "CONTINUATION", experiment.continuation, input.midpoint, input.now,
    input.roundTripFrictionRate ?? 0.0018);
  state = continuationResult.state;
  const reversalResult = resolveRoute(state, "REVERSAL", experiment.reversal, input.midpoint, input.now,
    input.roundTripFrictionRate ?? 0.0018);
  state = reversalResult.state;
  experiment = { ...experiment, continuation: continuationResult.route, reversal: reversalResult.route };
  if (input.now >= prior.observationExpiresAt) ({ state, experiment } = expireWatching(state, experiment));
  return finishExperimentIfDone(state, experiment);
}

function resolveRoute(state: ReactionLabState, branch: ReactionBranch, before: ReactionRoute, price: number,
  now: number, friction: number): { state: ReactionLabState; route: ReactionRoute } {
  if (before.status !== "OPEN" || before.entryPrice == null || before.stopPrice == null || before.targetPrice == null) {
    return { state, route: before };
  }
  const grossNow = directionalReturn(before.side, before.entryPrice, price);
  const best = Math.max(before.bestGrossReturnRate, grossNow);
  const worst = Math.min(before.worstGrossReturnRate, grossNow);
  const targetHit = before.side === "LONG" ? price >= before.targetPrice : price <= before.targetPrice;
  const stopHit = before.side === "LONG" ? price <= before.stopPrice : price >= before.stopPrice;
  const stalled = before.triggerAt != null && now - before.triggerAt >= 10 * 60_000
    && best < Math.abs(before.entryPrice - before.stopPrice) / before.entryPrice * 0.35
    && grossNow < Math.abs(before.entryPrice - before.stopPrice) / before.entryPrice * 0.15;
  const outcome: ReactionOutcome | null = targetHit ? "TARGET_FIRST" : stopHit ? "STOP_FIRST"
    : before.expiresAt != null && now >= before.expiresAt ? "TIME_EXPIRED" : stalled ? "STALLED_EXIT" : null;
  if (!outcome) return { state, route: { ...before, lastPrice: price, bestGrossReturnRate: best, worstGrossReturnRate: worst } };
  const net = grossNow - friction;
  const routeAfter = { ...before, status: "RESOLVED" as const, lastPrice: price, bestGrossReturnRate: best,
    worstGrossReturnRate: worst, outcome, resolvedAt: now, exitPrice: price, grossReturnRate: grossNow,
    netReturnRate: net, feeCovered: grossNow >= friction, profitableAfterCost: net > 0 };
  const stats = state.stats[branch];
  return { route: routeAfter, state: { ...state, stats: { ...state.stats, [branch]: { ...stats,
    resolved: stats.resolved + 1, profitableAfterCost: stats.profitableAfterCost + Number(net > 0),
    feeCovered: stats.feeCovered + Number(grossNow >= friction), targetFirst: stats.targetFirst + Number(outcome === "TARGET_FIRST"),
    stopFirst: stats.stopFirst + Number(outcome === "STOP_FIRST"), stalledExit: stats.stalledExit + Number(outcome === "STALLED_EXIT"),
    timeExpired: stats.timeExpired + Number(outcome === "TIME_EXPIRED"), netReturnRateSum: stats.netReturnRateSum + net } } } };
}

export function advanceReactionLab(input: { state: ReactionLabState; quotes: Record<string, number>; now: number;
  roundTripFrictionRate: number }) {
  let state = input.state;
  for (const experimentId of Object.keys(input.state.active)) {
    const prior = state.active[experimentId];
    const price = input.quotes[prior.symbol];
    let experiment = prior;
    if (price > 0) {
      const continuation = resolveRoute(state, "CONTINUATION", experiment.continuation, price, input.now,
        input.roundTripFrictionRate);
      state = continuation.state;
      const reversal = resolveRoute(state, "REVERSAL", experiment.reversal, price, input.now,
        input.roundTripFrictionRate);
      state = reversal.state;
      experiment = { ...experiment, lastPrice: price, continuation: continuation.route, reversal: reversal.route };
    }
    if (input.now >= experiment.observationExpiresAt) ({ state, experiment } = expireWatching(state, experiment));
    state = finishExperimentIfDone(state, experiment);
  }
  return state;
}

export function activeReactionForSymbol(state: ReactionLabState, symbol: string) {
  return Object.values(state.active).find((item) => item.symbol === symbol &&
    (item.continuation.status === "WATCHING" || item.reversal.status === "WATCHING")) ?? null;
}
