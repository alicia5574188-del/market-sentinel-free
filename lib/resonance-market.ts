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

type AnalogCandidate = {
  start: number;
  distance: number;
  similarity: number;
  forwardPct: number;
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

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function normalizedPath(candles: Hte31Candle[]) {
  const base = candles[0]?.close ?? 0;
  if (!(base > 0)) return [];
  return candles.map((candle) => candle.close / base - 1);
}

function returnPath(candles: Hte31Candle[]) {
  const values: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1].close;
    const current = candles[index].close;
    values.push(previous > 0 && current > 0 ? current / previous - 1 : 0);
  }
  return values;
}

function normalizedVolume(candles: Hte31Candle[]) {
  const positive = candles.map((row) => Math.max(0, row.volume));
  const base = Math.max(median(positive), Number.EPSILON);
  return positive.map((value) => Math.log1p(value / base));
}

function realizedVolatility(candles: Hte31Candle[]) {
  const returns = returnPath(candles);
  if (returns.length < 2) return 0;
  const avg = mean(returns);
  return Math.sqrt(mean(returns.map((value) => (value - avg) ** 2)));
}

function rangePct(candles: Hte31Candle[]) {
  const first = candles[0]?.close ?? 0;
  if (!(first > 0) || !candles.length) return 0;
  const high = Math.max(...candles.map((row) => row.high));
  const low = Math.min(...candles.map((row) => row.low));
  return (high - low) / first;
}

function trendEfficiency(candles: Hte31Candle[]) {
  if (candles.length < 2) return 0;
  const net = Math.abs(candles.at(-1)!.close - candles[0].close);
  let travelled = 0;
  for (let index = 1; index < candles.length; index += 1) travelled += Math.abs(candles[index].close - candles[index - 1].close);
  return travelled > 0 ? net / travelled : 0;
}

function rmse(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length) return Number.POSITIVE_INFINITY;
  return Math.sqrt(mean(a.map((value, index) => (value - b[index]) ** 2)));
}

function pathDistance(current: Hte31Candle[], candidate: Hte31Candle[]) {
  const priceDistance = rmse(normalizedPath(current), normalizedPath(candidate));
  const returnDistance = rmse(returnPath(current), returnPath(candidate));
  const volumeDistance = rmse(normalizedVolume(current), normalizedVolume(candidate));
  if (![priceDistance, returnDistance, volumeDistance].every(Number.isFinite)) return Number.POSITIVE_INFINITY;

  const currentVol = realizedVolatility(current);
  const candidateVol = realizedVolatility(candidate);
  const volatilityPenalty = Math.abs(currentVol - candidateVol) / Math.max(currentVol, candidateVol, 0.0005);
  const rangePenalty = Math.abs(rangePct(current) - rangePct(candidate)) / Math.max(rangePct(current), rangePct(candidate), 0.001);
  const efficiencyPenalty = Math.abs(trendEfficiency(current) - trendEfficiency(candidate));

  // Price shape remains the main signal, but volatility, candle-to-candle path,
  // volume behaviour and directional efficiency prevent visually similar yet
  // structurally different episodes from dominating the memory set.
  return priceDistance
    + returnDistance * 0.7
    + volumeDistance * 0.0025
    + volatilityPenalty * 0.008
    + rangePenalty * 0.006
    + efficiencyPenalty * 0.006;
}

function chooseDiverseMatches(candidates: AnalogCandidate[], options: AnalogOptions) {
  const selected: AnalogCandidate[] = [];
  const minimumSpacing = Math.max(2, Math.floor(options.windowSize * 0.75));
  for (const candidate of [...candidates].sort((a, b) => a.distance - b.distance)) {
    if (selected.some((row) => Math.abs(row.start - candidate.start) < minimumSpacing)) continue;
    selected.push(candidate);
    if (selected.length >= options.topK) break;
  }
  return selected;
}

function weightedRatio(matches: AnalogCandidate[], predicate: (row: AnalogCandidate) => boolean) {
  const total = matches.reduce((sum, row) => sum + row.similarity, 0);
  if (!(total > 0)) return 0;
  return matches.reduce((sum, row) => sum + (predicate(row) ? row.similarity : 0), 0) / total;
}

