import type { ReactionBranch, ReactionExperiment, ReactionLabState, ReactionOutcome, ReactionRoute } from "./reaction-lab.ts";

export const OUTCOME_DISCOVERY_SAMPLES = 100;
export const MAX_OUTCOME_RECENT = 120;
export const MAX_OUTCOME_PROCESSED = 512;
export const MAX_OUTCOME_SEGMENTS = 64;

export type OutcomeAggregate = {
  samples: number;
  wins: number;
  losses: number;
  targetFirst: number;
  stopFirst: number;
  stalledExit: number;
  timeExpired: number;
  netReturnRateSum: number;
};

export type OutcomeProfile = {
  impulseRate: number;
  strength: number;
  movementMultiple: number;
  volume24hUsd: number;
  openInterestChangeRate: number;
  startSpreadBps: number;
  startDepthAlignment: number;
  triggerRetraceRatio: number;
  triggerFlowSupport: number;
  triggerDelayMs: number;
  stopRate: number;
  bestGrossReturnRate: number;
  worstGrossReturnRate: number;
  holdingMs: number;
};

export type OutcomeGroup = OutcomeAggregate & {
  id: string;
  dimension: string;
  dimensionLabel: string;
  bucket: string;
  label: string;
  discovery: OutcomeAggregate;
  confirmation: OutcomeAggregate;
};

export type OutcomeSegment = OutcomeAggregate & {
  id: string;
  labels: string[];
  discovery: OutcomeAggregate;
  confirmation: OutcomeAggregate;
};

export type OutcomeSample = {
  id: string;
  experimentId: string;
  symbol: string;
  branch: ReactionBranch;
  side: "LONG" | "SHORT";
  eventKind: ReactionExperiment["kind"];
  triggeredAt: number;
  resolvedAt: number;
  phase: "DISCOVERY" | "CONFIRMATION";
  profitableAfterCost: boolean;
  outcome: Exclude<ReactionOutcome, "NO_TRIGGER">;
  netReturnRate: number;
  profile: OutcomeProfile;
  groupIds: string[];
  segmentId: string;
};

export type OutcomeResearchState = {
  version: 1;
  startedAt: number;
  processedRouteIds: string[];
  skippedLegacy: number;
  candidatesFrozenAt: number | null;
  candidateGroupIds: string[];
  candidateSegmentIds: string[];
  aggregate: OutcomeAggregate;
  discovery: OutcomeAggregate;
  confirmation: OutcomeAggregate;
  winnerProfileSums: OutcomeProfile;
  loserProfileSums: OutcomeProfile;
  groups: Record<string, OutcomeGroup>;
  segments: Record<string, OutcomeSegment>;
  recent: OutcomeSample[];
};

const emptyAggregate = (): OutcomeAggregate => ({ samples: 0, wins: 0, losses: 0, targetFirst: 0,
  stopFirst: 0, stalledExit: 0, timeExpired: 0, netReturnRateSum: 0 });
const emptyProfile = (): OutcomeProfile => ({ impulseRate: 0, strength: 0, movementMultiple: 0,
  volume24hUsd: 0, openInterestChangeRate: 0, startSpreadBps: 0, startDepthAlignment: 0,
  triggerRetraceRatio: 0, triggerFlowSupport: 0, triggerDelayMs: 0, stopRate: 0,
  bestGrossReturnRate: 0, worstGrossReturnRate: 0, holdingMs: 0 });

export function initialOutcomeResearch(now = Date.now()): OutcomeResearchState {
  return { version: 1, startedAt: now, processedRouteIds: [], skippedLegacy: 0, candidatesFrozenAt: null,
    candidateGroupIds: [], candidateSegmentIds: [], aggregate: emptyAggregate(),
    discovery: emptyAggregate(), confirmation: emptyAggregate(), winnerProfileSums: emptyProfile(),
    loserProfileSums: emptyProfile(), groups: {}, segments: {}, recent: [] };
}

