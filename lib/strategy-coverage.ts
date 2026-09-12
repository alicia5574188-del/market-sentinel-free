export type MarketPhase = "COMPRESSION" | "EXPANSION" | "ORDERLY_TREND" | "BALANCED_ROTATION" | "TRANSITION";
export type MarketCrowding = "BROAD_UP" | "BROAD_DOWN" | "MIXED";
export type MarketLocation = "LOW_EDGE" | "CENTER" | "HIGH_EDGE";

export type MarketStateFeatures = {
  trendRate: number;
  trendEfficiency: number;
  volatilityRatio: number;
  rangePosition: number;
  marketBreadth: number;
  marketMedianMove: number;
};

export type MarketStateCandle = { open: number; high: number; low: number; close: number };

export type MarketStateCell = {
  key: string;
  phase: MarketPhase;
  crowding: MarketCrowding;
  location: MarketLocation;
};

export type CoverageTrade = {
  strategyId: string;
  strategyName: string;
  symbol: string;
  side: "LONG" | "SHORT";
  openedAt: number;
  netReturnRate: number;
  state: MarketStateFeatures;
};

export type CoverageMetrics = {
  trades: number;
  wins: number;
  winRate: number;
  netReturnRate: number;
  meanReturnRate: number;
  profitFactor: number;
  symbols: number;
  periods: number;
  positivePeriods: number;
  profitablePeriods: string[];
};

export type CoverageCellResult = {
  strategyId: string;
  strategyName: string;
  state: MarketStateCell;
  discovery: CoverageMetrics;
  validation: CoverageMetrics;
  discoveryQualified: boolean;
  accepted: boolean;
  blockers: string[];
};

export type StrategyCoverageReport = {
  splitAt: number;
  thresholds: CoverageThresholds;
  knownCells: Array<{ state: MarketStateCell; discoveryOpportunities: number; validationOpportunities: number }>;
  acceptedCells: CoverageCellResult[];
  gaps: Array<{ state: MarketStateCell; discoveryOpportunities: number; validationOpportunities: number }>;
  cells: CoverageCellResult[];
  phases: Array<{ phase: MarketPhase; knownCells: number; coveredCells: number; coverageRate: number; fullyCovered: boolean;
    strategyIds: string[] }>;
};

export type CoverageThresholds = {
  discoveryTrades: number;
  validationTrades: number;
  discoveryProfitFactor: number;
  validationProfitFactor: number;
  validationSymbols: number;
  validationPositivePeriods: number;
  knownDiscoveryOpportunities: number;
  knownValidationOpportunities: number;
  periodMs: number;
};

const DEFAULT_THRESHOLDS: CoverageThresholds = {
  discoveryTrades: 12,
  validationTrades: 8,
  discoveryProfitFactor: 1.05,
  validationProfitFactor: 1,
  validationSymbols: 2,
  validationPositivePeriods: 2,
  knownDiscoveryOpportunities: 20,
  knownValidationOpportunities: 12,
  periodMs: 7 * 24 * 60 * 60_000,
};

const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const median = (values: number[]) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

export function deriveMarketStateFeatures(candles: MarketStateCandle[], marketBreadth: number, marketMedianMove: number): MarketStateFeatures | null {
  const rows = candles.slice(-120);
  if (rows.length < 48) return null;
  const latest = rows.at(-1)!;
  const trend = rows.slice(-24);
  const location = rows.slice(-48);
  const travel = trend.slice(1).reduce((total, row, index) => total + Math.abs(row.close - trend[index].close), 0);
  const recentRange = median(rows.slice(-6).map((row) => row.high - row.low));
  const priorRange = median(rows.slice(-30, -6).map((row) => row.high - row.low));
  const lower = Math.min(...location.map((row) => row.low));
  const upper = Math.max(...location.map((row) => row.high));
  return { trendRate: latest.close / trend[0].open - 1,
    trendEfficiency: Math.abs(latest.close - trend[0].open) / Math.max(travel, latest.close * 1e-7),
    volatilityRatio: recentRange / Math.max(priorRange, latest.close * 1e-9),
    rangePosition: (latest.close - lower) / Math.max(upper - lower, latest.close * 1e-9),
    marketBreadth, marketMedianMove };
}

/** Classifies only information available at signal time. Trade outcome fields are deliberately absent. */
export function classifyMarketState(features: MarketStateFeatures): MarketStateCell {
  const efficiency = clamp(finite(features.trendEfficiency), 0, 1);
  const volatilityRatio = Math.max(0, finite(features.volatilityRatio, 1));
  const trendRate = finite(features.trendRate);
  const breadth = clamp(finite(features.marketBreadth, 0.5), 0, 1);
  const marketMove = finite(features.marketMedianMove);
  const rangePosition = clamp(finite(features.rangePosition, 0.5), 0, 1);
  const phase: MarketPhase = volatilityRatio <= 0.78 ? "COMPRESSION"
    : volatilityRatio >= 1.35 ? "EXPANSION"
      : efficiency >= 0.42 && Math.abs(trendRate) >= 0.003 ? "ORDERLY_TREND"
        : efficiency <= 0.28 ? "BALANCED_ROTATION" : "TRANSITION";
  const crowding: MarketCrowding = breadth >= 0.62 && marketMove >= 0.0012 ? "BROAD_UP"
    : breadth <= 0.38 && marketMove <= -0.0012 ? "BROAD_DOWN" : "MIXED";
  const location: MarketLocation = rangePosition <= 0.28 ? "LOW_EDGE"
    : rangePosition >= 0.72 ? "HIGH_EDGE" : "CENTER";
  return { key: `${phase}:${crowding}:${location}`, phase, crowding, location };
}

