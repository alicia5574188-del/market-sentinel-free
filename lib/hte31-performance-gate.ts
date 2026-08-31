export type Hte31PerformanceSample = {
  sampleCount: number;
  wins: number;
  losses: number;
  expectancyR: number;
  grossProfitR: number;
  grossLossR: number;
  updatedAt?: number | null;
};

export type Hte31PerformanceGate = {
  state: "ACTIVE" | "PAUSED";
  reason: string;
  profitFactor: number | null;
  revalidation: boolean;
};

export const HTE31_CELL_PERFORMANCE_POLICY = {
  minimumSamples: 4,
  maximumNegativeExpectancyR: -0.15,
  minimumProfitFactor: 0.80,
  allLossMinimumSamples: 3,
  revalidationDelayMs: 6 * 60 * 60_000,
} as const;

/**
 * Stops only a proven-negative trader/regime/direction cell. A negative cell is
 * not allowed to deadlock forever: after a six-hour paper-only quarantine it
 * may take one revalidation trade. If the result remains weak, updatedAt moves
 * forward and the cell returns to quarantine before another revalidation.
 */
export function evaluateHte31PerformanceCell(
  sample: Hte31PerformanceSample | null | undefined,
  now = Date.now(),
): Hte31PerformanceGate {
  if (!sample || sample.sampleCount <= 0) {
    return { state: "ACTIVE", reason: "该组合尚无独立样本", profitFactor: null, revalidation: false };
  }
  const grossLossR = Math.max(0, sample.grossLossR);
  const grossProfitR = Math.max(0, sample.grossProfitR);
  const profitFactor = grossLossR > 0
    ? grossProfitR / grossLossR
    : grossProfitR > 0 ? 99 : null;
  const allLosses = sample.sampleCount >= HTE31_CELL_PERFORMANCE_POLICY.allLossMinimumSamples
    && sample.wins === 0
    && sample.losses >= sample.sampleCount;
  const provenNegative = sample.sampleCount >= HTE31_CELL_PERFORMANCE_POLICY.minimumSamples
    && sample.expectancyR <= HTE31_CELL_PERFORMANCE_POLICY.maximumNegativeExpectancyR
    && profitFactor != null
    && profitFactor < HTE31_CELL_PERFORMANCE_POLICY.minimumProfitFactor;

  if (allLosses || provenNegative) {
    const revalidationReady = sample.updatedAt != null
      && now - sample.updatedAt >= HTE31_CELL_PERFORMANCE_POLICY.revalidationDelayMs;
    if (revalidationReady) {
      return {
        state: "ACTIVE",
        reason: `${sample.sampleCount}笔组合样本仍偏弱，但已完成6小时隔离；仅允许模拟复考1笔`,
        profitFactor,
        revalidation: true,
      };
    }
    return {
      state: "PAUSED",
      reason: `${sample.sampleCount}笔组合样本 · Exp ${sample.expectancyR.toFixed(2)}R · PF ${profitFactor == null ? "--" : profitFactor >= 99 ? "∞" : profitFactor.toFixed(2)}，暂停该交易员/环境/方向组合并等待模拟复考`,
      profitFactor,
      revalidation: false,
    };
  }
  return {
    state: "ACTIVE",
    reason: `${sample.sampleCount}笔组合样本 · Exp ${sample.expectancyR.toFixed(2)}R · PF ${profitFactor == null ? "--" : profitFactor >= 99 ? "∞" : profitFactor.toFixed(2)}`,
    profitFactor,
    revalidation: false,
  };
}
