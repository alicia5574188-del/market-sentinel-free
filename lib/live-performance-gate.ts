export const LIVE_LOSS_STREAK_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
export const SIMULATION_PERFORMANCE_WINDOW = 8;
export const SIMULATION_MIN_SAMPLES = 6;
export const SIMULATION_MIN_WIN_RATE = 0.40;
export const SIMULATION_HARD_LOSS_STREAK = 3;

export type RecentLiveResult = {
  realizedPnlUsdt: number | null;
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
  simulationLossStreak: number;
  simulationSampleCount: number;
  simulationWinRate: number | null;
  simulationNetPct: number;
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

export function evaluateLivePerformanceGate(input: {
  now?: number;
  recentLive: RecentLiveResult[];
  recentSimulation: RecentSimulationResult[];
}): LivePerformanceGate {
  const now = input.now ?? Date.now();
  const recentLive = [...input.recentLive]
    .filter((item) => finite(item.closedAt))
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const latestLive = recentLive[0] ?? null;
  const liveValues = recentLive.filter((item) => finite(item.realizedPnlUsdt)).map((item) => item.realizedPnlUsdt as number);
  const liveLossStreak = lossStreak(liveValues);

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

  const base: Omit<LivePerformanceGate, "passed" | "reason" | "cooldownUntil"> = {
    liveLossStreak,
    simulationLossStreak,
    simulationSampleCount,
    simulationWinRate,
    simulationNetPct,
  };

  if (latestLive && latestLive.realizedPnlUsdt == null && (latestLive.closedAt ?? 0) >= now - 24 * 60 * 60 * 1_000) {
    return {
      ...base,
      passed: false,
      reason: "最近一笔 Gate 实盘已平仓但盈亏尚未完成归因，暂缓新开仓等待后台对账",
      cooldownUntil: null,
    };
  }

  if (liveLossStreak >= 2 && finite(latestLive?.closedAt)) {
    const cooldownUntil = (latestLive!.closedAt as number) + LIVE_LOSS_STREAK_COOLDOWN_MS;
    if (cooldownUntil > now) {
      return {
        ...base,
        passed: false,
        reason: "Gate 实盘最近连续 2 笔亏损，新开仓自动冷却 6 小时；已有仓位继续保护",
        cooldownUntil,
      };
    }
  }

  if (simulationLossStreak >= SIMULATION_HARD_LOSS_STREAK) {
    return {
      ...base,
      passed: false,
      reason: "模拟策略最近连续 3 笔亏损，实盘新开仓暂停；模拟扫描继续运行，表现恢复后自动放行",
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
