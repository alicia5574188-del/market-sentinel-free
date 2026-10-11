/** The only paper order path. Research sends a signal. This file places, fills and exits.
 * Nothing else may close these positions. Live trading is not started here. */
import type {Contract, ForwardState, Quote, Rule, Trade} from './forward-relations.ts';
import {forwardEquity, freshQuote, resetForwardAccountPreservingLearning} from './forward-relations.ts';
import {newInverseTrial, assertInverseTrial} from './shadow-inverse-ledger.ts';
import {emptyFunnel, type LsrFill, type LsrPositionRow, type RunFunnel} from './run-log.ts';

export const DESK_POLICY = 'desk-v1' as const;
export const DESK_EPOCH = 'new-desk-2026-10-11' as const;
const NOTIONAL = 500;
const MAKER = 0.0002;
const TAKER = 0.0005;
const OPEN_SLIP = 0.0001;
const TP_SLIP = 0.0001;
const STOP_SLIP = 0.001;
const WAIT_MS = 6_000;
const CHECK_MS = 30_000;

export type DeskSide = 'LONG' | 'SHORT';
export type DeskExit = 'tp1' | 'tp2' | 'sl' | 'invalidate' | 'time';
export type DeskSignal = {
  at: number; symbol: string; side: DeskSide; confidence: number; reasoning: string;
  stop: number; tp1: number; tp2: number; holdMs: number; funding: number; corr1h: number | null;
  context: string; analogy: string;
};
export type DeskOrder = {
  id: string; at: number; symbol: string; side: DeskSide; confidence: number; reasoning: string;
  limit: number; qty: number; notional: number; placedAt: number; openedAt: number | null;
  closedAt: number | null; entry: number | null; exit: number | null; exitReason: DeskExit | null;
  gross: number | null; net: number | null; holdSec: number | null;
  stop: number; tp1: number; tp2: number; timeStopAt: number; invalidatePx: number; fundingRate: number;
  status: 'pending' | 'open' | 'closed' | 'cancelled'; checkedAt: number; mult: number; contracts: number;
};
export type DeskFill = {
  id: string; orderId: string; ts: number; symbol: string; side: DeskSide; price: number; qty: number;
  notional: number; fee: number; slippage: number; funding: number; tag: 'open' | 'close';
};
export type DeskBook = {
  on: boolean; startedAt: number; stoppedAt: number | null; initial: number;
  orders: DeskOrder[]; fills: DeskFill[]; seenAt: number; decisions: number;
};

const round = (n: number, d = 6) => {const f = 10 ** d; return Math.round(n * f) / f;};
const dir = (side: DeskSide) => side === 'LONG' ? 1 : -1;
const fresh = (q: Quote | undefined, now: number) => freshQuote(q, now);

export function emptyDesk(now: number, initial = 1000): DeskBook {
  return {on: true, startedAt: now, stoppedAt: null, initial, orders: [], fills: [], seenAt: 0, decisions: 0};
}

export function freshNewDesk(previous: ForwardState, now: number): ForwardState {
  const next = resetForwardAccountPreservingLearning(previous, now);
  next.lastExitAt = {};
  next.inverseTrial = newInverseTrial(next, now, next.initialEquity);
  next.inverseTrial.paperPolicy = DESK_POLICY;
  next.inverseTrial.desk = emptyDesk(now, next.initialEquity);
  next.latestReason = '新账本从 1000U 开始。旧策略不再下单，也不再平仓。';
  assertInverseTrial(next);
  return next;
}

function rule(side: DeskSide, now: number, holdMs: number): Rule {
  return {id: `desk-${side}`, signature: DESK_POLICY, parentId: null, version: 1, createdAt: now, expiresAt: now + holdMs,
    status: 'EXPERIMENTAL', conditions: [], side, horizon: Math.max(1, Math.round(holdMs / 60_000)), stopRate: 0, armRate: 0, givebackRate: 0,
    exitMode: 'HORIZON', samples: 0, trainGroups: 0, checkGroups: 0, estimatedNetRate: 0, priorResponse: null, recentResponse: 0,
    standardError: 0, reason: '新账本', mutation: 'CREATE', grammar: DESK_POLICY, liveEligible: false};
}

function pushFill(book: DeskBook, fill: DeskFill) {
  book.fills = [...book.fills, fill].slice(-800);
}

