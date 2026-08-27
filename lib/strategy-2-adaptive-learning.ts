export const ADAPTIVE_LEARNING_FORWARD_EPOCH_MS = 1787811000000;

export type AdaptiveLearningObservation = {
  exitAt: number | null;
  netPct: number;
  plannedRiskPct: number;
  mfePct: number | null;
  maePct: number | null;
  target1Hit: boolean;
};

export type AdaptiveLearningPrior = {
  meanR: number;
  strength: number;
};

export type AdaptiveEdgeState = "uncertain" | "positive" | "negative" | "degrading";

export type AdaptiveLearningStats = {
  sampleCount: number;
  effectiveSampleCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  rawExpectancyR: number | null;
  recencyExpectancyR: number | null;
  recentExpectancyR: number | null;
  posteriorExpectancyR: number | null;
  averageNetPct: number | null;
  averageMfeR: number | null;
  averageMaeR: number | null;
  t1HitRate: number | null;
  directionFailureRate: number | null;
  inverseT1PotentialRate: number | null;
  edgeLowerBoundR: number | null;
  edgeUpperBoundR: number | null;
  edgeConfidence: number;
  driftR: number | null;
  edgeState: AdaptiveEdgeState;
  forwardSampleCount: number;
  forwardExpectancyR: number | null;
  forwardInverseT1PotentialRate: number | null;
};

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function observationMetrics(observation: AdaptiveLearningObservation) {
  const riskPct = Math.max(Math.abs(observation.plannedRiskPct), 0.05);
  const resultR = observation.netPct / riskPct;
  const mfeR = Math.max(0, (observation.mfePct ?? 0) / riskPct);
  const maeR = Math.min(0, (observation.maePct ?? 0) / riskPct);
  return {
    resultR,
    mfeR,
    maeR,
    directionFailure: resultR < 0 && !observation.target1Hit && mfeR < 0.35,
    inverseT1Potential: -maeR >= 1,
  };
}

/**
 * Recency is measured both by trade sequence and wall-clock age. This lets a
 * busy market learn quickly while still allowing old regimes to fade when the
 * market changes. Sequence half-life = 32 observations; time half-life = 14d.
 */
function recencyWeight(ageIndex: number, ageMs: number) {
  const sequenceWeight = 0.5 ** (ageIndex / 32);
  const ageDays = Math.max(0, ageMs) / 86_400_000;
  const timeWeight = 0.5 ** (ageDays / 14);
  return Math.sqrt(sequenceWeight * timeWeight);
}

export function makeAdaptivePrior(stats: AdaptiveLearningStats | null | undefined, maxStrength = 8): AdaptiveLearningPrior | null {
  if (!stats || stats.posteriorExpectancyR == null || stats.sampleCount <= 0) return null;
  return {
    meanR: stats.posteriorExpectancyR,
    strength: Math.min(maxStrength, Math.max(2, stats.effectiveSampleCount * 0.35)),
  };
}