const finite = (value: number | null | undefined) => Number.isFinite(value) ? Number(value) : 0;
const addAggregate = (before: OutcomeAggregate, sample: Pick<OutcomeSample, "profitableAfterCost" | "outcome" | "netReturnRate">) => ({
  samples: before.samples + 1,
  wins: before.wins + Number(sample.profitableAfterCost),
  losses: before.losses + Number(!sample.profitableAfterCost),
  targetFirst: before.targetFirst + Number(sample.outcome === "TARGET_FIRST"),
  stopFirst: before.stopFirst + Number(sample.outcome === "STOP_FIRST"),
  stalledExit: before.stalledExit + Number(sample.outcome === "STALLED_EXIT"),
  timeExpired: before.timeExpired + Number(sample.outcome === "TIME_EXPIRED"),
  netReturnRateSum: before.netReturnRateSum + sample.netReturnRate,
});
const addProfile = (before: OutcomeProfile, row: OutcomeProfile) => Object.fromEntries(
  Object.keys(before).map((key) => [key, before[key as keyof OutcomeProfile] + row[key as keyof OutcomeProfile]]),
) as OutcomeProfile;
const bucket = (value: number, cuts: number[], labels: string[]) => labels[cuts.findIndex((cut) => value < cut)] ?? labels[labels.length - 1];
const kindLabel: Record<ReactionExperiment["kind"], string> = {
  NEW_MONEY: "新增资金", SQUEEZE: "空头挤压", LIQUIDATION: "多头清算", PRICE_SHOCK: "价格异动",
};

function freezeCandidates(state: OutcomeResearchState, frozenAt: number) {
  if (state.candidatesFrozenAt != null || state.aggregate.samples < OUTCOME_DISCOVERY_SAMPLES) return state;
  const qualifies = (row: OutcomeAggregate, minimum: number) => row.samples >= minimum
    && row.netReturnRateSum / row.samples > 0 && row.wins / row.samples >= .5;
  const byNet = (left: OutcomeAggregate, right: OutcomeAggregate) =>
    right.netReturnRateSum / Math.max(right.samples, 1) - left.netReturnRateSum / Math.max(left.samples, 1);
  const candidateGroupIds = Object.values(state.groups).filter((row) => qualifies(row.discovery, 12))
    .sort((left, right) => byNet(left.discovery, right.discovery)).slice(0, 12).map((row) => row.id);
  const candidateSegmentIds = Object.values(state.segments).filter((row) => qualifies(row.discovery, 8))
    .sort((left, right) => byNet(left.discovery, right.discovery)).slice(0, 8).map((row) => row.id);
  return { ...state, candidatesFrozenAt: frozenAt, candidateGroupIds, candidateSegmentIds };
}

function phasedAggregate(before: { discovery: OutcomeAggregate; confirmation: OutcomeAggregate } | undefined,
  sample: OutcomeSample, phase: OutcomeSample["phase"]) {
  const discovery = before?.discovery ?? emptyAggregate();
  const confirmation = before?.confirmation ?? emptyAggregate();
  return { discovery: phase === "DISCOVERY" ? addAggregate(discovery, sample) : discovery,
    confirmation: phase === "CONFIRMATION" ? addAggregate(confirmation, sample) : confirmation };
}

function profileFor(experiment: ReactionExperiment, route: ReactionRoute): OutcomeProfile {
  const triggerAt = route.triggerAt ?? experiment.startedAt;
  const flow = finite(route.triggerAlignedFlow);
  return {
    impulseRate: finite(experiment.initialImpulseRate),
    strength: finite(experiment.strength),
    movementMultiple: finite(experiment.movementMultiple),
    volume24hUsd: finite(experiment.volume24hUsd),
    openInterestChangeRate: finite(experiment.openInterestChangeRate),
    startSpreadBps: finite(experiment.startSpreadBps),
    startDepthAlignment: finite(experiment.startDepthAlignment),
    triggerRetraceRatio: finite(route.triggerRetraceRatio),
    triggerFlowSupport: route.branch === "CONTINUATION" ? flow : -flow,
    triggerDelayMs: Math.max(0, triggerAt - experiment.startedAt),
    stopRate: finite(experiment.stopRate),
    bestGrossReturnRate: finite(route.bestGrossReturnRate),
    worstGrossReturnRate: finite(route.worstGrossReturnRate),
    holdingMs: Math.max(0, (route.resolvedAt ?? triggerAt) - triggerAt),
  };
}

