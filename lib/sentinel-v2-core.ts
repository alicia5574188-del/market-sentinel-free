import type { UniverseTicker } from "./gate-client.ts";
import type { ShadowStrategySignal } from "./shadow-strategy-engine.ts";

export type V2RegimeKind =
  | "bull_trend"
  | "bear_trend"
  | "range"
  | "compression"
  | "expansion"
  | "leverage_liquidation"
  | "transition";

export type V2Permission = "GREEN" | "BLUE" | "YELLOW" | "ORANGE" | "RED";
export type V2WarningLevel = "NOTICE" | "WATCH" | "ALERT" | "EMERGENCY";
export type V2WarningStatus = "DETECTED" | "DEVELOPING" | "CONFIRMED" | "ESCALATED" | "RESOLVED";
export type V2DecisionState = "TRADE" | "WATCH" | "REJECT";
export type V2PlaybookId = "P1_TREND_PULLBACK" | "P4_COMPRESSION_BREAKOUT" | "P8_TRANSITION_DEFENSIVE";

export type V2Warning = {
  id: string;
  type: "spot_flow" | "oi_acceleration" | "funding_imbalance" | "breadth_shock" | "volume_anomaly" | "volatility_shift" | "breakout_failure" | "macro_risk" | "data_integrity";
  level: V2WarningLevel;
  status: V2WarningStatus;
  severity: number;
  confidence: number;
  relevance: number;
  timeframe: "global" | "asset";
  direction: "bullish" | "bearish" | "neutral";
  title: string;
  detail: string;
  impact: string;
};

export type V2TransitionComponents = {
  trendDeterioration: number;
  breadthDeterioration: number;
  flowDivergence: number;
  leverageStress: number;
  volatilityTransition: number;
  breakoutFailure: number;
  strategyHealthDeterioration: number;
};

export type V2MarketContext = {
  version: "sentinel-v2";
  observedAt: number;
  regime: V2RegimeKind;
  regimeLabel: string;
  confidence: number;
  stability: number;
  regimeScore: number;
  regimeMargin: number;
  transitionRisk: number;
  transitionVelocity: number;
  riskAcceleration: number;
  developingRegime: V2RegimeKind | null;
  permission: V2Permission;
  bias: "LONG" | "SHORT" | "NEUTRAL";
  breadth: {
    sampleSize: number;
    advancingRatio: number;
    decliningRatio: number;
    medianChangePct: number;
    bullishParticipation: number;
    bearishParticipation: number;
  };
  volatility: {
    dispersionPct: number;
    ivPercentile: number | null;
    state: "compressed" | "normal" | "expanding" | "extreme";
  };
  leverage: {
    crowdedRatio: number;
    averageFundingAbs: number;
    state: "healthy" | "building" | "crowded" | "extreme";
  };
  transition: V2TransitionComponents;
  warnings: V2Warning[];
  topDrivers: string[];
  dataIntegrity: {
    valid: boolean;
    universeSize: number;
    stale: boolean;
    reason: string | null;
  };
};

export type V2AssetInput = {
  symbol: string;
  observedAt: number;
  dataQuality: number;
  changePercentage: number | null;
  fundingRate: number | null;
  openInterestChangePct: number | null;
  spotCvdRatio: number | null;
  orderBookImbalance: number | null;
  liquidationImbalance: number | null;
  multiTimeframeTrend: number | null;
  volumeUsd: number;
};

export type V2PortfolioInput = {
  openTrades: { side: "LONG" | "SHORT"; symbol: string; entryThesis?: string | null; regime?: string | null }[];
  candidateSide: "LONG" | "SHORT";
  candidateSymbol: string;
};

