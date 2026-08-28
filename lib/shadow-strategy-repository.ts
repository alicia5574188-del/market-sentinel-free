import { and, desc, eq, inArray, like, notLike } from "drizzle-orm";
import { getDb } from "../db";
import { tradeCases } from "../db/schema";
import type { GateAnalysisPacket } from "./gate-client.ts";
import { processDecision, type AppSettings, type LifecycleResult } from "./repository.ts";
import type { Candle } from "./signal-engine.ts";
import { type Strategy2Id, type Strategy2Signal } from "./strategy-2-engine.ts";
import { HUMAN_TRADER_LABELS } from "./human-trader-engine.ts";
import { calculateStrategyStatistics, type StrategyStatistics } from "./strategy-promotion.ts";

const LEGACY_SHADOW_PREFIX = "shadow_v3:";
const HUMAN_REGIME_PREFIX = "S2|HT";
const HUMAN_TRADERS: { id: Strategy2Id; label: string }[] = [
  { id: "trend_breakout", label: HUMAN_TRADER_LABELS.dennis_trend },
  { id: "trend_pullback", label: HUMAN_TRADER_LABELS.raschke_pullback },
  { id: "failed_breakout", label: HUMAN_TRADER_LABELS.turtle_soup },
];
const GOVERNOR_CACHE_MS = 60_000;

type ReadyGrowthSignal = Strategy2Signal & { side: "LONG" | "SHORT"; entryPlan: NonNullable<Strategy2Signal["entryPlan"]> };
export type GrowthModuleResult = { opened: number; closed: number; evaluated: number; archived: number; selected: Strategy2Id | null; lifecycle: LifecycleResult | null };
type ExecutionGovernor = {
  state: "NORMAL" | "CAUTION" | "DEFENSIVE" | "PAUSED";
  reason: string;
  lossStreak: number;
  stats: StrategyStatistics;
};

let governorCache: { savedAt: number; value: ExecutionGovernor } | null = null;
let governorPending: Promise<ExecutionGovernor> | null = null;

function currentLossStreak(rows: { netMovePct: number | null }[]) {
  let streak = 0;
  for (const row of rows) {
    if ((row.netMovePct ?? 0) < 0) streak += 1;
    else break;
  }
  return streak;
}

async function loadExecutionGovernor(): Promise<ExecutionGovernor> {
  const rows = await getDb().select({
    netMovePct: tradeCases.netMovePct,
    exitAt: tradeCases.exitAt,
    regime: tradeCases.regime,
  }).from(tradeCases).where(and(
    eq(tradeCases.status, "closed"),
    eq(tradeCases.simulationModel, "contract_v2"),
    like(tradeCases.regime, `${HUMAN_REGIME_PREFIX}%`),
  )).orderBy(desc(tradeCases.exitAt)).limit(2500);
  const stats = calculateStrategyStatistics(rows);
  const lossStreak = currentLossStreak(rows);
  const recentWeak = stats.recentSampleCount >= 8
    && (stats.recentAverageNetPct ?? 0) < 0
    && (stats.recentProfitFactor ?? 0) < 1;
  const stronglyWeak = stats.recentSampleCount >= 12
    && (stats.recentAverageNetPct ?? 0) < -0.08
    && (stats.recentProfitFactor ?? 0) < 0.8;
  const structurallyBroken = stats.sampleCount >= 20
    && (stats.averageNetPct ?? 0) < -0.12
    && (stats.profitFactor ?? 0) < 0.7;

  const state: ExecutionGovernor["state"] = lossStreak >= 7 || structurallyBroken
    ? "PAUSED"
    : lossStreak >= 5 || stronglyWeak
      ? "DEFENSIVE"
      : lossStreak >= 3 || recentWeak
        ? "CAUTION"
        : "NORMAL";
  const reason = state === "PAUSED"
    ? `Human Risk Governor 暂停新开仓：连续亏损 ${lossStreak} 笔，n=${stats.sampleCount}，PF ${stats.profitFactor?.toFixed(2) ?? "--"}。保留已有仓位管理，不为追回亏损提高频率。`
    : state === "DEFENSIVE"
      ? `Human Risk Governor 防守：连续亏损 ${lossStreak} 笔；只允许已验证且高置信的独立 Setup。`
      : state === "CAUTION"
        ? `Human Risk Governor 谨慎：连续亏损 ${lossStreak} 笔；探索单只接受 A+ Setup，不允许靠放宽门槛增加频率。`
        : `Human Risk Governor 正常：n=${stats.sampleCount}，连续亏损 ${lossStreak}，最近 PF ${stats.recentProfitFactor?.toFixed(2) ?? "--"}。`;
  return { state, reason, lossStreak, stats };
}

