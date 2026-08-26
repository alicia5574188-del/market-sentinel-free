import type { SignalMetric } from "./signal-engine.ts";
import type { EntryCheck, EntryPlan, ExitRule, TradeSide } from "./trade-lifecycle.ts";

export type SentinelRegime =
  | "bull_trend"
  | "bear_trend"
  | "range"
  | "compression"
  | "expansion"
  | "leverage_liquidation"
  | "transition";

export type TradingPermission = "GREEN" | "BLUE" | "YELLOW" | "ORANGE" | "RED";
export type V2DecisionState = "TRADE" | "WATCH" | "REJECT";
export type V2PlaybookId = "trend_pullback" | "compression_breakout" | "transition_defensive";
export type WarningStatus = "DETECTED" | "DEVELOPING" | "CONFIRMED" | "ESCALATED" | "RESOLVED";

export type MarketBreadth = {
  sampleSize: number;
  advanceRatio: number;
  declineRatio: number;
  strongAdvanceRatio: number;
  strongDeclineRatio: number;
  averageChangePct: number;
};

export type SentinelV2Input = {
  symbol: string;
  observedAt: number;
  futuresPrice: number;
  volumeUsd: number;
  changePercentage: number | null;
  fundingRate: number | null;
  openInterestChangePct: number | null;
  spotCvdRatio: number | null;
  orderBookImbalance: number | null;
  liquidationImbalance: number | null;
  multiTimeframeTrend: number | null;
  benchmarkMomentum: number | null;
  macroEventRisk: number | null;
  dataQuality: number;
  candles5m: Candle[];
  breadth: MarketBreadth | null;
  previousContext?: SentinelMarketContext | null;
};

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type TransitionComponents = {
  trendDeterioration: number;
  breadthDeterioration: number;
  flowDivergence: number;
  leverageStress: number;
  volatilityTransition: number;
  breakoutFailure: number;
  strategyHealthDeterioration: number;
};

export type RegimeScores = {
  bullTrend: number;
  bearTrend: number;
  range: number;
  compression: number;
  expansion: number;
  leverageLiquidation: number;
};

export type SentinelWarning = {
  id: string;
  type: "spot_flow" | "oi_acceleration" | "funding_imbalance" | "breadth_shock" | "volume_anomaly" | "volatility_shift" | "breakout_failure";
  label: string;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  severity: number;
  confidence: number;
  timeframe: "5m" | "15m" | "1h" | "market";
  persistence: number;
  velocity: number;
  relevance: number;
  status: WarningStatus;
  detail: string;
};

export type SentinelMarketContext = {
  symbol: string;
  observedAt: number;
  regime: SentinelRegime;
  regimeLabel: string;
  confidence: number;
  stability: number;
  transitionRisk: number;
  riskVelocity: number;
  riskAcceleration: number;
  permission: TradingPermission;
  developingRegime: SentinelRegime | null;
  directionBias: "LONG" | "SHORT" | "NEUTRAL";
  regimeMargin: number;
  scores: RegimeScores;
  transition: TransitionComponents;
  warnings: SentinelWarning[];
  reasons: string[];
};

export type SentinelOpportunity = {
  id: string;
  symbol: string;
  observedAt: number;
  playbookId: V2PlaybookId;
  playbookLabel: string;
  state: V2DecisionState;
  side: TradeSide | "WAIT";
  score: number;
  confidence: number;
  environmentFit: number;
  structureScore: number;
  timingScore: number;
  confirmationScore: number;
  riskRewardScore: number;
  portfolioImpact: number;
  thesis: string;
  reasons: string[];
  waitingFor: string[];
  rejectReasons: string[];
  entryPlan: EntryPlan | null;
  metrics: SignalMetric[];
};

export type SentinelV2Evaluation = {
  context: SentinelMarketContext;
  opportunities: SentinelOpportunity[];
  primaryOpportunity: SentinelOpportunity | null;
};

const FIVE_MINUTES = 5 * 60_000;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function ema(values: number[], period: number) {
  if (!values.length) return null;
  const alpha = 2 / (period + 1);
  let result = values[0];
  for (let index = 1; index < values.length; index += 1) result = values[index] * alpha + result * (1 - alpha);
  return result;
}

function atr(candles: Candle[], period = 14) {
  if (candles.length <= period) return null;
  const ranges = candles.slice(1).map((candle, index) => Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - candles[index].close),
    Math.abs(candle.low - candles[index].close),
  ));
  return mean(ranges.slice(-period));
}

function rsi(values: number[], period = 14) {
  if (values.length <= period) return null;
  const changes = values.slice(1).map((value, index) => value - values[index]);
  const window = changes.slice(-period);
  const gains = mean(window.map((change) => Math.max(change, 0)));
  const losses = mean(window.map((change) => Math.max(-change, 0)));
  if (losses === 0) return gains === 0 ? 50 : 100;
  return 100 - 100 / (1 + gains / losses);
}

function candleMs(value: number) {
  return value > 10_000_000_000 ? value : value * 1000;
}

function completedCandles(input: SentinelV2Input) {
  return input.candles5m
    .filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
    .filter((candle) => candleMs(candle.time) + FIVE_MINUTES <= input.observedAt)
    .sort((a, b) => a.time - b.time);
}

