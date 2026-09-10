export const ADAPTIVE_POLICY_VERSION = 2;
export const ADAPTIVE_DAILY_OBJECTIVE_RATE = 0.10;
export const ADAPTIVE_MIN_ANALOG_SAMPLES = 8;
export const ADAPTIVE_HORIZONS_MINUTES = [10, 20, 30, 45, 60] as const;

export type AdaptiveSide = "LONG" | "SHORT";
export type AdaptiveMechanism = "RANGE_ROTATION" | "COMPRESSION_EXPANSION" | "FAILED_AUCTION"
  | "PULLBACK_RECOVERY" | "MOMENTUM_CONTINUATION" | "BREAKOUT_ACCEPTANCE";

export type AdaptiveCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type AdaptivePolicyRecommendation = {
  mechanism: AdaptiveMechanism;
  side: AdaptiveSide;
  horizonMinutes: number;
  samples: number;
  discoverySamples?: number;
  confirmationSamples?: number;
  confirmationNetReturnRate?: number;
  wins: number;
  netExpectationRate: number;
  conservativeNetReturnRate: number;
  profitFactor: number;
  targetReachRate: number;
  largestWinShare: number;
  stopRate: number;
  targetRate: number;
  reachableRate: number;
  opportunityRatePerDay: number;
  objectiveScore: number;
  approved: boolean;
  reason: string;
};

export type AdaptivePolicySnapshot = {
  version: 2;
  generatedAt: number;
  candleCount: number;
  objectiveDailyReturnRate: number;
  currentState: number[];
  recommendations: AdaptivePolicyRecommendation[];
};

type Feature = {
  vector: number[];
  trendRate: number;
  efficiency: number;
  volatilityRatio: number;
  volumeRatio: number;
  closeLocation: number;
  position: number;
  lastMove: number;
  averageRangeRate: number;
};

type Trigger = { mechanism: AdaptiveMechanism; side: AdaptiveSide; stopRate: number; targetRate: number;
  feature: Feature; observedAt: number };
type Outcome = Trigger & { horizonMinutes: number; netReturnRate: number; favorableRate: number;
  won: boolean; targeted: boolean; stopped: boolean };

const FRICTION_RATE = 0.0014;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const mean = (values: number[]) => values.length ? sum(values) / values.length : 0;
const direction = (side: AdaptiveSide) => side === "LONG" ? 1 : -1;

function featureAt(rows: AdaptiveCandle[], index: number): Feature | null {
  const window = rows.slice(Math.max(0, index - 23), index + 1);
  if (window.length < 18) return null;
  const closes = window.map((row) => row.close);
  const path = closes.slice(1).reduce((total, close, offset) => total + Math.abs(close - closes[offset]), 0);
  const trendRate = (window.at(-1)!.close - window[0].open) / Math.max(window[0].open, 1e-9);
  const efficiency = clamp(Math.abs(window.at(-1)!.close - window[0].open)
    / Math.max(path, window.at(-1)!.close * 0.0002), 0, 1);
  const ranges = window.map((row) => (row.high - row.low) / Math.max(row.open, 1e-9));
  const recentRange = mean(ranges.slice(-4));
  const priorRange = mean(ranges.slice(-12, -4));
  const volatilityRatio = clamp(recentRange / Math.max(priorRange, 0.00005), 0, 4);
  const lower = Math.min(...window.map((row) => row.low));
  const upper = Math.max(...window.map((row) => row.high));
  const position = clamp((window.at(-1)!.close - lower) / Math.max(upper - lower, window.at(-1)!.close * 0.0002), 0, 1);
  const latest = window.at(-1)!;
  const lastMove = (latest.close - latest.open) / Math.max(latest.open, 1e-9);
  const volumes = window.map((row) => Math.max(0, row.volume ?? 0));
  const recentVolume = mean(volumes.slice(-4));
  const priorVolume = mean(volumes.slice(-16, -4));
  const volumeRatio = priorVolume > 0 ? clamp(recentVolume / priorVolume, 0, 4) : 1;
  const closeLocation = clamp((latest.close - latest.low) / Math.max(latest.high - latest.low, latest.close * 0.00005), 0, 1);
  return { trendRate, efficiency, volatilityRatio, volumeRatio, closeLocation, position, lastMove,
    averageRangeRate: mean(ranges.slice(-6)),
    vector: [clamp(trendRate / 0.02, -1, 1), efficiency, clamp(Math.log(Math.max(volatilityRatio, 0.1)), -1.5, 1.5) / 1.5,
      position * 2 - 1, clamp(lastMove / 0.012, -1, 1),
      clamp(Math.log(Math.max(volumeRatio, 0.1)), -1.5, 1.5) / 1.5, closeLocation * 2 - 1] };
}

