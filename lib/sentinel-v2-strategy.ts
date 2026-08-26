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

export type Strategy2Experience = {
  sampleCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  expectancyR: number | null;
  averageNetPct: number | null;
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
  explorationValue: number;
  experienceSamples: number;
  expectancyR: number | null;
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
  const shrink = experience.sampleCount / (experience.sampleCount + 10);
  const expectancy = clamp(50 + (experience.expectancyR ?? 0) * 55, 0, 100);
  const win = experience.winRate == null ? 50 : clamp(50 + (experience.winRate - 0.5) * 90, 0, 100);
  return Math.round(50 + ((expectancy * 0.68 + win * 0.32) - 50) * shrink);
}

function explorationValue(experience: Strategy2Experience | null) {
  const samples = experience?.sampleCount ?? 0;
  return Math.round(clamp((20 - Math.min(20, samples)) / 20 * 100));
}

function tradeMode(score: number, experience: Strategy2Experience | null): Strategy2TradeMode {
  const samples = experience?.sampleCount ?? 0;
  if (score >= 85 && samples >= 8 && (experience?.expectancyR ?? 0) >= 0) return "high_conviction";
  if (score >= 72 && samples >= 5) return "standard";
  return "exploration";
}

function modeRiskMultiplier(mode: Strategy2TradeMode, score: number, experience: Strategy2Experience | null) {
  if (mode === "exploration") return 0.25;
  if (mode === "standard") return score >= 80 ? 0.65 : 0.50;
  const verified = (experience?.sampleCount ?? 0) >= 30 && (experience?.expectancyR ?? 0) >= 0.25;
  return verified && score >= 88 ? 1 : 0.80;
}

function learningRiskMultiplier(experience: Strategy2Experience | null) {
  if (!experience || experience.sampleCount < 6 || experience.expectancyR == null) return 1;
  if (experience.sampleCount >= 15 && experience.expectancyR <= -0.30) return 0;
  if (experience.expectancyR < -0.10) return 0.65;
  if (experience.expectancyR > 0.20) return 1;
  return 0.85;
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
  const playbookFit = Math.round(assetFit * 0.78 + learnScore * 0.22);
  const opportunityScore = Math.round(clamp(
    signal.strategyMeta.setupScore * 0.22
      + confirmation * 0.20
      + assetFit * 0.18
      + globalFit * 0.10
      + structure * 0.10
      + timing * 0.08
      + rrScore * 0.05
      + portfolio * 0.03
      + learnScore * 0.025
      + explore * 0.015,
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
  if (samples >= 15 && (experience?.expectancyR ?? 0) <= -0.30) rejectReasons.push("LEARNED_EDGE_NEGATIVE");

  const threshold = requiredScore(market.permission);
  if (!signal.strategyMeta.triggerActive) waitingFor.push("等待该 Playbook 的核心结构触发");
  if (opportunityScore < threshold) waitingFor.push(`机会综合分 ${opportunityScore}/${threshold}`);
  if (confirmation < 44) waitingFor.push(`加权确认 ${confirmation}/44`);
  if (timing < 42) waitingFor.push(`时机 ${timing}/42`);
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

  const reasons = [
    `${STRATEGY2_LABELS[signal.strategyId]} · 单币环境 ${signal.strategyMeta.assetRegime} 适配 ${assetFit}`,
    `Global ${market.regimeLabel}/${market.permission} 只调整风险，不替代单币策略判断`,
    `结构 ${structure} · 加权确认 ${confirmation} · 时机 ${timing} · RR ${riskReward.toFixed(2)}`,
    samples ? `真实样本 ${samples} · Expectancy ${experience?.expectancyR == null ? "--" : `${experience.expectancyR.toFixed(2)}R`}` : "该组合尚无真实样本，进入探索优先队列",
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
    explorationValue: explore,
    experienceSamples: samples,
    expectancyR: experience?.expectancyR ?? null,
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
