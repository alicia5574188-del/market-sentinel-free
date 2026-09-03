import { hte31CanonicalStrategyLabel, hte31TraderDefinition, hte31TraderIdForSignal, type Hte31StrategyFamilyId, type Hte31TraderId } from "./hte31-strategy-catalog.ts";
import type { Hte31Signal, Hte31TradeSide } from "./hte31-types.ts";

export const HTE31_ROUTER_PROMOTION_POLICY = {
  minimumSamples: 30,
  minimumProfitFactor: 1.30,
  minimumExpectancyR: 0.15,
  maximumDrawdownR: 6,
} as const;

export type Hte31RouterEvidence = {
  traderId: Hte31TraderId;
  sampleCount: number;
  expectancyR: number;
  profitFactor: number | null;
  maximumDrawdownR: number;
  qualified: boolean;
  recentSampleCount?: number;
  recentExpectancyR?: number;
  baselineSampleCount?: number;
  baselineExpectancyR?: number;
  everProfitable?: boolean;
};

export type Hte31RouterCandidate = {
  traderId: Hte31TraderId;
  strategyId: Hte31Signal["strategyId"];
  code: string;
  label: string;
  side: Hte31TradeSide;
  lane: "paper";
  storyFamily: string;
  familyId: Hte31StrategyFamilyId;
  variantId: string;
  tags: readonly string[];
  currentScore: number;
  evidenceScore: number;
  combinedScore: number;
  evidence: Hte31RouterEvidence;
};

export type Hte31RouterDecision = {
  authority: "paper_brain_live_parity";
  mode: "WAIT" | "SINGLE" | "COOPERATE" | "CONFLICT" | "SWITCH_WATCH";
  observedAt: number;
  symbol: string;
  primary: Hte31RouterCandidate | null;
  selectedForExecution: Hte31RouterCandidate | null;
  supporting: Hte31RouterCandidate[];
  opposing: Hte31RouterCandidate[];
  familyAlternatives: Hte31RouterCandidate[];
  activePosition: { traderId: string; side: Hte31TradeSide } | null;
  currentThesisState: "none" | "intact" | "uncertain" | "invalidated";
  replacementEligible: boolean;
  reason: string;
  executionRule: string;
  promotionRule: string;
};

function emptyEvidence(traderId: Hte31TraderId): Hte31RouterEvidence {
  return { traderId, sampleCount: 0, expectancyR: 0, profitFactor: null, maximumDrawdownR: 0, qualified: false };
}

function evidenceAdjustment(evidence: Hte31RouterEvidence) {
  if (evidence.sampleCount < 8) return 0;
  const recentReady = (evidence.recentSampleCount ?? 0) >= 4;
  const effectiveExpectancy = recentReady ? evidence.recentExpectancyR ?? evidence.expectancyR : evidence.expectancyR;
  const expectancy = Math.max(-1, Math.min(1, effectiveExpectancy)) * 10;
  const profitFactor = evidence.profitFactor == null ? 0 : Math.max(-6, Math.min(8, (evidence.profitFactor - 1) * 8));
  const drawdown = Math.max(0, evidence.maximumDrawdownR - 3) * -0.75;
  const degraded = recentReady
    && (evidence.baselineSampleCount ?? 0) >= 8
    && (evidence.baselineExpectancyR ?? 0) >= 0.15
    && effectiveExpectancy <= -0.15;
  return expectancy + profitFactor + drawdown + (degraded ? -6 : 0);
}

function candidate(signal: Hte31Signal, evidenceByTrader: ReadonlyMap<Hte31TraderId, Hte31RouterEvidence>): Hte31RouterCandidate | null {
  if (signal.state !== "ready" || !signal.entryPlan?.ready || signal.side === "WAIT") return null;
  const traderId = hte31TraderIdForSignal(signal);
  const definition = hte31TraderDefinition(traderId);
  const evidence = evidenceByTrader.get(traderId) ?? emptyEvidence(traderId);
  const currentScore = signal.confidence * 0.38 + signal.strategyMeta.setupScore * 0.34 + signal.strategyMeta.evidenceScore * 0.28;
  const learned = evidenceAdjustment(evidence);
  return {
    traderId,
    strategyId: signal.strategyId,
    code: definition.code,
    label: hte31CanonicalStrategyLabel(traderId, signal.strategyMeta.assetRegime),
    side: signal.side,
    lane: definition.lane,
    storyFamily: definition.storyFamily,
    familyId: definition.familyId,
    variantId: definition.variantId,
    tags: definition.tags,
    currentScore: Number(currentScore.toFixed(2)),
    evidenceScore: Number(learned.toFixed(2)),
    combinedScore: Number((currentScore + learned).toFixed(2)),
    evidence,
  };
}

function promotionRule() {
  const policy = HTE31_ROUTER_PROMOTION_POLICY;
  return `全部策略都可进入模拟交易；少于 8 笔时历史表现不参与排序。达到 ${policy.minimumSamples} 笔且 PF ≥ ${policy.minimumProfitFactor.toFixed(2)}、Expectancy ≥ +${policy.minimumExpectancyR.toFixed(2)}R、最大回撤 ≤ ${policy.maximumDrawdownR.toFixed(0)}R 后标记为成熟策略。实盘始终复用同一大脑选择和学习结果。`;
}

