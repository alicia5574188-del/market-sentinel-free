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
const HUMAN_TRADERS: { id: Strategy2Id; label: string; tag: string }[] = [
  { id: "trend_breakout", label: HUMAN_TRADER_LABELS.dennis_trend, tag: "HT1_" },
  { id: "trend_pullback", label: HUMAN_TRADER_LABELS.raschke_pullback, tag: "HT2_" },
  { id: "failed_breakout", label: HUMAN_TRADER_LABELS.turtle_soup, tag: "HT3_" },
];
const GOVERNOR_CACHE_MS = 60_000;

type ReadyGrowthSignal = Strategy2Signal & { side: "LONG" | "SHORT"; entryPlan: NonNullable<Strategy2Signal["entryPlan"]> };
export type GrowthModuleResult = { opened: number; closed: number; evaluated: number; archived: number; selected: Strategy2Id | null; lifecycle: LifecycleResult | null };
export type TraderGuard = {
  state: "ACTIVE" | "COOLDOWN" | "PAUSED";
  lossStreak: number;
  cooldownUntil: number | null;
  reason: string;
};
type ExecutionGovernor = {
  state: "NORMAL" | "CAUTION" | "DEFENSIVE" | "PAUSED";
  reason: string;
  lossStreak: number;
  stats: StrategyStatistics;
  traderGuards: Record<Strategy2Id, TraderGuard>;
};

type ClosedRow = { netMovePct: number | null; exitAt: number | null; regime: string | null };

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

function buildTraderGuard(rows: ClosedRow[], trader: { label: string }): TraderGuard {
  const stats = calculateStrategyStatistics(rows);
  const lossStreak = currentLossStreak(rows);
  const latestExitAt = rows[0]?.exitAt ?? null;
  const structurallyWeak = stats.sampleCount >= 8
    && (stats.averageNetPct ?? 0) < -0.08
    && (stats.profitFactor ?? 0) < 0.65;
  if (structurallyWeak) {
    return {
      state: "PAUSED",
      lossStreak,
      cooldownUntil: null,
      reason: `${trader.label} 独立暂停：n=${stats.sampleCount}，PF ${stats.profitFactor?.toFixed(2) ?? "--"}，长期期望为负；不会拖累另外两位交易员。`,
    };
  }

  const cooldownMs = lossStreak >= 4
    ? 12 * 60 * 60_000
    : lossStreak >= 3
      ? 360 * 60_000
      : lossStreak >= 2
        ? 120 * 60_000
        : 0;
  const cooldownUntil = cooldownMs && latestExitAt ? latestExitAt + cooldownMs : null;
  if (cooldownUntil && cooldownUntil > Date.now()) {
    return {
      state: "COOLDOWN",
      lossStreak,
      cooldownUntil,
      reason: `${trader.label} 连续亏损 ${lossStreak} 笔，独立冷却至 ${new Date(cooldownUntil).toISOString()}；Dennis / Raschke / Turtle Soup 互不连坐。`,
    };
  }
  return {
    state: "ACTIVE",
    lossStreak,
    cooldownUntil: null,
    reason: lossStreak ? `${trader.label} 最近连续亏损 ${lossStreak} 笔，但独立冷却期已结束。` : `${trader.label} 可参与。`,
  };
}

