import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { hte31Learning, hte31SimulationEpochs, hte31TradeCharts, hte31Trades } from "../db/hte31-schema";
import type { MarketAnalysisPacket } from "./exchange-market.ts";
import { buildHte31PaperPosition, hte31PaperPortfolioBlockReason } from "./hte31-position-sizing.ts";
import { evaluateHte31PerformanceCell } from "./hte31-performance-gate.ts";
import { resonanceLearningId } from "./resonance-policy-version.ts";
import type { AppSettings } from "./settings-repository.ts";
import { hte31CanonicalStrategyLabel, hte31TraderIdForSignal, type Hte31TraderId } from "./hte31-strategy-catalog.ts";
import type { Hte31RouterDecision } from "./hte31-strategy-router.ts";
import type { Hte31Candle, Hte31Signal } from "./hte31-types.ts";

const COGNITIVE_MARKER = "COGNITIVE_ADAPTATION";
const BRAIN_SELECTED_MARKER = "BRAIN_SELECTED_LIVE_PARITY";

function cognitiveSignal(signal: Hte31Signal) {
  return Boolean(signal.entryPlan?.checks.some((check) => check.key.startsWith("resonance-cognitive-")));
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function atr(candles: Hte31Candle[], period = 14) {
  if (candles.length <= period) return null;
  const ranges = candles.slice(1).map((candle, index) => Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - candles[index].close),
    Math.abs(candle.low - candles[index].close),
  ));
  return mean(ranges.slice(-period));
}

function volumeRatio(candles: Hte31Candle[]) {
  if (candles.length < 22) return 1;
  const baseline = mean(candles.slice(-21, -1).map((row) => row.volume));
  return candles.at(-1)!.volume / Math.max(baseline, Number.EPSILON);
}

function signed(value: number | null | undefined, side: "LONG" | "SHORT") {
  return (value ?? 0) * (side === "LONG" ? 1 : -1);
}

/**
 * A negative trader/regime/direction cell is not allowed to deadlock paper
 * learning. It may continue only when the current tape supplies stronger
 * evidence than the original setup required. The extra confirmation is stored
 * in the trade checks and remains part of the exact live strategy lineage.
 */
