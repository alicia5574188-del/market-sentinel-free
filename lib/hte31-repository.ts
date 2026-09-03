import { and, asc, desc, eq, isNull, lte, or } from "drizzle-orm";
import { getDb } from "../db";
import {
  hte31Evaluations,
  hte31Learning,
  hte31PostExitObservations,
  hte31SimulationEpochs,
  hte31TradeCharts,
  hte31Trades,
} from "../db/hte31-schema";
import type { GateAnalysisPacket, GatePositionQuote } from "./gate-client.ts";
import { getSettings, type AppSettings } from "./settings-repository.ts";
import type { Hte31Candle, Hte31Signal } from "./hte31-types.ts";
import { HTE31_ALL_TRADER_IDS, hte31TraderIdForSignal as anyTraderIdForSignal, type Hte31TraderId } from "./hte31-strategy-catalog.ts";
import { buildHte31PaperPosition, hte31PaperPortfolioBlockReason } from "./hte31-position-sizing.ts";
import { evaluateHte31PerformanceCell } from "./hte31-performance-gate.ts";
import { hte31TimeoutExitReason, isSustainedHte31StopRecovery } from "./hte31-exit-quality.ts";
import { buildResonanceEntryQuality } from "./resonance-entry-quality.ts";
import { shouldPersistHte31HoldingCheckpoint } from "./hte31-d1-write-budget.ts";
import {
  RESONANCE_POLICY_STARTED_AT,
  isCurrentResonanceLearningId,
  isCurrentResonanceTrade,
  resonanceLearningId,
} from "./resonance-policy-version.ts";
import { evaluateDirectMarketRisk } from "./direct-market-risk.ts";

export const POST_EXIT_HORIZONS = [0, 30, 60, 120, 240, 480, 720] as const;
const TRADERS: Hte31TraderId[] = [...HTE31_ALL_TRADER_IDS];
const LONG_TERM_REVALIDATION_DELAY_MS = 12 * 60 * 60_000;
const LEARNED_CHALLENGER_MARKER = "LEARNED_CHALLENGER_LIVE_PARITY";
const HTE31_EVALUATION_BATCH_SIZE = 4;

