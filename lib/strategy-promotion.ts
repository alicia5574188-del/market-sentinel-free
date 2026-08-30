import type { ShadowStrategyId } from "./shadow-strategy-engine.ts";

export type StrategyResultSample = {
  netMovePct: number | null;
  exitAt: number | null;
  regime: string | null;
};

export type StrategyStatistics = {
  sampleCount: number;
  activeDayCount: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  averageNetPct: number | null;
  cumulativeNetPct: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  maxLossStreak: number;
  recentSampleCount: number;
  recentAverageNetPct: number | null;
  recentProfitFactor: number | null;
  profitableRegimeCount: number;
};

export type StrategyPromotion = {
  status: "collecting" | "watch" | "candidate";
  label: string;
  eligible: boolean;
  requiredSamples: number;
  requiredActiveDays: number;
  reasons: string[];
};

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function profitFactor(values: number[]) {
  const gains = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  if (losses === 0) return gains > 0 ? null : 0;
  return gains / losses;
}

function maxDrawdown(values: number[]) {
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const value of values) {
    equity *= Math.max(1e-9, 1 + value / 100);
    peak = Math.max(peak, equity);
    worst = Math.max(worst, peak > 0 ? (peak - equity) / peak : 1);
  }
  return worst * 100;
}

function maxLossStreak(values: number[]) {
  let current = 0;
  let maximum = 0;
  for (const value of values) {
    if (value < 0) {
      current += 1;
      maximum = Math.max(maximum, current);
    } else {
      current = 0;
    }
  }
  return maximum;
}

function stableRegime(value: string | null | undefined) {
  return (value || "unknown").split(" · ")[0].trim() || "unknown";
}

function utcDay(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function calculateStrategyStatistics(samples: StrategyResultSample[]): StrategyStatistics {
  const ordered = [...samples]
    .filter((sample) => finite(sample.netMovePct) && finite(sample.exitAt))
    .sort((a, b) => (a.exitAt ?? 0) - (b.exitAt ?? 0));
  const values = ordered.map((sample) => sample.netMovePct as number);
  const recent = values.slice(-20);
  const regimes = new Map<string, number[]>();
  for (const sample of ordered) {
    const key = stableRegime(sample.regime);
    const bucket = regimes.get(key) ?? [];
    bucket.push(sample.netMovePct as number);
    regimes.set(key, bucket);
  }
  const profitableRegimeCount = [...regimes.values()].filter((bucket) => bucket.length >= 5 && bucket.reduce((sum, value) => sum + value, 0) > 0).length;
  const activeDayCount = new Set(ordered.map((sample) => utcDay(sample.exitAt as number))).size;
  const wins = values.filter((value) => value > 0.03).length;
  const losses = values.filter((value) => value < -0.03).length;
  return {
    sampleCount: values.length,
    activeDayCount,
    wins,
    losses,
    flats: Math.max(0, values.length - wins - losses),
    winRate: values.length ? wins / values.length : null,
    averageNetPct: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    cumulativeNetPct: values.reduce((sum, value) => sum + value, 0),
    profitFactor: profitFactor(values),
    maxDrawdownPct: maxDrawdown(values),
    maxLossStreak: maxLossStreak(values),
    recentSampleCount: recent.length,
    recentAverageNetPct: recent.length ? recent.reduce((sum, value) => sum + value, 0) / recent.length : null,
    recentProfitFactor: profitFactor(recent),
    profitableRegimeCount,
  };
}

export function evaluateStrategyPromotion(strategyId: ShadowStrategyId, stats: StrategyStatistics): StrategyPromotion {
  const requiredSamples = strategyId === "relative_strength" ? 80 : 50;
  const requiredActiveDays = strategyId === "relative_strength" ? 10 : 7;
  const reasons: string[] = [];
  const effectiveProfitFactor = stats.profitFactor == null && stats.cumulativeNetPct > 0 ? Number.POSITIVE_INFINITY : (stats.profitFactor ?? 0);
  const recentProfitFactor = stats.recentProfitFactor == null && (stats.recentAverageNetPct ?? 0) > 0 ? Number.POSITIVE_INFINITY : (stats.recentProfitFactor ?? 0);
  if (stats.sampleCount < requiredSamples) reasons.push(`完整样本 ${stats.sampleCount}/${requiredSamples}`);
  if (stats.activeDayCount < requiredActiveDays) reasons.push(`有效交易日 ${stats.activeDayCount}/${requiredActiveDays}`);
  if ((stats.averageNetPct ?? 0) <= 0.08) reasons.push(`平均净收益需 > 0.08%，当前 ${(stats.averageNetPct ?? 0).toFixed(2)}%`);
  if (effectiveProfitFactor < 1.25) reasons.push(`Profit Factor 需 ≥ 1.25，当前 ${stats.profitFactor == null ? "0" : stats.profitFactor.toFixed(2)}`);
  if (stats.maxDrawdownPct > 8) reasons.push(`最大回撤需 ≤ 8%，当前 ${stats.maxDrawdownPct.toFixed(2)}%`);
  if (stats.maxLossStreak > 5) reasons.push(`最大连续亏损需 ≤ 5，当前 ${stats.maxLossStreak}`);
  if (stats.recentSampleCount < 20) reasons.push(`最近样本需满 20，当前 ${stats.recentSampleCount}`);
  if ((stats.recentAverageNetPct ?? 0) <= 0) reasons.push(`最近 20 笔平均净结果需 > 0，当前 ${(stats.recentAverageNetPct ?? 0).toFixed(2)}%`);
  if (recentProfitFactor < 1.10) reasons.push(`最近 20 笔 Profit Factor 需 ≥ 1.10，当前 ${stats.recentProfitFactor == null ? "0" : stats.recentProfitFactor.toFixed(2)}`);
  // Regime-routed strategies are allowed to specialize. Requiring them to win
  // in unrelated regimes would reward rule leakage instead of specialization.
  if (stats.profitableRegimeCount < 1 && stats.sampleCount >= requiredSamples) reasons.push("至少一个实际交易的市场状态需积累 ≥5 笔且累计正收益");
  const eligible = reasons.length === 0;
  if (eligible) return { status: "candidate", label: "达到实盘候选线（仍需人工批准）", eligible: true, requiredSamples, requiredActiveDays, reasons: [] };
  if (stats.sampleCount >= Math.min(30, requiredSamples)) return { status: "watch", label: "观察期", eligible: false, requiredSamples, requiredActiveDays, reasons };
  return { status: "collecting", label: "样本积累中", eligible: false, requiredSamples, requiredActiveDays, reasons };
}
