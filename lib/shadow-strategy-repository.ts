import { and, desc, eq, like, or } from "drizzle-orm";
import { getDb } from "../db";
import { tradeCases } from "../db/schema";
import type { GateAnalysisPacket } from "./gate-client.ts";
import { assessTakeProfitViability, buildContractPlan, calculateContractPnl } from "./contract-simulation.ts";
import type { AppSettings } from "./repository.ts";
import { singleTradeRiskBudgetUsdt } from "./risk-policy.ts";
import { shadowCompletedWindow } from "./shadow-candle-window.ts";
import type { Candle } from "./signal-engine.ts";
import type { ShadowStrategyId, ShadowStrategySignal } from "./shadow-strategy-engine.ts";
import { calculateStrategyStatistics, evaluateStrategyPromotion } from "./strategy-promotion.ts";
import { deriveTradeLesson, evaluatePosition, type TradePositionSnapshot } from "./trade-lifecycle.ts";

const SHADOW_PREFIX = "shadow_v3:";
const SHADOW_COOLDOWN_MS = 30 * 60_000;

const STRATEGIES: { id: ShadowStrategyId; label: string }[] = [
  { id: "trend_pullback", label: "趋势回踩" },
  { id: "volatility_breakout", label: "波动收缩突破" },
  { id: "range_reversion", label: "震荡均值回归" },
  { id: "relative_strength", label: "相对强弱（实验）" },
];

function model(strategyId: ShadowStrategyId) {
  return `${SHADOW_PREFIX}${strategyId}`;
}

function strategyIdFromModel(value: string): ShadowStrategyId | null {
  if (!value.startsWith(SHADOW_PREFIX)) return null;
  const id = value.slice(SHADOW_PREFIX.length) as ShadowStrategyId;
  return STRATEGIES.some((strategy) => strategy.id === id) ? id : null;
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function positionSnapshot(row: typeof tradeCases.$inferSelect): TradePositionSnapshot {
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    entryAt: row.entryAt,
    entryPrice: row.entryPrice,
    initialStopPrice: row.initialStopPrice,
    currentStopPrice: row.currentStopPrice,
    takeProfit1Price: row.takeProfit1Price,
    takeProfit2Price: row.takeProfit2Price,
    target1HitAt: row.target1HitAt,
    maxHoldingMinutes: row.maxHoldingMinutes,
    maxPriceSeen: row.maxPriceSeen,
    minPriceSeen: row.minPriceSeen,
    adverseFlowCount: row.adverseFlowCount,
    confidence: row.confidence,
    regime: row.regime,
  };
}

export async function listOpenShadowTradeSymbols() {
  const rows = await getDb().select({ symbol: tradeCases.symbol }).from(tradeCases).where(and(
    eq(tradeCases.status, "holding"),
    like(tradeCases.simulationModel, `${SHADOW_PREFIX}%`),
  ));
  return [...new Set(rows.map((row) => row.symbol))];
}