function emptyAnalog(label: HistoricalAnalog["label"]): HistoricalAnalog {
  return {
    label,
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

export function buildHistoricalAnalog(candles: Hte31Candle[], options: AnalogOptions): HistoricalAnalog {
  const rows = [...candles].sort((a, b) => a.time - b.time);
  const required = options.windowSize * 2 + options.horizon + 4;
  if (rows.length < required) return emptyAnalog(options.label);

  const currentStart = rows.length - options.windowSize;
  const current = rows.slice(currentStart);
  const candidates: AnalogCandidate[] = [];
  for (let start = 0; start + options.windowSize + options.horizon <= currentStart; start += 1) {
    const window = rows.slice(start, start + options.windowSize);
    const anchor = rows[start + options.windowSize - 1]?.close ?? 0;
    const future = rows[start + options.windowSize + options.horizon - 1]?.close ?? 0;
    if (!(anchor > 0 && future > 0)) continue;
    const distance = pathDistance(current, window);
    if (!Number.isFinite(distance)) continue;
    const similarity = 1 / (1 + distance * 32);
    candidates.push({ start, distance, similarity, forwardPct: (future / anchor - 1) * 100 });
  }

  // Adjacent sliding windows often describe the same historical event. Treating
  // sixteen overlapping slices as sixteen independent memories creates fake
  // confidence, so the final analog set intentionally keeps episodes apart.
  const matches = chooseDiverseMatches(candidates, options);
  if (!matches.length) return emptyAnalog(options.label);

  const bullishRatio = weightedRatio(matches, (match) => match.forwardPct > options.neutralThresholdPct);
  const bearishRatio = weightedRatio(matches, (match) => match.forwardPct < -options.neutralThresholdPct);
  const neutralRatio = Math.max(0, 1 - bullishRatio - bearishRatio);
  const dominantRatio = Math.max(bullishRatio, bearishRatio);
  const enoughIndependentHistory = matches.length >= Math.min(8, options.topK);
  const bias: ResonanceBias = enoughIndependentHistory && bullishRatio >= 0.60 ? "LONG"
    : enoughIndependentHistory && bearishRatio >= 0.60 ? "SHORT" : "NEUTRAL";
  const averageSimilarity = mean(matches.map((match) => match.similarity));
  const diversityFactor = clamp(matches.length / Math.max(8, options.topK), 0, 1);
  const confidence = bias === "NEUTRAL"
    ? Math.round(clamp(dominantRatio * 75 * diversityFactor, 0, 59))
    : Math.round(clamp((dominantRatio * 0.62 + averageSimilarity * 0.23 + diversityFactor * 0.15) * 100, 0, 90));

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
  const short = buildHistoricalAnalog(input.hourly, { label: "短线", windowSize: 18, horizon: 4, topK: 20, neutralThresholdPct: 0.25 });
  const swing = buildHistoricalAnalog(input.fourHour, { label: "波段", windowSize: 18, horizon: 6, topK: 20, neutralThresholdPct: 0.6 });
  const cycle = buildHistoricalAnalog(input.daily, { label: "大周期", windowSize: 30, horizon: 10, topK: 20, neutralThresholdPct: 1.5 });
  const weighted = [
    { item: short, weight: 0.20 },
    { item: swing, weight: 0.45 },
    { item: cycle, weight: 0.35 },
  ].filter(({ item }) => item.sampleCount >= 8 && item.bias !== "NEUTRAL");
  const signed = weighted.reduce((sum, { item, weight }) => sum + (item.bias === "LONG" ? 1 : -1) * (item.confidence / 100) * weight, 0);
  const usedWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  const normalized = usedWeight > 0 ? signed / usedWeight : 0;
  const combinedBias: ResonanceBias = normalized >= 0.22 ? "LONG" : normalized <= -0.22 ? "SHORT" : "NEUTRAL";
  const combinedConfidence = Math.round(clamp(Math.abs(normalized) * 100, 0, 88));
  const summary = `历史相似行情：短线${biasText(short.bias)} ${short.confidence}% · 波段${biasText(swing.bias)} ${swing.confidence}% · 大周期${biasText(cycle.bias)} ${cycle.confidence}%`;
  return { short, swing, cycle, combinedBias, combinedConfidence, summary };
}
