import type { EventEntryAssessment, EventEntryRule, RadarCandidate } from "./market-radar.ts";

export const REJECTION_AUDIT_HORIZON_MS = 20 * 60_000;
export const MAX_PENDING_REJECTION_AUDITS = 120;
export const MAX_RECENT_REJECTION_AUDITS = 200;
export const MAX_SEEN_REJECTION_EVENTS = 512;
export const MAX_REJECTION_RULE_COMBINATIONS = 64;

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

export type RejectionRuleCombinationStats = Omit<RejectionRuleStats, "id" | "label" | "kind"> & {
  id: string;
  ruleIds: EventEntryRule["id"][];
  labels: string[];
};

export type RejectionAuditState = {
  startedAt: number;
  pending: Record<string, RejectionAuditSample>;
  recent: RejectionAuditSample[];
  seenEventIds: string[];
  rules: Record<string, RejectionRuleStats>;
  primaryRules: Record<string, RejectionRuleStats>;
  isolatedRules: Record<string, RejectionRuleStats>;
  combinations: Record<string, RejectionRuleCombinationStats>;
  combinationOverflow: number;
  completed: number;
  dropped: number;
};

export function initialRejectionAudit(now = Date.now()): RejectionAuditState {
  return { startedAt: now, pending: {}, recent: [], seenEventIds: [], rules: {}, primaryRules: {}, isolatedRules: {},
    combinations: {}, combinationOverflow: 0, completed: 0, dropped: 0 };
}

const directionalReturn = (side: "LONG" | "SHORT", entry: number, price: number) =>
  (side === "LONG" ? 1 : -1) * (price - entry) / Math.max(entry, 1e-9);

const incrementStats = <T extends RejectionRuleStats | RejectionRuleCombinationStats>(
  before: T,
  outcome: RejectionAuditOutcome,
  netReturnRate: number,
  feeCovered: boolean,
  profitableAfterCost: boolean,
): T => ({ ...before,
  resolved: before.resolved + 1,
  profitableAfterCost: before.profitableAfterCost + Number(profitableAfterCost),
  feeCovered: before.feeCovered + Number(feeCovered),
  targetFirst: before.targetFirst + Number(outcome === "TARGET_FIRST"),
  stopFirst: before.stopFirst + Number(outcome === "STOP_FIRST"),
  stalledExit: before.stalledExit + Number(outcome === "STALLED_EXIT"),
  timeExpired: before.timeExpired + Number(outcome === "TIME_EXPIRED"),
  netReturnRateSum: before.netReturnRateSum + netReturnRate,
});

const emptyRuleStats = (rule: EventEntryRule): RejectionRuleStats => ({ id: rule.id, label: rule.label, kind: rule.kind,
  resolved: 0, profitableAfterCost: 0, feeCovered: 0, targetFirst: 0, stopFirst: 0, stalledExit: 0,
  timeExpired: 0, netReturnRateSum: 0 });

const uniqueRules = (rules: EventEntryRule[]) => [...new Map(rules.map((item) => [item.id, item])).values()];

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
  let state: RejectionAuditState = { ...input.state,
    primaryRules: input.state.primaryRules ?? {},
    isolatedRules: input.state.isolatedRules ?? {},
    combinations: input.state.combinations ?? {},
    combinationOverflow: input.state.combinationOverflow ?? 0,
  };
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
    const failedRules = uniqueRules(resolved.rules);
    const rules = { ...state.rules };
    for (const rule of failedRules) {
      rules[rule.id] = incrementStats(rules[rule.id] ?? emptyRuleStats(rule), outcome, netReturnRate,
        Boolean(resolved.feeCovered), Boolean(resolved.profitableAfterCost));
    }

    const primaryRule = failedRules.find((rule) => rule.label === resolved.primaryBlocker) ?? failedRules[0];
    const primaryRules = { ...state.primaryRules };
    if (primaryRule) primaryRules[primaryRule.id] = incrementStats(primaryRules[primaryRule.id] ?? emptyRuleStats(primaryRule),
      outcome, netReturnRate, Boolean(resolved.feeCovered), Boolean(resolved.profitableAfterCost));

    const isolatedRules = { ...state.isolatedRules };
    if (failedRules.length === 1) {
      const onlyRule = failedRules[0];
      isolatedRules[onlyRule.id] = incrementStats(isolatedRules[onlyRule.id] ?? emptyRuleStats(onlyRule), outcome,
        netReturnRate, Boolean(resolved.feeCovered), Boolean(resolved.profitableAfterCost));
    }

    const sortedRules = [...failedRules].sort((left, right) => left.id.localeCompare(right.id));
    const combinationId = sortedRules.map((rule) => rule.id).join("+");
    const combinations = { ...state.combinations };
    let combinationOverflow = state.combinationOverflow;
    if (combinationId && (combinations[combinationId] || Object.keys(combinations).length < MAX_REJECTION_RULE_COMBINATIONS)) {
      const before = combinations[combinationId] ?? { id: combinationId, ruleIds: sortedRules.map((rule) => rule.id),
        labels: sortedRules.map((rule) => rule.label), resolved: 0, profitableAfterCost: 0, feeCovered: 0, targetFirst: 0,
        stopFirst: 0, stalledExit: 0, timeExpired: 0, netReturnRateSum: 0 };
      combinations[combinationId] = incrementStats(before, outcome, netReturnRate, Boolean(resolved.feeCovered),
        Boolean(resolved.profitableAfterCost));
    } else if (combinationId) combinationOverflow += 1;

    state = { ...state, pending, rules, primaryRules, isolatedRules, combinations, combinationOverflow,
      recent: [...state.recent, resolved].slice(-MAX_RECENT_REJECTION_AUDITS), completed: state.completed + 1 };
  }
  return state;
}
