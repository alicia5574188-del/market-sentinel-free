import type { Candle } from "./signal-engine.ts";
import type { V2MarketContext, V2Permission } from "./sentinel-v2-core.ts";
import {
  evaluateStrategy2Pool,
  STRATEGY2_LABELS,
  type Strategy2AssetRegime,
  type Strategy2Id,
  type Strategy2Input,
  type Strategy2Signal,
} from "./strategy-2-engine.ts";

export type Strategy2TradeMode = "exploration" | "standard" | "high_conviction";
export type Strategy2AdaptiveEdgeState = "uncertain" | "positive" | "negative" | "degrading";

export type Strategy2Experience = {
  sampleCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  expectancyR: number | null;
  averageNetPct: number | null;
  rawExpectancyR?: number | null;
  recencyExpectancyR?: number | null;
  recentExpectancyR?: number | null;
  posteriorExpectancyR?: number | null;
  effectiveSampleCount?: number;
  averageMfeR?: number | null;
  averageMaeR?: number | null;
  t1HitRate?: number | null;
  directionFailureRate?: number | null;
  inverseT1PotentialRate?: number | null;
  edgeLowerBoundR?: number | null;
  edgeUpperBoundR?: number | null;
  edgeConfidence?: number;
  driftR?: number | null;
  edgeState?: Strategy2AdaptiveEdgeState;
  forwardSampleCount?: number;
  forwardExpectancyR?: number | null;
  forwardInverseT1PotentialRate?: number | null;
};

export type Strategy2ExperienceBook = Record<string, Strategy2Experience>;

export type Strategy2Opportunity = {
  symbol: string;
  observedAt: number;
  playbook: string;
  playbookLabel: string;
  strategyId: Strategy2Id;
  side: "LONG" | "SHORT" | "WAIT";
  state: "TRADE" | "WATCH" | "REJECT";
  tradeMode: Strategy2TradeMode;
  opportunityScore: number;
  environmentFit: number;
  playbookFit: number;
  structure: number;
  timing: number;
  confirmation: number;
  riskReward: number;
  portfolioImpact: number;
  riskMultiplier: number;
  globalRegime: string;
  assetRegime: Strategy2AssetRegime;
  learningScore: number;
  learningConfidence: number;
  learningState: Strategy2AdaptiveEdgeState;
  explorationValue: number;
  experienceSamples: number;
  expectancyR: number | null;
  recentExpectancyR: number | null;
  t1HitRate: number | null;
  directionFailureRate: number | null;
  inverseT1PotentialRate: number | null;
  supportingPlaybooks: string[];
  strategyConflict: number;
  waitingFor: string[];
  rejectReasons: string[];
  reasons: string[];
  maxRisk: string | null;
};

export type SentinelV2StrategyResult = {
  signals: Strategy2Signal[];
  opportunities: Strategy2Opportunity[];
};

const PLAYBOOK_IDS: Record<Strategy2Id, string> = {
  trend_pullback: "P1_TREND_PULLBACK",
  trend_breakout: "P2_TREND_BREAKOUT",
  range_reversion: "P3_RANGE_REVERSAL",
  compression_breakout: "P4_COMPRESSION_BREAKOUT",
  expansion_momentum: "P5_EXPANSION_MOMENTUM",
  liquidation_reversal: "P6_LIQUIDATION_REVERSAL",
  liquidation_continuation: "P7_LIQUIDATION_CONTINUATION",
  exhaustion_reversal: "P8_EXHAUSTION_REVERSAL",
  relative_strength: "P9_RELATIVE_STRENGTH",
  rotation_leadership: "P10_ROTATION_LEADERSHIP",
  failed_breakout: "P11_FAILED_BREAKOUT",
  flow_divergence: "P12_FLOW_DIVERGENCE",
};

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function permissionMultiplier(permission: V2Permission) {
  return permission === "GREEN" ? 1
    : permission === "BLUE" ? 0.90
      : permission === "YELLOW" ? 0.70
        : permission === "ORANGE" ? 0.40
          : 0;
}

export function strategy2ExperienceKey(playbook: string, globalRegime: string, assetRegime: string, side: "LONG" | "SHORT") {
  return `${playbook}|global:${globalRegime}|asset:${assetRegime}|side:${side}`;
}

