/** Paper-only experiment. Research decides the side. This file only places and exits.
 * It never turns on live trading. The run stops when equity is at or below zero, not on a clock. */
import type {Contract, ForwardState, Quote, Rule, Trade} from './forward-relations.ts';
import {forwardEquity} from './forward-relations.ts';

export const RX_POLICY = 'rx-v1';
const NOTIONAL = 500;
const MAKER = 0.0002;
const TAKER = 0.0005;
const OPEN_SLIP = 0.0001;
const TP_SLIP = 0.0001;
const STOP_SLIP = 0.001;
const WAIT_MS = 6_000;
const CHECK_MS = 30_000;
const STALE_MS = 2_000;

export type RxSide = 'LONG' | 'SHORT';
export type RxExit = 'tp1' | 'tp2' | 'sl' | 'invalidate' | 'time';
export type RxOrder = {
  id: string; decisionAt: number; symbol: string; direction: RxSide; confidence: number;
  entry: number; limit: number; qty: number; notional: number; placedAt: number; openedAt: number | null;
  closedAt: number | null; exit: number | null; exitReason: RxExit | null; gross: number | null; net: number | null;
  holdSec: number | null; stop: number; tp1: number; tp2: number; timeStopAt: number; invalidatePx: number;
  fundingRate: number; status: 'pending' | 'open' | 'closed' | 'cancelled'; checkedAt: number; mult: number; contracts: number;
};
export type RxFee = {
  orderId: string; openFee: number; closeFee: number; openSlippage: number; closeSlippage: number;
  fundingFee: number; totalCost: number; note: string;
};
export type RxDecision = {
  at: number; symbol: string; direction: RxSide | null; confidence: number; reasoning: string;
  action: 'opened' | 'observe' | 'stopped'; orderId: string | null; context: string; analogy: string;
};
export type RxSignal = {
  at: number; symbol: string; side: RxSide; confidence: number; reasoning: string;
  stop: number; tp1: number; tp2: number; holdMs: number; funding: number; corr1h: number | null;
  context: string; analogy: string;
};
export type RxBook = {
  on: boolean; startedAt: number; stoppedAt: number | null; stopReason: string | null;
  decisions: RxDecision[]; orders: RxOrder[]; fees: RxFee[]; seenAt: number;
  decisionsN: number; openedN: number; cancelledN: number;
  openFee: number; closeFee: number; openSlippage: number; closeSlippage: number; fundingFee: number; traded: number;
  path: {at: number; equity: number}[];
};
export type RxReport = {
  status: string; running: boolean; startedAt: number; stoppedAt: number | null;
  decisions: number; opened: number; cancelled: number; openRate: number; stillOpen: number;
  byConfidence: {bucket: string; n: number; wins: number; rate: number | null}[];
  bySide: {side: string; n: number; wins: number; rate: number | null}[];
  exits: {reason: string; n: number}[];
  fees: {openFee: number; closeFee: number; slippage: number; funding: number; total: number; traded: number; share: number | null};
  path: {at: number; equity: number}[];
  recent: {at: number; symbol: string; side: string; status: string; reason: string; net: number | null}[];
  rows: {id: string; at: number; symbol: string; side: string; status: string; confidence: number; limit: number; entry: number | null; exit: number | null; qty: number; notional: number; stop: number; tp1: number; tp2: number; reason: string; gross: number | null; net: number | null; holdSec: number | null; openFee: number | null; closeFee: number | null; openSlippage: number | null; closeSlippage: number | null; fundingFee: number | null; totalCost: number | null}[];
};

export function holdMsOf(text: string) {
  const hour = text.match(/(\d+(?:\.\d+)?)\s*小时/);
  if (hour) return Number(hour[1]) * 3_600_000;
  const minute = text.match(/(\d+(?:\.\d+)?)\s*分钟/);
  if (minute) return Number(minute[1]) * 60_000;
  return 2 * 3_600_000;
}
const dir = (side: RxSide) => side === 'LONG' ? 1 : -1;
const fresh = (q: Quote | undefined, now: number) => !!q && q.fresh && q.bestBid > 0 && q.bestAsk > q.bestBid && q.observedAt <= now && now - q.observedAt <= STALE_MS;
const round = (n: number, d = 4) => Number(n.toFixed(d));
const buckets = ['40% 以下', '40% 到 50%', '50% 到 55%', '55% 到 65%', '65% 到 75%', '75% 以上'];
const bucketOf = (c: number) => c < 0.4 ? buckets[0]! : c < 0.5 ? buckets[1]! : c < 0.55 ? buckets[2]! : c < 0.65 ? buckets[3]! : c < 0.75 ? buckets[4]! : buckets[5]!;

