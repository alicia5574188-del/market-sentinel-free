import type { MarketAnalysisPacket } from "./exchange-market.ts";
import {
  DIRECT_MARKET_BRAIN_VERSION,
  type DirectCoreSetup,
  type DirectMarketCandidate,
  type DirectMarketLocation,
  type DirectMarketSide,
} from "./direct-market-types.ts";
import type { Hte31Candle } from "./hte31-types.ts";
import { classifyHte31AssetRegime } from "./hte31-regime.ts";
import type { ResonanceGlobalMarketState } from "./resonance-global-market.ts";

type MarketContext = Pick<ResonanceGlobalMarketState, "benchmarkMomentum" | "advancingRatio" | "decliningRatio">;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function ema(values: number[], period: number) {
  if (!values.length) return null;
  const alpha = 2 / (period + 1);
  let value = values[0];
  for (let index = 1; index < values.length; index += 1) value = values[index] * alpha + value * (1 - alpha);
  return value;
}

function signed(value: number | null | undefined, side: Exclude<DirectMarketSide, "WAIT">) {
  return (value ?? 0) * (side === "LONG" ? 1 : -1);
}

function atr(candles: Hte31Candle[], period = 14) {
  if (candles.length < period + 1) return null;
  const ranges = candles.slice(1).map((row, index) => Math.max(
    row.high - row.low,
    Math.abs(row.high - candles[index].close),
    Math.abs(row.low - candles[index].close),
  ));
  return mean(ranges.slice(-period));
}

function returns(candles: Hte31Candle[]) {
  return candles.slice(1).map((row, index) => row.close / Math.max(candles[index].close, Number.EPSILON) - 1);
}

function completedCandles(candles: Hte31Candle[], observedAt: number) {
  return candles.filter((row) => [row.time, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)
    && (row.time > 10_000_000_000 ? row.time : row.time * 1000) + 300_000 <= observedAt)
    .sort((left, right) => left.time - right.time);
}

function barVolumeRatio(candles: Hte31Candle[], bar: Hte31Candle | undefined, endOffset: number) {
  if (!bar || candles.length < 24) return 0;
  return bar.volume / Math.max(mean(candles.slice(-28, -endOffset).map((row) => row.volume)), Number.EPSILON);
}

export function pearsonCorrelation(leftCandles: Hte31Candle[], rightCandles: Hte31Candle[]) {
  const left = returns(leftCandles).slice(-72);
  const right = returns(rightCandles).slice(-72);
  const length = Math.min(left.length, right.length);
  if (length < 24) return null;
  const x = left.slice(-length);
  const y = right.slice(-length);
  const mx = mean(x);
  const my = mean(y);
  let covariance = 0;
  let xVariance = 0;
  let yVariance = 0;
  for (let index = 0; index < length; index += 1) {
    const dx = x[index] - mx;
    const dy = y[index] - my;
    covariance += dx * dy;
    xVariance += dx * dx;
    yVariance += dy * dy;
  }
  if (xVariance <= 0 || yVariance <= 0) return null;
  return clamp(covariance / Math.sqrt(xVariance * yVariance), -1, 1);
}

function normalizedPaths(score: number) {
  const upRaw = Math.max(4, 35 + score * 45);
  const downRaw = Math.max(4, 35 - score * 45);
  const rangeRaw = Math.max(10, 30 - Math.abs(score) * 15);
  const total = upRaw + downRaw + rangeRaw;
  const up = Math.round(upRaw / total * 1000) / 10;
  const down = Math.round(downRaw / total * 1000) / 10;
  return { up, down, rangeOrInvalid: Math.round((100 - up - down) * 10) / 10 };
}

function location(candles: Hte31Candle[], price: number): DirectMarketLocation {
  const recent = candles.slice(-72);
  if (!recent.length) return "MIDDLE";
  const high = Math.max(...recent.map((row) => row.high));
  const low = Math.min(...recent.map((row) => row.low));
  if (price >= high) return "BREAKOUT";
  if (price <= low) return "BREAKDOWN";
  const percentile = (price - low) / Math.max(high - low, Number.EPSILON);
  return percentile >= 0.72 ? "TOP" : percentile <= 0.28 ? "BOTTOM" : "MIDDLE";
}

