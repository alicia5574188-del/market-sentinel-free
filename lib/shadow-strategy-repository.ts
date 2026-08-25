import { and, desc, eq, like } from "drizzle-orm";
import { getDb } from "../db";
import { tradeCases } from "../db/schema";
import type { GateAnalysisPacket } from "./gate-client.ts";
import { processDecision, type AppSettings } from "./repository.ts";
import type { Candle } from "./signal-engine.ts";
import type { ShadowStrategyId, ShadowStrategySignal } from "./shadow-strategy-engine.ts";
import { calculateStrategyStatistics } from "./strategy-promotion.ts";

const LEGACY_SHADOW_PREFIX = "shadow_v3:";

const STRATEGIES: { id: ShadowStrategyId; label: string }[] = [
  { id: "trend_pullback", label: "趋势回踩" },
  { id: "volatility_breakout", label: "波动收缩突破" },
  { id: "range_reversion", label: "震荡均值回归" },
  { id: "relative_strength", label: "相对强弱" },
];

type ReadyGrowthSignal = ShadowStrategySignal & {
  side: "LONG" | "SHORT";
  entryPlan: NonNullable<ShadowStrategySignal["entryPlan"]>;
};

function isReadyGrowthSignal(signal: ShadowStrategySignal): signal is ReadyGrowthSignal {
  return signal.state === "ready" && signal.side !== "WAIT" && Boolean(signal.entryPlan?.ready);
}

function chooseGrowthSignal(signals: ShadowStrategySignal[]) {
  return signals
    .filter(isReadyGrowthSignal)
    .sort((a, b) => b.confidence - a.confidence || Math.abs(b.score) - Math.abs(a.score))[0] ?? null;
}

function growthPacket(packet: GateAnalysisPacket, signal: ReadyGrowthSignal): GateAnalysisPacket {
  const direction = signal.side === "LONG" ? 1 : -1;
  const posteriorLong = Math.min(0.98, Math.max(0.02, 0.5 + direction * Math.abs(signal.score) * 0.45));
  const evidence = signal.reasons.map((detail, index) => ({
    title: index === 0 ? `${signal.label}触发` : `${signal.label}证据 ${index + 1}`,
    detail,
    score: Number(Math.abs(signal.score).toFixed(2)),
  }));
  const counterEvidence = signal.blockers.length
    ? signal.blockers.map((detail) => ({ title: "风险检查", detail }))
    : packet.decision.counterEvidence.slice(0, 3);

  return {
    ...packet,
    decision: {
      ...packet.decision,
      state: "confirmed",
      stateLabel: "成长策略确认",
      side: signal.side,
      confidence: signal.confidence,
      directionalScore: signal.score,
      posteriorLong,
      regime: `成长策略 · ${signal.label} · ${signal.regime.kind}`,
      action: `${signal.label}触发，按统一风控执行`,
      thesis: `哨兵成长策略当前由「${signal.label}」模块主导。${signal.thesis}`,
      entryZone: signal.entryPlan.entryZone,
      trigger: `成长策略 · ${signal.label}：${signal.reasons.join("；")}`,
      invalidation: `${signal.label}结构失效：触及结构止损 ${signal.entryPlan.stopLossPrice}`,
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

async function archiveLegacyShadowTrades(symbol: string) {
  const db = getDb();
  const archived = await db.update(tradeCases).set({
    activeKey: null,
    status: "archived",
    archivedAt: Date.now(),
    learningApplied: true,
  }).where(and(
    eq(tradeCases.symbol, symbol),
    eq(tradeCases.status, "holding"),
    like(tradeCases.simulationModel, `${LEGACY_SHADOW_PREFIX}%`),
  )).returning({ id: tradeCases.id });
  return archived.length;
}

export async function listOpenShadowTradeSymbols() {
  // V3 modules are no longer separate shadow accounts. New signals join the
  // normal contract_v2 lifecycle, so there are no shadow positions to favor
  // in background scheduling. Legacy shadow rows are retired on the next scan.
  return [] as string[];
}

export async function processShadowStrategies(
  packet: GateAnalysisPacket,
  _candles5m: Candle[],
  signals: ShadowStrategySignal[],
  settings: AppSettings,
) {
  const archived = await archiveLegacyShadowTrades(packet.symbol);
  const db = getDb();
  const [existing] = await db.select({ id: tradeCases.id }).from(tradeCases).where(and(
    eq(tradeCases.symbol, packet.symbol),
    eq(tradeCases.status, "holding"),
    eq(tradeCases.simulationModel, "contract_v2"),
  )).limit(1);

  if (existing) {
    return { opened: 0, closed: 0, evaluated: signals.length, archived };
  }

  const selected = chooseGrowthSignal(signals);
  if (!selected) {
    return { opened: 0, closed: 0, evaluated: signals.length, archived };
  }

  // The original comprehensive decision remains the first pass. When it has
  // not opened a position, a ready growth module may become the same unified
  // contract_v2 order. From here on it uses the exact same lifecycle, account,
  // learning, live-entry, risk and Gate execution path as every other Sentinel
  // order. There is no promotion/approval layer beyond the owner's live switch.
  const result = await processDecision(growthPacket(packet, selected), settings);
  return {
    opened: result.kind === "opened" ? 1 : 0,
    closed: result.kind === "closed" ? 1 : 0,
    evaluated: signals.length,
    archived,
    selected: result.kind === "opened" ? selected.strategyId : null,
  };
}

export async function getStrategyLabDashboard() {
  // Kept temporarily for backward-compatible API callers. The user-facing
  // product no longer exposes a separate strategy lab: all completed and open
  // orders are one Sentinel Growth history under contract_v2.
  const rows = await getDb().select({
    status: tradeCases.status,
    netMovePct: tradeCases.netMovePct,
    exitAt: tradeCases.exitAt,
    entryAt: tradeCases.entryAt,
    regime: tradeCases.regime,
  }).from(tradeCases).where(eq(tradeCases.simulationModel, "contract_v2"))
    .orderBy(desc(tradeCases.entryAt))
    .limit(2500);
  const closed = rows.filter((row) => row.status === "closed");
  const stats = calculateStrategyStatistics(closed.map((row) => ({
    netMovePct: row.netMovePct,
    exitAt: row.exitAt,
    regime: row.regime,
  })));
  return {
    observedAt: Date.now(),
    note: "所有判断模块已合并为 Sentinel Growth，一套订单、一套学习、一套实盘风控。",
    baseline: {
      id: "baseline_v1" as const,
      label: "Sentinel Growth",
      mode: "baseline" as const,
      openCount: rows.filter((row) => row.status === "holding").length,
      stats,
    },
    strategies: STRATEGIES.map((strategy) => ({
      id: strategy.id,
      label: strategy.label,
      mode: "shadow" as const,
      openCount: 0,
      stats: calculateStrategyStatistics([]),
      promotion: {
        status: "watch" as const,
        label: "已并入成长策略",
        eligible: true,
        requiredSamples: 0,
        requiredActiveDays: 0,
        reasons: ["不再单独晋级；满足完整入场条件即可进入统一订单生命周期"],
      },
    })),
  };
}
