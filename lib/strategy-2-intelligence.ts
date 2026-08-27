import type { V2MarketContext, V2RegimeKind } from "./sentinel-v2-core.ts";
import type { Strategy2LearningDashboard } from "./strategy-2-learning.ts";
import type { Strategy2Opportunity } from "./sentinel-v2-strategy.ts";

export type Strategy2RegimeMigrationStage = "stable" | "forming" | "developing" | "switch_watch";
export type Strategy2AdvisoryState = "NORMAL" | "REDUCE" | "BLOCK";

export type Strategy2DecisionIntelligence = {
  symbol: string;
  playbook: string;
  side: Strategy2Opportunity["side"];
  state: Strategy2Opportunity["state"];
  expertWeight: number;
  estimatedWinProbability: number;
  grossExpectedR: number | null;
  estimatedCostBufferR: number;
  netExpectedR: number | null;
  decisionConfidence: number;
  modelDisagreement: number;
  outOfDistributionRisk: number;
  advisoryState: Strategy2AdvisoryState;
  advisoryReasons: string[];
};

export type Strategy2ExpertIntelligence = {
  playbook: string;
  playbookLabel: string;
  weight: number;
  confidence: number;
  learningState: string;
  sampleCount: number;
  expectancyR: number | null;
  bestEnvironmentFit: number;
};

export type Strategy2Intelligence = {
  version: "strategy-2.1-intelligence";
  observedAt: number;
  regimeMigration: {
    currentRegime: V2RegimeKind;
    currentLabel: string;
    candidateRegime: V2RegimeKind | null;
    candidateLabel: string | null;
    transitionProbability: number;
    stage: Strategy2RegimeMigrationStage;
    confidence: number;
    stability: number;
    transitionRisk: number;
    transitionVelocity: number;
    explanation: string;
  } | null;
  decisions: Strategy2DecisionIntelligence[];
  experts: Strategy2ExpertIntelligence[];
  learningUpdate: {
    totalSamples: number;
    forwardSamples: number;
    positiveCells: number;
    negativeCells: number;
    degradingCells: number;
    playbookCoverage: number;
    headline: string;
    riskNote: string;
  } | null;
  counterfactual: {
    trackedDecisionCount: number;
    maturedDecisionCount: number;
    status: "collecting";
    note: string;
  };
  portfolio: {
    directionConcentration: number;
    regimeSideConcentration: number;
    dominantFactor: string | null;
    riskState: "NORMAL" | "CONCENTRATED" | "HIGH";
  };
  governance: {
    champion: "Sentinel Strategy 2.0";
    mode: "shadow_first";
    automaticPromotion: false;
    policy: string;
  };
};

const REGIME_LABELS: Record<V2RegimeKind, string> = {
  bull_trend: "上涨趋势",
  bear_trend: "下跌趋势",
  range: "震荡",
  compression: "波动压缩",
  expansion: "波动扩张",
  leverage_liquidation: "极端杠杆/清算",
  transition: "环境切换期",
};

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 0) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function candidateTransitionProbability(market: V2MarketContext) {
  if (!market.developingRegime) return 0;
  const lowMarginPressure = clamp(100 - market.regimeMargin);
  const velocityPressure = clamp(Math.max(0, market.transitionVelocity) * 3.5);
  const accelerationPressure = clamp(Math.max(0, market.riskAcceleration) * 2.5);
  const probability =
    lowMarginPressure * 0.28
    + market.transitionRisk * 0.38
    + velocityPressure * 0.18
    + accelerationPressure * 0.08
    + (100 - market.stability) * 0.08;
  return Math.round(clamp(probability));
}

function migrationStage(probability: number, market: V2MarketContext): Strategy2RegimeMigrationStage {
  if (!market.developingRegime || probability < 30) return "stable";
  if (probability < 48) return "forming";
  if (probability < 65) return "developing";
  return "switch_watch";
}