async function getExecutionGovernor() {
  const now = Date.now();
  if (governorCache && now - governorCache.savedAt < GOVERNOR_CACHE_MS) return governorCache.value;
  if (!governorPending) {
    governorPending = loadExecutionGovernor().then((value) => {
      governorCache = { savedAt: Date.now(), value };
      return value;
    }).finally(() => { governorPending = null; });
  }
  return governorPending;
}

function isReadyGrowthSignal(signal: Strategy2Signal, governor: ExecutionGovernor): signal is ReadyGrowthSignal {
  if (signal.state !== "ready" || signal.side === "WAIT" || !signal.entryPlan?.ready) return false;
  if (governor.state === "PAUSED") return false;
  if (governor.state === "CAUTION") {
    if (signal.strategyMeta.tradeMode === "exploration") return signal.confidence >= 82;
    return signal.confidence >= 74;
  }
  if (governor.state === "DEFENSIVE") {
    return signal.strategyMeta.tradeMode === "high_conviction"
      && (signal.strategyMeta.experienceSamples ?? 0) >= 12
      && (signal.strategyMeta.expectancyR ?? 0) >= 0.12
      && signal.confidence >= 84;
  }
  return true;
}

function chooseGrowthSignal(signals: Strategy2Signal[], governor: ExecutionGovernor) {
  return signals
    .filter((signal): signal is ReadyGrowthSignal => isReadyGrowthSignal(signal, governor))
    .sort((a, b) => b.confidence - a.confidence || Math.abs(b.score) - Math.abs(a.score))[0] ?? null;
}

function growthPacket(packet: GateAnalysisPacket, signal: ReadyGrowthSignal, governor: ExecutionGovernor): GateAnalysisPacket {
  const direction = signal.side === "LONG" ? 1 : -1;
  const posteriorLong = Math.min(0.98, Math.max(0.02, 0.5 + direction * Math.abs(signal.score) * 0.45));
  const evidence = signal.reasons.map((detail, index) => ({
    title: index === 0 ? `${signal.label} 核心触发` : `${signal.label} 证据 ${index + 1}`,
    detail,
    score: Number(Math.abs(signal.score).toFixed(2)),
  }));
  evidence.unshift({ title: "Human Risk Governor", detail: governor.reason, score: governor.state === "NORMAL" ? 1 : governor.state === "CAUTION" ? 0.72 : 0.45 });
  const counterEvidence = signal.blockers.length
    ? signal.blockers.map((detail) => ({ title: "硬性风险检查", detail }))
    : packet.decision.counterEvidence.slice(0, 3);
  const globalRegime = signal.strategyMeta.globalRegime ?? "unknown";
  const assetRegime = signal.strategyMeta.assetRegime ?? "transition";
  // Keep the S2 parser prefix for the existing hierarchical learner, but the
  // playbook identity is now HT1/HT2/HT3. Old P1-P12 samples are archived and
  // therefore cannot become priors for the new traders.
  const regimeKey = `S2|${signal.strategyMeta.playbookId}|global:${globalRegime}|asset:${assetRegime}`;
  return {
    ...packet,
    decision: {
      ...packet.decision,
      state: "confirmed",
      stateLabel: "Human Trader Engine 确认",
      side: signal.side,
      confidence: signal.confidence,
      directionalScore: signal.score,
      posteriorLong,
      regime: regimeKey,
      action: `${signal.label} 的独立 Setup 已完整触发`,
      thesis: `Sentinel Human Trader Engine 3.0 当前由「${signal.label}」单独拥有这笔交易。${signal.thesis}`,
      entryZone: signal.entryPlan.entryZone,
      trigger: `Human Trader · ${signal.label}：${signal.reasons.join("；")}`,
      invalidation: `${signal.label} Thesis 失效：触及结构止损 ${signal.entryPlan.stopLossPrice}`,
      invalidationPrice: signal.entryPlan.stopLossPrice,
      expiresMinutes: Math.min(packet.decision.expiresMinutes, 15),
      entryPlan: signal.entryPlan,
      evidence,
      counterEvidence,
      metrics: signal.metrics,
      diagnostics: {
        ...packet.decision.diagnostics,
        confirmationCount: signal.reasons.length,
        atrPct: signal.regime.atrPct ?? packet.decision.diagnostics.atrPct,
      },
    },
  };
}

/**
 * One-time/non-destructive isolation boundary. Old shadow records and all old
 * contract_v2 trades that are not owned by an HT1/HT2/HT3 regime are archived.
 * This keeps the rows for audit, but removes them from account PnL, live
 * performance gating and the new learner. Existing Gate live orders are stored
 * separately and remain protected by the live order lifecycle.
 */
