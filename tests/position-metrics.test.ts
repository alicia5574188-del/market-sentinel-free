import assert from "node:assert/strict";
import test from "node:test";
import { directionalReturnRate, marginReturnRate, unrealizedPnl } from "../lib/position-metrics.ts";

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
