import { evaluateHte31PerformanceCell } from "./hte31-performance-gate.ts";

export type Hte31OptimizationTrade = {
  id: string;
  symbol: string;
  traderId: "dennis_trend" | "raschke_pullback" | "turtle_soup" | "exhaustion_reversal" | "higher_timeframe_swing";
  setupId: string;
  side: "LONG" | "SHORT";
  assetRegime: string;
  entryPrice: number;
  initialStopPrice: number;
  riskBudgetUsdt: number;
  netPnlUsdt: number | null;
  exitCode: string | null;
  mfePct: number | null;
  maePct: number | null;
  holdMinutes: number | null;
  target1HitAt: number | null;
  stopRecovery: boolean | null;
  postExitLabel: string | null;
  exitEfficiency: number | null;
  exitAt: number | null;
};

type TradeMetrics = {
  samples: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  totalNetPnlUsdt: number;
  totalR: number;
  expectancyR: number;
  grossProfitR: number;
  grossLossR: number;
  profitFactor: number | null;
  averageWinR: number | null;
  averageLossR: number | null;
  payoffRatio: number | null;
  averageMfeR: number | null;
  averageMaeR: number | null;
  averageHoldMinutes: number | null;
  tp1HitRate: number | null;
  stopRecoveryRate: number | null;
  earlyExitRate: number | null;
  lateExitRate: number | null;
  averageExitEfficiency: number | null;
};

