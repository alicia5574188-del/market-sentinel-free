import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../db";
import { hte31PaperResetState, hte31SimulationEpochs, hte31TradeCharts, hte31Trades } from "../db/hte31-schema";
import { directMarketD1Admission } from "./direct-market-d1-budget.ts";
import { evaluateDirectMarketRisk, type DirectMarketResult } from "./direct-market-risk.ts";
import {
  DIRECT_MARKET_AUTHORITY,
  DIRECT_MARKET_BRAIN_VERSION,
  type DirectBrainDecisionSnapshot,
  type DirectMarketCandidate,
} from "./direct-market-types.ts";
import { buildHte31PaperPosition, hte31PaperPortfolioBlockReason } from "./hte31-position-sizing.ts";
import type { AppSettings } from "./settings-repository.ts";

const UTC_DAY_MS = 24 * 60 * 60_000;
const POSITION_DAILY_RESERVE = 8_640;

function utcDayStart(now: number) {
  return Math.floor(now / UTC_DAY_MS) * UTC_DAY_MS;
}

async function paperAccount(startingCapitalUsdt: number) {
  const db = getDb();
  const rows = await db.select().from(hte31Trades).orderBy(desc(hte31Trades.entryAt)).limit(500);
  const [epoch] = await db.select().from(hte31SimulationEpochs).orderBy(desc(hte31SimulationEpochs.startedAt)).limit(1);
  const startedAt = epoch?.startedAt ?? 0;
  const starting = epoch?.startingCapitalUsdt ?? startingCapitalUsdt;
  const open = rows.filter((row) => row.status === "holding");
  const realized = rows.filter((row) => row.status === "closed" && row.entryAt >= startedAt)
    .reduce((sum, row) => sum + (row.netPnlUsdt ?? 0), 0);
  const unrealized = open.reduce((sum, row) => sum + row.unrealizedNetUsdt, 0);
  const equityUsdt = starting + realized + unrealized;
  const usedMarginUsdt = open.reduce((sum, row) => sum + row.marginUsdt, 0);
  return { open, equityUsdt, availableMarginUsdt: Math.max(0, equityUsdt - usedMarginUsdt) };
}

export async function getDirectMarketRiskDecision() {
  const db = getDb();
  const [epoch] = await db.select({ startedAt: hte31SimulationEpochs.startedAt }).from(hte31SimulationEpochs)
    .orderBy(desc(hte31SimulationEpochs.startedAt)).limit(1);
  const rows = await db.select({
    id: hte31Trades.id,
    independentEventKey: hte31Trades.independentEventKey,
    netPnlUsdt: hte31Trades.netPnlUsdt,
    riskBudgetUsdt: hte31Trades.riskBudgetUsdt,
  }).from(hte31Trades).where(and(
    eq(hte31Trades.status, "closed"),
    eq(hte31Trades.postExitStatus, "complete"),
    eq(hte31Trades.decisionAuthority, DIRECT_MARKET_AUTHORITY),
    eq(hte31Trades.brainVersion, DIRECT_MARKET_BRAIN_VERSION),
    gte(hte31Trades.entryAt, epoch?.startedAt ?? 0),
  )).orderBy(desc(hte31Trades.exitAt)).limit(200);
  const results: DirectMarketResult[] = rows.map((row) => ({
    independentEventKey: row.independentEventKey ?? row.id,
    resultR: row.riskBudgetUsdt > 0 ? (row.netPnlUsdt ?? 0) / row.riskBudgetUsdt : 0,
  }));
  return evaluateDirectMarketRisk(results);
}

