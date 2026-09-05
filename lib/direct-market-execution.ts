import { analogRiskAllocation, ANALOG_POSITION_POLICY, ANALOG_RISK_POLICY } from "./analog-path-strategy.ts";
import { scalpCostBps, correlatedScalpExposure } from "./scalp-strategy.ts";
import { and, desc, eq, gte, or, sql, lt } from "drizzle-orm";
import { getDb } from "../db";
import { hte31PaperResetState, hte31SimulationEpochs, hte31TradeCharts, hte31Trades } from "../db/hte31-schema";
import { directMarketD1Admission, directMarketPositionCheckpointRows } from "./direct-market-d1-budget.ts";
import { validateDirectMarketEntry } from "./direct-market-entry.ts";
import {
  deriveDirectMarketLearningProfile,
  directMarketCandidateSignature,
  type DirectMarketLearningSample,
} from "./direct-market-learning.ts";
import { ensureDirectMarketReleaseCutover } from "./direct-market-release.ts";
import { evaluateDirectMarketRisk, type DirectMarketResult } from "./direct-market-risk.ts";
import {
  DIRECT_MARKET_AUTHORITY,
  DIRECT_MARKET_BRAIN_VERSION,
  type DirectBrainDecisionSnapshot,
  type DirectMarketCandidate,
} from "./direct-market-types.ts";
import { buildHte31PaperPosition, hte31PaperPortfolioBlockReason } from "./hte31-position-sizing.ts";
import type { MarketPositionQuote } from "./exchange-market.ts";
import type { AppSettings } from "./settings-repository.ts";

const UTC_DAY_MS = 24 * 60 * 60_000;
const POSITION_MINIMUM_DAILY_RESERVE = 8_640;

function utcDayStart(now: number) {
  return Math.floor(now / UTC_DAY_MS) * UTC_DAY_MS;
}

export async function scalpAccountRisk(startingCapitalUsdt:number, costBps:number, now=Date.now()) {
  const db=getDb(), day=utcDayStart(now);
  const [epoch]=await db.select().from(hte31SimulationEpochs).orderBy(desc(hte31SimulationEpochs.startedAt)).limit(1);
  const epochAt=epoch?.startedAt??0, starting=epoch?.startingCapitalUsdt??startingCapitalUsdt;
  const id=`${epochAt}:${day}`;
  let state=await db.get<{dayBase:number}>(sql`SELECT day_base AS dayBase FROM scalp_risk_days WHERE id=${id}`);
  const open=await db.select().from(hte31Trades).where(eq(hte31Trades.status,"holding"));
  if(!state) {
    const [before]=await db.select({net:sql<number>`coalesce(sum(${hte31Trades.netPnlUsdt}),0)`}).from(hte31Trades)
      .where(and(eq(hte31Trades.status,"closed"),gte(hte31Trades.entryAt,epochAt),lt(hte31Trades.exitAt,day)));
    const dayBase=starting+Number(before?.net??0);
    await db.run(sql`INSERT OR IGNORE INTO scalp_risk_days(id,day_base,halted_until,updated_at) VALUES(${id},${dayBase},0,${now})`);
    state={dayBase};
  }
  const closed=await db.select({net:hte31Trades.netPnlUsdt,exitAt:hte31Trades.exitAt}).from(hte31Trades)
    .where(and(eq(hte31Trades.status,"closed"),gte(hte31Trades.entryAt,epochAt),gte(hte31Trades.exitAt,day))).orderBy(desc(hte31Trades.exitAt));
  const realized=closed.reduce((a,c)=>a+(c.net??0),0);
  // Include full estimated liquidation costs, even before the first holding checkpoint.
  const unrealized=open.reduce((a,t)=>{
    let frozenCost=costBps;
    try { frozenCost=JSON.parse(t.decisionSnapshotJson)?.candidate?.scalp?.costBps??costBps; } catch { /* Unreadable legacy rows keep conservative configured costs. */ }
    return a+t.notionalUsdt*((t.side==='LONG'?1:-1)*(t.lastPrice/t.entryPrice-1)-scalpCostBps(frozenCost)/10_000);
  },0);
  const equityUsdt=state.dayBase+realized+unrealized;
  return {open,equityUsdt,availableMarginUsdt:Math.max(0,equityUsdt-open.reduce((a,t)=>a+t.marginUsdt,0)),reason:null};
}