function volumeRatio(candles: Candle[]) {
  if (candles.length < 22) return null;
  const previous = candles.slice(-21, -1).map((item) => item.volume);
  return candles.at(-1)!.volume / Math.max(mean(previous), Number.EPSILON);
}

function rangeWidth(candles: Candle[], lookback = 24) {
  const window = candles.slice(-lookback);
  const close = window.at(-1)?.close ?? 0;
  if (window.length < 12 || close <= 0) return null;
  return (Math.max(...window.map((item) => item.high)) - Math.min(...window.map((item) => item.low))) / close * 100;
}

function compressionRatio(candles: Candle[]) {
  if (candles.length < 48) return null;
  const recent = atr(candles.slice(-22), 10);
  const prior = atr(candles.slice(-48, -16), 14);
  if (recent == null || prior == null || prior <= 0) return null;
  return recent / prior;
}

function efficiency(candles: Candle[], lookback = 18) {
  const window = candles.slice(-lookback);
  if (window.length < 5) return 0;
  const net = Math.abs(window.at(-1)!.close - window[0].close);
  const path = window.slice(1).reduce((sum, candle, index) => sum + Math.abs(candle.close - window[index].close), 0);
  return path <= 0 ? 0 : clamp(net / path, 0, 1);
}

function wickRejectionScore(candles: Candle[]) {
  const window = candles.slice(-8);
  if (!window.length) return 0;
  return clamp(mean(window.map((candle) => {
    const range = Math.max(candle.high - candle.low, Number.EPSILON);
    const body = Math.abs(candle.close - candle.open);
    return 1 - body / range;
  })) * 100, 0, 100);
}

function label(regime: SentinelRegime) {
  switch (regime) {
    case "bull_trend": return "上涨趋势";
    case "bear_trend": return "下跌趋势";
    case "range": return "震荡";
    case "compression": return "波动压缩";
    case "expansion": return "波动扩张";
    case "leverage_liquidation": return "杠杆/清算";
    case "transition": return "环境切换期";
  }
}

function permissionFor(risk: number, macroRisk: number, dataQuality: number): TradingPermission {
  if (dataQuality < 0.58 || macroRisk >= 0.92 || risk > 80) return "RED";
  if (risk > 60) return "ORANGE";
  if (risk > 40) return "YELLOW";
  if (risk > 25) return "BLUE";
  return "GREEN";
}

function makeWarning(options: Omit<SentinelWarning, "id" | "status">): SentinelWarning {
  const status: WarningStatus = options.severity >= 80 && options.confidence >= 70
    ? "ESCALATED"
    : options.severity >= 65
      ? "CONFIRMED"
      : options.severity >= 45
        ? "DEVELOPING"
        : "DETECTED";
  return {
    ...options,
    id: `${options.type}:${options.timeframe}`,
    status,
  };
}