function classifications(experiment: ReactionExperiment, route: ReactionRoute, profile: OutcomeProfile) {
  const rows = [
    ["BRANCH", "路线", route.branch, route.branch === "CONTINUATION" ? "回撤后延续" : "深回撤后反转"],
    ["EVENT_KIND", "异动类型", experiment.kind, kindLabel[experiment.kind]],
    ["IMPULSE_SIDE", "异动方向", experiment.impulseSide, experiment.impulseSide === "LONG" ? "向上异动" : "向下异动"],
    ["IMPULSE_SIZE", "异动幅度", bucket(profile.impulseRate, [.0025, .005], ["SMALL", "MEDIUM", "LARGE"]),
      bucket(profile.impulseRate, [.0025, .005], ["小于0.25%", "0.25%–0.50%", "不低于0.50%"])],
    ["STRENGTH", "异动强度", bucket(profile.strength, [65, 80], ["LOW", "MID", "HIGH"]),
      bucket(profile.strength, [65, 80], ["低于65", "65–80", "不低于80"])],
    ["RELATIVE_MOVE", "相对异动", bucket(profile.movementMultiple, [3, 5], ["LOW", "MID", "HIGH"]),
      bucket(profile.movementMultiple, [3, 5], ["低于3倍", "3–5倍", "不低于5倍"])],
    ["VOLUME", "24H成交额", bucket(profile.volume24hUsd, [25e6, 100e6], ["LOW", "MID", "HIGH"]),
      bucket(profile.volume24hUsd, [25e6, 100e6], ["低于2500万", "2500万–1亿", "不低于1亿"])],
    ["OI_CHANGE", "OI变化", bucket(profile.openInterestChangeRate, [-.0002, .0002], ["DOWN", "FLAT", "UP"]),
      bucket(profile.openInterestChangeRate, [-.0002, .0002], ["下降", "平缓", "上升"])],
    ["SPREAD", "起始点差", bucket(profile.startSpreadBps, [2, 5], ["TIGHT", "MID", "WIDE"]),
      bucket(profile.startSpreadBps, [2, 5], ["低于2bps", "2–5bps", "高于5bps"])],
    ["DEPTH", "同向盘口深度", bucket(profile.startDepthAlignment, [-.15, .15], ["OPPOSED", "BALANCED", "SUPPORTED"]),
      bucket(profile.startDepthAlignment, [-.15, .15], ["反向占优", "基本平衡", "同向占优"])],
    ["RETRACE", "触发回撤", bucket(profile.triggerRetraceRatio, [.4, .7, 1], ["SHALLOW", "MID", "DEEP", "OVER"]),
      bucket(profile.triggerRetraceRatio, [.4, .7, 1], ["低于40%", "40%–70%", "70%–100%", "超过100%"])],
    ["FLOW", "触发资金流", bucket(profile.triggerFlowSupport, [.3, .5], ["LOW", "MID", "HIGH"]),
      bucket(profile.triggerFlowSupport, [.3, .5], ["18%–30%", "30%–50%", "高于50%"])],
    ["SPEED", "触发速度", bucket(profile.triggerDelayMs, [30_000, 90_000], ["FAST", "MID", "SLOW"]),
      bucket(profile.triggerDelayMs, [30_000, 90_000], ["30秒内", "30–90秒", "90秒后"])],
    ["STOP", "止损宽度", bucket(profile.stopRate, [.004, .005], ["TIGHT", "MID", "WIDE"]),
      bucket(profile.stopRate, [.004, .005], ["低于0.40%", "0.40%–0.50%", "高于0.50%"])],
  ] as const;
  return rows.map(([dimension, dimensionLabel, key, label]) => ({ id: `${dimension}:${key}`, dimension, dimensionLabel, bucket: key, label }));
}