export type V2Opportunity = {
  symbol: string;
  observedAt: number;
  playbook: V2PlaybookId;
  playbookLabel: string;
  side: "LONG" | "SHORT" | "WAIT";
  state: V2DecisionState;
  opportunityScore: number;
  environmentFit: number;
  playbookFit: number;
  structure: number;
  timing: number;
  confirmation: number;
  riskReward: number;
  portfolioImpact: number;
  riskMultiplier: number;
  waitingFor: string[];
  rejectReasons: string[];
  reasons: string[];
  maxRisk: string | null;
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

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function standardDeviation(values: number[]) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function warningLevel(severity: number, emergency = false): V2WarningLevel {
  if (emergency) return "EMERGENCY";
  if (severity >= 75) return "ALERT";
  if (severity >= 50) return "WATCH";
  return "NOTICE";
}

function warningStatus(severity: number): V2WarningStatus {
  if (severity >= 80) return "ESCALATED";
  if (severity >= 65) return "CONFIRMED";
  if (severity >= 45) return "DEVELOPING";
  return "DETECTED";
}

function makeWarning(input: Omit<V2Warning, "id" | "level" | "status"> & { emergency?: boolean }): V2Warning {
  const severity = Math.round(clamp(input.severity));
  const confidence = Math.round(clamp(input.confidence));
  const relevance = Math.round(clamp(input.relevance));
  return {
    ...input,
    severity,
    confidence,
    relevance,
    id: `${input.type}:${input.timeframe}:${input.direction}`,
    level: warningLevel(severity, input.emergency),
    status: input.emergency ? "ESCALATED" : warningStatus(severity),
  };
}

function permissionForRisk(transitionRisk: number, emergency: boolean): V2Permission {
  if (emergency || transitionRisk > 80) return "RED";
  if (transitionRisk > 60) return "ORANGE";
  if (transitionRisk > 40) return "YELLOW";
  if (transitionRisk > 25) return "BLUE";
  return "GREEN";
}

function permissionMultiplier(permission: V2Permission) {
  return permission === "GREEN" ? 1 : permission === "BLUE" ? 0.9 : permission === "YELLOW" ? 0.7 : permission === "ORANGE" ? 0.4 : 0;
}

function regimeScoreFromInputs(input: {
  benchmarkMomentum: number | null;
  advancingRatio: number;
  decliningRatio: number;
  medianChangePct: number;
  dispersionPct: number;
  ivPercentile: number | null;
  crowdedRatio: number;
}) {
  const benchmark = clamp(Math.abs(input.benchmarkMomentum ?? 0) / 7 * 100);
  const breadthDirectional = clamp(Math.abs(input.advancingRatio - input.decliningRatio) * 100);
  const medianDirectional = clamp(Math.abs(input.medianChangePct) / 5 * 100);
  const trendStrength = clamp(benchmark * 0.45 + breadthDirectional * 0.35 + medianDirectional * 0.2);
  const compression = clamp(100 - input.dispersionPct * 22 - (input.ivPercentile ?? 0.5) * 45);
  const expansion = clamp(input.dispersionPct * 17 + (input.ivPercentile ?? 0.5) * 42);
  const range = clamp((100 - trendStrength) * 0.65 + (100 - Math.min(100, expansion)) * 0.35);
  const leverage = clamp(input.crowdedRatio * 75 + Math.max(0, expansion - 65) * 0.4);
  const positive = (input.benchmarkMomentum ?? 0) >= 0;
  return {
    bull: positive ? trendStrength : trendStrength * 0.28,
    bear: positive ? trendStrength * 0.28 : trendStrength,
    range,
    compression,
    expansion,
    leverage,
  };
}

export function buildSentinelV2MarketContext(input: {
  observedAt: number;
  universe: UniverseTicker[];
  benchmarkMomentum: number | null;
  optionsIvPercentile: number | null;
  macroEventRisk: number | null;
  previous?: Pick<V2MarketContext, "observedAt" | "transitionRisk" | "transitionVelocity"> | null;
  strategyHealthDeterioration?: number;
}): V2MarketContext {
  const changes = input.universe.map((item) => item.changePercentage).filter(Number.isFinite);
  const advancing = changes.filter((value) => value > 0).length;
  const declining = changes.filter((value) => value < 0).length;
  const advancingRatio = changes.length ? advancing / changes.length : 0.5;
  const decliningRatio = changes.length ? declining / changes.length : 0.5;
  const medianChangePct = median(changes);
  const dispersionPct = standardDeviation(changes);
  const funding = input.universe.map((item) => Math.abs(item.fundingRate ?? 0)).filter(Number.isFinite);
  const crowded = input.universe.filter((item) => item.fundingRate != null && Math.abs(item.fundingRate) >= 0.0006).length;
  const crowdedRatio = input.universe.length ? crowded / input.universe.length : 0;
  const averageFundingAbs = mean(funding);

  const dataValid = input.universe.length >= 8 && changes.length >= Math.min(8, input.universe.length);
  const dataStale = input.observedAt <= 0;
  const benchmark = input.benchmarkMomentum ?? 0;
  const bullishParticipation = clamp(advancingRatio * 100);
  const bearishParticipation = clamp(decliningRatio * 100);

  const breadthDeterioration = benchmark > 0
    ? clamp((0.55 - advancingRatio) * 180 + Math.max(0, -medianChangePct) * 10)
    : benchmark < 0
      ? clamp((0.55 - decliningRatio) * 180 + Math.max(0, medianChangePct) * 10)
      : clamp(Math.abs(advancingRatio - 0.5) < 0.08 ? 20 : 35);
  const trendDeterioration = clamp(
    (Math.abs(benchmark) < 1 ? 38 : Math.abs(benchmark) < 2.5 ? 22 : 8)
    + (benchmark > 0 && medianChangePct < 0 ? 34 : 0)
    + (benchmark < 0 && medianChangePct > 0 ? 34 : 0),
  );
  const flowDivergence = clamp(
    (benchmark > 0 && advancingRatio < 0.45 ? 55 : 0)
    + (benchmark < 0 && decliningRatio < 0.45 ? 55 : 0)
    + (Math.abs(benchmark) >= 2 && Math.abs(medianChangePct) < 0.4 ? 25 : 0),
  );
  const leverageStress = clamp(crowdedRatio * 105 + averageFundingAbs / 0.001 * 25);
  const volatilityTransition = clamp(dispersionPct * 16 + (input.optionsIvPercentile ?? 0.5) * 35);
  const breakoutFailure = clamp(
    (Math.abs(benchmark) >= 2 && Math.abs(medianChangePct) < 0.5 ? 45 : 12)
    + (breadthDeterioration > 60 ? 22 : 0),
  );
  const strategyHealthDeterioration = clamp(input.strategyHealthDeterioration ?? 15);

  const components: V2TransitionComponents = {
    trendDeterioration: Math.round(trendDeterioration),
    breadthDeterioration: Math.round(breadthDeterioration),
    flowDivergence: Math.round(flowDivergence),
    leverageStress: Math.round(leverageStress),
    volatilityTransition: Math.round(volatilityTransition),
    breakoutFailure: Math.round(breakoutFailure),
    strategyHealthDeterioration: Math.round(strategyHealthDeterioration),
  };

  let transitionRisk =
    trendDeterioration * 0.20
    + breadthDeterioration * 0.18
    + flowDivergence * 0.17
    + leverageStress * 0.15
    + volatilityTransition * 0.12
    + breakoutFailure * 0.10
    + strategyHealthDeterioration * 0.08;
  const confluence = Object.values(components).filter((value) => value >= 60).length;
  if (confluence >= 4) transitionRisk += 15;
  else if (confluence === 3) transitionRisk += 10;
  else if (confluence === 2) transitionRisk += 5;
  if ((input.macroEventRisk ?? 0) >= 0.85) transitionRisk += 12;
  if (!dataValid) transitionRisk = Math.max(transitionRisk, 82);
  transitionRisk = Math.round(clamp(transitionRisk));

  const elapsedHours = input.previous ? Math.max((input.observedAt - input.previous.observedAt) / 3_600_000, 1 / 60) : 1;
  const transitionVelocity = input.previous ? clamp((transitionRisk - input.previous.transitionRisk) / elapsedHours, -100, 100) : 0;
  const riskAcceleration = input.previous ? clamp(transitionVelocity - input.previous.transitionVelocity, -100, 100) : 0;

  const scores = regimeScoreFromInputs({
    benchmarkMomentum: input.benchmarkMomentum,
    advancingRatio,
    decliningRatio,
    medianChangePct,
    dispersionPct,
    ivPercentile: input.optionsIvPercentile,
    crowdedRatio,
  });
  const ranked: { regime: Exclude<V2RegimeKind, "transition">; score: number }[] = [
    { regime: "bull_trend", score: scores.bull },
    { regime: "bear_trend", score: scores.bear },
    { regime: "range", score: scores.range },
    { regime: "compression", score: scores.compression },
    { regime: "expansion", score: scores.expansion },
    { regime: "leverage_liquidation", score: scores.leverage },
  ].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  const margin = clamp(best.score - second.score);
  const emergency = !dataValid || (input.macroEventRisk ?? 0) >= 0.98 || scores.leverage >= 88;
  const uncertain = best.score < 58 || margin < 8;
  const regime: V2RegimeKind = transitionRisk >= 61 && (uncertain || transitionVelocity >= 12)
    ? "transition"
    : scores.leverage >= 82
      ? "leverage_liquidation"
      : best.regime;
  const developingRegime = regime === "transition" ? best.regime : second.score >= 58 ? second.regime : null;
  const confidence = Math.round(clamp(best.score * 0.65 + margin * 0.25 + (dataValid ? 10 : 0)));
  const stability = Math.round(clamp(100 - transitionRisk * 0.72 - Math.max(0, transitionVelocity) * 0.4 + margin * 0.25));
  const permission = permissionForRisk(transitionRisk, emergency);
  const bias = regime === "bull_trend" ? "LONG" : regime === "bear_trend" ? "SHORT" : "NEUTRAL";

  const warnings: V2Warning[] = [];
  if (!dataValid) warnings.push(makeWarning({
    type: "data_integrity", severity: 100, confidence: 100, relevance: 100, timeframe: "global", direction: "neutral",
    title: "市场数据完整性不足", detail: `有效市场样本 ${changes.length}/${input.universe.length}`, impact: "禁止新增风险", emergency: true,
  }));
  if (breadthDeterioration >= 40) warnings.push(makeWarning({
    type: "breadth_shock", severity: breadthDeterioration, confidence: Math.min(95, 55 + changes.length), relevance: 95, timeframe: "global",
    direction: benchmark >= 0 ? "bearish" : "bullish", title: "市场广度正在偏离主趋势",
    detail: `上涨参与 ${(advancingRatio * 100).toFixed(0)}%，下跌参与 ${(decliningRatio * 100).toFixed(0)}%，中位涨跌 ${medianChangePct.toFixed(2)}%`,
    impact: "降低当前趋势稳定度并提高环境切换风险",
  }));
  if (leverageStress >= 45) warnings.push(makeWarning({
    type: "funding_imbalance", severity: leverageStress, confidence: 78, relevance: 82, timeframe: "global", direction: "neutral",
    title: "杠杆拥挤正在上升", detail: `拥挤合约占比 ${(crowdedRatio * 100).toFixed(0)}%，平均绝对资金费率 ${(averageFundingAbs * 100).toFixed(4)}%`,
    impact: "降低追价容忍度并提高清算风险",
  }));
  if (volatilityTransition >= 60) warnings.push(makeWarning({
    type: "volatility_shift", severity: volatilityTransition, confidence: 76, relevance: 80, timeframe: "global", direction: "neutral",
    title: "波动结构正在扩张", detail: `市场涨跌离散度 ${dispersionPct.toFixed(2)}%，IV分位 ${input.optionsIvPercentile == null ? "--" : `${Math.round(input.optionsIvPercentile * 100)}%`}`,
    impact: "缩小仓位并提高执行滑点警戒",
  }));
  if ((input.macroEventRisk ?? 0) >= 0.7) warnings.push(makeWarning({
    type: "macro_risk", severity: (input.macroEventRisk ?? 0) * 100, confidence: 100, relevance: 90, timeframe: "global", direction: "neutral",
    title: "高影响宏观事件窗口", detail: `宏观事件风险 ${Math.round((input.macroEventRisk ?? 0) * 100)}/100`, impact: "提高环境切换风险并限制新增仓位",
  }));

  const drivers = Object.entries(components)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key, value]) => `${key} ${Math.round(value)}`);

  return {
    version: "sentinel-v2",
    observedAt: input.observedAt,
    regime,
    regimeLabel: REGIME_LABELS[regime],
    confidence,
    stability,
    regimeScore: Math.round(best.score),
    regimeMargin: Math.round(margin),
    transitionRisk,
    transitionVelocity: Number(transitionVelocity.toFixed(2)),
    riskAcceleration: Number(riskAcceleration.toFixed(2)),
    developingRegime,
    permission,
    bias,
    breadth: {
      sampleSize: changes.length,
      advancingRatio: Number(advancingRatio.toFixed(4)),
      decliningRatio: Number(decliningRatio.toFixed(4)),
      medianChangePct: Number(medianChangePct.toFixed(4)),
      bullishParticipation: Math.round(bullishParticipation),
      bearishParticipation: Math.round(bearishParticipation),
    },
    volatility: {
      dispersionPct: Number(dispersionPct.toFixed(4)),
      ivPercentile: input.optionsIvPercentile,
      state: dispersionPct >= 5 || (input.optionsIvPercentile ?? 0) >= 0.9 ? "extreme" : dispersionPct >= 2.8 || (input.optionsIvPercentile ?? 0) >= 0.72 ? "expanding" : dispersionPct <= 1.1 && (input.optionsIvPercentile ?? 0.5) <= 0.4 ? "compressed" : "normal",
    },
    leverage: {
      crowdedRatio: Number(crowdedRatio.toFixed(4)),
      averageFundingAbs: Number(averageFundingAbs.toFixed(8)),
      state: leverageStress >= 80 ? "extreme" : leverageStress >= 60 ? "crowded" : leverageStress >= 35 ? "building" : "healthy",
    },
    transition: components,
    warnings: warnings.sort((a, b) => b.relevance * b.severity - a.relevance * a.severity),
    topDrivers: drivers,
    dataIntegrity: {
      valid: dataValid && !dataStale,
      universeSize: input.universe.length,
      stale: dataStale,
      reason: !dataValid ? "市场样本不足" : dataStale ? "市场时间戳无效" : null,
    },
  };
}