function marketContext(input: SentinelV2Input, candles: Candle[]): SentinelMarketContext {
  const closes = candles.map((item) => item.close);
  const fast = ema(closes.slice(-50), 9);
  const slow = ema(closes.slice(-60), 21);
  const currentAtr = atr(candles);
  const atrPct = currentAtr != null && input.futuresPrice > 0 ? currentAtr / input.futuresPrice * 100 : null;
  const comp = compressionRatio(candles);
  const width = rangeWidth(candles);
  const volRatio = volumeRatio(candles);
  const trend = clamp(input.multiTimeframeTrend ?? 0, -1, 1);
  const recentReturn = closes.length >= 13 ? (closes.at(-1)! / closes.at(-13)! - 1) * 100 : 0;
  const trendEfficiency = efficiency(candles);
  const emaDirection = fast != null && slow != null ? clamp((fast / slow - 1) * 400, -1, 1) : 0;
  const structureDirection = clamp(trend * 0.72 + emaDirection * 0.28, -1, 1);
  const flowDirection = clamp((input.spotCvdRatio ?? 0) * 4 + (input.orderBookImbalance ?? 0) * 1.4, -1, 1);
  const breadthDirection = input.breadth == null
    ? 0
    : clamp((input.breadth.advanceRatio - input.breadth.declineRatio) * 1.3 + (input.breadth.strongAdvanceRatio - input.breadth.strongDeclineRatio) * 0.8, -1, 1);
  const momentumDirection = clamp(recentReturn / Math.max((atrPct ?? 0.8) * 3.2, 1.2), -1, 1);
  const leverageStress = clamp(
    Math.abs(input.openInterestChangePct ?? 0) / 7 * 50
      + Math.abs(input.fundingRate ?? 0) / 0.001 * 28
      + Math.abs(input.liquidationImbalance ?? 0) * 22,
    0,
    100,
  );
  const volatilityExpansion = clamp(
    ((comp ?? 1) - 0.95) * 130
      + Math.max(0, (volRatio ?? 1) - 1) * 45
      + Math.max(0, (atrPct ?? 0.5) - 1.5) * 18,
    0,
    100,
  );
  const compression = clamp(
    (comp == null ? 0 : (0.95 - comp) * 150)
      + (width == null ? 0 : (3.5 - width) * 10),
    0,
    100,
  );

  const bullTrend = clamp(
    Math.max(0, structureDirection) * 32
      + Math.max(0, momentumDirection) * 20
      + Math.max(0, breadthDirection) * 18
      + Math.max(0, flowDirection) * 15
      + trendEfficiency * 10
      + (leverageStress < 55 ? 5 : 0),
    0,
    100,
  );
  const bearTrend = clamp(
    Math.max(0, -structureDirection) * 32
      + Math.max(0, -momentumDirection) * 20
      + Math.max(0, -breadthDirection) * 18
      + Math.max(0, -flowDirection) * 15
      + trendEfficiency * 10
      + (leverageStress < 55 ? 5 : 0),
    0,
    100,
  );
  const range = clamp(
    (1 - Math.abs(structureDirection)) * 32
      + (1 - trendEfficiency) * 26
      + clamp(wickRejectionScore(candles) / 100, 0, 1) * 18
      + (width != null && width <= 5.5 ? 14 : 0)
      + (volatilityExpansion < 45 ? 10 : 0),
    0,
    100,
  );
  const expansion = clamp(volatilityExpansion * 0.7 + Math.abs(momentumDirection) * 20 + Math.abs(flowDirection) * 10, 0, 100);
  const leverageLiquidation = clamp(leverageStress * 0.82 + Math.max(0, (atrPct ?? 0) - 2.5) * 8, 0, 100);

  const scores: RegimeScores = {
    bullTrend: Number(bullTrend.toFixed(1)),
    bearTrend: Number(bearTrend.toFixed(1)),
    range: Number(range.toFixed(1)),
    compression: Number(compression.toFixed(1)),
    expansion: Number(expansion.toFixed(1)),
    leverageLiquidation: Number(leverageLiquidation.toFixed(1)),
  };

  const directionSign = bullTrend >= bearTrend ? 1 : -1;
  const directionScore = directionSign > 0 ? bullTrend : bearTrend;
  const breadthDeterioration = input.breadth == null ? 20 : clamp(
    directionSign > 0
      ? (0.56 - input.breadth.advanceRatio) * 160 + input.breadth.strongDeclineRatio * 50
      : (0.56 - input.breadth.declineRatio) * 160 + input.breadth.strongAdvanceRatio * 50,
    0,
    100,
  );
  const flowDivergence = clamp(
    directionSign > 0
      ? Math.max(0, -flowDirection) * 85 + Math.max(0, momentumDirection - flowDirection) * 25
      : Math.max(0, flowDirection) * 85 + Math.max(0, -momentumDirection + flowDirection) * 25,
    0,
    100,
  );
  const trendDeterioration = clamp(
    (65 - directionScore) * 1.25
      + (1 - trendEfficiency) * 22
      + Math.max(0, wickRejectionScore(candles) - 58) * 0.55,
    0,
    100,
  );
  const breakoutFailure = clamp(
    wickRejectionScore(candles) * 0.55
      + (trendEfficiency < 0.28 ? 25 : 0)
      + ((volRatio ?? 1) > 1.25 && Math.abs(recentReturn) < (atrPct ?? 0.8) * 0.8 ? 20 : 0),
    0,
    100,
  );
  const volatilityTransition = clamp(Math.max(compression, expansion) * 0.78 + Math.abs((comp ?? 1) - 1) * 30, 0, 100);
  const transition: TransitionComponents = {
    trendDeterioration: Number(trendDeterioration.toFixed(1)),
    breadthDeterioration: Number(breadthDeterioration.toFixed(1)),
    flowDivergence: Number(flowDivergence.toFixed(1)),
    leverageStress: Number(leverageStress.toFixed(1)),
    volatilityTransition: Number(volatilityTransition.toFixed(1)),
    breakoutFailure: Number(breakoutFailure.toFixed(1)),
    strategyHealthDeterioration: 0,
  };

  let transitionRisk =
    trendDeterioration * 0.20
    + breadthDeterioration * 0.18
    + flowDivergence * 0.17
    + leverageStress * 0.15
    + volatilityTransition * 0.12
    + breakoutFailure * 0.10;
  const hotComponents = Object.values(transition).filter((value) => value >= 60).length;
  transitionRisk += hotComponents >= 4 ? 15 : hotComponents === 3 ? 10 : hotComponents === 2 ? 5 : 0;
  if (input.dataQuality < 0.68) transitionRisk += (0.68 - input.dataQuality) * 80;
  if ((input.macroEventRisk ?? 0) >= 0.85) transitionRisk += 18;
  transitionRisk = clamp(transitionRisk, 0, 100);

  const ranked = [
    ["bull_trend", bullTrend],
    ["bear_trend", bearTrend],
    ["range", range],
    ["compression", compression],
    ["expansion", expansion],
    ["leverage_liquidation", leverageLiquidation],
  ] as const;
  const sorted = [...ranked].sort((a, b) => b[1] - a[1]);
  const best = sorted[0];
  const second = sorted[1];
  const margin = best[1] - second[1];
  const previous = input.previousContext;
  let regime = best[0] as SentinelRegime;
  if (leverageLiquidation >= 75) {
    regime = "leverage_liquidation";
  } else if (previous && previous.regime !== "transition") {
    const previousKey = previous.regime === "bull_trend" ? "bullTrend"
      : previous.regime === "bear_trend" ? "bearTrend"
        : previous.regime === "range" ? "range"
          : previous.regime === "compression" ? "compression"
            : previous.regime === "expansion" ? "expansion"
              : "leverageLiquidation";
    const previousScore = scores[previousKey];
    if (previousScore >= 58 && best[1] < 78) regime = previous.regime;
    else if (previousScore < 58 && best[1] < 70) regime = "transition";
  }
  if (transitionRisk >= 62 && best[1] < 74 && leverageLiquidation < 75) regime = "transition";
  if (margin < 7 && best[1] < 76 && transitionRisk >= 45) regime = "transition";

  const elapsedHours = previous ? Math.max((input.observedAt - previous.observedAt) / 3_600_000, 1 / 12) : 1;
  const rawVelocity = previous ? (transitionRisk - previous.transitionRisk) / elapsedHours : 0;
  const riskVelocity = clamp(rawVelocity, -40, 40);
  const previousVelocity = previous?.riskVelocity ?? 0;
  const riskAcceleration = clamp((riskVelocity - previousVelocity) / elapsedHours, -60, 60);
  const confidence = clamp(best[1] * 0.68 + Math.max(0, margin) * 0.7 + Math.min(candles.length / 60, 1) * 12, 30, 96);
  const stability = clamp(100 - transitionRisk * 0.68 - Math.max(0, riskVelocity) * 0.45 + margin * 0.28, 5, 98);
  const permission = permissionFor(transitionRisk, input.macroEventRisk ?? 0, input.dataQuality);
  const directionBias = bullTrend - bearTrend > 10 ? "LONG" : bearTrend - bullTrend > 10 ? "SHORT" : "NEUTRAL";
  const developing = regime === "transition" ? best[0] as SentinelRegime : second[1] >= 60 ? second[0] as SentinelRegime : null;

  const warnings: SentinelWarning[] = [];
  if (flowDivergence >= 35) warnings.push(makeWarning({ type: "spot_flow", label: "现货流背离", direction: directionSign > 0 ? "BEARISH" : "BULLISH", severity: flowDivergence, confidence: clamp(55 + Math.abs(flowDirection) * 35, 45, 92), timeframe: "15m", persistence: 1, velocity: Math.abs(flowDirection) * 100, relevance: 90, detail: `价格方向与 Spot CVD/盘口支持度出现偏离，风险分 ${flowDivergence.toFixed(0)}` }));
  if (Math.abs(input.openInterestChangePct ?? 0) >= 2.5) warnings.push(makeWarning({ type: "oi_acceleration", label: "OI 加速", direction: "NEUTRAL", severity: clamp(Math.abs(input.openInterestChangePct ?? 0) / 6 * 100, 35, 100), confidence: 78, timeframe: "15m", persistence: 1, velocity: Math.abs(input.openInterestChangePct ?? 0), relevance: 82, detail: `OI 变化 ${input.openInterestChangePct?.toFixed(2)}%，需结合现货流判断是否为杠杆推动` }));
  if (Math.abs(input.fundingRate ?? 0) >= 0.00055) warnings.push(makeWarning({ type: "funding_imbalance", label: "资金费率拥挤", direction: (input.fundingRate ?? 0) > 0 ? "BEARISH" : "BULLISH", severity: clamp(Math.abs(input.fundingRate ?? 0) / 0.001 * 100, 35, 100), confidence: 82, timeframe: "market", persistence: 1, velocity: Math.abs(input.fundingRate ?? 0) * 100_000, relevance: 86, detail: `资金费率 ${((input.fundingRate ?? 0) * 100).toFixed(4)}%，拥挤风险上升` }));
  if (breadthDeterioration >= 35) warnings.push(makeWarning({ type: "breadth_shock", label: "市场广度恶化", direction: directionSign > 0 ? "BEARISH" : "BULLISH", severity: breadthDeterioration, confidence: input.breadth && input.breadth.sampleSize >= 20 ? 86 : 62, timeframe: "market", persistence: 1, velocity: Math.abs((input.breadth?.advanceRatio ?? 0.5) - 0.5) * 100, relevance: 94, detail: input.breadth ? `上涨 ${(input.breadth.advanceRatio * 100).toFixed(0)}% / 下跌 ${(input.breadth.declineRatio * 100).toFixed(0)}%，内部参与度与主方向出现矛盾` : "市场广度样本不足" }));
  if ((volRatio ?? 1) >= 1.7) warnings.push(makeWarning({ type: "volume_anomaly", label: "成交量异常", direction: recentReturn > 0 ? "BULLISH" : recentReturn < 0 ? "BEARISH" : "NEUTRAL", severity: clamp(((volRatio ?? 1) - 1) / 1.5 * 100, 35, 100), confidence: 76, timeframe: "5m", persistence: 1, velocity: volRatio ?? 0, relevance: 68, detail: `完整 5m 成交量为前 20 根均值的 ${(volRatio ?? 0).toFixed(2)}×` }));
  if (volatilityTransition >= 45) warnings.push(makeWarning({ type: "volatility_shift", label: compression > expansion ? "波动压缩加深" : "波动开始扩张", direction: "NEUTRAL", severity: volatilityTransition, confidence: 80, timeframe: "15m", persistence: 1, velocity: Math.abs((comp ?? 1) - 1) * 100, relevance: 84, detail: `ATR 状态比 ${(comp ?? 1).toFixed(2)}，Compression ${compression.toFixed(0)} / Expansion ${expansion.toFixed(0)}` }));
  if (breakoutFailure >= 48) warnings.push(makeWarning({ type: "breakout_failure", label: "突破接受度下降", direction: "NEUTRAL", severity: breakoutFailure, confidence: 68, timeframe: "1h", persistence: 1, velocity: wickRejectionScore(candles), relevance: 76, detail: `近期影线/低效率走势增加，突破失败风险 ${breakoutFailure.toFixed(0)}` }));

  const reasons = [
    `结构 ${structureDirection >= 0 ? "+" : ""}${(structureDirection * 100).toFixed(0)}`,
    `资金流 ${flowDirection >= 0 ? "+" : ""}${(flowDirection * 100).toFixed(0)}`,
    `市场广度 ${breadthDirection >= 0 ? "+" : ""}${(breadthDirection * 100).toFixed(0)}`,
    `Transition ${transitionRisk.toFixed(0)}${riskVelocity > 5 ? " 快速上升" : riskVelocity < -5 ? " 回落" : ""}`,
  ];

  return {
    symbol: input.symbol,
    observedAt: input.observedAt,
    regime,
    regimeLabel: label(regime),
    confidence: Math.round(confidence),
    stability: Math.round(stability),
    transitionRisk: Math.round(transitionRisk),
    riskVelocity: Number(riskVelocity.toFixed(1)),
    riskAcceleration: Number(riskAcceleration.toFixed(1)),
    permission,
    developingRegime: developing,
    directionBias,
    regimeMargin: Number(margin.toFixed(1)),
    scores,
    transition,
    warnings: warnings.sort((a, b) => b.relevance * b.severity - a.relevance * a.severity).slice(0, 7),
    reasons,
  };
}

