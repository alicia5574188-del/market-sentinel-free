import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import { alertEvents, appSettings, pushSubscriptions, regimeState, scanRuns, strategyMemory, symbolLifecycle, tradeCases } from "../db/schema";
import type { GateAnalysisPacket, GatePositionQuote } from "./gate-client";
import { assessTakeProfitViability, buildContractPlan, calculateContractPnl, type ContractPlan, type TakeProfitViability } from "./contract-simulation";
import {
  accumulateMemory,
  deriveTradeLesson,
  evaluatePosition,
  type ExperienceBySide,
  type HistoricalExperience,
  type MemoryAccumulator,
  type TradePositionSnapshot,
} from "./trade-lifecycle.ts";

export type AppSettings = typeof appSettings.$inferSelect;
export type AlertRecord = typeof alertEvents.$inferSelect;
export type TradeRecord = typeof tradeCases.$inferSelect;
export type MemoryRecord = typeof strategyMemory.$inferSelect;

const DEFAULT_SETTINGS: typeof appSettings.$inferInsert = {
  id: 1,
  alertStyle: "balanced",
  universeLimit: 30,
  deepScanLimit: 8,
  minConfidence: 72,
  coreSymbolsJson: '["BTC_USDT","ETH_USDT","SOL_USDT","HYPE_USDT"]',
  roundTripCostBps: 8,
  trialCapitalUsdt: 1000,
  maxRiskPerAlertUsdt: 10,
  dailyPauseUsdt: 30,
  maxDrawdownUsdt: 100,
  scanEnabled: true,
  pushEnabled: false,
  updatedAt: Date.now(),
};

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export async function getSettings(): Promise<AppSettings> {
  const db = getDb();
  const [existing] = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  if (existing) return existing;
  await db.insert(appSettings).values(DEFAULT_SETTINGS).onConflictDoNothing();
  const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  if (!settings) throw new Error("Unable to initialize settings");
  return settings;
}

export async function updateSettings(patch: Partial<Pick<AppSettings,
  "alertStyle" | "universeLimit" | "deepScanLimit" | "minConfidence" | "roundTripCostBps" |
  "trialCapitalUsdt" | "maxRiskPerAlertUsdt" | "dailyPauseUsdt" | "maxDrawdownUsdt" | "scanEnabled" | "pushEnabled"
>> & { coreSymbols?: string[] }) {
  const db = getDb();
  await getSettings();
  const values: Partial<typeof appSettings.$inferInsert> = { updatedAt: Date.now() };
  if (patch.alertStyle && ["early", "balanced", "confirmed"].includes(patch.alertStyle)) values.alertStyle = patch.alertStyle;
  if (Number.isFinite(patch.universeLimit)) values.universeLimit = Math.round(Math.min(50, Math.max(4, patch.universeLimit!)));
  if (Number.isFinite(patch.deepScanLimit)) values.deepScanLimit = Math.round(Math.min(12, Math.max(2, patch.deepScanLimit!)));
  if (Number.isFinite(patch.minConfidence)) values.minConfidence = Math.round(Math.min(90, Math.max(55, patch.minConfidence!)));
  if (Number.isFinite(patch.roundTripCostBps)) values.roundTripCostBps = Math.min(100, Math.max(0, patch.roundTripCostBps!));
  if (Number.isFinite(patch.trialCapitalUsdt)) values.trialCapitalUsdt = Math.min(1_000_000, Math.max(10, patch.trialCapitalUsdt!));
  if (Number.isFinite(patch.maxRiskPerAlertUsdt)) values.maxRiskPerAlertUsdt = Math.min(10, Math.max(0.1, patch.maxRiskPerAlertUsdt!));
  if (Number.isFinite(patch.dailyPauseUsdt)) values.dailyPauseUsdt = Math.min(100_000, Math.max(0.1, patch.dailyPauseUsdt!));
  if (Number.isFinite(patch.maxDrawdownUsdt)) values.maxDrawdownUsdt = Math.min(500_000, Math.max(1, patch.maxDrawdownUsdt!));
  if (typeof patch.scanEnabled === "boolean") values.scanEnabled = patch.scanEnabled;
  if (typeof patch.pushEnabled === "boolean") values.pushEnabled = patch.pushEnabled;
  if (patch.coreSymbols) values.coreSymbolsJson = JSON.stringify(patch.coreSymbols.filter((symbol) => /^[A-Z0-9]{2,18}_USDT$/.test(symbol)).slice(0, 20));
  await db.update(appSettings).set(values).where(eq(appSettings.id, 1));
  return getSettings();
}

export function publicSettings(settings: AppSettings) {
  return { ...settings, coreSymbols: parseJson<string[]>(settings.coreSymbolsJson, []) };
}

export async function getPriorLong(symbol: string) {
  const db = getDb();
  const [state] = await db.select().from(regimeState).where(eq(regimeState.symbol, symbol)).limit(1);
  return state?.posteriorLong ?? 0.5;
}

export async function saveRegime(packet: GateAnalysisPacket) {
  const db = getDb();
  await db.insert(regimeState).values({
    symbol: packet.symbol,
    posteriorLong: packet.decision.posteriorLong,
    regime: packet.decision.regime,
    lastScore: packet.decision.directionalScore,
    updatedAt: packet.observedAt,
  }).onConflictDoUpdate({
    target: regimeState.symbol,
    set: {
      posteriorLong: packet.decision.posteriorLong,
      regime: packet.decision.regime,
      lastScore: packet.decision.directionalScore,
      updatedAt: packet.observedAt,
    },
  });
}

