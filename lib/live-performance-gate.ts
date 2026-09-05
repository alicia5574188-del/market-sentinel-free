import { RISK_POLICY } from "./risk-policy.ts";

export const LIVE_LOSS_STREAK_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
export const SIMULATION_PERFORMANCE_WINDOW = 8;
export const SIMULATION_MIN_SAMPLES = 6;
export const SIMULATION_MIN_WIN_RATE = 0.40;
export const SIMULATION_HARD_LOSS_STREAK = 3;
export const SIMULATION_EXPECTANCY_MIN_SAMPLES = SIMULATION_PERFORMANCE_WINDOW;

export type RecentLiveResult = {
  realizedPnlUsdt: number | null;
  entryEquityUsdt?: number | null;
  closedAt: number | null;
};

export type RecentSimulationResult = {
  netMovePct: number | null;
  exitAt: number | null;
};

export type LivePerformanceGate = {
  passed: boolean;
  reason: string | null;
  cooldownUntil: number | null;
  liveLossStreak: number;
  liveStrategyDrawdownPct: number;
  simulationLossStreak: number;
  simulationSampleCount: number;
  simulationWinRate: number | null;
  simulationNetPct: number;
  simulationExpectancyPct: number | null;
  simulationProfitFactor: number | null;
};

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function lossStreak(values: number[]) {
  let streak = 0;
  for (const value of values) {
    if (value >= 0) break;
    streak += 1;
  }
  return streak;
}

/**
 * Build a transfer-neutral equity curve from Market Sentinel's own closed live
 * orders. Each submitted live order stores a snapshot of the actual Gate equity
 * immediately before submission. Realized PnL is normalized by that entry-time
 * equity, so later transfers between futures and spot cannot rewrite historical
 * trading returns or manufacture a fake drawdown.
 */
function liveStrategyDrawdownPct(results: RecentLiveResult[]) {
  const chronological = [...results]
    .filter((item) => finite(item.closedAt) && finite(item.realizedPnlUsdt) && finite(item.entryEquityUsdt) && (item.entryEquityUsdt as number) > 0)
    .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  if (!chronological.length) return 0;

  let equityIndex = 1;
  let peakIndex = 1;
  for (const item of chronological) {
    const tradeReturn = (item.realizedPnlUsdt as number) / (item.entryEquityUsdt as number);
    if (!Number.isFinite(tradeReturn)) continue;
    equityIndex *= Math.max(1e-9, 1 + tradeReturn);
    peakIndex = Math.max(peakIndex, equityIndex);
  }
  return peakIndex > 0 ? Math.max(0, (peakIndex - equityIndex) / peakIndex) : 1;
}

