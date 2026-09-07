import { ROUND_TRIP_FRICTION_RATE, type PaperPosition } from "./liquidity-core.ts";

export const PAPER_INITIAL_EQUITY = 1_000;
export const PAPER_BANKRUPTCY_EQUITY = PAPER_INITIAL_EQUITY * 0.3;
export const MAX_CYCLE_TRADES = 250;

export type CycleTradeDiagnostic = {
  id: string;
  symbol: string;
  scenario: PaperPosition["scenario"];
  side: PaperPosition["side"];
  entryAt: number;
  exitAt: number;
  holdingSeconds: number;
  entryPrice: number;
  exitPrice: number;
  initialStop: number;
  target: number;
  notional: number;
  plannedRisk: number;
  plannedNetRewardRisk: number;
  grossPnl: number;
  costs: number;
  netPnl: number;
  mfeRate: number;
  maeRate: number;
  targetProgress: number;
  stopUse: number;
  directionCorrectAtExit: boolean;
  feeCoveringMove: boolean;
  targetReached: boolean;
  stopReached: boolean;
  exitReason: string;
};

export type PaperCycle = {
  number: number;
  startedAt: number;
  startingEquity: number;
  peakEquity: number;
  trades: CycleTradeDiagnostic[];
};

type Breakdown = Record<string, { trades: number; wins: number; netPnl: number }>;

export type BankruptcyReport = {
  id: string;
  cycleNumber: number;
  startedAt: number;
  endedAt: number;
  startingEquity: number;
  endingEquity: number;
  bankruptcyLine: number;
  loss: number;
  maxDrawdownRate: number;
  performance: { trades: number; wins: number; losses: number; breakeven: number; grossPnl: number; costs: number; netPnl: number; profitFactor: number | null; expectancy: number };
  direction: { correctAtExit: number; correctAtExitRate: number; feeCoveringMoves: number; feeCoveringMoveRate: number };
  entries: { averagePlannedNetRewardRisk: number; belowMinimumCount: number };
  stops: { reached: number; structuralStopExits: number; averageMaximumAdverseVsStop: number; stoppedAfterFavorableMove: number };
  targets: { reached: number; reachedRate: number; averageProgress: number };
  exits: { averageHoldingSeconds: number; underOneMinute: number; reasons: Record<string, number> };
  breakdown: { symbols: Breakdown; scenarios: Breakdown; sides: Breakdown };
  rootCauses: string[];
  trades: CycleTradeDiagnostic[];
};

const rate = (count: number, total: number) => total > 0 ? count / total : 0;

export function startPaperCycle(now: number, startingEquity = PAPER_INITIAL_EQUITY, number = 1): PaperCycle {
  return { number, startedAt: now, startingEquity, peakEquity: startingEquity, trades: [] };
}