function presentMemory(row: MemoryRecord) {
  const bayesianWinRate = row.bayesAlpha / Math.max(row.bayesAlpha + row.bayesBeta, 1);
  return {
    ...row,
    bayesianWinRate,
    profitFactor: row.grossLossSumPct < 0 ? row.grossProfitSumPct / Math.abs(row.grossLossSumPct) : row.grossProfitSumPct > 0 ? null : 0,
    stopRate: row.sampleCount ? row.stopExits / row.sampleCount : 0,
    regimeBreakdown: parseJson(row.regimeBreakdownJson, {}),
    lastLesson: parseJson(row.lastLessonJson, null),
  };
}

function toExperience(row: MemoryRecord | undefined): HistoricalExperience | null {
  if (!row) return null;
  const presented = presentMemory(row);
  return {
    sampleCount: row.sampleCount,
    wins: row.wins,
    losses: row.losses,
    bayesianWinRate: presented.bayesianWinRate,
    averageNetPct: row.averageNetPct,
    averageMfePct: row.averageMfePct,
    averageMaePct: row.averageMaePct,
    profitFactor: presented.profitFactor,
    stopRate: presented.stopRate,
    lastLesson: presented.lastLesson,
  };
}

export async function getExperience(symbol: string): Promise<ExperienceBySide> {
  const db = getDb();
  const rows = await db.select().from(strategyMemory).where(eq(strategyMemory.symbol, symbol));
  return {
    LONG: toExperience(rows.find((row) => row.side === "LONG")),
    SHORT: toExperience(rows.find((row) => row.side === "SHORT")),
  };
}

function presentTrade(row: TradeRecord) {
  return {
    ...row,
    entryChecks: parseJson(row.entryChecksJson, []),
    exitRules: parseJson(row.exitRulesJson, []),
    entryEvidence: parseJson(row.entryEvidenceJson, []),
    entryCounterEvidence: parseJson(row.entryCounterEvidenceJson, []),
    entryMetrics: parseJson(row.entryMetricsJson, []),
    entrySnapshot: parseJson(row.entrySnapshotJson, {}),
    exitEvidence: parseJson(row.exitEvidenceJson, []),
    exitMetrics: parseJson(row.exitMetricsJson, []),
    lesson: parseJson(row.lessonJson, null),
  };
}

async function getOpenTradeRow(symbol: string) {
  const db = getDb();
  const [row] = await db.select().from(tradeCases).where(and(
    eq(tradeCases.activeKey, symbol),
    eq(tradeCases.status, "holding"),
    eq(tradeCases.simulationModel, "contract_v2"),
  )).limit(1);
  return row ?? null;
}

export async function getOpenTrade(symbol: string) {
  const row = await getOpenTradeRow(symbol);
  return row ? presentTrade(row) : null;
}

export async function getTrade(id: string) {
  const db = getDb();
  const [row] = await db.select().from(tradeCases).where(eq(tradeCases.id, id)).limit(1);
  return row ? presentTrade(row) : null;
}

export async function listOpenTradeSymbols() {
  const db = getDb();
  const rows = await db.select({ symbol: tradeCases.symbol }).from(tradeCases).where(and(
    eq(tradeCases.status, "holding"),
    eq(tradeCases.simulationModel, "contract_v2"),
  ));
  return rows.map((row) => row.symbol);
}

export async function listOpenTrades() {
  const db = getDb();
  const rows = await db.select().from(tradeCases).where(and(
    eq(tradeCases.status, "holding"),
    eq(tradeCases.simulationModel, "contract_v2"),
  )).orderBy(desc(tradeCases.entryAt));
  return rows.map(presentTrade);
}

export type AccountSnapshot = {
  startingCapitalUsdt: number;
  realizedPnlUsdt: number;
  unrealizedPnlUsdt: number;
  realizedBalanceUsdt: number;
  equityUsdt: number;
  usedMarginUsdt: number;
  availableMarginUsdt: number;
};

export async function getAccountSnapshot(settingsOverride?: AppSettings): Promise<AccountSnapshot> {
  const db = getDb();
  const settings = settingsOverride ?? await getSettings();
  const [closed, open] = await Promise.all([
    db.select({ netPnlUsdt: tradeCases.netPnlUsdt }).from(tradeCases).where(and(
      eq(tradeCases.status, "closed"),
      eq(tradeCases.simulationModel, "contract_v2"),
    )),
    db.select({ marginUsdt: tradeCases.marginUsdt, unrealizedNetUsdt: tradeCases.unrealizedNetUsdt }).from(tradeCases).where(and(
      eq(tradeCases.status, "holding"),
      eq(tradeCases.simulationModel, "contract_v2"),
    )),
  ]);
  const realizedPnlUsdt = closed.reduce((sum, row) => sum + (row.netPnlUsdt ?? 0), 0);
  const unrealizedPnlUsdt = open.reduce((sum, row) => sum + row.unrealizedNetUsdt, 0);
  const usedMarginUsdt = open.reduce((sum, row) => sum + row.marginUsdt, 0);
  const realizedBalanceUsdt = settings.trialCapitalUsdt + realizedPnlUsdt;
  const equityUsdt = realizedBalanceUsdt + unrealizedPnlUsdt;
  return {
    startingCapitalUsdt: settings.trialCapitalUsdt,
    realizedPnlUsdt,
    unrealizedPnlUsdt,
    realizedBalanceUsdt,
    equityUsdt,
    usedMarginUsdt,
    availableMarginUsdt: Math.max(0, equityUsdt - usedMarginUsdt),
  };
}