export async function retireLegacyShadowTrades() {
  const db = getDb();
  const now = Date.now();
  const shadow = await db.update(tradeCases).set({
    activeKey: null,
    status: "archived",
    archivedAt: now,
    learningApplied: true,
  }).where(and(
    inArray(tradeCases.status, ["holding", "closed"]),
    like(tradeCases.simulationModel, `${LEGACY_SHADOW_PREFIX}%`),
  )).returning({ id: tradeCases.id });

  const oldContract = await db.update(tradeCases).set({
    activeKey: null,
    status: "archived",
    archivedAt: now,
    learningApplied: true,
  }).where(and(
    inArray(tradeCases.status, ["holding", "closed"]),
    eq(tradeCases.simulationModel, "contract_v2"),
    notLike(tradeCases.regime, `${HUMAN_REGIME_PREFIX}%`),
  )).returning({ id: tradeCases.id });

  if (shadow.length || oldContract.length) governorCache = null;
  return shadow.length + oldContract.length;
}

export async function listOpenShadowTradeSymbols() {
  return [] as string[];
}

export async function processShadowStrategies(packet: GateAnalysisPacket, _candles5m: Candle[], signals: Strategy2Signal[], settings: AppSettings): Promise<GrowthModuleResult> {
  const db = getDb();
  const [existing] = await db.select({ id: tradeCases.id }).from(tradeCases).where(and(
    eq(tradeCases.symbol, packet.symbol),
    eq(tradeCases.status, "holding"),
    eq(tradeCases.simulationModel, "contract_v2"),
    like(tradeCases.regime, `${HUMAN_REGIME_PREFIX}%`),
  )).limit(1);
  if (existing) return { opened: 0, closed: 0, evaluated: signals.length, archived: 0, selected: null, lifecycle: null };

  const governor = await getExecutionGovernor();
  const selected = chooseGrowthSignal(signals, governor);
  if (!selected) return { opened: 0, closed: 0, evaluated: signals.length, archived: 0, selected: null, lifecycle: null };
  const lifecycle = await processDecision(growthPacket(packet, selected, governor), settings);
  if (lifecycle.kind === "opened") governorCache = null;
  return {
    opened: lifecycle.kind === "opened" ? 1 : 0,
    closed: lifecycle.kind === "closed" ? 1 : 0,
    evaluated: signals.length,
    archived: 0,
    selected: lifecycle.kind === "opened" ? selected.strategyId : null,
    lifecycle,
  };
}

export async function getStrategyLabDashboard() {
  const rows = await getDb().select({
    status: tradeCases.status,
    netMovePct: tradeCases.netMovePct,
    exitAt: tradeCases.exitAt,
    entryAt: tradeCases.entryAt,
    regime: tradeCases.regime,
  }).from(tradeCases).where(and(
    eq(tradeCases.simulationModel, "contract_v2"),
    like(tradeCases.regime, `${HUMAN_REGIME_PREFIX}%`),
  )).orderBy(desc(tradeCases.entryAt)).limit(2500);
  const closed = rows.filter((row) => row.status === "closed");
  const stats = calculateStrategyStatistics(closed.map((row) => ({ netMovePct: row.netMovePct, exitAt: row.exitAt, regime: row.regime })));
  const governor = await getExecutionGovernor();
  return {
    observedAt: Date.now(),
    note: "Human Trader Engine 3.0：Dennis 趋势突破、Raschke 趋势回踩、Turtle Soup 假突破三位交易员独立工作；不投票、不叠加分数。旧 Strategy 2.0 仅作为历史 benchmark，不再拥有新开仓权。",
    executionGovernor: { state: governor.state, reason: governor.reason, lossStreak: governor.lossStreak },
    baseline: {
      id: "human_trader_v3" as const,
      label: "Sentinel Human Trader Engine 3.0",
      mode: "baseline" as const,
      openCount: rows.filter((row) => row.status === "holding").length,
      stats,
    },
    strategies: HUMAN_TRADERS.map((strategy) => ({
      id: strategy.id,
      label: strategy.label,
      mode: "active" as const,
      openCount: rows.filter((row) => row.status === "holding" && row.regime?.includes(strategy.id === "trend_breakout" ? "HT1_" : strategy.id === "trend_pullback" ? "HT2_" : "HT3_")).length,
      stats: calculateStrategyStatistics(closed.filter((row) => row.regime?.includes(strategy.id === "trend_breakout" ? "HT1_" : strategy.id === "trend_pullback" ? "HT2_" : "HT3_"))),
      promotion: {
        status: "watch" as const,
        label: "独立交易员",
        eligible: true,
        requiredSamples: 0,
        requiredActiveDays: 0,
        reasons: ["每位交易员只按自己的 Setup 工作；学习只改变该交易员在对应环境的风险与优先级"],
      },
    })),
  };
}
