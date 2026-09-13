import { detectExtremeSequencePath } from "./extreme-sequence-mirror.ts";
import type { MarketRegimeCandidate as CurrentMarketRegimeCandidate, ResidentCandleStructure } from "./market-regime.ts";
import { allRegimePaperApproved, detectAllRegimeRoutes, dominantAllRegimeEnvironment,
  type AllRegimeEnvironment, type AllRegimeRoute } from "./previous-all-regime-engine.ts";
import { deriveMarketStateFeatures } from "./strategy-coverage.ts";

export type PreviousMarketRegimeCandidate = Omit<CurrentMarketRegimeCandidate, "allRegimeRoutes" | "dominantEnvironment"> & {
  allRegimeRoutes?: AllRegimeRoute[];
  dominantEnvironment?: AllRegimeEnvironment | null;
};

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const candlePriceBin = (price: number) => Math.round(Math.log(Math.max(price, 1e-12)) / Math.log(1.0005));

/** Frozen V4/V12 completed-candle candidate builder from production commit 4c34325. */
export function previousCompletedCandleStrategyCandidate(input: {
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
  const stateFeatures = deriveMarketStateFeatures(allRows, 0.5, 0);
  if (!stateFeatures) return null;
  const trendRate = stateFeatures.trendRate;
  const broadMoveRate = (latest.close - rows.at(-7)!.close) / Math.max(rows.at(-7)!.close, 1e-9);
  const trendEfficiency = clamp(stateFeatures.trendEfficiency, 0, 1);
  const volatilityRatio = clamp(stateFeatures.volatilityRatio, 0, 5);
  const lower = Math.min(...rows.map((row) => row.low));
  const upper = Math.max(...rows.map((row) => row.high));
  const rangePosition = clamp(stateFeatures.rangePosition, 0, 1);
  const lastMove = (latest.close - latest.open) / Math.max(latest.open, 1e-9);
  let channel: PreviousMarketRegimeCandidate["channel"];
  let regime: PreviousMarketRegimeCandidate["regime"];
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
  const extremeSequence = detectExtremeSequencePath(allRows);
  const allRegimeRoutes = detectAllRegimeRoutes(allRows);
  const dominantEnvironment = dominantAllRegimeEnvironment(allRows);
  const approvedRoute = allRegimeRoutes.find((route) => allRegimePaperApproved(route.strategyId));
  const primary = approvedRoute ?? allRegimeRoutes[0];
  if (primary) {
    channel = primary.environment === "TREND" ? "TREND" : primary.environment === "RANGE" ? "RANGE"
      : primary.environment === "COMPRESSION" ? "COMPRESSION" : "ANOMALY";
    regime = primary.environment === "TREND" ? "TREND" : primary.environment === "RANGE" ? "RANGE"
      : primary.environment === "COMPRESSION" ? "COMPRESSION" : "EXPANSION";
    side = primary.side; score = primary.score;
  }
  const executionPriorityScore = approvedRoute ? 90 + clamp(approvedRoute.score - 60, 0, 10) : Math.min(score, 75);
  const candidate: PreviousMarketRegimeCandidate = {
    id: `${input.symbol}:CANDLE5M:${channel}:${side}:${lifecycle}`, symbol: input.symbol, channel, regime, side,
    score: clamp(executionPriorityScore, 0, 100), referencePrice: channel === "ANOMALY" ? latest.open : latest.close,
    moveRate: channel === "ANOMALY" ? lastMove : trendRate, trendRate, broadMoveRate, trendEfficiency, volatilityRatio, rangePosition,
    volume24hUsd: input.volume24hUsd, fundingRate: input.fundingRate, openInterestChangeRate: 0,
    confirmations: 2, firstSeenAt: latestCompletedAt, observedAt: latestCompletedAt, anomalyKind: null,
    adaptivePolicy: null, extremeSequence, allRegimeRoutes, dominantEnvironment,
  };
  const structure: ResidentCandleStructure = { id: `${input.symbol}:5m:${lifecycle}`, observedAt: latestCompletedAt,
    lower, upper, midpoint: (lower + upper) / 2, recentLower, recentUpper };
  return { candidate, structure };
}