async function upsertLifecycle(values: typeof symbolLifecycle.$inferInsert) {
  const db = getDb();
  await db.insert(symbolLifecycle).values(values).onConflictDoUpdate({
    target: symbolLifecycle.symbol,
    set: {
      state: values.state,
      side: values.side,
      activeTradeId: values.activeTradeId ?? null,
      cooldownUntil: values.cooldownUntil ?? null,
      lastTransitionAt: values.lastTransitionAt,
      lastObservedAt: values.lastObservedAt,
      decisionJson: values.decisionJson ?? "{}",
    },
  });
}

function memoryAccumulator(row: MemoryRecord | undefined): MemoryAccumulator | null {
  if (!row) return null;
  return {
    sampleCount: row.sampleCount,
    wins: row.wins,
    losses: row.losses,
    bayesAlpha: row.bayesAlpha,
    bayesBeta: row.bayesBeta,
    averageNetPct: row.averageNetPct,
    averageMfePct: row.averageMfePct,
    averageMaePct: row.averageMaePct,
    grossProfitSumPct: row.grossProfitSumPct,
    grossLossSumPct: row.grossLossSumPct,
    targetExits: row.targetExits,
    stopExits: row.stopExits,
    reversalExits: row.reversalExits,
    timeoutExits: row.timeoutExits,
  };
}

async function applyTradeLearning(trade: TradeRecord) {
  if (trade.simulationModel !== "contract_v2" || trade.status !== "closed" || trade.learningApplied || trade.netMovePct == null || trade.mfePct == null || trade.maePct == null) return;
  const db = getDb();
  const id = `${trade.symbol}:${trade.side}`;
  const [current] = await db.select().from(strategyMemory).where(eq(strategyMemory.id, id)).limit(1);
  if (current?.lastAppliedTradeId === trade.id) {
    await db.update(tradeCases).set({ learningApplied: true }).where(eq(tradeCases.id, trade.id));
    return;
  }
  const next = accumulateMemory(memoryAccumulator(current), {
    netMovePct: trade.netMovePct,
    mfePct: trade.mfePct,
    maePct: trade.maePct,
    exitCode: trade.exitCode,
  });
  const breakdown = parseJson<Record<string, { count: number; wins: number; netSumPct: number }>>(current?.regimeBreakdownJson ?? "{}", {});
  const regime = breakdown[trade.regime] ?? { count: 0, wins: 0, netSumPct: 0 };
  breakdown[trade.regime] = { count: regime.count + 1, wins: regime.wins + (trade.netMovePct > 0 ? 1 : 0), netSumPct: regime.netSumPct + trade.netMovePct };
  const values: typeof strategyMemory.$inferInsert = {
    id,
    symbol: trade.symbol,
    side: trade.side,
    ...next,
    regimeBreakdownJson: JSON.stringify(breakdown),
    lastLessonJson: trade.lessonJson,
    lastAppliedTradeId: trade.id,
    updatedAt: trade.exitAt ?? Date.now(),
  };
  await db.insert(strategyMemory).values(values).onConflictDoUpdate({ target: strategyMemory.id, set: values });
  await db.update(tradeCases).set({ learningApplied: true }).where(eq(tradeCases.id, trade.id));
}

async function applyPendingLearning(symbol: string) {
  const db = getDb();
  const pending = await db.select().from(tradeCases).where(and(
    eq(tradeCases.symbol, symbol),
    eq(tradeCases.status, "closed"),
    eq(tradeCases.simulationModel, "contract_v2"),
    eq(tradeCases.learningApplied, false),
  )).orderBy(asc(tradeCases.exitAt));
  for (const trade of pending) await applyTradeLearning(trade);
}

async function insertTransition(packet: GateAnalysisPacket, tradeId: string | null = null) {
  const db = getDb();
  const plan = packet.decision.entryPlan;
  const id = crypto.randomUUID();
  await db.insert(alertEvents).values({
    id,
    fingerprint: `transition:${packet.symbol}:${packet.decision.state}:${packet.decision.side}:${packet.observedAt}`,
    tradeId,
    symbol: packet.symbol,
    state: packet.decision.state,
    side: packet.decision.side,
    confidence: packet.decision.confidence,
    directionalScore: packet.decision.directionalScore,
    posteriorLong: packet.decision.posteriorLong,
    dataQuality: packet.decision.dataQuality,
    regime: packet.decision.regime,
    observedAt: packet.observedAt,
    expiresAt: packet.observedAt + packet.decision.expiresMinutes * 60_000,
    entryPrice: plan?.entryPrice ?? packet.market.futuresPrice,
    entryLow: plan?.entryZone[0] ?? null,
    entryHigh: plan?.entryZone[1] ?? null,
    invalidationPrice: plan?.stopLossPrice ?? packet.decision.invalidationPrice,
    trigger: packet.decision.trigger,
    thesis: packet.decision.thesis,
    evidenceJson: JSON.stringify(packet.decision.evidence),
    counterEvidenceJson: JSON.stringify(packet.decision.counterEvidence),
    metricsJson: JSON.stringify(packet.decision.metrics),
    sourceSnapshotJson: JSON.stringify(packet.market),
    maxPriceSeen: packet.market.futuresPrice,
    minPriceSeen: packet.market.futuresPrice,
    notified: false,
  }).onConflictDoNothing();
  return id;
}

