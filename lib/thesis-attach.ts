/** Attaches the new closed loop to whatever market the host already has.
 * It does not import the old strategy, the old position book, or the old exit path. */
import { StrategySystem, type StrategyCapture } from '../src/strategy-system/index.ts';
import type { Executor, OrderRequest } from '../src/strategy-system/execution/executor.ts';
import type { Fill, MarketSnapshot, Regime } from '../src/strategy-system/types.ts';
import type { Action } from '../src/strategy-system/decision/policy.ts';
import { Ledger } from '../src/strategy-system/ledger/ledger.ts';
import type { ThesisPublic } from './thesis-view.ts';

export const THESIS_STORAGE_KEY = 'thesis-attached-v1';
const FEE_RATE = 0.00055;

export interface ThesisMarket {
  symbol: string;
  candles: { ts: number; open: number; high: number; low: number; close: number; volume: number }[];
  price: number;
  bid: number;
  ask: number;
  fundingRate: number;
  volume24h: number;
  btcPrice: number;
  btcChange24h: number;
}

export interface ThesisAttached {
  version: 'thesis-v1';
  updatedAt: number;
  initialEquity: number;
  capture: StrategyCapture | null;
  lastError: string | null;
  view?: ThesisPublic;
}

export function emptyThesis(initialEquity: number, now: number): ThesisAttached {
  return { version: 'thesis-v1', updatedAt: now, initialEquity, capture: null, lastError: null };
}

function snapshotOf(market: ThesisMarket, btcRegime: Regime): MarketSnapshot {
  return {
    symbol: market.symbol,
    ts: market.candles.at(-1)?.ts ?? 0,
    price: market.price,
    bid: market.bid,
    ask: market.ask,
    candles: { '1h': market.candles },
    fundingRate: market.fundingRate,
    openInterest: 0,
    openInterestChange24h: 0,
    takerBuyRatio: 0.5,
    longShortRatio: 1,
    orderbook: { bidDepth: 1, askDepth: 1 },
    btcPrice: market.btcPrice,
    btcChange24h: market.btcChange24h,
    btcRegime,
    volume24h: market.volume24h,
    fearGreedIndex: 50,
  };
}

function markToMarket(ledger: Ledger, marks: Map<string, number>, initial: number): number {
  let closed = 0;
  let unrealized = 0;
  for (const position of ledger.allPositions()) {
    if (position.exit !== null) closed += position.netPnl ?? 0;
    else {
      const mark = marks.get(position.symbol) ?? position.entry;
      const dir = position.side === 'LONG' ? 1 : -1;
      unrealized += (mark - position.entry) * position.qty * dir - position.fee;
    }
  }
  return initial + closed + unrealized;
}

class BookExecutor implements Executor {
  private readonly now: number;
  private readonly marks: Map<string, number>;

  constructor(now: number, marks: Map<string, number>) {
    this.now = now;
    this.marks = marks;
  }

  async placeOrder(req: OrderRequest): Promise<Fill> {
    const mark = this.marks.get(req.symbol) ?? 0;
    const buying = (req.tag === 'open' && req.side === 'LONG') || (req.tag === 'close' && req.side === 'SHORT');
    const price = buying ? mark * 1.00005 : mark * 0.99995;
    const notional = req.qty * price;
    return {
      ts: this.now,
      symbol: req.symbol,
      side: req.side,
      price,
      qty: req.qty,
      notional,
      fee: notional * FEE_RATE,
      tag: req.tag,
      trace: req.trace,
      reason: req.reason,
    };
  }

  async getEquity(): Promise<number> {
    return 0;
  }

  async getMarkPrice(symbol: string): Promise<number> {
    return this.marks.get(symbol) ?? 0;
  }
}

function actionText(action: Action): string {
  if (action.type === 'OPEN') return action.direction === 'LONG' ? '开多' : '开空';
  if (action.type === 'REVERSE') return action.direction === 'LONG' ? '反手多' : '反手空';
  if (action.type === 'CLOSE') return '平仓';
  return '持有';
}

function drawdownOf(points: { equity: number }[], equity: number): number {
  let peak = 0;
  let worst = 0;
  for (const point of points) {
    if (point.equity > peak) peak = point.equity;
    if (peak > 0) worst = Math.max(worst, (peak - point.equity) / peak);
  }
  if (equity > peak) peak = equity;
  if (peak > 0) worst = Math.max(worst, (peak - equity) / peak);
  return worst;
}