export function summarizeAdaptiveLearning(
  observations: AdaptiveLearningObservation[],
  prior: AdaptiveLearningPrior | null = null,
): AdaptiveLearningStats {
  if (!observations.length) {
    return {
      sampleCount: 0,
      effectiveSampleCount: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      rawExpectancyR: null,
      recencyExpectancyR: null,
      recentExpectancyR: null,
      posteriorExpectancyR: prior?.meanR ?? null,
      averageNetPct: null,
      averageMfeR: null,
      averageMaeR: null,
      t1HitRate: null,
      directionFailureRate: null,
      inverseT1PotentialRate: null,
      edgeLowerBoundR: null,
      edgeUpperBoundR: null,
      edgeConfidence: 0,
      driftR: null,
      edgeState: "uncertain",
      forwardSampleCount: 0,
      forwardExpectancyR: null,
      forwardInverseT1PotentialRate: null,
    };
  }

  const ordered = [...observations].sort((a, b) => (a.exitAt ?? 0) - (b.exitAt ?? 0));
  const newestAt = ordered[ordered.length - 1]?.exitAt ?? Date.now();
  const metrics = ordered.map((observation) => ({ observation, ...observationMetrics(observation) }));
  const weights = metrics.map((item, index) => recencyWeight(metrics.length - 1 - index, newestAt - (item.observation.exitAt ?? newestAt)));
  const weightSum = Math.max(1e-9, weights.reduce((sum, weight) => sum + weight, 0));
  const weightSquaredSum = Math.max(1e-9, weights.reduce((sum, weight) => sum + weight * weight, 0));
  const effectiveSampleCount = (weightSum * weightSum) / weightSquaredSum;
  const weighted = (selector: (item: (typeof metrics)[number]) => number) => metrics.reduce((sum, item, index) => sum + selector(item) * weights[index], 0) / weightSum;

  const rawExpectancyR = mean(metrics.map((item) => item.resultR));
  const recencyExpectancyR = weighted((item) => item.resultR);
  const recent = metrics.slice(-12);
  const recentExpectancyR = mean(recent.map((item) => item.resultR));
  const wins = metrics.filter((item) => item.resultR > 0).length;
  const losses = metrics.filter((item) => item.resultR < 0).length;
  const winRate = wins / metrics.length;
  const averageNetPct = mean(ordered.map((item) => item.netPct));
  const averageMfeR = weighted((item) => item.mfeR);
  const averageMaeR = weighted((item) => item.maeR);
  const t1HitRate = weighted((item) => item.observation.target1Hit ? 1 : 0);
  const directionFailureRate = weighted((item) => item.directionFailure ? 1 : 0);
  const inverseT1PotentialRate = weighted((item) => item.inverseT1Potential ? 1 : 0);

  const priorStrength = Math.max(0, prior?.strength ?? 0);
  const posteriorDenominator = Math.max(1e-9, effectiveSampleCount + priorStrength);
  const posteriorExpectancyR = ((recencyExpectancyR ?? 0) * effectiveSampleCount + (prior?.meanR ?? 0) * priorStrength) / posteriorDenominator;

  const weightedVariance = weighted((item) => (item.resultR - (recencyExpectancyR ?? 0)) ** 2);
  const varianceFloor = 0.12;
  const standardError = Math.sqrt(Math.max(varianceFloor, weightedVariance) / posteriorDenominator);
  const intervalRadius = 1.28 * standardError;
  const edgeLowerBoundR = posteriorExpectancyR - intervalRadius;
  const edgeUpperBoundR = posteriorExpectancyR + intervalRadius;
  const driftR = recentExpectancyR == null ? null : recentExpectancyR - posteriorExpectancyR;
  const separation = Math.abs(posteriorExpectancyR) / Math.max(0.12, standardError);
  const sampleConfidence = 1 - Math.exp(-effectiveSampleCount / 12);
  const edgeConfidence = Math.round(100 * clamp(sampleConfidence * Math.min(1, separation / 1.5)));

  const degrading = metrics.length >= 10
    && recent.length >= 6
    && (recentExpectancyR ?? 0) <= -0.25
    && (driftR ?? 0) <= -0.20;
  const directionallyBroken = metrics.length >= 10
    && directionFailureRate >= 0.62
    && inverseT1PotentialRate >= 0.52
    && posteriorExpectancyR < 0.05;
  const negative = metrics.length >= 10
    && ((posteriorExpectancyR <= -0.18 && edgeUpperBoundR < 0) || directionallyBroken);
  const positive = metrics.length >= 12
    && posteriorExpectancyR >= 0.12
    && edgeLowerBoundR > 0
    && (recentExpectancyR ?? 0) > -0.05;
  const edgeState: AdaptiveEdgeState = negative ? "negative" : degrading ? "degrading" : positive ? "positive" : "uncertain";

  const forward = metrics.filter((item) => (item.observation.exitAt ?? 0) >= ADAPTIVE_LEARNING_FORWARD_EPOCH_MS);
  const forwardExpectancyR = mean(forward.map((item) => item.resultR));
  const forwardInverseT1PotentialRate = forward.length ? forward.filter((item) => item.inverseT1Potential).length / forward.length : null;

  return {
    sampleCount: metrics.length,
    effectiveSampleCount: Number(effectiveSampleCount.toFixed(2)),
    wins,
    losses,
    winRate,
    rawExpectancyR,
    recencyExpectancyR,
    recentExpectancyR,
    posteriorExpectancyR,
    averageNetPct,
    averageMfeR,
    averageMaeR,
    t1HitRate,
    directionFailureRate,
    inverseT1PotentialRate,
    edgeLowerBoundR,
    edgeUpperBoundR,
    edgeConfidence,
    driftR,
    edgeState,
    forwardSampleCount: forward.length,
    forwardExpectancyR,
    forwardInverseT1PotentialRate,
  };
}