export type LifecycleResult = {
  kind: "opened" | "holding" | "target1" | "closed" | "transition" | "cooldown" | "noop";
  trade: ReturnType<typeof presentTrade> | null;
  shouldNotify: boolean;
  notification: "entry" | "target1" | "exit" | null;
  transitionId: string | null;
};

type PositionMarketInput = Parameters<typeof evaluatePosition>[1];

function positionSnapshot(open: TradeRecord): TradePositionSnapshot {
  return {
    id: open.id,
    symbol: open.symbol,
    side: open.side,
    entryAt: open.entryAt,
    entryPrice: open.entryPrice,
    initialStopPrice: open.initialStopPrice,
    currentStopPrice: open.currentStopPrice,
    takeProfit1Price: open.takeProfit1Price,
    takeProfit2Price: open.takeProfit2Price,
    target1HitAt: open.target1HitAt,
    maxHoldingMinutes: open.maxHoldingMinutes,
    maxPriceSeen: open.maxPriceSeen,
    minPriceSeen: open.minPriceSeen,
    adverseFlowCount: open.adverseFlowCount,
    confidence: open.confidence,
    regime: open.regime,
  };
}

async function evaluateAndPersistPosition(
  open: TradeRecord,
  input: PositionMarketInput,
  settings: AppSettings,
  lifecycleContext: unknown,
): Promise<LifecycleResult> {
  const db = getDb();
  const snapshot = positionSnapshot(open);
  const evaluation = evaluatePosition(snapshot, input);
  const liveAmountPnl = calculateContractPnl(open.contractNotionalUsdt, evaluation.grossMovePct, settings.roundTripCostBps / 100);
  const commonUpdate = {
    currentStopPrice: evaluation.currentStopPrice,
    target1HitAt: evaluation.target1HitAt,
    lastPrice: input.price,
    lastEvaluatedAt: input.observedAt,
    maxPriceSeen: evaluation.maxPriceSeen,
    minPriceSeen: evaluation.minPriceSeen,
    adverseFlowCount: evaluation.adverseFlowCount,
    unrealizedGrossPct: evaluation.grossMovePct,
    unrealizedNetPct: evaluation.netMovePct,
    unrealizedGrossUsdt: liveAmountPnl.grossPnlUsdt,
    unrealizedNetUsdt: liveAmountPnl.netPnlUsdt,
    progressR: evaluation.progressR,
  };
  const stillOpen = and(
    eq(tradeCases.id, open.id),
    eq(tradeCases.status, "holding"),
    eq(tradeCases.simulationModel, "contract_v2"),
  );

  if (evaluation.close) {
    const lesson = deriveTradeLesson(snapshot, evaluation, parseJson(open.entryEvidenceJson, []), input.metrics);
    const amountPnl = calculateContractPnl(open.contractNotionalUsdt, evaluation.grossMovePct, evaluation.estimatedCostPct);
    const closedRows = await db.update(tradeCases).set({
      ...commonUpdate,
      activeKey: null,
      status: "closed",
      exitAt: input.observedAt,
      exitPrice: evaluation.exitPrice ?? input.price,
      exitCode: evaluation.exitCode,
      exitReason: evaluation.exitReason,
      exitEvidenceJson: JSON.stringify(evaluation.exitEvidence),
      exitMetricsJson: JSON.stringify(input.metrics),
      grossMovePct: evaluation.grossMovePct,
      estimatedCostPct: evaluation.estimatedCostPct,
      netMovePct: evaluation.netMovePct,
      unrealizedGrossUsdt: 0,
      unrealizedNetUsdt: 0,
      grossPnlUsdt: amountPnl.grossPnlUsdt,
      estimatedCostUsdt: amountPnl.estimatedCostUsdt,
      netPnlUsdt: amountPnl.netPnlUsdt,
      accountBalanceAfterUsdt: null,
      mfePct: evaluation.mfePct,
      maePct: evaluation.maePct,
      holdMinutes: evaluation.holdMinutes,
      lessonJson: JSON.stringify(lesson),
      learningApplied: false,
    }).where(stillOpen).returning({ id: tradeCases.id });

    if (!closedRows.length) {
      const [current] = await db.select().from(tradeCases).where(eq(tradeCases.id, open.id)).limit(1);
      return { kind: current?.status === "closed" ? "closed" : "noop", trade: current ? presentTrade(current) : null, shouldNotify: false, notification: null, transitionId: null };
    }

    const accountAfterClose = await getAccountSnapshot(settings);
    await db.update(tradeCases).set({ accountBalanceAfterUsdt: accountAfterClose.realizedBalanceUsdt }).where(eq(tradeCases.id, open.id));
    await upsertLifecycle({
      symbol: open.symbol,
      state: "cooldown",
      side: open.side,
      activeTradeId: null,
      cooldownUntil: input.observedAt + 30 * 60_000,
      lastTransitionAt: input.observedAt,
      lastObservedAt: input.observedAt,
      decisionJson: JSON.stringify({ context: lifecycleContext, exit: evaluation, lesson }),
    });
    const [closed] = await db.select().from(tradeCases).where(eq(tradeCases.id, open.id)).limit(1);
    if (closed) await applyTradeLearning(closed);
    const [learned] = await db.select().from(tradeCases).where(eq(tradeCases.id, open.id)).limit(1);
    return { kind: "closed", trade: learned ? presentTrade(learned) : null, shouldNotify: true, notification: "exit", transitionId: null };
  }

  const holdingWhere = evaluation.target1ReachedNow ? and(stillOpen, isNull(tradeCases.target1HitAt)) : stillOpen;
  const updatedRows = await db.update(tradeCases).set(commonUpdate).where(holdingWhere).returning({ id: tradeCases.id });
  if (!updatedRows.length) {
    const [current] = await db.select().from(tradeCases).where(eq(tradeCases.id, open.id)).limit(1);
    return { kind: current?.status === "closed" ? "closed" : "holding", trade: current ? presentTrade(current) : null, shouldNotify: false, notification: null, transitionId: null };
  }
  await upsertLifecycle({
    symbol: open.symbol,
    state: "holding",
    side: open.side,
    activeTradeId: open.id,
    cooldownUntil: null,
    lastTransitionAt: open.entryAt,
    lastObservedAt: input.observedAt,
    decisionJson: JSON.stringify({ context: lifecycleContext, position: evaluation }),
  });
  const [updated] = await db.select().from(tradeCases).where(eq(tradeCases.id, open.id)).limit(1);
  return {
    kind: evaluation.target1ReachedNow ? "target1" : "holding",
    trade: updated ? presentTrade(updated) : null,
    shouldNotify: evaluation.target1ReachedNow,
    notification: evaluation.target1ReachedNow ? "target1" : null,
    transitionId: null,
  };
}

