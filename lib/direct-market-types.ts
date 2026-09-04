import type { Hte31Candle } from "./hte31-types.ts";

export const DIRECT_MARKET_BRAIN_VERSION = "direct-market-brain-v2-core-three";
export const DIRECT_MARKET_AUTHORITY = "direct_market_brain" as const;

export type DirectMarketSide = "LONG" | "SHORT" | "WAIT";
export type DirectMarketLocation = "TOP" | "MIDDLE" | "BOTTOM" | "BREAKOUT" | "BREAKDOWN";
export type DirectMarketFreshness = "FRESH" | "STALE" | "UNAVAILABLE";
export type DirectMarketRiskState = "CALIBRATING" | "VALIDATING" | "NORMAL" | "CAUTION" | "DEFENSIVE" | "PAUSED";
export type DirectCoreSetup = "VOLUME_FORCE_FAILED_BREAKOUT" | "EXHAUSTION_REVERSAL" | "DENNIS_TREND_BREAKOUT";

export type DirectMarketCandidate = {
  symbol: string;
  batchId: string;
  observedAt: number;
  freshness: DirectMarketFreshness;
  scanStage: "LIGHT" | "DEEP";
  volumeRank: number;
  volumeUsd: number;
  riskClusterId: string;
  btcCorrelation: number | null;
  location: DirectMarketLocation;
  paths: { up: number; down: number; rangeOrInvalid: number };
  directionalScore: number;
  netEdgeR: number;
  confidence: number;
  setup: DirectCoreSetup;
  setupLabel: string;
  setupScore: number;
  decision: DirectMarketSide;
  entryZone: [number, number] | null;
  invalidationPrice: number | null;
  targets: number[];
  evidence: string[];
  counterEvidence: string[];
  checks: { key: string; label: string; passed: boolean; detail: string }[];
  candles5m: Hte31Candle[];
  assetRegime: string;
  maxHoldingMinutes: number;
};

export type DirectBrainDecisionSnapshot = {
  id: string;
  authority: typeof DIRECT_MARKET_AUTHORITY;
  brainVersion: typeof DIRECT_MARKET_BRAIN_VERSION;
  parentVersion: string | null;
  decisionPolicyVersion: string;
  positionPolicyVersion: string;
  batchId: string;
  universe: string[];
  selectedSymbol: string;
  portfolioRank: number;
  candidate: Omit<DirectMarketCandidate, "candles5m">;
  portfolioChecks: Record<string, unknown>;
  entryValidation: {
    quoteObservedAt: number;
    candidateAgeMs: number;
    entryPrice: number;
    rewardRisk: number;
  };
  learningRule: {
    action: string;
    reason: string;
    evidenceCount: number;
    revalidation: boolean;
  };
  riskState: DirectMarketRiskState;
  createdAt: number;
};

export type DirectMarketRadarItem = {
  symbol: string;
  observedAt: number;
  volumeRank: number;
  volumeUsd: number;
  changePercentage: number;
  scanStage: "LIGHT" | "DEEP";
  freshness: DirectMarketFreshness;
  candidate: Omit<DirectMarketCandidate, "candles5m"> | null;
};