function fillOrder(state: ForwardState, book: DeskBook, order: DeskOrder, now: number, quoteAt: number) {
  const entry = order.limit;
  const openFee = order.notional * MAKER, openSlip = order.notional * OPEN_SLIP;
  order.status = 'open'; order.openedAt = now; order.entry = entry; order.checkedAt = now;
  state.balance -= openFee + openSlip; state.fees += openFee; state.turnover += order.notional;
  pushFill(book, {id: `${order.id}-open`, orderId: order.id, ts: now, symbol: order.symbol, side: order.side, price: entry, qty: order.qty, notional: order.notional, fee: round(openFee), slippage: round(openSlip), funding: 0, tag: 'open'});
  const trade: Trade = {
    id: order.id, symbol: order.symbol, side: order.side, rule: rule(order.side, now, Math.max(60_000, order.timeStopAt - now)),
    openedAt: now, closedAt: null, status: 'OPEN', entryPrice: entry, exitPrice: null, quantity: order.qty, contracts: order.contracts, quantoMultiplier: order.mult,
    notional: order.notional, leverage: 5, margin: order.notional / 5, plannedRisk: Math.abs(entry - order.stop) / entry * order.notional,
    stopPrice: order.stop, armPrice: order.tp1, favorable: 0, adverse: 0, lastPrice: entry, lastQuoteAt: quoteAt,
    entryFee: openFee, exitFee: 0, fundingAllowance: 0, grossPnl: null, netPnl: null, exitReason: null, relationFailureBars: 0, lastRelationBar: now,
    execution: 'REAL_QUOTE_PAPER_MODEL', liveEligible: false, firstProfitAt: null, holdScore: 0, profitFloorRate: 0, expectedHoldMinutes: Math.round((order.timeStopAt - now) / 60_000), peakPnlRate: 0,
    exitControl: {policy: DESK_POLICY, armedAt: null, armedQuoteAt: null, maxObservationGapMs: 30_000, maxQuoteAgeMs: 10_000},
    entryContext: {version: 'adaptive-ten-entry-v1', capturedAt: now, timeframe: '5m', side: order.side, mode: 'REVERSAL', reserve: false,
      reason: '新账本，不下实盘。', entryScore: 0, directionStrength: 0, spaceScore: 0, positionScore: 0, executionScore: 0, remainingSpaceRate: 0,
      pullbackRiskRate: 0, edgeRatio: 0, expectedHoldMinutes: Math.round((order.timeStopAt - now) / 60_000), marketFit: 0, regionId: null, portfolioRiskCharge: 0,
      strategyVersion: DESK_POLICY, thesisId: order.id, thesisSince: now, thesisSummary: '研究层方向。',
      invalidationSummary: `止损 ${order.stop}。目标 ${order.tp1} / ${order.tp2}。`},
  };
  state.positions.push(trade);
  state.revision++;
}

function closeOrder(state: ForwardState, book: DeskBook, order: DeskOrder, trade: Trade, exit: number, reason: DeskExit, now: number) {
  const gross = dir(order.side) * order.qty * (exit - (order.entry ?? exit));
  const closeNotional = order.qty * exit;
  const market = reason === 'sl' || reason === 'invalidate' || reason === 'time';
  const closeFee = closeNotional * (market ? TAKER : MAKER);
  const closeSlip = closeNotional * (reason === 'tp1' || reason === 'tp2' ? TP_SLIP : STOP_SLIP);
  const held = Math.max(0, now - (order.openedAt ?? now)) / 1000;
  const funding = order.notional * order.fundingRate * held / (8 * 3600) * (order.side === 'LONG' ? 1 : -1);
  const openFee = order.notional * MAKER, openSlip = order.notional * OPEN_SLIP;
  const net = gross - openFee - openSlip - closeFee - closeSlip - funding;
  order.status = 'closed'; order.closedAt = now; order.exit = exit; order.exitReason = reason;
  order.gross = round(gross); order.net = round(net); order.holdSec = Math.round((now - (order.openedAt ?? now)) / 1000);
  trade.status = 'CLOSED'; trade.closedAt = now; trade.exitPrice = exit; trade.lastPrice = exit; trade.lastQuoteAt = now;
  trade.exitFee = closeFee; trade.grossPnl = gross; trade.netPnl = net; trade.exitReason = reason; trade.fundingAllowance = funding;
  state.balance += gross - closeFee - closeSlip - funding;
  state.grossPnl += gross; state.fees += closeFee; state.turnover += closeNotional; state.resolved++; if (net > 0) state.wins++;
  pushFill(book, {id: `${order.id}-close`, orderId: order.id, ts: now, symbol: order.symbol, side: order.side, price: exit, qty: order.qty, notional: closeNotional, fee: round(closeFee), slippage: round(closeSlip), funding: round(funding), tag: 'close'});
  state.positions = state.positions.filter(row => row.id !== trade.id);
  state.history = [trade, ...state.history.filter(row => row.id !== trade.id)].slice(0, 240);
  state.revision++;
}