export async function processPositionQuote(quote: GatePositionQuote, settings: AppSettings): Promise<LifecycleResult> {
  const open = await getOpenTradeRow(quote.symbol);
  if (!open) return { kind: "noop", trade: null, shouldNotify: false, notification: null, transitionId: null };
  const rawCandleTime = quote.candleTime ?? 0;
  const candleTimeMs = rawCandleTime > 10_000_000_000 ? rawCandleTime : rawCandleTime * 1000;
  const candleStartedAfterEntry = candleTimeMs >= open.entryAt;
  return evaluateAndPersistPosition(open, {
    observedAt: quote.observedAt,
    price: quote.price,
    highPrice: candleStartedAfterEntry ? quote.highPrice : null,
    lowPrice: candleStartedAfterEntry ? quote.lowPrice : null,
    directionalScore: open.side === "LONG" ? 0.1 : -0.1,
    confirmationCount: 0,
    macroEventRisk: 0,
    metrics: [],
    roundTripCostBps: settings.roundTripCostBps,
  }, settings, { source: "Gate 10s position quote", candleTime: quote.candleTime });
}

function applyMinimumTakeProfitDecision(
  packet: GateAnalysisPacket,
  contract: ContractPlan,
  takeProfitViability: TakeProfitViability,
): GateAnalysisPacket {
  const plan = packet.decision.entryPlan;
  if (!plan || takeProfitViability.passed) return packet;
  const profitDetail = `按实际 ${contract.leverage}x、名义仓位 ${contract.contractNotionalUsdt.toFixed(2)}U 和往返成本计算，TP2 预计净利润 ${takeProfitViability.netPnlUsdt.toFixed(2)}U / 最低 ${takeProfitViability.minimumNetProfitUsdt.toFixed(2)}U`;
  return {
    ...packet,
    decision: {
      ...packet.decision,
      state: "pre_alert",
      stateLabel: "预警·收益不足",
      action: `不开仓：TP2预计净利润不足 ${takeProfitViability.minimumNetProfitUsdt.toFixed(0)}U`,
      thesis: `方向证据虽已通过，但实际仓位在TP2扣除成本后只能预计盈利 ${takeProfitViability.netPnlUsdt.toFixed(2)}U，收益不足，不创建订单。`,
      trigger: `收益闸门未通过：${profitDetail}`,
      entryPlan: {
        ...plan,
        ready: false,
        checks: [
          ...plan.checks.filter((check) => check.key !== "minimum-tp2-net-profit"),
          { key: "minimum-tp2-net-profit", label: "TP2最低净利润", passed: false, required: true, detail: profitDetail },
        ],
      },
      counterEvidence: [
        { title: "TP2净利润不足", detail: `${profitDetail}；系统不会通过提高杠杆来勉强开仓。` },
        ...packet.decision.counterEvidence.filter((item) => item.title !== "TP2净利润不足"),
      ].slice(0, 5),
    },
  };
}