export function diagnoseClosedPosition(position: PaperPosition): CycleTradeDiagnostic {
  if (position.status !== "CLOSED" || position.exitAt == null || position.exitPrice == null) throw new Error("closed PAPER position required");
  const direction = position.side === "LONG" ? 1 : -1;
  const favorablePrice = position.maxFavorablePrice ?? (position.side === "LONG" ? Math.max(position.entryPrice, position.exitPrice) : Math.min(position.entryPrice, position.exitPrice));
  const adversePrice = position.maxAdversePrice ?? (position.side === "LONG" ? Math.min(position.entryPrice, position.exitPrice) : Math.max(position.entryPrice, position.exitPrice));
  const mfeRate = Math.max(0, (favorablePrice - position.entryPrice) / Math.max(position.entryPrice, 1e-9) * direction);
  const maeRate = Math.max(0, (position.entryPrice - adversePrice) / Math.max(position.entryPrice, 1e-9) * direction);
  const targetRate = Math.abs(position.currentTarget - position.entryPrice) / Math.max(position.entryPrice, 1e-9);
  const stopRate = Math.abs(position.entryPrice - position.initialStop) / Math.max(position.entryPrice, 1e-9);
  const costs = position.feesAndSlippage ?? position.notional * ROUND_TRIP_FRICTION_RATE;
  const netPnl = position.realizedPnl ?? 0;
  const grossPnl = netPnl + costs;
  return {
    id: position.id, symbol: position.symbol, scenario: position.scenario, side: position.side,
    entryAt: position.entryAt, exitAt: position.exitAt, holdingSeconds: Math.max(0, (position.exitAt - position.entryAt) / 1_000),
    entryPrice: position.entryPrice, exitPrice: position.exitPrice, initialStop: position.initialStop, target: position.currentTarget,
    notional: position.notional, plannedRisk: position.plannedRisk,
    plannedNetRewardRisk: Math.max(0, targetRate - ROUND_TRIP_FRICTION_RATE) / Math.max(stopRate + ROUND_TRIP_FRICTION_RATE, 1e-9),
    grossPnl, costs, netPnl, mfeRate, maeRate,
    targetProgress: targetRate > 0 ? mfeRate / targetRate : 0,
    stopUse: stopRate > 0 ? maeRate / stopRate : 0,
    directionCorrectAtExit: grossPnl > 0,
    feeCoveringMove: mfeRate >= ROUND_TRIP_FRICTION_RATE,
    targetReached: position.side === "LONG" ? favorablePrice >= position.currentTarget : favorablePrice <= position.currentTarget,
    stopReached: position.side === "LONG" ? adversePrice <= position.initialStop : adversePrice >= position.initialStop,
    exitReason: position.exitReason ?? "UNKNOWN",
  };
}

export function recordCycleTrade(cycle: PaperCycle, position: PaperPosition, equity: number): PaperCycle {
  const diagnostic = diagnoseClosedPosition(position);
  const trades = [...cycle.trades.filter((item) => item.id !== diagnostic.id), diagnostic].slice(-MAX_CYCLE_TRADES);
  return { ...cycle, peakEquity: Math.max(cycle.peakEquity, equity), trades };
}

function breakdown(trades: CycleTradeDiagnostic[], key: (trade: CycleTradeDiagnostic) => string): Breakdown {
  const output: Breakdown = {};
  for (const trade of trades) {
    const name = key(trade);
    const row = output[name] ?? { trades: 0, wins: 0, netPnl: 0 };
    row.trades += 1;
    row.wins += trade.netPnl > 0 ? 1 : 0;
    row.netPnl += trade.netPnl;
    output[name] = row;
  }
  return output;
}