export function emptyRx(now: number): RxBook {
  return {on: true, startedAt: now, stoppedAt: null, stopReason: null, decisions: [], orders: [], fees: [], seenAt: 0,
    decisionsN: 0, openedN: 0, cancelledN: 0, openFee: 0, closeFee: 0, openSlippage: 0, closeSlippage: 0, fundingFee: 0, traded: 0, path: []};
}

export function armResearchExperiment(state: ForwardState, now: number) {
  const trial = state.inverseTrial;
  if (!trial || trial.rx?.on) return false;
  trial.rx = emptyRx(now);
  trial.lsrWork = [];
  trial.lsrNote = '老策略不再开新单。研究实验在记账。';
  return true;
}

function rule(side: RxSide, now: number, holdMs: number, reason: string): Rule {
  return {id: `rx-${side}`, signature: RX_POLICY, parentId: null, version: 1, createdAt: now, expiresAt: now + holdMs,
    status: 'EXPERIMENTAL', conditions: [], side, horizon: Math.max(1, Math.round(holdMs / 60_000)), stopRate: 0, armRate: 0, givebackRate: 0,
    exitMode: 'HORIZON', samples: 0, trainGroups: 0, checkGroups: 0, estimatedNetRate: 0, priorResponse: null, recentResponse: 0,
    standardError: 0, reason, mutation: 'CREATE', grammar: RX_POLICY, liveEligible: false};
}

function remember<T>(rows: T[] | undefined, row: T, cap: number) {
  return [...(rows ?? []), row].slice(-cap);
}

function markPath(book: RxBook, equity: number, now: number) {
  const last = book.path.at(-1);
  if (last && now - last.at < 60_000 && Math.abs(last.equity - equity) < 0.5) return;
  book.path = [...book.path, {at: now, equity: round(equity, 2)}].slice(-180);
}

function costOf(order: RxOrder, reason: RxExit, exit: number, now: number) {
  const closeNotional = order.qty * exit;
  const market = reason === 'sl' || reason === 'invalidate' || reason === 'time';
  const closeFee = closeNotional * (market ? TAKER : MAKER);
  const closeSlippage = closeNotional * (reason === 'tp1' || reason === 'tp2' ? TP_SLIP : STOP_SLIP);
  const held = Math.max(0, now - (order.openedAt ?? now)) / 1000;
  const fundingFee = order.notional * order.fundingRate * held / (8 * 3600) * (order.direction === 'LONG' ? 1 : -1);
  const openFee = order.notional * MAKER;
  const openSlippage = order.notional * OPEN_SLIP;
  const note = market
    ? '开仓按挂单 0.02% 和 1bp。平仓按吃单 0.05% 和 10bp。'
    : '开仓按挂单 0.02% 和 1bp。止盈按挂单 0.02% 和 1bp。';
  return {openFee, closeFee, openSlippage, closeSlippage, fundingFee, totalCost: openFee + closeFee + openSlippage + closeSlippage + fundingFee, note};
}

function closeOrder(state: ForwardState, book: RxBook, order: RxOrder, trade: Trade, exit: number, reason: RxExit, now: number) {
  const gross = dir(order.direction) * order.qty * (exit - order.entry);
  const cost = costOf(order, reason, exit, now);
  const net = gross - cost.totalCost;
  order.status = 'closed'; order.closedAt = now; order.exit = exit; order.exitReason = reason;
  order.gross = round(gross, 6); order.net = round(net, 6); order.holdSec = Math.round((now - (order.openedAt ?? now)) / 1000);
  trade.status = 'CLOSED'; trade.closedAt = now; trade.exitPrice = exit; trade.lastPrice = exit; trade.lastQuoteAt = now;
  trade.exitFee = cost.closeFee; trade.grossPnl = gross; trade.netPnl = net; trade.exitReason = reason; trade.fundingAllowance = cost.fundingFee;
  state.balance += gross - cost.closeFee - cost.closeSlippage - cost.fundingFee;
  state.grossPnl += gross; state.fees += cost.closeFee; state.turnover += order.qty * exit;
  state.resolved++; if (net > 0) state.wins++;
  book.closeFee += cost.closeFee; book.closeSlippage += cost.closeSlippage; book.fundingFee += cost.fundingFee; book.traded += order.qty * exit;
  book.fees = remember(book.fees, {orderId: order.id, ...cost, openFee: round(cost.openFee, 6), closeFee: round(cost.closeFee, 6), openSlippage: round(cost.openSlippage, 6), closeSlippage: round(cost.closeSlippage, 6), fundingFee: round(cost.fundingFee, 6), totalCost: round(cost.totalCost, 6)}, 400);
  state.positions = state.positions.filter(row => row.id !== trade.id);
  state.history = [trade, ...state.history.filter(row => row.id !== trade.id)].slice(0, 240);
  state.revision++;
  state.events = [{id: `rx${state.startedAt}-${state.revision}`, at: now, kind: 'EXIT' as const, subject: trade.id, reason}, ...state.events].slice(0, 160);
}