async function reconcileShadowTrade(
  row: typeof tradeCases.$inferSelect,
  packet: GateAnalysisPacket,
  candles5m: Candle[],
  signal: ShadowStrategySignal | undefined,
  settings: AppSettings,
) {
  const db = getDb();
  // For shadow rows, lastEvaluatedAt is deliberately the end of the latest
  // fully consumed 5m candle, not merely the wall-clock time of the last scan.
  // That lets a rotating free-worker scan catch up without either skipping a
  // completed bar or borrowing high/low data from before the trade existed.
  const fromCoveredThrough = Math.max(row.entryAt, row.lastEvaluatedAt);
  const priceWindow = shadowCompletedWindow(candles5m, fromCoveredThrough, packet.observedAt);
  const score = signal?.score ?? packet.decision.directionalScore;
  const metrics = signal?.metrics ?? packet.decision.metrics;
  const evaluation = evaluatePosition(positionSnapshot(row), {
    observedAt: packet.observedAt,
    price: packet.market.futuresPrice,
    highPrice: priceWindow.highPrice,
    lowPrice: priceWindow.lowPrice,
    directionalScore: score,
    confirmationCount: signal?.reasons.length ?? packet.decision.diagnostics.confirmationCount,
    macroEventRisk: packet.market.macroEventRisk ?? 0,
    metrics,
    roundTripCostBps: settings.roundTripCostBps,
  });
  const currentPnl = calculateContractPnl(row.contractNotionalUsdt, evaluation.grossMovePct, evaluation.estimatedCostPct);
  const where = and(eq(tradeCases.id, row.id), eq(tradeCases.status, "holding"), eq(tradeCases.simulationModel, row.simulationModel));
  const common = {
    currentStopPrice: evaluation.currentStopPrice,
    target1HitAt: evaluation.target1HitAt,
    lastPrice: packet.market.futuresPrice,
    lastEvaluatedAt: priceWindow.coveredThroughAt ?? row.lastEvaluatedAt,
    maxPriceSeen: evaluation.maxPriceSeen,
    minPriceSeen: evaluation.minPriceSeen,
    adverseFlowCount: evaluation.adverseFlowCount,
    unrealizedGrossPct: evaluation.grossMovePct,
    unrealizedNetPct: evaluation.netMovePct,
    unrealizedGrossUsdt: currentPnl.grossPnlUsdt,
    unrealizedNetUsdt: currentPnl.netPnlUsdt,
    progressR: evaluation.progressR,
  };
  if (!evaluation.close) {
    await db.update(tradeCases).set(common).where(where);
    return "holding" as const;
  }
  const lesson = deriveTradeLesson(positionSnapshot(row), evaluation, parseJson(row.entryEvidenceJson, []), metrics);
  const amountPnl = calculateContractPnl(row.contractNotionalUsdt, evaluation.grossMovePct, evaluation.estimatedCostPct);
  await db.update(tradeCases).set({
    ...common,
    activeKey: null,
    status: "closed",
    exitAt: packet.observedAt,
    exitPrice: evaluation.exitPrice ?? packet.market.futuresPrice,
    exitCode: evaluation.exitCode,
    exitReason: evaluation.exitReason,
    exitEvidenceJson: JSON.stringify([
      ...evaluation.exitEvidence,
      priceWindow.count > 1 ? `后台轮转期间补查 ${priceWindow.count} 根完整 5m K 线，未遗漏期间触价` : "按开仓后的完整 5m 价格窗口判定",
    ]),
    exitMetricsJson: JSON.stringify(metrics),
    grossMovePct: evaluation.grossMovePct,
    estimatedCostPct: evaluation.estimatedCostPct,
    netMovePct: evaluation.netMovePct,
    unrealizedGrossUsdt: 0,
    unrealizedNetUsdt: 0,
    grossPnlUsdt: amountPnl.grossPnlUsdt,
    estimatedCostUsdt: amountPnl.estimatedCostUsdt,
    netPnlUsdt: amountPnl.netPnlUsdt,
    accountBalanceAfterUsdt: settings.trialCapitalUsdt,
    mfePct: evaluation.mfePct,
    maePct: evaluation.maePct,
    holdMinutes: evaluation.holdMinutes,
    lessonJson: JSON.stringify(lesson),
    learningApplied: true,
  }).where(where);
  return "closed" as const;
}

async function recentShadowClose(symbol: string, strategyId: ShadowStrategyId) {
  const [row] = await getDb().select({ exitAt: tradeCases.exitAt }).from(tradeCases).where(and(
    eq(tradeCases.symbol, symbol),
    eq(tradeCases.status, "closed"),
    eq(tradeCases.simulationModel, model(strategyId)),
  )).orderBy(desc(tradeCases.exitAt)).limit(1);
  return row?.exitAt ?? null;
}

