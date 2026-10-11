export interface ThesisRow {
  symbol: string;
  action: string;
  detail: string;
  state: string;
  score: number;
}

export interface ThesisPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  thesis: string;
  entry: number;
  qty: number;
  upl: number;
  reason: string;
}

export interface ThesisClose {
  symbol: string;
  side: 'LONG' | 'SHORT';
  net: number;
  reason: string;
  closedAt: number;
}

export interface ThesisPublic {
  version: 'thesis-v1';
  updatedAt: number;
  equity: number;
  initialEquity: number;
  netPnl: number;
  closedPnl: number;
  unrealized: number;
  fees: number;
  identityError: number;
  maxDrawdown: number;
  scans: number;
  signals: number;
  filled: number;
  closed: number;
  wins: number;
  open: ThesisPosition[];
  recent: ThesisClose[];
  rows: ThesisRow[];
  note: string;
}