function defaultExitRules(side: TradeSide, stop: number, tp1: number, tp2: number, timeout: number): ExitRule[] {
  return [
    { code: "stop_loss", label: "结构止损", condition: `${side === "LONG" ? "价格 ≤" : "价格 ≥"} ${stop}` },
    { code: "breakeven", label: "第一目标保护", condition: `到达 ${tp1} 后把保护位推进到不亏损区域` },
    { code: "take_profit", label: "第二目标", condition: `到达 ${tp2} 完成主要退出` },
    { code: "structure_reversal", label: "交易逻辑失效", condition: "结构与资金流同时反向，Thesis Health 应下降" },
    { code: "flow_reversal", label: "环境风险升级", condition: "Transition Risk 明显升级时禁止加仓并提高利润保护" },
    { code: "timeout", label: "时间止损", condition: `${timeout} 分钟内未按 Playbook 预期发展则退出` },
  ];
}

function buildPlan(input: SentinelV2Input, candles: Candle[], options: {
  side: TradeSide;
  stopLossPrice: number;
  tp2R: number;
  maxHoldingMinutes: number;
  checks: EntryCheck[];
  zoneAtr?: number;
}) {
  const currentAtr = atr(candles);
  if (currentAtr == null || input.futuresPrice <= 0 || options.stopLossPrice <= 0) return null;
  const risk = Math.abs(input.futuresPrice - options.stopLossPrice);
  const riskPct = risk / input.futuresPrice * 100;
  if (risk <= 0 || riskPct > 6) return null;
  const direction = options.side === "LONG" ? 1 : -1;
  const tp1 = input.futuresPrice + direction * risk;
  const tp2 = input.futuresPrice + direction * risk * options.tp2R;
  const zone = currentAtr * (options.zoneAtr ?? 0.16);
  const checks = [...options.checks, {
    key: "risk-distance",
    label: "结构止损距离",
    passed: riskPct <= 6,
    required: true,
    detail: `${riskPct.toFixed(2)}% / 上限 6.00%`,
  }];
  return {
    ready: checks.every((check) => !check.required || check.passed),
    side: options.side,
    entryPrice: input.futuresPrice,
    entryZone: [input.futuresPrice - zone, input.futuresPrice + zone] as [number, number],
    stopLossPrice: options.stopLossPrice,
    takeProfit1Price: tp1,
    takeProfit2Price: tp2,
    riskPerUnit: risk,
    plannedRiskPct: riskPct,
    riskReward: options.tp2R,
    maxHoldingMinutes: options.maxHoldingMinutes,
    checks,
    exitRules: defaultExitRules(options.side, options.stopLossPrice, tp1, tp2, options.maxHoldingMinutes),
  } satisfies EntryPlan;
}