function fill(state: ForwardState, book: RxBook, order: RxOrder, now: number, quoteAt: number) {
  const openFee = order.notional * MAKER, openSlippage = order.notional * OPEN_SLIP;
  order.status = 'open'; order.openedAt = now; order.entry = order.limit; order.checkedAt = now;
  state.balance -= openFee + openSlippage; state.fees += openFee; state.turnover += order.notional;
  book.openFee += openFee; book.openSlippage += openSlippage; book.traded += order.notional; book.openedN++;
  const leverage = 5;
  const trade: Trade = {
    id: order.id, symbol: order.symbol, side: order.direction, rule: rule(order.direction, now, Math.max(60_000, order.timeStopAt - now), '研究实验'),
    openedAt: now, closedAt: null, status: 'OPEN', entryPrice: order.entry, exitPrice: null, quantity: order.qty, contracts: order.contracts, quantoMultiplier: order.mult,
    notional: order.notional, leverage, margin: order.notional / leverage, plannedRisk: Math.abs(order.entry - order.stop) / order.entry * order.notional,
    stopPrice: order.stop, armPrice: order.tp1, favorable: 0, adverse: 0, lastPrice: order.entry, lastQuoteAt: quoteAt,
    entryFee: openFee, exitFee: 0, fundingAllowance: 0, grossPnl: null, netPnl: null, exitReason: null, relationFailureBars: 0, lastRelationBar: now,
    execution: 'REAL_QUOTE_PAPER_MODEL', liveEligible: false, firstProfitAt: null, holdScore: 0, profitFloorRate: 0, expectedHoldMinutes: Math.round((order.timeStopAt - now) / 60_000), peakPnlRate: 0,
    exitControl: {policy: RX_POLICY, armedAt: null, armedQuoteAt: null, maxObservationGapMs: 30_000, maxQuoteAgeMs: STALE_MS},
    entryContext: {version: 'adaptive-ten-entry-v1', capturedAt: now, timeframe: '5m', side: order.direction, mode: 'REVERSAL', reserve: false,
      reason: '研究实验，不下实盘。', entryScore: 0, directionStrength: 0, spaceScore: 0, positionScore: 0, executionScore: 0, remainingSpaceRate: 0,
      pullbackRiskRate: 0, edgeRatio: 0, expectedHoldMinutes: Math.round((order.timeStopAt - now) / 60_000), marketFit: 0, regionId: null, portfolioRiskCharge: 0,
      strategyVersion: RX_POLICY, thesisId: order.id, thesisSince: now, thesisSummary: '研究层方向，正向做。',
      invalidationSummary: `止损 ${order.stop}。目标 ${order.tp1} / ${order.tp2}。`},
  };
  state.positions.push(trade);
  state.revision++;
  state.events = [{id: `rx${state.startedAt}-${state.revision}`, at: now, kind: 'ENTRY' as const, subject: trade.id, reason: `${order.symbol} ${order.direction} ${order.notional.toFixed(0)}U`}, ...state.events].slice(0, 160);
}

