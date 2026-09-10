import type { RadarCandidate, RadarTicker } from "./market-radar.ts";
import type { CompletedMinuteCandle } from "./liquidity-core.ts";
import { buildAdaptivePolicySnapshot, type AdaptivePolicySnapshot } from "./adaptive-policy.ts";

export const MARKET_REGIME_VERSION = 2;
export const MARKET_REGIME_MIN_SAMPLES = 18;

export type MarketRegimeKind = "TREND" | "RANGE" | "COMPRESSION" | "EXPANSION" | "UNCERTAIN";
export type CandidateChannel = "TREND" | "RANGE" | "COMPRESSION" | "ANOMALY";

export type MarketProfile = {
  symbol: string;
  last: number;
  observedAt: number;
  samples: number;
  fastPrice: number;
  slowPrice: number;
  fastMove: number;
  slowMove: number;
  directionBias: number;
  rangeHigh: number;
  rangeLow: number;
  rangeStartedAt: number;
  openInterest: number;
  volume24hUsd: number;
  fundingRate: number;
  regime: MarketRegimeKind;
  previousRegime: MarketRegimeKind;
  regimeSince: number;
  pendingRegime: MarketRegimeKind;
  pendingCount: number;
  side: "LONG" | "SHORT";
  trendRate: number;
  trendEfficiency: number;
  volatilityRatio: number;
  rangePosition: number;
  openInterestChangeRate: number;
};

export type MarketRegimeCandidate = {
  id: string;
  symbol: string;
  channel: CandidateChannel;
  regime: MarketRegimeKind;
  side: "LONG" | "SHORT";
  score: number;
  referencePrice: number;
  moveRate: number;
  trendRate: number;
  trendEfficiency: number;
  volatilityRatio: number;
  rangePosition: number;
  volume24hUsd: number;
  fundingRate: number;
  openInterestChangeRate: number;
  confirmations: number;
  firstSeenAt: number;
  observedAt: number;
  anomalyKind: RadarCandidate["kind"] | null;
  adaptivePolicy?: AdaptivePolicySnapshot | null;
};

export type MarketRegimeState = {
  version: 2;
  profiles: Record<string, MarketProfile>;
  candidates: MarketRegimeCandidate[];
  lastUpdatedAt: number | null;
};

export type CompletedFiveMinuteCandle = CompletedMinuteCandle & { completedAt: number };
export type ResidentCandleStructure = {
  id: string;
  observedAt: number;
  lower: number;
  upper: number;
  midpoint: number;
  recentLower: number;
  recentUpper: number;
};

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const candlePriceBin = (price: number) => Math.round(Math.log(Math.max(price, 1e-12)) / Math.log(1.0025));

export function completedFiveMinuteCandles(candles: CompletedMinuteCandle[]) {
  const unique = [...new Map(candles.filter((row) => [row.time, row.open, row.high, row.low, row.close].every(Number.isFinite)
      && row.open > 0 && row.close > 0 && row.high >= row.low && row.low > 0)
    .map((row) => [row.time, row])).values()].sort((left, right) => left.time - right.time);
  const groups = new Map<number, CompletedMinuteCandle[]>();
  for (const row of unique) {
    const bucket = Math.floor(row.time / 300) * 300;
    const group = groups.get(bucket) ?? [];
    group.push(row);
    groups.set(bucket, group);
  }
  return [...groups.entries()].sort((left, right) => left[0] - right[0]).flatMap(([bucket, rows]) => {
    const ordered = rows.sort((left, right) => left.time - right.time);
    const complete = ordered.length === 5 && ordered.every((row, index) => row.time === bucket + index * 60);
    if (!complete) return [];
    return [{ time: bucket, open: ordered[0].open, high: Math.max(...ordered.map((row) => row.high)),
      low: Math.min(...ordered.map((row) => row.low)), close: ordered.at(-1)!.close,
      completedAt: (bucket + 300) * 1_000 } satisfies CompletedFiveMinuteCandle];
  });
}