export async function getDirectMarketRiskDecision() {
  const db = getDb();
  const [epoch] = await db.select({ startedAt: hte31SimulationEpochs.startedAt }).from(hte31SimulationEpochs)
    .orderBy(desc(hte31SimulationEpochs.startedAt)).limit(1);
  const rows = await db.select({
    id: hte31Trades.id,
    exitAt: hte31Trades.exitAt,
    independentEventKey: hte31Trades.independentEventKey,
    netPnlUsdt: hte31Trades.netPnlUsdt,
    riskBudgetUsdt: hte31Trades.riskBudgetUsdt,
  }).from(hte31Trades).where(and(
    eq(hte31Trades.status, "closed"),
    eq(hte31Trades.decisionAuthority, DIRECT_MARKET_AUTHORITY),
    eq(hte31Trades.brainVersion, DIRECT_MARKET_BRAIN_VERSION),
    gte(hte31Trades.entryAt, epoch?.startedAt ?? 0),
  )).orderBy(desc(hte31Trades.exitAt)).limit(200);
  const results: DirectMarketResult[] = rows.map((row) => ({
    independentEventKey: row.independentEventKey ?? row.id,
    resultR: row.riskBudgetUsdt > 0 ? (row.netPnlUsdt ?? 0) / row.riskBudgetUsdt : 0,
  }));
  const evaluated=evaluateDirectMarketRisk(results);
  return {...evaluated,state:results.length<12?"CALIBRATING" as const:"VALIDATING" as const,riskRate:ANALOG_RISK_POLICY.riskRate,
    reason:`持续运行，不因连续亏损或当日模拟亏损暂停；单笔含费风险上限4.00%；TP2扣费后至少30U；${evaluated.reason}`};
}

export async function getDirectMarketLearningDecision() {
  const rows = await getDb().select({
    id: hte31Trades.id,
    independentEventKey: hte31Trades.independentEventKey,
    netPnlUsdt: hte31Trades.netPnlUsdt,
    riskBudgetUsdt: hte31Trades.riskBudgetUsdt,
    side: hte31Trades.side,
    assetRegime: hte31Trades.assetRegime,
    decisionSnapshotJson: hte31Trades.decisionSnapshotJson,
    postExitStatus: hte31Trades.postExitStatus,
    exitAt: hte31Trades.exitAt,
  }).from(hte31Trades).where(and(
    eq(hte31Trades.status, "closed"),
    eq(hte31Trades.postExitStatus, "complete"),
    eq(hte31Trades.decisionAuthority, DIRECT_MARKET_AUTHORITY),
    eq(hte31Trades.brainVersion, DIRECT_MARKET_BRAIN_VERSION),
  )).orderBy(desc(hte31Trades.exitAt)).limit(200);
  const samples: DirectMarketLearningSample[] = rows.map((row) => {
    let signature = `UNKNOWN|${row.side}|${row.assetRegime}`;
    try {
      const snapshot = JSON.parse(row.decisionSnapshotJson) as Partial<DirectBrainDecisionSnapshot>;
      if (snapshot.candidate) signature = directMarketCandidateSignature(snapshot.candidate);
    } catch {
      // Historical rows without a readable snapshot remain isolated in an
      // UNKNOWN signature instead of contaminating a current location rule.
    }
    return {
      independentEventKey: row.independentEventKey ?? row.id,
      resultR: row.riskBudgetUsdt > 0 ? (row.netPnlUsdt ?? 0) / row.riskBudgetUsdt : 0,
      signature,
      exitAt: row.exitAt ?? 0,
      complete: row.postExitStatus === "complete",
    };
  });
  return deriveDirectMarketLearningProfile(samples);
}

