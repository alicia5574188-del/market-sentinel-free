import assert from 'node:assert/strict';
import test from 'node:test';
import {initialForward, type Quote} from '../lib/forward-relations.ts';
import {applyLsrBook,lsrLogBook} from '../lib/lsr-book.ts';
import {buildRunLogExport} from '../lib/run-log.ts';
import {applyResearchExperiment, armResearchExperiment, experimentReport, type RxSignal} from '../lib/research-experiment.ts';
import {newInverseTrial} from '../lib/shadow-inverse-ledger.ts';

const T = 1_791_600_000_000;
const contract = {quantoMultiplier: 1, leverageMax: 20, maintenanceRate: .005, minContracts: 1, volume24hUsd: 5_000_000};
const quote = (bid: number, ask: number, at: number): Quote => ({bestBid: bid, bestAsk: ask, observedAt: at, fresh: true, sourceCount: 2, disagreementRate: 0});
function book(balance = 1000) {
  const state = initialForward(T);
  state.inverseTrial = newInverseTrial(state, T, balance);
  state.inverseTrial.paperPolicy = 'lsr-v1';
  state.balance = balance;
  armResearchExperiment(state, T);
  return state;
}
function signal(at: number, over: Partial<RxSignal> = {}): RxSignal {
  return {at, symbol: 'SOL_USDT', side: 'LONG', confidence: 0.42, reasoning: '票数偏向做多', stop: 90, tp1: 110, tp2: 120, holdMs: 7_200_000, funding: 0.0001, corr1h: 0.2, context: '涨了', analogy: '20 个场面', ...over};
}

test('a low-confidence side still gets a 500U order, and the same decision is not repeated', () => {
  const state = book();
  const quotes = {SOL_USDT: quote(100, 100.02, T)};
  applyResearchExperiment(state, signal(T), quotes, {SOL_USDT: contract}, T);
  assert.equal(state.inverseTrial?.rx?.orders.length, 1);
  assert.equal(state.inverseTrial?.rx?.orders[0]?.status, 'pending');
  assert.ok(Math.abs(state.inverseTrial!.rx!.orders[0]!.limit - 100.01) < 1e-9);
  applyResearchExperiment(state, signal(T), quotes, {SOL_USDT: contract}, T + 1000);
  assert.equal(state.inverseTrial?.rx?.orders.length, 1);
});

test('a new decision opens another order on the same coin', () => {
  const state = book();
  const quotes = {SOL_USDT: quote(100, 100.02, T)};
  applyResearchExperiment(state, signal(T), quotes, {SOL_USDT: contract}, T);
  applyResearchExperiment(state, signal(T + 30_000), {SOL_USDT: quote(100, 100.02, T + 30_000)}, {SOL_USDT: contract}, T + 30_000);
  assert.equal(state.inverseTrial?.rx?.orders.length, 2);
  assert.equal(state.inverseTrial?.rx?.orders.filter(row => row.symbol === 'SOL_USDT' && row.status !== 'cancelled').length, 1);
});

test('six seconds without a cross cancels, a cross fills and a stop keeps taker cost apart from the price', () => {
  const state = book();
  applyResearchExperiment(state, signal(T), {SOL_USDT: quote(100, 100.02, T)}, {SOL_USDT: contract}, T);
  applyResearchExperiment(state, null, {SOL_USDT: quote(100, 100.02, T + 6_000)}, {SOL_USDT: contract}, T + 6_000);
  assert.equal(state.inverseTrial?.rx?.orders[0]?.status, 'cancelled');
  applyResearchExperiment(state, signal(T + 30_000), {SOL_USDT: quote(100, 100.02, T + 30_000)}, {SOL_USDT: contract}, T + 30_000);
  applyResearchExperiment(state, null, {SOL_USDT: quote(99.99, 100, T + 36_000)}, {SOL_USDT: contract}, T + 36_000);
  const open = state.inverseTrial?.rx?.orders.find(row => row.status === 'open');
  assert.ok(open);
  assert.ok((state.inverseTrial?.rx?.openFee ?? 0) > 0);
  assert.ok((state.inverseTrial?.rx?.openSlippage ?? 0) > 0);
  applyResearchExperiment(state, null, {SOL_USDT: quote(89, 89.02, T + 40_000)}, {SOL_USDT: contract}, T + 40_000);
  const closed = state.inverseTrial?.rx?.orders.find(row => row.id === open?.id);
  assert.equal(closed?.exitReason, 'sl');
  assert.equal(closed?.exit, 90);
  const fee = state.inverseTrial?.rx?.fees.find(row => row.orderId === open?.id);
  assert.ok(fee && fee.closeFee > fee.openFee * 2);
  assert.match(fee!.note, /吃单/);
  assert.ok(Math.abs((closed?.net ?? 0) - ((closed?.gross ?? 0) - fee!.totalCost)) < 1e-6);
});