function rowsForTrader(rows: ClosedRow[], strategyId: Strategy2Id) {
  const tag = HUMAN_TRADERS.find((item) => item.id === strategyId)?.tag ?? "";
  return rows.filter((row) => Boolean(tag) && row.regime?.includes(tag));
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
  )).orderBy(desc(tradeCases.exitAt)).limit(2500) as ClosedRow[];

  const stats = calculateStrategyStatistics(rows);
  const lossStreak = currentLossStreak(rows);
  const recentWeak = stats.recentSampleCount >= 10
    && (stats.recentAverageNetPct ?? 0) < 0
    && (stats.recentProfitFactor ?? 0) < 0.9;
  const stronglyWeak = stats.recentSampleCount >= 16
    && (stats.recentAverageNetPct ?? 0) < -0.08
    && (stats.recentProfitFactor ?? 0) < 0.75;
  const structurallyBroken = stats.sampleCount >= 30
    && (stats.averageNetPct ?? 0) < -0.12
    && (stats.profitFactor ?? 0) < 0.65;

  // Account-level protection must not let one over-active trader freeze the
  // whole engine after only a few losses. Per-trader circuit breakers below
  // react much earlier; the global governor is reserved for genuine account-wide damage.
  const state: ExecutionGovernor["state"] = lossStreak >= 8 || structurallyBroken
    ? "PAUSED"
    : lossStreak >= 6 || stronglyWeak
      ? "DEFENSIVE"
      : lossStreak >= 4 || recentWeak
        ? "CAUTION"
        : "NORMAL";

  const traderGuards = Object.fromEntries(HUMAN_TRADERS.map((trader) => [
    trader.id,
    buildTraderGuard(rowsForTrader(rows, trader.id), trader),
  ])) as Record<Strategy2Id, TraderGuard>;

  const cooling = HUMAN_TRADERS.filter((trader) => traderGuards[trader.id].state !== "ACTIVE").map((trader) => trader.label);
  const reason = state === "PAUSED"
    ? `Human Risk Governor 全局暂停新开仓：账户连续亏损 ${lossStreak} 笔，n=${stats.sampleCount}，PF ${stats.profitFactor?.toFixed(2) ?? "--"}。已有仓位继续保护。`
    : state === "DEFENSIVE"
      ? `Human Risk Governor 全局防守：账户连续亏损 ${lossStreak} 笔；只允许已验证且高确信 Setup。${cooling.length ? ` 独立冷却：${cooling.join("、")}。` : ""}`
      : state === "CAUTION"
        ? `Human Risk Governor 全局谨慎：账户连续亏损 ${lossStreak} 笔；不靠放宽门槛增加频率。${cooling.length ? ` 独立冷却：${cooling.join("、")}。` : ""}`
        : `Human Risk Governor 正常：n=${stats.sampleCount}，账户连续亏损 ${lossStreak}，最近 PF ${stats.recentProfitFactor?.toFixed(2) ?? "--"}。${cooling.length ? ` 独立冷却：${cooling.join("、")}。` : ""}`;
  return { state, reason, lossStreak, stats, traderGuards };
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

function traderGuardForSignal(signal: Strategy2Signal, governor: ExecutionGovernor) {
  return governor.traderGuards[signal.strategyId];
}

function isReadyGrowthSignal(signal: Strategy2Signal, governor: ExecutionGovernor): signal is ReadyGrowthSignal {
  if (signal.state !== "ready" || signal.side === "WAIT" || !signal.entryPlan?.ready) return false;
  const guard = traderGuardForSignal(signal, governor);
  if (guard && guard.state !== "ACTIVE") return false;
  if (governor.state === "PAUSED") return false;
  if (governor.state === "CAUTION") {
    if (signal.strategyMeta.tradeMode === "exploration") return signal.confidence >= 84;
    return signal.confidence >= 76;
  }
  if (governor.state === "DEFENSIVE") {
    return signal.strategyMeta.tradeMode === "high_conviction"
      && (signal.strategyMeta.experienceSamples ?? 0) >= 12
      && (signal.strategyMeta.expectancyR ?? 0) >= 0.12
      && signal.confidence >= 86;
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
  const guard = traderGuardForSignal(signal, governor);
  evidence.unshift({ title: "Human Risk Governor", detail: `${governor.reason}${guard ? ` ${guard.reason}` : ""}`, score: governor.state === "NORMAL" ? 1 : governor.state === "CAUTION" ? 0.72 : 0.45 });
  const counterEvidence = signal.blockers.length
    ? signal.blockers.map((detail) => ({ title: "硬性风险检查", detail }))
    : packet.decision.counterEvidence.slice(0, 3);
  const globalRegime = signal.strategyMeta.globalRegime ?? "unknown";
  const assetRegime = signal.strategyMeta.assetRegime ?? "transition";
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
 * Old strategy/simulation history remains isolated from Human Trader learning.
 * Existing Gate live orders are stored separately and remain protected by the
 * live order lifecycle.
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
    note: "Human Trader Engine 3.0：Dennis 趋势突破、Raschke 趋势回踩、Turtle Soup 假突破独立工作；同一交易员连亏只熔断自己，不再把其他交易员一起锁死。",
    executionGovernor: {
      state: governor.state,
      reason: governor.reason,
      lossStreak: governor.lossStreak,
      traderGuards: governor.traderGuards,
    },
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
      mode: governor.traderGuards[strategy.id].state === "ACTIVE" ? "active" as const : "guarded" as const,
      guard: governor.traderGuards[strategy.id],
      openCount: rows.filter((row) => row.status === "holding" && row.regime?.includes(strategy.tag)).length,
      stats: calculateStrategyStatistics(closed.filter((row) => row.regime?.includes(strategy.tag))),
      promotion: {
        status: "watch" as const,
        label: "独立交易员",
        eligible: governor.traderGuards[strategy.id].state === "ACTIVE",
        requiredSamples: 0,
        requiredActiveDays: 0,
        reasons: [governor.traderGuards[strategy.id].reason],
      },
    })),
  };
}