export async function openDirectMarketTrade(input: {
  candidate: DirectMarketCandidate;
  universe: string[];
  settings: AppSettings;
  portfolioRank?: number;
}) {
  const { candidate, settings } = input;
  if (candidate.decision === "WAIT" || !candidate.entryZone || !candidate.invalidationPrice || candidate.targets.length < 2) {
    return { opened: null, reason: candidate.counterEvidence[0] ?? "当前位置没有足够净优势" };
  }
  const db = getDb();
  const [pendingReset] = await db.select({ id: hte31PaperResetState.id }).from(hte31PaperResetState).where(and(
    eq(hte31PaperResetState.id, "singleton"),
    eq(hte31PaperResetState.status, "pending"),
  )).limit(1);
  if (pendingReset) return { opened: null, reason: "模拟本金等待重置，暂不新开仓" };
  const [existing] = await db.select({ id: hte31Trades.id }).from(hte31Trades).where(and(
    eq(hte31Trades.symbol, candidate.symbol),
    eq(hte31Trades.status, "holding"),
  )).limit(1);
  if (existing) return { opened: null, reason: "该币已有模拟持仓" };

  const account = await paperAccount(settings.trialCapitalUsdt);
  if (account.open.length >= 3) return { opened: null, reason: "组合已达到三笔持仓上限" };
  if (account.equityUsdt <= 0) return { opened: null, reason: "模拟账户权益不足" };
  const sameCluster = account.open.some((row) => {
    if (row.side !== candidate.decision || !row.decisionSnapshotJson) return false;
    try {
      const snapshot = JSON.parse(row.decisionSnapshotJson) as Partial<DirectBrainDecisionSnapshot>;
      return snapshot.candidate?.riskClusterId === candidate.riskClusterId;
    } catch {
      return false;
    }
  });
  if (sameCluster) return { opened: null, reason: `已有同方向 ${candidate.riskClusterId} 风险簇持仓` };

  const risk = await getDirectMarketRiskDecision();
  if (risk.state === "PAUSED") return { opened: null, reason: `市场大脑暂停新单：${risk.reason}` };
  const today = utcDayStart(candidate.observedAt);
  const todayRows = await db.select({ id: hte31Trades.id }).from(hte31Trades).where(and(
    eq(hte31Trades.decisionAuthority, DIRECT_MARKET_AUTHORITY),
    gte(hte31Trades.entryAt, today),
  )).limit(121);
  const admission = directMarketD1Admission({
    estimatedPhysicalRowsToday: POSITION_DAILY_RESERVE,
    committedMandatoryRows: todayRows.length * 100,
    newOrdersToday: todayRows.length,
  });
  if (!admission.allowed) return { opened: null, reason: `D1每日预算保护：${admission.reason}` };

  const side = candidate.decision;
  const entryPrice = (candidate.entryZone[0] + candidate.entryZone[1]) / 2;
  const sizing = buildHte31PaperPosition({
    side,
    entryPrice,
    stopLossPrice: candidate.invalidationPrice,
    originalTakeProfit2Price: candidate.targets[1],
    accountEquityUsdt: account.equityUsdt,
    availableMarginUsdt: account.availableMarginUsdt,
    riskMultiplier: 1,
    riskRate: risk.riskRate,
    minimumTp2NetProfitUsdt: 5,
    roundTripCostBps: settings.roundTripCostBps,
    liquidityVolumeUsd: candidate.volumeUsd,
    atrPct: Math.abs(entryPrice - candidate.invalidationPrice) / entryPrice * 100,
    dataQuality: candidate.checks.find((check) => check.key === "data")?.passed ? 0.85 : 0.7,
    confidence: candidate.confidence,
  });
  if (!sizing.accepted) return { opened: null, reason: `仓位经济门槛：${sizing.reason}` };
  const portfolioBlock = hte31PaperPortfolioBlockReason({
    open: account.open.map((row) => ({ side: row.side, riskBudgetUsdt: row.riskBudgetUsdt })),
    nextSide: side,
    nextRiskUsdt: sizing.plannedRiskUsdt,
    accountEquityUsdt: account.equityUsdt,
  });
  if (portfolioBlock) return { opened: null, reason: portfolioBlock };

  const id = `hte31:${crypto.randomUUID()}`;
  const independentEventKey = `${candidate.batchId}|${candidate.riskClusterId}|${side}`;
  const { candles5m: _candles, ...candidateSnapshot } = candidate;
  const snapshot: DirectBrainDecisionSnapshot = {
    id: `decision:${crypto.randomUUID()}`,
    authority: DIRECT_MARKET_AUTHORITY,
    brainVersion: DIRECT_MARKET_BRAIN_VERSION,
    parentVersion: null,
    batchId: candidate.batchId,
    universe: input.universe,
    selectedSymbol: candidate.symbol,
    portfolioRank: input.portfolioRank ?? 1,
    candidate: candidateSnapshot,
    portfolioChecks: {
      openPositionsBefore: account.open.length,
      maximumOpenPositions: 3,
      riskClusterId: candidate.riskClusterId,
      d1ProjectedRows: admission.projectedRows,
    },
    riskState: risk.state,
    createdAt: candidate.observedAt,
  };
  const row = {
    id,
    activeKey: candidate.symbol,
    symbol: candidate.symbol,
    status: "holding" as const,
    traderId: DIRECT_MARKET_AUTHORITY,
    setupId: DIRECT_MARKET_BRAIN_VERSION,
    decisionAuthority: DIRECT_MARKET_AUTHORITY,
    brainVersion: DIRECT_MARKET_BRAIN_VERSION,
    decisionSnapshotJson: JSON.stringify(snapshot),
    independentEventKey,
    side,
    assetRegime: candidate.assetRegime,
    confidence: candidate.confidence,
    entryAt: candidate.observedAt,
    entryPrice,
    initialStopPrice: candidate.invalidationPrice,
    currentStopPrice: candidate.invalidationPrice,
    takeProfit1Price: candidate.targets[0],
    takeProfit2Price: sizing.takeProfit2Price,
    target1HitAt: null,
    maxHoldingMinutes: candidate.maxHoldingMinutes,
    riskReward: sizing.riskReward,
    riskBudgetUsdt: sizing.plannedRiskUsdt,
    notionalUsdt: sizing.notionalUsdt,
    marginUsdt: sizing.marginUsdt,
    quantity: sizing.quantity,
    leverage: sizing.leverage,
    entryTrigger: `DIRECT_MARKET_BRAIN · ${candidate.location} · ${candidate.decision} · ${candidate.evidence.join("；")}`,
    entryThesis: `当前位置${side === "LONG" ? "向上" : "向下"}路径占优；目标由当前结构生成，失效价 ${candidate.invalidationPrice}`,
    entryChecksJson: JSON.stringify(candidate.checks),
    entryMetricsJson: JSON.stringify([{ key: "direct-market-decision", label: "市场大脑决策", score: candidate.netEdgeR, detail: JSON.stringify(snapshot), available: true, category: "cross" }]),
    lastPrice: entryPrice,
    lastEvaluatedAt: candidate.observedAt,
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
    createdAt: candidate.observedAt,
    updatedAt: candidate.observedAt,
  };
  await db.insert(hte31Trades).values(row);
  await db.insert(hte31TradeCharts).values({
    tradeId: id,
    symbol: candidate.symbol,
    entryCandlesJson: JSON.stringify(candidate.candles5m),
    holdingCandlesJson: "[]",
    postExitCandlesJson: "[]",
    entryQualityJson: "null",
    updatedAt: candidate.observedAt,
  });
  return { opened: row, reason: `市场大脑以 ${risk.state} 风险档建立模拟仓；决策快照已锁定供实盘原样继承` };
}