function bindThesis(prev: ThesisAttached | null, markets: ThesisMarket[], now: number, initialEquity: number) {
  const initial = prev?.initialEquity ?? initialEquity;
  const marks = new Map(markets.map((market) => [market.symbol, market.price]));
  const btcRegime: Regime = Math.abs(markets[0]?.btcChange24h ?? 0) >= 0.02 ? 'TREND' : 'RANGE';
  const snapshots = new Map(markets.map((market) => [market.symbol, snapshotOf(market, btcRegime)]));
  let ledgerRef: Ledger | null = null;
  const system = new StrategySystem({
    executor: new BookExecutor(now, marks),
    symbols: markets.map((market) => market.symbol),
    initialEquity: initial,
    priorAdjustment: 0,
    now: () => now,
    getSnapshot: async (symbol) => {
      const snap = snapshots.get(symbol);
      if (!snap) throw new Error(`没有 ${symbol} 的行情`);
      return snap;
    },
    getMarkPrice: async (symbol) => marks.get(symbol) ?? 0,
    getEquity: async () => (ledgerRef ? markToMarket(ledgerRef, marks, initial) : initial),
  });
  if (prev?.capture) system.restore(prev.capture);
  ledgerRef = system.getLedger();
  return { system, initial, marks };
}

export async function exportAttachedLog(prev: ThesisAttached, markets: ThesisMarket[], now: number) {
  const { system } = bindThesis(prev, markets, now, prev.initialEquity);
  return system.exportLog();
}

export async function runThesisCycle(
  prev: ThesisAttached | null,
  markets: ThesisMarket[],
  now: number,
  initialEquity: number,
): Promise<{ state: ThesisAttached; view: ThesisPublic }> {
  const { system, initial, marks } = bindThesis(prev, markets, now, initialEquity);
  let lastError: string | null = null;
  if (markets.length) {
    try {
      await system.step();
    } catch (error) {
      lastError = error instanceof Error ? error.message : '策略这一拍失败';
    }
  }
  const ledger = system.getLedger();
  const equity = markToMarket(ledger, marks, initial);
  const identity = ledger.identity(equity, marks);
  const funnel = system.getFunnel();
  const open = ledger.openPositions().map((position) => {
    const mark = marks.get(position.symbol) ?? position.entry;
    const dir = position.side === 'LONG' ? 1 : -1;
    const reason = ledger.allFills().find((fill) => fill.trace === position.trace && fill.tag === 'open')?.reason ?? '';
    return {
      symbol: position.symbol,
      side: position.side,
      thesis: position.thesis === 'TREND' ? '趋势' : '假突破',
      entry: position.entry,
      qty: position.qty,
      upl: (mark - position.entry) * position.qty * dir - position.fee,
      reason,
    };
  });
  const recent = ledger.closedPositions().slice(-8).reverse().map((position) => ({
    symbol: position.symbol,
    side: position.side,
    net: position.netPnl ?? 0,
    reason: position.exitReason ?? '',
    closedAt: position.closedAt ?? now,
  }));
  const rows = system.lastViews().map((view) => ({
    symbol: view.symbol,
    action: actionText(view.result.action),
    detail: view.result.detail,
    state: view.result.newContext.thesisState,
    score: view.result.thesisScore,
  }));
  const acted = rows.filter((row) => row.action !== '持有');
  const note = !markets.length
    ? '策略已接上。这一拍还没有同时具备 1 小时 K 和新鲜买卖价的合约，所以没有下单。'
    : acted.length
      ? `这一拍 ${acted.map((row) => `${row.symbol.replace('_', '/')} ${row.action}`).join('，')}。`
      : `这一拍看了 ${markets.length} 个合约，没有新的假突破，也没有该平的仓。`;
  const view: ThesisPublic = {
    version: 'thesis-v1',
    updatedAt: now,
    equity,
    initialEquity: initial,
    netPnl: equity - initial,
    closedPnl: identity.closed_pnl_sum,
    unrealized: identity.unrealized_pnl,
    fees: ledger.allFills().reduce((sum, fill) => sum + fill.fee, 0),
    identityError: identity.identity_error,
    maxDrawdown: drawdownOf(system.curve(), equity),
    scans: funnel.scans,
    signals: funnel.signals,
    filled: funnel.filled,
    closed: funnel.closed,
    wins: funnel.wins,
    open,
    recent,
    rows,
    note: lastError ? `${note} ${lastError}` : note,
  };
  return {
    state: { version: 'thesis-v1', updatedAt: now, initialEquity: initial, capture: system.capture(), lastError, view },
    view,
  };
}