export async function previewDecisionContract(packet: GateAnalysisPacket, settings: AppSettings) {
  const plan = packet.decision.entryPlan;
  if (packet.decision.state !== "confirmed" || !plan?.ready || packet.decision.side === "WAIT") return null;
  const account = await getAccountSnapshot(settings);
  const contract = buildContractPlan({
    side: plan.side,
    entryPrice: plan.entryPrice,
    stopLossPrice: plan.stopLossPrice,
    atrPct: packet.decision.diagnostics.atrPct,
    dataQuality: packet.decision.dataQuality,
    confidence: packet.decision.confidence,
    liquidityVolumeUsd: packet.market.volumeUsd,
    accountEquityUsdt: account.equityUsdt,
    availableMarginUsdt: account.availableMarginUsdt,
    requestedRiskUsdt: settings.maxRiskPerAlertUsdt,
  });
  const takeProfitViability = assessTakeProfitViability({
    side: plan.side,
    entryPrice: plan.entryPrice,
    takeProfitPrice: plan.takeProfit2Price,
    notionalUsdt: contract.contractNotionalUsdt,
    accountEquityUsdt: account.equityUsdt,
    roundTripCostBps: settings.roundTripCostBps,
  });
  return {
    account,
    contract,
    takeProfitViability,
    packet: applyMinimumTakeProfitDecision(packet, contract, takeProfitViability),
  };
}

export async function processDecision(packet: GateAnalysisPacket, settings: AppSettings): Promise<LifecycleResult> {
  const db = getDb();
  await applyPendingLearning(packet.symbol);
  await saveRegime(packet);
  const open = await getOpenTradeRow(packet.symbol);

  if (open) {
    return evaluateAndPersistPosition(open, {
      observedAt: packet.observedAt,
      price: packet.market.futuresPrice,
      highPrice: packet.decision.diagnostics.lastCandleHigh,
      lowPrice: packet.decision.diagnostics.lastCandleLow,
      directionalScore: packet.decision.directionalScore,
      confirmationCount: packet.decision.diagnostics.confirmationCount,
      macroEventRisk: packet.decision.diagnostics.macroEventRisk,
      metrics: packet.decision.metrics,
      roundTripCostBps: settings.roundTripCostBps,
    }, settings, packet.decision);
  }

  const [lifecycle] = await db.select().from(symbolLifecycle).where(eq(symbolLifecycle.symbol, packet.symbol)).limit(1);
  if (lifecycle?.state === "cooldown" && (lifecycle.cooldownUntil ?? 0) > packet.observedAt) {
    await db.update(symbolLifecycle).set({ lastObservedAt: packet.observedAt, decisionJson: JSON.stringify(packet.decision) }).where(eq(symbolLifecycle.symbol, packet.symbol));
    return { kind: "cooldown", trade: null, shouldNotify: false, notification: null, transitionId: null };
  }

  const plan = packet.decision.entryPlan;
  if (packet.decision.state === "confirmed" && plan?.ready && packet.decision.side !== "WAIT") {
    const contractPreview = await previewDecisionContract(packet, settings);
    if (!contractPreview) throw new Error("Confirmed decision is missing its contract preview");
    const { account, contract, takeProfitViability } = contractPreview;
    if (contract.contractNotionalUsdt < 1 || contract.marginUsdt < 1) {
      await upsertLifecycle({
        symbol: packet.symbol,
        state: "pre_alert",
        side: plan.side,
        activeTradeId: null,
        cooldownUntil: null,
        lastTransitionAt: packet.observedAt,
        lastObservedAt: packet.observedAt,
        decisionJson: JSON.stringify({ decision: packet.decision, accountBlocked: "模拟账户可用保证金不足 1U" }),
      });
      return { kind: "transition", trade: null, shouldNotify: false, notification: null, transitionId: null };
    }
    if (!takeProfitViability.passed) {
      packet.decision = contractPreview.packet.decision;
      const profitBlockChanged = !lifecycle || lifecycle.state !== "pre_alert" || lifecycle.side !== plan.side;
      await upsertLifecycle({
        symbol: packet.symbol,
        state: "pre_alert",
        side: plan.side,
        activeTradeId: null,
        cooldownUntil: null,
        lastTransitionAt: profitBlockChanged ? packet.observedAt : lifecycle.lastTransitionAt,
        lastObservedAt: packet.observedAt,
        decisionJson: JSON.stringify(packet.decision),
      });
      const transitionId = profitBlockChanged ? await insertTransition(packet) : null;
      return { kind: profitBlockChanged ? "transition" : "noop", trade: null, shouldNotify: false, notification: null, transitionId };
    }
    const id = crypto.randomUUID();
    const inserted = await db.insert(tradeCases).values({
      id,
      activeKey: packet.symbol,
      symbol: packet.symbol,
      status: "holding",
      side: plan.side,
      confidence: packet.decision.confidence,
      posteriorLong: packet.decision.posteriorLong,
      dataQuality: packet.decision.dataQuality,
      regime: packet.decision.regime,
      entryDirectionalScore: packet.decision.directionalScore,
      entryAt: packet.observedAt,
      entryPrice: plan.entryPrice,
      entryLow: plan.entryZone[0],
      entryHigh: plan.entryZone[1],
      entryTrigger: packet.decision.trigger,
      entryThesis: packet.decision.thesis,
      entryChecksJson: JSON.stringify(plan.checks),
      exitRulesJson: JSON.stringify(plan.exitRules),
      entryEvidenceJson: JSON.stringify(packet.decision.evidence),
      entryCounterEvidenceJson: JSON.stringify(packet.decision.counterEvidence),
      entryMetricsJson: JSON.stringify(packet.decision.metrics),
      entrySnapshotJson: JSON.stringify(packet.market),
      initialStopPrice: plan.stopLossPrice,
      currentStopPrice: plan.stopLossPrice,
      takeProfit1Price: plan.takeProfit1Price,
      takeProfit2Price: plan.takeProfit2Price,
      target1HitAt: null,
      maxHoldingMinutes: plan.maxHoldingMinutes,
      plannedRiskPct: plan.plannedRiskPct,
      riskReward: plan.riskReward,
      riskBudgetUsdt: contract.plannedLossUsdt,
      suggestedNotionalUsdt: contract.contractNotionalUsdt,
      contractType: contract.contractType,
      marginMode: contract.marginMode,
      leverage: contract.leverage,
      leverageReason: contract.leverageReason,
      marginUsdt: contract.marginUsdt,
      contractNotionalUsdt: contract.contractNotionalUsdt,
      quantity: contract.quantity,
      estimatedLiquidationPrice: contract.estimatedLiquidationPrice,
      simulationModel: "contract_v2",
      accountBalanceBeforeUsdt: account.realizedBalanceUsdt,
      accountBalanceAfterUsdt: null,
      lastPrice: packet.market.futuresPrice,
      lastEvaluatedAt: packet.observedAt,
      maxPriceSeen: packet.market.futuresPrice,
      minPriceSeen: packet.market.futuresPrice,
      adverseFlowCount: 0,
      unrealizedGrossPct: 0,
      unrealizedNetPct: -settings.roundTripCostBps / 100,
      unrealizedGrossUsdt: 0,
      unrealizedNetUsdt: -contract.contractNotionalUsdt * settings.roundTripCostBps / 10_000,
      progressR: 0,
    }).onConflictDoNothing().returning({ id: tradeCases.id });
    if (!inserted.length) {
      const raced = await getOpenTradeRow(packet.symbol);
      return { kind: "holding", trade: raced ? presentTrade(raced) : null, shouldNotify: false, notification: null, transitionId: null };
    }
    await upsertLifecycle({
      symbol: packet.symbol,
      state: "holding",
      side: plan.side,
      activeTradeId: id,
      cooldownUntil: null,
      lastTransitionAt: packet.observedAt,
      lastObservedAt: packet.observedAt,
      decisionJson: JSON.stringify(packet.decision),
    });
    const transitionId = await insertTransition(packet, id);
    const [created] = await db.select().from(tradeCases).where(eq(tradeCases.id, id)).limit(1);
    return {
      kind: "opened",
      trade: created ? presentTrade(created) : null,
      shouldNotify: packet.decision.confidence >= settings.minConfidence,
      notification: packet.decision.confidence >= settings.minConfidence ? "entry" : null,
      transitionId,
    };
  }

  const nextState = packet.decision.state === "confirmed" ? "pre_alert" : packet.decision.state;
  const nextSide = nextState === "pre_alert" ? packet.decision.side : "WAIT";
  const changed = !lifecycle || lifecycle.state !== nextState || lifecycle.side !== nextSide;
  await upsertLifecycle({
    symbol: packet.symbol,
    state: nextState,
    side: nextSide,
    activeTradeId: null,
    cooldownUntil: null,
    lastTransitionAt: changed ? packet.observedAt : lifecycle.lastTransitionAt,
    lastObservedAt: packet.observedAt,
    decisionJson: JSON.stringify(packet.decision),
  });
  const transitionId = changed && nextState !== "observing" ? await insertTransition(packet) : null;
  return { kind: changed ? "transition" : "noop", trade: null, shouldNotify: false, notification: null, transitionId };
}