export function evaluateLivePerformanceGate(input: {
  now?: number;
  recentLive: RecentLiveResult[];
  recentSimulation: RecentSimulationResult[];
  simulationOnly?: boolean;
}): LivePerformanceGate {
  const now = input.now ?? Date.now();
  const recentLive = [...input.recentLive]
    .filter((item) => finite(item.closedAt))
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const latestLive = recentLive[0] ?? null;
  const attributedLive = recentLive.filter((item) => finite(item.realizedPnlUsdt));
  const latestAttributedLive = attributedLive[0] ?? null;
  const liveLossStreak = lossStreak(attributedLive.map((item) => item.realizedPnlUsdt as number));
  const strategyDrawdown = liveStrategyDrawdownPct(recentLive);

  const recentSimulation = [...input.recentSimulation]
    .filter((item) => finite(item.exitAt) && finite(item.netMovePct))
    .sort((a, b) => (b.exitAt ?? 0) - (a.exitAt ?? 0))
    .slice(0, SIMULATION_PERFORMANCE_WINDOW);
  const simulationValues = recentSimulation.map((item) => item.netMovePct as number);
  const simulationLossStreak = lossStreak(simulationValues);
  const simulationSampleCount = simulationValues.length;
  const simulationWins = simulationValues.filter((value) => value > 0).length;
  const simulationWinRate = simulationSampleCount ? simulationWins / simulationSampleCount : null;
  const simulationNetPct = Number(simulationValues.reduce((sum, value) => sum + value, 0).toFixed(6));
  const simulationExpectancyPct = simulationSampleCount
    ? Number((simulationNetPct / simulationSampleCount).toFixed(6))
    : null;
  const simulationGrossProfitPct = simulationValues.reduce((sum, value) => sum + Math.max(0, value), 0);
  const simulationGrossLossPct = Math.abs(simulationValues.reduce((sum, value) => sum + Math.min(0, value), 0));
  const simulationProfitFactor = simulationGrossLossPct > 0
    ? Number((simulationGrossProfitPct / simulationGrossLossPct).toFixed(6))
    : simulationGrossProfitPct > 0 ? 99 : null;

  const base: Omit<LivePerformanceGate, "passed" | "reason" | "cooldownUntil"> = {
    liveLossStreak,
    liveStrategyDrawdownPct: Number((strategyDrawdown * 100).toFixed(6)),
    simulationLossStreak,
    simulationSampleCount,
    simulationWinRate,
    simulationNetPct,
    simulationExpectancyPct,
    simulationProfitFactor,
  };

  if (latestLive && latestLive.realizedPnlUsdt == null && (latestLive.closedAt ?? 0) >= now - 24 * 60 * 60 * 1_000) {
    return {
      ...base,
      passed: false,
      reason: "最近一笔 Gate 实盘已平仓但盈亏尚未完成归因，暂缓新开仓等待后台对账",
      cooldownUntil: null,
    };
  }

  if (liveLossStreak >= 2 && finite(latestAttributedLive?.closedAt)) {
    const cooldownUntil = (latestAttributedLive!.closedAt as number) + LIVE_LOSS_STREAK_COOLDOWN_MS;
    if (cooldownUntil > now) {
      return {
        ...base,
        passed: false,
        reason: "Gate 实盘最近连续 2 笔亏损，新开仓自动冷却 6 小时；已有仓位继续保护",
        cooldownUntil,
      };
    }
  }

  if (strategyDrawdown >= RISK_POLICY.peakDrawdownRate) {
    return {
      ...base,
      passed: false,
      reason: `哨兵实盘交易回撤 ${(strategyDrawdown * 100).toFixed(1)}%，达到 10% 策略回撤上限；Gate 账户转入/转出不计入交易回撤`,
      cooldownUntil: null,
    };
  }

  if (input.simulationOnly) {
    return { ...base, passed: false, cooldownUntil: null,
      reason: `当前历史路径方向策略仅用于模拟验证；本版本本轮已完成 ${simulationSampleCount} 笔（最近最多8笔）。旧版本订单仅保留归档，不计入当前资格；暂不支持实盘新开仓` };
  }

  if (simulationLossStreak >= SIMULATION_HARD_LOSS_STREAK) {
    return {
      ...base,
      passed: false,
      reason: "模拟策略最近连续 3 笔亏损，实盘新开仓暂停；模拟扫描继续运行，表现恢复后自动放行",
      cooldownUntil: null,
    };
  }

  if (simulationSampleCount >= SIMULATION_EXPECTANCY_MIN_SAMPLES
    && simulationNetPct <= 0
    && simulationProfitFactor != null
    && simulationProfitFactor < 1) {
    return {
      ...base,
      passed: false,
      reason: `最近 ${simulationSampleCount} 笔模拟策略为负期望：累计 ${simulationNetPct.toFixed(2)}%，平均 ${simulationExpectancyPct?.toFixed(2) ?? "--"}%/笔，PF ${simulationProfitFactor.toFixed(2)}；模拟盘继续采样，实盘新开仓暂停`,
      cooldownUntil: null,
    };
  }

  if (simulationSampleCount >= SIMULATION_MIN_SAMPLES
    && simulationWinRate != null
    && simulationWinRate < SIMULATION_MIN_WIN_RATE
    && simulationNetPct <= 0) {
    return {
      ...base,
      passed: false,
      reason: `最近 ${simulationSampleCount} 笔模拟策略胜率 ${(simulationWinRate * 100).toFixed(0)}% 且累计净结果 ${simulationNetPct.toFixed(2)}%，暂缓实盘新开仓`,
      cooldownUntil: null,
    };
  }

  return { ...base, passed: true, reason: null, cooldownUntil: null };
}