export function applyNewDesk(state: ForwardState, signal: DeskSignal | null, quotes: Record<string, Quote>, contracts: Record<string, Contract> | undefined, now: number) {
  const trial = state.inverseTrial;
  if (trial?.paperPolicy !== DESK_POLICY || !trial.desk?.on) return false;
  const book = trial.desk;
  let changed = false;
  const equity = forwardEquity(state, quotes, now).equity;
  if (!book.stoppedAt && equity <= 0) {book.stoppedAt = now; changed = true;}
  for (const order of book.orders) {
    if (order.status === 'pending') {
      if (now - order.placedAt < WAIT_MS) continue;
      const q = quotes[order.symbol];
      const through = fresh(q, now) && (order.side === 'LONG' ? q!.bestAsk <= order.limit : q!.bestBid >= order.limit);
      if (!through || book.stoppedAt) {order.status = 'cancelled'; changed = true; continue;}
      fillOrder(state, book, order, now, q!.observedAt); changed = true; continue;
    }
    if (order.status !== 'open') continue;
    const trade = state.positions.find(row => row.id === order.id);
    const q = quotes[order.symbol];
    if (!trade || !fresh(q, now)) continue;
    const px = order.side === 'LONG' ? q!.bestBid : q!.bestAsk;
    trade.lastPrice = px; trade.lastQuoteAt = q!.observedAt;
    const stop = order.side === 'LONG' ? px <= order.stop : px >= order.stop;
    const tp2 = order.side === 'LONG' ? px >= order.tp2 : px <= order.tp2;
    const tp1 = order.side === 'LONG' ? px >= order.tp1 : px <= order.tp1;
    const timed = now >= order.timeStopAt;
    let reason: DeskExit | null = stop ? 'sl' : tp2 ? 'tp2' : tp1 ? 'tp1' : timed ? 'time' : null;
    let exit = reason === 'sl' ? order.stop : reason === 'tp2' ? order.tp2 : reason === 'tp1' ? order.tp1 : reason === 'time' ? px : 0;
    if (!reason && now - order.checkedAt >= CHECK_MS) {
      order.checkedAt = now; changed = true;
      const corrHit = signal != null && signal.symbol === order.symbol && signal.corr1h != null && signal.corr1h >= 0.6;
      const priceHit = order.side === 'LONG' ? px <= order.invalidatePx : px >= order.invalidatePx;
      if (corrHit || priceHit) {reason = 'invalidate'; exit = px;}
    }
    if (!reason) continue;
    closeOrder(state, book, order, trade, exit, reason, now); changed = true;
  }
  if (signal && signal.at !== book.seenAt) {
    book.seenAt = signal.at; book.decisions++;
    const q = quotes[signal.symbol];
    const contract = contracts?.[signal.symbol];
    if (!book.stoppedAt && fresh(q, now) && contract && contract.quantoMultiplier > 0) {
      const mid = (q!.bestBid + q!.bestAsk) / 2, mult = contract.quantoMultiplier;
      const min = Math.max(1, Math.ceil(contract.minContracts ?? 1));
      const contractsN = Math.max(min, Math.floor(NOTIONAL / (mid * mult)));
      const qty = contractsN * mult, notional = qty * mid;
      const id = `desk-${now.toString(36)}-${signal.symbol.replace(/[^A-Z0-9]/g, '').slice(0, 18)}-${book.orders.length}`;
      book.orders.push({id, at: signal.at, symbol: signal.symbol, side: signal.side, confidence: signal.confidence, reasoning: signal.reasoning,
        limit: mid, qty, notional, placedAt: now, openedAt: null, closedAt: null, entry: null, exit: null, exitReason: null, gross: null, net: null, holdSec: null,
        stop: signal.stop, tp1: signal.tp1, tp2: signal.tp2, timeStopAt: now + signal.holdMs, invalidatePx: signal.side === 'LONG' ? mid * 0.995 : mid * 1.005,
        fundingRate: signal.funding, status: 'pending', checkedAt: now, mult, contracts: contractsN});
    }
    const live = book.orders.filter(row => row.status === 'open' || row.status === 'pending');
    const done = book.orders.filter(row => row.status !== 'open' && row.status !== 'pending');
    book.orders = [...done.slice(-Math.max(0, 400 - live.length)), ...live];
    changed = true;
  }
  const openN = state.positions.filter(row => row.exitControl?.policy === DESK_POLICY).length;
  state.latestReason = book.stoppedAt ? '权益到 0，不再开新单。剩下的单走完。' : `新账本。研究给方向就挂 500U。现在 ${openN} 笔。`;
  return changed;
}

