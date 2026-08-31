import type { Hte31Candle } from "./hte31-types.ts";

export type ResonanceBias = "LONG" | "SHORT" | "NEUTRAL";

export type HistoricalAnalog = {
  label: "短线" | "波段" | "大周期";
  sampleCount: number;
  bias: ResonanceBias;
  confidence: number;
  bullishRatio: number;
  bearishRatio: number;
  neutralRatio: number;
  medianForwardPct: number;
  averageSimilarity: number;
};

export type ResonanceMarketMemory = {
  short: HistoricalAnalog;
  swing: HistoricalAnalog;
  cycle: HistoricalAnalog;
  combinedBias: ResonanceBias;
  combinedConfidence: number;
  summary: string;
};

type AnalogOptions = {
  label: HistoricalAnalog["label"];
  windowSize: number;
  horizon: number;
  topK: number;
  neutralThresholdPct: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function normalizedPath(candles: Hte31Candle[]) {
  const base = candles[0]?.close ?? 0;
  if (!(base > 0)) return [];
  return candles.map((candle) => candle.close / base - 1);
}

function realizedVolatility(candles: Hte31Candle[]) {
  const returns: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1].close;
    const current = candles[index].close;
    if (previous > 0 && current > 0) returns.push(current / previous - 1);
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  return Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length);
}

function pathDistance(current: Hte31Candle[], candidate: Hte31Candle[]) {
  const a = normalizedPath(current);
  const b = normalizedPath(candidate);
  if (!a.length || a.length !== b.length) return Number.POSITIVE_INFINITY;
  const rmse = Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0) / a.length);
  const currentVol = realizedVolatility(current);
  const candidateVol = realizedVolatility(candidate);
  const volatilityPenalty = Math.abs(currentVol - candidateVol) / Math.max(currentVol, candidateVol, 0.0005) * 0.01;
  return rmse + volatilityPenalty;
}

export function buildHistoricalAnalog(candles: Hte31Candle[], options: AnalogOptions): HistoricalAnalog {
  const rows = [...candles].sort((a, b) => a.time - b.time);
  const required = options.windowSize * 2 + options.horizon + 4;
  if (rows.length < required) {
    return {
      label: options.label,
      sampleCount: 0,
      bias: "NEUTRAL",
      confidence: 0,
      bullishRatio: 0,
      bearishRatio: 0,
      neutralRatio: 1,
      medianForwardPct: 0,
      averageSimilarity: 0,
    };
  }

  const currentStart = rows.length - options.windowSize;
  const current = rows.slice(currentStart);
  const candidates: { distance: number; similarity: number; forwardPct: number }[] = [];
  for (let start = 0; start + options.windowSize + options.horizon <= currentStart; start += 1) {
    const window = rows.slice(start, start + options.windowSize);
    const anchor = rows[start + options.windowSize - 1]?.close ?? 0;
    const future = rows[start + options.windowSize + options.horizon - 1]?.close ?? 0;
    if (!(anchor > 0 && future > 0)) continue;
    const distance = pathDistance(current, window);
    if (!Number.isFinite(distance)) continue;
    const similarity = 1 / (1 + distance * 35);
    candidates.push({ distance, similarity, forwardPct: (future / anchor - 1) * 100 });
  }

  const matches = candidates.sort((a, b) => a.distance - b.distance).slice(0, options.topK);
  if (!matches.length) {
    return {
      label: options.label,
      sampleCount: 0,
      bias: "NEUTRAL",
      confidence: 0,
      bullishRatio: 0,
      bearishRatio: 0,
      neutralRatio: 1,
      medianForwardPct: 0,
      averageSimilarity: 0,
    };
  }

  const bullish = matches.filter((match) => match.forwardPct > options.neutralThresholdPct).length;
  const bearish = matches.filter((match) => match.forwardPct < -options.neutralThresholdPct).length;
  const neutral = matches.length - bullish - bearish;
  const bullishRatio = bullish / matches.length;
  const bearishRatio = bearish / matches.length;
  const neutralRatio = neutral / matches.length;
  const dominantRatio = Math.max(bullishRatio, bearishRatio);
  const bias: ResonanceBias = bullishRatio >= 0.62 ? "LONG" : bearishRatio >= 0.62 ? "SHORT" : "NEUTRAL";
  const averageSimilarity = matches.reduce((sum, match) => sum + match.similarity, 0) / matches.length;
  const confidence = bias === "NEUTRAL" ? Math.round(clamp(dominantRatio * 100, 0, 59)) : Math.round(clamp((dominantRatio * 0.75 + averageSimilarity * 0.25) * 100, 0, 90));

  return {
    label: options.label,
    sampleCount: matches.length,
    bias,
    confidence,
    bullishRatio,
    bearishRatio,
    neutralRatio,
    medianForwardPct: median(matches.map((match) => match.forwardPct)),
    averageSimilarity,
  };
}

function biasText(bias: ResonanceBias) {
  return bias === "LONG" ? "偏多" : bias === "SHORT" ? "偏空" : "分歧";
}

export function buildResonanceMarketMemory(input: {
  hourly: Hte31Candle[];
  fourHour: Hte31Candle[];
  daily: Hte31Candle[];
}): ResonanceMarketMemory {
  const short = buildHistoricalAnalog(input.hourly, { label: "短线", windowSize: 12, horizon: 4, topK: 16, neutralThresholdPct: 0.25 });
  const swing = buildHistoricalAnalog(input.fourHour, { label: "波段", windowSize: 12, horizon: 6, topK: 16, neutralThresholdPct: 0.6 });
  const cycle = buildHistoricalAnalog(input.daily, { label: "大周期", windowSize: 21, horizon: 7, topK: 16, neutralThresholdPct: 1.5 });
  const weighted = [
    { item: short, weight: 0.25 },
    { item: swing, weight: 0.4 },
    { item: cycle, weight: 0.35 },
  ].filter(({ item }) => item.sampleCount >= 6 && item.bias !== "NEUTRAL");
  const signed = weighted.reduce((sum, { item, weight }) => sum + (item.bias === "LONG" ? 1 : -1) * (item.confidence / 100) * weight, 0);
  const usedWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  const normalized = usedWeight > 0 ? signed / usedWeight : 0;
  const combinedBias: ResonanceBias = normalized >= 0.2 ? "LONG" : normalized <= -0.2 ? "SHORT" : "NEUTRAL";
  const combinedConfidence = Math.round(clamp(Math.abs(normalized) * 100, 0, 88));
  const summary = `历史相似行情：短线${biasText(short.bias)} ${short.confidence}% · 波段${biasText(swing.bias)} ${swing.confidence}% · 大周期${biasText(cycle.bias)} ${cycle.confidence}%`;
  return { short, swing, cycle, combinedBias, combinedConfidence, summary };
}
