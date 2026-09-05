import { DIRECT_CORE_SETUPS, DIRECT_LEGACY_SETUPS, type DirectCoreSetup } from "./direct-market-types.ts";

type PerformanceTrade = {
  setupId: string;
  status: "holding" | "closed";
  entryAt: number;
  exitAt: number | null;
  exitCode: string | null;
  netPnlUsdt: number | null;
  riskBudgetUsdt: number;
};

export type DirectSetupPerformance = {
  setup: DirectCoreSetup;
  setupLabel: string;
  openedTrades: number;
  openTrades: number;
  sampleCount: number;
  wins: number;
  scratches: number;
  losses: number;
  winRate: number | null;
  netPnlUsdt: number;
  averageR: number | null;
  averageWinR: number | null;
  averageLossR: number | null;
  realizedPayoffRatio: number | null;
  profitFactor: number | null;
  maxDrawdownR: number;
  maxLosingStreak: number;
  status: "发力" | "正常" | "观察" | "拖后腿" | "暂无机会";
};

function inWindow(value: number | null, from: number | null, to: number | null) {
  return value != null && (from == null || value >= from) && (to == null || value < to);
}
function setupStatus(sampleCount: number, netPnlUsdt: number, averageR: number | null, profitFactor: number | null, openedTrades: number) {
  if (sampleCount === 0) return openedTrades > 0 ? "观察" as const : "暂无机会" as const;
  if (sampleCount < 8) return "观察" as const;
  if (netPnlUsdt < 0 && ((averageR ?? 0) <= 0 || (profitFactor ?? 0) < 1)) return "拖后腿" as const;
  if (netPnlUsdt > 0 && (averageR ?? 0) > 0 && (profitFactor ?? 0) >= 1.2) return "发力" as const;
  return "正常" as const;
}

export function buildDirectSetupPerformance(
  trades: PerformanceTrade[],
  window: { from?: number; to?: number } = {},
): DirectSetupPerformance[] {
  const from = window.from ?? null;
  const to = window.to ?? null;
  return [...DIRECT_CORE_SETUPS, ...DIRECT_LEGACY_SETUPS.filter((setup) => trades.some((trade) => trade.setupId === setup.id))].map(({ id: setup, label: setupLabel }) => {
    const setupTrades = trades.filter((trade) => trade.setupId === setup);
    const opened = setupTrades.filter((trade) => inWindow(trade.entryAt, from, to));
    const closed = setupTrades
      .filter((trade) => trade.status === "closed" && inWindow(trade.exitAt, from, to))
      .sort((left, right) => (left.exitAt ?? 0) - (right.exitAt ?? 0));
    const resultsR = closed.map((trade) => trade.riskBudgetUsdt > 0 ? (trade.netPnlUsdt ?? 0) / trade.riskBudgetUsdt : 0);
    const grossProfit = closed.reduce((sum, trade) => sum + Math.max(0, trade.netPnlUsdt ?? 0), 0);
    const grossLoss = Math.abs(closed.reduce((sum, trade) => sum + Math.min(0, trade.netPnlUsdt ?? 0), 0));
    let equityR = 0;
    let peakR = 0;
    let maxDrawdownR = 0;
    let losingStreak = 0;
    let maxLosingStreak = 0;
    for (const resultR of resultsR) {
      equityR += resultR;
      peakR = Math.max(peakR, equityR);
      maxDrawdownR = Math.max(maxDrawdownR, peakR - equityR);
      losingStreak = resultR < 0 ? losingStreak + 1 : 0;
      maxLosingStreak = Math.max(maxLosingStreak, losingStreak);
    }
    const wins = closed.filter((trade) => (trade.netPnlUsdt ?? 0) > 0).length;
    const scratches = closed.filter((trade) => trade.exitCode === "breakeven").length;
    const losses = closed.filter((trade) => (trade.netPnlUsdt ?? 0) < 0 && trade.exitCode !== "breakeven").length;
    const netPnlUsdt = closed.reduce((sum, trade) => sum + (trade.netPnlUsdt ?? 0), 0);
    const averageR = resultsR.length ? resultsR.reduce((sum, value) => sum + value, 0) / resultsR.length : null;
    const winResults = resultsR.filter((value) => value > 0);
    const lossResults = resultsR.filter((value) => value < 0);
    const averageWinR = winResults.length ? winResults.reduce((sum, value) => sum + value, 0) / winResults.length : null;
    const averageLossR = lossResults.length ? lossResults.reduce((sum, value) => sum + value, 0) / lossResults.length : null;
    const realizedPayoffRatio = averageWinR != null && averageLossR != null
      ? averageWinR / Math.abs(averageLossR)
      : null;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : null;
    return {
      setup,
      setupLabel,
      openedTrades: opened.length,
      openTrades: setupTrades.filter((trade) => trade.status === "holding").length,
      sampleCount: closed.length,
      wins,
      scratches,
      losses,
      winRate: closed.length ? wins / closed.length * 100 : null,
      netPnlUsdt,
      averageR,
      averageWinR,
      averageLossR,
      realizedPayoffRatio,
      profitFactor,
      maxDrawdownR,
      maxLosingStreak,
      status: setupStatus(closed.length, netPnlUsdt, averageR, profitFactor, opened.length),
    };
  });
}
