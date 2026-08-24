import { experienceEdge, type EntryPlan, type ExperienceBySide, type TradeSide } from "./trade-lifecycle.ts";

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type MarketInputs = {
  symbol: string;
  observedAt: number;
  futuresPrice: number;
  changePercentage: number | null;
  markPrice: number | null;
  spotPrice: number | null;
  fundingRate: number | null;
  openInterestChangePct: number | null;
  basisPct: number | null;
  spotCvdRatio: number | null;
  orderBookImbalance: number | null;
  benchmarkMomentum: number | null;
  multiTimeframeTrend?: number | null;
  liquidationImbalance?: number | null;
  optionsIvPercentile?: number | null;
  macroEventRisk?: number | null;
  macroEventLabel?: string | null;
  etfFlowScore?: number | null;
  priorLongProbability?: number | null;
  experience?: ExperienceBySide;
  alertStyle?: "early" | "balanced" | "confirmed";
  candles: Candle[];
  sourceAgesMs: Record<string, number | null>;
};

export type SignalMetric = {
  key: string;
  label: string;
  score: number;
  detail: string;
  available: boolean;
  category: "price" | "momentum" | "volume" | "spot" | "derivatives" | "microstructure" | "cross" | "flow" | "volatility" | "events";
};

export type SignalDecision = {
  symbol: string;
  observedAt: number;
  state: "observing" | "pre_alert" | "confirmed" | "blocked";
  stateLabel: string;
  side: "LONG" | "SHORT" | "WAIT";
  confidence: number;
  directionalScore: number;
  posteriorLong: number;
  dataQuality: number;
  regime: string;
  action: string;
  thesis: string;
  entryZone: [number, number] | null;
  trigger: string;
  invalidationPrice: number | null;
  invalidation: string;
  expiresMinutes: number;
  entryPlan: EntryPlan | null;
  metrics: SignalMetric[];
  evidence: { title: string; detail: string; score: number }[];
  counterEvidence: { title: string; detail: string }[];
  diagnostics: {
    rsi14: number | null;
    atrPct: number | null;
    volumeRatio: number | null;
    confirmationCount: number;
    contradictionCount: number;
    staleSources: string[];
    macroEventRisk: number;
    optionsIvPercentile: number | null;
    experienceSampleCount: number;
    experienceAdjustment: number;
    lastCandleHigh: number | null;
    lastCandleLow: number | null;
    lastCompletedCandleAt: number | null;
    excludedIncompleteCandle: boolean;
  };
};

const FIVE_MINUTES_MS = 5 * 60_000;

const SOURCE_WEIGHTS: Record<string, number> = {
  ticker: 0.16,
  candles: 0.24,
  spotTicker: 0.08,
  spotTrades: 0.18,
  orderBook: 0.10,
  contractStats: 0.16,
  benchmarks: 0.08,
};

const STALE_AFTER_MS: Record<string, number> = {
  ticker: 30_000,
  candles: 360_000,
  spotTicker: 30_000,
  spotTrades: 45_000,
  orderBook: 30_000,
  contractStats: 720_000,
  benchmarks: 45_000,
};

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