function permissionMultiplier(permission: TradingPermission) {
  return permission === "GREEN" ? 1 : permission === "BLUE" ? 0.9 : permission === "YELLOW" ? 0.7 : permission === "ORANGE" ? 0.4 : 0;
}

function commonMetrics(input: SentinelV2Input, context: SentinelMarketContext): SignalMetric[] {
  return [
    { key: "regime-fit", label: "市场环境", score: context.directionBias === "LONG" ? context.confidence / 100 : context.directionBias === "SHORT" ? -context.confidence / 100 : 0, detail: `${context.regimeLabel} · 置信 ${context.confidence} · 稳定 ${context.stability}`, available: true, category: "cross" },
    { key: "transition-risk", label: "环境切换风险", score: -(context.transitionRisk / 100), detail: `${context.transitionRisk}/100 · ${context.permission} · 速度 ${context.riskVelocity >= 0 ? "+" : ""}${context.riskVelocity}/h`, available: true, category: "events" },
    { key: "breadth", label: "市场广度", score: input.breadth == null ? 0 : input.breadth.advanceRatio - input.breadth.declineRatio, detail: input.breadth == null ? "广度样本不足" : `上涨 ${(input.breadth.advanceRatio * 100).toFixed(0)}% / 下跌 ${(input.breadth.declineRatio * 100).toFixed(0)}%`, available: input.breadth != null, category: "cross" },
    { key: "spot-flow", label: "Spot CVD", score: clamp((input.spotCvdRatio ?? 0) * 2.2, -1, 1), detail: input.spotCvdRatio == null ? "不可用" : `${(input.spotCvdRatio * 100).toFixed(1)}%`, available: input.spotCvdRatio != null, category: "spot" },
    { key: "leverage", label: "杠杆结构", score: -(context.transition.leverageStress / 100), detail: `OI ${input.openInterestChangePct == null ? "--" : `${input.openInterestChangePct.toFixed(2)}%`} · Funding ${input.fundingRate == null ? "--" : `${(input.fundingRate * 100).toFixed(4)}%`}`, available: input.openInterestChangePct != null || input.fundingRate != null, category: "derivatives" },
  ];
}

