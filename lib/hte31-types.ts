export type Hte31TradeSide = "LONG" | "SHORT";
export type Hte31ExitCode = "take_profit" | "stop_loss" | "breakeven" | "structure_reversal" | "flow_reversal" | "macro_risk" | "timeout";

export type Hte31Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Hte31SignalMetric = {
  key: string;
  label: string;
  score: number;
  detail: string;
  available: boolean;
  category: "price" | "momentum" | "volume" | "spot" | "derivatives" | "microstructure" | "cross" | "flow" | "volatility" | "events";
};

export type Hte31EntryCheck = {
  key: string;
  label: string;
  passed: boolean;
  required: boolean;
  detail: string;
};

export type Hte31ExitRule = {
  code: Hte31ExitCode;
  label: string;
  condition: string;
};

export type Hte31EntryPlan = {
  ready: boolean;
  side: Hte31TradeSide;
  entryPrice: number;
  entryZone: [number, number];
  stopLossPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  riskPerUnit: number;
  plannedRiskPct: number;
  riskReward: number;
  maxHoldingMinutes: number;
  checks: Hte31EntryCheck[];
  exitRules: Hte31ExitRule[];
};

export type Hte31MarketRegimeKind = "trend" | "range" | "compression" | "mixed" | "stress";

export type Hte31MarketRegime = {
  kind: Hte31MarketRegimeKind;
  trendScore: number;
  atrPct: number | null;
  compressionRatio: number | null;
  rangeWidthPct: number | null;
  relativeStrength24h: number | null;
  reason: string;
};

export type Hte31AssetRegime =
  | "trend_up" | "trend_down" | "range" | "compression"
  | "expansion_up" | "expansion_down" | "leverage_liquidation" | "transition";

export type Hte31Input = {
  symbol: string;
  observedAt: number;
  futuresPrice: number;
  volumeUsd: number;
  changePercentage: number | null;
  fundingRate: number | null;
  openInterestChangePct: number | null;
  spotCvdRatio: number | null;
  orderBookImbalance: number | null;
  liquidationImbalance: number | null;
  multiTimeframeTrend: number | null;
  timeframeTrend15m?: number | null;
  timeframeTrend1h?: number | null;
  timeframeTrend4h?: number | null;
  benchmarkMomentum: number | null;
  optionsIvPercentile?: number | null;
  macroEventRisk: number | null;
  dataQuality: number;
  candles5m: Hte31Candle[];
  crossSectionRank?: number | null;
  rotationVelocity?: number | null;
  marketAdvancingRatio?: number | null;
  marketDecliningRatio?: number | null;
};

export type Hte31StrategyId =
  | "trend_breakout" | "trend_pullback" | "failed_breakout" | "trend_exhaustion_reversal" | "higher_timeframe_swing"
  | "trend_breakout_challenger" | "trend_pullback_challenger" | "failed_breakout_challenger" | "higher_timeframe_swing_challenger"
  | "range_rotation" | "compression_expansion" | "relative_strength" | "momentum_continuation";

export type Hte31StrategyMeta = {
  playbookId: string;
  assetRegime: Hte31AssetRegime;
  setupScore: number;
  evidenceScore: number;
  triggerActive: boolean;
  hardGatePassed: boolean;
  candidateSide: Hte31TradeSide;
  globalRegime?: string;
  tradeMode?: "exploration" | "standard" | "high_conviction";
  supportingPlaybooks?: string[];
  strategyConflict?: number;
  experienceSamples?: number;
  expectancyR?: number | null;
  executionLane?: "control" | "research";
  baselineId?: string;
  storyFamily?: "trend" | "reversal" | "range" | "volatility" | "relative_strength";
};

export type Hte31Signal = {
  strategyId: Hte31StrategyId;
  label: string;
  shadowOnly: true;
  state: "ready" | "watching" | "blocked";
  side: Hte31TradeSide | "WAIT";
  score: number;
  confidence: number;
  regime: Hte31MarketRegime;
  thesis: string;
  reasons: string[];
  blockers: string[];
  entryPlan: Hte31EntryPlan | null;
  metrics: Hte31SignalMetric[];
  strategyMeta: Hte31StrategyMeta;
};
