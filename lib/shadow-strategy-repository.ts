import { and, desc, eq, like } from "drizzle-orm";
import { getDb } from "../db";
import { tradeCases } from "../db/schema";
import type { GateAnalysisPacket } from "./gate-client.ts";
import { processDecision, type AppSettings, type LifecycleResult } from "./repository.ts";
import type { SentinelOpportunity, SentinelV2Evaluation, V2DecisionState } from "./sentinel-v2-engine.ts";
import { calculateStrategyStatistics } from "./strategy-promotion.ts";

const LEGACY_SHADOW_PREFIX = "shadow_v3:";

const STRATEGIES = [
  { id: "trend_pullback", label: "P1 趋势回踩" },
  { id: "compression_breakout", label: "P4 压缩突破" },
  { id: "transition_defensive", label: "P8 环境切换防御" },
] as const;

type ReadyV2Opportunity = SentinelOpportunity & {
  state: "TRADE";
  side: "LONG" | "SHORT";
  entryPlan: NonNullable<SentinelOpportunity["entryPlan"]>;
};

export type GrowthModuleResult = {
  opened: number;
  closed: number;
  evaluated: number;
  archived: number;
  selected: string | null;
  lifecycle: LifecycleResult | null;
};

function isReadyV2Opportunity(opportunity: SentinelOpportunity): opportunity is ReadyV2Opportunity {
  return opportunity.state === "TRADE"
    && opportunity.side !== "WAIT"
    && Boolean(opportunity.entryPlan?.ready)
    && opportunity.playbookId !== "transition_defensive";
}

function chooseV2Opportunity(evaluation: SentinelV2Evaluation) {
  return evaluation.opportunities
    .filter(isReadyV2Opportunity)
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence)[0] ?? null;
}

function stateToLegacy(state: V2DecisionState): "confirmed" | "pre_alert" | "blocked" {
  return state === "TRADE" ? "confirmed" : state === "WATCH" ? "pre_alert" : "blocked";
}

export function decoratePacketWithSentinelV2(packet: GateAnalysisPacket, evaluation: SentinelV2Evaluation): GateAnalysisPacket {
  const primary = evaluation.primaryOpportunity;
  const context = evaluation.context;
  const state = primary?.state ?? (context.permission === "RED" ? "REJECT" : "WATCH");
  const legacyState = stateToLegacy(state);
  const side = primary?.side ?? "WAIT";
  const entryPlan = primary?.entryPlan ?? null;
  const evidence = primary?.reasons.slice(0, 5).map((detail, index) => ({
    title: index === 0 ? `${primary.playbookLabel} · 主要证据` : `V2 证据 ${index + 1}`,
    detail,
    score: primary.score,
  })) ?? context.reasons.slice(0, 5).map((detail) => ({ title: "市场环境", detail, score: context.confidence }));
  const counterEvidence = [
    ...(primary?.waitingFor ?? []).map((detail) => ({ title: "等待确认", detail })),
    ...(primary?.rejectReasons ?? []).map((detail) => ({ title: "V2 硬拦截", detail })),
    ...context.warnings.slice(0, 4).map((warning) => ({ title: warning.label, detail: warning.detail })),
  ].slice(0, 6);

  return {
    ...packet,
    decision: {
      ...packet.decision,
      state: legacyState,
      stateLabel: state === "TRADE" ? "V2 推荐机会" : state === "WATCH" ? "V2 观察机会" : "V2 已拒绝",
      side: side === "WAIT" ? "WAIT" : side,
      confidence: primary?.confidence ?? context.confidence,
      directionalScore: side === "LONG" ? (primary?.score ?? context.confidence) / 100 : side === "SHORT" ? -(primary?.score ?? context.confidence) / 100 : 0,
      posteriorLong: side === "LONG" ? 0.5 + (primary?.score ?? 0) / 220 : side === "SHORT" ? 0.5 - (primary?.score ?? 0) / 220 : 0.5,
      regime: `Sentinel V2 · ${context.regimeLabel} · ${context.permission} · Transition ${context.transitionRisk}`,
      action: state === "TRADE"
        ? `${primary?.playbookLabel ?? "V2"} 条件完成，进入统一风控与执行生命周期`
        : state === "WATCH"
          ? `继续观察：${primary?.waitingFor.slice(0, 3).join("、") || "等待环境与确认改善"}`
          : `禁止进场：${primary?.rejectReasons.slice(0, 3).join("、") || `当前 ${context.permission} 风险许可不允许新增风险`}`,
      thesis: primary
        ? `当前 ${context.regimeLabel}，稳定度 ${context.stability}，环境切换风险 ${context.transitionRisk}。${primary.thesis}`
        : `当前 ${context.regimeLabel}，Transition ${context.transitionRisk}，暂未形成可执行 V2 Playbook。`,
      entryZone: entryPlan?.entryZone ?? null,
      trigger: primary
        ? `${primary.playbookLabel}｜环境 ${primary.environmentFit}｜结构 ${primary.structureScore}｜时机 ${primary.timingScore}｜确认 ${primary.confirmationScore}`
        : `环境 ${context.regimeLabel}，等待 V2 Playbook 形成`,
      invalidationPrice: entryPlan?.stopLossPrice ?? null,
      invalidation: entryPlan ? `V2 结构失效：触及 ${entryPlan.stopLossPrice}；持仓后继续读取 Regime / Transition 变化。` : "当前没有通过 V2 的有效结构止损，因此不能建立新仓位。",
      expiresMinutes: Math.min(packet.decision.expiresMinutes, 15),
      entryPlan,
      evidence,
      counterEvidence,
      metrics: primary?.metrics ?? packet.decision.metrics,
      diagnostics: {
        ...packet.decision.diagnostics,
        confirmationCount: primary?.reasons.length ?? 0,
        contradictionCount: (primary?.waitingFor.length ?? 0) + (primary?.rejectReasons.length ?? 0),
      },
    },
  };
}