function lookupExperience(book: Strategy2ExperienceBook | undefined, playbook: string, globalRegime: string, assetRegime: string, side: "LONG" | "SHORT") {
  if (!book) return null;
  return book[strategy2ExperienceKey(playbook, globalRegime, assetRegime, side)]
    ?? book[strategy2ExperienceKey(playbook, "*", assetRegime, side)]
    ?? book[strategy2ExperienceKey(playbook, "*", "*", side)]
    ?? null;
}

function assetPlaybookFit(strategyId: Strategy2Id, regime: Strategy2AssetRegime) {
  const profiles: Record<Strategy2Id, Partial<Record<Strategy2AssetRegime, number>>> = {
    trend_pullback: { trend_up: 94, trend_down: 94, expansion_up: 76, expansion_down: 76, transition: 58, range: 38, compression: 52, leverage_liquidation: 42 },
    trend_breakout: { trend_up: 88, trend_down: 88, expansion_up: 90, expansion_down: 90, compression: 68, transition: 62, range: 45, leverage_liquidation: 55 },
    range_reversion: { range: 94, compression: 75, transition: 70, trend_up: 42, trend_down: 42, expansion_up: 36, expansion_down: 36, leverage_liquidation: 55 },
    compression_breakout: { compression: 98, expansion_up: 86, expansion_down: 86, transition: 68, trend_up: 62, trend_down: 62, range: 58, leverage_liquidation: 52 },
    expansion_momentum: { expansion_up: 96, expansion_down: 96, trend_up: 82, trend_down: 82, leverage_liquidation: 72, transition: 64, compression: 48, range: 42 },
    liquidation_reversal: { leverage_liquidation: 98, transition: 82, expansion_up: 72, expansion_down: 72, range: 60, trend_up: 48, trend_down: 48, compression: 42 },
    liquidation_continuation: { leverage_liquidation: 96, expansion_up: 86, expansion_down: 86, transition: 72, trend_up: 65, trend_down: 65, range: 38, compression: 35 },
    exhaustion_reversal: { transition: 94, expansion_up: 88, expansion_down: 88, trend_up: 76, trend_down: 76, leverage_liquidation: 78, range: 62, compression: 45 },
    relative_strength: { trend_up: 92, trend_down: 92, expansion_up: 90, expansion_down: 90, range: 74, transition: 80, compression: 68, leverage_liquidation: 62 },
    rotation_leadership: { trend_up: 88, trend_down: 88, expansion_up: 92, expansion_down: 92, range: 78, transition: 84, compression: 70, leverage_liquidation: 60 },
    failed_breakout: { transition: 96, range: 86, expansion_up: 82, expansion_down: 82, compression: 70, trend_up: 65, trend_down: 65, leverage_liquidation: 68 },
    flow_divergence: { transition: 94, range: 86, expansion_up: 82, expansion_down: 82, trend_up: 78, trend_down: 78, leverage_liquidation: 80, compression: 68 },
  };
  return profiles[strategyId][regime] ?? 50;
}

function globalEnvironmentFit(market: V2MarketContext, side: "LONG" | "SHORT") {
  let score = 72;
  if (market.bias === side) score += 14;
  else if (market.bias !== "NEUTRAL") score -= 10;
  if (market.regime === "transition") score -= 7;
  if (market.regime === "leverage_liquidation") score -= 5;
  score -= Math.max(0, market.transitionRisk - 45) * 0.15;
  return Math.round(clamp(score));
}

function portfolioImpact(openTrades: { side: "LONG" | "SHORT"; symbol: string }[], side: "LONG" | "SHORT", symbol: string) {
  const sameSide = openTrades.filter((trade) => trade.side === side).length;
  const sameSymbol = openTrades.filter((trade) => trade.symbol === symbol).length;
  return Math.round(clamp(100 - sameSide * 24 - sameSymbol * 75));
}