export function applyResearchExperiment(state: ForwardState, signal: RxSignal | null, quotes: Record<string, Quote>, contracts: Record<string, Contract> | undefined, now: number) {
  const trial = state.inverseTrial;
  if (!trial?.rx?.on) return false;
  const book = trial.rx;
  let changed = false;
  const equity = forwardEquity(state, quotes, now).equity;
  const beforePath = book.path.length;
  markPath(book, equity, now);
  if (book.path.length !== beforePath) changed = true;
  if (!book.stoppedAt && equity <= 0) {
    book.stoppedAt = now; book.stopReason = '权益到 0，不再开新单。剩下的单走完。'; changed = true;
  }
  for (const order of book.orders) {
    if (order.status === 'pending') {
      if (now - order.placedAt < WAIT_MS) continue;
      const q = quotes[order.symbol];
      const through = fresh(q, now) && (order.direction === 'LONG' ? q!.bestAsk <= order.limit : q!.bestBid >= order.limit);
      if (!through || book.stoppedAt) {order.status = 'cancelled'; book.cancelledN++; changed = true; continue;}
      fill(state, book, order, now, q!.observedAt); changed = true; continue;
    }
    if (order.status !== 'open') continue;
    const trade = state.positions.find(row => row.id === order.id);
    const q = quotes[order.symbol];
    if (!trade || !fresh(q, now)) continue;
    const bid = q!.bestBid, ask = q!.bestAsk;
    const px = order.direction === 'LONG' ? bid : ask;
    trade.lastPrice = px; trade.lastQuoteAt = q!.observedAt;
    trade.favorable = Math.max(trade.favorable, dir(order.direction) * (px - order.entry) / order.entry);
    const stop = order.direction === 'LONG' ? bid <= order.stop : ask >= order.stop;
    const tp2 = order.direction === 'LONG' ? bid >= order.tp2 : ask <= order.tp2;
    const tp1 = order.direction === 'LONG' ? bid >= order.tp1 : ask <= order.tp1;
    const timed = now >= order.timeStopAt;
    let reason: RxExit | null = stop ? 'sl' : tp2 ? 'tp2' : tp1 ? 'tp1' : timed ? 'time' : null;
    let exit = reason === 'sl' ? order.stop : reason === 'tp2' ? order.tp2 : reason === 'tp1' ? order.tp1 : reason === 'time' ? px : 0;
    if (!reason && now - order.checkedAt >= CHECK_MS) {
      order.checkedAt = now; changed = true;
      const corrHit = signal && signal.symbol === order.symbol && signal.corr1h != null && signal.corr1h >= 0.6;
      const priceHit = order.direction === 'LONG' ? px <= order.invalidatePx : px >= order.invalidatePx;
      if (corrHit || priceHit) {reason = 'invalidate'; exit = px;}
    }
    if (!reason) continue;
    closeOrder(state, book, order, trade, exit, reason, now); changed = true;
  }
  if (signal && signal.at !== book.seenAt) {
    book.seenAt = signal.at; book.decisionsN++;
    const stopped = !!book.stoppedAt;
    const decision: RxDecision = {at: signal.at, symbol: signal.symbol, direction: signal.side, confidence: signal.confidence, reasoning: signal.reasoning,
      action: stopped ? 'stopped' : 'opened', orderId: null, context: signal.context, analogy: signal.analogy};
    if (!stopped) {
      const q = quotes[signal.symbol];
      const contract = contracts?.[signal.symbol];
      if (fresh(q, now) && contract && contract.quantoMultiplier > 0) {
        const bid = q!.bestBid, ask = q!.bestAsk, mid = (bid + ask) / 2;
        const mult = contract.quantoMultiplier;
        const min = Math.max(1, Math.ceil(contract.minContracts ?? 1));
        const contractsN = Math.max(min, Math.floor(NOTIONAL / (mid * mult)));
        const qty = contractsN * mult, notional = qty * mid;
        const id = `rx-${now.toString(36)}-${signal.symbol.replace(/[^A-Z0-9]/g, '').slice(0, 18)}-${book.openedN}`;
        const order: RxOrder = {id, decisionAt: signal.at, symbol: signal.symbol, direction: signal.side, confidence: signal.confidence,
          entry: mid, limit: mid, qty, notional, placedAt: now, openedAt: null, closedAt: null, exit: null, exitReason: null, gross: null, net: null, holdSec: null,
          stop: signal.stop, tp1: signal.tp1, tp2: signal.tp2, timeStopAt: now + signal.holdMs, invalidatePx: signal.side === 'LONG' ? mid * 0.995 : mid * 1.005,
          fundingRate: signal.funding, status: 'pending', checkedAt: now, mult, contracts: contractsN};
        decision.orderId = id; book.orders.push(order);
      } else decision.action = 'observe';
    }
    book.decisions = remember(book.decisions, decision, 400);
    const live = book.orders.filter(row => row.status === 'open' || row.status === 'pending');
    const done = book.orders.filter(row => row.status !== 'open' && row.status !== 'pending');
    book.orders = [...done.slice(-Math.max(0, 400 - live.length)), ...live];
    changed = true;
  } else if (!signal && book.seenAt !== now && !book.orders.some(row => row.status === 'open' || row.status === 'pending')) {
    /* no decision this pass */
  }
  return changed;
}

