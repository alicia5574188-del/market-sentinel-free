import { and, asc, desc, eq, lte } from "drizzle-orm";
import { getDb } from "../db";
import {
  hte31Evaluations,
  hte31Learning,
  hte31PostExitObservations,
  hte31TradeCharts,
  hte31Trades,
} from "../db/hte31-schema";
import type { GateAnalysisPacket, GatePositionQuote } from "./gate-client.ts";
import { getSettings, type AppSettings } from "./repository.ts";
import type { Candle } from "./signal-engine.ts";
import type { Strategy2Signal } from "./strategy-2-engine.ts";
import type { HumanTraderId } from "./human-trader-engine.ts";

const POST_EXIT_HORIZONS = [0, 30, 60, 120, 240, 720] as const;
const TRADERS: HumanTraderId[] = ["dennis_trend", "raschke_pullback", "turtle_soup"];

function traderIdForSignal(signal: Strategy2Signal): HumanTraderId | null {
  if (signal.strategyId === "trend_breakout") return "dennis_trend";
  if (signal.strategyId === "trend_pullback") return "raschke_pullback";
  if (signal.strategyId === "failed_breakout") return "turtle_soup";
  return null;
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

export type Hte31TraderGuard = {
  state: "ACTIVE" | "COOLDOWN" | "PAUSED";
  lossStreak: number;
  retryAfter: number | null;
  reason: string;
};

export type Hte31Governance = {
  state: "NORMAL" | "CAUTION" | "DEFENSIVE" | "PAUSED";
  riskMultiplier: number;
  lossStreak: number;
  reason: string;
  traderGuards: Record<HumanTraderId, Hte31TraderGuard>;
};

export async function getHte31Governance(now = Date.now()): Promise<Hte31Governance> {
  const rows = await getDb().select().from(hte31Trades)
    .where(eq(hte31Trades.status, "closed"))
    .orderBy(desc(hte31Trades.exitAt)).limit(80);

  const traderGuards = Object.fromEntries(TRADERS.map((traderId) => {
    const own = rows.filter((row) => row.traderId === traderId && row.exitAt != null);
    let lossStreak = 0;
    for (const row of own) {
      if ((row.netPnlUsdt ?? 0) < 0) lossStreak += 1;
      else break;
    }
    const latestExit = own[0]?.exitAt ?? null;
    const cooldownMs = lossStreak >= 4 ? 12 * 60 * 60_000 : lossStreak >= 3 ? 6 * 60 * 60_000 : lossStreak >= 2 ? 2 * 60 * 60_000 : 0;
    const retryAfter = latestExit && cooldownMs ? latestExit + cooldownMs : null;
    const grossProfit = own.reduce((sum, row) => sum + Math.max(0, row.netPnlUsdt ?? 0), 0);
    const grossLoss = Math.abs(own.reduce((sum, row) => sum + Math.min(0, row.netPnlUsdt ?? 0), 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : null;
    const longTermPaused = own.length >= 12 && pf != null && pf < 0.72;
    const cooling = retryAfter != null && retryAfter > now;
    const state: Hte31TraderGuard["state"] = longTermPaused ? "PAUSED" : cooling ? "COOLDOWN" : "ACTIVE";
    return [traderId, {
      state,
      lossStreak,
      retryAfter: cooling ? retryAfter : null,
      reason: longTermPaused
        ? `最近 ${own.length} 笔长期 PF ${pf?.toFixed(2)}，暂停该交易员等待重新验证`
        : cooling
          ? `连续亏损 ${lossStreak} 笔，独立冷却至 ${new Date(retryAfter!).toLocaleString("zh-CN")}`
          : lossStreak ? `已完成冷却；此前连续亏损 ${lossStreak} 笔` : "独立交易员正常",
    } satisfies Hte31TraderGuard];
  })) as Record<HumanTraderId, Hte31TraderGuard>;

  let lossStreak = 0;
  const streakTraders = new Set<string>();
  for (const row of rows) {
    if ((row.netPnlUsdt ?? 0) < 0) {
      lossStreak += 1;
      streakTraders.add(row.traderId);
    } else break;
  }
  const diversifiedLoss = streakTraders.size >= 2;
  const state: Hte31Governance["state"] = diversifiedLoss && lossStreak >= 8 ? "PAUSED"
    : diversifiedLoss && lossStreak >= 6 ? "DEFENSIVE"
      : diversifiedLoss && lossStreak >= 4 ? "CAUTION" : "NORMAL";
  const riskMultiplier = state === "PAUSED" ? 0 : state === "DEFENSIVE" ? 0.35 : state === "CAUTION" ? 0.6 : 1;
  return {
    state,
    riskMultiplier,
    lossStreak,
    reason: state === "NORMAL"
      ? `Clean Risk Governor 正常；跨交易员连续亏损 ${diversifiedLoss ? lossStreak : 0}`
      : `至少两位独立交易员共同出现 ${lossStreak} 笔连续亏损，账户进入 ${state}`,
    traderGuards,
  };
}

export async function recordHte31Evaluations(packet: GateAnalysisPacket, signals: Strategy2Signal[]) {
  const db = getDb();
  const rows = signals.flatMap((signal) => {
    const traderId = traderIdForSignal(signal);
    if (!traderId) return [];
    return [{
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
    }];
  });
  for (const row of rows) {
    await db.insert(hte31Evaluations).values(row).onConflictDoNothing();
  }
  return rows.length;
}

async function accountFromRows(startingCapitalUsdt: number) {
  const rows = await getDb().select().from(hte31Trades).orderBy(desc(hte31Trades.entryAt)).limit(500);
  const closed = rows.filter((row) => row.status === "closed");
  const open = rows.filter((row) => row.status === "holding");
  const realizedPnlUsdt = closed.reduce((sum, row) => sum + (row.netPnlUsdt ?? 0), 0);
  const unrealizedPnlUsdt = open.reduce((sum, row) => sum + row.unrealizedNetUsdt, 0);
  const realizedBalanceUsdt = startingCapitalUsdt + realizedPnlUsdt;
  const equityUsdt = realizedBalanceUsdt + unrealizedPnlUsdt;
  const usedMarginUsdt = open.reduce((sum, row) => sum + row.marginUsdt, 0);
  return {
    rows,
    closed,
    open,
    account: {
      startingCapitalUsdt,
      realizedPnlUsdt,
      unrealizedPnlUsdt,
      realizedBalanceUsdt,
      equityUsdt,
      usedMarginUsdt,
      availableMarginUsdt: Math.max(0, equityUsdt - usedMarginUsdt),
    },
  };
}

export async function tryOpenHte31Trade(
  packet: GateAnalysisPacket,
  signals: Strategy2Signal[],
  candles: Candle[],
  settings: AppSettings,
) {
  const db = getDb();
  const governance = await getHte31Governance(packet.observedAt);
  if (governance.state === "PAUSED") return { opened: null, reason: governance.reason };

  const candidates = signals
    .map((signal) => ({ signal, traderId: traderIdForSignal(signal) }))
    .filter((item): item is { signal: Strategy2Signal; traderId: HumanTraderId } => Boolean(item.traderId))
    .filter(({ signal, traderId }) => signal.state === "ready" && Boolean(signal.entryPlan?.ready) && signal.side !== "WAIT" && governance.traderGuards[traderId].state === "ACTIVE")
    .sort((a, b) => b.signal.confidence - a.signal.confidence || Math.abs(b.signal.score) - Math.abs(a.signal.score));
  const selected = candidates[0];
  if (!selected?.signal.entryPlan || selected.signal.side === "WAIT") return { opened: null, reason: "三位交易员本轮没有完整 Setup" };

  const [existing] = await db.select({ id: hte31Trades.id }).from(hte31Trades)
    .where(and(eq(hte31Trades.symbol, packet.symbol), eq(hte31Trades.status, "holding"))).limit(1);
  if (existing) return { opened: null, reason: "该币已有 HTE 3.1 模拟持仓" };

  const { open, account } = await accountFromRows(settings.trialCapitalUsdt);
  if (open.length >= 2) return { opened: null, reason: "Clean 账户同时最多 2 笔模拟持仓" };
  if (account.equityUsdt <= 0) return { opened: null, reason: "模拟账户权益不足" };

  const plan = selected.signal.entryPlan;
  const entryPrice = plan.entryPrice;
  const stopDistance = Math.abs(entryPrice - plan.stopLossPrice);
  if (!(entryPrice > 0 && stopDistance > 0)) return { opened: null, reason: "结构止损无效" };

  const baseRisk = Math.min(settings.maxRiskPerAlertUsdt, Math.max(2, account.equityUsdt * 0.01));
  const riskBudgetUsdt = baseRisk * governance.riskMultiplier;
  if (riskBudgetUsdt <= 0) return { opened: null, reason: "Risk Governor 当前不分配新风险" };
  let quantity = riskBudgetUsdt / stopDistance;
  let notionalUsdt = quantity * entryPrice;
  let leverage = clamp(Math.ceil(notionalUsdt / Math.max(account.equityUsdt * 0.18, 1)), 1, 3);
  let marginUsdt = notionalUsdt / leverage;
  const maxMargin = Math.max(0, Math.min(account.availableMarginUsdt, account.equityUsdt * 0.25));
  if (marginUsdt > maxMargin && maxMargin > 0) {
    marginUsdt = maxMargin;
    notionalUsdt = marginUsdt * leverage;
    quantity = notionalUsdt / entryPrice;
  }
  if (marginUsdt <= 0 || notionalUsdt <= 0) return { opened: null, reason: "可用保证金不足" };

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
    takeProfit2Price: plan.takeProfit2Price,
    target1HitAt: null,
    maxHoldingMinutes: plan.maxHoldingMinutes,
    riskReward: plan.riskReward,
    riskBudgetUsdt,
    notionalUsdt,
    marginUsdt,
    quantity,
    leverage,
    entryTrigger: `${selected.signal.label} · ${selected.signal.reasons.join("；")}`,
    entryThesis: selected.signal.thesis,
    entryChecksJson: JSON.stringify(plan.checks),
    entryMetricsJson: JSON.stringify(selected.signal.metrics),
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
    updatedAt: now,
  });
  return { opened: row, reason: `${selected.signal.label} 独立 Setup 完整触发` };
}

async function updateLearningAfterClose(trade: typeof hte31Trades.$inferSelect, netPnlUsdt: number, mfePct: number, maePct: number, now: number) {
  const db = getDb();
  const id = `${trade.traderId}|${trade.assetRegime}|${trade.side}`;
  const [existing] = await db.select().from(hte31Learning).where(eq(hte31Learning.id, id)).limit(1);
  const r = trade.riskBudgetUsdt > 0 ? netPnlUsdt / trade.riskBudgetUsdt : 0;
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
      losses: netPnlUsdt < 0 ? 1 : 0,
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
    losses: existing.losses + (netPnlUsdt < 0 ? 1 : 0),
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

  const high = quote.highPrice ?? quote.price;
  const low = quote.lowPrice ?? quote.price;
  const maxPriceSeen = Math.max(trade.maxPriceSeen, high, quote.price);
  const minPriceSeen = Math.min(trade.minPriceSeen, low, quote.price);
  const tp1Hit = trade.side === "LONG" ? high >= trade.takeProfit1Price : low <= trade.takeProfit1Price;
  const target1HitAt = trade.target1HitAt ?? (tp1Hit ? quote.observedAt : null);
  const currentStopPrice = target1HitAt ? (trade.side === "LONG" ? Math.max(trade.currentStopPrice, trade.entryPrice) : Math.min(trade.currentStopPrice, trade.entryPrice)) : trade.currentStopPrice;

  const stopHit = trade.side === "LONG" ? low <= currentStopPrice : high >= currentStopPrice;
  const tp2Hit = trade.side === "LONG" ? high >= trade.takeProfit2Price : low <= trade.takeProfit2Price;
  const timeout = quote.observedAt - trade.entryAt >= trade.maxHoldingMinutes * 60_000;
  let exitCode: string | null = null;
  let exitReason: string | null = null;
  let exitPrice: number | null = null;
  // Conservative same-candle ordering: when stop and target are both touched,
  // the simulation assumes the protective stop was hit first.
  if (stopHit) {
    exitCode = target1HitAt && currentStopPrice === trade.entryPrice ? "breakeven" : "stop_loss";
    exitReason = exitCode === "breakeven" ? "TP1 后保护止损被触发" : "结构止损被触发";
    exitPrice = currentStopPrice;
  } else if (tp2Hit) {
    exitCode = "take_profit";
    exitReason = "第二目标完成，按交易员计划退出";
    exitPrice = trade.takeProfit2Price;
  } else if (timeout) {
    exitCode = "timeout";
    exitReason = `超过 ${trade.maxHoldingMinutes} 分钟仍未兑现预期行为，执行时间止损`;
    exitPrice = quote.price;
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
    const excursion = excursionPct(trade.side, trade.entryPrice, maxPriceSeen, minPriceSeen);
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
        price: null,
        favorablePct: null,
        adversePct: null,
        favorableR: null,
        adverseR: null,
        candlesJson: "[]",
      }).onConflictDoNothing();
    }
    await updateLearningAfterClose(trade, netPnlUsdt, excursion.mfe, excursion.mae, quote.observedAt);
    return { kind: "closed" as const, tradeId: trade.id, exitCode, exitPrice, netPnlUsdt };
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
    entryCandles: parseJson<Candle[]>(chart.entryCandlesJson, []),
    holdingCandles: parseJson<Candle[]>(chart.holdingCandlesJson, []),
    postExitCandles: parseJson<Candle[]>(chart.postExitCandlesJson, []),
  } : null;
}