function strictCellChallenger(
  signal: Hte31Signal,
  packet: MarketAnalysisPacket,
  candles: Hte31Candle[],
): Hte31Signal | null {
  if (signal.side === "WAIT" || !signal.entryPlan?.ready) return null;
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  const currentAtr = atr(candles);
  if (!latest || !previous || currentAtr == null || currentAtr <= 0) return null;
  const side = signal.side;
  const body = Math.abs(latest.close - latest.open);
  const directional = side === "LONG"
    ? latest.close > latest.open && latest.close > previous.close
    : latest.close < latest.open && latest.close < previous.close;
  const higherTimeframeSupport = signed(packet.market.timeframeTrend1h, side) >= 0.10
    || signed(packet.market.timeframeTrend4h, side) >= 0.10;
  const flowSupport = signed(packet.market.spotCvdRatio, side) >= 0
    && signed(packet.market.orderBookImbalance, side) >= -0.015;
  const confirmed = directional
    && body >= currentAtr * 0.22
    && volumeRatio(candles) >= 1.08
    && higherTimeframeSupport
    && flowSupport;
  if (!confirmed) return null;
  return {
    ...signal,
    reasons: [...signal.reasons, "负期望组合仅通过更严格的挑战条件继续学习"],
    entryPlan: {
      ...signal.entryPlan,
      checks: [
        ...signal.entryPlan.checks,
        {
          key: "resonance-cognitive-cell-challenger",
          label: "负期望组合挑战确认",
          passed: true,
          required: true,
          detail: "方向K线、成交量、高周期与资金流同时确认；学习结果保留统一实盘血缘",
        },
      ],
    },
  };
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

async function paperAccount(startingCapitalUsdt: number) {
  const rows = await getDb().select().from(hte31Trades).orderBy(desc(hte31Trades.entryAt)).limit(500);
  const epoch = await currentSimulationEpoch(startingCapitalUsdt);
  const closed = rows.filter((row) => row.status === "closed" && row.entryAt >= epoch.startedAt);
  const open = rows.filter((row) => row.status === "holding");
  const realizedPnlUsdt = closed.reduce((sum, row) => sum + (row.netPnlUsdt ?? 0), 0);
  const unrealizedPnlUsdt = open.reduce((sum, row) => sum + row.unrealizedNetUsdt, 0);
  const equityUsdt = epoch.startingCapitalUsdt + realizedPnlUsdt + unrealizedPnlUsdt;
  const usedMarginUsdt = open.reduce((sum, row) => sum + row.marginUsdt, 0);
  return {
    open,
    equityUsdt,
    availableMarginUsdt: Math.max(0, equityUsdt - usedMarginUsdt),
  };
}

/**
 * Paper learning no longer treats two losses as a reason to stop collecting
 * evidence. Safety/data/liquidity/structural-stop checks still live inside the
 * playbooks and sizing layer. Statistically weak cells continue only via a
 * stricter challenger instead of waiting six hours for the clock.
 */
export async function openResonancePaperTrade(
  packet: MarketAnalysisPacket,
  signals: Hte31Signal[],
  candles: Hte31Candle[],
  settings: AppSettings,
  brainDecision: Hte31RouterDecision,
) {
  const db = getDb();
  const learningRows = await db.select().from(hte31Learning);
  const learningById = new Map(learningRows.map((row) => [row.id, row]));

  const ready = signals
    .map((signal) => ({ signal, traderId: hte31TraderIdForSignal(signal) }))
    .filter((item): item is { signal: Hte31Signal; traderId: Hte31TraderId } => Boolean(item.traderId))
    .filter(({ signal }) => signal.state === "ready" && Boolean(signal.entryPlan?.ready) && signal.side !== "WAIT")
    .map((item) => {
      const side = item.signal.side as "LONG" | "SHORT";
      const learning = learningById.get(resonanceLearningId(item.traderId, item.signal.strategyMeta.assetRegime, side, packet.observedAt));
      const performanceGate = evaluateHte31PerformanceCell(learning, packet.observedAt);
      const signal = performanceGate.state === "PAUSED" && !cognitiveSignal(item.signal)
        ? strictCellChallenger(item.signal, packet, candles)
        : item.signal;
      return signal ? { ...item, signal, performanceGate } : null;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const candidates = ready.filter((item) => item.performanceGate.state === "ACTIVE" || cognitiveSignal(item.signal));
  const selected = candidates.find((item) => item.traderId === brainDecision.selectedForExecution?.traderId);
  if (!selected?.signal.entryPlan || selected.signal.side === "WAIT") {
    return {
      opened: null,
      reason: brainDecision.selectedForExecution
        ? `${brainDecision.selectedForExecution.label} 没有通过最终学习/执行门控；本轮不改选低排名策略`
        : brainDecision.executionRule,
    };
  }

  const [existing] = await db.select({ id: hte31Trades.id }).from(hte31Trades)
    .where(and(eq(hte31Trades.symbol, packet.symbol), eq(hte31Trades.status, "holding"))).limit(1);
  if (existing) return { opened: null, reason: "该币已有 Resonance 模拟持仓" };

  const account = await paperAccount(settings.trialCapitalUsdt);
  if (account.equityUsdt <= 0) return { opened: null, reason: "模拟账户权益不足" };

  const plan = selected.signal.entryPlan;
  const entryPrice = plan.entryPrice;
  const stopDistance = Math.abs(entryPrice - plan.stopLossPrice);
  if (!(entryPrice > 0 && stopDistance > 0)) return { opened: null, reason: "结构止损无效" };

  // Losses change what the brain investigates, not the paper sample size.
  // The paper account therefore keeps the same nominal risk budget instead of
  // shrinking position size to make a weak strategy look safer.
  const sizing = buildHte31PaperPosition({
    side: selected.signal.side,
    entryPrice,
    stopLossPrice: plan.stopLossPrice,
    originalTakeProfit2Price: plan.takeProfit2Price,
    accountEquityUsdt: account.equityUsdt,
    availableMarginUsdt: account.availableMarginUsdt,
    riskMultiplier: 1,
    roundTripCostBps: settings.roundTripCostBps,
    liquidityVolumeUsd: packet.market.volumeUsd,
    atrPct: packet.decision.diagnostics.atrPct,
    dataQuality: packet.decision.dataQuality,
    confidence: selected.signal.confidence,
  });
  if (!sizing.accepted) return { opened: null, reason: `仓位经济门槛：${sizing.reason}` };

  const portfolioBlock = hte31PaperPortfolioBlockReason({
    open: account.open.map((trade) => ({ side: trade.side, riskBudgetUsdt: trade.riskBudgetUsdt })),
    nextSide: selected.signal.side,
    nextRiskUsdt: sizing.plannedRiskUsdt,
    accountEquityUsdt: account.equityUsdt,
  });
  if (portfolioBlock) return { opened: null, reason: portfolioBlock };

  const learnedAdaptation = cognitiveSignal(selected.signal) || selected.performanceGate.state === "PAUSED";
  const id = `hte31:${crypto.randomUUID()}`;
  const now = packet.observedAt;
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
    riskBudgetUsdt: sizing.plannedRiskUsdt,
    notionalUsdt: sizing.notionalUsdt,
    marginUsdt: sizing.marginUsdt,
    quantity: sizing.quantity,
    leverage: sizing.leverage,
    entryTrigger: `${BRAIN_SELECTED_MARKER} · ${hte31CanonicalStrategyLabel(selected.traderId)} · ${learnedAdaptation ? `${COGNITIVE_MARKER} · ` : ""}${selected.signal.label} · ${selected.signal.reasons.join("；")} · ${sizing.leverageReason}`,
    entryThesis: selected.signal.thesis,
    entryChecksJson: JSON.stringify(plan.checks),
    entryMetricsJson: JSON.stringify([
      ...selected.signal.metrics,
      {
        key: "brain-selection",
        label: "策略大脑选择",
        score: brainDecision.selectedForExecution?.combinedScore ?? selected.signal.confidence,
        detail: `${brainDecision.mode} · ${brainDecision.executionRule}`,
        available: true,
        category: "cross",
      },
      {
        key: "paper-position-economics",
        label: "模拟仓位经济性",
        score: sizing.plannedTp2NetProfitUsdt / Math.max(sizing.plannedRiskUsdt, 1),
        detail: `${sizing.leverage}x · 保证金 ${sizing.marginUsdt.toFixed(2)}U · 名义 ${sizing.notionalUsdt.toFixed(2)}U · 风险 ${sizing.plannedRiskUsdt.toFixed(2)}U · TP2净利 ${sizing.plannedTp2NetProfitUsdt.toFixed(2)}U`,
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
  return {
    opened: row,
    reason: learnedAdaptation
      ? `${selected.signal.label} 学习后策略由大脑选中；已建立模拟仓并保留实盘同链血缘`
      : `${selected.signal.label} 由策略大脑选中并触发模拟交易`,
  };
}
