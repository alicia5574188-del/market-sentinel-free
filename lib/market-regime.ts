import type { RadarCandidate, RadarTicker } from "./market-radar.ts";

export const MARKET_REGIME_VERSION = 1;
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
};

export type MarketRegimeState = {
  version: 1;
  profiles: Record<string, MarketProfile>;
  candidates: MarketRegimeCandidate[];
  lastUpdatedAt: number | null;
};

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;

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