function triggersAt(rows: AdaptiveCandle[], index: number): Trigger[] {
  const feature = featureAt(rows, index);
  if (!feature) return [];
  const current = rows[index];
  const previous = rows[index - 1];
  const prior = rows.slice(Math.max(0, index - 12), index);
  if (!previous || prior.length < 8) return [];
  const priorHigh = Math.max(...prior.map((row) => row.high));
  const priorLow = Math.min(...prior.map((row) => row.low));
  const priorRanges = rows.slice(Math.max(0, index - 16), index)
    .map((row) => (row.high - row.low) / Math.max(row.open, 1e-9));
  const compression = mean(priorRanges.slice(-4)) / Math.max(mean(priorRanges.slice(-12, -4)), 0.00005);
  const noiseStopRate = clamp(Math.max(0.0016, feature.averageRangeRate * 1.15), 0.0016, 0.025);
  const output: Trigger[] = [];
  const add = (mechanism: AdaptiveMechanism, side: AdaptiveSide, rr: number, structuralStop?: number) => {
    const structuralStopRate = structuralStop && structuralStop > 0 ? (side === "LONG"
      ? (current.close - structuralStop) / current.close : (structuralStop - current.close) / current.close) : 0;
    const stopRate = clamp(Math.max(noiseStopRate, structuralStopRate + feature.averageRangeRate * 0.12), 0.0016, 0.025);
    // The frozen target itself must cover the complete round-trip friction and the selected net R multiple.
    const targetRate = FRICTION_RATE + rr * (stopRate + FRICTION_RATE);
    if (!output.some((row) => row.mechanism === mechanism && row.side === side))
      output.push({ mechanism, side, stopRate, targetRate, feature,
        observedAt: current.time });
  };
  // These are independent path hypotheses derived from state variables. Several may coexist on one candle;
  // the walk-forward evidence, not a fixed market-to-strategy lookup, decides which one is executable.
  if (feature.efficiency <= 0.72 && feature.position <= 0.42) add("RANGE_ROTATION", "LONG", 1.35, priorLow);
  if (feature.efficiency <= 0.72 && feature.position >= 0.58) add("RANGE_ROTATION", "SHORT", 1.35, priorHigh);
  if (compression <= 1.05 && Math.abs(feature.lastMove) >= Math.max(0.0008, feature.averageRangeRate * 0.28))
    add("COMPRESSION_EXPANSION", feature.lastMove >= 0 ? "LONG" : "SHORT", 1.8,
      feature.lastMove >= 0 ? Math.min(...prior.slice(-4).map((row) => row.low))
        : Math.max(...prior.slice(-4).map((row) => row.high)));
  const upperRejection = current.high > priorHigh && current.close < priorHigh
    || feature.position >= 0.72 && feature.closeLocation <= 0.42 && current.close < current.open;
  const lowerRejection = current.low < priorLow && current.close > priorLow
    || feature.position <= 0.28 && feature.closeLocation >= 0.58 && current.close > current.open;
  if (upperRejection)
    add("FAILED_AUCTION", "SHORT", 1.55, current.high);
  if (lowerRejection)
    add("FAILED_AUCTION", "LONG", 1.55, current.low);
  const trendSide: AdaptiveSide = feature.trendRate >= 0 ? "LONG" : "SHORT";
  const priorMove = (previous.close - previous.open) / Math.max(previous.open, 1e-9);
  if (feature.efficiency >= 0.22 && Math.abs(feature.trendRate) >= 0.0015
    && direction(trendSide) * priorMove < 0 && direction(trendSide) * feature.lastMove > 0)
    add("PULLBACK_RECOVERY", trendSide, 1.65, trendSide === "LONG"
      ? Math.min(current.low, previous.low) : Math.max(current.high, previous.high));
  if (feature.efficiency >= 0.32 && Math.abs(feature.trendRate) >= 0.002
    && (direction(trendSide) * feature.lastMove > 0
      || (trendSide === "LONG" ? feature.closeLocation >= 0.68 : feature.closeLocation <= 0.32)))
    add("MOMENTUM_CONTINUATION", trendSide, 1.85,
      trendSide === "LONG" ? Math.min(current.low, previous.low) : Math.max(current.high, previous.high));
  if (current.close > priorHigh && current.close > current.open)
    add("BREAKOUT_ACCEPTANCE", "LONG", 2, Math.min(current.low, priorHigh));
  if (current.close < priorLow && current.close < current.open)
    add("BREAKOUT_ACCEPTANCE", "SHORT", 2, Math.max(current.high, priorLow));
  return output;
}

