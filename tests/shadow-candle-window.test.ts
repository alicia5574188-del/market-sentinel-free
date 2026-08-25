import assert from "node:assert/strict";
import test from "node:test";
import { shadowCompletedWindow } from "../lib/shadow-candle-window.ts";
import type { Candle } from "../lib/signal-engine.ts";

const minute = 60_000;
const start = Date.UTC(2026, 7, 25, 10, 0, 0);

function candle(offsetMinutes: number, high: number, low: number): Candle {
  return {
    time: Math.floor((start + offsetMinutes * minute) / 1000),
    open: 100,
    high,
    low,
    close: 100,
    volume: 1000,
  };
}

test("shadow window excludes candles that started before a mid-candle entry", () => {
  const rows = [candle(0, 150, 50), candle(5, 103, 97), candle(10, 104, 96)];
  const result = shadowCompletedWindow(rows, start + 2 * minute, start + 16 * minute);
  assert.equal(result.count, 2);
  assert.equal(result.highPrice, 104);
  assert.equal(result.lowPrice, 96);
  assert.equal(result.coveredThroughAt, start + 15 * minute);
});

test("shadow window aggregates every whole candle skipped by rotating background scans", () => {
  const rows = [
    candle(0, 101, 99),
    candle(5, 103, 98),
    candle(10, 102, 95),
    candle(15, 105, 97),
  ];
  const result = shadowCompletedWindow(rows, start + 5 * minute, start + 21 * minute);
  assert.equal(result.count, 3);
  assert.equal(result.highPrice, 105);
  assert.equal(result.lowPrice, 95);
  assert.equal(result.coveredThroughAt, start + 20 * minute);
});

test("shadow window never uses an incomplete candle", () => {
  const rows = [
    candle(0, 101, 99),
    candle(5, 102, 98),
    candle(10, 150, 50),
  ];
  const result = shadowCompletedWindow(rows, start, start + 14 * minute);
  assert.equal(result.count, 2);
  assert.equal(result.highPrice, 102);
  assert.equal(result.lowPrice, 98);
  assert.equal(result.coveredThroughAt, start + 10 * minute);
});
