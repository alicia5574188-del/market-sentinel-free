import {
  analyzeGateSymbol,
  fetchGateChartCandles,
  fetchGatePositionQuotes,
  fetchGateUniverse,
  type GateAnalysisPacket,
  type GatePositionQuote,
  type UniverseTicker,
} from "./gate-client.ts";
import { fetchGateHistoricalCandles, type HistoricalInterval } from "./gate-history.ts";
import type { GlobalRiskContext } from "./gate-client.ts";
import type { ExperienceBySide } from "./trade-lifecycle.ts";

export type MarketAnalysisPacket = GateAnalysisPacket;
export type MarketUniverseTicker = UniverseTicker;
export type MarketPositionQuote = GatePositionQuote;

export type MarketAnalyzeOptions = {
  global?: Partial<GlobalRiskContext>;
  priorLongProbability?: number | null;
  experience?: ExperienceBySide;
  alertStyle?: "early" | "balanced" | "confirmed";
  detail?: "full" | "scan";
};

export interface MarketExchangeAdapter {
  readonly id: string;
  readonly label: string;
  fetchUniverse(limit: number, coreSymbols: string[]): Promise<MarketUniverseTicker[]>;
  analyzeSymbol(symbol: string, options?: MarketAnalyzeOptions): Promise<MarketAnalysisPacket>;
  fetchPositionQuotes(symbols: string[]): Promise<MarketPositionQuote[]>;
  fetchChartCandles(symbol: string, fromMs: number, toMs: number): ReturnType<typeof fetchGateChartCandles>;
  fetchHistoricalCandles(symbol: string, interval: HistoricalInterval, limit?: number): ReturnType<typeof fetchGateHistoricalCandles>;
}

const gateAdapter: MarketExchangeAdapter = {
  id: "gate",
  label: "Gate",
  fetchUniverse: fetchGateUniverse,
  analyzeSymbol: analyzeGateSymbol,
  fetchPositionQuotes: fetchGatePositionQuotes,
  fetchChartCandles: fetchGateChartCandles,
  fetchHistoricalCandles: fetchGateHistoricalCandles,
};

/**
 * Single public-market boundary for the strategy runtime. Gate remains the
 * first adapter, but strategy code no longer needs to know which exchange
 * supplies the canonical market packet. A future exchange only implements
 * this interface and maps its payload into the same packet shape.
 */
export function getMarketExchange(): MarketExchangeAdapter {
  return gateAdapter;
}