function round(value: number, digits = 6) {
  return Number(value.toFixed(digits));
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function tradeR(row: Hte31OptimizationTrade) {
  if (!finite(row.netPnlUsdt) || !(row.riskBudgetUsdt > 0)) return 0;
  return row.netPnlUsdt / row.riskBudgetUsdt;
}

function excursionR(row: Hte31OptimizationTrade, value: number | null) {
  if (!finite(value) || !(row.entryPrice > 0)) return null;
  const riskPct = Math.abs(row.entryPrice - row.initialStopPrice) / row.entryPrice * 100;
  return riskPct > 0 ? value / riskPct : null;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function summarizeHte31TradeGroup(rows: Hte31OptimizationTrade[]): TradeMetrics {
  const valid = rows.filter((row) => finite(row.netPnlUsdt));
  const rValues = valid.map(tradeR);
  const wins = rValues.filter((value) => value > 0);
  const losses = rValues.filter((value) => value < 0);
  const grossProfitR = wins.reduce((sum, value) => sum + value, 0);
  const grossLossR = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const avgWin = average(wins);
  const avgLoss = average(losses);
  const mfe = valid.map((row) => excursionR(row, row.mfePct)).filter((value): value is number => value != null);
  const mae = valid.map((row) => excursionR(row, row.maePct)).filter((value): value is number => value != null);
  const holds = valid.map((row) => row.holdMinutes).filter((value): value is number => finite(value));
  const exits = valid.map((row) => row.exitEfficiency).filter((value): value is number => finite(value));
  const stopRows = valid.filter((row) => row.exitCode === "stop_loss");
  const stopRecoveryKnown = stopRows.filter((row) => row.stopRecovery != null);
  const totalR = rValues.reduce((sum, value) => sum + value, 0);
  return {
    samples: valid.length,
    wins: wins.length,
    losses: losses.length,
    flats: valid.length - wins.length - losses.length,
    winRate: valid.length ? round(wins.length / valid.length) : null,
    totalNetPnlUsdt: round(valid.reduce((sum, row) => sum + (row.netPnlUsdt ?? 0), 0)),
    totalR: round(totalR),
    expectancyR: valid.length ? round(totalR / valid.length) : 0,
    grossProfitR: round(grossProfitR),
    grossLossR: round(grossLossR),
    profitFactor: grossLossR > 0 ? round(grossProfitR / grossLossR) : grossProfitR > 0 ? 99 : null,
    averageWinR: avgWin == null ? null : round(avgWin),
    averageLossR: avgLoss == null ? null : round(avgLoss),
    payoffRatio: avgWin != null && avgLoss != null && avgLoss < 0 ? round(avgWin / Math.abs(avgLoss)) : null,
    averageMfeR: mfe.length ? round(average(mfe) ?? 0) : null,
    averageMaeR: mae.length ? round(average(mae) ?? 0) : null,
    averageHoldMinutes: holds.length ? round(average(holds) ?? 0, 2) : null,
    tp1HitRate: valid.length ? round(valid.filter((row) => row.target1HitAt != null).length / valid.length) : null,
    stopRecoveryRate: stopRecoveryKnown.length ? round(stopRecoveryKnown.filter((row) => row.stopRecovery).length / stopRecoveryKnown.length) : null,
    earlyExitRate: valid.length ? round(valid.filter((row) => row.postExitLabel === "退出偏早").length / valid.length) : null,
    lateExitRate: valid.length ? round(valid.filter((row) => row.postExitLabel === "退出偏晚").length / valid.length) : null,
    averageExitEfficiency: exits.length ? round(average(exits) ?? 0, 2) : null,
  };
}

function grouped(rows: Hte31OptimizationTrade[], key: (row: Hte31OptimizationTrade) => string) {
  const groups = new Map<string, Hte31OptimizationTrade[]>();
  for (const row of rows) {
    const value = key(row);
    const bucket = groups.get(value) ?? [];
    bucket.push(row);
    groups.set(value, bucket);
  }
  return [...groups.entries()].map(([id, trades]) => ({ id, ...summarizeHte31TradeGroup(trades) }))
    .sort((a, b) => a.expectancyR - b.expectancyR || b.samples - a.samples);
}

export function buildHte31OptimizationAnalysis(rows: Hte31OptimizationTrade[]) {
  const closed = rows.filter((row) => row.exitAt != null && finite(row.netPnlUsdt));
  const overall = summarizeHte31TradeGroup(closed);
  const cells = grouped(closed, (row) => `${row.traderId}|${row.assetRegime}|${row.side}`).map((row) => ({
    ...row,
    performanceGate: evaluateHte31PerformanceCell({
      sampleCount: row.samples,
      wins: row.wins,
      losses: row.losses,
      expectancyR: row.expectancyR,
      grossProfitR: row.grossProfitR,
      grossLossR: row.grossLossR,
    }),
  }));
  const exits = grouped(closed, (row) => row.exitCode ?? "unknown");
  const setups = grouped(closed, (row) => row.setupId);
  const traders = grouped(closed, (row) => row.traderId);
  const sides = grouped(closed, (row) => row.side);

  const findings: { priority: "high" | "medium" | "observe"; code: string; evidence: string; action: string }[] = [];
  if (overall.samples < 12) findings.push({ priority: "observe", code: "sample_size", evidence: `当前只有 ${overall.samples} 笔已平仓样本`, action: "继续模拟和 Shadow 采样；不因为小样本全局提高入场门槛。" });
  if (overall.samples >= 6 && overall.expectancyR < 0) findings.push({ priority: "high", code: "negative_expectancy", evidence: `整体 Exp ${overall.expectancyR.toFixed(2)}R，PF ${overall.profitFactor == null ? "--" : overall.profitFactor.toFixed(2)}`, action: "保持 Gate 新开仓负期望门控；模拟继续运行并优先修复拖累最大的组合。" });
  if (overall.samples >= 6 && overall.payoffRatio != null && overall.payoffRatio < 1.2) findings.push({ priority: "high", code: "payoff_structure", evidence: `平均盈利 ${overall.averageWinR?.toFixed(2)}R，平均亏损 ${overall.averageLossR?.toFixed(2)}R，Payoff ${overall.payoffRatio.toFixed(2)}`, action: "优先检查止盈兑现、TP1 后回本止损和 timeout，而不是继续收紧入场过滤。" });
  for (const cell of cells.filter((item) => item.samples >= 3 && item.expectancyR < 0).slice(0, 3)) findings.push({ priority: cell.performanceGate.state === "PAUSED" ? "high" : "medium", code: "negative_cell", evidence: `${cell.id} · ${cell.samples}笔 · Exp ${cell.expectancyR.toFixed(2)}R · PF ${cell.profitFactor == null ? "--" : cell.profitFactor.toFixed(2)}`, action: cell.performanceGate.state === "PAUSED" ? "该组合保持暂停，其他组合不受影响。" : "继续独立采样到门控样本量，不做全局降频。" });
  const timeout = exits.find((item) => item.id === "timeout");
  if (timeout && timeout.samples >= 3 && timeout.expectancyR < -0.1) findings.push({ priority: "medium", code: "timeout_drag", evidence: `timeout ${timeout.samples}笔 · Exp ${timeout.expectancyR.toFixed(2)}R`, action: "把持仓时限/无进展退出作为下一轮实验变量，保持入场条件不变以隔离因果。" });
  const stops = exits.find((item) => item.id === "stop_loss");
  if (stops && stops.samples >= 3 && stops.stopRecoveryRate != null && stops.stopRecoveryRate >= 0.4) findings.push({ priority: "medium", code: "stop_recovery", evidence: `止损后持续恢复率 ${(stops.stopRecoveryRate * 100).toFixed(0)}%（${stops.samples}笔止损）`, action: "优先验证止损是否过紧；只有后续观察继续确认时才调整结构止损。" });
  if (overall.samples >= 5 && overall.earlyExitRate != null && overall.earlyExitRate >= 0.4) findings.push({ priority: "medium", code: "early_exit", evidence: `退出后被标记“退出偏早”的比例 ${(overall.earlyExitRate * 100).toFixed(0)}%`, action: "优先优化退出/移动止损，不增加新的入场过滤条件。" });
  return { overall, cells, traders, setups, sides, exits, findings };
}