function trendPullback(input: SentinelV2Input, candles: Candle[], context: SentinelMarketContext): SentinelOpportunity {
  const closes = candles.map((item) => item.close);
  const fast = ema(closes.slice(-45), 9);
  const slow = ema(closes.slice(-55), 21);
  const currentAtr = atr(candles);
  const latest = candles.at(-1) ?? null;
  const previous = candles.at(-2) ?? null;
  const rsi14 = rsi(closes);
  const volRatio = volumeRatio(candles);
  const direction = context.directionBias === "SHORT" ? -1 : 1;
  const side: TradeSide = direction > 0 ? "LONG" : "SHORT";
  const regimeAligned = side === "LONG" ? context.regime === "bull_trend" : context.regime === "bear_trend";
  const nearFast = currentAtr != null && fast != null ? Math.abs(input.futuresPrice - fast) / currentAtr <= 0.9 : false;
  const resumed = latest != null && previous != null && fast != null && slow != null && (side === "LONG"
    ? fast > slow && latest.close >= fast && latest.close > latest.open && latest.close > previous.close
    : fast < slow && latest.close <= fast && latest.close < latest.open && latest.close < previous.close);
  const healthyRsi = rsi14 != null && (side === "LONG" ? rsi14 >= 44 && rsi14 <= 69 : rsi14 >= 31 && rsi14 <= 56);
  const flowAligned = input.spotCvdRatio != null && input.spotCvdRatio * direction >= 0.008;
  const volumeHealthy = volRatio != null && volRatio >= 0.68;
  const permissionAllows = ["GREEN", "BLUE", "YELLOW"].includes(context.permission);
  const checks: EntryCheck[] = [
    { key: "regime", label: "环境适配", passed: regimeAligned, required: true, detail: `${context.regimeLabel} / ${context.permission}` },
    { key: "permission", label: "交易许可", passed: permissionAllows, required: true, detail: context.permission },
    { key: "pullback", label: "回踩位置", passed: nearFast, required: true, detail: nearFast ? "价格回到 EMA9/ATR 合理区域" : "离回踩区域过远，禁止追价" },
    { key: "resume", label: "完整 K 线恢复", passed: resumed, required: true, detail: resumed ? "完整 5m K 线重新顺趋势" : "等待完整 K 线重新顺趋势" },
    { key: "momentum", label: "动量不过热", passed: healthyRsi, required: true, detail: `RSI14 ${rsi14 == null ? "--" : rsi14.toFixed(1)}` },
    { key: "flow", label: "现货流确认", passed: flowAligned, required: true, detail: input.spotCvdRatio == null ? "缺失" : `${(input.spotCvdRatio * 100).toFixed(1)}%` },
    { key: "volume", label: "量能健康", passed: volumeHealthy, required: true, detail: volRatio == null ? "--" : `${volRatio.toFixed(2)}×` },
  ];
  const swing = candles.slice(-10);
  const stop = swing.length && currentAtr != null
    ? side === "LONG" ? Math.min(...swing.map((item) => item.low)) - currentAtr * 0.10 : Math.max(...swing.map((item) => item.high)) + currentAtr * 0.10
    : 0;
  const plan = buildPlan(input, candles, { side, stopLossPrice: stop, tp2R: 2.2, maxHoldingMinutes: 180, checks });
  const requiredPassed = checks.filter((check) => check.required && check.passed).length;
  const environmentFit = clamp((regimeAligned ? 55 : 10) + context.confidence * 0.32 + context.stability * 0.13 - context.transitionRisk * 0.18, 0, 100);
  const structureScore = clamp((regimeAligned ? 35 : 5) + (nearFast ? 30 : 0) + (resumed ? 35 : 0), 0, 100);
  const timingScore = clamp((nearFast ? 45 : 10) + (healthyRsi ? 30 : 0) + (resumed ? 25 : 0), 0, 100);
  const confirmationScore = clamp((flowAligned ? 42 : 8) + (volumeHealthy ? 28 : 5) + requiredPassed / checks.length * 30, 0, 100);
  const riskRewardScore = plan ? clamp(plan.riskReward / 2.2 * 100, 0, 100) : 0;
  const score = clamp(environmentFit * 0.28 + structureScore * 0.24 + timingScore * 0.20 + confirmationScore * 0.18 + riskRewardScore * 0.10, 0, 100);
  const rejectReasons: string[] = [];
  if (input.dataQuality < 0.70) rejectReasons.push("DATA_UNSAFE");
  if (context.permission === "RED") rejectReasons.push("TRANSITION_RED");
  if (context.permission === "ORANGE") rejectReasons.push("TRANSITION_HIGH");
  if (plan && plan.riskReward < 1.8) rejectReasons.push("RR_LOW");
  const waitingFor = checks.filter((check) => check.required && !check.passed).map((check) => check.label);
  const state: V2DecisionState = rejectReasons.length ? "REJECT" : plan?.ready && score >= (context.permission === "YELLOW" ? 82 : 75) ? "TRADE" : "WATCH";
  return {
    id: `${input.symbol}:trend_pullback:${input.observedAt}`,
    symbol: input.symbol,
    observedAt: input.observedAt,
    playbookId: "trend_pullback",
    playbookLabel: "P1 趋势回踩",
    state,
    side: regimeAligned || state === "WATCH" ? side : "WAIT",
    score: Math.round(score),
    confidence: Math.round(clamp(score * 0.72 + input.dataQuality * 28, 35, 95)),
    environmentFit: Math.round(environmentFit),
    structureScore: Math.round(structureScore),
    timingScore: Math.round(timingScore),
    confirmationScore: Math.round(confirmationScore),
    riskRewardScore: Math.round(riskRewardScore),
    portfolioImpact: Math.round(permissionMultiplier(context.permission) * 100),
    thesis: state === "TRADE" ? "大盘与个币趋势一致，回踩没有破坏结构，完整 K 线与现货流重新确认。" : "趋势机会存在，但只在环境、位置、完整 K 线恢复和现货流同时满足时执行。",
    reasons: checks.filter((check) => check.passed).map((check) => check.label),
    waitingFor,
    rejectReasons,
    entryPlan: plan,
    metrics: commonMetrics(input, context),
  };
}