export function residentCandleCandidate(input: {
  symbol: string;
  candles: CompletedMinuteCandle[];
  volume24hUsd: number;
  fundingRate: number;
  now: number;
}) {
  const rows = completedFiveMinuteCandles(input.candles).slice(-12);
  if (rows.length < 6 || input.volume24hUsd <= 0) return null;
  const latest = rows.at(-1)!;
  if (input.now < latest.completedAt || input.now - latest.completedAt > 11 * 60_000) return null;
  const closes = rows.map((row) => row.close);
  const path = closes.slice(1).reduce((total, close, index) => total + Math.abs(close - closes[index]), 0);
  const trendRate = (latest.close - rows[0].open) / Math.max(rows[0].open, 1e-9);
  const trendEfficiency = clamp(Math.abs(latest.close - rows[0].open) / Math.max(path, latest.close * 0.0002), 0, 1);
  const ranges = rows.map((row) => (row.high - row.low) / Math.max(row.open, 1e-9));
  const recentVolatility = sum(ranges.slice(-3)) / 3;
  const priorRows = ranges.slice(-6, -3);
  const priorVolatility = sum(priorRows) / Math.max(1, priorRows.length);
  const volatilityRatio = clamp(recentVolatility / Math.max(priorVolatility, 0.00005), 0, 5);
  const lower = Math.min(...rows.map((row) => row.low));
  const upper = Math.max(...rows.map((row) => row.high));
  const width = Math.max(upper - lower, latest.close * 0.0002);
  const rangePosition = clamp((latest.close - lower) / width, 0, 1);
  const lastMove = (latest.close - latest.open) / Math.max(latest.open, 1e-9);
  let channel: CandidateChannel;
  let regime: MarketRegimeKind;
  let side: "LONG" | "SHORT" = trendRate >= 0 ? "LONG" : "SHORT";
  let score: number;
  if (volatilityRatio >= 1.55 && Math.abs(lastMove) >= 0.0025) {
    channel = "ANOMALY"; regime = "EXPANSION"; side = lastMove >= 0 ? "LONG" : "SHORT";
    score = 58 + clamp((volatilityRatio - 1.55) / 1.5, 0, 1) * 22 + clamp(Math.abs(lastMove) / 0.01, 0, 1) * 20;
  } else if (volatilityRatio <= 0.72) {
    channel = "COMPRESSION"; regime = "COMPRESSION";
    score = 55 + clamp((0.72 - volatilityRatio) / 0.5, 0, 1) * 28 + trendEfficiency * 12;
  } else if (trendEfficiency >= 0.52 && Math.abs(trendRate) >= 0.0035) {
    channel = "TREND"; regime = "TREND";
    score = 52 + trendEfficiency * 30 + clamp(Math.abs(trendRate) / 0.02, 0, 1) * 18;
  } else if (trendEfficiency <= 0.5 && (rangePosition <= 0.28 || rangePosition >= 0.72)) {
    channel = "RANGE"; regime = "RANGE"; side = rangePosition <= 0.28 ? "LONG" : "SHORT";
    score = 52 + (1 - trendEfficiency) * 24 + Math.abs(rangePosition - 0.5) * 36;
  } else return null;
  const recent = rows.slice(-3);
  const recentLower = Math.min(...recent.map((row) => row.low));
  const recentUpper = Math.max(...recent.map((row) => row.high));
  let lifecycle = `${candlePriceBin(lower)}:${candlePriceBin(upper)}`;
  if (channel === "ANOMALY") lifecycle += `:${latest.completedAt}`;
  if (channel === "RANGE") {
    const edgeCutoff = side === "LONG" ? lower + width * 0.3 : upper - width * 0.3;
    let edgeStartedAt = latest.completedAt;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const stillAtEdge = side === "LONG" ? rows[index].close <= edgeCutoff : rows[index].close >= edgeCutoff;
      if (!stillAtEdge) break;
      edgeStartedAt = rows[index].completedAt;
    }
    lifecycle += `:${edgeStartedAt}`;
  }
  const firstSeenAt = rows[0].completedAt;
  const candidate: MarketRegimeCandidate = {
    id: `${input.symbol}:CANDLE5M:${channel}:${side}:${lifecycle}`, symbol: input.symbol, channel, regime, side,
    score: clamp(score, 0, 100), referencePrice: channel === "ANOMALY" ? latest.open : latest.close,
    moveRate: channel === "ANOMALY" ? lastMove : trendRate, trendRate, trendEfficiency, volatilityRatio, rangePosition,
    volume24hUsd: input.volume24hUsd, fundingRate: input.fundingRate, openInterestChangeRate: 0,
    confirmations: 2, firstSeenAt, observedAt: latest.completedAt,
    anomalyKind: channel === "ANOMALY" ? "PRICE_SHOCK" : null,
  };
  const structure: ResidentCandleStructure = { id: `${input.symbol}:5m:${lifecycle}`, observedAt: latest.completedAt,
    lower, upper, midpoint: (lower + upper) / 2, recentLower, recentUpper };
  return { candidate, structure };
}

