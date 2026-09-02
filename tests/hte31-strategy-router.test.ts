import test from "node:test";
import assert from "node:assert/strict";
import { buildHte31ResearchRouter } from "../lib/hte31-strategy-router.ts";

test("router never promotes a strategy from a few lucky samples", () => {
  const router = buildHte31ResearchRouter({
    shallow_pullback: {
      traderId: "shallow_pullback",
      completed: 7,
      pending: 2,
      wins: 7,
      losses: 0,
      expectancyR: 0.8,
      profitFactor: 99,
    },
  });
  const ht9 = router.candidates.find((row) => row.traderId === "shallow_pullback");
  assert.ok(ht9);
  assert.equal(ht9.qualified, false);
  assert.equal(router.automaticExecutionChanges, false);
  assert.equal(router.automaticStrategySwitching, false);
  assert.equal(router.mode, "observe_only");
});

test("router can mark a strategy evidence-qualified without granting execution authority", () => {
  const router = buildHte31ResearchRouter({
    shallow_pullback: {
      traderId: "shallow_pullback",
      completed: 36,
      pending: 0,
      wins: 22,
      losses: 14,
      expectancyR: 0.24,
      profitFactor: 1.58,
    },
    turtle_soup_r: {
      traderId: "turtle_soup_r",
      completed: 34,
      pending: 0,
      wins: 15,
      losses: 19,
      expectancyR: -0.08,
      profitFactor: 0.82,
    },
  });
  assert.equal(router.qualified.length, 1);
  assert.equal(router.qualified[0].traderId, "shallow_pullback");
  assert.equal(router.automaticExecutionChanges, false);
  assert.match(router.summary, /不抢占 HT4/);
});
