import test from 'node:test';
import assert from 'node:assert/strict';
import { exportAttachedLog, runThesisCycle, type ThesisMarket } from '../lib/thesis-attach.ts';

const T0 = 1_700_000_000_000;

function flat(n: number): ThesisMarket['candles'] {
  return Array.from({ length: n }, (_, i) => ({
    ts: T0 + i * 3_600_000,
    open: 100, high: 101, low: 99, close: 100, volume: 10,
  }));
}

function market(candles: ThesisMarket['candles']): ThesisMarket {
  return {
    symbol: 'BTC_USDT', candles, price: 100, bid: 99.995, ask: 100.005,
    fundingRate: 0, volume24h: 1e9, btcPrice: 100, btcChange24h: 0,
  };
}

function spike(): ThesisMarket {
  const candles = flat(58);
  const ts = candles.at(-1)!.ts;
  candles.push({ ts: ts + 3_600_000, open: 100, high: 110, low: 99, close: 105, volume: 10 });
  candles.push({ ts: ts + 7_200_000, open: 105, high: 106, low: 99, close: 100, volume: 10 });
  return market(candles);
}

test('flat hourly book does not trade and identity holds', async () => {
  const book = market(flat(60));
  const now = book.candles.at(-1)!.ts;
  const first = await runThesisCycle(null, [book], now, 1000);
  assert.equal(first.view.open.length, 0);
  assert.ok(Math.abs(first.view.identityError) < 0.5);
  assert.match(first.view.note, /看了 1 个合约/);
  assert.equal(first.view.equity, 1000);
});

test('fake-breakout fade opens once and the log is v3', async () => {
  const book = spike();
  const now = book.candles.at(-1)!.ts;
  const first = await runThesisCycle(null, [book], now, 1000);
  assert.equal(first.view.open.length, 1);
  assert.equal(first.view.open[0]?.side, 'SHORT');
  assert.match(first.view.open[0]?.reason ?? '', /收回/);
  assert.ok(Math.abs(first.view.identityError) < 1e-6);
  const second = await runThesisCycle(first.state, [book], now + 60_000, 1000);
  assert.equal(second.view.open.length, 1);
  assert.equal(second.view.filled, 1);
  assert.equal(second.view.initialEquity, 1000);
  const log = await exportAttachedLog(second.state, [book], now + 60_000);
  assert.equal(log.version, 'lsr-run-log-v3');
  assert.equal(log.invariants.checks.fees_match, true);
  assert.equal(log.invariants.checks.positions_sum_match, true);
  assert.ok(Math.abs(log.invariants.identity_error) < 0.5);
});

test('no fresh market still says the strategy is attached', async () => {
  const view = (await runThesisCycle(null, [], T0, 1000)).view;
  assert.match(view.note, /策略已接上/);
  assert.equal(view.open.length, 0);
  assert.equal(view.equity, 1000);
});
