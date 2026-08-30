export type Hte31PerformanceSample = {
  sampleCount: number;
  wins: number;
  losses: number;
  expectancyR: number;
  grossProfitR: number;
  grossLossR: number;
};

export type Hte31PerformanceGate = {
  state: "ACTIVE" | "PAUSED";
  reason: string;
  profitFactor: number | null;
};

export const HTE31_CELL_PERFORMANCE_POLICY = {
  minimumSamples: 4,
  maximumNegativeExpectancyR: -0.15,
  minimumProfitFactor: 0.80,
  allLossMinimumSamples: 3,
} as const;

/**
 * Stops only a proven-negative trader/regime/direction cell. This avoids a
 * global frequency cut while preventing a sparse but repeatedly losing setup
 * from being kept alive by unrelated profitable cells.
 */
export function evaluateHte31PerformanceCell(sample: Hte31PerformanceSample | null | undefined): Hte31PerformanceGate {
  if (!sample || sample.sampleCount <= 0) {
    return { state: "ACTIVE", reason: "该组合尚无独立样本", profitFactor: null };
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
    return {
      state: "PAUSED",
      reason: `${sample.sampleCount}笔组合样本 · Exp ${sample.expectancyR.toFixed(2)}R · PF ${profitFactor == null ? "--" : profitFactor >= 99 ? "∞" : profitFactor.toFixed(2)}，暂停该交易员/环境/方向组合`,
      profitFactor,
    };
  }
  return {
    state: "ACTIVE",
    reason: `${sample.sampleCount}笔组合样本 · Exp ${sample.expectancyR.toFixed(2)}R · PF ${profitFactor == null ? "--" : profitFactor >= 99 ? "∞" : profitFactor.toFixed(2)}`,
    profitFactor,
  };
}