function learningScore(experience: Strategy2Experience | null) {
  if (!experience || experience.sampleCount === 0) return 50;
  const samples = experience.effectiveSampleCount ?? experience.sampleCount;
  const shrink = samples / (samples + 8);
  const posterior = experience.posteriorExpectancyR ?? experience.expectancyR ?? 0;
  const recent = experience.recentExpectancyR ?? posterior;
  const expectancy = clamp(50 + posterior * 60, 0, 100);
  const recentScore = clamp(50 + recent * 48, 0, 100);
  const win = experience.winRate == null ? 50 : clamp(50 + (experience.winRate - 0.5) * 80, 0, 100);
  const t1 = experience.t1HitRate ?? 0.5;
  const directionFailure = experience.directionFailureRate ?? 0;
  const pathQuality = clamp(50 + (t1 - 0.5) * 70 - directionFailure * 28, 0, 100);
  const confidence = 0.35 + 0.65 * ((experience.edgeConfidence ?? 0) / 100);
  const stateAdjustment = experience.edgeState === "positive" ? 8
    : experience.edgeState === "negative" ? -32
      : experience.edgeState === "degrading" ? -18
        : 0;
  const blended = expectancy * 0.42 + recentScore * 0.25 + pathQuality * 0.18 + win * 0.15;
  return Math.round(clamp(50 + (blended - 50) * shrink * confidence + stateAdjustment));
}

function explorationValue(experience: Strategy2Experience | null) {
  if (!experience) return 100;
  if (experience.edgeState === "negative") return 0;
  if (experience.edgeState === "degrading") return 5;
  const samples = experience.effectiveSampleCount ?? experience.sampleCount;
  const base = clamp((18 - Math.min(18, samples)) / 18 * 100);
  const directionPenalty = Math.max(0, ((experience.directionFailureRate ?? 0) - 0.45) * 120);
  const inversePenalty = Math.max(0, ((experience.inverseT1PotentialRate ?? 0) - 0.55) * 80);
  return Math.round(clamp(base - directionPenalty - inversePenalty));
}

function tradeMode(score: number, experience: Strategy2Experience | null): Strategy2TradeMode {
  const samples = experience?.sampleCount ?? 0;
  const posterior = experience?.posteriorExpectancyR ?? experience?.expectancyR ?? 0;
  if (score >= 85 && samples >= 12 && posterior >= 0.12 && (experience?.edgeConfidence ?? 0) >= 55 && experience?.edgeState !== "degrading") return "high_conviction";
  if (score >= 72 && samples >= 5 && experience?.edgeState !== "negative") return "standard";
  return "exploration";
}

function modeRiskMultiplier(mode: Strategy2TradeMode, score: number, experience: Strategy2Experience | null) {
  if (mode === "exploration") return 0.25;
  if (mode === "standard") return score >= 80 ? 0.65 : 0.50;
  const verified = (experience?.sampleCount ?? 0) >= 30
    && (experience?.posteriorExpectancyR ?? experience?.expectancyR ?? 0) >= 0.20
    && (experience?.edgeConfidence ?? 0) >= 65;
  return verified && score >= 88 ? 1 : 0.80;
}

function learningRiskMultiplier(experience: Strategy2Experience | null) {
  if (!experience || experience.sampleCount < 5) return 1;
  if (experience.edgeState === "negative") return 0;
  if (experience.edgeState === "degrading") return 0.35;
  const posterior = experience.posteriorExpectancyR ?? experience.expectancyR;
  const recent = experience.recentExpectancyR ?? posterior;
  if (posterior == null) return 0.9;
  if (experience.sampleCount >= 6 && (recent ?? 0) <= -0.30) return 0.45;
  if (experience.sampleCount >= 8 && (experience.directionFailureRate ?? 0) >= 0.58) return 0.50;
  if (posterior < -0.12) return 0.55;
  if (posterior < -0.03) return 0.75;
  if (experience.edgeState === "positive" && (experience.edgeConfidence ?? 0) >= 60) return 1;
  return 0.90;
}

function requiredScore(permission: V2Permission) {
  return permission === "ORANGE" ? 76
    : permission === "YELLOW" ? 68
      : permission === "BLUE" ? 64
        : permission === "GREEN" ? 62
          : 101;
}