async function openShadowTrade(packet: GateAnalysisPacket, signal: ShadowStrategySignal, settings: AppSettings) {
  if (signal.state !== "ready" || signal.side === "WAIT" || !signal.entryPlan?.ready) return false;
  const db = getDb();
  const strategyModel = model(signal.strategyId);
  const activeKey = `shadow:${signal.strategyId}:${packet.symbol}`;
  const [existing] = await db.select({ id: tradeCases.id }).from(tradeCases).where(and(
    eq(tradeCases.status, "holding"),
    eq(tradeCases.simulationModel, strategyModel),
    eq(tradeCases.symbol, packet.symbol),
  )).limit(1);
  if (existing) return false;
  const lastClose = await recentShadowClose(packet.symbol, signal.strategyId);
  if (lastClose != null && packet.observedAt - lastClose < SHADOW_COOLDOWN_MS) return false;

  const researchEquity = Math.max(10, settings.trialCapitalUsdt);
  const contract = buildContractPlan({
    side: signal.side,
    entryPrice: signal.entryPlan.entryPrice,
    stopLossPrice: signal.entryPlan.stopLossPrice,
    atrPct: signal.regime.atrPct,
    dataQuality: packet.decision.dataQuality,
    confidence: signal.confidence,
    liquidityVolumeUsd: packet.market.volumeUsd,
    accountEquityUsdt: researchEquity,
    availableMarginUsdt: researchEquity,
    requestedRiskUsdt: singleTradeRiskBudgetUsdt(researchEquity),
  });
  if (contract.contractNotionalUsdt < 1 || contract.marginUsdt < 1) return false;
  const viability = assessTakeProfitViability({
    side: signal.side,
    entryPrice: signal.entryPlan.entryPrice,
    takeProfitPrice: signal.entryPlan.takeProfit2Price,
    notionalUsdt: contract.contractNotionalUsdt,
    accountEquityUsdt: researchEquity,
    roundTripCostBps: settings.roundTripCostBps,
  });
  if (!viability.passed) return false;

  const id = crypto.randomUUID();
  const inserted = await db.insert(tradeCases).values({
    id,
    activeKey,
    symbol: packet.symbol,
    status: "holding",
    side: signal.side,
    confidence: signal.confidence,
    posteriorLong: signal.side === "LONG" ? 0.5 + Math.abs(signal.score) / 2 : 0.5 - Math.abs(signal.score) / 2,
    dataQuality: packet.decision.dataQuality,
    regime: `${signal.regime.kind} · ${signal.regime.reason}`,
    entryDirectionalScore: signal.score,
    entryAt: packet.observedAt,
    entryPrice: signal.entryPlan.entryPrice,
    entryLow: signal.entryPlan.entryZone[0],
    entryHigh: signal.entryPlan.entryZone[1],
    entryTrigger: `${signal.label}：${signal.reasons.join("、")}`,
    entryThesis: signal.thesis,
    entryChecksJson: JSON.stringify(signal.entryPlan.checks),
    exitRulesJson: JSON.stringify(signal.entryPlan.exitRules),
    entryEvidenceJson: JSON.stringify(signal.reasons.map((title) => ({ title }))),
    entryCounterEvidenceJson: JSON.stringify(signal.blockers.map((detail) => ({ title: "未通过项", detail }))),
    entryMetricsJson: JSON.stringify(signal.metrics),
    entrySnapshotJson: JSON.stringify({ strategyId: signal.strategyId, shadowOnly: true, ruleset: SHADOW_PREFIX.slice(0, -1), regime: signal.regime, market: packet.market }),
    initialStopPrice: signal.entryPlan.stopLossPrice,
    currentStopPrice: signal.entryPlan.stopLossPrice,
    takeProfit1Price: signal.entryPlan.takeProfit1Price,
    takeProfit2Price: signal.entryPlan.takeProfit2Price,
    target1HitAt: null,
    maxHoldingMinutes: signal.entryPlan.maxHoldingMinutes,
    plannedRiskPct: signal.entryPlan.plannedRiskPct,
    riskReward: signal.entryPlan.riskReward,
    riskBudgetUsdt: contract.plannedLossUsdt,
    suggestedNotionalUsdt: contract.contractNotionalUsdt,
    contractType: contract.contractType,
    marginMode: contract.marginMode,
    leverage: contract.leverage,
    leverageReason: `影子策略 ${signal.label}；${contract.leverageReason}`,
    marginUsdt: contract.marginUsdt,
    contractNotionalUsdt: contract.contractNotionalUsdt,
    quantity: contract.quantity,
    estimatedLiquidationPrice: contract.estimatedLiquidationPrice,
    simulationModel: strategyModel,
    accountBalanceBeforeUsdt: researchEquity,
    accountBalanceAfterUsdt: null,
    lastPrice: packet.market.futuresPrice,
    // Until the first whole post-entry candle closes, keep the entry time as
    // the coverage boundary. This prevents a scan at 10:02 from later using
    // the 10:00-10:05 candle's pre-entry high/low.
    lastEvaluatedAt: packet.observedAt,
    maxPriceSeen: packet.market.futuresPrice,
    minPriceSeen: packet.market.futuresPrice,
    adverseFlowCount: 0,
    unrealizedGrossPct: 0,
    unrealizedNetPct: -settings.roundTripCostBps / 100,
    unrealizedGrossUsdt: 0,
    unrealizedNetUsdt: -contract.contractNotionalUsdt * settings.roundTripCostBps / 10_000,
    progressR: 0,
    learningApplied: true,
  }).onConflictDoNothing().returning({ id: tradeCases.id });
  return inserted.length > 0;
}

