import type { MarketAnalysisPacket } from "./exchange-market.ts";
import {
  DIRECT_MARKET_BRAIN_VERSION,
  type DirectMarketCandidate,
  type DirectMarketLocation,
} from "./direct-market-types.ts";
import type { Hte31Candle } from "./hte31-types.ts";

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
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
  const rangeOrInvalid = Math.round((100 - up - down) * 10) / 10;
  return { up, down, rangeOrInvalid };
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

export function buildDirectMarketCandidate(input: {
  packet: MarketAnalysisPacket;
  candles: Hte31Candle[];
  btcCandles: Hte31Candle[];
  volumeRank: number;
  batchId: string;
}): DirectMarketCandidate {
  const { packet, candles } = input;
  const price = packet.market.futuresPrice;
  const currentAtr = atr(candles);
  const atrPct = currentAtr && price > 0 ? currentAtr / price * 100 : null;
  const trend15m = packet.market.timeframeTrend15m ?? 0;
  const trend1h = packet.market.timeframeTrend1h ?? 0;
  const trend4h = packet.market.timeframeTrend4h ?? 0;
  const flow = (packet.market.spotCvdRatio ?? 0) * 0.55 + (packet.market.orderBookImbalance ?? 0) * 0.45;
  const crowding = clamp((packet.market.fundingRate ?? 0) / 0.001, -1, 1);
  const directionalScore = clamp(
    trend4h * 0.34 + trend1h * 0.27 + trend15m * 0.16 + clamp(flow * 2.4, -1, 1) * 0.17 - crowding * 0.06,
    -1,
    1,
  );
  const paths = normalizedPaths(directionalScore);
  const side = directionalScore >= 0 ? "LONG" as const : "SHORT" as const;
  const directionalProbability = side === "LONG" ? paths.up : paths.down;
  const confidence = Math.round(clamp(directionalProbability + packet.decision.dataQuality * 18, 0, 99));
  const netEdgeR = directionalProbability / 100 * 2.8
    - (side === "LONG" ? paths.down : paths.up) / 100
    - paths.rangeOrInvalid / 100 * 0.22;
  const btcCorrelation = packet.symbol === "BTC_USDT" ? 1 : pearsonCorrelation(candles, input.btcCandles);
  const riskClusterId = btcCorrelation == null
    ? "btc-correlation-unavailable"
    : Math.abs(btcCorrelation) >= 0.8
      ? `btc-${btcCorrelation >= 0 ? "positive" : "inverse"}`
      : `independent-${packet.symbol}`;
  const aligned = [trend15m, trend1h, trend4h].filter((value) => Math.sign(value) === Math.sign(directionalScore) && Math.abs(value) >= 0.08).length;
  const recent = candles.slice(-72);
  const swingLow = recent.length ? Math.min(...recent.map((row) => row.low)) : price;
  const swingHigh = recent.length ? Math.max(...recent.map((row) => row.high)) : price;
  const rawRisk = Math.max(currentAtr ? currentAtr * 1.25 : price * 0.006, price * 0.0035);
  const maximumRisk = price * 0.03;
  const riskDistance = Math.min(maximumRisk, rawRisk);
  const structuralStop = side === "LONG"
    ? Math.max(price - maximumRisk, Math.min(price - riskDistance, swingLow))
    : Math.min(price + maximumRisk, Math.max(price + riskDistance, swingHigh));
  const stopDistance = Math.abs(price - structuralStop);
  const entryHalfWidth = Math.min(stopDistance * 0.12, price * 0.0015);
  const entryZone: [number, number] = [price - entryHalfWidth, price + entryHalfWidth];
  const targets = side === "LONG"
    ? [price + stopDistance * 1.4, price + stopDistance * 2.8]
    : [price - stopDistance * 1.4, price - stopDistance * 2.8];
  const checks = [
    { key: "data", label: "数据完整", passed: packet.decision.dataQuality >= 0.72 && candles.length >= 48, detail: `质量 ${Math.round(packet.decision.dataQuality * 100)}% · 5m K线 ${candles.length}` },
    { key: "direction", label: "方向优势", passed: Math.abs(directionalScore) >= 0.30, detail: `方向分 ${directionalScore.toFixed(2)}` },
    { key: "timeframes", label: "周期共振", passed: aligned >= 2, detail: `${aligned}/3 个周期同向` },
    { key: "edge", label: "扣费后期望", passed: netEdgeR >= 0.55, detail: `${netEdgeR.toFixed(2)}R` },
    { key: "volatility", label: "波动可执行", passed: atrPct != null && atrPct >= 0.15 && atrPct <= 3.2, detail: atrPct == null ? "ATR不可用" : `ATR ${atrPct.toFixed(2)}%` },
  ];
  const ready = checks.every((check) => check.passed) && confidence >= 70;
  const evidence = [
    `${aligned}/3 个周期与${side === "LONG" ? "上涨" : "下跌"}方向一致`,
    `路径概率 上 ${paths.up.toFixed(1)}% / 下 ${paths.down.toFixed(1)}% / 震荡或失效 ${paths.rangeOrInvalid.toFixed(1)}%`,
    `24h成交额排名 ${input.volumeRank}，数据质量 ${Math.round(packet.decision.dataQuality * 100)}%`,
  ];
  const counterEvidence = checks.filter((check) => !check.passed).map((check) => `${check.label}：${check.detail}`);
  if (Math.abs(crowding) >= 0.65) counterEvidence.push(`资金费率拥挤 ${((packet.market.fundingRate ?? 0) * 100).toFixed(3)}%`);
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
    location: location(candles, price),
    paths,
    directionalScore,
    netEdgeR,
    confidence,
    decision: ready ? side : "WAIT",
    entryZone: ready ? entryZone : null,
    invalidationPrice: ready ? structuralStop : null,
    targets: ready ? targets : [],
    evidence,
    counterEvidence,
    checks,
    candles5m: candles.slice(-96),
    assetRegime: Math.abs(directionalScore) < 0.3 ? "range" : directionalScore > 0 ? "trend_up" : "trend_down",
    maxHoldingMinutes: 8 * 60,
  };
}

export function directCandidateSummary(candidate: DirectMarketCandidate) {
  return `${DIRECT_MARKET_BRAIN_VERSION} · ${candidate.location} · 上${candidate.paths.up.toFixed(1)}%/下${candidate.paths.down.toFixed(1)}%/震荡或失效${candidate.paths.rangeOrInvalid.toFixed(1)}%`;
}