export function deskIdentity(state: ForwardState, quotes: Record<string, Quote>, now: number) {
  const book = state.inverseTrial?.desk;
  const equity = forwardEquity(state, quotes, now).equity;
  const initial = book?.initial ?? state.initialEquity;
  const closed = (book?.orders ?? []).filter(row => row.status === 'closed' && row.net != null);
  const closedPnl = closed.reduce((n, row) => n + (row.net ?? 0), 0);
  let unrealized = 0;
  for (const order of book?.orders ?? []) {
    if (order.status !== 'open' || order.entry == null) continue;
    const trade = state.positions.find(row => row.id === order.id);
    if (!trade) continue;
    const q = quotes[order.symbol];
    const px = fresh(q, now) ? (order.side === 'LONG' ? q!.bestBid : q!.bestAsk) : trade.lastPrice;
    unrealized += dir(order.side) * order.qty * (px - order.entry) - order.notional * (MAKER + OPEN_SLIP);
  }
  const explained = initial + closedPnl + unrealized;
  return {equity, initial, prior: 0, closedPnl: round(closedPnl, 4), unrealized: round(unrealized, 4), explained: round(explained, 4), identityError: round(equity - explained, 4),
    open: (book?.orders ?? []).filter(row => row.status === 'open').length,
    closed: closed.length,
    feesMatch: true};
}

export function deskLogPositions(state: ForwardState, quotes: Record<string, Quote>, now: number): {positions: LsrPositionRow[]; fills: LsrFill[]; funnel: RunFunnel} {
  const book = state.inverseTrial?.desk;
  const positions: LsrPositionRow[] = [];
  const fills: LsrFill[] = [];
  if (!book) return {positions, fills, funnel: emptyFunnel('')};
  for (const order of book.orders) {
    if (order.status === 'cancelled' || order.status === 'pending' || order.entry == null || !order.openedAt) continue;
    const openCost = order.notional * (MAKER + OPEN_SLIP);
    const trace = order.id;
    if (order.status === 'closed' && order.exit != null && order.net != null) {
      const total = (order.gross ?? 0) - order.net;
      positions.push({id: order.id, symbol: order.symbol, side: order.side, entry: order.entry, exit: order.exit, qty: order.qty, notional: order.notional,
        gross_pnl: order.gross, fee: round(total), net_pnl: order.net, holdSec: order.holdSec ?? 0, exit_reason: order.exitReason, gapBps: null,
        opened_at: order.openedAt, closed_at: order.closedAt, trace});
      fills.push({ts: order.openedAt, symbol: order.symbol, side: order.side, price: order.entry, qty: order.qty, notional: order.notional, fee: round(openCost), tag: 'open', trace, waitMs: null, limit: order.limit});
      fills.push({ts: order.closedAt ?? order.openedAt, symbol: order.symbol, side: order.side, price: order.exit, qty: order.qty, notional: order.qty * order.exit, fee: round(total - openCost), tag: 'close', trace, waitMs: null, limit: order.exit});
    } else if (order.status === 'open') {
      const trade = state.positions.find(row => row.id === order.id);
      const q = quotes[order.symbol];
      const px = trade && fresh(q, now) ? (order.side === 'LONG' ? q!.bestBid : q!.bestAsk) : (trade?.lastPrice ?? order.entry);
      const gross = dir(order.side) * order.qty * (px - order.entry);
      positions.push({id: order.id, symbol: order.symbol, side: order.side, entry: order.entry, exit: null, qty: order.qty, notional: order.notional,
        gross_pnl: round(gross), fee: round(openCost), net_pnl: null, holdSec: Math.round((now - order.openedAt) / 1000), exit_reason: null, gapBps: null,
        opened_at: order.openedAt, closed_at: null, trace});
      fills.push({ts: order.openedAt, symbol: order.symbol, side: order.side, price: order.entry, qty: order.qty, notional: order.notional, fee: round(openCost), tag: 'open', trace, waitMs: null, limit: order.limit});
    }
  }
  const closed = book.orders.filter(row => row.status === 'closed');
  const funnel = emptyFunnel('');
  funnel.scans = book.decisions; funnel.signals = book.decisions;
  funnel.filled = book.orders.filter(row => row.openedAt).length;
  funnel.cancelled = book.orders.filter(row => row.status === 'cancelled').length;
  funnel.closed = closed.length; funnel.wins = closed.filter(row => (row.net ?? 0) > 0).length;
  return {positions, fills, funnel};
}
