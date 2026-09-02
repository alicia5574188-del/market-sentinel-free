import { hte31TraderDefinition, hte31TraderIdForSignal, type Hte31TraderId } from "./hte31-strategy-catalog.ts";
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
};

export type Hte31RouterCandidate = {
  traderId: Hte31TraderId;
  strategyId: Hte31Signal["strategyId"];
  code: string;
  label: string;
  side: Hte31TradeSide;
  lane: "control" | "research";
  storyFamily: string;
  currentScore: number;
  evidenceScore: number;
  combinedScore: number;
  evidence: Hte31RouterEvidence;
};

export type Hte31RouterDecision = {
  authority: "research_only";
  mode: "WAIT" | "SINGLE" | "COOPERATE" | "CONFLICT" | "SWITCH_WATCH";
  observedAt: number;
  symbol: string;
  primary: Hte31RouterCandidate | null;
  supporting: Hte31RouterCandidate[];
  opposing: Hte31RouterCandidate[];
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
  const expectancy = Math.max(-1, Math.min(1, evidence.expectancyR)) * 10;
  const profitFactor = evidence.profitFactor == null ? 0 : Math.max(-6, Math.min(8, (evidence.profitFactor - 1) * 8));
  const drawdown = Math.max(0, evidence.maximumDrawdownR - 3) * -0.75;
  return expectancy + profitFactor + drawdown;
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
    label: `${definition.code} ${definition.name}`,
    side: signal.side,
    lane: definition.lane,
    storyFamily: definition.storyFamily,
    currentScore: Number(currentScore.toFixed(2)),
    evidenceScore: Number(learned.toFixed(2)),
    combinedScore: Number((currentScore + learned).toFixed(2)),
    evidence,
  };
}

function promotionRule() {
  const policy = HTE31_ROUTER_PROMOTION_POLICY;
  return `至少 ${policy.minimumSamples} 个独立前向样本、PF ≥ ${policy.minimumProfitFactor.toFixed(2)}、Expectancy ≥ +${policy.minimumExpectancyR.toFixed(2)}R、最大回撤 ≤ ${policy.maximumDrawdownR.toFixed(0)}R；达标也只进入人工审计，不自动获得 Gate 权限。`;
}

export function buildHte31StrategyRouterDecision(input: {
  observedAt: number;
  symbol: string;
  signals: Hte31Signal[];
  evidence: Hte31RouterEvidence[];
  activePosition?: { traderId: string; side: Hte31TradeSide } | null;
}): Hte31RouterDecision {
  const evidenceByTrader = new Map(input.evidence.map((item) => [item.traderId, item]));
  const candidates = input.signals
    .map((signal) => candidate(signal, evidenceByTrader))
    .filter((item): item is Hte31RouterCandidate => item != null)
    .sort((a, b) => b.combinedScore - a.combinedScore || b.currentScore - a.currentScore || a.code.localeCompare(b.code));
  const activePosition = input.activePosition ?? null;
  const base = {
    authority: "research_only" as const,
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
      supporting: [],
      opposing: [],
      currentThesisState: activePosition ? "uncertain" : "none",
      replacementEligible: false,
      reason: activePosition
        ? "当前没有新的完整 Setup。持仓仍由原始止损、目标和失效规则管理，不能因为没有新信号就机械反手。"
        : "当前没有完整 Setup；大脑保持空白而不是强迫选策略。",
      executionRule: "不创建研究外的额外仓位。",
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
        supporting: candidates.filter((item) => item.side === replacement.side && item.traderId !== replacement.traderId),
        opposing: candidates.filter((item) => item.side !== replacement.side),
        currentThesisState: "invalidated",
        replacementEligible: replacement.evidence.qualified,
        reason: `${activePosition.traderId} 的当前方向前提已被新结构否定；${replacement.label} 独立形成 ${replacement.side} Setup。旧仓应先按自身失效规则退出，不能把“退出”和“反手”合并成一个动作。`,
        executionRule: replacement.evidence.qualified
          ? "影子路由允许记录换挡候选；正式换挡仍需人工审计后单独授权。"
          : "只记录换挡反事实；替代策略样本尚未达标，禁止自动反手。",
      };
    }
  }

  if (opposing.length) {
    return {
      ...base,
      mode: "CONFLICT",
      primary,
      supporting,
      opposing,
      currentThesisState: activePosition ? "uncertain" : "none",
      replacementEligible: false,
      reason: `${primary.label} 看 ${primary.side}，同时 ${opposing.map((item) => item.label).join("、")} 看相反方向；这代表不同市场故事并存，不是把分数相加后强行下单。`,
      executionRule: "研究账本可同时记录正反假设；控制账户不对冲、不叠加风险，等待其中一个故事独立失效。",
    };
  }

  if (supporting.length) {
    return {
      ...base,
      mode: "COOPERATE",
      primary,
      supporting,
      opposing: [],
      currentThesisState: activePosition ? "intact" : "none",
      replacementEligible: primary.evidence.qualified,
      reason: `${primary.label} 与 ${supporting.map((item) => item.label).join("、")} 独立得到同方向结论；它们可以共同归因，但不能因此重复放大名义仓位。`,
      executionRule: "研究层分别记账；未来控制层最多合并成一笔仓位并保留多策略归因。",
    };
  }

  return {
    ...base,
    mode: "SINGLE",
    primary,
    supporting: [],
    opposing: [],
    currentThesisState: activePosition ? "intact" : "none",
    replacementEligible: primary.evidence.qualified,
    reason: `${primary.label} 是本轮唯一完整的 ${primary.side} 市场故事；排名来自当前结构质量，历史表现只有达到最低样本后才参与微调。`,
    executionRule: primary.lane === "research"
      ? "只建立独立研究样本，不占控制账户仓位。"
      : "保持现有控制执行规则；影子路由没有开仓、加仓或实盘权限。",
  };
}