function ingestOne(state: OutcomeResearchState, experiment: ReactionExperiment, route: ReactionRoute): OutcomeResearchState {
  const id = `${experiment.id}:${route.branch}`;
  if (state.processedRouteIds.includes(id) || route.status !== "RESOLVED" || route.outcome == null
    || route.outcome === "NO_TRIGGER" || route.netReturnRate == null || route.profitableAfterCost == null) return state;
  const processedRouteIds = [...state.processedRouteIds, id].slice(-MAX_OUTCOME_PROCESSED);
  if (experiment.featureVersion !== 1 || route.triggerRetraceRatio == null || route.triggerAlignedFlow == null) {
    return { ...state, processedRouteIds, skippedLegacy: state.skippedLegacy + 1 };
  }
  state = freezeCandidates(state, route.resolvedAt ?? experiment.startedAt);
  const profile = profileFor(experiment, route);
  const phase = state.aggregate.samples < OUTCOME_DISCOVERY_SAMPLES ? "DISCOVERY" as const : "CONFIRMATION" as const;
  const groupRows = classifications(experiment, route, profile);
  const segmentRows = groupRows.filter((row) => ["BRANCH", "EVENT_KIND", "IMPULSE_SIZE", "RETRACE", "FLOW", "SPEED"].includes(row.dimension));
  const segmentId = segmentRows.map((row) => row.id).join("|");
  const sample: OutcomeSample = { id, experimentId: experiment.id, symbol: experiment.symbol, branch: route.branch,
    side: route.side, eventKind: experiment.kind, triggeredAt: route.triggerAt!, resolvedAt: route.resolvedAt!, phase,
    profitableAfterCost: route.profitableAfterCost, outcome: route.outcome, netReturnRate: route.netReturnRate,
    profile, groupIds: groupRows.map((row) => row.id), segmentId };
  const groups = { ...state.groups };
  for (const row of groupRows) groups[row.id] = { ...row, ...addAggregate(groups[row.id] ?? emptyAggregate(), sample),
    ...phasedAggregate(groups[row.id], sample, phase) };
  const segments = { ...state.segments };
  if (segments[segmentId] || Object.keys(segments).length < MAX_OUTCOME_SEGMENTS) {
    segments[segmentId] = { id: segmentId, labels: segmentRows.map((row) => row.label),
      ...addAggregate(segments[segmentId] ?? emptyAggregate(), sample),
      ...phasedAggregate(segments[segmentId], sample, phase) };
  }
  return { ...state, processedRouteIds, aggregate: addAggregate(state.aggregate, sample),
    discovery: phase === "DISCOVERY" ? addAggregate(state.discovery, sample) : state.discovery,
    confirmation: phase === "CONFIRMATION" ? addAggregate(state.confirmation, sample) : state.confirmation,
    winnerProfileSums: sample.profitableAfterCost ? addProfile(state.winnerProfileSums, profile) : state.winnerProfileSums,
    loserProfileSums: sample.profitableAfterCost ? state.loserProfileSums : addProfile(state.loserProfileSums, profile),
    groups, segments, recent: [...state.recent, sample].slice(-MAX_OUTCOME_RECENT) };
}

export function ingestReactionOutcomes(state: OutcomeResearchState, lab: ReactionLabState) {
  let next = state;
  const experiments = [...Object.values(lab.active), ...lab.recent];
  for (const experiment of experiments) {
    next = ingestOne(next, experiment, experiment.continuation);
    next = ingestOne(next, experiment, experiment.reversal);
  }
  return next;
}