function growthPacket(packet: GateAnalysisPacket, selected: ReadyV2Opportunity, evaluation: SentinelV2Evaluation): GateAnalysisPacket {
  const decorated = decoratePacketWithSentinelV2(packet, evaluation);
  const direction = selected.side === "LONG" ? 1 : -1;
  return {
    ...decorated,
    decision: {
      ...decorated.decision,
      state: "confirmed",
      stateLabel: "Sentinel V2 确认",
      side: selected.side,
      confidence: selected.confidence,
      directionalScore: direction * selected.score / 100,
      posteriorLong: Math.min(0.97, Math.max(0.03, 0.5 + direction * selected.score / 220)),
      regime: `Sentinel V2 · ${evaluation.context.regimeLabel} · ${selected.playbookLabel} · ${evaluation.context.permission}`,
      action: `${selected.playbookLabel} 触发，按 V2 风险许可进入统一订单生命周期`,
      thesis: `Sentinel Growth V2 当前由「${selected.playbookLabel}」主导。${selected.thesis} Transition ${evaluation.context.transitionRisk}/100。`,
      entryZone: selected.entryPlan.entryZone,
      trigger: `${selected.playbookLabel}：${selected.reasons.join("；")}`,
      invalidation: `${selected.playbookLabel}结构失效：触及结构止损 ${selected.entryPlan.stopLossPrice}`,
      invalidationPrice: selected.entryPlan.stopLossPrice,
      entryPlan: selected.entryPlan,
      evidence: selected.reasons.map((detail, index) => ({
        title: index === 0 ? `${selected.playbookLabel}触发` : `${selected.playbookLabel}证据 ${index + 1}`,
        detail,
        score: selected.score,
      })),
      counterEvidence: evaluation.context.warnings.slice(0, 4).map((warning) => ({ title: warning.label, detail: warning.detail })),
      metrics: selected.metrics,
    },
  };
}

export async function retireLegacyShadowTrades() {
  const archived = await getDb().update(tradeCases).set({
    activeKey: null,
    status: "archived",
    archivedAt: Date.now(),
    learningApplied: true,
  }).where(and(
    eq(tradeCases.status, "holding"),
    like(tradeCases.simulationModel, `${LEGACY_SHADOW_PREFIX}%`),
  )).returning({ id: tradeCases.id });
  return archived.length;
}

export async function listOpenShadowTradeSymbols() {
  return [] as string[];
}

export async function processShadowStrategies(
  packet: GateAnalysisPacket,
  evaluation: SentinelV2Evaluation,
  settings: AppSettings,
): Promise<GrowthModuleResult> {
  const db = getDb();
  const [existing] = await db.select({ id: tradeCases.id }).from(tradeCases).where(and(
    eq(tradeCases.symbol, packet.symbol),
    eq(tradeCases.status, "holding"),
    eq(tradeCases.simulationModel, "contract_v2"),
  )).limit(1);

  if (existing) {
    return { opened: 0, closed: 0, evaluated: evaluation.opportunities.length, archived: 0, selected: null, lifecycle: null };
  }

  const selected = chooseV2Opportunity(evaluation);
  if (!selected) {
    return { opened: 0, closed: 0, evaluated: evaluation.opportunities.length, archived: 0, selected: null, lifecycle: null };
  }

  const lifecycle = await processDecision(growthPacket(packet, selected, evaluation), settings);
  return {
    opened: lifecycle.kind === "opened" ? 1 : 0,
    closed: lifecycle.kind === "closed" ? 1 : 0,
    evaluated: evaluation.opportunities.length,
    archived: 0,
    selected: lifecycle.kind === "opened" ? selected.playbookId : null,
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
  }).from(tradeCases).where(eq(tradeCases.simulationModel, "contract_v2"))
    .orderBy(desc(tradeCases.entryAt))
    .limit(2500);
  const v2Rows = rows.filter((row) => row.regime?.startsWith("Sentinel V2"));
  const closed = v2Rows.filter((row) => row.status === "closed");
  const stats = calculateStrategyStatistics(closed.map((row) => ({
    netMovePct: row.netMovePct,
    exitAt: row.exitAt,
    regime: row.regime,
  })));
  return {
    observedAt: Date.now(),
    note: "Sentinel Growth V2：环境优先、Transition 风险优先；旧 V1 仅保留为行情数据解析，不再拥有新开仓权。",
    baseline: {
      id: "sentinel_growth_v2" as const,
      label: "Sentinel Growth V2",
      mode: "baseline" as const,
      openCount: v2Rows.filter((row) => row.status === "holding").length,
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
        label: strategy.id === "transition_defensive" ? "风险防御常驻" : "V2 Core 已启用",
        eligible: true,
        requiredSamples: 0,
        requiredActiveDays: 0,
        reasons: [strategy.id === "transition_defensive" ? "Transition 升级时自动限制新增风险" : "只有 V2 TRADE 且所有硬检查通过才会进入统一订单生命周期"],
      },
    })),
  };
}
