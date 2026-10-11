import assert from 'node:assert/strict';
import test from 'node:test';
import {initialForward, type Quote} from '../lib/forward-relations.ts';
import {applyLsrBook} from '../lib/lsr-book.ts';
import {applyNewDesk, deskIdentity, freshNewDesk, type DeskSignal} from '../lib/new-desk.ts';
import {buildRunLogExport} from '../lib/run-log.ts';
import {deskLogPositions} from '../lib/new-desk.ts';

const T = Date.parse('2026-10-11T00:00:00Z');
const contract = {quantoMultiplier: 1, minContracts: 1, orderSizeMin: 1, orderPriceRound: 0.01, markPriceRound: 0.01};
const quote = (bid: number, ask: number, at: number): Quote => ({symbol: 'SOL_USDT', source: 'gate', bid, ask, bestBid: bid, bestAsk: ask, bidSize: 10, askSize: 10, last: (bid + ask) / 2, mark: (bid + ask) / 2, index: (bid + ask) / 2, fundingRate: 0, observedAt: at, fresh: true, ageMs: 0});
const signal = (at: number): DeskSignal => ({at, symbol: 'SOL_USDT', side: 'LONG', confidence: 0.42, reasoning: '做多', stop: 90, tp1: 110, tp2: 120, holdMs: 7_200_000, funding: 0, corr1h: 0.2, context: '', analogy: ''});

test('a reset book starts at 1000 and the old strategy cannot open', () => {
  const state = freshNewDesk(initialForward(T), T);
  assert.equal(state.balance, 1000);
  assert.equal(state.inverseTrial?.paperPolicy, 'desk-v1');
  assert.equal(applyLsrBook(state, {}, {SOL_USDT: quote(100, 100.02, T)}, {SOL_USDT: contract}, T), false);
  assert.equal(state.positions.length, 0);
});

test('one fill and one stop keep the identity inside half a unit', () => {
  const state = freshNewDesk(initialForward(T), T);
  applyNewDesk(state, signal(T), {SOL_USDT: quote(100, 100.02, T)}, {SOL_USDT: contract}, T);
  applyNewDesk(state, null, {SOL_USDT: quote(99.99, 100, T + 6_000)}, {SOL_USDT: contract}, T + 6_000);
  assert.equal(state.positions.length, 1);
  applyNewDesk(state, null, {SOL_USDT: quote(89, 89.02, T + 10_000)}, {SOL_USDT: contract}, T + 10_000);
  assert.equal(state.positions.length, 0);
  const id = deskIdentity(state, {SOL_USDT: quote(89, 89.02, T + 10_000)}, T + 10_000);
  assert.ok(Math.abs(id.identityError) < 0.5, `identity ${id.identityError}`);
  const packed = deskLogPositions(state, {SOL_USDT: quote(89, 89.02, T + 10_000)}, T + 10_000);
  const file = buildRunLogExport({events: [], funnel: packed.funnel, health: {}, gate: {}, exportedAt: T + 10_000, liveEnabled: false,
    positions: packed.positions, fills: packed.fills, curve: [{ts: T + 10_000, equity: id.equity, closed_pnl: id.closedPnl, unrealized_pnl: id.unrealized, positions: 0}],
    equity: id.equity, initial: id.initial, closedNet: id.closedPnl, priorAdjustment: 0, places: []});
  assert.ok(Math.abs(file.invariants.identity_error ?? 99) < 0.5, `log ${file.invariants.identity_error}`);
  assert.equal(file.invariants.checks.fees_match, true);
  assert.equal(file.invariants.checks.positions_sum_match, true);
});