function buildRegimeMigration(market: V2MarketContext | null) {
  if (!market) return null;
  const probability = candidateTransitionProbability(market);
  const stage = migrationStage(probability, market);
  const candidateLabel = market.developingRegime ? REGIME_LABELS[market.developingRegime] : null;
  const explanation = !market.developingRegime
    ? "当前没有达到展示阈值的候选环境，继续维持现有 Regime。"
    : stage === "switch_watch"
      ? `候选环境「${candidateLabel}」已进入切换观察区，继续等待确认而不是提前强制换档。`
      : stage === "developing"
        ? `候选环境「${candidateLabel}」正在增强，现有 Regime 仍保持，风险先行收缩。`
        : stage === "forming"
          ? `候选环境「${candidateLabel}」正在形成，暂不足以触发正式切换。`
          : `候选环境「${candidateLabel}」证据较弱，现有 Regime 仍占优。`;
  return {
    currentRegime: market.regime,
    currentLabel: market.regimeLabel,
    candidateRegime: market.developingRegime,
    candidateLabel,
    transitionProbability: probability,
    stage,
    confidence: market.confidence,
    stability: market.stability,
    transitionRisk: market.transitionRisk,
    transitionVelocity: market.transitionVelocity,
    explanation,
  };
}

function estimatedWinProbability(opportunity: Strategy2Opportunity) {
  const learning = opportunity.learningScore ?? 50;
  const conflict = opportunity.strategyConflict ?? 0;
  const samplePenalty = Math.max(0, 10 - Math.min(10, opportunity.experienceSamples ?? 0)) * 0.8;
  const value =
    50
    + (opportunity.opportunityScore - 62) * 0.48
    + (learning - 50) * 0.22
    + (opportunity.environmentFit - 50) * 0.10
    + (opportunity.confirmation - 50) * 0.08
    - conflict * 0.10
    - samplePenalty;
  return round(clamp(value, 5, 95) / 100, 3);
}

function grossExpectedR(opportunity: Strategy2Opportunity, winProbability: number) {
  const learned = opportunity.expectancyR;
  const theoretical = opportunity.riskReward > 0
    ? winProbability * opportunity.riskReward - (1 - winProbability)
    : null;
  if (learned == null) return theoretical == null ? null : round(theoretical, 3);
  if (theoretical == null) return round(learned, 3);
  const sampleWeight = Math.min(1, Math.max(0, (opportunity.experienceSamples ?? 0) / 20));
  return round(learned * sampleWeight + theoretical * (1 - sampleWeight), 3);
}

function costBufferR(opportunity: Strategy2Opportunity, market: V2MarketContext | null) {
  let value = 0.04;
  if (opportunity.tradeMode === "exploration") value += 0.03;
  if (market?.volatility.state === "expanding") value += 0.03;
  if (market?.volatility.state === "extreme") value += 0.07;
  if ((opportunity.strategyConflict ?? 0) >= 70) value += 0.02;
  return round(Math.min(0.18, value), 3);
}

function decisionConfidence(opportunity: Strategy2Opportunity, market: V2MarketContext | null) {
  const learningConfidence = opportunity.learningConfidence ?? 0;
  const conflict = opportunity.strategyConflict ?? 0;
  const dataPenalty = market && !market.dataIntegrity.valid ? 35 : 0;
  const explorationPenalty = opportunity.tradeMode === "exploration" ? 8 : 0;
  return Math.round(clamp(
    opportunity.opportunityScore * 0.36
    + opportunity.environmentFit * 0.18
    + opportunity.confirmation * 0.16
    + learningConfidence * 0.20
    + (100 - conflict) * 0.10
    - dataPenalty
    - explorationPenalty,
  ));
}

function outOfDistributionRisk(opportunity: Strategy2Opportunity, market: V2MarketContext | null) {
  const lowLearningConfidence = 100 - (opportunity.learningConfidence ?? 0);
  const lowSamples = clamp(100 - Math.min(20, opportunity.experienceSamples ?? 0) / 20 * 100);
  const transitionRisk = market?.transitionRisk ?? 50;
  const instability = market ? 100 - market.stability : 50;
  const volatilityPenalty = market?.volatility.state === "extreme" ? 18 : market?.volatility.state === "expanding" ? 8 : 0;
  const dataPenalty = market && !market.dataIntegrity.valid ? 30 : 0;
  return Math.round(clamp(
    lowLearningConfidence * 0.34
    + lowSamples * 0.18
    + transitionRisk * 0.23
    + instability * 0.15
    + volatilityPenalty
    + dataPenalty,
  ));
}