function resolve(rows: AdaptiveCandle[], index: number, trigger: Trigger, horizonMinutes: number): Outcome | null {
  const entry = rows[index]?.close;
  if (!(entry > 0)) return null;
  const steps = Math.max(1, Math.round(horizonMinutes / 5));
  const future = rows.slice(index + 1, index + 1 + steps);
  if (future.length < steps) return null;
  const sign = direction(trigger.side);
  const stop = entry * (1 - sign * trigger.stopRate);
  const target = entry * (1 + sign * trigger.targetRate);
  let exit = future.at(-1)!.close;
  let favorableRate = 0;
  let targeted = false;
  let stopped = false;
  for (const row of future) {
    const favorable = trigger.side === "LONG" ? (row.high - entry) / entry : (entry - row.low) / entry;
    favorableRate = Math.max(favorableRate, favorable);
    const stopHit = trigger.side === "LONG" ? row.low <= stop : row.high >= stop;
    const targetHit = trigger.side === "LONG" ? row.high >= target : row.low <= target;
    if (stopHit) { stopped = true; exit = stop; break; } // Same-candle ambiguity is deliberately stop-first.
    if (targetHit) { targeted = true; exit = target; break; }
  }
  const netReturnRate = sign * (exit - entry) / entry - FRICTION_RATE;
  return { ...trigger, horizonMinutes, netReturnRate, favorableRate, won: netReturnRate > 0, targeted, stopped };
}

function distance(left: number[], right: number[]) {
  return Math.sqrt(sum(left.map((value, index) => (value - (right[index] ?? 0)) ** 2)));
}