export async function markTradeNotification(id: string, type: "entry" | "target1" | "exit") {
  const db = getDb();
  const field = type === "entry" ? { entryNotified: true } : type === "target1" ? { target1Notified: true } : { exitNotified: true };
  await db.update(tradeCases).set(field).where(eq(tradeCases.id, id));
}

export async function markNotified(id: string) {
  const db = getDb();
  await db.update(alertEvents).set({ notified: true }).where(eq(alertEvents.id, id));
}

export async function beginScan(universeSize: number) {
  const db = getDb();
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  await db.insert(scanRuns).values({ id, startedAt, status: "running", universeSize });
  return { id, startedAt };
}

export async function completeScan(id: string, startedAt: number, values: {
  status: "completed" | "degraded" | "failed";
  deepScanned: number;
  confirmedCount: number;
  preAlertCount: number;
  averageDataQuality: number | null;
  error?: string | null;
}) {
  const db = getDb();
  await db.update(scanRuns).set({ ...values, completedAt: Date.now(), durationMs: Date.now() - startedAt }).where(eq(scanRuns.id, id));
}

function presentAlert(row: AlertRecord) {
  return {
    ...row,
    displayState: row.state,
    evidence: parseJson(row.evidenceJson, []),
    counterEvidence: parseJson(row.counterEvidenceJson, []),
    metrics: parseJson(row.metricsJson, []),
    sourceSnapshot: parseJson(row.sourceSnapshotJson, {}),
  };
}