export function buildBankruptcyReport(cycle: PaperCycle, endedAt: number, endingEquity: number): BankruptcyReport {
  const trades = cycle.trades;
  const wins = trades.filter((item) => item.netPnl > 0);
  const losses = trades.filter((item) => item.netPnl < 0);
  const grossPnl = trades.reduce((sum, item) => sum + item.grossPnl, 0);
  const costs = trades.reduce((sum, item) => sum + item.costs, 0);
  const netPnl = trades.reduce((sum, item) => sum + item.netPnl, 0);
  const correctAtExit = trades.filter((item) => item.directionCorrectAtExit).length;
  const feeCoveringMoves = trades.filter((item) => item.feeCoveringMove).length;
  const targetReached = trades.filter((item) => item.targetReached).length;
  const structuralStops = trades.filter((item) => item.exitReason === "STRUCTURAL_STOP").length;
  const stoppedAfterFavorableMove = trades.filter((item) => item.exitReason === "STRUCTURAL_STOP" && item.feeCoveringMove).length;
  const underOneMinute = trades.filter((item) => item.holdingSeconds < 60).length;
  const reasons = trades.reduce<Record<string, number>>((output, item) => ({ ...output, [item.exitReason]: (output[item.exitReason] ?? 0) + 1 }), {});
  const average = (selector: (item: CycleTradeDiagnostic) => number) => trades.length ? trades.reduce((sum, item) => sum + selector(item), 0) / trades.length : 0;
  const rootCauses: string[] = [];
  if (costs > Math.max(1, Math.abs(netPnl)) * 0.5) rootCauses.push(`交易成本占净亏损的 ${Math.round(costs / Math.max(1, Math.abs(netPnl)) * 100)}%，换手和仓位成本过高`);
  if (rate(correctAtExit, trades.length) < 0.45) rootCauses.push(`出场时方向正确率仅 ${Math.round(rate(correctAtExit, trades.length) * 100)}%，方向选择需要重新校准`);
  if (rate(feeCoveringMoves, trades.length) < 0.45) rootCauses.push(`仅 ${Math.round(rate(feeCoveringMoves, trades.length) * 100)}% 的订单曾产生足以覆盖成本的顺向波动，入场位置质量不足`);
  if (rate(targetReached, trades.length) < 0.2) rootCauses.push(`目标到达率仅 ${Math.round(rate(targetReached, trades.length) * 100)}%，目标区域或路径概率可能估计过高`);
  if (rate(structuralStops, trades.length) > 0.4) rootCauses.push(`结构止损占 ${Math.round(rate(structuralStops, trades.length) * 100)}%，需结合最大不利波动检查止损是否过紧`);
  if (rate(underOneMinute, trades.length) > 0.4) rootCauses.push(`持仓不足一分钟的订单占 ${Math.round(rate(underOneMinute, trades.length) * 100)}%，退出噪声或过度交易仍然明显`);
  const scenarios = breakdown(trades, (item) => item.scenario);
  const worst = Object.entries(scenarios).sort((a, b) => a[1].netPnl - b[1].netPnl)[0];
  if (worst?.[1].netPnl < 0) rootCauses.push(`${worst[0]} 是本周期拖累最大的市场状态，净结果 ${worst[1].netPnl.toFixed(2)} U`);
  if (!rootCauses.length) rootCauses.push("样本没有单一主导故障，需要结合逐单价格、成本、止损、目标进度和退出时机继续检查");
  const positive = wins.reduce((sum, item) => sum + item.netPnl, 0);
  const negative = Math.abs(losses.reduce((sum, item) => sum + item.netPnl, 0));
  return {
    id: `paper-bankruptcy:${cycle.number}:${endedAt}`, cycleNumber: cycle.number, startedAt: cycle.startedAt, endedAt,
    startingEquity: cycle.startingEquity, endingEquity, bankruptcyLine: PAPER_BANKRUPTCY_EQUITY,
    loss: cycle.startingEquity - endingEquity, maxDrawdownRate: 1 - endingEquity / Math.max(cycle.peakEquity, 1e-9),
    performance: { trades: trades.length, wins: wins.length, losses: losses.length, breakeven: trades.length - wins.length - losses.length,
      grossPnl, costs, netPnl, profitFactor: negative > 0 ? positive / negative : null, expectancy: trades.length ? netPnl / trades.length : 0 },
    direction: { correctAtExit, correctAtExitRate: rate(correctAtExit, trades.length), feeCoveringMoves, feeCoveringMoveRate: rate(feeCoveringMoves, trades.length) },
    entries: { averagePlannedNetRewardRisk: average((item) => item.plannedNetRewardRisk), belowMinimumCount: trades.filter((item) => item.plannedNetRewardRisk < 1.2).length },
    stops: { reached: trades.filter((item) => item.stopReached).length, structuralStopExits: structuralStops,
      averageMaximumAdverseVsStop: average((item) => item.stopUse), stoppedAfterFavorableMove },
    targets: { reached: targetReached, reachedRate: rate(targetReached, trades.length), averageProgress: average((item) => item.targetProgress) },
    exits: { averageHoldingSeconds: average((item) => item.holdingSeconds), underOneMinute, reasons },
    breakdown: { symbols: breakdown(trades, (item) => item.symbol), scenarios, sides: breakdown(trades, (item) => item.side) },
    rootCauses, trades,
  };
}

export function paperCycleSummary(cycle: PaperCycle, currentEquity: number) {
  return { number: cycle.number, startedAt: cycle.startedAt, startingEquity: cycle.startingEquity, currentEquity,
    bankruptcyLine: PAPER_BANKRUPTCY_EQUITY, peakEquity: cycle.peakEquity, trades: cycle.trades.length,
    drawdownRate: 1 - currentEquity / Math.max(cycle.peakEquity, 1e-9) };
}
