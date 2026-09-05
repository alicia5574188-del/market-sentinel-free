import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUDFLARE_D1_FREE_DAILY_ROWS_WRITTEN,
  DIRECT_MARKET_ACCOUNT_SAFE_ROWS_WRITTEN,
  DIRECT_MARKET_APP_HARD_ROWS_WRITTEN,
  DIRECT_MARKET_MAX_NEW_ORDERS_PER_UTC_DAY,
  DIRECT_MARKET_NEW_ORDER_ADMISSION_ROWS,
  DIRECT_MARKET_RESERVED_ROWS_PER_NEW_ORDER,
  directMarketD1Admission,
  directMarketPositionCheckpointRows,
  directMarketIndexAdjustedDailyBudget,
  legacyHte31IndexAdjustedDailyUpperBound,
} from "../lib/direct-market-d1-budget.ts";

test("legacy logical-row estimate exposes index-amplified D1 exhaustion risk", () => {
  const legacy = legacyHte31IndexAdjustedDailyUpperBound();
  assert.equal(legacy.evaluationLogicalRows, 18_720);
  assert.equal(legacy.evaluationPhysicalRows, 93_600);
  assert.equal(legacy.diagnosticPhysicalRows, 4_320);
  assert.equal(legacy.physicalRowsUpperBound, 105_120);
  assert.ok(legacy.physicalRowsUpperBound > CLOUDFLARE_D1_FREE_DAILY_ROWS_WRITTEN);
});

test("direct brain keeps scans out of D1 and reserves seventy thousand rows", () => {
  const budget = directMarketIndexAdjustedDailyBudget();
  assert.equal(budget.scannerRows, 0);
  assert.equal(budget.evaluationRows, 0);
  assert.equal(budget.diagnosticRows, 0);
  assert.equal(budget.positionCheckpointLogicalRows, 4_320);
  assert.equal(budget.positionCheckpointPhysicalRows, 8_640);
  assert.equal(budget.admittedTradeLifecycleRows, 6_000);
  assert.equal(budget.mandatoryReserveRows, 15_360);
  assert.equal(budget.plannedPhysicalRows, DIRECT_MARKET_APP_HARD_ROWS_WRITTEN);
  assert.equal(budget.accountSafeLimit, DIRECT_MARKET_ACCOUNT_SAFE_ROWS_WRITTEN);
  assert.equal(budget.freeLimitHeadroom, 70_000);
});

test("position write reserve scales with actual capacity and retains today's peak after closure", () => {
  assert.equal(directMarketPositionCheckpointRows(4), 11_520);
  assert.equal(directMarketPositionCheckpointRows(6), 17_280);
  const snapshots = [JSON.stringify({ portfolioChecks: { openPositionsBefore: 5 } })];
  assert.equal(directMarketPositionCheckpointRows(2, snapshots), 17_280);
  assert.equal(directMarketD1Admission({ estimatedPhysicalRowsToday: directMarketPositionCheckpointRows(8), committedMandatoryRows: 0, newOrdersToday: 0 }).allowed, false);
  assert.equal(directMarketPositionCheckpointRows(2, ["invalid"]), Number.POSITIVE_INFINITY);
});

test("new orders stop before mandatory lifecycle writes lose their reserve", () => {
  assert.deepEqual(directMarketD1Admission({
    estimatedPhysicalRowsToday: DIRECT_MARKET_NEW_ORDER_ADMISSION_ROWS - 200,
    committedMandatoryRows: 50,
    newOrdersToday: 20,
  }), {
    allowed: true,
    projectedRows: DIRECT_MARKET_NEW_ORDER_ADMISSION_ROWS - 50,
    reason: "within_budget",
  });
  assert.equal(directMarketD1Admission({
    estimatedPhysicalRowsToday: DIRECT_MARKET_NEW_ORDER_ADMISSION_ROWS - 100,
    committedMandatoryRows: 1,
    newOrdersToday: 20,
  }).reason, "new_order_reserve");
  assert.equal(directMarketD1Admission({
    estimatedPhysicalRowsToday: 10_000,
    committedMandatoryRows: 0,
    newOrdersToday: DIRECT_MARKET_MAX_NEW_ORDERS_PER_UTC_DAY,
  }).reason, "daily_order_cap");
  assert.equal(directMarketD1Admission({
    estimatedPhysicalRowsToday: DIRECT_MARKET_APP_HARD_ROWS_WRITTEN,
    committedMandatoryRows: 0,
    newOrdersToday: 0,
    nextTradeReserveRows: DIRECT_MARKET_RESERVED_ROWS_PER_NEW_ORDER,
  }).reason, "hard_limit");
});