export async function openDirectMarketTrade(input: {
  candidate: DirectMarketCandidate;
  universe: string[];
  settings: AppSettings;
  freshQuote: Pick<MarketPositionQuote, "symbol" | "price" | "observedAt"> | null;
  portfolioRank?: number;
}) {
  const { candidate, settings } = input;
  if (candidate.decision === "WAIT" || !candidate.entryZone || !candidate.invalidationPrice || candidate.targets.length < 2) {
    return { opened: null, reason: candidate.counterEvidence[0] ?? "当前位置没有足够净优势" };
  }
  const entryValidation = validateDirectMarketEntry(candidate, input.freshQuote, Date.now());
  if (!entryValidation.allowed || entryValidation.entryPrice == null || entryValidation.rewardRisk == null) {
    return { opened: null, reason: `开仓复核：${entryValidation.reason}` };
  }
  const executionNow = Date.now();
  if (!candidate.scalp || candidate.setup !== "ANALOG_PATH") return { opened: null, reason: "当前版本只接受历史路径方向交易" };
  const db = getDb();
  await ensureDirectMarketReleaseCutover(settings.trialCapitalUsdt, executionNow);
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
  const [recentClosed] = await db.select({ exitAt: hte31Trades.exitAt }).from(hte31Trades).where(and(
    eq(hte31Trades.symbol, candidate.symbol),
    eq(hte31Trades.status, "closed"),
    eq(hte31Trades.decisionAuthority, DIRECT_MARKET_AUTHORITY),
  )).orderBy(desc(hte31Trades.exitAt)).limit(1);
  if (recentClosed?.exitAt && executionNow - recentClosed.exitAt < 5 * 60_000) {
    return { opened: null, reason: "刚结束同币种判断，等待一根完整5分钟K线后重新决策" };
  }

  if (recentClosed?.exitAt && candidate.scalp.structureAt <= recentClosed.exitAt) return {opened:null,reason:"等待平仓后形成新的历史预测计划"};
  const [duplicate]=await db.select({id:hte31Trades.id}).from(hte31Trades).where(eq(hte31Trades.independentEventKey,candidate.scalp.signalKey)).limit(1);
  if(duplicate) return {opened:null,reason:"同一历史预测计划已处理"};
  const account = await scalpAccountRisk(settings.trialCapitalUsdt, settings.roundTripCostBps, executionNow);
  if(account.reason) return {opened:null,reason:account.reason};
  if(account.open.some(t=>executionNow-t.lastEvaluatedAt>90_000)) return {opened:null,reason:"已有持仓报价过期，先恢复持仓保护"};
  if (account.equityUsdt <= 0) return { opened: null, reason: "模拟账户权益不足" };
  const sameCluster = account.open.some((row) => {
    if (!row.decisionSnapshotJson) return true;
    try {
      const snapshot = JSON.parse(row.decisionSnapshotJson) as Partial<DirectBrainDecisionSnapshot>;
      return correlatedScalpExposure({side:candidate.decision as "LONG"|"SHORT",correlation:candidate.btcCorrelation},
        {side:row.side,correlation:snapshot.candidate?.btcCorrelation??null});
    } catch {
      return true;
    }
  });


  // PAPER keeps collecting outcomes through losing runs. Structural capital, quote,
  // D1, duplicate-plan and portfolio boundaries remain mandatory.
  const riskRate=analogRiskAllocation(account.equityUsdt,account.open.reduce((sum,row)=>sum+row.riskBudgetUsdt,0),input.universe.length-account.open.length,sameCluster);
  if(riskRate<=0)return {opened:null,reason:"组合风险预算已用尽"};
  const risk={state:"CALIBRATING" as const,riskRate};
  const learning=deriveDirectMarketLearningProfile([]);
  const learningAdmission={revalidation:false};
  const setupGuard={reason:"单笔最多4.00%，组合12.00%；每单按真实TP2倒算放大至扣费后至少30U且不限制上方利润",revalidation:false};
  const today = utcDayStart(executionNow);
  const todayRows = await db.select({ entryAt: hte31Trades.entryAt, decisionSnapshotJson: hte31Trades.decisionSnapshotJson }).from(hte31Trades).where(and(
    eq(hte31Trades.decisionAuthority, DIRECT_MARKET_AUTHORITY),
    or(gte(hte31Trades.entryAt, today), gte(hte31Trades.exitAt, today)),
  )).limit(241);
  if (todayRows.length >= 241) return { opened: null, reason: "当日仓位历史超出预算校验范围，暂不新开仓" };
  const admission = directMarketD1Admission({
    estimatedPhysicalRowsToday: Math.max(POSITION_MINIMUM_DAILY_RESERVE,
      directMarketPositionCheckpointRows(account.open.length + 1, todayRows.map((row) => row.decisionSnapshotJson))),
    committedMandatoryRows: todayRows.length * 100,
    newOrdersToday: todayRows.filter((row) => row.entryAt >= today).length,
  });
  if (!admission.allowed) return { opened: null, reason: `D1每日预算保护：${admission.reason}` };

  const side = candidate.decision;
  const entryPrice = entryValidation.entryPrice;
  const sizing = buildHte31PaperPosition({
    side,
    entryPrice,
    stopLossPrice: candidate.invalidationPrice,
    originalTakeProfit2Price: candidate.targets[1],
    accountEquityUsdt: account.equityUsdt,
    availableMarginUsdt: Math.max(0,account.availableMarginUsdt-account.equityUsdt*0.05),
    riskMultiplier: 1,
    riskRate: risk.riskRate,
    roundTripCostBps: scalpCostBps(settings.roundTripCostBps),
    minimumTp2NetProfitUsdt: ANALOG_RISK_POLICY.minimumTp2NetProfitUsdt,
    sizeToMinimumTp2NetProfit: true,
    minimumRiskRate: 0,
    liquidityVolumeUsd: candidate.volumeUsd,
    atrPct: Math.abs(entryPrice - candidate.invalidationPrice) / entryPrice * 100,
    dataQuality: candidate.checks.find((check) => check.key === "data")?.passed ? 0.85 : 0.7,
    confidence: candidate.confidence,
  });
  if (!sizing.accepted) return { opened: null, reason: `仓位经济门槛：${sizing.reason}` };
  const portfolioBlock = hte31PaperPortfolioBlockReason({
    maximumTotalPlannedRiskRate: ANALOG_RISK_POLICY.portfolioRiskRate,
    open: account.open.map((row) => ({ side: row.side, riskBudgetUsdt: row.riskBudgetUsdt })),
    nextSide: side,
    nextRiskUsdt: sizing.plannedRiskUsdt,
    accountEquityUsdt: account.equityUsdt,
  });
  if (portfolioBlock) return { opened: null, reason: portfolioBlock };

  const id = `hte31:${crypto.randomUUID()}`;
  const independentEventKey = candidate.scalp.signalKey;
  const { candles5m: _candles, ...candidateSnapshot } = candidate;
  void _candles;
  const snapshot: DirectBrainDecisionSnapshot = {
    id: `decision:${crypto.randomUUID()}`,
    authority: DIRECT_MARKET_AUTHORITY,
    brainVersion: DIRECT_MARKET_BRAIN_VERSION,
    parentVersion: learning.parentVersion,
    decisionPolicyVersion: learning.version,
    positionPolicyVersion: ANALOG_POSITION_POLICY,
    batchId: candidate.batchId,
    universe: input.universe,
    selectedSymbol: candidate.symbol,
    portfolioRank: input.portfolioRank ?? 1,
    candidate: candidateSnapshot,
    portfolioChecks: {
      openPositionsBefore: account.open.length,
      maximumOpenPositions: null,
      maximumTotalPlannedRiskRate: ANALOG_RISK_POLICY.portfolioRiskRate,
      riskClusterId: candidate.riskClusterId,
      d1ProjectedRows: admission.projectedRows,
      sameDirectionMaximum: null,
      setupGuard: setupGuard.reason,
    },
    entryValidation: {
      quoteObservedAt: executionNow,
      candidateAgeMs: executionNow - candidate.observedAt,
      entryPrice,
      rewardRisk: entryValidation.rewardRisk,
    },
    learningRule: {
      action: learning.action,
      reason: learning.reason,
      evidenceCount: learning.evidenceCount,
      revalidation: learningAdmission.revalidation || setupGuard.revalidation,
    },
    riskState: risk.state,
    createdAt: executionNow,
  };
  const row = {
    id,
    activeKey: candidate.symbol,
    symbol: candidate.symbol,
    status: "holding" as const,
    traderId: DIRECT_MARKET_AUTHORITY,
    setupId: candidate.setup,
    decisionAuthority: DIRECT_MARKET_AUTHORITY,
    brainVersion: DIRECT_MARKET_BRAIN_VERSION,
    decisionSnapshotJson: JSON.stringify(snapshot),
    independentEventKey,
    side,
    assetRegime: candidate.assetRegime,
    confidence: candidate.confidence,
    entryAt: executionNow,
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
    entryTrigger: `DIRECT_MARKET_BRAIN · ${candidate.setupLabel} · ${learning.version} · ${candidate.location} · ${candidate.decision} · ${candidate.evidence.join("；")}`,
    entryThesis: `${candidate.setupLabel}在当前位置形成${side === "LONG" ? "做多" : "做空"}机会；${entryValidation.reason}；结构失效价 ${candidate.invalidationPrice}`,
    entryChecksJson: JSON.stringify(candidate.checks),
    entryMetricsJson: JSON.stringify([{ key: "direct-market-decision", label: "市场大脑决策", score: candidate.netEdgeR, detail: JSON.stringify(snapshot), available: true, category: "cross" }]),
    lastPrice: entryPrice,
    lastEvaluatedAt: executionNow,
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
    createdAt: executionNow,
    updatedAt: executionNow,
  };
  await db.insert(hte31Trades).values(row);
  await db.insert(hte31TradeCharts).values({
    tradeId: id,
    symbol: candidate.symbol,
    entryCandlesJson: JSON.stringify(candidate.candles5m),
    holdingCandlesJson: "[]",
    postExitCandlesJson: "[]",
    entryQualityJson: "null",
    updatedAt: executionNow,
  });
  return { opened: row, reason: `市场大脑以 ${risk.state} 风险档建立模拟仓；决策快照已锁定；一分钟回踩策略仅在模拟验证` };
}