type SetupEvaluation = {
  setup: DirectCoreSetup;
  label: string;
  side: Exclude<DirectMarketSide, "WAIT">;
  trigger: boolean;
  score: number;
  target1R: number;
  target2R: number;
  maxHoldingMinutes: number;
  stopLookback: number;
  stopPaddingAtr: number;
  assetRegime: string;
  setupChecks: { key: string; label: string; passed: boolean; detail: string }[];
  evidence: string[];
  blockers: string[];
};

function evaluateCoreSetups(packet: MarketAnalysisPacket, candles: Hte31Candle[], marketContext?: MarketContext): SetupEvaluation[] {
  const rows = candles.slice(-96);
  const last = rows.at(-1)!;
  const previous = rows.at(-2)!;
  const currentAtr = atr(rows);
  const trend15m = packet.market.timeframeTrend15m ?? 0;
  const trend1h = packet.market.timeframeTrend1h ?? 0;
  const trend4h = packet.market.timeframeTrend4h ?? 0;
  const weightedTrend = trend15m * 0.25 + trend1h * 0.35 + trend4h * 0.40;
  const assetRegime = classifyHte31AssetRegime({
    ...packet.market, symbol: packet.symbol, observedAt: packet.observedAt,
    multiTimeframeTrend: packet.market.multiTimeframeTrend ?? weightedTrend,
    benchmarkMomentum: marketContext?.benchmarkMomentum ?? null,
    dataQuality: packet.decision.dataQuality, candles5m: candles,
  });

  // HT3-R Failed Auction: a raw signal is the price event (sweep + reclaim).
  // Volume, reverse impulse, microstructure and trend fit remain qualification
  // gates so signal frequency is visible without weakening actual entry.
  const failedReference = rows.slice(-36, -2);
  const failedHigh = Math.max(...failedReference.map((row) => row.high));
  const failedLow = Math.min(...failedReference.map((row) => row.low));
  const highExtension = currentAtr ? (previous.high - failedHigh) / currentAtr : 0;
  const lowExtension = currentAtr ? (failedLow - previous.low) / currentAtr : 0;
  const sweptHigh = highExtension >= 0.08 && highExtension <= 1.10;
  const sweptLow = lowExtension >= 0.08 && lowExtension <= 1.10;
  const breakoutSide = sweptHigh && highExtension >= lowExtension ? "LONG" as const : "SHORT" as const;
  const failedSide = breakoutSide === "LONG" ? "SHORT" as const : "LONG" as const;
  const failedReclaim = Boolean(currentAtr && (failedSide === "SHORT"
    ? sweptHigh && last.close < failedHigh - currentAtr * 0.04
    : sweptLow && last.close > failedLow + currentAtr * 0.04));
  const failedSweepVolume = barVolumeRatio(rows, previous, 2);
  const failedSweepRangeAtr = currentAtr ? (previous.high - previous.low) / currentAtr : 0;
  const breakoutForce = failedSweepVolume >= 1.05 && failedSweepRangeAtr >= 0.62;
  const reverseBodyAtr = currentAtr ? Math.abs(last.close - last.open) / currentAtr : 0;
  const reverseImpulse = reverseBodyAtr >= 0.20 && (failedSide === "SHORT"
    ? last.close < last.open && last.close <= (previous.high + previous.low) / 2
    : last.close > last.open && last.close >= (previous.high + previous.low) / 2);
  const failedForceRatio = reverseBodyAtr / Math.max(Math.max(highExtension, lowExtension), 0.10);
  const failedFlow = signed(packet.market.spotCvdRatio, failedSide);
  const failedBook = signed(packet.market.orderBookImbalance, failedSide);
  const failedVotes = [
    breakoutForce,
    reverseImpulse,
    failedForceRatio >= 0.90,
    failedFlow >= 0.0015,
    failedBook >= 0.015,
    signed(packet.market.liquidationImbalance, breakoutSide) >= 0.22,
  ].filter(Boolean).length;
  const failedMicro = failedVotes >= 3 && (reverseImpulse || (failedFlow >= 0.0015 && failedBook >= 0.015));
  const failedStrongTrendAgainst = signed(trend4h, failedSide) < -0.42;
  const failedTrendFit = !failedStrongTrendAgainst || (failedForceRatio >= 1.45 && failedFlow >= 0.0015 && failedBook >= 0.015);
  const failedTrigger = (sweptHigh || sweptLow) && failedReclaim;
  const failedChecks = [
    { key: "failed-force", label: "突破量价力度", passed: breakoutForce, detail: `${failedSweepVolume.toFixed(2)}x / ${failedSweepRangeAtr.toFixed(2)} ATR` },
    { key: "failed-reversal", label: "反向力度确认", passed: failedMicro, detail: `${failedVotes}/6 · 力度比 ${failedForceRatio.toFixed(2)}` },
    { key: "failed-regime", label: "不机械对抗强趋势", passed: failedTrendFit, detail: failedStrongTrendAgainst ? "需要极强反向证据" : "高周期未强烈反对" },
  ];
  const failedSetupScore = (failedTrigger ? 48 : sweptHigh || sweptLow ? 24 : 0) + (breakoutForce ? 16 : 0) + (reverseImpulse ? 18 : 0) + Math.min(18, failedVotes * 3);
  const failedEvidenceScore = 34 + failedVotes * 9 + Math.min(16, failedForceRatio * 8) + (failedTrendFit ? 8 : -24);

  // Original HT4: do not infer exhaustion from a 24-hour move alone. The
  // crowded trend must be mature and stretched, then fail with multi-source
  // crowding evidence and a completed five-minute reversal.
  const exhaustionTrend = Math.abs(trend15m) > 0 ? trend15m : weightedTrend;
  const crowdedSide = exhaustionTrend >= 0 ? "LONG" as const : "SHORT" as const;
  const exhaustionSide = crowdedSide === "LONG" ? "SHORT" as const : "LONG" as const;
  const exhaustionEma = ema(rows.slice(-50).map((row) => row.close), 20);
  const exhaustionStretch = currentAtr && exhaustionEma != null
    ? signed(last.close - exhaustionEma, crowdedSide) / currentAtr
    : 0;
  const exhaustionMature = Math.abs(exhaustionTrend) >= 0.45;
  const exhaustionStretched = exhaustionStretch >= 0.72;
  const fundingCrowded = packet.market.fundingRate != null && signed(packet.market.fundingRate, crowdedSide) >= 0.00008;
  const oiCrowded = (packet.market.openInterestChangePct ?? 0) >= 0.8;
  const flowWeak = packet.market.spotCvdRatio != null && signed(packet.market.spotCvdRatio, crowdedSide) <= 0.006;
  const bookWeak = packet.market.orderBookImbalance != null && signed(packet.market.orderBookImbalance, crowdedSide) <= 0.018;
  const higherConflict = signed(trend4h, crowdedSide) <= -0.18
    || (signed(trend4h, crowdedSide) <= 0.08 && signed(trend1h, crowdedSide) <= 0.12);
  const highIv = (packet.market.optionsIvPercentile ?? 0) >= 0.72;
  const exhaustionVotes = [fundingCrowded, oiCrowded, flowWeak, bookWeak, higherConflict, highIv].filter(Boolean).length;
  const exhaustionCrowded = exhaustionVotes >= 3;
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const exhaustionFailure = Boolean(currentAtr && (crowdedSide === "LONG"
    ? last.close < last.open && last.close < previous.close && upperWick >= Math.max(body * 0.65, currentAtr * 0.10)
    : last.close > last.open && last.close > previous.close && lowerWick >= Math.max(body * 0.65, currentAtr * 0.10)));
  const exhaustionReversal = exhaustionSide === "SHORT"
    ? last.close < previous.close && last.close <= (previous.high + previous.low) / 2
    : last.close > previous.close && last.close >= (previous.high + previous.low) / 2;
  const exhaustionTrigger = exhaustionMature && exhaustionStretched;
  const exhaustionChecks = [
    { key: "exhaustion-crowding", label: "拥挤/背离证据", passed: exhaustionCrowded, detail: `${exhaustionVotes}/6 · Funding/OI/Flow/Book/HTF/IV` },
    { key: "exhaustion-failure", label: "原方向推进失败", passed: exhaustionFailure, detail: crowdedSide === "LONG" ? "等待冲高转弱" : "等待杀跌转强" },
    { key: "exhaustion-reversal", label: "完整5m反转确认", passed: exhaustionReversal, detail: exhaustionSide === "LONG" ? "向上恢复" : "向下恢复" },
  ];
  const exhaustionSetupScore = (exhaustionMature ? 20 : 0) + (exhaustionStretched ? 22 : 0)
    + (exhaustionCrowded ? 28 : exhaustionVotes * 6) + (exhaustionFailure ? 18 : 0) + (exhaustionReversal ? 12 : 0);
  const exhaustionEvidenceScore = 34 + exhaustionVotes * 9 + (higherConflict ? 12 : 0) + (exhaustionFailure ? 10 : 0);

  // Original Resonance is the direction layer; HT5-R supplies the executable
  // pullback/resume timing. Higher timeframes define the story while 15m/5m
  // only decide whether the current location is executable.
  const resonanceSide = trend4h < 0 ? "SHORT" as const : "LONG" as const;
  const resonanceEma = ema(rows.slice(-60).map((row) => row.close), 20);
  const resonanceBase = rows.slice(-6, -1);
  const resonanceBaseRangeAtr = currentAtr && resonanceBase.length
    ? (Math.max(...resonanceBase.map((row) => row.high)) - Math.min(...resonanceBase.map((row) => row.low))) / currentAtr
    : 99;
  const resonanceStructure = Math.abs(trend4h) >= 0.28 && signed(trend1h, resonanceSide) >= 0.04;
  const resonanceNearMean = Boolean(currentAtr && resonanceEma != null && Math.abs(last.close - resonanceEma) <= currentAtr * 1.45);
  const tacticalTrend = signed(trend15m, resonanceSide);
  const resonanceTactical = tacticalTrend >= -0.42 && tacticalTrend <= 0.58 && resonanceBaseRangeAtr <= 1.65;
  const resonanceBodyAtr = currentAtr ? Math.abs(last.close - last.open) / currentAtr : 0;
  const recoveryBars = rows.slice(-3, -1);
  const resonanceResume = resonanceBodyAtr >= 0.13 && (resonanceSide === "LONG"
    ? last.close > last.open && last.close > Math.max(...recoveryBars.map((bar) => bar.high))
    : last.close < last.open && last.close < Math.min(...recoveryBars.map((bar) => bar.low)));
  const resonanceFlow = signed(packet.market.spotCvdRatio, resonanceSide) >= -0.006
    && signed(packet.market.orderBookImbalance, resonanceSide) >= -0.08;
  const breadth = resonanceSide === "LONG" ? marketContext?.advancingRatio : marketContext?.decliningRatio;
  const resonanceMarket = Number.isFinite(marketContext?.benchmarkMomentum) && Number.isFinite(breadth)
    && signed(marketContext?.benchmarkMomentum, resonanceSide) >= -0.9 && breadth! >= 0.37 && breadth! <= 1;
  const resonanceRegime = ["trend_up", "trend_down", "expansion_up", "expansion_down", "transition"].includes(assetRegime);
  const resonanceTrigger = resonanceStructure && resonanceNearMean && resonanceTactical;
  const resonanceChecks = [
    { key: "resonance-resume", label: "五分钟收盘收复近端结构", passed: resonanceResume, detail: `${resonanceSide === "LONG" ? "需收于前两根最高价之上" : "需收于前两根最低价之下"}，实体 ${resonanceBodyAtr.toFixed(2)} 倍平均波幅` },
    { key: "resonance-flow", label: "现货与订单簿未逆风", passed: resonanceFlow, detail: `Spot ${signed(packet.market.spotCvdRatio, resonanceSide).toFixed(3)} / Book ${signed(packet.market.orderBookImbalance, resonanceSide).toFixed(3)}` },
    { key: "resonance-market", label: "整体市场支持当前方向", passed: resonanceMarket, detail: breadth == null ? "市场广度不可用" : `同向品种占比 ${(breadth * 100).toFixed(0)}%` },
    { key: "resonance-regime", label: "当前行情适合顺势参与", passed: resonanceRegime, detail: assetRegime },
  ];
  const resonanceSetupScore = (resonanceStructure ? 30 : 0) + (resonanceNearMean ? 16 : 0)
    + (resonanceTactical ? 18 : 0) + (resonanceResume ? 22 : 0) + (resonanceFlow ? 10 : 0);
  const resonanceEvidenceScore = 46 + (resonanceFlow ? 18 : -22) + Math.min(16, Math.abs(trend4h) * 24);

  return [
    {
      setup: "VOLUME_FORCE_FAILED_BREAKOUT", label: "量价力度假突破", side: failedSide,
      trigger: failedTrigger, score: clamp(failedSetupScore * 0.58 + failedEvidenceScore * 0.42, 0, 100),
      target1R: 1, target2R: 2.1, maxHoldingMinutes: 120, stopLookback: 8, stopPaddingAtr: 0.20, assetRegime,
      setupChecks: failedChecks,
      evidence: [`成熟边界扫单并收回：${failedTrigger ? "是" : "否"}`, `扫单量能 ${failedSweepVolume.toFixed(2)}x · 区间 ${failedSweepRangeAtr.toFixed(2)} ATR`, `反向确认 ${failedVotes}/6`],
      blockers: [!failedTrigger ? "尚未形成成熟边界扫单并深度收回" : "", ...failedChecks.filter((check) => !check.passed).map((check) => `${check.label}：${check.detail}`)].filter(Boolean),
    },
    {
      setup: "EXHAUSTION_REVERSAL", label: "衰竭反转", side: exhaustionSide,
      trigger: exhaustionTrigger, score: clamp(exhaustionSetupScore * 0.60 + exhaustionEvidenceScore * 0.40, 0, 100),
      target1R: 1, target2R: 2.6, maxHoldingMinutes: 300, stopLookback: 8, stopPaddingAtr: 0.20, assetRegime,
      setupChecks: exhaustionChecks,
      evidence: [`15m成熟度 ${Math.abs(exhaustionTrend).toFixed(2)} · 延伸 ${exhaustionStretch.toFixed(2)} ATR`, `拥挤/背离 ${exhaustionVotes}/6`, `推进失败与5m反转：${exhaustionFailure && exhaustionReversal ? "是" : "否"}`],
      blockers: [!exhaustionMature ? "短周期趋势尚未成熟" : "", !exhaustionStretched ? "价格尚未形成ATR级衰竭" : "", ...exhaustionChecks.filter((check) => !check.passed).map((check) => `${check.label}：${check.detail}`)].filter(Boolean),
    },
    {
      setup: "MULTI_TIMEFRAME_RESONANCE", label: "多周期综合共振", side: resonanceSide,
      trigger: resonanceTrigger, score: clamp(resonanceSetupScore * 0.58 + resonanceEvidenceScore * 0.42, 0, 100),
      target1R: 1, target2R: 3.0, maxHoldingMinutes: 480, stopLookback: 14, stopPaddingAtr: 0.22,
      assetRegime, setupChecks: resonanceChecks,
      evidence: [`4h主方向 ${trend4h.toFixed(2)} · 1h同向 ${signed(trend1h, resonanceSide).toFixed(2)}`, `位置距均值可执行：${resonanceNearMean && resonanceTactical ? "是" : "否"}`, `完整5m恢复：${resonanceResume ? "是" : "否"}`],
      blockers: [!resonanceStructure ? "4h与1h主故事尚未一致" : "", !resonanceNearMean || !resonanceTactical ? "等待回到可执行位置" : "", ...resonanceChecks.filter((check) => !check.passed).map((check) => `${check.label}：${check.detail}`)].filter(Boolean),
    },
  ];
}