function evaluateOne(signal: Strategy2Signal, input: Strategy2Input, market: V2MarketContext, openTrades: { side: "LONG" | "SHORT"; symbol: string }[], book?: Strategy2ExperienceBook): Strategy2Opportunity {
  const candidateSide = signal.strategyMeta.candidateSide;
  const side = signal.side === "WAIT" ? candidateSide : signal.side;
  const playbook = PLAYBOOK_IDS[signal.strategyId];
  const experience = lookupExperience(book, playbook, market.regime, signal.strategyMeta.assetRegime, side);
  const samples = experience?.sampleCount ?? 0;
  const learnScore = learningScore(experience);
  const explore = explorationValue(experience);
  const assetFit = assetPlaybookFit(signal.strategyId, signal.strategyMeta.assetRegime);
  const globalFit = globalEnvironmentFit(market, side);
  const environmentFit = Math.round(assetFit * 0.72 + globalFit * 0.28);
  const structure = Math.round(clamp(signal.strategyMeta.setupScore * 0.72 + Math.abs(signal.score) * 28));
  const confirmation = signal.strategyMeta.evidenceScore;
  const chase = Math.abs(input.changePercentage ?? 0);
  const chasePenalty = chase >= 15 ? 32 : chase >= 11 ? 20 : chase >= 8 ? 10 : 0;
  const timing = Math.round(clamp(52 + signal.strategyMeta.setupScore * 0.32 + confirmation * 0.20 - chasePenalty - Math.max(0, market.transitionVelocity) * 0.12));
  const riskReward = signal.entryPlan?.riskReward ?? 0;
  const rrScore = clamp((riskReward - 1) * 58);
  const portfolio = portfolioImpact(openTrades, side, input.symbol);
  const playbookFit = Math.round(assetFit * 0.72 + learnScore * 0.28);
  const opportunityScore = Math.round(clamp(
    signal.strategyMeta.setupScore * 0.20
      + confirmation * 0.19
      + assetFit * 0.17
      + globalFit * 0.09
      + structure * 0.09
      + timing * 0.08
      + rrScore * 0.05
      + portfolio * 0.03
      + learnScore * 0.08
      + explore * 0.02,
  ));

  const rejectReasons: string[] = [];
  const waitingFor: string[] = [];
  if (!market.dataIntegrity.valid) rejectReasons.push("DATA_UNSAFE");
  if (market.permission === "RED") rejectReasons.push("TRANSITION_HIGH");
  if (!signal.strategyMeta.hardGatePassed && signal.strategyMeta.triggerActive) rejectReasons.push(...signal.blockers);
  if (riskReward > 0 && riskReward < 1.35) rejectReasons.push("RR_LOW");
  if (portfolio < 20) rejectReasons.push("PORTFOLIO_CONCENTRATION");
  if (chase >= 15 && ["trend_breakout", "expansion_momentum", "relative_strength", "rotation_leadership"].includes(signal.strategyId)) rejectReasons.push("CHASE_TOO_FAR");
  if (input.fundingRate != null && Math.abs(input.fundingRate) >= 0.0015) rejectReasons.push("LEVERAGE_EXTREME");
  if (experience?.edgeState === "negative") rejectReasons.push("LEARNED_EDGE_NEGATIVE");

  const threshold = requiredScore(market.permission);
  if (!signal.strategyMeta.triggerActive) waitingFor.push("等待该 Playbook 的核心结构触发");
  if (opportunityScore < threshold) waitingFor.push(`机会综合分 ${opportunityScore}/${threshold}`);
  if (confirmation < 44) waitingFor.push(`加权确认 ${confirmation}/44`);
  if (timing < 42) waitingFor.push(`时机 ${timing}/42`);
  if (experience?.edgeState === "degrading") waitingFor.push("该组合近期优势明显衰退，仅允许显著缩小风险");
  if (signal.state === "watching" && signal.strategyMeta.triggerActive) waitingFor.push("策略证据仍在形成，但不要求全部指标同时通过");

  let state: Strategy2Opportunity["state"] = "WATCH";
  if (rejectReasons.length) state = "REJECT";
  else if (signal.strategyMeta.triggerActive && signal.entryPlan?.ready && signal.state === "ready" && opportunityScore >= threshold && confirmation >= 44 && timing >= 42) state = "TRADE";

  const mode = tradeMode(opportunityScore, experience);
  const volatilityMultiplier = market.volatility.state === "extreme" ? 0.50 : market.volatility.state === "expanding" ? 0.80 : 1;
  const portfolioMultiplier = portfolio < 45 ? 0.50 : portfolio < 70 ? 0.75 : 1;
  const riskMultiplier = state === "TRADE"
    ? Number(clamp(
      modeRiskMultiplier(mode, opportunityScore, experience)
        * permissionMultiplier(market.permission)
        * volatilityMultiplier
        * portfolioMultiplier
        * learningRiskMultiplier(experience),
      0,
      1,
    ).toFixed(3))
    : 0;

  const adaptiveExpectation = experience?.posteriorExpectancyR ?? experience?.expectancyR ?? null;
  const recentExpectation = experience?.recentExpectancyR ?? null;
  const t1 = experience?.t1HitRate ?? null;
  const directionFailure = experience?.directionFailureRate ?? null;
  const inversePotential = experience?.inverseT1PotentialRate ?? null;
  const reasons = [
    `${STRATEGY2_LABELS[signal.strategyId]} · 单币环境 ${signal.strategyMeta.assetRegime} 适配 ${assetFit}`,
    `Global ${market.regimeLabel}/${market.permission} 只调整风险，不替代单币策略判断`,
    `结构 ${structure} · 加权确认 ${confirmation} · 时机 ${timing} · RR ${riskReward.toFixed(2)}`,
    samples
      ? `Adaptive 学习：n=${samples} · 后验 ${adaptiveExpectation == null ? "--" : `${adaptiveExpectation.toFixed(2)}R`} · 近窗 ${recentExpectation == null ? "--" : `${recentExpectation.toFixed(2)}R`} · T1 ${t1 == null ? "--" : `${Math.round(t1 * 100)}%`} · 方向失败 ${directionFailure == null ? "--" : `${Math.round(directionFailure * 100)}%`} · 反向T1潜力 ${inversePotential == null ? "--" : `${Math.round(inversePotential * 100)}%`} · 置信 ${experience?.edgeConfidence ?? 0}%`
      : "该组合尚无精确样本，继承 Playbook/Asset 上层先验并用最小风险探索",
  ];

  return {
    symbol: input.symbol,
    observedAt: input.observedAt,
    playbook,
    playbookLabel: STRATEGY2_LABELS[signal.strategyId],
    strategyId: signal.strategyId,
    side: signal.strategyMeta.triggerActive ? side : "WAIT",
    state,
    tradeMode: mode,
    opportunityScore,
    environmentFit,
    playbookFit,
    structure,
    timing,
    confirmation,
    riskReward,
    portfolioImpact: portfolio,
    riskMultiplier,
    globalRegime: market.regime,
    assetRegime: signal.strategyMeta.assetRegime,
    learningScore: learnScore,
    learningConfidence: experience?.edgeConfidence ?? 0,
    learningState: experience?.edgeState ?? "uncertain",
    explorationValue: explore,
    experienceSamples: samples,
    expectancyR: adaptiveExpectation,
    recentExpectancyR: recentExpectation,
    t1HitRate: t1,
    directionFailureRate: directionFailure,
    inverseT1PotentialRate: inversePotential,
    supportingPlaybooks: [],
    strategyConflict: 0,
    waitingFor,
    rejectReasons: [...new Set(rejectReasons)],
    reasons,
    maxRisk: market.warnings[0]?.title ?? (market.transitionRisk >= 45 ? "环境切换风险正在升高" : null),
  };
}