function rsi(values: number[], period = 14) {
  if (values.length <= period) return null;
  const changes = values.slice(1).map((value, index) => value - values[index]);
  const window = changes.slice(-period);
  const gains = mean(window.map((change) => Math.max(0, change)));
  const losses = mean(window.map((change) => Math.max(0, -change)));
  if (losses === 0) return gains === 0 ? 50 : 100;
  return 100 - 100 / (1 + gains / losses);
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

function signed(value: number) {
  return value === 0 ? 0 : value > 0 ? 1 : -1;
}

function logit(probability: number) {
  const bounded = clamp(probability, 0.03, 0.97);
  return Math.log(bounded / (1 - bounded));
}

function logistic(value: number) {
  return 1 / (1 + Math.exp(-value));
}

function percent(value: number | null, digits = 2) {
  return value == null || !Number.isFinite(value) ? "不可用" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function freshness(sourceAgesMs: Record<string, number | null>) {
  let quality = 0;
  const staleSources: string[] = [];
  for (const [source, weight] of Object.entries(SOURCE_WEIGHTS)) {
    const age = sourceAgesMs[source];
    const staleAfter = STALE_AFTER_MS[source];
    if (age == null || !Number.isFinite(age)) {
      staleSources.push(source);
      continue;
    }
    const score = clamp(1 - age / (staleAfter * 2), 0, 1);
    quality += score * weight;
    if (age > staleAfter) staleSources.push(source);
  }
  return { quality: clamp(quality, 0, 1), staleSources };
}

function priceDigits(price: number) {
  if (price >= 10_000) return 1;
  if (price >= 100) return 2;
  if (price >= 1) return 3;
  return 6;
}

function formatPrice(price: number) {
  return price.toLocaleString("en-US", { minimumFractionDigits: priceDigits(price), maximumFractionDigits: priceDigits(price) });
}

function candleTimeMs(time: number) {
  return time > 10_000_000_000 ? time : time * 1000;
}

function momentumFromRsi(value: number | null): number {
  if (value == null) return 0;
  if (value < 50) return -momentumFromRsi(100 - value);
  if (value <= 65) return clamp((value - 50) / 15, 0, 1);
  if (value <= 72) return 1 - ((value - 65) / 7) * 0.75;
  return -clamp((value - 72) / 8, 0, 1);
}

export function evaluateMarket(input: MarketInputs): SignalDecision {
  const rawCandles = input.candles
    .filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
    .sort((a, b) => a.time - b.time);
  const candles = rawCandles.filter((candle) => candleTimeMs(candle.time) + FIVE_MINUTES_MS <= input.observedAt);
  const excludedIncompleteCandle = candles.length < rawCandles.length;
  const closes = candles.map((candle) => candle.close);
  const current = input.futuresPrice;
  const fast = ema(closes.slice(-35), 9);
  const slow = ema(closes.slice(-50), 21);
  const rsi14 = rsi(closes);
  const atr14 = atr(candles);
  const atrPct = atr14 && current > 0 ? (atr14 / current) * 100 : null;
  const recentVolumes = candles.slice(-21, -1).map((candle) => candle.volume);
  const volumeRatio = recentVolumes.length && candles.length ? candles.at(-1)!.volume / Math.max(mean(recentVolumes), Number.EPSILON) : null;
  const priceReturn = closes.length > 6 ? (closes.at(-1)! / closes.at(-7)! - 1) * 100 : 0;
  const trendScale = Math.max((atrPct ?? 0.7) / 100, 0.0025);
  const trendScore = fast && slow ? clamp((fast / slow - 1) / (trendScale * 1.4), -1, 1) : 0;
  const momentumScore = momentumFromRsi(rsi14);
  const volumeScore = volumeRatio == null ? 0 : signed(priceReturn) * clamp((volumeRatio - 0.80) / 1.2, 0, 1);
  const spotScore = input.spotCvdRatio == null ? 0 : clamp(input.spotCvdRatio * 2.2, -1, 1);

  let derivativesScore = 0;
  if (input.openInterestChangePct != null) {
    const oiStrength = clamp(Math.abs(input.openInterestChangePct) / 5, 0.15, 1);
    derivativesScore = signed(priceReturn) * (input.openInterestChangePct >= 0 ? 0.75 : 0.35) * oiStrength;
  }
  if (input.fundingRate != null) {
    const crowded = clamp(Math.abs(input.fundingRate) / 0.001, 0, 1);
    derivativesScore -= signed(input.fundingRate) * crowded * 0.34;
  }
  if (input.basisPct != null) derivativesScore -= signed(input.basisPct) * clamp(Math.abs(input.basisPct) / 0.8, 0, 1) * 0.12;
  derivativesScore = clamp(derivativesScore, -1, 1);

  const bookScore = input.orderBookImbalance == null ? 0 : clamp(input.orderBookImbalance * 1.8, -1, 1);
  const crossScore = input.benchmarkMomentum == null ? 0 : clamp(input.benchmarkMomentum / 2.2, -1, 1);
  const multiTimeframeScore = input.multiTimeframeTrend == null ? 0 : clamp(input.multiTimeframeTrend, -1, 1);
  const extremeLiquidation = input.liquidationImbalance != null && Math.abs(input.liquidationImbalance) >= 0.80;
  const liquidationScore = input.liquidationImbalance == null || extremeLiquidation ? 0 : clamp(input.liquidationImbalance * 1.10, -0.8, 0.8);
  const etfScore = input.etfFlowScore == null ? 0 : clamp(input.etfFlowScore, -1, 1);

  const metrics: SignalMetric[] = [
    { key: "trend", label: "价格结构", score: trendScore, detail: fast && slow ? `EMA9 ${fast > slow ? "高于" : "低于"} EMA21，近 30 分钟 ${percent(priceReturn)}` : "K 线数量不足", available: fast != null && slow != null, category: "price" },
    { key: "multi-timeframe", label: "多周期共振", score: multiTimeframeScore, detail: input.multiTimeframeTrend == null ? "15m/1h/4h 数据不可用" : `15m、1h、4h 聚合趋势分数 ${(multiTimeframeScore * 100).toFixed(0)}`, available: input.multiTimeframeTrend != null, category: "price" },
    { key: "momentum", label: "动量", score: momentumScore, detail: rsi14 == null ? "RSI14 不可用" : `RSI14 = ${rsi14.toFixed(1)}`, available: rsi14 != null, category: "momentum" },
    { key: "volume", label: "成交量确认", score: volumeScore, detail: volumeRatio == null ? "成交量不可用" : `最近完整 5m K 线成交量为此前 20 根均值的 ${volumeRatio.toFixed(2)}×`, available: volumeRatio != null, category: "volume" },
    { key: "spot-flow", label: "现货主动流", score: spotScore, detail: input.spotCvdRatio == null ? "现货成交方向不可用" : `近端 Spot CVD 占比 ${percent(input.spotCvdRatio * 100, 1)}`, available: input.spotCvdRatio != null, category: "spot" },
    { key: "derivatives", label: "衍生品结构", score: derivativesScore, detail: `OI ${percent(input.openInterestChangePct)}；资金费率 ${input.fundingRate == null ? "不可用" : percent(input.fundingRate * 100, 4)}；基差 ${percent(input.basisPct, 3)}`, available: input.openInterestChangePct != null || input.fundingRate != null, category: "derivatives" },
    { key: "liquidations", label: "清算方向", score: liquidationScore, detail: input.liquidationImbalance == null ? "近期清算流不可用" : extremeLiquidation ? `清算净方向 ${percent(input.liquidationImbalance * 100, 1)}，已达挤压极值，只计风险、不作延续加分` : `短空/多头清算净方向 ${percent(input.liquidationImbalance * 100, 1)}`, available: input.liquidationImbalance != null, category: "derivatives" },
    { key: "order-book", label: "订单簿深度", score: bookScore, detail: input.orderBookImbalance == null ? "订单簿不可用" : `前 50 档金额不平衡 ${percent(input.orderBookImbalance * 100, 1)}`, available: input.orderBookImbalance != null, category: "microstructure" },
    { key: "cross-market", label: "大盘同步", score: crossScore, detail: input.benchmarkMomentum == null ? "基准行情不可用" : `BTC/ETH 24h 平均动量 ${percent(input.benchmarkMomentum)}`, available: input.benchmarkMomentum != null, category: "cross" },
    { key: "etf-flow", label: "ETF 资金流", score: etfScore, detail: input.etfFlowScore == null ? "尚未配置可靠 ETF 净流数据源，不参与评分" : `标准化净流分数 ${(etfScore * 100).toFixed(0)}`, available: input.etfFlowScore != null, category: "flow" },
  ];

  const weights: Record<string, number> = {
    trend: 0.18,
    "multi-timeframe": 0.15,
    momentum: 0.08,
    volume: 0.08,
    "spot-flow": 0.16,
    derivatives: 0.13,
    liquidations: 0.07,
    "order-book": 0.06,
    "cross-market": 0.06,
    "etf-flow": 0.03,
    "historical-edge": 0,
  };

  const scoreMetrics = () => {
    const availableWeight = metrics.filter((metric) => metric.available).reduce((sum, metric) => sum + weights[metric.key], 0);
    const rawScore = metrics.reduce((sum, metric) => sum + (metric.available ? metric.score * weights[metric.key] : 0), 0);
    return availableWeight ? rawScore / availableWeight : 0;
  };
  const preliminaryScore = scoreMetrics();
  const preliminaryDirection = preliminaryScore >= 0 ? 1 : -1;
  const preliminarySide: TradeSide = preliminaryDirection > 0 ? "LONG" : "SHORT";
  const historicalExperience = input.experience?.[preliminarySide] ?? null;
  const historicalAdjustment = experienceEdge(historicalExperience);
  metrics.push({
    key: "historical-edge",
    label: "同币同方向历史经验",
    score: preliminaryDirection * historicalAdjustment,
    detail: historicalExperience
      ? `${preliminarySide} 已完成 ${historicalExperience.sampleCount} 单；贝叶斯胜率 ${(historicalExperience.bayesianWinRate * 100).toFixed(1)}%；平均净结果 ${percent(historicalExperience.averageNetPct)}`
      : `${preliminarySide} 暂无完整平仓样本，不凭空加分`,
    available: Boolean(historicalExperience?.sampleCount),
    category: "events",
  });
  let directionalScore = scoreMetrics();

  const decayedPrior = 0.5 + ((input.priorLongProbability ?? 0.5) - 0.5) * 0.65;
  const likelihoodEvidence = metrics.reduce((sum, metric) => sum + (metric.available ? metric.score * weights[metric.key] * 2.2 : 0), 0);
  const posteriorLong = clamp(logistic(logit(decayedPrior) + likelihoodEvidence), 0.03, 0.97);
  directionalScore = directionalScore * 0.78 + (posteriorLong - 0.5) * 2 * 0.22;
  directionalScore += preliminaryDirection * historicalAdjustment * 0.12;

  const atrPenalty = atrPct == null ? 0 : clamp((atrPct - 1.8) / 3, 0, 0.28);
  const ivPenalty = input.optionsIvPercentile == null ? 0 : clamp((input.optionsIvPercentile - 0.78) * 0.6, 0, 0.14);
  directionalScore *= 1 - atrPenalty - ivPenalty;
  directionalScore = clamp(directionalScore, -1, 1);

  const direction = signed(directionalScore) || preliminaryDirection;
  const confirmationCount = metrics.filter((metric) => metric.available && metric.score * direction >= 0.18).length;
  const contradictionCount = metrics.filter((metric) => metric.available && metric.score * direction <= -0.18).length;
  const { quality: dataQuality, staleSources } = freshness(input.sourceAgesMs);
  const fundingCrowded = input.fundingRate != null && Math.abs(input.fundingRate) >= 0.001;
  const extremeVolatility = atrPct != null && atrPct >= 4.5;
  const highImpactEvent = (input.macroEventRisk ?? 0) >= 0.85;
  const enoughCompletedCandles = candles.length >= 30;
  const hardBlock = dataQuality < 0.58 || !metrics[0].available || !enoughCompletedCandles || fundingCrowded || extremeVolatility || highImpactEvent;

  const profiles = {
    early: { confirmScore: 0.24, preAlertScore: 0.12, confirmations: 3, quality: 0.70 },
    balanced: { confirmScore: 0.28, preAlertScore: 0.16, confirmations: 3, quality: 0.74 },
    confirmed: { confirmScore: 0.35, preAlertScore: 0.20, confirmations: 4, quality: 0.80 },
  } as const;
  const profile = profiles[input.alertStyle ?? "balanced"];

  const candidateSide: TradeSide = direction > 0 ? "LONG" : "SHORT";
  const alignedValue = (value: number) => value * direction;
  const latestCandle = candles.at(-1) ?? null;
  const previousCandle = candles.at(-2) ?? null;
  const latestClose = latestCandle?.close ?? current;
  const completedBarAligned = fast != null && latestCandle != null && previousCandle != null
    && (candidateSide === "LONG"
      ? latestCandle.close >= fast && latestCandle.close > latestCandle.open && latestCandle.close > previousCandle.close && current >= fast
      : latestCandle.close <= fast && latestCandle.close < latestCandle.open && latestCandle.close < previousCandle.close && current <= fast);
  const directionalDayChange = (input.changePercentage ?? 0) * direction;
  const directionalThirtyMinuteChange = priceReturn * direction;
  const alignedLiquidation = (input.liquidationImbalance ?? 0) * direction;
  const liquidationExhaustion = alignedLiquidation >= 0.80 && (directionalDayChange >= 4 || directionalThirtyMinuteChange >= 1);
  const requiredVolumeRatio = directionalDayChange >= 4 || extremeLiquidation ? 1 : 0.8;
  const volumeConfirmed = volumeRatio != null && volumeRatio >= requiredVolumeRatio;
  const emaExtensionAtr = fast != null && atr14 != null && atr14 > 0 ? ((current - fast) * direction) / atr14 : null;
  const rsiNotExhausted = rsi14 != null && (candidateSide === "LONG" ? rsi14 <= 72 : rsi14 >= 28);
  const antiChasePassed = rsiNotExhausted && emaExtensionAtr != null && emaExtensionAtr <= 1.25 && directionalDayChange <= 8;

  const supportive = metrics.filter((metric) => metric.available && metric.score * direction >= 0.12).sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const opposing = metrics.filter((metric) => metric.available && metric.score * direction <= -0.10).sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const evidence = supportive.slice(0, 5).map((metric) => ({ title: metric.label, detail: metric.detail, score: Math.round(50 + Math.abs(metric.score) * 45) }));
  const counterEvidence = opposing.slice(0, 4).map((metric) => ({ title: metric.label, detail: metric.detail }));
  if (staleSources.length) counterEvidence.push({ title: "数据新鲜度", detail: `${staleSources.join("、")} 缺失或超过新鲜度阈值，系统已降低可信度。` });
  if (fundingCrowded) counterEvidence.push({ title: "资金费率过热", detail: "资金费率超过硬拦截阈值，避免在拥挤方向追价。" });
  if (extremeVolatility) counterEvidence.push({ title: "波动率异常", detail: `ATR 达价格的 ${atrPct!.toFixed(2)}%，当前不提供进场提醒。` });
  if ((input.optionsIvPercentile ?? 0) >= 0.85) counterEvidence.push({ title: "期权隐含波动率", detail: `BTC/ETH 期权 IV 位于历史 ${(input.optionsIvPercentile! * 100).toFixed(0)}% 分位，方向可信度已降级。` });
  if (highImpactEvent) counterEvidence.push({ title: "宏观事件窗口", detail: `${input.macroEventLabel ?? "高影响宏观事件"}临近，事件公布前不发进场确认。` });
  if (!volumeConfirmed) counterEvidence.push({ title: "完整 K 线量能不足", detail: `最近完整 5m 量能 ${volumeRatio == null ? "不可用" : `${volumeRatio.toFixed(2)}×`}，当前结构至少要求 ${requiredVolumeRatio.toFixed(2)}×。` });
  if (!rsiNotExhausted) counterEvidence.push({ title: "动量已过热", detail: `RSI14 ${rsi14 == null ? "不可用" : rsi14.toFixed(1)} 已进入${candidateSide === "LONG" ? "追多" : "追空"}耗竭区，不再作为趋势延续加分。` });
  if (emaExtensionAtr != null && emaExtensionAtr > 1.25) counterEvidence.push({ title: "入场位置过远", detail: `现价相对 EMA9 已沿目标方向偏离 ${emaExtensionAtr.toFixed(2)} ATR，超过 1.25 ATR 追价上限。` });
  if (liquidationExhaustion) counterEvidence.push({ title: "清算挤压耗竭", detail: `清算方向强度 ${alignedLiquidation.toFixed(2)}，且目标方向 24h 已运行 ${directionalDayChange.toFixed(2)}%；等待挤压释放后重新确认。` });
  const criticalCounterEvidence = new Set(["完整 K 线量能不足", "动量已过热", "入场位置过远", "清算挤压耗竭"]);
  counterEvidence.sort((left, right) => Number(criticalCounterEvidence.has(right.title)) - Number(criticalCounterEvidence.has(left.title)));
  if (!counterEvidence.length) counterEvidence.push({ title: "样本风险", detail: "即使多源证据同向，也可能在结构突变时同时失效；必须执行失效条件。" });

  const swing = candles.slice(-7);
  const buffer = (atr14 ?? current * 0.006) * 0.12;
  const invalidationPrice = !swing.length ? null : candidateSide === "LONG" ? Math.min(...swing.map((candle) => candle.low)) - buffer : Math.max(...swing.map((candle) => candle.high)) + buffer;
  const entryZone: [number, number] | null = !atr14 ? null : candidateSide === "LONG"
    ? [current - atr14 * 0.28, current + atr14 * 0.08]
    : [current - atr14 * 0.08, current + atr14 * 0.28];
  const entryPrice = current;
  const riskPerUnit = invalidationPrice == null ? 0 : Math.abs(entryPrice - invalidationPrice);
  const plannedRiskPct = entryPrice > 0 ? riskPerUnit / entryPrice * 100 : 0;
  const maxPlannedRiskPct = Math.min(Math.max((atrPct ?? 0.8) * 4.5, 3.5), 6);
  const takeProfit1Price = candidateSide === "LONG" ? entryPrice + riskPerUnit : entryPrice - riskPerUnit;
  const takeProfit2Price = candidateSide === "LONG" ? entryPrice + riskPerUnit * 2 : entryPrice - riskPerUnit * 2;
  const maxHoldingMinutes = atrPct != null && atrPct >= 1.8 ? 60 : atrPct != null && atrPct < 0.55 ? 180 : 120;
  const entryChecks = [
    { key: "directional-score", label: "方向评分", passed: Math.abs(directionalScore) >= profile.confirmScore, required: true, detail: `${Math.abs(directionalScore).toFixed(3)} / 要求 ${profile.confirmScore.toFixed(2)}` },
    { key: "independent-confirmations", label: "独立证据数量", passed: confirmationCount >= profile.confirmations, required: true, detail: `${confirmationCount} 类同向 / 要求 ${profile.confirmations} 类` },
    { key: "data-quality", label: "数据质量", passed: dataQuality >= profile.quality, required: true, detail: `${Math.round(dataQuality * 100)} / 要求 ${Math.round(profile.quality * 100)}` },
    { key: "multi-timeframe", label: "15m/1h/4h 共振", passed: input.multiTimeframeTrend != null && alignedValue(multiTimeframeScore) >= 0.12, required: true, detail: input.multiTimeframeTrend == null ? "多周期数据缺失" : `同向强度 ${alignedValue(multiTimeframeScore).toFixed(3)} / 要求 0.120` },
    { key: "spot-flow", label: "现货主动流确认", passed: input.spotCvdRatio != null && alignedValue(spotScore) >= 0.03, required: true, detail: input.spotCvdRatio == null ? "Spot CVD 缺失" : `同向强度 ${alignedValue(spotScore).toFixed(3)} / 要求 0.030` },
    { key: "closed-candle-trigger", label: "完整 5m K 线确认", passed: completedBarAligned, required: true, detail: latestCandle == null ? "没有可用的完整 5m K 线" : `只使用已结束 K 线：收盘 ${formatPrice(latestClose)}，EMA9 ${formatPrice(fast ?? current)}；K 线实体、前后收盘与实时价必须同向` },
    { key: "volume-confirmation", label: "完整 K 线量能", passed: volumeConfirmed, required: true, detail: `${volumeRatio == null ? "不可用" : `${volumeRatio.toFixed(2)}×`} / 当前最低 ${requiredVolumeRatio.toFixed(2)}×` },
    { key: "anti-chase", label: "过热与追价检查", passed: antiChasePassed, required: true, detail: `RSI ${rsi14 == null ? "不可用" : rsi14.toFixed(1)}；距 EMA9 ${emaExtensionAtr == null ? "不可用" : `${emaExtensionAtr.toFixed(2)} ATR`}；同向 24h ${directionalDayChange.toFixed(2)}%` },
    { key: "liquidation-exhaustion", label: "清算挤压耗竭检查", passed: !liquidationExhaustion, required: true, detail: liquidationExhaustion ? `极端清算与同向涨跌已同时出现，不追单` : `未出现“极端清算 + 已大幅运行”的追单组合` },
    { key: "leverage-safe", label: "杠杆拥挤检查", passed: !fundingCrowded, required: true, detail: input.fundingRate == null ? "资金费率缺失，未触发拥挤拦截" : `资金费率 ${percent(input.fundingRate * 100, 4)}；硬阈值 ±0.1000%` },
    { key: "macro-safe", label: "宏观事件窗口", passed: !highImpactEvent, required: true, detail: `事件风险 ${Math.round((input.macroEventRisk ?? 0) * 100)}/100；硬阈值 85` },
    { key: "contradictions", label: "反向证据限制", passed: contradictionCount <= 2, required: true, detail: `${contradictionCount} 类反向 / 最多 2 类` },
    { key: "risk-boundary", label: "结构止损距离", passed: riskPerUnit > 0 && plannedRiskPct <= maxPlannedRiskPct, required: true, detail: invalidationPrice == null ? "没有有效结构止损" : `${plannedRiskPct.toFixed(2)}% / 上限 ${maxPlannedRiskPct.toFixed(2)}%；止损 ${formatPrice(invalidationPrice)}` },
    { key: "risk-reward", label: "计划盈亏比", passed: riskPerUnit > 0, required: true, detail: "第二目标为 2.00R / 最低要求 1.80R" },
  ];
  const entryReady = entryZone != null && invalidationPrice != null && entryChecks.filter((check) => check.required).every((check) => check.passed);
  const entryPlan: EntryPlan | null = entryZone && invalidationPrice != null && riskPerUnit > 0 ? {
    ready: entryReady,
    side: candidateSide,
    entryPrice,
    entryZone,
    stopLossPrice: invalidationPrice,
    takeProfit1Price,
    takeProfit2Price,
    riskPerUnit,
    plannedRiskPct,
    riskReward: 2,
    maxHoldingMinutes,
    checks: entryChecks,
    exitRules: [
      { code: "stop_loss", label: "结构止损", condition: `${candidateSide === "LONG" ? "价格 ≤" : "价格 ≥"} ${formatPrice(invalidationPrice)}，立即平仓` },
      { code: "breakeven", label: "第一目标保护", condition: `到达 ${formatPrice(takeProfit1Price)}（1R）后，止损移动到入场价 ${formatPrice(entryPrice)}` },
      { code: "take_profit", label: "第二目标止盈", condition: `到达 ${formatPrice(takeProfit2Price)}（2R），完成平仓` },
      { code: "structure_reversal", label: "结构反转", condition: "多源方向分反向 ≥ 0.24 且至少 3 类证据确认，平仓" },
      { code: "flow_reversal", label: "资金流反转", condition: "Spot CVD 与至少一个独立结构源连续 2 轮反向，平仓" },
      { code: "macro_risk", label: "事件风险退出", condition: "宏观事件风险达到 85/100，平仓规避跳空" },
      { code: "timeout", label: "时间止损", condition: `${maxHoldingMinutes} 分钟内未到第二目标，按当时价格平仓` },
    ],
  } : null;

  const baseConfirm = Math.abs(directionalScore) >= profile.confirmScore && confirmationCount >= profile.confirmations && contradictionCount <= 2 && dataQuality >= profile.quality;
  let state: SignalDecision["state"] = "observing";
  if (hardBlock) state = "blocked";
  else if (baseConfirm && entryReady) state = "confirmed";
  else if (baseConfirm || (Math.abs(directionalScore) >= profile.preAlertScore && confirmationCount >= 2)) state = "pre_alert";

  const side: SignalDecision["side"] = state === "blocked" || state === "observing" ? "WAIT" : candidateSide;
  const rawConfidence = Math.round(clamp(46 + Math.abs(directionalScore) * 38 + (dataQuality - 0.5) * 22 + confirmationCount * 2 - contradictionCount * 3, 20, 92));
  const confidence = state === "confirmed" ? rawConfidence : state === "pre_alert" ? Math.min(rawConfidence, 79) : state === "blocked" ? Math.min(rawConfidence, 45) : Math.min(rawConfidence, 69);
  const label = state === "confirmed" ? "进场条件已全部满足" : state === "pre_alert" ? "预警·条件未齐" : state === "blocked" ? "风险拦截" : "持续观察";
  const action = state === "confirmed" ? `创建 ${candidateSide} 系统跟踪持仓` : state === "pre_alert" ? `等待 ${candidateSide} 缺失条件补齐` : state === "blocked" ? "禁止进场" : "保持空仓观察";
  const failedChecks = entryChecks.filter((check) => check.required && !check.passed);
  const trigger = state === "confirmed"
    ? `全部 ${entryChecks.length} 项进场检查通过；以实时价 ${formatPrice(entryPrice)} 建立系统跟踪持仓`
    : failedChecks.length
      ? `尚缺：${failedChecks.slice(0, 4).map((check) => `${check.label}（${check.detail}）`).join("；")}`
      : "方向强度尚未达到预警阈值，继续等待多源证据形成共振";
  const invalidation = invalidationPrice == null
    ? "当前没有有效结构止损，因此不能形成订单。"
    : `${candidateSide === "LONG" ? "价格触及或跌破" : "价格触及或站上"} ${formatPrice(invalidationPrice)}，立即按结构止损平仓；第一目标后止损上移至入场价。`;

  const trendName = Math.abs(trendScore) > 0.55 ? (trendScore > 0 ? "上升趋势" : "下降趋势") : "震荡结构";
  const volName = atrPct == null ? "波动未知" : atrPct > 1.8 ? "高波动" : atrPct < 0.55 ? "低波动" : "常态波动";
  const thesis = state === "blocked"
    ? `方向证据可能存在，但风险引擎已拦截：${fundingCrowded ? "杠杆拥挤" : extremeVolatility ? "波动异常" : highImpactEvent ? "高影响事件临近" : "关键数据不足或过期"}。`
    : evidence.length
      ? state === "confirmed"
        ? `${evidence.slice(0, 3).map((item) => item.title).join("、")}同向，且进场检查全部通过；订单将由明确的止损、两级目标与反转规则持续管理。`
        : `${evidence.slice(0, 2).map((item) => item.title).join("与")}提供主要方向证据，但${failedChecks.slice(0, 2).map((item) => item.label).join("、") || "执行阈值"}尚未通过。`
      : "当前证据分散，没有形成可执行优势。";

  return {
    symbol: input.symbol,
    observedAt: input.observedAt,
    state,
    stateLabel: label,
    side,
    confidence,
    directionalScore: Number(directionalScore.toFixed(4)),
    posteriorLong: Number(posteriorLong.toFixed(4)),
    dataQuality: Number(dataQuality.toFixed(4)),
    regime: `${trendName} · ${volName}`,
    action,
    thesis,
    entryZone: state === "pre_alert" || state === "confirmed" ? entryZone : null,
    trigger,
    invalidationPrice,
    invalidation,
    expiresMinutes: 15,
    entryPlan: state === "observing" || state === "blocked" ? null : entryPlan,
    metrics,
    evidence,
    counterEvidence: counterEvidence.slice(0, 5),
    diagnostics: {
      rsi14: rsi14 == null ? null : Number(rsi14.toFixed(2)),
      atrPct: atrPct == null ? null : Number(atrPct.toFixed(3)),
      volumeRatio: volumeRatio == null ? null : Number(volumeRatio.toFixed(3)),
      confirmationCount,
      contradictionCount,
      staleSources,
      macroEventRisk: input.macroEventRisk ?? 0,
      optionsIvPercentile: input.optionsIvPercentile ?? null,
      experienceSampleCount: historicalExperience?.sampleCount ?? 0,
      experienceAdjustment: Number(historicalAdjustment.toFixed(4)),
      lastCandleHigh: rawCandles.at(-1)?.high ?? null,
      lastCandleLow: rawCandles.at(-1)?.low ?? null,
      lastCompletedCandleAt: latestCandle == null ? null : candleTimeMs(latestCandle.time),
      excludedIncompleteCandle,
    },
  };
}
