import type { MarketAnalysisPacket } from "./exchange-market.ts";
import {
  DIRECT_MARKET_BRAIN_VERSION,
  type DirectCoreSetup,
  type DirectMarketCandidate,
  type DirectMarketLocation,
  type DirectMarketSide,
} from "./direct-market-types.ts";
import type { Hte31Candle } from "./hte31-types.ts";

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
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

function rsi(candles: Hte31Candle[], period = 14) {
  if (candles.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  const rows = candles.slice(-(period + 1));
  for (let index = 1; index < rows.length; index += 1) {
    const change = rows[index].close - rows[index - 1].close;
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  if (losses <= Number.EPSILON) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function volumeRatio(candles: Hte31Candle[]) {
  if (candles.length < 24) return null;
  const baseline = mean(candles.slice(-24, -2).map((row) => row.volume));
  return Math.max(candles.at(-1)!.volume, candles.at(-2)!.volume) / Math.max(baseline, Number.EPSILON);
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
  volumeMinimum: number;
  target1R: number;
  target2R: number;
  maxHoldingMinutes: number;
  evidence: string[];
  blockers: string[];
};

function evaluateCoreSetups(packet: MarketAnalysisPacket, candles: Hte31Candle[]): SetupEvaluation[] {
  const rows = candles.slice(-96);
  const last = rows.at(-1)!;
  const previous = rows.at(-2)!;
  const reference = rows.slice(-26, -2);
  const priorHigh = Math.max(...reference.map((row) => row.high));
  const priorLow = Math.min(...reference.map((row) => row.low));
  const currentRsi = rsi(rows);
  const currentVolumeRatio = volumeRatio(rows) ?? 0;
  const flow = (packet.market.spotCvdRatio ?? 0) * 0.55 + (packet.market.orderBookImbalance ?? 0) * 0.45;
  const trend15m = packet.market.timeframeTrend15m ?? 0;
  const trend1h = packet.market.timeframeTrend1h ?? 0;
  const trend4h = packet.market.timeframeTrend4h ?? 0;
  const change24h = packet.market.changePercentage ?? 0;
  const liquidation = packet.market.liquidationImbalance ?? 0;

  const highSweep = previous.high > priorHigh && last.close < priorHigh && last.close < previous.close;
  const lowSweep = previous.low < priorLow && last.close > priorLow && last.close > previous.close;
  const failedSide = lowSweep ? "LONG" as const : "SHORT" as const;
  const failedFlow = signed(flow, failedSide);
  const failedVolume = currentVolumeRatio >= 1.0;
  const failedForce = failedFlow >= 0.010 || signed(packet.market.orderBookImbalance, failedSide) >= 0.035;
  const failedTrigger = (highSweep || lowSweep) && failedVolume && failedForce;
  const failedScore = clamp(35 + (highSweep || lowSweep ? 28 : 0) + Math.min(18, currentVolumeRatio * 8) + Math.min(19, Math.max(0, failedFlow) * 240), 0, 100);

  const weightedTrend = trend15m * 0.25 + trend1h * 0.35 + trend4h * 0.40;
  const resonanceSide = weightedTrend < 0 ? "SHORT" as const : "LONG" as const;
  const resonanceAligned = [trend15m, trend1h, trend4h].filter((value) => signed(value, resonanceSide) >= 0.08).length;
  const higherTimeframeConflict = signed(trend1h, resonanceSide) < -0.08 || signed(trend4h, resonanceSide) < -0.08;
  const fiveMinuteConfirmation = resonanceSide === "LONG"
    ? last.close > last.open && last.close > previous.close
    : last.close < last.open && last.close < previous.close;
  const fiveMinuteResume = resonanceSide === "LONG"
    ? last.close > mean(rows.slice(-8).map((row) => row.close))
    : last.close < mean(rows.slice(-8).map((row) => row.close));
  const resonanceFlow = signed(flow, resonanceSide);
  const resonanceOverheated = resonanceSide === "LONG"
    ? (currentRsi ?? 50) > 72 || change24h > 12 || (liquidation > 0.45 && change24h > 7)
    : (currentRsi ?? 50) < 28 || change24h < -12 || (liquidation < -0.45 && change24h < -7);
  const resonanceTrigger = Math.abs(weightedTrend) >= 0.14
    && resonanceAligned >= 2
    && !higherTimeframeConflict
    && fiveMinuteConfirmation
    && fiveMinuteResume
    && currentVolumeRatio >= 0.92
    && resonanceFlow >= -0.004
    && !resonanceOverheated;
  const resonanceScore = clamp(
    24
      + resonanceAligned * 12
      + Math.min(18, Math.abs(weightedTrend) * 22)
      + (fiveMinuteConfirmation ? 12 : 0)
      + (fiveMinuteResume ? 8 : 0)
      + Math.min(10, currentVolumeRatio * 5)
      + Math.min(8, Math.max(0, resonanceFlow) * 140)
      - (higherTimeframeConflict ? 30 : 0)
      - (resonanceOverheated ? 35 : 0),
    0,
    100,
  );

  const stretchedUp = change24h >= 4 || (currentRsi ?? 50) >= 72 || liquidation >= 0.35;
  const stretchedDown = change24h <= -4 || (currentRsi ?? 50) <= 28 || liquidation <= -0.35;
  const exhaustionSide = stretchedDown ? "LONG" as const : "SHORT" as const;
  const candleRange = Math.max(last.high - last.low, Number.EPSILON);
  const upperRejection = (last.high - Math.max(last.open, last.close)) / candleRange >= 0.32 && last.close < last.open;
  const lowerRejection = (Math.min(last.open, last.close) - last.low) / candleRange >= 0.32 && last.close > last.open;
  const exhaustionRejection = exhaustionSide === "LONG" ? lowerRejection : upperRejection;
  const reversalFlow = signed(flow, exhaustionSide);
  const exhaustionTrigger = (stretchedUp || stretchedDown) && (exhaustionRejection || reversalFlow >= 0.020) && currentVolumeRatio >= 0.85;
  const exhaustionScore = clamp(30 + (stretchedUp || stretchedDown ? 24 : 0) + (exhaustionRejection ? 20 : 0) + Math.min(16, Math.abs(change24h) * 1.5) + Math.min(10, Math.max(0, reversalFlow) * 180), 0, 100);

  return [
    {
      setup: "VOLUME_FORCE_FAILED_BREAKOUT", label: "量价力度假突破", side: failedSide,
      trigger: failedTrigger, score: failedScore, volumeMinimum: 1.0, target1R: 1.25, target2R: 2.5, maxHoldingMinutes: 120,
      evidence: [`扫过区间边界后收回：${highSweep || lowSweep ? "是" : "否"}`, `量能 ${currentVolumeRatio.toFixed(2)}x`, `反向力度 ${failedFlow.toFixed(3)}`],
      blockers: [!highSweep && !lowSweep ? "尚未形成边界扫单并收回" : "", !failedVolume ? "假突破量能不足" : "", !failedForce ? "反向现货流/订单簿力度不足" : ""].filter(Boolean),
    },
    {
      setup: "EXHAUSTION_REVERSAL", label: "衰竭反转", side: exhaustionSide,
      trigger: exhaustionTrigger, score: exhaustionScore, volumeMinimum: 0.85, target1R: 1.2, target2R: 2.2, maxHoldingMinutes: 100,
      evidence: [`24h位移 ${change24h.toFixed(2)}% · RSI ${currentRsi?.toFixed(1) ?? "--"}`, `拒绝K线：${exhaustionRejection ? "是" : "否"}`, `反转资金流 ${reversalFlow.toFixed(3)}`],
      blockers: [!stretchedUp && !stretchedDown ? "价格尚未形成可验证衰竭" : "", !exhaustionRejection && reversalFlow < 0.020 ? "缺少拒绝K线或反转资金流" : "", currentVolumeRatio < 0.85 ? "反转量能不足" : ""].filter(Boolean),
    },
    {
      setup: "MULTI_TIMEFRAME_RESONANCE", label: "多周期综合共振", side: resonanceSide,
      trigger: resonanceTrigger, score: resonanceScore, volumeMinimum: 0.92, target1R: 1.3, target2R: 2.6, maxHoldingMinutes: 240,
      evidence: [`15m/1h/4h 共振 ${resonanceAligned}/3`, `完整5m确认并恢复：${fiveMinuteConfirmation && fiveMinuteResume ? "是" : "否"}`, `量能 ${currentVolumeRatio.toFixed(2)}x · 同向资金流 ${resonanceFlow.toFixed(3)}`],
      blockers: [Math.abs(weightedTrend) < 0.14 || resonanceAligned < 2 ? "多周期方向尚未形成共振" : "", higherTimeframeConflict ? "1h或4h仍与主方向冲突" : "", !fiveMinuteConfirmation || !fiveMinuteResume ? "完整5m尚未确认恢复" : "", currentVolumeRatio < 0.92 ? "共振量能不足" : "", resonanceFlow < -0.004 ? "现货流与共振方向明显相反" : "", resonanceOverheated ? "RSI/24h位移/清算显示追价风险" : ""].filter(Boolean),
    },
  ];
}

export function buildDirectMarketCandidate(input: {
  packet: MarketAnalysisPacket;
  candles: Hte31Candle[];
  btcCandles: Hte31Candle[];
  volumeRank: number;
  batchId: string;
}): DirectMarketCandidate {
  const { packet, candles } = input;
  const price = packet.market.futuresPrice;
  const marketLocation = location(candles, price);
  const currentAtr = atr(candles);
  const atrPct = currentAtr && price > 0 ? currentAtr / price * 100 : null;
  const setupEvaluations = evaluateCoreSetups(packet, candles);
  const selectedSetup = [...setupEvaluations].sort((left, right) => Number(right.trigger) - Number(left.trigger) || right.score - left.score)[0];
  const directionalScore = clamp((selectedSetup.side === "LONG" ? 1 : -1) * (0.28 + selectedSetup.score / 145), -1, 1);
  const paths = normalizedPaths(directionalScore);
  const directionalProbability = selectedSetup.side === "LONG" ? paths.up : paths.down;
  const confidence = Math.round(clamp(selectedSetup.score * 0.78 + packet.decision.dataQuality * 22, 0, 99));
  const netEdgeR = directionalProbability / 100 * selectedSetup.target2R
    - (selectedSetup.side === "LONG" ? paths.down : paths.up) / 100
    - paths.rangeOrInvalid / 100 * 0.22;
  const btcCorrelation = packet.symbol === "BTC_USDT" ? 1 : pearsonCorrelation(candles, input.btcCandles);
  const riskClusterId = btcCorrelation == null
    ? "btc-correlation-unavailable"
    : Math.abs(btcCorrelation) >= 0.8 ? `btc-${btcCorrelation >= 0 ? "positive" : "inverse"}` : `independent-${packet.symbol}`;
  const recent = candles.slice(-72);
  const swingLow = recent.length ? Math.min(...recent.map((row) => row.low)) : price;
  const swingHigh = recent.length ? Math.max(...recent.map((row) => row.high)) : price;
  const rawRisk = Math.max(currentAtr ? currentAtr * 1.25 : price * 0.006, price * 0.0035);
  const maximumRisk = price * 0.03;
  const riskDistance = Math.min(maximumRisk, rawRisk);
  const structuralStop = selectedSetup.side === "LONG"
    ? Math.max(price - maximumRisk, Math.min(price - riskDistance, swingLow))
    : Math.min(price + maximumRisk, Math.max(price + riskDistance, swingHigh));
  const stopDistance = Math.abs(price - structuralStop);
  const entryHalfWidth = Math.min(stopDistance * 0.12, price * 0.0015);
  const entryZone: [number, number] = [price - entryHalfWidth, price + entryHalfWidth];
  const targets = selectedSetup.side === "LONG"
    ? [price + stopDistance * selectedSetup.target1R, price + stopDistance * selectedSetup.target2R]
    : [price - stopDistance * selectedSetup.target1R, price - stopDistance * selectedSetup.target2R];
  const currentVolumeRatio = volumeRatio(candles) ?? 0;
  const macroRisk = packet.market.macroEventRisk ?? 0;
  const checks = [
    { key: "setup", label: "核心打法触发", passed: selectedSetup.trigger, detail: `${selectedSetup.label} · ${selectedSetup.score.toFixed(0)}分` },
    { key: "data", label: "数据完整", passed: packet.decision.dataQuality >= 0.72 && candles.length >= 48, detail: `质量 ${Math.round(packet.decision.dataQuality * 100)}% · 完整5m K线 ${candles.length}` },
    { key: "liquidity", label: "流动性安全", passed: (packet.market.volumeUsd ?? 0) >= 12_000_000, detail: `${((packet.market.volumeUsd ?? 0) / 1_000_000).toFixed(1)}M USDT/24h` },
    { key: "volume", label: "量能硬确认", passed: currentVolumeRatio >= selectedSetup.volumeMinimum, detail: `${currentVolumeRatio.toFixed(2)}x / 要求 ${selectedSetup.volumeMinimum.toFixed(2)}x` },
    { key: "funding", label: "杠杆拥挤安全", passed: Math.abs(packet.market.fundingRate ?? 0) < 0.0015, detail: `${((packet.market.fundingRate ?? 0) * 100).toFixed(4)}%` },
    { key: "macro", label: "宏观事件风险", passed: macroRisk < 0.85, detail: `${Math.round(macroRisk * 100)}%` },
    { key: "edge", label: "结构期望", passed: netEdgeR >= 0.55, detail: `${netEdgeR.toFixed(2)}R` },
    { key: "volatility", label: "波动可执行", passed: atrPct != null && atrPct >= 0.15 && atrPct <= 3.2, detail: atrPct == null ? "ATR不可用" : `ATR ${atrPct.toFixed(2)}%` },
  ];
  const ready = checks.every((check) => check.passed) && confidence >= 70;
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
    decision: ready ? selectedSetup.side : "WAIT",
    entryZone: ready ? entryZone : null,
    invalidationPrice: ready ? structuralStop : null,
    targets: ready ? targets : [],
    evidence,
    counterEvidence: [...new Set(counterEvidence)],
    checks,
    candles5m: candles.slice(-96),
    assetRegime: selectedSetup.setup === "MULTI_TIMEFRAME_RESONANCE"
      ? selectedSetup.side === "LONG" ? "trend_up" : "trend_down"
      : selectedSetup.setup === "EXHAUSTION_REVERSAL" ? "leverage_liquidation" : "transition",
    maxHoldingMinutes: selectedSetup.maxHoldingMinutes,
  };
}

export function directCandidateSummary(candidate: DirectMarketCandidate) {
  return `${DIRECT_MARKET_BRAIN_VERSION} · ${candidate.setupLabel} · ${candidate.location} · 上${candidate.paths.up.toFixed(1)}%/下${candidate.paths.down.toFixed(1)}%/震荡或失效${candidate.paths.rangeOrInvalid.toFixed(1)}%`;
}
