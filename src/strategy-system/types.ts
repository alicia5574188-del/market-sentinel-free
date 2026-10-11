export type Side = 'LONG' | 'SHORT';
export type Regime = 'IDLE' | 'RANGE' | 'TREND';
export type ThesisState = 'ALIVE' | 'WEAKENING' | 'DYING' | 'DEAD';
export type ThesisType = 'FAKE_BREAKOUT' | 'TREND';

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketSnapshot {
  ts: number;
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  candles: { [tf: string]: Candle[] };
  volume24h: number;
  takerBuyRatio: number;
  orderbook: { bidDepth: number; askDepth: number };
  fundingRate: number;
  openInterest: number;
  openInterestChange24h: number;
  longShortRatio: number;
  btcPrice: number;
  btcChange24h: number;
  btcRegime: Regime;
  fearGreedIndex: number;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  entry: number;
  exit: number | null;
  qty: number;
  notional: number;
  grossPnl: number;
  fee: number;
  netPnl: number | null;
  holdSec: number;
  exitReason: string | null;
  openedAt: number;
  closedAt: number | null;
  trace: string;
  thesis: ThesisType;
  thesisScore: number;
}

export interface Fill {
  ts: number;
  symbol: string;
  side: Side;
  price: number;
  qty: number;
  notional: number;
  fee: number;
  tag: 'open' | 'close';
  trace: string;
  reason?: string;
}

export interface Signal {
  ts: number;
  symbol: string;
  side: Side;
  confidence: number;
  reason: string;
  trace: string;
  type: 'fake_breakout' | 'trend_reversal' | 'observe';
}

export interface ThesisFactor {
  name: string;
  score: number;
  weight: number;
  detail: string;
}