function rate(wins: number, n: number) {return n ? round(wins / n, 3) : null;}

export function experimentReport(book: RxBook | undefined): RxReport | null {
  if (!book) return null;
  const closed = book.orders.filter(row => row.status === 'closed');
  const tally = (group: (row: RxOrder) => string) => {
    const map = new Map<string, {n: number; wins: number}>();
    for (const row of closed) {
      const key = group(row);
      const hit = map.get(key) ?? {n: 0, wins: 0};
      hit.n++; if ((row.net ?? 0) > 0) hit.wins++;
      map.set(key, hit);
    }
    return [...map.entries()].map(([side, hit]) => ({side, n: hit.n, wins: hit.wins, rate: rate(hit.wins, hit.n)}));
  };
  const byConfidence = buckets.map(name => {
    const rows = closed.filter(row => bucketOf(row.confidence) === name);
    const wins = rows.filter(row => (row.net ?? 0) > 0).length;
    return {bucket: name, n: rows.length, wins, rate: rate(wins, rows.length)};
  });
  const exits = ['tp1', 'tp2', 'sl', 'invalidate', 'time'].map(reason => ({reason, n: closed.filter(row => row.exitReason === reason).length}));
  const total = book.openFee + book.closeFee + book.openSlippage + book.closeSlippage + book.fundingFee;
  const status = book.stoppedAt
    ? `${book.stopReason ?? '已停止'} ${book.orders.some(row => row.status === 'open' || row.status === 'pending') ? '还有单没走完。' : '单已经走完。'}`
    : '正向实验在跑。没有 2 小时截止。权益到 0 才停开新单。';
  const reasonName = (reason: RxExit | null) => reason === 'tp1' ? '第一目标' : reason === 'tp2' ? '第二目标' : reason === 'sl' ? '止损' : reason === 'invalidate' ? '看错了' : reason === 'time' ? '到时间' : '';
  const fees = new Map(book.fees.map(row => [row.orderId, row]));
  const rows = [...book.orders].reverse().slice(0, 80).map(row => {
    const fee = fees.get(row.id);
    return {id: row.id, at: row.openedAt ?? row.placedAt, symbol: row.symbol, side: row.direction === 'LONG' ? '做多' : '做空',
      status: row.status === 'pending' ? '挂着' : row.status === 'open' ? '持仓' : row.status === 'cancelled' ? '6 秒没成交' : '已平',
      confidence: round(row.confidence, 3), limit: row.limit, entry: row.openedAt ? row.entry : null, exit: row.exit, qty: row.qty, notional: round(row.notional, 2),
      stop: row.stop, tp1: row.tp1, tp2: row.tp2, reason: reasonName(row.exitReason), gross: row.gross, net: row.net, holdSec: row.holdSec,
      openFee: fee ? fee.openFee : row.status === 'open' ? round(row.notional * MAKER, 6) : null,
      closeFee: fee?.closeFee ?? null, openSlippage: fee ? fee.openSlippage : row.status === 'open' ? round(row.notional * OPEN_SLIP, 6) : null,
      closeSlippage: fee?.closeSlippage ?? null, fundingFee: fee?.fundingFee ?? null, totalCost: fee?.totalCost ?? null};
  });
  return {status, running: !book.stoppedAt, startedAt: book.startedAt, stoppedAt: book.stoppedAt,
    decisions: book.decisionsN, opened: book.openedN, cancelled: book.cancelledN, openRate: book.decisionsN ? round(book.openedN / book.decisionsN, 3) : 0,
    stillOpen: book.orders.filter(row => row.status === 'open' || row.status === 'pending').length,
    byConfidence, bySide: tally(row => row.direction === 'LONG' ? '做多' : '做空'), exits,
    fees: {openFee: round(book.openFee, 4), closeFee: round(book.closeFee, 4), slippage: round(book.openSlippage + book.closeSlippage, 4), funding: round(book.fundingFee, 4), total: round(total, 4), traded: round(book.traded, 2), share: book.traded > 0 ? round(total / book.traded, 5) : null},
    path: book.stoppedAt ? book.path : book.path.slice(-8),
    recent: rows.slice(0, 8).map(row => ({at: row.at, symbol: row.symbol, side: row.side, status: row.status, reason: row.reason, net: row.net})),
    rows,
  };
}