function assetEnvironmentFit(input: V2AssetInput, context: V2MarketContext, side: "LONG" | "SHORT") {
  const direction = side === "LONG" ? 1 : -1;
  const trend = (input.multiTimeframeTrend ?? 0) * direction;
  const marketBias = context.bias === side ? 1 : context.bias === "NEUTRAL" ? 0.45 : 0;
  return Math.round(clamp(42 + trend * 38 + marketBias * 20 - context.transitionRisk * 0.18));
}

function portfolioImpact(input: V2PortfolioInput) {
  const sameSide = input.openTrades.filter((trade) => trade.side === input.candidateSide).length;
  const sameBase = input.openTrades.filter((trade) => trade.symbol === input.candidateSymbol).length;
  const concentration = clamp(sameSide * 24 + sameBase * 65);
  return Math.round(clamp(100 - concentration));
}

export function evaluateSentinelV2Opportunity(input: {
  signal: ShadowStrategySignal;
  asset: V2AssetInput;
  market: V2MarketContext;
  portfolio: V2PortfolioInput;
}): V2Opportunity {
  const side = input.signal.side;
  const playbook: V2PlaybookId = input.signal.strategyId === "trend_pullback" ? "P1_TREND_PULLBACK" : "P4_COMPRESSION_BREAKOUT";
  const playbookLabel = playbook === "P1_TREND_PULLBACK" ? "P1 趋势回踩" : "P4 压缩突破";
  if (side === "WAIT") {
    return {
      symbol: input.asset.symbol, observedAt: input.asset.observedAt, playbook, playbookLabel, side: "WAIT", state: "WATCH",
      opportunityScore: 0, environmentFit: 0, playbookFit: 0, structure: 0, timing: 0, confirmation: 0, riskReward: 0, portfolioImpact: 100,
      riskMultiplier: 0, waitingFor: ["等待策略形成明确方向"], rejectReasons: [], reasons: [], maxRisk: null,
    };
  }

  const environmentFit = assetEnvironmentFit(input.asset, input.market, side);
  const regimeFit = playbook === "P1_TREND_PULLBACK"
    ? (input.market.regime === "bull_trend" || input.market.regime === "bear_trend" ? 92 : input.market.regime === "transition" ? 52 : 35)
    : (input.market.regime === "compression" ? 94 : input.market.regime === "expansion" ? 78 : input.market.regime === "transition" ? 48 : 42);
  const playbookFit = Math.round(clamp(regimeFit - Math.max(0, input.market.transitionRisk - 40) * 0.35));
  const structure = Math.round(clamp(45 + Math.abs(input.signal.score) * 45 + Math.abs(input.asset.multiTimeframeTrend ?? 0) * 10));
  const flowDirection = (input.asset.spotCvdRatio ?? 0) * (side === "LONG" ? 1 : -1);
  const oiDirection = (input.asset.openInterestChangePct ?? 0) * (side === "LONG" ? 1 : -1);
  const confirmation = Math.round(clamp(52 + flowDirection * 220 + Math.min(16, Math.max(-12, oiDirection * 2)) + input.asset.dataQuality * 20));
  const chasePenalty = Math.abs(input.asset.changePercentage ?? 0) > 9 ? 28 : Math.abs(input.asset.changePercentage ?? 0) > 6 ? 16 : 0;
  const timing = Math.round(clamp(70 - chasePenalty + (input.signal.entryPlan?.ready ? 16 : -12) - Math.max(0, input.market.transitionVelocity) * 0.25));
  const riskReward = input.signal.entryPlan?.riskReward ?? 0;
  const rrScore = clamp((riskReward - 1) * 52);
  const portfolioImpactScore = portfolioImpact(input.portfolio);
  const opportunityScore = Math.round(clamp(
    environmentFit * 0.23
    + playbookFit * 0.20
    + structure * 0.18
    + timing * 0.16
    + confirmation * 0.13
    + rrScore * 0.06
    + portfolioImpactScore * 0.04,
  ));

  const waitingFor: string[] = [];
  const rejectReasons: string[] = [];
  if (!input.market.dataIntegrity.valid) rejectReasons.push("DATA_UNSAFE");
  if (input.market.permission === "RED") rejectReasons.push("TRANSITION_HIGH");
  if (environmentFit < 45) rejectReasons.push("REGIME_CONFLICT");
  if (riskReward > 0 && riskReward < 1.5) rejectReasons.push("RR_LOW");
  if (portfolioImpactScore < 35) rejectReasons.push("PORTFOLIO_CONCENTRATION");
  if (chasePenalty >= 28) rejectReasons.push("CHASE_TOO_FAR");
  if (input.asset.fundingRate != null && Math.abs(input.asset.fundingRate) >= 0.001) rejectReasons.push("LEVERAGE_EXTREME");
  if (!input.signal.entryPlan?.ready) waitingFor.push("等待完整进场确认");
  if (confirmation < 62) waitingFor.push("等待现货/衍生品确认");
  if (input.market.permission === "ORANGE") waitingFor.push("环境切换风险较高，只接受 A+ 机会");
  if (playbook === "P4_COMPRESSION_BREAKOUT" && input.market.regime === "compression") waitingFor.push("等待突破站稳与量能确认");

  let state: V2DecisionState = "WATCH";
  if (rejectReasons.length) state = "REJECT";
  else {
    const requiredScore = input.market.permission === "ORANGE" ? 88 : input.market.permission === "YELLOW" ? 82 : input.market.permission === "BLUE" ? 78 : 74;
    if (input.signal.state === "ready" && opportunityScore >= requiredScore && confirmation >= 62 && timing >= 62) state = "TRADE";
  }

  const qualityMultiplier = opportunityScore >= 90 ? 1 : opportunityScore >= 84 ? 0.85 : opportunityScore >= 78 ? 0.7 : 0.55;
  const volatilityMultiplier = input.market.volatility.state === "extreme" ? 0.35 : input.market.volatility.state === "expanding" ? 0.65 : 1;
  const portfolioMultiplier = portfolioImpactScore < 45 ? 0.4 : portfolioImpactScore < 70 ? 0.75 : 1;
  const riskMultiplier = state === "TRADE"
    ? Number(clamp(permissionMultiplier(input.market.permission) * qualityMultiplier * volatilityMultiplier * portfolioMultiplier, 0, 1).toFixed(3))
    : 0;

  const reasons = [
    `${playbookLabel}环境适配 ${environmentFit}`,
    `结构质量 ${structure}，确认质量 ${confirmation}，时机 ${timing}`,
    `市场 ${input.market.regimeLabel} / Transition ${input.market.transitionRisk}`,
  ];
  const maxRisk = input.market.warnings[0]?.title ?? (input.market.transitionRisk >= 40 ? "环境稳定度下降" : null);

  return {
    symbol: input.asset.symbol,
    observedAt: input.asset.observedAt,
    playbook,
    playbookLabel,
    side,
    state,
    opportunityScore,
    environmentFit,
    playbookFit,
    structure,
    timing,
    confirmation,
    riskReward,
    portfolioImpact: portfolioImpactScore,
    riskMultiplier,
    waitingFor,
    rejectReasons,
    reasons,
    maxRisk,
  };
}

export function v2DecisionMetric(opportunity: V2Opportunity) {
  return {
    key: "v2-risk-multiplier",
    label: "V2 风险倍率",
    score: opportunity.riskMultiplier,
    detail: `${opportunity.playbookLabel} · ${opportunity.state} · 风险倍率 ${(opportunity.riskMultiplier * 100).toFixed(0)}%`,
    available: true,
    category: "derivatives" as const,
  };
}

export function v2PermissionLabel(permission: V2Permission) {
  return permission === "GREEN" ? "正常交易"
    : permission === "BLUE" ? "避免追价"
      : permission === "YELLOW" ? "提高门槛"
        : permission === "ORANGE" ? "只做最强机会"
          : "停止新增风险";
}