function compressionBreakout(input: SentinelV2Input, candles: Candle[], context: SentinelMarketContext): SentinelOpportunity {
  const latest = candles.at(-1) ?? null;
  const currentAtr = atr(candles);
  const prior = candles.slice(-25, -1);
  const priorHigh = prior.length ? Math.max(...prior.map((item) => item.high)) : null;
  const priorLow = prior.length ? Math.min(...prior.map((item) => item.low)) : null;
  const volRatio = volumeRatio(candles);
  const compScore = context.scores.compression;
  const breakoutLong = latest != null && priorHigh != null && currentAtr != null && latest.close >= priorHigh + currentAtr * 0.03;
  const breakoutShort = latest != null && priorLow != null && currentAtr != null && latest.close <= priorLow - currentAtr * 0.03;
  const side: TradeSide = breakoutShort && !breakoutLong ? "SHORT" : "LONG";
  const direction = side === "LONG" ? 1 : -1;
  const breakout = side === "LONG" ? breakoutLong : breakoutShort;
  const compressionPresent = context.regime === "compression" || compScore >= 58;
  const volumeExpanded = volRatio != null && volRatio >= 1.15;
  const flowAligned = input.spotCvdRatio != null && input.spotCvdRatio * direction >= 0.012;
  const oiHealthy = input.openInterestChangePct == null || Math.abs(input.openInterestChangePct) <= 6.5;
  const higherTimeframeNotOpposed = input.multiTimeframeTrend == null || input.multiTimeframeTrend * direction >= -0.20;
  const permissionAllows = ["GREEN", "BLUE", "YELLOW"].includes(context.permission);
  const checks: EntryCheck[] = [
    { key: "compression", label: "突破前压缩", passed: compressionPresent, required: true, detail: `Compression ${compScore}` },
    { key: "breakout", label: "完整 K 线突破", passed: breakout, required: true, detail: `前高 ${priorHigh ?? "--"} / 前低 ${priorLow ?? "--"}` },
    { key: "volume", label: "量能扩张", passed: volumeExpanded, required: true, detail: volRatio == null ? "--" : `${volRatio.toFixed(2)}×` },
    { key: "flow", label: "Spot CVD 确认", passed: flowAligned, required: true, detail: input.spotCvdRatio == null ? "缺失" : `${(input.spotCvdRatio * 100).toFixed(1)}%` },
    { key: "oi", label: "杠杆未失控", passed: oiHealthy, required: true, detail: input.openInterestChangePct == null ? "中性" : `${input.openInterestChangePct.toFixed(2)}%` },
    { key: "higher-timeframe", label: "高周期不强烈反向", passed: higherTimeframeNotOpposed, required: true, detail: input.multiTimeframeTrend == null ? "--" : `${(input.multiTimeframeTrend * direction).toFixed(2)}` },
    { key: "permission", label: "交易许可", passed: permissionAllows, required: true, detail: context.permission },
  ];
  const stopBase = side === "LONG" ? priorHigh : priorLow;
  const stop = stopBase != null && currentAtr != null ? stopBase - direction * currentAtr * 0.55 : 0;
  const plan = buildPlan(input, candles, { side, stopLossPrice: stop, tp2R: 2.4, maxHoldingMinutes: 120, checks, zoneAtr: 0.12 });
  const environmentFit = clamp(compScore * 0.62 + (context.regime === "compression" ? 28 : 0) + (context.permission === "GREEN" || context.permission === "BLUE" ? 10 : 0), 0, 100);
  const structureScore = clamp((breakout ? 62 : 20) + (compressionPresent ? 38 : 0), 0, 100);
  const timingScore = clamp((breakout ? 45 : 15) + (volumeExpanded ? 25 : 5) + (flowAligned ? 30 : 5), 0, 100);
  const confirmationScore = clamp((volumeExpanded ? 30 : 5) + (flowAligned ? 35 : 5) + (oiHealthy ? 20 : 0) + (higherTimeframeNotOpposed ? 15 : 0), 0, 100);
  const riskRewardScore = plan ? clamp(plan.riskReward / 2.4 * 100, 0, 100) : 0;
  const score = clamp(environmentFit * 0.26 + structureScore * 0.25 + timingScore * 0.22 + confirmationScore * 0.17 + riskRewardScore * 0.10, 0, 100);
  const rejectReasons: string[] = [];
  if (input.dataQuality < 0.70) rejectReasons.push("DATA_UNSAFE");
  if (context.permission === "RED") rejectReasons.push("TRANSITION_RED");
  if (context.permission === "ORANGE") rejectReasons.push("TRANSITION_HIGH");
  if (!oiHealthy) rejectReasons.push("LEVERAGE_EXTREME");
  const waitingFor = checks.filter((check) => check.required && !check.passed).map((check) => check.label);
  const state: V2DecisionState = rejectReasons.length ? "REJECT" : plan?.ready && score >= (context.permission === "YELLOW" ? 84 : 77) ? "TRADE" : "WATCH";
  return {
    id: `${input.symbol}:compression_breakout:${input.observedAt}`,
    symbol: input.symbol,
    observedAt: input.observedAt,
    playbookId: "compression_breakout",
    playbookLabel: "P4 压缩突破",
    state,
    side: breakout || state === "WATCH" ? side : "WAIT",
    score: Math.round(score),
    confidence: Math.round(clamp(score * 0.72 + input.dataQuality * 28, 35, 95)),
    environmentFit: Math.round(environmentFit),
    structureScore: Math.round(structureScore),
    timingScore: Math.round(timingScore),
    confirmationScore: Math.round(confirmationScore),
    riskRewardScore: Math.round(riskRewardScore),
    portfolioImpact: Math.round(permissionMultiplier(context.permission) * 100),
    thesis: state === "TRADE" ? "市场先压缩，再由完整 K 线、成交量和现货流共同确认突破，不提前猜方向。" : "压缩阶段只准备，不预测方向；等待真实突破与资金流确认。",
    reasons: checks.filter((check) => check.passed).map((check) => check.label),
    waitingFor,
    rejectReasons,
    entryPlan: plan,
    metrics: commonMetrics(input, context),
  };
}

