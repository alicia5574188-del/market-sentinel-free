import type { EventEntryAssessment, EventEntryRule, RadarCandidate } from "./market-radar.ts";

export const REJECTION_AUDIT_HORIZON_MS = 20 * 60_000;
export const MAX_PENDING_REJECTION_AUDITS = 120;
export const MAX_RECENT_REJECTION_AUDITS = 200;
export const MAX_SEEN_REJECTION_EVENTS = 512;

export type RejectionAuditOutcome = "TARGET_FIRST" | "STOP_FIRST" | "STALLED_EXIT" | "TIME_EXPIRED";

export type RejectionAuditSample = {
  id: string;
  eventId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  kind: RadarCandidate["kind"];
  startedAt: number;
  expiresAt: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  rules: EventEntryRule[];
  primaryBlocker: string;
  qualityScore: number;
  qualityRequired: number;
  qualityEvidence: string[];
  lastPrice: number;
  bestGrossReturnRate: number;
  worstGrossReturnRate: number;
  outcome: RejectionAuditOutcome | null;
  resolvedAt: number | null;
  exitPrice: number | null;
  grossReturnRate: number | null;
  netReturnRate: number | null;
  feeCovered: boolean | null;
  profitableAfterCost: boolean | null;
};

export type RejectionRuleStats = {
  id: EventEntryRule["id"];
  label: string;
  kind: EventEntryRule["kind"];
  resolved: number;
  profitableAfterCost: number;
  feeCovered: number;
  targetFirst: number;
  stopFirst: number;
  stalledExit: number;
  timeExpired: number;
  netReturnRateSum: number;
};

export type RejectionAuditState = {
  startedAt: number;
  pending: Record<string, RejectionAuditSample>;
  recent: RejectionAuditSample[];
  seenEventIds: string[];
  rules: Record<string, RejectionRuleStats>;
  completed: number;
  dropped: number;
};

export function initialRejectionAudit(now = Date.now()): RejectionAuditState {
  return { startedAt: now, pending: {}, recent: [], seenEventIds: [], rules: {}, completed: 0, dropped: 0 };
}

const directionalReturn = (side: "LONG" | "SHORT", entry: number, price: number) =>
  (side === "LONG" ? 1 : -1) * (price - entry) / Math.max(entry, 1e-9);

export function recordRejectedCandidate(input: {
  state: RejectionAuditState;
  candidate: RadarCandidate;
  assessment: EventEntryAssessment;
  midpoint: number;
  stopRate: number;
  targetRate: number;
  now: number;
}) {
  if (input.assessment.accepted || !input.assessment.failedRules.length || input.state.seenEventIds.includes(input.candidate.id)) return input.state;
  if (Object.keys(input.state.pending).length >= MAX_PENDING_REJECTION_AUDITS) {
    return { ...input.state, dropped: input.state.dropped + 1, seenEventIds: [...input.state.seenEventIds, input.candidate.id].slice(-MAX_SEEN_REJECTION_EVENTS) };
  }
  const direction = input.candidate.side === "LONG" ? 1 : -1;
  const sample: RejectionAuditSample = {
    id: `rejected:${input.candidate.id}`,
    eventId: input.candidate.id,
    symbol: input.candidate.symbol,
    side: input.candidate.side,
    kind: input.candidate.kind,
    startedAt: input.now,
    expiresAt: input.now + REJECTION_AUDIT_HORIZON_MS,
    entryPrice: input.midpoint,
    stopPrice: input.midpoint * (1 - direction * input.stopRate),
    targetPrice: input.midpoint * (1 + direction * input.targetRate),
    rules: input.assessment.failedRules,
    primaryBlocker: input.assessment.blocker ?? input.assessment.failedRules[0].label,
    qualityScore: input.assessment.qualityScore,
    qualityRequired: input.assessment.qualityRequired,
    qualityEvidence: input.assessment.qualityEvidence,
    lastPrice: input.midpoint,
    bestGrossReturnRate: 0,
    worstGrossReturnRate: 0,
    outcome: null,
    resolvedAt: null,
    exitPrice: null,
    grossReturnRate: null,
    netReturnRate: null,
    feeCovered: null,
    profitableAfterCost: null,
  };
  return {
    ...input.state,
    pending: { ...input.state.pending, [sample.id]: sample },
    seenEventIds: [...input.state.seenEventIds, input.candidate.id].slice(-MAX_SEEN_REJECTION_EVENTS),
  };
}