function traderIdForSignal(signal: Hte31Signal): Hte31TraderId | null {
  return anyTraderIdForSignal(signal);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function direction(side: "LONG" | "SHORT") {
  return side === "LONG" ? 1 : -1;
}

function grossMovePct(side: "LONG" | "SHORT", entry: number, exit: number) {
  return direction(side) * (exit / entry - 1) * 100;
}

function excursionPct(side: "LONG" | "SHORT", entry: number, high: number, low: number) {
  if (side === "LONG") return {
    mfe: Math.max(0, (high / entry - 1) * 100),
    mae: Math.max(0, (1 - low / entry) * 100),
  };
  return {
    mfe: Math.max(0, (1 - low / entry) * 100),
    mae: Math.max(0, (high / entry - 1) * 100),
  };
}

function isHte31FailureLoss(row: { netPnlUsdt: number | null; exitCode: string | null }) {
  return (row.netPnlUsdt ?? 0) < 0 && row.exitCode !== "breakeven";
}

export type Hte31TraderGuard = {
  state: "ACTIVE" | "COOLDOWN" | "PAUSED";
  lossStreak: number;
  retryAfter: number | null;
  reason: string;
  revalidation: boolean;
};

export type Hte31Governance = {
  state: "NORMAL" | "CAUTION" | "DEFENSIVE" | "PAUSED";
  riskMultiplier: number;
  lossStreak: number;
  reason: string;
  traderGuards: Record<Hte31TraderId, Hte31TraderGuard>;
  revalidation: boolean;
};

export async function getHte31Governance(now = Date.now()): Promise<Hte31Governance> {
  const rows = await getDb().select().from(hte31Trades)
    .where(eq(hte31Trades.status, "closed"))
    .orderBy(desc(hte31Trades.exitAt)).limit(80);
  const [epoch] = await getDb().select().from(hte31SimulationEpochs)
    .orderBy(desc(hte31SimulationEpochs.startedAt)).limit(1);

  // Policy governance is version-scoped. Pre-Resonance losses remain in D1 and
  // owner diagnostics but cannot cool down or pause the new policy.
  const policyRows = rows.filter((row) => isCurrentResonanceTrade(row.entryAt));
  const accountGateStartedAt = Math.max(epoch?.startedAt ?? 0, RESONANCE_POLICY_STARTED_AT);
  const accountRows = policyRows.filter((row) => row.entryAt >= accountGateStartedAt);

  const traderGuards = Object.fromEntries(TRADERS.map((traderId) => {
    const own = policyRows.filter((row) => row.traderId === traderId && row.exitAt != null);
    let lossStreak = 0;
    for (const row of own) {
      if (isHte31FailureLoss(row)) lossStreak += 1;
      else break;
    }
    const latestExit = own[0]?.exitAt ?? null;
    const streakCooldownMs = lossStreak >= 4 ? 12 * 60 * 60_000 : lossStreak >= 3 ? 6 * 60 * 60_000 : lossStreak >= 2 ? 2 * 60 * 60_000 : 0;
    const grossProfit = own.reduce((sum, row) => sum + Math.max(0, row.netPnlUsdt ?? 0), 0);
    const grossLoss = Math.abs(own.reduce((sum, row) => sum + Math.min(0, row.netPnlUsdt ?? 0), 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : null;
    const longTermWeak = own.length >= 12 && pf != null && pf < 0.72;
    const cooldownMs = Math.max(streakCooldownMs, longTermWeak ? LONG_TERM_REVALIDATION_DELAY_MS : 0);
    const retryAfter = latestExit && cooldownMs ? latestExit + cooldownMs : null;
    const cooling = retryAfter != null && retryAfter > now;
    const revalidation = longTermWeak && !cooling;
    const state: Hte31TraderGuard["state"] = cooling ? (longTermWeak ? "PAUSED" : "COOLDOWN") : "ACTIVE";
    return [traderId, {
      state,
      lossStreak,
      retryAfter: cooling ? retryAfter : null,
      revalidation,
      reason: longTermWeak
        ? cooling
          ? `Resonance 本版 ${own.length} 笔 PF ${pf?.toFixed(2)}，隔离至 ${new Date(retryAfter!).toLocaleString("zh-CN")} 后仅做模拟复考`
          : `Resonance 本版长期表现偏弱；隔离结束，当前仅允许模拟复考`
        : cooling
          ? `Resonance 本版连续亏损 ${lossStreak} 笔，独立冷却至 ${new Date(retryAfter!).toLocaleString("zh-CN")}`
          : lossStreak ? `已完成冷却；本版此前连续亏损 ${lossStreak} 笔` : "Resonance 本版交易员正常",
    } satisfies Hte31TraderGuard];
  })) as Record<Hte31TraderId, Hte31TraderGuard>;

  let lossStreak = 0;
  const streakTraders = new Set<string>();
  for (const row of accountRows) {
    if (isHte31FailureLoss(row)) {
      lossStreak += 1;
      streakTraders.add(row.traderId);
    } else break;
  }
  const diversifiedLoss = streakTraders.size >= 2;
  const rawPaused = diversifiedLoss && lossStreak >= 8;
  const latestAccountExit = accountRows[0]?.exitAt ?? null;
  const globalRetryAfter = rawPaused && latestAccountExit ? latestAccountExit + LONG_TERM_REVALIDATION_DELAY_MS : null;
  const globalCooling = globalRetryAfter != null && globalRetryAfter > now;
  const revalidation = rawPaused && !globalCooling;
  const state: Hte31Governance["state"] = rawPaused
    ? globalCooling ? "PAUSED" : "DEFENSIVE"
    : diversifiedLoss && lossStreak >= 6 ? "DEFENSIVE"
      : diversifiedLoss && lossStreak >= 4 ? "CAUTION" : "NORMAL";
  const riskMultiplier = state === "PAUSED" ? 0 : state === "DEFENSIVE" ? 0.35 : state === "CAUTION" ? 0.6 : 1;
  return {
    state,
    riskMultiplier,
    lossStreak,
    revalidation,
    reason: state === "NORMAL"
      ? `Resonance 本版风险正常；跨交易员连续亏损 ${diversifiedLoss ? lossStreak : 0}`
      : revalidation
        ? `Resonance 本版曾出现 ${lossStreak} 笔跨交易员连续亏损；12小时隔离结束，仅恢复模拟复考`
        : `Resonance 本版至少两位交易员共同出现 ${lossStreak} 笔连续亏损，账户进入 ${state}`,
    traderGuards,
  };
}

export async function recordHte31Evaluations(packet: GateAnalysisPacket, signals: Hte31Signal[]) {
  const db = getDb();
  const rows = signals.map((signal) => {
    const traderId = anyTraderIdForSignal(signal);
    return {
      id: `hte31:${packet.symbol}:${packet.observedAt}:${traderId}`,
      symbol: packet.symbol,
      observedAt: packet.observedAt,
      traderId,
      setupId: signal.strategyId,
      state: signal.state,
      side: signal.side,
      confidence: signal.confidence,
      setupScore: signal.strategyMeta.setupScore,
      evidenceScore: signal.strategyMeta.evidenceScore,
      assetRegime: signal.strategyMeta.assetRegime,
      thesis: signal.thesis,
      reasonsJson: JSON.stringify(signal.reasons),
      blockersJson: JSON.stringify(signal.blockers),
      entryPlanJson: JSON.stringify(signal.entryPlan),
    };
  });
  for (let index = 0; index < rows.length; index += HTE31_EVALUATION_BATCH_SIZE) {
    await db.insert(hte31Evaluations).values(rows.slice(index, index + HTE31_EVALUATION_BATCH_SIZE)).onConflictDoNothing();
  }
  return rows.length;
}

async function currentSimulationEpoch(startingCapitalUsdt: number) {
  const [epoch] = await getDb().select().from(hte31SimulationEpochs)
    .orderBy(desc(hte31SimulationEpochs.startedAt)).limit(1);
  return epoch ?? {
    id: "hte31-epoch:initial",
    startedAt: 0,
    startingCapitalUsdt,
    createdAt: 0,
  };
}

async function accountFromRows(startingCapitalUsdt: number) {
  const rows = await getDb().select().from(hte31Trades).orderBy(desc(hte31Trades.entryAt)).limit(500);
  const epoch = await currentSimulationEpoch(startingCapitalUsdt);
  const closed = rows.filter((row) => row.status === "closed");
  const open = rows.filter((row) => row.status === "holding");
  const epochClosed = closed.filter((row) => row.entryAt >= epoch.startedAt);
  const realizedPnlUsdt = epochClosed.reduce((sum, row) => sum + (row.netPnlUsdt ?? 0), 0);
  const unrealizedPnlUsdt = open.reduce((sum, row) => sum + row.unrealizedNetUsdt, 0);
  const realizedBalanceUsdt = epoch.startingCapitalUsdt + realizedPnlUsdt;
  const equityUsdt = realizedBalanceUsdt + unrealizedPnlUsdt;
  const usedMarginUsdt = open.reduce((sum, row) => sum + row.marginUsdt, 0);
  return {
    rows,
    closed,
    open,
    account: {
      startingCapitalUsdt: epoch.startingCapitalUsdt,
      epochId: epoch.id,
      epochStartedAt: epoch.startedAt,
      realizedPnlUsdt,
      unrealizedPnlUsdt,
      realizedBalanceUsdt,
      equityUsdt,
      usedMarginUsdt,
      availableMarginUsdt: Math.max(0, equityUsdt - usedMarginUsdt),
    },
  };
}

export async function resetHte31PaperCapital(startingCapitalUsdt: number, now = Date.now()) {
  const db = getDb();
  const open = await db.select({ id: hte31Trades.id }).from(hte31Trades)
    .where(eq(hte31Trades.status, "holding")).limit(1);
  if (open.length) throw new Error("存在模拟持仓，平仓后才能重置模拟本金");
  const capital = Math.min(1_000_000, Math.max(10, startingCapitalUsdt));
  const epoch = {
    id: `hte31-epoch:${crypto.randomUUID()}`,
    startedAt: now,
    startingCapitalUsdt: capital,
    createdAt: now,
  };
  await db.insert(hte31SimulationEpochs).values(epoch);
  return epoch;
}

export async function tryOpenHte31Trade(
  packet: GateAnalysisPacket,
  signals: Hte31Signal[],
  candles: Hte31Candle[],
  settings: AppSettings,
) {
  const db = getDb();
  const governance = await getHte31Governance(packet.observedAt);
  if (governance.state === "PAUSED") return { opened: null, reason: governance.reason };

  const learningRows = await db.select().from(hte31Learning);
  const learningById = new Map(learningRows.map((row) => [row.id, row]));
  const readyCandidates = signals
    .map((signal) => ({ signal, traderId: traderIdForSignal(signal) }))
    .filter((item): item is { signal: Hte31Signal; traderId: Hte31TraderId } => Boolean(item.traderId))
    .filter(({ signal, traderId }) => signal.state === "ready" && Boolean(signal.entryPlan?.ready) && signal.side !== "WAIT" && governance.traderGuards[traderId].state === "ACTIVE");
  const scoredCandidates = readyCandidates.map((item) => {
    const side = item.signal.side as "LONG" | "SHORT";
    const learning = learningById.get(resonanceLearningId(item.traderId, item.signal.strategyMeta.assetRegime, side, packet.observedAt));
    return { ...item, performanceGate: evaluateHte31PerformanceCell(learning, packet.observedAt) };
  });
  const candidates = scoredCandidates
    .filter((item) => item.performanceGate.state === "ACTIVE")
    .sort((a, b) => b.signal.confidence - a.signal.confidence || Math.abs(b.signal.score) - Math.abs(a.signal.score));
  const selected = candidates[0];
  if (!selected?.signal.entryPlan || selected.signal.side === "WAIT") {
    const paused = scoredCandidates.find((item) => item.performanceGate.state === "PAUSED");
    return { opened: null, reason: paused ? `负期望组合门控：${paused.performanceGate.reason}` : "9个策略家族本轮没有完整 Setup" };
  }

  const [existing] = await db.select({ id: hte31Trades.id }).from(hte31Trades)
    .where(and(eq(hte31Trades.symbol, packet.symbol), eq(hte31Trades.status, "holding"))).limit(1);
  if (existing) return { opened: null, reason: "该币已有 Resonance 模拟持仓" };

  const { open, account } = await accountFromRows(settings.trialCapitalUsdt);
  if (account.equityUsdt <= 0) return { opened: null, reason: "模拟账户权益不足" };

  const plan = selected.signal.entryPlan;
  const entryPrice = plan.entryPrice;
  const stopDistance = Math.abs(entryPrice - plan.stopLossPrice);
  if (!(entryPrice > 0 && stopDistance > 0)) return { opened: null, reason: "结构止损无效" };

  const sizing = buildHte31PaperPosition({
    side: selected.signal.side,
    entryPrice,
    stopLossPrice: plan.stopLossPrice,
    originalTakeProfit2Price: plan.takeProfit2Price,
    accountEquityUsdt: account.equityUsdt,
    availableMarginUsdt: account.availableMarginUsdt,
    riskMultiplier: governance.riskMultiplier,
    roundTripCostBps: settings.roundTripCostBps,
    liquidityVolumeUsd: packet.market.volumeUsd,
    atrPct: packet.decision.diagnostics.atrPct,
    dataQuality: packet.decision.dataQuality,
    confidence: selected.signal.confidence,
  });
  if (!sizing.accepted) return { opened: null, reason: `仓位经济门槛：${sizing.reason}` };
  const portfolioBlock = hte31PaperPortfolioBlockReason({
    open: open.map((trade) => ({ side: trade.side, riskBudgetUsdt: trade.riskBudgetUsdt })),
    nextSide: selected.signal.side,
    nextRiskUsdt: sizing.plannedRiskUsdt,
    accountEquityUsdt: account.equityUsdt,
  });
  if (portfolioBlock) return { opened: null, reason: portfolioBlock };
  const {
    quantity,
    notionalUsdt,
    leverage,
    marginUsdt,
    plannedRiskUsdt: riskBudgetUsdt,
  } = sizing;

  const id = `hte31:${crypto.randomUUID()}`;
  const now = packet.observedAt;
  const learnedChallenger = governance.revalidation
    || governance.traderGuards[selected.traderId].revalidation
    || selected.performanceGate.revalidation;
  const row = {
    id,
    activeKey: packet.symbol,
    symbol: packet.symbol,
    status: "holding" as const,
    traderId: selected.traderId,
    setupId: selected.signal.strategyId,
    side: selected.signal.side as "LONG" | "SHORT",
    assetRegime: selected.signal.strategyMeta.assetRegime,
    confidence: selected.signal.confidence,
    entryAt: now,
    entryPrice,
    initialStopPrice: plan.stopLossPrice,
    currentStopPrice: plan.stopLossPrice,
    takeProfit1Price: plan.takeProfit1Price,
    takeProfit2Price: sizing.takeProfit2Price,
    target1HitAt: null,
    maxHoldingMinutes: plan.maxHoldingMinutes,
    riskReward: sizing.riskReward,
    riskBudgetUsdt,
    notionalUsdt,
    marginUsdt,
    quantity,
    leverage,
    entryTrigger: `${learnedChallenger ? `${LEARNED_CHALLENGER_MARKER} · ` : ""}${selected.signal.label} · ${selected.signal.reasons.join("；")} · ${sizing.leverageReason}`,
    entryThesis: selected.signal.thesis,
    entryChecksJson: JSON.stringify(plan.checks),
    entryMetricsJson: JSON.stringify([
      ...selected.signal.metrics,
      {
        key: "paper-position-economics",
        label: "模拟仓位经济性",
        score: sizing.plannedTp2NetProfitUsdt / Math.max(sizing.plannedRiskUsdt, 1),
        detail: `${sizing.leverage}x · 保证金 ${sizing.marginUsdt.toFixed(2)}U · 名义 ${sizing.notionalUsdt.toFixed(2)}U · 风险 ${sizing.plannedRiskUsdt.toFixed(2)}U · TP2净利 ${sizing.plannedTp2NetProfitUsdt.toFixed(2)}U${sizing.tp2Adjusted ? " · 已按费用提高TP2" : ""}`,
        available: true,
        category: "risk",
      },
    ]),
    lastPrice: entryPrice,
    lastEvaluatedAt: now,
    maxPriceSeen: entryPrice,
    minPriceSeen: entryPrice,
    unrealizedNetPct: 0,
    unrealizedNetUsdt: 0,
    progressR: 0,
    exitAt: null,
    exitPrice: null,
    exitCode: null,
    exitReason: null,
    grossMovePct: null,
    netMovePct: null,
    grossPnlUsdt: null,
    costUsdt: null,
    netPnlUsdt: null,
    mfePct: null,
    maePct: null,
    holdMinutes: null,
    postExitStatus: "pending" as const,
    postExitMfePct: null,
    postExitMaePct: null,
    exitCapturePct: null,
    exitEfficiency: null,
    stopRecovery: null,
    postExitLabel: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(hte31Trades).values(row);
  await db.insert(hte31TradeCharts).values({
    tradeId: id,
    symbol: packet.symbol,
    entryCandlesJson: JSON.stringify(candles.slice(-96)),
    holdingCandlesJson: "[]",
    postExitCandlesJson: "[]",
    entryQualityJson: "null",
    updatedAt: now,
  });
  return { opened: row, reason: learnedChallenger ? `${selected.signal.label} 学习挑战单已建立（保留实盘血缘）` : `${selected.signal.label} 独立 Setup 完整触发` };
}

async function updateLearningAfterClose(trade: typeof hte31Trades.$inferSelect, netPnlUsdt: number, mfePct: number, maePct: number, now: number, exitCode: string | null, target1Hit: boolean) {
  const db = getDb();
  const id = resonanceLearningId(trade.traderId, trade.assetRegime, trade.side, trade.entryAt);
  const [existing] = await db.select().from(hte31Learning).where(eq(hte31Learning.id, id)).limit(1);
  const r = trade.riskBudgetUsdt > 0 ? netPnlUsdt / trade.riskBudgetUsdt : 0;
  const protectedScratch = exitCode === "breakeven" || (target1Hit && r > -0.35);
  const countedLoss = netPnlUsdt < 0 && !protectedScratch;
  const riskPct = Math.abs(trade.entryPrice - trade.initialStopPrice) / trade.entryPrice * 100;
  const mfeR = riskPct > 0 ? mfePct / riskPct : 0;
  const maeR = riskPct > 0 ? maePct / riskPct : 0;
  if (!existing) {
    await db.insert(hte31Learning).values({
      id,
      traderId: trade.traderId,
      assetRegime: trade.assetRegime,
      side: trade.side,
      sampleCount: 1,
      wins: netPnlUsdt > 0 ? 1 : 0,
      losses: countedLoss ? 1 : 0,
      expectancyR: r,
      grossProfitR: Math.max(0, r),
      grossLossR: Math.abs(Math.min(0, r)),
      averageMfeR: mfeR,
      averageMaeR: maeR,
      averageExitEfficiency: 0,
      updatedAt: now,
    });
    return;
  }
  const n = existing.sampleCount + 1;
  await db.update(hte31Learning).set({
    sampleCount: n,
    wins: existing.wins + (netPnlUsdt > 0 ? 1 : 0),
    losses: existing.losses + (countedLoss ? 1 : 0),
    expectancyR: (existing.expectancyR * existing.sampleCount + r) / n,
    grossProfitR: existing.grossProfitR + Math.max(0, r),
    grossLossR: existing.grossLossR + Math.abs(Math.min(0, r)),
    averageMfeR: (existing.averageMfeR * existing.sampleCount + mfeR) / n,
    averageMaeR: (existing.averageMaeR * existing.sampleCount + maeR) / n,
    updatedAt: now,
  }).where(eq(hte31Learning.id, id));
}

export async function applyHte31PositionQuote(quote: GatePositionQuote, settings: AppSettings) {
  const db = getDb();
  const [trade] = await db.select().from(hte31Trades)
    .where(and(eq(hte31Trades.symbol, quote.symbol), eq(hte31Trades.status, "holding"))).limit(1);
  if (!trade) return { kind: "none" as const };

  const barTime = (time: number) => time > 10_000_000_000 ? time : time * 1000;
  const freshBars = (quote.recentCandles ?? []).filter((bar) => {
    const startedAt = barTime(bar.time);
    return startedAt >= trade.lastEvaluatedAt && startedAt >= trade.entryAt && startedAt <= quote.observedAt;
  });
  const legacyBarFresh = quote.candleTime != null
    && barTime(quote.candleTime) >= trade.lastEvaluatedAt
    && barTime(quote.candleTime) >= trade.entryAt;
  const observedHighs = [quote.price, ...freshBars.map((bar) => bar.high), ...(legacyBarFresh && quote.highPrice != null ? [quote.highPrice] : [])];
  const observedLows = [quote.price, ...freshBars.map((bar) => bar.low), ...(legacyBarFresh && quote.lowPrice != null ? [quote.lowPrice] : [])];
  const high = Math.max(...observedHighs);
  const low = Math.min(...observedLows);
  const maxPriceSeen = Math.max(trade.maxPriceSeen, high, quote.price);
  const minPriceSeen = Math.min(trade.minPriceSeen, low, quote.price);
  let target1HitAt = trade.target1HitAt;
  let currentStopPrice = trade.currentStopPrice;
  const stopBeforeObservation = trade.currentStopPrice;
  const previouslyProtected = trade.target1HitAt != null;
  const stopHit = trade.side === "LONG" ? low <= stopBeforeObservation : high >= stopBeforeObservation;
  const tp1Hit = trade.side === "LONG" ? high >= trade.takeProfit1Price : low <= trade.takeProfit1Price;
  const tp2Hit = trade.side === "LONG" ? high >= trade.takeProfit2Price : low <= trade.takeProfit2Price;
  const timeout = quote.observedAt - trade.entryAt >= trade.maxHoldingMinutes * 60_000;
  const currentExcursion = excursionPct(trade.side, trade.entryPrice, maxPriceSeen, minPriceSeen);
  const initialRiskPct = Math.abs(trade.entryPrice - trade.initialStopPrice) / trade.entryPrice * 100;
  const maximumFavorableR = initialRiskPct > 0 ? currentExcursion.mfe / initialRiskPct : 0;
  let exitCode: string | null = null;
  let exitReason: string | null = null;
  let exitPrice: number | null = null;
  // The stop that existed BEFORE this observation owns same-bar priority. A new
  // TP1 breakeven stop is installed only for future observations, so a low/high
  // from before TP1 can never retroactively trigger it.
  if (stopHit) {
    exitCode = previouslyProtected && stopBeforeObservation === trade.entryPrice ? "breakeven" : "stop_loss";
    exitReason = exitCode === "breakeven" ? "TP1 后保护止损被触发" : "结构止损被触发";
    exitPrice = stopBeforeObservation;
  } else if (tp2Hit) {
    exitCode = "take_profit";
    exitReason = "第二目标完成，按交易员计划退出";
    exitPrice = trade.takeProfit2Price;
  } else if (timeout) {
    exitCode = "timeout";
    exitReason = hte31TimeoutExitReason({
      maxHoldingMinutes: trade.maxHoldingMinutes,
      target1Hit: Boolean(target1HitAt || tp1Hit),
      maximumFavorableR,
    });
    exitPrice = quote.price;
  } else if (!target1HitAt && tp1Hit) {
    target1HitAt = quote.observedAt;
    currentStopPrice = trade.side === "LONG"
      ? Math.max(trade.currentStopPrice, trade.entryPrice)
      : Math.min(trade.currentStopPrice, trade.entryPrice);
  }

  const grossPct = grossMovePct(trade.side, trade.entryPrice, quote.price);
  const estimatedOneWayCostPct = settings.roundTripCostBps / 100 / 2;
  const unrealizedNetPct = grossPct - estimatedOneWayCostPct;
  const unrealizedNetUsdt = trade.notionalUsdt * unrealizedNetPct / 100;
  const riskDistance = Math.abs(trade.entryPrice - trade.initialStopPrice);
  const progressR = riskDistance > 0 ? direction(trade.side) * (quote.price - trade.entryPrice) / riskDistance : 0;

  if (exitCode && exitPrice != null) {
    const realizedGrossPct = grossMovePct(trade.side, trade.entryPrice, exitPrice);
    const grossPnlUsdt = trade.notionalUsdt * realizedGrossPct / 100;
    const costUsdt = trade.notionalUsdt * settings.roundTripCostBps / 10_000;
    const netPnlUsdt = grossPnlUsdt - costUsdt;
    const netMovePct = trade.notionalUsdt > 0 ? netPnlUsdt / trade.notionalUsdt * 100 : realizedGrossPct;
    const excursion = currentExcursion;
    const holdMinutes = (quote.observedAt - trade.entryAt) / 60_000;
    await db.update(hte31Trades).set({
      activeKey: null,
      status: "closed",
      currentStopPrice,
      target1HitAt,
      lastPrice: exitPrice,
      lastEvaluatedAt: quote.observedAt,
      maxPriceSeen,
      minPriceSeen,
      unrealizedNetPct: 0,
      unrealizedNetUsdt: 0,
      progressR,
      exitAt: quote.observedAt,
      exitPrice,
      exitCode,
      exitReason,
      grossMovePct: realizedGrossPct,
      netMovePct,
      grossPnlUsdt,
      costUsdt,
      netPnlUsdt,
      mfePct: excursion.mfe,
      maePct: excursion.mae,
      holdMinutes,
      postExitStatus: "observing",
      updatedAt: quote.observedAt,
    }).where(eq(hte31Trades.id, trade.id));
    for (const horizonMinutes of POST_EXIT_HORIZONS) {
      await db.insert(hte31PostExitObservations).values({
        tradeId: trade.id,
        horizonMinutes,
        dueAt: quote.observedAt + horizonMinutes * 60_000,
        observedAt: null,
        status: "pending",
        qualityStatus: "PENDING",
        retryCount: 0,
        nextRetryAt: null,
        price: null,
        favorablePct: null,
        adversePct: null,
        favorableR: null,
        adverseR: null,
        candlesJson: "[]",
      }).onConflictDoNothing();
    }
    // Direct Market Brain changes only after the full real 12-hour path is
    // available. Historical strategies keep their original close-time ledger.
    if (trade.decisionAuthority !== "direct_market_brain") {
      await updateLearningAfterClose(trade, netPnlUsdt, excursion.mfe, excursion.mae, quote.observedAt, exitCode, Boolean(target1HitAt));
    }
    return { kind: "closed" as const, tradeId: trade.id, exitCode, exitPrice, netPnlUsdt };
  }

  const protectionChanged = target1HitAt !== trade.target1HitAt || currentStopPrice !== trade.currentStopPrice;
  if (!shouldPersistHte31HoldingCheckpoint({
    lastEvaluatedAt: trade.lastEvaluatedAt,
    observedAt: quote.observedAt,
    protectionChanged,
  })) {
    return { kind: "holding" as const, tradeId: trade.id, target1HitAt, currentStopPrice };
  }

  await db.update(hte31Trades).set({
    currentStopPrice,
    target1HitAt,
    lastPrice: quote.price,
    lastEvaluatedAt: quote.observedAt,
    maxPriceSeen,
    minPriceSeen,
    unrealizedNetPct,
    unrealizedNetUsdt,
    progressR,
    updatedAt: quote.observedAt,
  }).where(eq(hte31Trades.id, trade.id));
  return { kind: "holding" as const, tradeId: trade.id, target1HitAt, currentStopPrice };
}

export async function listHte31OpenTrades() {
  return getDb().select().from(hte31Trades).where(eq(hte31Trades.status, "holding")).orderBy(asc(hte31Trades.entryAt));
}

export async function getHte31Trade(id: string) {
  const [trade] = await getDb().select().from(hte31Trades).where(eq(hte31Trades.id, id)).limit(1);
  return trade ?? null;
}

export async function getHte31TradeChart(id: string) {
  const [chart] = await getDb().select().from(hte31TradeCharts).where(eq(hte31TradeCharts.tradeId, id)).limit(1);
  return chart ? {
    ...chart,
    entryCandles: parseJson<Hte31Candle[]>(chart.entryCandlesJson, []),
    holdingCandles: parseJson<Hte31Candle[]>(chart.holdingCandlesJson, []),
    postExitCandles: parseJson<Hte31Candle[]>(chart.postExitCandlesJson, []),
    entryQuality: parseJson<ReturnType<typeof buildResonanceEntryQuality> | null>(chart.entryQualityJson, null),
  } : null;
}

export async function nextHte31PostExitObservation(now = Date.now()) {
  const [row] = await getDb().select().from(hte31PostExitObservations)
    .where(and(
      eq(hte31PostExitObservations.status, "pending"),
      lte(hte31PostExitObservations.dueAt, now),
      or(isNull(hte31PostExitObservations.nextRetryAt), lte(hte31PostExitObservations.nextRetryAt, now)),
    ))
    .orderBy(asc(hte31PostExitObservations.dueAt)).limit(1);
  if (!row) return null;
  const trade = await getHte31Trade(row.tradeId);
  return trade ? { observation: row, trade } : null;
}

const MAX_POST_EXIT_RETRIES = 4;

async function scheduleHte31PostExitRetry(input: {
  tradeId: string;
  horizonMinutes: number;
  qualityStatus: "STALE" | "UNAVAILABLE";
  coveragePct: number;
  lastError: string;
  candlesJson: string;
  now: number;
}) {
  const db = getDb();
  const [current] = await db.select({ retryCount: hte31PostExitObservations.retryCount })
    .from(hte31PostExitObservations)
    .where(and(
      eq(hte31PostExitObservations.tradeId, input.tradeId),
      eq(hte31PostExitObservations.horizonMinutes, input.horizonMinutes),
    )).limit(1);
  const retryCount = (current?.retryCount ?? 0) + 1;
  const terminal = retryCount >= MAX_POST_EXIT_RETRIES;
  const retryDelayMinutes = Math.min(30, 5 * 2 ** Math.max(0, retryCount - 1));
  const nextRetryAt = terminal ? null : input.now + retryDelayMinutes * 60_000;
  await db.update(hte31PostExitObservations).set({
    observedAt: input.now,
    status: terminal ? "complete" : "pending",
    qualityStatus: input.qualityStatus,
    coveragePct: input.coveragePct,
    lastError: input.lastError,
    candlesJson: input.candlesJson,
    retryCount,
    nextRetryAt,
  }).where(and(
    eq(hte31PostExitObservations.tradeId, input.tradeId),
    eq(hte31PostExitObservations.horizonMinutes, input.horizonMinutes),
  ));
  return { qualityStatus: input.qualityStatus, coveragePct: input.coveragePct, retryScheduled: !terminal, nextRetryAt };
}

export async function completeHte31PostExitObservation(
  trade: typeof hte31Trades.$inferSelect,
  horizonMinutes: number,
  candles: Hte31Candle[],
  roundTripCostBps = 0,
  now = Date.now(),
) {
  if (!trade.exitAt || !trade.exitPrice) return;
  const exitAt = trade.exitAt;
  const exitPrice = trade.exitPrice;
  const db = getDb();
  const dueAt = exitAt + horizonMinutes * 60_000;
  const rows = candles.filter((candle) => {
    const time = candle.time > 10_000_000_000 ? candle.time : candle.time * 1000;
    return time >= exitAt && time <= dueAt + 6 * 60_000;
  });
  const times = [...new Set(rows.map((candle) => candle.time > 10_000_000_000 ? candle.time : candle.time * 1000))].sort((a, b) => a - b);
  const expected = horizonMinutes === 0 ? 1 : Math.max(1, Math.floor(horizonMinutes / 5));
  const coveragePct = Math.min(100, times.length / expected * 100);
  const largestGap = times.slice(1).reduce((largest, time, index) => Math.max(largest, time - times[index]), 0);
  const reachesHorizon = horizonMinutes === 0 || (times.at(-1) ?? 0) >= dueAt - 6 * 60_000;
  const qualityReady = rows.length > 0 && coveragePct >= 95 && largestGap <= 7 * 60_000 && reachesHorizon;
  if (!qualityReady) {
    const qualityStatus = rows.length ? "STALE" as const : "UNAVAILABLE" as const;
    return scheduleHte31PostExitRetry({
      tradeId: trade.id,
      horizonMinutes,
      qualityStatus,
      coveragePct,
      lastError: rows.length ? `覆盖率 ${coveragePct.toFixed(1)}% 或K线间隔不完整` : "该观察节点没有可验证K线",
      candlesJson: JSON.stringify(rows.slice(-160)),
      now,
    });
  }
  const high = rows.length ? Math.max(...rows.map((candle) => candle.high)) : exitPrice;
  const low = rows.length ? Math.min(...rows.map((candle) => candle.low)) : exitPrice;
  const currentPrice = rows.at(-1)?.close ?? exitPrice;
  const favorablePct = trade.side === "LONG" ? Math.max(0, (high / exitPrice - 1) * 100) : Math.max(0, (1 - low / exitPrice) * 100);
  const adversePct = trade.side === "LONG" ? Math.max(0, (1 - low / exitPrice) * 100) : Math.max(0, (high / exitPrice - 1) * 100);
  const riskPct = Math.abs(trade.entryPrice - trade.initialStopPrice) / trade.entryPrice * 100;
  const favorableR = riskPct > 0 ? favorablePct / riskPct : 0;
  const adverseR = riskPct > 0 ? adversePct / riskPct : 0;
  const currentRecoveryPct = Math.max(0, grossMovePct(trade.side, exitPrice, currentPrice));
  const currentRecoveryR = riskPct > 0 ? currentRecoveryPct / riskPct : 0;
  const capturedPct = Math.max(0, grossMovePct(trade.side, trade.entryPrice, exitPrice));
  const totalPotentialPct = Math.max(capturedPct, capturedPct + favorablePct);
  const exitCapturePct = totalPotentialPct > 0 ? clamp(capturedPct / totalPotentialPct * 100, 0, 100) : 100;
  // A brief rebound followed by a larger continuation beyond the stop is not a
  // fake stop. Require recovery to persist at the observation horizon and not
  // be overwhelmed by adverse continuation.
  const stopRecovery = isSustainedHte31StopRecovery({
    exitCode: trade.exitCode,
    favorableR,
    currentRecoveryR,
    adverseR,
  });
  let postExitLabel = "退出合理";
  if (stopRecovery) postExitLabel = "疑似假止损";
  else if (favorableR >= 1.25) postExitLabel = "退出偏早";
  else if ((trade.mfePct ?? 0) > 0 && capturedPct < (trade.mfePct ?? 0) * 0.45) postExitLabel = "退出偏晚";
  else if (adverseR >= 1 && favorableR < 0.5) postExitLabel = "退出优秀";
  const exitEfficiency = clamp((exitCapturePct * 0.65) + Math.min(100, adverseR * 50) * 0.25 + Math.max(0, 10 - favorableR * 8), 0, 100);

  await db.update(hte31PostExitObservations).set({
    observedAt: now,
    status: "complete",
    qualityStatus: "READY",
    coveragePct,
    lastError: null,
    nextRetryAt: null,
    price: currentPrice,
    favorablePct,
    adversePct,
    favorableR,
    adverseR,
    candlesJson: JSON.stringify(rows.slice(-160)),
  }).where(and(eq(hte31PostExitObservations.tradeId, trade.id), eq(hte31PostExitObservations.horizonMinutes, horizonMinutes)));

  const [chart] = await db.select().from(hte31TradeCharts).where(eq(hte31TradeCharts.tradeId, trade.id)).limit(1);
  const fullWindow = candles.slice(-220);
  if (chart) {
    const entryQuality = buildResonanceEntryQuality(trade, [
      ...parseJson<Hte31Candle[]>(chart.entryCandlesJson, []),
      ...parseJson<Hte31Candle[]>(chart.holdingCandlesJson, []),
      ...parseJson<Hte31Candle[]>(chart.postExitCandlesJson, []),
      ...fullWindow,
      ...rows,
    ], roundTripCostBps, now);
    await db.update(hte31TradeCharts).set({
      holdingCandlesJson: horizonMinutes === 0 ? JSON.stringify(fullWindow) : chart.holdingCandlesJson,
      postExitCandlesJson: horizonMinutes > 0 ? JSON.stringify(rows.slice(-160)) : chart.postExitCandlesJson,
      entryQualityJson: JSON.stringify(entryQuality),
      updatedAt: now,
    }).where(eq(hte31TradeCharts.tradeId, trade.id));
  }

  const complete = horizonMinutes >= 720;
  await db.update(hte31Trades).set({
    postExitStatus: complete ? "complete" : "observing",
    postExitMfePct: favorablePct,
    postExitMaePct: adversePct,
    exitCapturePct,
    exitEfficiency,
    stopRecovery,
    postExitLabel,
    updatedAt: now,
  }).where(eq(hte31Trades.id, trade.id));

  if (complete && trade.decisionAuthority === "direct_market_brain") {
    await updateLearningAfterClose(
      trade,
      trade.netPnlUsdt ?? 0,
      trade.mfePct ?? 0,
      trade.maePct ?? 0,
      now,
      trade.exitCode ?? "timeout",
      Boolean(trade.target1HitAt),
    );
  }

  if (complete) {
    const learningId = resonanceLearningId(trade.traderId, trade.assetRegime, trade.side, trade.entryAt);
    const [learning] = await db.select().from(hte31Learning).where(eq(hte31Learning.id, learningId)).limit(1);
    if (learning?.sampleCount) {
      await db.update(hte31Learning).set({
        averageExitEfficiency: (learning.averageExitEfficiency * Math.max(0, learning.sampleCount - 1) + exitEfficiency) / learning.sampleCount,
        updatedAt: now,
      }).where(eq(hte31Learning.id, learningId));
    }
  }
  return { qualityStatus: "READY" as const, coveragePct };
}

export async function markHte31PostExitObservationUnavailable(
  tradeId: string,
  horizonMinutes: number,
  error: unknown,
  now = Date.now(),
) {
  return scheduleHte31PostExitRetry({
    tradeId,
    horizonMinutes,
    qualityStatus: "UNAVAILABLE",
    coveragePct: 0,
    lastError: error instanceof Error ? error.message.slice(0, 500) : "K线读取失败",
    candlesJson: "[]",
    now,
  });
}

export async function getHte31Dashboard(now = Date.now()) {
  const settings = await getSettings();
  const { rows, closed, open, account } = await accountFromRows(settings.trialCapitalUsdt);
  const evaluations = await getDb().select().from(hte31Evaluations)
    .where(lte(hte31Evaluations.observedAt, now))
    .orderBy(desc(hte31Evaluations.observedAt)).limit(120);
  const freshEvaluations = evaluations.filter((row) => now - row.observedAt <= 15 * 60_000);
  const allLearningRows = await getDb().select().from(hte31Learning).orderBy(desc(hte31Learning.updatedAt)).limit(300);
  const learningRows = allLearningRows.filter((row) => isCurrentResonanceLearningId(row.id));
  const learning = learningRows.map((row) => ({
    ...row,
    performanceGate: evaluateHte31PerformanceCell(row, now),
  }));
  const governance = await getHte31Governance(now);
  const tenMinute = evaluations.filter((row) => now - row.observedAt <= 10 * 60_000);
  const grossProfit = closed.reduce((sum, row) => sum + Math.max(0, row.netPnlUsdt ?? 0), 0);
  const grossLoss = Math.abs(closed.reduce((sum, row) => sum + Math.min(0, row.netPnlUsdt ?? 0), 0));
  const directRisk = evaluateDirectMarketRisk(closed
    .filter((row) => row.decisionAuthority === "direct_market_brain" && row.postExitStatus === "complete")
    .map((row) => ({
      independentEventKey: row.independentEventKey ?? row.id,
      resultR: row.riskBudgetUsdt > 0 ? (row.netPnlUsdt ?? 0) / row.riskBudgetUsdt : 0,
    })));
  return {
    account,
    trades: rows.slice(0, 100),
    openTrades: open,
    closedTrades: closed.slice(0, 60),
    evaluations: freshEvaluations.map((row) => ({
      ...row,
      reasons: parseJson<string[]>(row.reasonsJson, []),
      blockers: parseJson<string[]>(row.blockersJson, []),
      entryPlan: parseJson<unknown>(row.entryPlanJson, null),
    })),
    learning,
    governance,
    directRisk,
    activity: {
      symbols: new Set(tenMinute.map((row) => row.symbol)).size,
      evaluations: tenMinute.length,
      ready: tenMinute.filter((row) => row.state === "ready").length,
      watching: tenMinute.filter((row) => row.state === "watching").length,
      blocked: tenMinute.filter((row) => row.state === "blocked").length,
    },
    stats: {
      sampleCount: closed.length,
      wins: closed.filter((row) => (row.netPnlUsdt ?? 0) > 0).length,
      scratches: closed.filter((row) => row.exitCode === "breakeven").length,
      losses: closed.filter((row) => isHte31FailureLoss(row)).length,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : null,
      totalNetPnlUsdt: closed.reduce((sum, row) => sum + (row.netPnlUsdt ?? 0), 0),
    },
    settings: {
      scanEnabled: settings.scanEnabled,
      pushEnabled: settings.pushEnabled,
      coreSymbols: parseJson<string[]>(settings.coreSymbolsJson, []),
      universeLimit: settings.universeLimit,
      trialCapitalUsdt: settings.trialCapitalUsdt,
      roundTripCostBps: settings.roundTripCostBps,
    },
  };
}