export function buildHte31StrategyRouterDecision(input: {
  observedAt: number;
  symbol: string;
  signals: Hte31Signal[];
  evidence: Hte31RouterEvidence[];
  activePosition?: { traderId: string; side: Hte31TradeSide } | null;
}): Hte31RouterDecision {
  const evidenceByTrader = new Map(input.evidence.map((item) => [item.traderId, item]));
  const rawCandidates = input.signals
    .map((signal) => candidate(signal, evidenceByTrader))
    .filter((item): item is Hte31RouterCandidate => item != null)
    .sort((a, b) => b.combinedScore - a.combinedScore || b.currentScore - a.currentScore || a.code.localeCompare(b.code));
  const winnersByFamily = new Map<Hte31StrategyFamilyId, Hte31RouterCandidate>();
  const familyAlternatives: Hte31RouterCandidate[] = [];
  for (const item of rawCandidates) {
    if (winnersByFamily.has(item.familyId)) familyAlternatives.push(item);
    else winnersByFamily.set(item.familyId, item);
  }
  const candidates = [...winnersByFamily.values()];
  const activePosition = input.activePosition ?? null;
  const base = {
    authority: "paper_brain_live_parity" as const,
    observedAt: input.observedAt,
    symbol: input.symbol,
    activePosition,
    promotionRule: promotionRule(),
  };

  if (!candidates.length) {
    return {
      ...base,
      mode: "WAIT",
      primary: null,
      selectedForExecution: null,
      supporting: [],
      opposing: [],
      familyAlternatives,
      currentThesisState: activePosition ? "uncertain" : "none",
      replacementEligible: false,
      reason: activePosition
        ? "当前没有新的完整 Setup。持仓仍由原始止损、目标和失效规则管理，不能因为没有新信号就机械反手。"
        : "当前没有完整 Setup；大脑保持空白而不是强迫选策略。",
      executionRule: "没有完整 Setup，不强迫模拟开仓。",
    };
  }

  const primary = candidates[0];
  const supporting = candidates.filter((item) => item.side === primary.side && item.traderId !== primary.traderId);
  const opposing = candidates.filter((item) => item.side !== primary.side);

  if (activePosition) {
    const activeSignal = input.signals.find((signal) => hte31TraderIdForSignal(signal) === activePosition.traderId);
    const safetyBlocked = activeSignal?.state === "blocked";
    const directionFlipped = activeSignal?.side !== "WAIT" && activeSignal?.side !== activePosition.side;
    const invalidated = Boolean(safetyBlocked || directionFlipped);
    const replacement = candidates.find((item) => item.side !== activePosition.side);
    if (invalidated && replacement) {
      return {
        ...base,
        mode: "SWITCH_WATCH",
        primary: replacement,
        selectedForExecution: null,
        supporting: candidates.filter((item) => item.side === replacement.side && item.traderId !== replacement.traderId),
        opposing: candidates.filter((item) => item.side !== replacement.side),
        familyAlternatives,
        currentThesisState: "invalidated",
        replacementEligible: replacement.evidence.qualified,
        reason: `${activePosition.traderId} 的当前方向前提已被新结构否定；${replacement.label} 独立形成 ${replacement.side} Setup。旧仓应先按自身失效规则退出，不能把“退出”和“反手”合并成一个动作。`,
        executionRule: "旧仓先按自身失效规则退出；本轮不把退出与反手合并，下一轮再由大脑重新选择。",
      };
    }
  }

  if (opposing.length) {
    const leadingMargin = primary.combinedScore - opposing[0].combinedScore;
    const selectedForExecution = leadingMargin >= 8 ? primary : null;
    return {
      ...base,
      mode: "CONFLICT",
      primary,
      selectedForExecution,
      supporting,
      opposing,
      familyAlternatives,
      currentThesisState: activePosition ? "uncertain" : "none",
      replacementEligible: false,
      reason: `${primary.label} 看 ${primary.side}，同时 ${opposing.map((item) => item.label).join("、")} 看相反方向；领先差 ${leadingMargin.toFixed(1)} 分。`,
      executionRule: selectedForExecution
        ? `领先差达到 8 分，大脑选择 ${primary.label} 建立一笔模拟仓位；不对冲、不重复叠加。`
        : "多空分歧不足以形成明确优势，本轮不下单。",
    };
  }

  if (supporting.length) {
    return {
      ...base,
      mode: "COOPERATE",
      primary,
      selectedForExecution: primary,
      supporting,
      opposing: [],
      familyAlternatives,
      currentThesisState: activePosition ? "intact" : "none",
      replacementEligible: primary.evidence.qualified,
      reason: `${primary.label} 与 ${supporting.map((item) => item.label).join("、")} 独立得到同方向结论；它们可以共同归因，但不能因此重复放大名义仓位。`,
      executionRule: `大脑选择 ${primary.label} 建立一笔模拟仓位，并保留同向策略的协作归因。`,
    };
  }

  return {
    ...base,
    mode: "SINGLE",
    primary,
    selectedForExecution: primary,
    supporting: [],
    opposing: [],
    familyAlternatives,
    currentThesisState: activePosition ? "intact" : "none",
    replacementEligible: primary.evidence.qualified,
    reason: `${primary.label} 是本轮唯一完整的 ${primary.side} 市场故事；排名来自当前结构质量，历史表现只有达到最低样本后才参与微调。`,
    executionRule: `大脑选择 ${primary.label} 进入统一模拟交易池；未来实盘沿用同一策略血缘。`,
  };
}