export function advanceRejectionAudit(input: {
  state: RejectionAuditState;
  quotes: Record<string, number>;
  now: number;
  roundTripFrictionRate: number;
}) {
  let state = input.state;
  for (const [id, prior] of Object.entries(input.state.pending)) {
    const price = input.quotes[prior.symbol];
    if (!(price > 0)) continue;
    const grossNow = directionalReturn(prior.side, prior.entryPrice, price);
    const sample = { ...prior, lastPrice: price, bestGrossReturnRate: Math.max(prior.bestGrossReturnRate, grossNow),
      worstGrossReturnRate: Math.min(prior.worstGrossReturnRate, grossNow) };
    const targetHit = prior.side === "LONG" ? price >= prior.targetPrice : price <= prior.targetPrice;
    const stopHit = prior.side === "LONG" ? price <= prior.stopPrice : price >= prior.stopPrice;
    const stalled = input.now - prior.startedAt >= 10 * 60_000
      && sample.bestGrossReturnRate < Math.abs(prior.entryPrice - prior.stopPrice) / prior.entryPrice * 0.35
      && grossNow < Math.abs(prior.entryPrice - prior.stopPrice) / prior.entryPrice * 0.15;
    const outcome: RejectionAuditOutcome | null = targetHit ? "TARGET_FIRST" : stopHit ? "STOP_FIRST"
      : input.now >= prior.expiresAt ? "TIME_EXPIRED" : stalled ? "STALLED_EXIT" : null;
    if (!outcome) {
      state = { ...state, pending: { ...state.pending, [id]: sample } };
      continue;
    }
    const grossReturnRate = grossNow;
    const netReturnRate = grossReturnRate - input.roundTripFrictionRate;
    const resolved: RejectionAuditSample = { ...sample, outcome, resolvedAt: input.now, exitPrice: price, grossReturnRate,
      netReturnRate, feeCovered: grossReturnRate >= input.roundTripFrictionRate, profitableAfterCost: netReturnRate > 0 };
    const pending = { ...state.pending };
    delete pending[id];
    const rules = { ...state.rules };
    for (const rule of [...new Map(resolved.rules.map((item) => [item.id, item])).values()]) {
      const before = rules[rule.id] ?? { id: rule.id, label: rule.label, kind: rule.kind, resolved: 0,
        profitableAfterCost: 0, feeCovered: 0, targetFirst: 0, stopFirst: 0, stalledExit: 0, timeExpired: 0, netReturnRateSum: 0 };
      rules[rule.id] = { ...before, resolved: before.resolved + 1,
        profitableAfterCost: before.profitableAfterCost + Number(resolved.profitableAfterCost),
        feeCovered: before.feeCovered + Number(resolved.feeCovered),
        targetFirst: before.targetFirst + Number(outcome === "TARGET_FIRST"),
        stopFirst: before.stopFirst + Number(outcome === "STOP_FIRST"),
        stalledExit: before.stalledExit + Number(outcome === "STALLED_EXIT"),
        timeExpired: before.timeExpired + Number(outcome === "TIME_EXPIRED"),
        netReturnRateSum: before.netReturnRateSum + netReturnRate };
    }
    state = { ...state, pending, rules, recent: [...state.recent, resolved].slice(-MAX_RECENT_REJECTION_AUDITS), completed: state.completed + 1 };
  }
  return state;
}
