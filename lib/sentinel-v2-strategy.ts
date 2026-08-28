import type { Candle } from "./signal-engine.ts";
import type { V2MarketContext, V2Permission } from "./sentinel-v2-core.ts";
import { evaluateHumanTraderPool } from "./human-trader-engine.ts";
import type {
  Strategy2AssetRegime,
  Strategy2Id,
  Strategy2Input,
  Strategy2Signal,
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

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function permissionMultiplier(permission: V2Permission) {
  return permission === "GREEN" ? 1
    : permission === "BLUE" ? 0.92
      : permission === "YELLOW" ? 0.78
        : permission === "ORANGE" ? 0.58
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

function humanAssetFit(strategyId: Strategy2Id, regime: Strategy2AssetRegime) {
  if (strategyId === "trend_breakout") {
    return ({ trend_up: 94, trend_down: 94, expansion_up: 96, expansion_down: 96, compression: 74, transition: 58, range: 28, leverage_liquidation: 35 } as Record<Strategy2AssetRegime, number>)[regime];
  }
  if (strategyId === "trend_pullback") {
    return ({ trend_up: 98, trend_down: 98, expansion_up: 84, expansion_down: 84, transition: 52, range: 24, compression: 42, leverage_liquidation: 30 } as Record<Strategy2AssetRegime, number>)[regime];
  }
  return ({ transition: 98, range: 94, compression: 82, leverage_liquidation: 82, expansion_up: 72, expansion_down: 72, trend_up: 48, trend_down: 48 } as Record<Strategy2AssetRegime, number>)[regime];
}

function globalEnvironmentFit(market: V2MarketContext, side: "LONG" | "SHORT") {
  let score = 74;
  if (market.bias === side) score += 12;
  else if (market.bias !== "NEUTRAL") score -= 8;
  if (market.regime === "transition") score -= 4;
  if (market.regime === "leverage_liquidation") score -= 8;
  score -= Math.max(0, market.transitionRisk - 50) * 0.12;
  return Math.round(clamp(score));
}

function portfolioImpact(openTrades: { side: "LONG" | "SHORT"; symbol: string }[], side: "LONG" | "SHORT", symbol: string) {
  const sameSide = openTrades.filter((trade) => trade.side === side).length;
  const sameSymbol = openTrades.filter((trade) => trade.symbol === symbol).length;
  return Math.round(clamp(100 - sameSide * 26 - sameSymbol * 80));
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
  const pathQuality = clamp(50 + ((experience.t1HitRate ?? 0.5) - 0.5) * 70 - (experience.directionFailureRate ?? 0) * 28, 0, 100);
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
  return Math.round(clamp((18 - Math.min(18, samples)) / 18 * 100));
}

function tradeMode(score: number, experience: Strategy2Experience | null): Strategy2TradeMode {
  const samples = experience?.sampleCount ?? 0;
  const posterior = experience?.posteriorExpectancyR ?? experience?.expectancyR ?? 0;
  if (score >= 86 && samples >= 16 && posterior >= 0.15 && (experience?.edgeConfidence ?? 0) >= 60 && experience?.edgeState === "positive") return "high_conviction";
  if (samples >= 6 && posterior > -0.08 && experience?.edgeState !== "negative") return "standard";
  return "exploration";
}

function diagnosticRiskMultiplier(mode: Strategy2TradeMode, market: V2MarketContext, experience: Strategy2Experience | null) {
  if (market.permission === "RED") return 0;
  let base = mode === "high_conviction" ? 1 : mode === "standard" ? 0.72 : 0.45;
  base *= permissionMultiplier(market.permission);
  if (experience?.edgeState === "degrading") base *= 0.45;
  if (experience?.recentExpectancyR != null && experience.recentExpectancyR <= -0.30) base *= 0.55;
  return Number(Math.max(0, Math.min(1, base)).toFixed(3));
}

function evaluateOne(signal: Strategy2Signal, input: Strategy2Input, market: V2MarketContext, openTrades: { side: "LONG" | "SHORT"; symbol: string }[], book?: Strategy2ExperienceBook): Strategy2Opportunity {
  const candidateSide = signal.strategyMeta.candidateSide;
  const side = signal.side === "WAIT" ? candidateSide : signal.side;
  const playbook = signal.strategyMeta.playbookId;
  const experience = lookupExperience(book, playbook, market.regime, signal.strategyMeta.assetRegime, side);
  const samples = experience?.sampleCount ?? 0;
  const learnScore = learningScore(experience);
  const explore = explorationValue(experience);
  const assetFit = humanAssetFit(signal.strategyId, signal.strategyMeta.assetRegime);
  const globalFit = globalEnvironmentFit(market, side);
  const environmentFit = Math.round(assetFit * 0.82 + globalFit * 0.18);
  const structure = signal.strategyMeta.setupScore;
  const confirmation = signal.strategyMeta.evidenceScore;
  const timing = Math.round(clamp(40 + signal.strategyMeta.setupScore * 0.44 + (signal.strategyMeta.triggerActive ? 18 : 0) - Math.max(0, market.transitionVelocity) * 0.08));
  const riskReward = signal.entryPlan?.riskReward ?? 0;
  const portfolio = portfolioImpact(openTrades, side, input.symbol);
  const playbookFit = Math.round(assetFit * 0.78 + learnScore * 0.22);

  // This number ranks complete setups; it no longer grants entry authority.
  // Three incomplete human-trader opinions can never be averaged into one trade.
  const opportunityScore = Math.round(clamp(
    structure * 0.30
      + confirmation * 0.23
      + assetFit * 0.18
      + globalFit * 0.08
      + Math.min(100, Math.max(0, (riskReward - 1) * 55)) * 0.08
      + portfolio * 0.05
      + learnScore * 0.08,
  ));

  const rejectReasons: string[] = [];
  const waitingFor: string[] = [];
  if (!market.dataIntegrity.valid) rejectReasons.push("DATA_UNSAFE");
  if (market.permission === "RED") rejectReasons.push("GLOBAL_RISK_RED");
  if (input.fundingRate != null && Math.abs(input.fundingRate) >= 0.0015) rejectReasons.push("LEVERAGE_EXTREME");
  if (riskReward > 0 && riskReward < 1.5) rejectReasons.push("RR_LOW");
  if (portfolio < 20) rejectReasons.push("PORTFOLIO_CONCENTRATION");
  if (experience?.edgeState === "negative") rejectReasons.push("LEARNED_EDGE_NEGATIVE");
  if (signal.strategyMeta.triggerActive && !signal.strategyMeta.hardGatePassed) rejectReasons.push(...signal.blockers);

  if (!signal.strategyMeta.triggerActive) waitingFor.push(`等待 ${signal.label} 自己的核心 Setup`);
  if (!signal.entryPlan?.ready) waitingFor.push("该交易员的 Router / Trigger / Invalidation 尚未同时成立");
  if (experience?.edgeState === "degrading") waitingFor.push("该交易员在当前环境的近期优势衰退，Risk Governor 将压低优先级");

  let state: Strategy2Opportunity["state"] = "WATCH";
  if (rejectReasons.length) state = "REJECT";
  else if (signal.state === "ready" && signal.strategyMeta.triggerActive && signal.entryPlan?.ready) state = "TRADE";

  const mode = tradeMode(opportunityScore, experience);
  const riskMultiplier = state === "TRADE" ? diagnosticRiskMultiplier(mode, market, experience) : 0;
  const adaptiveExpectation = experience?.posteriorExpectancyR ?? experience?.expectancyR ?? null;
  const recentExpectation = experience?.recentExpectancyR ?? null;
  const t1 = experience?.t1HitRate ?? null;
  const directionFailure = experience?.directionFailureRate ?? null;
  const inversePotential = experience?.inverseT1PotentialRate ?? null;
  const reasons = [
    `${signal.label} · 独立 Setup · Asset ${signal.strategyMeta.assetRegime} 适配 ${assetFit}`,
    `Global ${market.regimeLabel}/${market.permission} 只管理风险背景，不替交易员决定方向`,
    `结构 ${structure} · 证据 ${confirmation} · RR ${riskReward.toFixed(2)} · 排名分 ${opportunityScore}`,
    samples
      ? `学习：n=${samples} · 后验 ${adaptiveExpectation == null ? "--" : `${adaptiveExpectation.toFixed(2)}R`} · 近窗 ${recentExpectation == null ? "--" : `${recentExpectation.toFixed(2)}R`} · 方向失败 ${directionFailure == null ? "--" : `${Math.round(directionFailure * 100)}%`}`
      : "新交易员/环境组合从零开始记录，旧 Strategy 2.0 样本不作为它的优势证明",
  ];

  return {
    symbol: input.symbol,
    observedAt: input.observedAt,
    playbook,
    playbookLabel: signal.label,
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
    maxRisk: market.warnings[0]?.title ?? (market.transitionRisk >= 50 ? "市场环境迁移风险正在升高" : null),
  };
}

/**
 * At most one human trader owns a symbol at a time. This is selection, not a
 * vote: other traders cannot add score/risk to the winner. If two complete
 * setups coexist, the cleaner independent setup wins this scan and the other
 * remains WATCH for auditability.
 */
function selectIndependentOwner(opportunities: Strategy2Opportunity[]) {
  const trades = opportunities.filter((item) => item.state === "TRADE").sort((a, b) =>
    b.opportunityScore - a.opportunityScore
    || b.environmentFit - a.environmentFit
    || b.riskReward - a.riskReward,
  );
  const winner = trades[0];
  if (!winner) return opportunities;
  for (const opportunity of trades.slice(1)) {
    opportunity.state = "WATCH";
    opportunity.riskMultiplier = 0;
    opportunity.waitingFor.push(`本轮由更完整的独立 Setup「${winner.playbookLabel}」拥有该币；不做多策略投票或叠加`);
  }
  return opportunities;
}

function addHumanTraderCheck(signal: Strategy2Signal, opportunity: Strategy2Opportunity, market: V2MarketContext) {
  if (!signal.entryPlan) return null;
  const passed = opportunity.state === "TRADE";
  return {
    ...signal.entryPlan,
    ready: signal.entryPlan.ready && passed,
    checks: [
      ...signal.entryPlan.checks.filter((check) => check.key !== "sentinel-v2-context" && check.key !== "human-trader-authority"),
      {
        key: "human-trader-authority",
        label: "Human Trader Engine 单一开仓权",
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
    thesis: `Sentinel Human Trader Engine 3.0：当前由「${opportunity.playbookLabel}」独立判断。${signal.thesis}`,
    reasons: [...opportunity.reasons, ...opportunity.waitingFor.map((item) => `等待：${item}`), ...signal.reasons].slice(0, 14),
    blockers: opportunity.state === "REJECT" ? [...new Set([...signal.blockers, ...opportunity.rejectReasons])] : signal.blockers,
    entryPlan: addHumanTraderCheck(signal, opportunity, market),
    metrics: [
      {
        key: "human-risk-mode",
        label: "Human Risk Governor 建议倍率",
        score: opportunity.riskMultiplier,
        detail: `${opportunity.tradeMode} · 建议 ${(opportunity.riskMultiplier * 100).toFixed(0)}% · 当前模拟执行仍受账户基础风险上限约束`,
        available: true,
        category: "derivatives" as const,
      },
      {
        key: "human-learning-edge",
        label: "交易员环境优势",
        score: (opportunity.learningScore - 50) / 50,
        detail: `${opportunity.learningState} · 学习 ${opportunity.learningScore}/100 · 置信 ${opportunity.learningConfidence}%`,
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
      supportingPlaybooks: [],
      strategyConflict: 0,
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
  const rawSignals = evaluateHumanTraderPool(input);
  const opportunities = selectIndependentOwner(rawSignals.map((signal) => evaluateOne(signal, input, options.market, options.openTrades, options.experienceBook)));
  return {
    signals: rawSignals.map((signal, index) => mappedSignal(signal, opportunities[index], options.market)),
    opportunities,
  };
}