export function completedCandleStrategyCandidate(input: {
  symbol: string;
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>;
  volume24hUsd: number;
  fundingRate: number;
  now: number;
}) {
  const allRows = [...input.candles].sort((left, right) => left.time - right.time).slice(-120);
  const rows = allRows.slice(-24);
  if (rows.length < 12 || input.volume24hUsd <= 0) return null;
  const latest = rows.at(-1)!;
  const latestCompletedAt = (latest.time + 300) * 1_000;
  if (input.now < latestCompletedAt || input.now - latestCompletedAt > 11 * 60_000) return null;
  const closes = rows.map((row) => row.close);
  const path = closes.slice(1).reduce((total, close, index) => total + Math.abs(close - closes[index]), 0);
  const trendRate = (latest.close - rows[0].open) / Math.max(rows[0].open, 1e-9);
  const trendEfficiency = clamp(Math.abs(latest.close - rows[0].open) / Math.max(path, latest.close * 0.0002), 0, 1);
  const ranges = rows.map((row) => (row.high - row.low) / Math.max(row.open, 1e-9));
  const recentVolatility = sum(ranges.slice(-4)) / 4;
  const priorVolatility = sum(ranges.slice(-12, -4)) / 8;
  const volatilityRatio = clamp(recentVolatility / Math.max(priorVolatility, 0.00005), 0, 5);
  const lower = Math.min(...rows.map((row) => row.low));
  const upper = Math.max(...rows.map((row) => row.high));
  const width = Math.max(upper - lower, latest.close * 0.0002);
  const rangePosition = clamp((latest.close - lower) / width, 0, 1);
  const lastMove = (latest.close - latest.open) / Math.max(latest.open, 1e-9);
  let channel: CandidateChannel;
  let regime: MarketRegimeKind;
  let side: "LONG" | "SHORT" = trendRate >= 0 ? "LONG" : "SHORT";
  let score: number;
  if (volatilityRatio <= 0.76) {
    channel = "COMPRESSION"; regime = "COMPRESSION";
    score = 56 + clamp((0.76 - volatilityRatio) / 0.5, 0, 1) * 28 + trendEfficiency * 12;
  } else if (volatilityRatio >= 1.42 && Math.abs(lastMove) >= 0.0018) {
    channel = "ANOMALY"; regime = "EXPANSION"; side = lastMove >= 0 ? "LONG" : "SHORT";
    score = 58 + clamp((volatilityRatio - 1.42) / 1.5, 0, 1) * 22 + clamp(Math.abs(lastMove) / 0.01, 0, 1) * 20;
  } else if (trendEfficiency >= 0.46 && Math.abs(trendRate) >= 0.0025) {
    channel = "TREND"; regime = "TREND";
    score = 54 + trendEfficiency * 30 + clamp(Math.abs(trendRate) / 0.02, 0, 1) * 16;
  } else {
    channel = "RANGE"; regime = "RANGE"; side = rangePosition <= 0.5 ? "LONG" : "SHORT";
    score = 52 + (1 - trendEfficiency) * 24 + Math.abs(rangePosition - 0.5) * 36;
  }
  const recent = rows.slice(-4);
  const recentLower = Math.min(...recent.map((row) => row.low));
  const recentUpper = Math.max(...recent.map((row) => row.high));
  const lifecycle = `${latestCompletedAt}:${candlePriceBin(lower)}:${candlePriceBin(upper)}`;
  const adaptivePolicy = buildAdaptivePolicySnapshot(allRows, latestCompletedAt);
  const bestApprovedObjective = Math.max(0, ...(adaptivePolicy?.recommendations
    .filter((row) => row.approved).map((row) => row.objectiveScore) ?? []));
  // A route with independently confirmed positive expectancy must win scarce fresh-book capacity over research-only ranks.
  const executionPriorityScore = bestApprovedObjective > 0
    ? 90 + clamp(bestApprovedObjective * 100, 0, 10) : score;
  const candidate: MarketRegimeCandidate = {
    id: `${input.symbol}:CANDLE5M:${channel}:${side}:${lifecycle}`, symbol: input.symbol, channel, regime, side,
    score: clamp(executionPriorityScore, 0, 100), referencePrice: channel === "ANOMALY" ? latest.open : latest.close,
    moveRate: channel === "ANOMALY" ? lastMove : trendRate, trendRate, trendEfficiency, volatilityRatio, rangePosition,
    volume24hUsd: input.volume24hUsd, fundingRate: input.fundingRate, openInterestChangeRate: 0,
    confirmations: 2, firstSeenAt: latestCompletedAt, observedAt: latestCompletedAt, anomalyKind: null,
    adaptivePolicy,
  };
  const structure: ResidentCandleStructure = { id: `${input.symbol}:5m:${lifecycle}`, observedAt: latestCompletedAt,
    lower, upper, midpoint: (lower + upper) / 2, recentLower, recentUpper };
  return { candidate, structure };
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

export function initialMarketRegimes(): MarketRegimeState {
  return { version: MARKET_REGIME_VERSION, profiles: {}, candidates: [], lastUpdatedAt: null };
}

export function normalizeMarketRegimes(value: MarketRegimeState | null | undefined): MarketRegimeState {
  if (!value || value.version !== MARKET_REGIME_VERSION) return initialMarketRegimes();
  return {
    version: MARKET_REGIME_VERSION,
    profiles: Object.fromEntries(Object.entries(value.profiles ?? {}).slice(-240)),
    candidates: (value.candidates ?? []).slice(0, 24),
    lastUpdatedAt: value.lastUpdatedAt ?? null,
  };
}

function initialProfile(row: RadarTicker, now: number): MarketProfile {
  return {
    symbol: row.symbol, last: row.last, observedAt: now, samples: 1,
    fastPrice: row.last, slowPrice: row.last, fastMove: 0.00015, slowMove: 0.00015, directionBias: 0,
    rangeHigh: row.last, rangeLow: row.last, rangeStartedAt: now,
    openInterest: row.openInterest, volume24hUsd: row.volume24hUsd, fundingRate: row.fundingRate,
    regime: "UNCERTAIN", previousRegime: "UNCERTAIN", regimeSince: now,
    pendingRegime: "UNCERTAIN", pendingCount: 0, side: "LONG",
    trendRate: 0, trendEfficiency: 0, volatilityRatio: 1, rangePosition: 0.5, openInterestChangeRate: 0,
  };
}

function rawRegime(profile: MarketProfile): MarketRegimeKind {
  if (profile.samples < MARKET_REGIME_MIN_SAMPLES) return "UNCERTAIN";
  if (profile.volatilityRatio >= 1.45 && profile.fastMove >= 0.00022) return "EXPANSION";
  if (profile.volatilityRatio <= 0.68 && profile.fastMove <= 0.00018) return "COMPRESSION";
  if (profile.trendEfficiency >= 0.52 && Math.abs(profile.trendRate) >= 0.00035) return "TREND";
  if (profile.trendEfficiency <= 0.38) return "RANGE";
  return "UNCERTAIN";
}

function updateProfile(before: MarketProfile | undefined, row: RadarTicker, now: number) {
  if (!before || before.last <= 0 || now - before.observedAt > 5 * 60_000) return initialProfile(row, now);
  const moveRate = (row.last - before.last) / before.last;
  const absoluteMove = Math.abs(moveRate);
  const resetRange = now - before.rangeStartedAt >= 30 * 60_000;
  const fastPrice = before.fastPrice * 0.72 + row.last * 0.28;
  const slowPrice = before.slowPrice * 0.94 + row.last * 0.06;
  const fastMove = before.fastMove * 0.65 + absoluteMove * 0.35;
  const slowMove = before.slowMove * 0.97 + absoluteMove * 0.03;
  const directionBias = before.directionBias * 0.85 + Math.sign(moveRate) * 0.15;
  const rangeHigh = resetRange ? row.last : Math.max(before.rangeHigh, row.last);
  const rangeLow = resetRange ? row.last : Math.min(before.rangeLow, row.last);
  const width = Math.max(rangeHigh - rangeLow, row.last * 0.0002);
  const trendRate = (fastPrice - slowPrice) / Math.max(slowPrice, 1e-9);
  const normalizedTrend = Math.abs(trendRate) / Math.max(slowMove * 4, 0.0002);
  const trendEfficiency = clamp(Math.abs(directionBias) * 0.55 + clamp(normalizedTrend / 1.5, 0, 1) * 0.45, 0, 1);
  const openInterestChangeRate = before.openInterest > 0 ? (row.openInterest - before.openInterest) / before.openInterest : 0;
  const draft: MarketProfile = {
    ...before, last: row.last, observedAt: now, samples: Math.min(720, before.samples + 1), fastPrice, slowPrice,
    fastMove, slowMove, directionBias, rangeHigh, rangeLow, rangeStartedAt: resetRange ? now : before.rangeStartedAt,
    openInterest: row.openInterest, volume24hUsd: row.volume24hUsd, fundingRate: row.fundingRate,
    side: trendRate >= 0 ? "LONG" : "SHORT", trendRate, trendEfficiency,
    volatilityRatio: clamp(fastMove / Math.max(slowMove, 0.00002), 0, 5),
    rangePosition: clamp((row.last - rangeLow) / width, 0, 1), openInterestChangeRate,
  };
  const nextRaw = rawRegime(draft);
  const pendingCount = nextRaw === before.pendingRegime ? before.pendingCount + 1 : 1;
  if (nextRaw !== before.regime && pendingCount >= 3) {
    draft.previousRegime = before.regime;
    draft.regime = nextRaw;
    draft.regimeSince = now;
    draft.pendingRegime = nextRaw;
    draft.pendingCount = 0;
  } else {
    draft.pendingRegime = nextRaw;
    draft.pendingCount = pendingCount;
  }
  return draft;
}

function regimeCandidate(profile: MarketProfile, now: number): MarketRegimeCandidate | null {
  if (profile.samples < MARKET_REGIME_MIN_SAMPLES || profile.volume24hUsd < 2_000_000) return null;
  const liquidScore = clamp((Math.log10(Math.max(profile.volume24hUsd, 1)) - 6) / 3, 0, 1) * 12;
  let channel: CandidateChannel;
  let side = profile.side;
  let score = 0;
  if (profile.regime === "TREND") {
    channel = "TREND";
    score = profile.trendEfficiency * 70 + clamp(Math.abs(profile.trendRate) / 0.004, 0, 1) * 18 + liquidScore;
  } else if (profile.regime === "RANGE" && (profile.rangePosition <= 0.2 || profile.rangePosition >= 0.8)) {
    channel = "RANGE";
    side = profile.rangePosition <= 0.2 ? "LONG" : "SHORT";
    score = (1 - profile.trendEfficiency) * 58 + Math.abs(profile.rangePosition - 0.5) * 55 + liquidScore;
  } else if (profile.regime === "COMPRESSION") {
    channel = "COMPRESSION";
    score = clamp(1 - profile.volatilityRatio, 0, 1) * 70 + profile.trendEfficiency * 18 + liquidScore;
  } else return null;
  const firstSeenAt = profile.regimeSince;
  return {
    id: `${profile.symbol}:${channel}:${side}:${firstSeenAt}`, symbol: profile.symbol, channel, regime: profile.regime, side,
    score: clamp(score, 0, 100), referencePrice: profile.last, moveRate: finite((profile.last - profile.slowPrice) / Math.max(profile.slowPrice, 1e-9)),
    trendRate: profile.trendRate, trendEfficiency: profile.trendEfficiency, volatilityRatio: profile.volatilityRatio,
    rangePosition: profile.rangePosition, volume24hUsd: profile.volume24hUsd, fundingRate: profile.fundingRate,
    openInterestChangeRate: profile.openInterestChangeRate, confirmations: Math.max(1, Math.floor((now - profile.regimeSince) / 10_000) + 1),
    firstSeenAt, observedAt: now, anomalyKind: null,
  };
}

export function anomalyCandidate(candidate: RadarCandidate): MarketRegimeCandidate {
  return {
    id: candidate.id, symbol: candidate.symbol, channel: "ANOMALY", regime: "EXPANSION", side: candidate.side,
    score: candidate.strength, referencePrice: candidate.referencePrice, moveRate: candidate.moveRate,
    trendRate: candidate.moveRate, trendEfficiency: clamp(candidate.strength / 100, 0, 1),
    volatilityRatio: clamp(candidate.movementMultiple, 0, 5), rangePosition: candidate.side === "LONG" ? 1 : 0,
    volume24hUsd: candidate.volume24hUsd, fundingRate: 0, openInterestChangeRate: candidate.openInterestChangeRate,
    confirmations: candidate.confirmations, firstSeenAt: candidate.firstSeenAt, observedAt: candidate.observedAt,
    anomalyKind: candidate.kind,
  };
}

export function updateMarketRegimes(input: { state: MarketRegimeState; rows: RadarTicker[]; eligible: Set<string>; now: number }) {
  const prior = normalizeMarketRegimes(input.state);
  const profiles: Record<string, MarketProfile> = {};
  for (const row of input.rows) {
    if (!input.eligible.has(row.symbol) || row.last <= 0 || row.volume24hUsd < 2_000_000) continue;
    profiles[row.symbol] = updateProfile(prior.profiles[row.symbol], row, input.now);
  }
  const candidates = Object.values(profiles).map((profile) => regimeCandidate(profile, input.now))
    .filter((candidate): candidate is MarketRegimeCandidate => candidate != null)
    .sort((left, right) => right.score - left.score).slice(0, 24);
  return { version: MARKET_REGIME_VERSION, profiles, candidates, lastUpdatedAt: input.now } satisfies MarketRegimeState;
}

export function marketRegimeSummary(state: MarketRegimeState) {
  const profiles = Object.values(state.profiles);
  const counts = Object.fromEntries((["TREND", "RANGE", "COMPRESSION", "EXPANSION", "UNCERTAIN"] as MarketRegimeKind[])
    .map((regime) => [regime, profiles.filter((profile) => profile.regime === regime).length]));
  return {
    version: state.version,
    lastUpdatedAt: state.lastUpdatedAt,
    tracked: profiles.length,
    warmed: profiles.filter((profile) => profile.samples >= MARKET_REGIME_MIN_SAMPLES).length,
    counts,
    candidates: state.candidates.slice(0, 24),
  };
}

const channelGroup = (channel: CandidateChannel) => channel === "TREND" ? "TREND"
  : channel === "RANGE" || channel === "COMPRESSION" ? "ROTATION" : "EVENT";

export function selectDiverseMarketPool(input: {
  locked: string[];
  current: string[];
  candidates: MarketRegimeCandidate[];
  fallback: string[];
  limit: number;
}) {
  const bySymbol = new Map(input.candidates.map((candidate) => [candidate.symbol, candidate]));
  const output = [...new Set(input.locked)].slice(0, input.limit);
  const liquid = new Set(input.fallback);
  const stableCoreTarget = Math.min(6, input.limit);
  for (const symbol of input.current) {
    if (output.length >= stableCoreTarget) break;
    if (liquid.has(symbol) && !output.includes(symbol)) output.push(symbol);
  }
  for (const symbol of input.fallback) {
    if (output.length >= stableCoreTarget) break;
    if (!output.includes(symbol)) output.push(symbol);
  }
  const usedGroups = new Set(output.map((symbol) => bySymbol.get(symbol)).filter(Boolean).map((candidate) => channelGroup(candidate!.channel)));
  const availableGroups = new Set(input.candidates.map((candidate) => channelGroup(candidate.channel)));
  const add = (symbol: string, requireNewGroup = true) => {
    if (output.length >= input.limit || output.includes(symbol)) return;
    const candidate = bySymbol.get(symbol);
    if (requireNewGroup && candidate && usedGroups.has(channelGroup(candidate.channel))) return;
    output.push(symbol);
    if (candidate) usedGroups.add(channelGroup(candidate.channel));
  };
  input.current.filter((symbol) => bySymbol.has(symbol)).forEach((symbol) => add(symbol, availableGroups.size > 1));
  for (const group of ["TREND", "ROTATION", "EVENT"]) {
    const row = input.candidates.find((candidate) => channelGroup(candidate.channel) === group && !output.includes(candidate.symbol));
    if (row) add(row.symbol);
  }
  for (const candidate of input.candidates) {
    if (output.length >= input.limit) break;
    if (!output.includes(candidate.symbol)) output.push(candidate.symbol);
  }
  for (const symbol of input.fallback) {
    if (output.length >= input.limit) break;
    if (!output.includes(symbol)) output.push(symbol);
  }
  return output.slice(0, input.limit);
}