function defensiveOpportunity(input: SentinelV2Input, context: SentinelMarketContext): SentinelOpportunity {
  const active = context.regime === "transition" || ["ORANGE", "RED"].includes(context.permission);
  return {
    id: `${input.symbol}:transition_defensive:${input.observedAt}`,
    symbol: input.symbol,
    observedAt: input.observedAt,
    playbookId: "transition_defensive",
    playbookLabel: "P8 环境切换防御",
    state: active ? "REJECT" : "WATCH",
    side: "WAIT",
    score: context.transitionRisk,
    confidence: Math.max(context.confidence, context.transitionRisk),
    environmentFit: 100,
    structureScore: 0,
    timingScore: 0,
    confirmationScore: context.transitionRisk,
    riskRewardScore: 0,
    portfolioImpact: Math.round(permissionMultiplier(context.permission) * 100),
    thesis: active ? "旧环境正在失效或风险过高，当前首要任务是收缩新增风险而不是制造交易。" : "防御 Playbook 持续待命；一旦 Transition 升级会优先限制追价和新增风险。",
    reasons: active ? [`Transition ${context.transitionRisk}`, `Permission ${context.permission}`] : ["环境仍可控"],
    waitingFor: active ? ["Transition Risk 回落", "新 Regime 确认"] : [],
    rejectReasons: active ? [context.permission === "RED" ? "TRANSITION_RED" : "TRANSITION_HIGH"] : [],
    entryPlan: null,
    metrics: commonMetrics(input, context),
  };
}

function choosePrimary(opportunities: SentinelOpportunity[]) {
  const tradable = opportunities.filter((item) => item.playbookId !== "transition_defensive");
  return [...tradable].sort((a, b) => {
    const stateRank = (state: V2DecisionState) => state === "TRADE" ? 3 : state === "WATCH" ? 2 : 1;
    return stateRank(b.state) - stateRank(a.state) || b.score - a.score || b.confidence - a.confidence;
  })[0] ?? null;
}

export function evaluateSentinelV2(input: SentinelV2Input): SentinelV2Evaluation {
  const candles = completedCandles(input);
  const safeInput = candles.length >= 30 ? input : { ...input, dataQuality: Math.min(input.dataQuality, 0.55) };
  const context = marketContext(safeInput, candles);
  const opportunities = [
    trendPullback(safeInput, candles, context),
    compressionBreakout(safeInput, candles, context),
    defensiveOpportunity(safeInput, context),
  ];
  return {
    context,
    opportunities,
    primaryOpportunity: choosePrimary(opportunities),
  };
}
