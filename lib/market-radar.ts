import type { BookSnapshot, FlowEvidence } from "./liquidity-core.ts";

export const EVENT_REARM_QUIET_SCANS = 18;
export const EVENT_VISIBLE_QUIET_SCANS = 4;
export const MIN_EVENT_VOLUME_24H_USD = 10_000_000;
export const MAX_EVENT_SPREAD_BPS = 12;
export const MIN_EVENT_ALIGNED_FLOW = 0.32;
export const MAX_EVENT_EXTENSION_RATE = 0.0075;
export const MAX_FRICTION_SHARE_OF_TARGET = 0.25;
export const MIN_EVENT_QUALITY_SCORE = 3;

export type RadarTicker = {
  symbol: string;
  last: number;
  volume24hUsd: number;
  fundingRate: number;
  openInterest: number;
};

export type RadarBaseline = {
  last: number;
  observedAt: number;
  samples: number;
  movementEma: number;
  eventStartedAt: number | null;
  confirmations: number;
  quietScans: number;
  eventSide: "LONG" | "SHORT" | null;
  eventStrength: number;
  eventMoveRate: number;
  eventKind: RadarCandidate["kind"] | null;
  eventReferencePrice: number;
  eventOpenInterestChangeRate: number;
  openInterest: number;
};

export type RadarCandidate = {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  strength: number;
  moveRate: number;
  movementMultiple: number;
  volume24hUsd: number;
  confirmations: number;
  firstSeenAt: number;
  observedAt: number;
  kind: "NEW_MONEY" | "SQUEEZE" | "LIQUIDATION" | "PRICE_SHOCK";
  openInterestChangeRate: number;
  referencePrice: number;
};

export type EventEntryAssessment = {
  accepted: boolean;
  blocker: string | null;
  alignedFlow: number;
  spreadBps: number;
  nearBidDepthUsd: number;
  nearAskDepthUsd: number;
  extensionRate: number;
  costShare: number;
  conservativeWinRate: number;
  expectedReturnRate: number;
  qualityScore: number;
  qualityRequired: number;
  qualityEvidence: string[];
  failedRules: EventEntryRule[];
};

export type EventEntryRule = {
  id: "MIN_VOLUME" | "EVENT_CONFIRMATION" | "OPPOSITE_FLOW" | "MAX_SPREAD" | "MIN_DEPTH"
    | "MIN_DISPLACEMENT" | "MAX_EXTENSION" | "MAX_COST_SHARE" | "QUALITY_SCORE" | "POSITIVE_EXPECTANCY"
    | "QUALITY_STRENGTH" | "QUALITY_THIRD_CONFIRMATION" | "QUALITY_NEW_MONEY" | "QUALITY_ALIGNED_FLOW" | "QUALITY_RELATIVE_MOVE";
  label: string;
  kind: "EXECUTION" | "DIRECTION" | "ECONOMICS" | "QUALITY";
};