export async function processShadowStrategies(packet: GateAnalysisPacket, candles5m: Candle[], signals: ShadowStrategySignal[], settings: AppSettings) {
  const db = getDb();
  const open = await db.select().from(tradeCases).where(and(
    eq(tradeCases.symbol, packet.symbol),
    eq(tradeCases.status, "holding"),
    like(tradeCases.simulationModel, `${SHADOW_PREFIX}%`),
  ));
  let closed = 0;
  for (const row of open) {
    const strategyId = strategyIdFromModel(row.simulationModel);
    if (!strategyId) continue;
    const result = await reconcileShadowTrade(row, packet, candles5m, signals.find((signal) => signal.strategyId === strategyId), settings);
    if (result === "closed") closed += 1;
  }
  let opened = 0;
  for (const signal of signals) {
    if (await openShadowTrade(packet, signal, settings)) opened += 1;
  }
  return { opened, closed, evaluated: signals.length };
}

export async function getStrategyLabDashboard() {
  const db = getDb();
  const rows = await db.select({
    simulationModel: tradeCases.simulationModel,
    status: tradeCases.status,
    netMovePct: tradeCases.netMovePct,
    exitAt: tradeCases.exitAt,
    entryAt: tradeCases.entryAt,
    regime: tradeCases.regime,
  }).from(tradeCases).where(or(
    eq(tradeCases.simulationModel, "contract_v2"),
    like(tradeCases.simulationModel, `${SHADOW_PREFIX}%`),
  )).orderBy(desc(tradeCases.entryAt)).limit(2500);

  const baseline = rows.filter((row) => row.simulationModel === "contract_v2");
  const baselineStats = calculateStrategyStatistics(baseline.filter((row) => row.status === "closed").map((row) => ({ netMovePct: row.netMovePct, exitAt: row.exitAt, regime: row.regime })));
  const strategies = STRATEGIES.map((strategy) => {
    const strategyRows = rows.filter((row) => row.simulationModel === model(strategy.id));
    const closed = strategyRows.filter((row) => row.status === "closed");
    const stats = calculateStrategyStatistics(closed.map((row) => ({ netMovePct: row.netMovePct, exitAt: row.exitAt, regime: row.regime })));
    return {
      id: strategy.id,
      label: strategy.label,
      mode: "shadow" as const,
      openCount: strategyRows.filter((row) => row.status === "holding").length,
      stats,
      promotion: evaluateStrategyPromotion(strategy.id, stats),
    };
  });
  return {
    observedAt: Date.now(),
    note: "新策略只做影子模拟，不会进入 Gate 实盘；达到候选线也必须人工批准。",
    baseline: {
      id: "baseline_v1" as const,
      label: "Sentinel Baseline V1",
      mode: "baseline" as const,
      openCount: baseline.filter((row) => row.status === "holding").length,
      stats: baselineStats,
    },
    strategies,
  };
}