export function buildDirectMarketCandidate(input: {
  packet: MarketAnalysisPacket;
  candles: Hte31Candle[];
  btcCandles: Hte31Candle[];
  volumeRank: number;
  batchId: string;
  marketContext?: MarketContext;
}): DirectMarketCandidate {
  const { packet } = input;
  const candles = completedCandles(input.candles, packet.observedAt);
  if (candles.length < 2) throw new Error("完整五分钟K线不足，不能形成入场判断");
  const price = packet.market.futuresPrice;
  const marketLocation = location(candles, price);
  const currentAtr = atr(candles);
  const atrPct = currentAtr && price > 0 ? currentAtr / price * 100 : null;
  const setupEvaluations = evaluateCoreSetups(packet, candles, input.marketContext);
  const macroRisk = packet.market.macroEventRisk ?? 0;
  const scoredSetups = setupEvaluations.map((setup) => {
    const stopWindow = candles.slice(-setup.stopLookback);
    const stopPadding = (currentAtr ?? 0) * setup.stopPaddingAtr;
    const structuralStop = setup.side === "LONG"
      ? Math.min(...stopWindow.map((row) => row.low)) - stopPadding
      : Math.max(...stopWindow.map((row) => row.high)) + stopPadding;
    const stopDistance = (setup.side === "LONG" ? 1 : -1) * (price - structuralStop);
    // Structure owns the stop. An unaffordable/invalid plan must be rejected,
    // never moved inside its swing just to fit a percentage limit.
    const structuralRiskValid = Number.isFinite(structuralStop) && structuralStop > 0
      && price > 0 && stopDistance > 0 && stopDistance / price <= 0.05;
    const directionalScore = clamp((setup.side === "LONG" ? 1 : -1) * (0.28 + setup.score / 145), -1, 1);
    const paths = normalizedPaths(directionalScore);
    const directionalProbability = setup.side === "LONG" ? paths.up : paths.down;
    const confidence = Math.round(clamp(setup.score * 0.78 + packet.decision.dataQuality * 22, 0, 99));
    const netEdgeR = directionalProbability / 100 * setup.target2R
      - (setup.side === "LONG" ? paths.down : paths.up) / 100
      - paths.rangeOrInvalid / 100 * 0.22;
    const checks = [
      { key: "setup", label: "核心打法触发", passed: setup.trigger, detail: `${setup.label} · ${setup.score.toFixed(0)}分` },
      ...setup.setupChecks,
      { key: "data", label: "数据完整", passed: packet.decision.dataQuality >= 0.72 && candles.length >= 48, detail: `质量 ${Math.round(packet.decision.dataQuality * 100)}% · 完整5m K线 ${candles.length}` },
      { key: "liquidity", label: "流动性安全", passed: (packet.market.volumeUsd ?? 0) >= 12_000_000, detail: `${((packet.market.volumeUsd ?? 0) / 1_000_000).toFixed(1)}M USDT/24h` },
      { key: "funding", label: "杠杆拥挤安全", passed: Math.abs(packet.market.fundingRate ?? 0) < 0.0015, detail: `${((packet.market.fundingRate ?? 0) * 100).toFixed(4)}%` },
      { key: "macro", label: "宏观事件风险", passed: macroRisk < 0.85, detail: `${Math.round(macroRisk * 100)}%` },
      { key: "edge", label: "结构期望", passed: netEdgeR >= 0.55, detail: `${netEdgeR.toFixed(2)}R` },
      { key: "volatility", label: "波动可执行", passed: atrPct != null && atrPct >= 0.15 && atrPct <= 3.2, detail: atrPct == null ? "ATR不可用" : `ATR ${atrPct.toFixed(2)}%` },
      { key: "structural-stop", label: "真实结构止损可执行", passed: structuralRiskValid, detail: `距离 ${(stopDistance / price * 100).toFixed(2)}%，超出5%则放弃，不向内压缩止损` },
    ];
    return { ...setup, structuralStop, stopDistance, directionalScore, paths, confidence, netEdgeR, checks, qualified: checks.every((check) => check.passed) && confidence >= 70 };
  });
  const selectedSetup = [...scoredSetups].sort((left, right) => Number(right.qualified) - Number(left.qualified)
    || Number(right.trigger) - Number(left.trigger)
    || right.score - left.score)[0];
  const { directionalScore, paths, confidence, netEdgeR, checks } = selectedSetup;
  const btcCorrelation = packet.symbol === "BTC_USDT" ? 1 : pearsonCorrelation(candles, completedCandles(input.btcCandles, packet.observedAt));
  const riskClusterId = btcCorrelation == null
    ? "btc-correlation-unavailable"
    : Math.abs(btcCorrelation) >= 0.8 ? `btc-${btcCorrelation >= 0 ? "positive" : "inverse"}` : `independent-${packet.symbol}`;
  const { structuralStop, stopDistance } = selectedSetup;
  const entryHalfWidth = Math.min(stopDistance * 0.12, price * 0.0015);
  const entryZone: [number, number] = [price - entryHalfWidth, price + entryHalfWidth];
  const targets = selectedSetup.side === "LONG"
    ? [price + stopDistance * selectedSetup.target1R, price + stopDistance * selectedSetup.target2R]
    : [price - stopDistance * selectedSetup.target1R, price - stopDistance * selectedSetup.target2R];
  const ready = selectedSetup.qualified;
  const evidence = [
    `${selectedSetup.label} · 只在完整5m证据成立后触发`,
    ...selectedSetup.evidence,
    `路径概率 上 ${paths.up.toFixed(1)}% / 下 ${paths.down.toFixed(1)}% / 震荡或失效 ${paths.rangeOrInvalid.toFixed(1)}%`,
    `24h成交额排名 ${input.volumeRank}，数据质量 ${Math.round(packet.decision.dataQuality * 100)}%`,
  ];
  const counterEvidence = [...selectedSetup.blockers, ...checks.filter((check) => !check.passed).map((check) => `${check.label}：${check.detail}`)];
  return {
    symbol: packet.symbol,
    batchId: input.batchId,
    observedAt: packet.observedAt,
    freshness: Date.now() - packet.observedAt <= 90_000 ? "FRESH" : "STALE",
    scanStage: "DEEP",
    volumeRank: input.volumeRank,
    volumeUsd: packet.market.volumeUsd,
    riskClusterId,
    btcCorrelation,
    location: marketLocation,
    paths,
    directionalScore,
    netEdgeR,
    confidence,
    setup: selectedSetup.setup,
    setupLabel: selectedSetup.label,
    setupScore: selectedSetup.score,
    setupEvaluations: scoredSetups.map((setup) => ({
      setup: setup.setup,
      setupLabel: setup.label,
      side: setup.side,
      score: setup.score,
      triggered: setup.trigger,
      qualified: setup.qualified,
      selected: setup.setup === selectedSetup.setup,
      blockers: [...new Set([
        ...setup.blockers,
        ...setup.checks.filter((check) => !check.passed).map((check) => `${check.label}：${check.detail}`),
        ...(setup.confidence < 70 ? [`置信度不足：${setup.confidence}% / 要求 70%`] : []),
      ])],
    })),
    decision: ready ? selectedSetup.side : "WAIT",
    entryZone: ready ? entryZone : null,
    invalidationPrice: ready ? structuralStop : null,
    targets: ready ? targets : [],
    evidence,
    counterEvidence: [...new Set(counterEvidence)],
    checks,
    candles5m: candles.slice(-96),
    assetRegime: selectedSetup.assetRegime,
    maxHoldingMinutes: selectedSetup.maxHoldingMinutes,
  };
}

export function directCandidateSummary(candidate: DirectMarketCandidate) {
  return `${DIRECT_MARKET_BRAIN_VERSION} · ${candidate.setupLabel} · ${candidate.location} · 上${candidate.paths.up.toFixed(1)}%/下${candidate.paths.down.toFixed(1)}%/震荡或失效${candidate.paths.rangeOrInvalid.toFixed(1)}%`;
}