export async function nextHte31PostExitObservation(now = Date.now()) {
  const [row] = await getDb().select().from(hte31PostExitObservations)
    .where(and(eq(hte31PostExitObservations.status, "pending"), lte(hte31PostExitObservations.dueAt, now)))
    .orderBy(asc(hte31PostExitObservations.dueAt)).limit(1);
  if (!row) return null;
  const trade = await getHte31Trade(row.tradeId);
  return trade ? { observation: row, trade } : null;
}

export async function completeHte31PostExitObservation(trade: typeof hte31Trades.$inferSelect, horizonMinutes: number, candles: Candle[], now = Date.now()) {
  if (!trade.exitAt || !trade.exitPrice) return;
  const db = getDb();
  const rows = candles.filter((candle) => {
    const time = candle.time > 10_000_000_000 ? candle.time : candle.time * 1000;
    return time >= trade.exitAt;
  });
  const high = rows.length ? Math.max(...rows.map((candle) => candle.high)) : trade.exitPrice;
  const low = rows.length ? Math.min(...rows.map((candle) => candle.low)) : trade.exitPrice;
  const currentPrice = rows.at(-1)?.close ?? trade.exitPrice;
  const favorablePct = trade.side === "LONG" ? Math.max(0, (high / trade.exitPrice - 1) * 100) : Math.max(0, (1 - low / trade.exitPrice) * 100);
  const adversePct = trade.side === "LONG" ? Math.max(0, (1 - low / trade.exitPrice) * 100) : Math.max(0, (high / trade.exitPrice - 1) * 100);
  const riskPct = Math.abs(trade.entryPrice - trade.initialStopPrice) / trade.entryPrice * 100;
  const favorableR = riskPct > 0 ? favorablePct / riskPct : 0;
  const adverseR = riskPct > 0 ? adversePct / riskPct : 0;
  const capturedPct = Math.max(0, grossMovePct(trade.side, trade.entryPrice, trade.exitPrice));
  const totalPotentialPct = Math.max(capturedPct, capturedPct + favorablePct);
  const exitCapturePct = totalPotentialPct > 0 ? clamp(capturedPct / totalPotentialPct * 100, 0, 100) : 100;
  const stopRecovery = trade.exitCode === "stop_loss" && favorableR >= 1;
  let postExitLabel = "退出合理";
  if (stopRecovery) postExitLabel = "疑似假止损";
  else if (favorableR >= 1.25) postExitLabel = "退出偏早";
  else if ((trade.mfePct ?? 0) > 0 && capturedPct < (trade.mfePct ?? 0) * 0.45) postExitLabel = "退出偏晚";
  else if (adverseR >= 1 && favorableR < 0.5) postExitLabel = "退出优秀";
  const exitEfficiency = clamp((exitCapturePct * 0.65) + Math.min(100, adverseR * 50) * 0.25 + Math.max(0, 10 - favorableR * 8), 0, 100);

  await db.update(hte31PostExitObservations).set({
    observedAt: now,
    status: "complete",
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
    await db.update(hte31TradeCharts).set({
      holdingCandlesJson: horizonMinutes === 0 ? JSON.stringify(fullWindow) : chart.holdingCandlesJson,
      postExitCandlesJson: horizonMinutes > 0 ? JSON.stringify(rows.slice(-160)) : chart.postExitCandlesJson,
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

  if (complete) {
    const learningId = `${trade.traderId}|${trade.assetRegime}|${trade.side}`;
    const [learning] = await db.select().from(hte31Learning).where(eq(hte31Learning.id, learningId)).limit(1);
    if (learning?.sampleCount) {
      await db.update(hte31Learning).set({
        averageExitEfficiency: (learning.averageExitEfficiency * Math.max(0, learning.sampleCount - 1) + exitEfficiency) / learning.sampleCount,
        updatedAt: now,
      }).where(eq(hte31Learning.id, learningId));
    }
  }
}

export async function getHte31Dashboard(now = Date.now()) {
  const settings = await getSettings();
  const { rows, closed, open, account } = await accountFromRows(settings.trialCapitalUsdt);
  const evaluations = await getDb().select().from(hte31Evaluations)
    .where(lte(hte31Evaluations.observedAt, now))
    .orderBy(desc(hte31Evaluations.observedAt)).limit(120);
  const freshEvaluations = evaluations.filter((row) => now - row.observedAt <= 15 * 60_000);
  const learning = await getDb().select().from(hte31Learning).orderBy(desc(hte31Learning.updatedAt)).limit(100);
  const governance = await getHte31Governance(now);
  const tenMinute = evaluations.filter((row) => now - row.observedAt <= 10 * 60_000);
  const grossProfit = closed.reduce((sum, row) => sum + Math.max(0, row.netPnlUsdt ?? 0), 0);
  const grossLoss = Math.abs(closed.reduce((sum, row) => sum + Math.min(0, row.netPnlUsdt ?? 0), 0));
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
      losses: closed.filter((row) => (row.netPnlUsdt ?? 0) < 0).length,
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
