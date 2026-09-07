import assert from "node:assert/strict";
import test from "node:test";
import { aggregateClosePoints, directionalReturnRate, marginReturnRate, unrealizedPnl } from "../lib/position-metrics.ts";

test("position metrics calculate long and short unrealized results", () => {
  assert.equal(unrealizedPnl(4_000, "LONG", 100, 101), 40);
  assert.equal(unrealizedPnl(4_000, "SHORT", 100, 99), 40);
  assert.equal(unrealizedPnl(4_000, "SHORT", 100, 101), -40);
  assert.equal(directionalReturnRate("LONG", 100, 101), .01);
  assert.equal(directionalReturnRate("SHORT", 100, 99), .01);
});

test("margin return is explicit and invalid market inputs fail closed", () => {
  assert.equal(marginReturnRate(40, 100), .4);
  assert.equal(marginReturnRate(40, 0), 0);
  assert.equal(unrealizedPnl(4_000, "LONG", 0, 101), 0);
  assert.equal(directionalReturnRate("LONG", 100, Number.NaN), 0);
});

test("one-minute closes aggregate into the latest close of each five-minute bucket", () => {
  assert.deepEqual(aggregateClosePoints([
    { time: 60_000, price: 100 },
    { time: 240_000, price: 101 },
    { time: 300_000, price: 102 },
    { time: 420_000, price: 103 },
    { time: Number.NaN, price: 999 },
  ], 300_000), [
    { time: 240_000, price: 101 },
    { time: 420_000, price: 103 },
  ]);
});