export function selectRealtimePool(input: {
  locked: string[];
  current: string[];
  candidates: string[];
  priorityCandidates?: string[];
  fallback: string[];
  limit: number;
}) {
  const candidateSet = new Set(input.candidates);
  const prioritySet = new Set(input.priorityCandidates ?? []);
  const priorityCandidates = input.candidates.filter((symbol) => prioritySet.has(symbol));
  const residentCandidates = input.current.filter((symbol) => candidateSet.has(symbol) && !prioritySet.has(symbol));
  const otherCandidates = input.candidates.filter((symbol) => !prioritySet.has(symbol));
  return [...new Set([...input.locked, ...priorityCandidates, ...residentCandidates, ...otherCandidates, ...input.current, ...input.fallback])]
    .slice(0, Math.max(0, input.limit));
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function updateRadar(
  prior: Record<string, RadarBaseline>,
  rows: RadarTicker[],
  eligible: Set<string>,
  now: number,
) {
  const baselines: Record<string, RadarBaseline> = {};
  const candidates: RadarCandidate[] = [];
  for (const row of rows) {
    if (!eligible.has(row.symbol) || row.last <= 0 || row.volume24hUsd < 2_000_000) continue;
    const before = prior[row.symbol];
    const moveRate = before?.last ? (row.last - before.last) / before.last : 0;
    const absoluteMove = Math.abs(moveRate);
    const movementEma = before
      ? before.movementEma * 0.88 + absoluteMove * 0.12
      : Math.max(absoluteMove, 0.00015);
    const multiple = absoluteMove / Math.max(before?.movementEma ?? 0.00015, 0.00008);
    const liquidBonus = clamp(Math.log10(Math.max(row.volume24hUsd, 1)) - 6, 0, 3) * 4;
    const strength = clamp(absoluteMove / 0.0008 * 35 + multiple * 12 + liquidBonus, 0, 100);
    const active = before != null && before.samples >= 2 && absoluteMove >= Math.max(0.0006, before.movementEma * 2.2) && strength >= 55;
    const side = moveRate >= 0 ? "LONG" as const : "SHORT" as const;
    const sameDirection = before?.eventStartedAt != null && before.eventSide === side;
    const eventStartedAt = active ? (sameDirection ? before!.eventStartedAt : now) : before?.eventStartedAt ?? null;
    const quietScans = active ? 0 : (before?.quietScans ?? 0) + 1;
    const retainedEvent = quietScans < EVENT_REARM_QUIET_SCANS ? eventStartedAt : null;
    const confirmations = active ? (sameDirection ? (before?.confirmations ?? 0) + 1 : 1)
      : retainedEvent ? Math.min(6, (before?.confirmations ?? 0) + 1) : 0;
    const eventSide = active ? side : retainedEvent ? before?.eventSide ?? null : null;
    const eventStrength = active ? Math.max(strength, before?.eventStrength ?? 0) : retainedEvent ? (before?.eventStrength ?? 0) * 0.96 : 0;
    const eventMoveRate = active ? ((before?.eventMoveRate ?? 0) + moveRate) : retainedEvent ? before?.eventMoveRate ?? 0 : 0;
    const priorOpenInterest = before?.openInterest ?? row.openInterest;
    const openInterestChangeRate = priorOpenInterest > 0 ? (row.openInterest - priorOpenInterest) / priorOpenInterest : 0;
    const impulseKind: RadarCandidate["kind"] = openInterestChangeRate >= 0.0002 ? "NEW_MONEY"
      : openInterestChangeRate <= -0.0002 ? (side === "LONG" ? "SQUEEZE" : "LIQUIDATION") : "PRICE_SHOCK";
    const eventKind = active ? (sameDirection ? before?.eventKind ?? impulseKind : impulseKind)
      : retainedEvent ? before?.eventKind ?? null : null;
    const eventReferencePrice = active ? (sameDirection ? before?.eventReferencePrice || before!.last : before?.last ?? row.last)
      : retainedEvent ? before?.eventReferencePrice ?? row.last : 0;
    const eventOpenInterestChangeRate = active ? (sameDirection
      ? Math.max(before?.eventOpenInterestChangeRate ?? openInterestChangeRate, openInterestChangeRate)
      : openInterestChangeRate) : retainedEvent ? before?.eventOpenInterestChangeRate ?? 0 : 0;
    baselines[row.symbol] = {
      last: row.last,
      observedAt: now,
      samples: Math.min(120, (before?.samples ?? 0) + 1),
      movementEma,
      eventStartedAt: retainedEvent,
      confirmations: retainedEvent ? confirmations : 0,
      quietScans,
      eventSide,
      eventStrength,
      eventMoveRate,
      eventKind,
      eventReferencePrice,
      eventOpenInterestChangeRate,
      openInterest: row.openInterest,
    };
    if (!retainedEvent || !eventSide || !eventKind || eventStrength < 52 || quietScans >= EVENT_VISIBLE_QUIET_SCANS) continue;
    candidates.push({
      id: `${row.symbol}:${retainedEvent}`,
      symbol: row.symbol,
      side: eventSide,
      strength: eventStrength,
      moveRate: eventMoveRate,
      movementMultiple: multiple,
      volume24hUsd: row.volume24hUsd,
      confirmations,
      firstSeenAt: retainedEvent,
      observedAt: now,
      kind: eventKind,
      openInterestChangeRate: eventOpenInterestChangeRate,
      referencePrice: eventReferencePrice,
    });
  }
  return { baselines, candidates: candidates.sort((a, b) => b.strength - a.strength).slice(0, 12), scanned: Object.keys(baselines).length };
}

export function assessEventEntry(input: {
  candidate: RadarCandidate;
  midpoint: number;
  snapshot: BookSnapshot;
  flow: FlowEvidence;
  stopRate: number;
  targetRate: number;
  roundTripFrictionRate: number;
}): EventEntryAssessment {
  const direction = input.candidate.side === "LONG" ? 1 : -1;
  const alignedFlow = direction * (input.flow.ofi * 0.45 + input.flow.takerDelta * 0.35
    + clamp(input.flow.openInterestDelta, -1, 1) * 0.20);
  const bestBid = input.snapshot.bids[0]?.price ?? 0;
  const bestAsk = input.snapshot.asks[0]?.price ?? 0;
  const spreadBps = bestBid > 0 && bestAsk >= bestBid ? (bestAsk - bestBid) / ((bestAsk + bestBid) / 2) * 10_000 : Infinity;
  const depthFloor = clamp(input.candidate.volume24hUsd * 0.00025, 25_000, 150_000);
  const nearBidDepthUsd = input.snapshot.bids.filter((row) => row.price >= input.midpoint * 0.999).reduce((sum, row) => sum + row.size, 0);
  const nearAskDepthUsd = input.snapshot.asks.filter((row) => row.price <= input.midpoint * 1.001).reduce((sum, row) => sum + row.size, 0);
  const extensionRate = direction * (input.midpoint - input.candidate.referencePrice) / Math.max(input.candidate.referencePrice, 1e-9);
  const costShare = input.roundTripFrictionRate / Math.max(input.targetRate, 1e-9);
  const qualityEvidence = [
    input.candidate.strength >= 62 ? "异动强度" : null,
    input.candidate.confirmations >= 3 ? "三轮扫描" : null,
    input.candidate.kind === "NEW_MONEY" && input.candidate.openInterestChangeRate >= 0.0002 ? "新增持仓" : null,
    alignedFlow >= MIN_EVENT_ALIGNED_FLOW ? "主动资金同向" : null,
    input.candidate.movementMultiple >= 2.5 ? "相对位移" : null,
  ].filter((item): item is string => item != null);
  const qualityScore = qualityEvidence.length;
  const conservativeWinRate = clamp(0.46 + qualityScore * 0.025 + Math.max(0, input.candidate.strength - 62) * 0.001,
    0.48, 0.62);
  const netRewardRate = Math.max(0, input.targetRate - input.roundTripFrictionRate);
  const lossRate = input.stopRate + input.roundTripFrictionRate;
  const expectedReturnRate = conservativeWinRate * netRewardRate - (1 - conservativeWinRate) * lossRate;
  const failedRuleCandidates: Array<EventEntryRule | null> = [
    input.candidate.volume24hUsd < MIN_EVENT_VOLUME_24H_USD ? { id: "MIN_VOLUME", label: "24小时成交额低于流动性门槛", kind: "EXECUTION" } as const : null,
    input.candidate.confirmations < 2 || input.candidate.strength < 58 ? { id: "EVENT_CONFIRMATION", label: "异动尚未形成两轮有效确认", kind: "DIRECTION" } as const : null,
    alignedFlow < -0.28 ? { id: "OPPOSITE_FLOW", label: "实时主动资金明显反向", kind: "DIRECTION" } as const : null,
    spreadBps > MAX_EVENT_SPREAD_BPS ? { id: "MAX_SPREAD", label: "盘口价差过大", kind: "EXECUTION" } as const : null,
    nearBidDepthUsd < depthFloor || nearAskDepthUsd < depthFloor ? { id: "MIN_DEPTH", label: "近端双边盘口深度不足", kind: "EXECUTION" } as const : null,
    extensionRate < 0.0006 ? { id: "MIN_DISPLACEMENT", label: "异动位移尚未成立", kind: "DIRECTION" } as const : null,
    extensionRate > MAX_EVENT_EXTENSION_RATE ? { id: "MAX_EXTENSION", label: "行情已经延伸，禁止追价", kind: "DIRECTION" } as const : null,
    costShare > MAX_FRICTION_SHARE_OF_TARGET ? { id: "MAX_COST_SHARE", label: "交易成本占第一目标空间过高", kind: "ECONOMICS" } as const : null,
    qualityScore < MIN_EVENT_QUALITY_SCORE ? { id: "QUALITY_SCORE", label: `方向证据 ${qualityScore}/${MIN_EVENT_QUALITY_SCORE}`, kind: "DIRECTION" } as const : null,
    qualityScore < MIN_EVENT_QUALITY_SCORE && input.candidate.strength < 62 ? { id: "QUALITY_STRENGTH", label: "评分项：异动强度不足62", kind: "QUALITY" } as const : null,
    qualityScore < MIN_EVENT_QUALITY_SCORE && input.candidate.confirmations < 3 ? { id: "QUALITY_THIRD_CONFIRMATION", label: "评分项：缺少第三轮确认", kind: "QUALITY" } as const : null,
    qualityScore < MIN_EVENT_QUALITY_SCORE && !(input.candidate.kind === "NEW_MONEY" && input.candidate.openInterestChangeRate >= 0.0002) ? { id: "QUALITY_NEW_MONEY", label: "评分项：缺少新增持仓", kind: "QUALITY" } as const : null,
    qualityScore < MIN_EVENT_QUALITY_SCORE && alignedFlow < MIN_EVENT_ALIGNED_FLOW ? { id: "QUALITY_ALIGNED_FLOW", label: "评分项：主动资金未强同向", kind: "QUALITY" } as const : null,
    qualityScore < MIN_EVENT_QUALITY_SCORE && input.candidate.movementMultiple < 2.5 ? { id: "QUALITY_RELATIVE_MOVE", label: "评分项：相对位移不足2.5倍", kind: "QUALITY" } as const : null,
    expectedReturnRate <= 0 ? { id: "POSITIVE_EXPECTANCY", label: "保守估计的成本后期望值不为正", kind: "ECONOMICS" } as const : null,
  ];
  const failedRules = failedRuleCandidates.filter((item): item is EventEntryRule => item != null);
  const blocker = failedRules[0]?.label ?? null;
  return { accepted: blocker == null, blocker, alignedFlow, spreadBps, nearBidDepthUsd, nearAskDepthUsd,
    extensionRate, costShare, conservativeWinRate, expectedReturnRate, qualityScore,
    qualityRequired: MIN_EVENT_QUALITY_SCORE, qualityEvidence, failedRules };
}