function recommendation(current: Trigger, outcomes: Outcome[], candleCount: number): AdaptivePolicyRecommendation {
  const comparable = outcomes.filter((row) => row.mechanism === current.mechanism && row.side === current.side)
    .map((row) => ({ row, distance: distance(current.feature.vector, row.feature.vector) }));
  const byHorizon = ADAPTIVE_HORIZONS_MINUTES.map((horizonMinutes) => {
    const selected = comparable.filter((item) => item.row.horizonMinutes === horizonMinutes)
      .sort((a, b) => a.distance - b.distance).slice(0, 24);
    const chronological = [...selected].sort((a, b) => a.row.observedAt - b.row.observedAt);
    const confirmationCount = selected.length >= ADAPTIVE_MIN_ANALOG_SAMPLES
      ? Math.max(3, Math.floor(selected.length * 0.3)) : 0;
    const discovery = confirmationCount ? chronological.slice(0, -confirmationCount) : chronological;
    const confirmation = confirmationCount ? chronological.slice(-confirmationCount) : [];
    const weights = selected.map((item) => Math.exp(-item.distance * 1.35));
    const totalWeight = sum(weights);
    const returns = selected.map((item) => item.row.netReturnRate);
    const expected = totalWeight ? sum(selected.map((item, index) => item.row.netReturnRate * weights[index])) / totalWeight : 0;
    const variance = totalWeight ? sum(selected.map((item, index) => (item.row.netReturnRate - expected) ** 2 * weights[index])) / totalWeight : 0;
    const conservative = expected - Math.sqrt(variance) * 0.75 / Math.sqrt(Math.max(1, selected.length));
    const discoveryReturns = discovery.map((item) => item.row.netReturnRate);
    const discoveryExpected = mean(discoveryReturns);
    const discoveryDeviation = Math.sqrt(mean(discoveryReturns.map((value) => (value - discoveryExpected) ** 2)));
    const discoveryConservative = discoveryExpected
      - discoveryDeviation * 0.75 / Math.sqrt(Math.max(1, discoveryReturns.length));
    const confirmationReturns = confirmation.map((item) => item.row.netReturnRate);
    const confirmationExpected = mean(confirmationReturns);
    const confirmationDeviation = Math.sqrt(mean(confirmationReturns
      .map((value) => (value - confirmationExpected) ** 2)));
    const confirmationConservative = confirmationReturns.length
      ? confirmationExpected - confirmationDeviation * 0.5 / Math.sqrt(confirmationReturns.length) : 0;
    const grossProfit = sum(returns.filter((value) => value > 0));
    const grossLoss = Math.abs(sum(returns.filter((value) => value <= 0)));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
    const wins = returns.filter((value) => value > 0).length;
    const targetReachRate = selected.length ? selected.filter((item) => item.row.targeted).length / selected.length : 0;
    const positive = returns.filter((value) => value > 0).sort((a, b) => b - a);
    const largestWinShare = sum(positive) > 0 ? (positive[0] ?? 0) / sum(positive) : 1;
    const reachable = selected.map((item) => item.row.favorableRate).sort((a, b) => a - b);
    const reachableRate = reachable.length ? reachable[Math.floor((reachable.length - 1) * 0.6)] * 0.9 : 0;
    const spanDays = Math.max(1 / 24, candleCount * 5 / 1_440);
    const opportunitiesPerDay = clamp(selected.length / spanDays, 0, 30);
    const riskScaledNotional = clamp(0.015 / Math.max(current.stopRate + FRICTION_RATE, 1e-9), 0, 4);
    const selectionScore = discoveryConservative * riskScaledNotional * opportunitiesPerDay;
    const objectiveScore = Math.min(conservative, confirmationConservative) * riskScaledNotional * opportunitiesPerDay;
    const eligible = selected.length >= ADAPTIVE_MIN_ANALOG_SAMPLES && conservative > 0
      && confirmation.length >= 3 && confirmationConservative > 0
      && profitFactor >= 1.05 && targetReachRate >= 0.3 && largestWinShare <= 0.55;
    return { horizonMinutes, samples: selected.length, wins, expected, conservative, profitFactor, targetReachRate,
      largestWinShare, reachableRate, opportunitiesPerDay, objectiveScore, selectionScore, eligible,
      discoverySamples: discovery.length, confirmationSamples: confirmation.length, confirmationExpected,
      confirmationConservative };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible)
    || (b.eligible ? b.objectiveScore - a.objectiveScore : b.selectionScore - a.selectionScore)
    || b.conservative - a.conservative)[0];
  const approved = byHorizon.eligible;
  const reason = byHorizon.samples < ADAPTIVE_MIN_ANALOG_SAMPLES ? `相似历史样本不足 ${byHorizon.samples}/${ADAPTIVE_MIN_ANALOG_SAMPLES}`
    : byHorizon.conservative <= 0 ? "相似状态完整成本后的保守期望不为正"
      : byHorizon.confirmationSamples < 3 ? "最近独立确认样本不足"
        : byHorizon.confirmationConservative <= 0 ? "最近独立样本未确认正期望"
          : byHorizon.profitFactor < 1.05 ? "相似状态盈亏因子不足"
            : byHorizon.targetReachRate < 0.3 ? "冻结目标的历史到达率不足"
              : byHorizon.largestWinShare > 0.55 ? "收益过度依赖单笔异常盈利" : "旧样本选择、最近独立样本确认成本后正期望";
  return { mechanism: current.mechanism, side: current.side, horizonMinutes: byHorizon.horizonMinutes,
    samples: byHorizon.samples, discoverySamples: byHorizon.discoverySamples,
    confirmationSamples: byHorizon.confirmationSamples,
    confirmationNetReturnRate: byHorizon.confirmationExpected,
    wins: byHorizon.wins, netExpectationRate: byHorizon.expected,
    conservativeNetReturnRate: byHorizon.conservative, profitFactor: byHorizon.profitFactor,
    targetReachRate: byHorizon.targetReachRate, largestWinShare: byHorizon.largestWinShare,
    stopRate: current.stopRate, targetRate: current.targetRate, reachableRate: byHorizon.reachableRate,
    opportunityRatePerDay: byHorizon.opportunitiesPerDay, objectiveScore: byHorizon.objectiveScore, approved, reason };
}

export function buildAdaptivePolicySnapshot(candles: AdaptiveCandle[], generatedAt: number): AdaptivePolicySnapshot | null {
  const rows = [...new Map(candles.filter((row) => [row.time, row.open, row.high, row.low, row.close].every(Number.isFinite)
      && row.time > 0 && row.open > 0 && row.high >= row.low && row.low > 0 && row.close > 0)
    .map((row) => [row.time, row])).values()].sort((a, b) => a.time - b.time);
  if (rows.length < 48) return null;
  const currentFeature = featureAt(rows, rows.length - 1);
  if (!currentFeature) return null;
  const outcomes: Outcome[] = [];
  for (let index = 24; index < rows.length - Math.max(...ADAPTIVE_HORIZONS_MINUTES) / 5; index += 1) {
    for (const trigger of triggersAt(rows, index)) {
      for (const horizon of ADAPTIVE_HORIZONS_MINUTES) {
        const row = resolve(rows, index, trigger, horizon);
        if (row) outcomes.push(row);
      }
    }
  }
  const current = triggersAt(rows, rows.length - 1);
  return { version: ADAPTIVE_POLICY_VERSION, generatedAt, candleCount: rows.length,
    objectiveDailyReturnRate: ADAPTIVE_DAILY_OBJECTIVE_RATE, currentState: currentFeature.vector,
    recommendations: current.map((trigger) => recommendation(trigger, outcomes, rows.length)) };
}
