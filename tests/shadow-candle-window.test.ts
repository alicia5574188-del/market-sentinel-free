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

test("shadow window excludes candles completed before the last evaluation boundary", () => {
  const rows = [candle(0, 102, 98), candle(5, 103, 97), candle(10, 104, 96)];
  const result = shadowCompletedWindow(rows, start + 10 * minute, start + 16 * minute);
  assert.equal(result.count, 1);
  assert.equal(result.highPrice, 104);
  assert.equal(result.lowPrice, 96);
});

test("shadow window aggregates every completed candle skipped by rotating background scans", () => {
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
});

test("shadow window never uses an incomplete candle", () => {
  const rows = [
    candle(0, 101, 99),
    candle(5, 102, 98),
    candle(10, 150, 50),
  ];
  const result = shadowCompletedWindow(rows, start, start + 14 * minute);
  assert.equal(result.count, 1);
  assert.equal(result.highPrice, 102);
  assert.equal(result.lowPrice, 98);
});
