import type { Hte31Candle } from "./hte31-types.ts";

export const DIRECT_MARKET_BRAIN_VERSION = "direct-market-brain-v12-majority-path-learning";
export const DIRECT_MARKET_AUTHORITY = "direct_market_brain" as const;

export type DirectMarketSide = "LONG" | "SHORT" | "WAIT";
export type DirectMarketLocation = "TOP" | "MIDDLE" | "BOTTOM" | "BREAKOUT" | "BREAKDOWN";
export type DirectMarketFreshness = "FRESH" | "STALE" | "UNAVAILABLE";
export type DirectMarketRiskState = "CALIBRATING" | "VALIDATING" | "NORMAL" | "CAUTION" | "DEFENSIVE" | "PAUSED";
export const DIRECT_LEGACY_SETUPS = [
  { id: "MINUTE_PULLBACK", label: "顺势回踩快进快出" },
  { id: "HISTORICAL_ANALOG", label: "历史相似预测" },
  { id: "VOLUME_FORCE_FAILED_BREAKOUT", label: "量价力度假突破" },
  { id: "EXHAUSTION_REVERSAL", label: "衰竭反转" },
  { id: "MULTI_TIMEFRAME_RESONANCE", label: "多周期综合共振" },
] as const;
export const DIRECT_CORE_SETUPS = [{ id: "ANALOG_PATH", label: "历史路径方向交易" }] as const;
export const DIRECT_CORE_STRATEGY_LINEAGE = {
  ANALOG_PATH: "ANALOG_FIRST_SWING_V3",
  MINUTE_PULLBACK: "MINUTE_PULLBACK_15M_1M_V1",
  HISTORICAL_ANALOG: "HISTORICAL_ANALOG_2H_14D_1H_V1",
  VOLUME_FORCE_FAILED_BREAKOUT: "HT3-R_FAILED_AUCTION",
  EXHAUSTION_REVERSAL: "HT4_EXHAUSTION_ANTI_CROWD",
  MULTI_TIMEFRAME_RESONANCE: "HT5-R_MARKET_FIT_STRUCTURE_RECOVERY_V5",
} as const;

export type DirectCoreSetup = typeof DIRECT_CORE_SETUPS[number]["id"] | typeof DIRECT_LEGACY_SETUPS[number]["id"];

export type DirectSetupEvaluationSnapshot = {
  setup: DirectCoreSetup;
  setupLabel: string;
  side: Exclude<DirectMarketSide, "WAIT">;
  score: number;
  triggered: boolean;
  qualified: boolean;
  selected: boolean;
  blockers: string[];
};

export type DirectSetupActivity = {
  setup: DirectCoreSetup;
  setupLabel: string;
  evaluations: number;
  triggeredSignals: number;
  qualifiedSignals: number;
  selectedSignals: number;
  blockedEntries: number;
  openedTrades: number;
  leadingBlocker: string | null;
  blockerCount: number;
  blockers: Record<string, number>;
  latestQualifiedSelection?: {
    observedAt: number;
    symbol: string;
    selected: boolean;
    score: number;
    preferredSetupLabel: string;
    preferredScore: number;
  };
};

export type DirectTwelveHourActivity = {
  windowStartAt: number;
  windowEndAt: number;
  generatedAt: number;
  lastObservedAt: number | null;
  coverageMs: number;
  complete: boolean;
  evaluations: number;
  triggeredSignals: number;
  qualifiedSignals: number;
  selectedSignals: number;
  blockedEntries: number;
  openedTrades: number;
  setups: DirectSetupActivity[];
};

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
  setupEvaluations?: DirectSetupEvaluationSnapshot[];
  decision: DirectMarketSide;
  entryZone: [number, number] | null;
  invalidationPrice: number | null;
  targets: number[];
  evidence: string[];
  counterEvidence: string[];
  checks: { key: string; label: string; passed: boolean; detail: string }[];
  candles5m: Hte31Candle[];
  analogIntent?: import("./analog-path-strategy.ts").AnalogIntent;
  scalp?: { signalAt: number; structureAt: number; signalKey: string; costBps: number; confirmationPrice: number };
  forecast?: import("./historical-forecast.ts").HistoricalForecast;
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