function expertWeight(opportunity: Strategy2Opportunity) {
  const learning = opportunity.learningScore ?? 50;
  const confidence = opportunity.learningConfidence ?? 0;
  const statePenalty = opportunity.learningState === "negative" ? 35 : opportunity.learningState === "degrading" ? 18 : 0;
  const weight =
    opportunity.playbookFit * 0.36
    + opportunity.environmentFit * 0.24
    + learning * 0.24
    + confidence * 0.16
    - statePenalty;
  return round(clamp(weight, 20, 100) / 100, 3);
}

function decisionIntelligence(opportunity: Strategy2Opportunity, market: V2MarketContext | null): Strategy2DecisionIntelligence {
  const winProbability = estimatedWinProbability(opportunity);
  const gross = grossExpectedR(opportunity, winProbability);
  const cost = costBufferR(opportunity, market);
  const net = gross == null ? null : round(gross - cost, 3);
  const confidence = decisionConfidence(opportunity, market);
  const disagreement = Math.round(clamp(opportunity.strategyConflict ?? 0));
  const ood = outOfDistributionRisk(opportunity, market);
  const advisoryReasons: string[] = [];
  if (net != null && net <= 0) advisoryReasons.push(`成本后 EV ${net.toFixed(2)}R ≤ 0`);
  if (ood >= 80) advisoryReasons.push(`分布外风险 ${ood}/100 过高`);
  else if (ood >= 60) advisoryReasons.push(`分布外风险 ${ood}/100 偏高`);
  if (disagreement >= 90) advisoryReasons.push(`模型分歧 ${disagreement}/100 过高`);
  else if (disagreement >= 70) advisoryReasons.push(`模型分歧 ${disagreement}/100 偏高`);
  if (confidence < 45) advisoryReasons.push(`决策置信 ${confidence}/100 偏低`);
  const advisoryState: Strategy2AdvisoryState =
    (net != null && net <= 0) || ood >= 80 || disagreement >= 90
      ? "BLOCK"
      : ood >= 60 || disagreement >= 70 || confidence < 45
        ? "REDUCE"
        : "NORMAL";
  return {
    symbol: opportunity.symbol,
    playbook: opportunity.playbook,
    side: opportunity.side,
    state: opportunity.state,
    expertWeight: expertWeight(opportunity),
    estimatedWinProbability: winProbability,
    grossExpectedR: gross,
    estimatedCostBufferR: cost,
    netExpectedR: net,
    decisionConfidence: confidence,
    modelDisagreement: disagreement,
    outOfDistributionRisk: ood,
    advisoryState,
    advisoryReasons,
  };
}

function expertIntelligence(opportunities: Strategy2Opportunity[]) {
  const byPlaybook = new Map<string, Strategy2Opportunity[]>();
  for (const opportunity of opportunities) {
    const rows = byPlaybook.get(opportunity.playbook) ?? [];
    rows.push(opportunity);
    byPlaybook.set(opportunity.playbook, rows);
  }
  return [...byPlaybook.entries()].map(([playbook, rows]) => {
    const ranked = [...rows].sort((a, b) => expertWeight(b) - expertWeight(a) || b.opportunityScore - a.opportunityScore);
    const best = ranked[0];
    return {
      playbook,
      playbookLabel: best.playbookLabel,
      weight: expertWeight(best),
      confidence: best.learningConfidence ?? 0,
      learningState: best.learningState ?? "uncertain",
      sampleCount: best.experienceSamples ?? 0,
      expectancyR: best.expectancyR ?? null,
      bestEnvironmentFit: Math.max(...rows.map((row) => row.environmentFit)),
    } satisfies Strategy2ExpertIntelligence;
  }).sort((a, b) => b.weight - a.weight || b.confidence - a.confidence);
}

