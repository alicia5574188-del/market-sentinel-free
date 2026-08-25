import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveEntryPlan } from "../lib/live-risk.ts";

test("isolated live entry never expands margin with cross_available", () => {
  const plan = buildLiveEntryPlan({
    trade: {
      id: "isolated-available",
      symbol: "TEST_USDT",
      side: "LONG",
      entryPrice: 100,
      entryLow: 99.9,
      entryHigh: 100.1,
      currentStopPrice: 99,
      takeProfit2Price: 140,
      leverage: 3,
      contractNotionalUsdt: 1000,
    },
    contract: {
      mark_price: "100",
      quanto_multiplier: "0.01",
      leverage_max: "10",
      order_size_min: "1",
      order_size_max: "100000",
      status: "trading",
    },
    account: {
      total: "1000",
      available: "20",
      cross_available: "1000",
      position_mode: "single",
      margin_mode: 0,
    },
    roundTripCostBps: 8,
  });

  assert.equal(plan.passed, true);
  assert.ok(plan.requiredMarginUsdt <= 20 / 1.1 + 1e-9);
  assert.ok(plan.targetNotionalUsdt < 60);
  assert.ok(plan.actualNotionalUsdt < 60);
});
