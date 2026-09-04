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
  const failedVolume = currentVolumeRatio >= 1.05;
  const failedForce = failedFlow >= 0.012 || signed(packet.market.orderBookImbalance, failedSide) >= 0.04;
  const failedTrigger = (highSweep || lowSweep) && failedVolume && failedForce;
  const failedScore = clamp(35 + (highSweep || lowSweep ? 28 : 0) + Math.min(18, currentVolumeRatio * 8) + Math.min(19, Math.max(0, failedFlow) * 240), 0, 100);

  const upBreakout = last.close > priorHigh && last.close > last.open;
  const downBreakout = last.close < priorLow && last.close < last.open;
  const trendSide = downBreakout ? "SHORT" as const : "LONG" as const;
  const trendAligned = [trend15m, trend1h, trend4h].filter((value) => signed(value, trendSide) >= 0.10).length;
  const trendFlow = signed(flow, trendSide);
  const trendOverheated = trendSide === "LONG"
    ? (currentRsi ?? 50) > 72 || change24h > 12 || (liquidation > 0.45 && change24h > 7)
    : (currentRsi ?? 50) < 28 || change24h < -12 || (liquidation < -0.45 && change24h < -7);
  const trendTrigger = (upBreakout || downBreakout) && trendAligned >= 2 && currentVolumeRatio >= 1.12 && trendFlow >= 0 && !trendOverheated;
  const trendScore = clamp(28 + (upBreakout || downBreakout ? 25 : 0) + trendAligned * 10 + Math.min(12, currentVolumeRatio * 6) + Math.min(10, Math.max(0, trendFlow) * 150) - (trendOverheated ? 35 : 0), 0, 100);

  const stretchedUp = change24h >= 4.5 || (currentRsi ?? 50) >= 74 || liquidation >= 0.4;
  const stretchedDown = change24h <= -4.5 || (currentRsi ?? 50) <= 26 || liquidation <= -0.4;
  const exhaustionSide = stretchedDown ? "LONG" as const : "SHORT" as const;
  const candleRange = Math.max(last.high - last.low, Number.EPSILON);
  const upperRejection = (last.high - Math.max(last.open, last.close)) / candleRange >= 0.32 && last.close < last.open;
  const lowerRejection = (Math.min(last.open, last.close) - last.low) / candleRange >= 0.32 && last.close > last.open;
  const exhaustionRejection = exhaustionSide === "LONG" ? lowerRejection : upperRejection;
  const reversalFlow = signed(flow, exhaustionSide);
  const exhaustionTrigger = (stretchedUp || stretchedDown) && (exhaustionRejection || reversalFlow >= 0.025) && currentVolumeRatio >= 0.9;
  const exhaustionScore = clamp(30 + (stretchedUp || stretchedDown ? 24 : 0) + (exhaustionRejection ? 20 : 0) + Math.min(16, Math.abs(change24h) * 1.5) + Math.min(10, Math.max(0, reversalFlow) * 180), 0, 100);

  return [
    {
      setup: "VOLUME_FORCE_FAILED_BREAKOUT", label: "量价力度假突破", side: failedSide,
      trigger: failedTrigger, score: failedScore, volumeMinimum: 1.05, target1R: 1.25, target2R: 2.5, maxHoldingMinutes: 120,
      evidence: [`扫过区间边界后收回：${highSweep || lowSweep ? "是" : "否"}`, `量能 ${currentVolumeRatio.toFixed(2)}x`, `反向力度 ${failedFlow.toFixed(3)}`],
      blockers: [!highSweep && !lowSweep ? "尚未形成边界扫单并收回" : "", !failedVolume ? "假突破量能不足" : "", !failedForce ? "反向现货流/订单簿力度不足" : ""].filter(Boolean),
    },
    {
      setup: "EXHAUSTION_REVERSAL", label: "衰竭反转", side: exhaustionSide,
      trigger: exhaustionTrigger, score: exhaustionScore, volumeMinimum: 0.9, target1R: 1.2, target2R: 2.2, maxHoldingMinutes: 100,
      evidence: [`24h位移 ${change24h.toFixed(2)}% · RSI ${currentRsi?.toFixed(1) ?? "--"}`, `拒绝K线：${exhaustionRejection ? "是" : "否"}`, `反转资金流 ${reversalFlow.toFixed(3)}`],
      blockers: [!stretchedUp && !stretchedDown ? "价格尚未形成可验证衰竭" : "", !exhaustionRejection && reversalFlow < 0.025 ? "缺少拒绝K线或反转资金流" : "", currentVolumeRatio < 0.9 ? "反转量能不足" : ""].filter(Boolean),
    },
    {
      setup: "DENNIS_TREND_BREAKOUT", label: "经典趋势突破", side: trendSide,
      trigger: trendTrigger, score: trendScore, volumeMinimum: 1.12, target1R: 1.45, target2R: 3.2, maxHoldingMinutes: 360,
      evidence: [`完整5m收盘突破：${upBreakout || downBreakout ? "是" : "否"}`, `周期共振 ${trendAligned}/3 · 量能 ${currentVolumeRatio.toFixed(2)}x`, `同向资金流 ${trendFlow.toFixed(3)}`],
      blockers: [!upBreakout && !downBreakout ? "完整5m尚未收在旧区间外" : "", trendAligned < 2 ? "高低周期没有形成共振" : "", currentVolumeRatio < 1.12 ? "突破量能不足" : "", trendFlow < 0 ? "现货流与突破方向相反" : "", trendOverheated ? "RSI/24h位移/清算显示追价风险" : ""].filter(Boolean),
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
    assetRegime: selectedSetup.setup === "DENNIS_TREND_BREAKOUT"
      ? selectedSetup.side === "LONG" ? "trend_up" : "trend_down"
      : selectedSetup.setup === "EXHAUSTION_REVERSAL" ? "leverage_liquidation" : "transition",
    maxHoldingMinutes: selectedSetup.maxHoldingMinutes,
  };
}

export function directCandidateSummary(candidate: DirectMarketCandidate) {
  return `${DIRECT_MARKET_BRAIN_VERSION} · ${candidate.setupLabel} · ${candidate.location} · 上${candidate.paths.up.toFixed(1)}%/下${candidate.paths.down.toFixed(1)}%/震荡或失效${candidate.paths.rangeOrInvalid.toFixed(1)}%`;
}