function learningUpdate(learning: Strategy2LearningDashboard | null) {
  if (!learning) return null;
  const headline = learning.degradingCells > 0
    ? `${learning.degradingCells} 个学习单元出现优势衰退，继续降风险观察。`
    : learning.positiveCells > 0
      ? `${learning.positiveCells} 个精确环境单元已形成正优势。`
      : "仍处于样本校准期，不因短期结果放大风险。";
  const riskNote = learning.negativeCells > 0
    ? `${learning.negativeCells} 个负优势单元保持禁用；学习结果只能降低风险，不能突破硬风控。`
    : "学习结果只参与排序、评分与风险收缩，不突破硬风控和实盘安全上限。";
  return {
    totalSamples: learning.totalSamples,
    forwardSamples: learning.forwardSamples,
    positiveCells: learning.positiveCells,
    negativeCells: learning.negativeCells,
    degradingCells: learning.degradingCells,
    playbookCoverage: learning.playbookCoverage,
    headline,
    riskNote,
  };
}

function globalRegimeFromTrade(regime: string | null | undefined) {
  if (!regime) return "unknown";
  const parsed = regime.split("|").find((part) => part.startsWith("global:"))?.slice(7);
  return parsed || regime.split(" · ")[0]?.trim() || "unknown";
}

function portfolioIntelligence(openTrades: { side: "LONG" | "SHORT"; regime?: string | null }[]) {
  if (!openTrades.length) {
    return { directionConcentration: 0, regimeSideConcentration: 0, dominantFactor: null, riskState: "NORMAL" as const };
  }
  const sideBuckets = new Map<string, number>();
  const factorBuckets = new Map<string, number>();
  for (const trade of openTrades) {
    sideBuckets.set(trade.side, (sideBuckets.get(trade.side) ?? 0) + 1);
    const factor = `${trade.side} · ${globalRegimeFromTrade(trade.regime)}`;
    factorBuckets.set(factor, (factorBuckets.get(factor) ?? 0) + 1);
  }
  const maxSide = Math.max(...sideBuckets.values());
  const rankedFactor = [...factorBuckets.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  const directionConcentration = Math.round(maxSide / openTrades.length * 100);
  const regimeSideConcentration = rankedFactor ? Math.round(rankedFactor[1] / openTrades.length * 100) : 0;
  const riskState = regimeSideConcentration >= 75 && openTrades.length >= 3
    ? "HIGH" as const
    : regimeSideConcentration >= 60 && openTrades.length >= 2
      ? "CONCENTRATED" as const
      : "NORMAL" as const;
  return { directionConcentration, regimeSideConcentration, dominantFactor: rankedFactor?.[0] ?? null, riskState };
}

export function buildStrategy2Intelligence(input: {
  observedAt: number;
  market: V2MarketContext | null;
  opportunities: Strategy2Opportunity[];
  learning: Strategy2LearningDashboard | null;
  openTrades: { side: "LONG" | "SHORT"; regime?: string | null }[];
}): Strategy2Intelligence {
  const maturedCutoff = input.observedAt - 60 * 60_000;
  const tracked = input.opportunities.filter((item) => item.state !== "TRADE");
  return {
    version: "strategy-2.1-intelligence",
    observedAt: input.observedAt,
    regimeMigration: buildRegimeMigration(input.market),
    decisions: input.opportunities.map((opportunity) => decisionIntelligence(opportunity, input.market)),
    experts: expertIntelligence(input.opportunities),
    learningUpdate: learningUpdate(input.learning),
    counterfactual: {
      trackedDecisionCount: tracked.length,
      maturedDecisionCount: tracked.filter((item) => item.observedAt <= maturedCutoff).length,
      status: "collecting",
      note: "WATCH/REJECT 决策继续保留为反事实样本；当前层只做影子归档与成熟度标记，不反向修改实盘参数。",
    },
    portfolio: portfolioIntelligence(input.openTrades),
    governance: {
      champion: "Sentinel Strategy 2.0",
      mode: "shadow_first",
      automaticPromotion: false,
      policy: "新学习结论先进入影子观察；任何升权都不能自动提高实盘风险上限，策略晋升仍需前向样本和人工批准。",
    },
  };
}