function applyStrategyCompetition(opportunities: Strategy2Opportunity[]) {
  const directional = opportunities.filter((opportunity) => opportunity.side !== "WAIT" && opportunity.state !== "REJECT");
  const bestLong = directional.filter((item) => item.side === "LONG").sort((a, b) => b.opportunityScore - a.opportunityScore)[0];
  const bestShort = directional.filter((item) => item.side === "SHORT").sort((a, b) => b.opportunityScore - a.opportunityScore)[0];
  const conflict = bestLong && bestShort
    ? Math.round(clamp(100 - Math.abs(bestLong.opportunityScore - bestShort.opportunityScore) * 5))
    : 0;

  for (const opportunity of opportunities) {
    if (opportunity.side === "WAIT") continue;
    const support = directional
      .filter((other) => other.strategyId !== opportunity.strategyId && other.side === opportunity.side && other.opportunityScore >= Math.max(56, opportunity.opportunityScore - 12))
      .sort((a, b) => b.opportunityScore - a.opportunityScore)
      .slice(0, 4);
    opportunity.supportingPlaybooks = support.map((item) => item.playbook);
    opportunity.strategyConflict = conflict;
    if (support.length) {
      opportunity.opportunityScore = Math.round(clamp(opportunity.opportunityScore + Math.min(6, support.length * 2)));
      opportunity.reasons.push(`同向支持：${support.map((item) => item.playbookLabel).join("、")}`);
      if (opportunity.state === "TRADE") opportunity.riskMultiplier = Number(Math.min(1, opportunity.riskMultiplier * 1.08).toFixed(3));
    }
    if (conflict >= 80 && opportunity.state === "TRADE") {
      const opposingBest = opportunity.side === "LONG" ? bestShort : bestLong;
      if (opposingBest && Math.abs(opportunity.opportunityScore - opposingBest.opportunityScore) <= 4) {
        opportunity.state = "WATCH";
        opportunity.riskMultiplier = 0;
        opportunity.waitingFor.push("多策略多空冲突过高，等待一侧明显胜出");
      } else {
        opportunity.riskMultiplier = Number((opportunity.riskMultiplier * 0.5).toFixed(3));
        opportunity.reasons.push("存在明显反向策略竞争，仓位减半");
      }
    }
  }
  return opportunities;
}