export async function getAlertDashboard(limit = 100) {
  const db = getDb();
  const [alerts, trades, archivedCountRows, lastScan, settings, memories] = await Promise.all([
    db.select().from(alertEvents).orderBy(desc(alertEvents.observedAt)).limit(Math.min(250, Math.max(1, limit))),
    db.select().from(tradeCases).where(eq(tradeCases.simulationModel, "contract_v2")).orderBy(desc(tradeCases.entryAt)).limit(Math.min(250, Math.max(1, limit))),
    db.select({ count: sql<number>`count(*)` }).from(tradeCases).where(eq(tradeCases.status, "archived")),
    db.select().from(scanRuns).orderBy(desc(scanRuns.startedAt)).limit(1),
    getSettings(),
    db.select().from(strategyMemory).orderBy(desc(strategyMemory.updatedAt)).limit(250),
  ]);
  const closed = trades.filter((row) => row.status === "closed" && row.netMovePct != null);
  const open = trades.filter((row) => row.status === "holding");
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const row of [...closed].reverse()) {
    equity += row.netMovePct ?? 0;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  const calibration = Array.from({ length: 5 }, (_, bucket) => {
    const low = 50 + bucket * 10;
    const high = low + 9;
    const rows = closed.filter((row) => row.confidence >= low && row.confidence <= high);
    return {
      range: `${low}–${high}`,
      count: rows.length,
      predicted: rows.length ? rows.reduce((sum, row) => sum + row.confidence, 0) / rows.length : null,
      realized: rows.length ? rows.filter((row) => (row.netMovePct ?? 0) > 0).length / rows.length * 100 : null,
    };
  });
  const stats = {
    emitted: trades.length,
    open: open.length,
    closed: closed.length,
    wins: closed.filter((row) => (row.netMovePct ?? 0) > 0).length,
    winRate: closed.length ? closed.filter((row) => (row.netMovePct ?? 0) > 0).length / closed.length * 100 : null,
    averageGrossPct: closed.length ? closed.reduce((sum, row) => sum + (row.grossMovePct ?? 0), 0) / closed.length : null,
    averageCostPct: closed.length ? closed.reduce((sum, row) => sum + (row.estimatedCostPct ?? 0), 0) / closed.length : null,
    averageNetPct: closed.length ? closed.reduce((sum, row) => sum + (row.netMovePct ?? 0), 0) / closed.length : null,
    totalNetPnlUsdt: closed.reduce((sum, row) => sum + (row.netPnlUsdt ?? 0), 0),
    averageMfePct: closed.length ? closed.reduce((sum, row) => sum + (row.mfePct ?? 0), 0) / closed.length : null,
    averageMaePct: closed.length ? closed.reduce((sum, row) => sum + (row.maePct ?? 0), 0) / closed.length : null,
    averageHoldMinutes: closed.length ? closed.reduce((sum, row) => sum + (row.holdMinutes ?? 0), 0) / closed.length : null,
    targetExits: closed.filter((row) => row.exitCode === "take_profit").length,
    stopExits: closed.filter((row) => row.exitCode === "stop_loss" || row.exitCode === "breakeven").length,
    brierScore: closed.length ? closed.reduce((sum, row) => sum + (row.confidence / 100 - ((row.netMovePct ?? 0) > 0 ? 1 : 0)) ** 2, 0) / closed.length : null,
    maxDrawdownPct: maxDrawdown,
    calibration,
    uncalibrated: closed.length < 50,
  };
  const account = await getAccountSnapshot(settings);
  return {
    alerts: alerts.map(presentAlert),
    trades: trades.map(presentTrade),
    openTrades: open.map(presentTrade),
    memories: memories.map(presentMemory),
    stats,
    account,
    archivedCount: Number(archivedCountRows[0]?.count ?? 0),
    lastScan: lastScan[0] ?? null,
    settings: publicSettings(settings),
  };
}

export async function savePushSubscription(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent?: string | null, accountId?: string | null) {
  const db = getDb();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subscription.endpoint));
  const id = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await db.insert(pushSubscriptions).values({
    id,
    accountId: accountId ?? null,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    userAgent: userAgent ?? null,
    createdAt: Date.now(),
    disabledAt: null,
    failureCount: 0,
  }).onConflictDoUpdate({
    target: pushSubscriptions.endpoint,
    set: { accountId: accountId ?? null, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, userAgent: userAgent ?? null, disabledAt: null, failureCount: 0 },
  });
  await updateSettings({ pushEnabled: true });
  return id;
}

export async function disablePushSubscription(endpoint: string, accountId?: string | null) {
  const db = getDb();
  await db.update(pushSubscriptions).set({ disabledAt: Date.now() }).where(accountId
    ? and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.accountId, accountId))
    : eq(pushSubscriptions.endpoint, endpoint));
  const [remaining] = await db.select({ count: sql<number>`count(*)` }).from(pushSubscriptions).where(isNull(pushSubscriptions.disabledAt));
  if (Number(remaining?.count ?? 0) === 0) await updateSettings({ pushEnabled: false });
}

export async function listActivePushSubscriptions(accountId?: string | null) {
  const db = getDb();
  return db.select().from(pushSubscriptions).where(accountId
    ? and(isNull(pushSubscriptions.disabledAt), eq(pushSubscriptions.accountId, accountId))
    : isNull(pushSubscriptions.disabledAt));
}

export async function recordPushResult(id: string, success: boolean, disable = false) {
  const db = getDb();
  await db.update(pushSubscriptions).set(success ? {
    lastSuccessAt: Date.now(), failureCount: 0,
  } : {
    failureCount: sql`${pushSubscriptions.failureCount} + 1`,
    ...(disable ? { disabledAt: Date.now() } : {}),
  }).where(eq(pushSubscriptions.id, id));
}