function periodKey(openedAt: number, periodMs: number) {
  const start = Math.floor(openedAt / periodMs) * periodMs;
  return new Date(start).toISOString().slice(0, 10);
}

export function coverageMetrics(trades: CoverageTrade[], periodMs = DEFAULT_THRESHOLDS.periodMs): CoverageMetrics {
  const returns = trades.map((trade) => finite(trade.netReturnRate));
  const gain = returns.filter((value) => value > 0).reduce((total, value) => total + value, 0);
  const loss = Math.abs(returns.filter((value) => value <= 0).reduce((total, value) => total + value, 0));
  const byPeriod = new Map<string, number>();
  for (const trade of trades) {
    const key = periodKey(trade.openedAt, periodMs);
    byPeriod.set(key, (byPeriod.get(key) ?? 0) + finite(trade.netReturnRate));
  }
  const profitablePeriods = [...byPeriod].filter(([, value]) => value > 0).map(([key]) => key).sort();
  const wins = returns.filter((value) => value > 0).length;
  const netReturnRate = returns.reduce((total, value) => total + value, 0);
  return { trades: trades.length, wins, winRate: trades.length ? wins / trades.length : 0,
    netReturnRate, meanReturnRate: trades.length ? netReturnRate / trades.length : 0,
    profitFactor: loss > 0 ? gain / loss : gain > 0 ? 99 : 0,
    symbols: new Set(trades.map((trade) => trade.symbol)).size, periods: byPeriod.size,
    positivePeriods: profitablePeriods.length, profitablePeriods };
}

function deduplicatedOpportunities(trades: CoverageTrade[], splitAt: number) {
  const byCell = new Map<string, { state: MarketStateCell; discovery: Set<string>; validation: Set<string> }>();
  for (const trade of trades) {
    const state = classifyMarketState(trade.state);
    const row = byCell.get(state.key) ?? { state, discovery: new Set<string>(), validation: new Set<string>() };
    const opportunity = `${trade.symbol}:${trade.side}:${trade.openedAt}`;
    (trade.openedAt < splitAt ? row.discovery : row.validation).add(opportunity);
    byCell.set(state.key, row);
  }
  return byCell;
}

export function buildStrategyCoverageReport(trades: CoverageTrade[], splitAt: number,
  overrides: Partial<CoverageThresholds> = {}): StrategyCoverageReport {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...overrides };
  const validTrades = trades.filter((trade) => trade.openedAt > 0 && Number.isFinite(trade.netReturnRate)
    && trade.strategyId && trade.strategyName && trade.symbol);
  const opportunities = deduplicatedOpportunities(validTrades, splitAt);
  const knownCells = [...opportunities.values()].filter((row) => row.discovery.size >= thresholds.knownDiscoveryOpportunities
    && row.validation.size >= thresholds.knownValidationOpportunities)
    .map((row) => ({ state: row.state, discoveryOpportunities: row.discovery.size, validationOpportunities: row.validation.size }))
    .sort((left, right) => left.state.key.localeCompare(right.state.key));
  const strategyIds = [...new Set(validTrades.map((trade) => trade.strategyId))].sort();
  const cells = strategyIds.flatMap((strategyId) => knownCells.map((known): CoverageCellResult => {
    const matching = validTrades.filter((trade) => trade.strategyId === strategyId
      && classifyMarketState(trade.state).key === known.state.key);
    const discovery = coverageMetrics(matching.filter((trade) => trade.openedAt < splitAt), thresholds.periodMs);
    const validation = coverageMetrics(matching.filter((trade) => trade.openedAt >= splitAt), thresholds.periodMs);
    const discoveryQualified = discovery.trades >= thresholds.discoveryTrades
      && discovery.netReturnRate > 0 && discovery.profitFactor >= thresholds.discoveryProfitFactor;
    const blockers: string[] = [];
    if (!discoveryQualified) blockers.push("DISCOVERY_EDGE");
    if (validation.trades < thresholds.validationTrades) blockers.push("VALIDATION_SAMPLE");
    if (validation.netReturnRate <= 0 || validation.profitFactor < thresholds.validationProfitFactor) blockers.push("VALIDATION_EDGE");
    if (validation.symbols < thresholds.validationSymbols) blockers.push("SYMBOL_CONCENTRATION");
    if (validation.positivePeriods < thresholds.validationPositivePeriods) blockers.push("TIME_CONCENTRATION");
    const first = matching[0];
    return { strategyId, strategyName: first?.strategyName ?? strategyId, state: known.state,
      discovery, validation, discoveryQualified, accepted: blockers.length === 0, blockers };
  }));
  const acceptedCells = cells.filter((cell) => cell.accepted);
  const gaps = knownCells.filter((known) => !acceptedCells.some((cell) => cell.state.key === known.state.key));
  const phases = (["COMPRESSION", "EXPANSION", "ORDERLY_TREND", "BALANCED_ROTATION", "TRANSITION"] as const)
    .map((phase) => {
      const known = knownCells.filter((cell) => cell.state.phase === phase);
      const covered = known.filter((cell) => acceptedCells.some((result) => result.state.key === cell.state.key));
      return { phase, knownCells: known.length, coveredCells: covered.length,
        coverageRate: known.length ? covered.length / known.length : 0, fullyCovered: known.length > 0 && covered.length === known.length,
        strategyIds: [...new Set(acceptedCells.filter((cell) => cell.state.phase === phase).map((cell) => cell.strategyId))] };
    });
  return { splitAt, thresholds, knownCells, acceptedCells, gaps, cells, phases };
}