test('the run does not stop at two hours, and it does stop when equity is gone', () => {
  const state = book();
  state.inverseTrial!.rx!.startedAt = T - 3 * 3_600_000;
  applyResearchExperiment(state, signal(T), {SOL_USDT: quote(100, 100.02, T)}, {SOL_USDT: contract}, T);
  assert.equal(state.inverseTrial?.rx?.stoppedAt, null);
  assert.equal(state.inverseTrial?.rx?.orders.length, 1);
  const broke = book();
  broke.balance = 0;
  applyResearchExperiment(broke, signal(T), {SOL_USDT: quote(100, 100.02, T)}, {SOL_USDT: contract}, T);
  assert.equal(broke.inverseTrial?.rx?.stoppedAt, T);
  assert.equal(broke.inverseTrial?.rx?.orders.length, 0);
  assert.match(experimentReport(broke.inverseTrial?.rx)?.status ?? '', /权益到 0/);
});

test('a close taken by the old manager is copied onto the experiment book so the cash still adds up', () => {
  const state = book();
  applyResearchExperiment(state, signal(T), {SOL_USDT: quote(100, 100.02, T)}, {SOL_USDT: contract}, T);
  applyResearchExperiment(state, null, {SOL_USDT: quote(99.99, 100, T + 6_000)}, {SOL_USDT: contract}, T + 6_000);
  const trade = state.positions[0];
  assert.ok(trade);
  const exit = 99.5;
  const gross = trade.quantity * (exit - trade.entryPrice);
  const exitFee = trade.quantity * exit * 0.0007;
  state.balance += gross - exitFee;
  trade.status = 'CLOSED'; trade.exitPrice = exit; trade.closedAt = T + 7_000; trade.grossPnl = gross; trade.netPnl = gross - trade.entryFee - exitFee;
  state.history = [trade];
  state.positions = [];
  applyResearchExperiment(state, null, {SOL_USDT: quote(99.4, 99.5, T + 8_000)}, {SOL_USDT: contract}, T + 8_000);
  const order = state.inverseTrial?.rx?.orders[0];
  assert.equal(order?.status, 'closed');
  assert.equal(order?.exitReason, 'external');
  const packed = lsrLogBook(state, {SOL_USDT: quote(99.4, 99.5, T + 8_000)}, T + 8_000);
  const file = buildRunLogExport({events: packed.events, funnel: packed.funnel, health: {}, gate: {}, exportedAt: T + 8_000, liveEnabled: false,
    positions: packed.positions, fills: packed.fills, curve: packed.curve, equity: packed.equity, initial: packed.initial, closedNet: packed.closedNet, priorAdjustment: packed.priorAdjustment, places: packed.places});
  assert.equal(file.positions.filter(row => row.exit == null).length, 0);
  assert.ok(Math.abs(file.invariants.identity_error ?? 99) < 0.05, `identity ${file.invariants.identity_error}`);
});

test('an experiment fill is in the log, so the cash change is not an unexplained gap', () => {
  const state = book();
  applyResearchExperiment(state, signal(T), {SOL_USDT: quote(100, 100.02, T)}, {SOL_USDT: contract}, T);
  applyResearchExperiment(state, null, {SOL_USDT: quote(99.99, 100, T + 6_000)}, {SOL_USDT: contract}, T + 6_000);
  applyResearchExperiment(state, null, {SOL_USDT: quote(89, 89.02, T + 10_000)}, {SOL_USDT: contract}, T + 10_000);
  const packed = lsrLogBook(state, {SOL_USDT: quote(89, 89.02, T + 10_000)}, T + 10_000);
  const file = buildRunLogExport({events: packed.events, funnel: packed.funnel, health: {}, gate: {}, exportedAt: T + 10_000, liveEnabled: false,
    positions: packed.positions, fills: packed.fills, curve: packed.curve, equity: packed.equity, initial: packed.initial, closedNet: packed.closedNet, priorAdjustment: packed.priorAdjustment, places: packed.places});
  assert.equal(file.positions.length, 1);
  assert.equal(file.positions[0]?.exit_reason, 'sl');
  assert.ok((file.funnel.filled ?? 0) >= 1);
  assert.ok(Math.abs(file.invariants.identity_error ?? 99) < 0.05, `identity ${file.invariants.identity_error}`);
  assert.equal(file.invariants.checks.positions_sum_match, true);
});

test('the old book opens nothing once the experiment is on', () => {
  const state = initialForward(T);
  state.inverseTrial = newInverseTrial(state, T, 1000);
  state.inverseTrial.paperPolicy = 'lsr-v1';
  state.balance = 1000;
  const bars = Array.from({length: 40}, (_, i) => ({time: Math.floor(T / 1000) - (40 - i) * 300, open: 100, high: 100, low: 100, close: 100, volume: i === 39 ? 5_000 : 10}));
  const paths = {ETH_USDT: bars};
  for (let i = 0; i < 31; i++) applyLsrBook(state, paths, {ETH_USDT: quote(100, 100.02, T + i * 2_000)}, {ETH_USDT: contract}, T + i * 2_000);
  armResearchExperiment(state, T + 62_000);
  applyLsrBook(state, paths, {ETH_USDT: quote(99, 99.02, T + 64_000)}, {ETH_USDT: contract}, T + 64_000);
  assert.equal(state.positions.length, 0);
  assert.equal(state.inverseTrial?.lsrWork?.length ?? 0, 0);
});
