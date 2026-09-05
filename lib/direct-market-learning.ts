import { DIRECT_MARKET_BRAIN_VERSION, type DirectMarketCandidate } from "./direct-market-types.ts";

export type DirectMarketLearningSample = {
  independentEventKey: string;
  resultR: number;
  signature: string;
  exitAt: number;
  complete: boolean;
};

export type DirectMarketLearningProfile = {
  version: string;
  parentVersion: string;
  sampleCount: number;
  action: "BASELINE" | "BLOCK_FAILURE_SIGNATURE" | "RAISE_EDGE_FLOOR";
  blockedSignature: string | null;
  minimumEdgeOffsetR: number;
  evidenceCount: number;
  lastEvidenceAt: number | null;
  reason: string;
};

export function directMarketCandidateSignature(candidate: Pick<DirectMarketCandidate, "setup" | "location" | "decision" | "assetRegime">) {
  return `${candidate.setup}|${candidate.location}|${candidate.decision}|${candidate.assetRegime}`;
}

function uniqueCompleteEvents(samples: DirectMarketLearningSample[]) {
  const seen = new Set<string>();
  return [...samples]
    .filter((sample) => sample.complete)
    .sort((a, b) => b.exitAt - a.exitAt)
    .filter((sample) => {
      if (seen.has(sample.independentEventKey)) return false;
      seen.add(sample.independentEventKey);
      return true;
    });
}

function profitFactor(samples: DirectMarketLearningSample[]) {
  const profit = samples.reduce((sum, sample) => sum + Math.max(0, sample.resultR), 0);
  const loss = Math.abs(samples.reduce((sum, sample) => sum + Math.min(0, sample.resultR), 0));
  return loss > 0 ? profit / loss : profit > 0 ? 99 : null;
}

/**
 * Complete 12-hour evidence changes at most one explainable admission variable.
 * Account resets are intentionally absent from this function: learning memory
 * follows the brain, while an epoch only restarts the displayed capital curve.
 */
export function deriveDirectMarketLearningProfile(samples: DirectMarketLearningSample[]): DirectMarketLearningProfile {
  const events = uniqueCompleteEvents(samples);
  const groups = new Map<string, DirectMarketLearningSample[]>();
  for (const event of events) groups.set(event.signature, [...(groups.get(event.signature) ?? []), event]);
  const weak = [...groups.entries()].map(([signature, rows]) => ({
    signature,
    rows,
    expectancy: rows.reduce((sum, row) => sum + row.resultR, 0) / rows.length,
    pf: profitFactor(rows),
    lastEvidenceAt: Math.max(...rows.map((row) => row.exitAt)),
  })).filter((group) => group.rows.length >= 4 && group.expectancy <= -0.25 && (group.pf ?? 0) < 0.8)
    .sort((a, b) => a.expectancy - b.expectancy || b.rows.length - a.rows.length)[0];

  if (weak) {
    return {
      version: `adaptive-direct-v2:block:${weak.signature}:${weak.rows.length}`,
      parentVersion: "adaptive-direct-v2",
      sampleCount: events.length,
      action: "BLOCK_FAILURE_SIGNATURE",
      blockedSignature: weak.signature,
      minimumEdgeOffsetR: 0,
      evidenceCount: weak.rows.length,
      lastEvidenceAt: weak.lastEvidenceAt,
      reason: `${weak.signature} 已有 ${weak.rows.length} 个独立完整事件，期望 ${weak.expectancy.toFixed(2)}R、PF ${weak.pf?.toFixed(2) ?? "--"}；停止重复进场，仅保留高质量复考`,
    };
  }

  const expectancy = events.length ? events.reduce((sum, row) => sum + row.resultR, 0) / events.length : 0;
  const pf = profitFactor(events);
  if (events.length >= 8 && expectancy < 0 && (pf ?? 0) < 1) {
    return {
      version: `adaptive-direct-v2:edge:${events.length}`,
      parentVersion: "adaptive-direct-v2",
      sampleCount: events.length,
      action: "RAISE_EDGE_FLOOR",
      blockedSignature: null,
      minimumEdgeOffsetR: 0.15,
      evidenceCount: events.length,
      lastEvidenceAt: events[0]?.exitAt ?? null,
      reason: `${events.length} 个独立完整事件整体期望 ${expectancy.toFixed(2)}R、PF ${pf?.toFixed(2) ?? "--"}；只提高净优势门槛，不改仓位`,
    };
  }

  return {
    version: "adaptive-direct-v2",
    parentVersion: DIRECT_MARKET_BRAIN_VERSION,
    sampleCount: events.length,
    action: "BASELINE",
    blockedSignature: null,
    minimumEdgeOffsetR: 0,
    evidenceCount: events.length,
    lastEvidenceAt: events[0]?.exitAt ?? null,
    reason: events.length ? `${events.length} 个完整独立事件尚未形成可验证的重复失效模式` : "等待首批完整12小时复盘证据",
  };
}

export function evaluateDirectMarketLearningAdmission(
  profile: DirectMarketLearningProfile,
  candidate: DirectMarketCandidate,
  now = Date.now(),
) {
  const baseEdge = candidate.forecast ? 0.05 : 0.55;
  if (candidate.netEdgeR < baseEdge + profile.minimumEdgeOffsetR) {
    return { allowed: false, revalidation: false, reason: `学习版本要求净优势至少 ${(baseEdge + profile.minimumEdgeOffsetR).toFixed(2)}R` };
  }
  const signature = directMarketCandidateSignature(candidate);
  if (profile.blockedSignature !== signature) return { allowed: true, revalidation: false, reason: profile.reason };
  const revalidationDue = profile.lastEvidenceAt != null
    && now - profile.lastEvidenceAt >= 12 * 60 * 60_000
    && candidate.confidence >= (candidate.forecast ? 72 : 82)
    && candidate.netEdgeR >= (candidate.forecast ? 0.25 : 0.9);
  return revalidationDue
    ? { allowed: true, revalidation: true, reason: `${profile.reason}；当前达到高质量复考条件` }
    : { allowed: false, revalidation: false, reason: profile.reason };
}