function addV2Check(signal: Strategy2Signal, opportunity: Strategy2Opportunity, market: V2MarketContext) {
  if (!signal.entryPlan) return null;
  const passed = opportunity.state === "TRADE";
  return {
    ...signal.entryPlan,
    ready: signal.entryPlan.ready && passed,
    checks: [
      ...signal.entryPlan.checks.filter((check) => check.key !== "sentinel-v2-context"),
      {
        key: "sentinel-v2-context",
        label: "Strategy 2.0 综合许可",
        passed,
        required: true,
        detail: `${opportunity.playbookLabel} · Asset ${opportunity.assetRegime} · Global ${market.regimeLabel}/${market.permission} · ${opportunity.tradeMode} · ${opportunity.state}`,
      },
    ],
  };
}

function mappedSignal(signal: Strategy2Signal, opportunity: Strategy2Opportunity, market: V2MarketContext): Strategy2Signal {
  const state = opportunity.state === "TRADE" ? "ready" : opportunity.state === "REJECT" ? "blocked" : "watching";
  return {
    ...signal,
    label: opportunity.playbookLabel,
    state,
    confidence: opportunity.opportunityScore,
    thesis: `Sentinel Strategy 2.0：Global ${market.regimeLabel}，Asset ${opportunity.assetRegime}，${opportunity.tradeMode}。${signal.thesis}`,
    reasons: [...opportunity.reasons, ...opportunity.waitingFor.map((item) => `等待：${item}`), ...signal.reasons].slice(0, 14),
    blockers: opportunity.state === "REJECT" ? [...new Set([...signal.blockers, ...opportunity.rejectReasons])] : signal.blockers,
    entryPlan: addV2Check(signal, opportunity, market),
    metrics: [
      {
        key: "v2-risk-multiplier",
        label: "V2 风险倍率",
        score: opportunity.riskMultiplier,
        detail: `${opportunity.playbookLabel} · ${opportunity.tradeMode} · ${(opportunity.riskMultiplier * 100).toFixed(0)}%`,
        available: true,
        category: "derivatives" as const,
      },
      {
        key: "strategy2-learning-edge",
        label: "Adaptive 学习优势",
        score: (opportunity.learningScore - 50) / 50,
        detail: `${opportunity.learningState} · 学习 ${opportunity.learningScore}/100 · 置信 ${opportunity.learningConfidence}%`,
        available: true,
        category: "cross" as const,
      },
      {
        key: "strategy2-conflict",
        label: "策略冲突",
        score: -opportunity.strategyConflict / 100,
        detail: `${opportunity.strategyConflict}/100`,
        available: true,
        category: "cross" as const,
      },
      ...signal.metrics,
    ],
    strategyMeta: {
      ...signal.strategyMeta,
      playbookId: opportunity.playbook,
      globalRegime: opportunity.globalRegime,
      assetRegime: opportunity.assetRegime,
      tradeMode: opportunity.tradeMode,
      supportingPlaybooks: opportunity.supportingPlaybooks,
      strategyConflict: opportunity.strategyConflict,
      experienceSamples: opportunity.experienceSamples,
      expectancyR: opportunity.expectancyR,
    },
  };
}

export function evaluateSentinelV2Strategies(input: Strategy2Input & { candles5m: Candle[] }, options: {
  market: V2MarketContext;
  openTrades: { symbol: string; side: "LONG" | "SHORT"; entryThesis?: string | null; regime?: string | null }[];
  experienceBook?: Strategy2ExperienceBook;
}): SentinelV2StrategyResult {
  const rawSignals = evaluateStrategy2Pool(input);
  const opportunities = applyStrategyCompetition(rawSignals.map((signal) => evaluateOne(signal, input, options.market, options.openTrades, options.experienceBook)));
  return {
    signals: rawSignals.map((signal, index) => mappedSignal(signal, opportunities[index], options.market)),
    opportunities,
  };
}
