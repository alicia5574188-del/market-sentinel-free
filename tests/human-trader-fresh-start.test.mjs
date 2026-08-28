import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../drizzle/0010_human_trader_fresh_start.sql", import.meta.url), "utf8");

test("fresh start removes old strategy simulation, memory and observability data", () => {
  for (const table of [
    "alert_events",
    "strategy_memory",
    "regime_state",
    "scan_runs",
    "v2_warning_events",
    "v2_opportunities",
    "v2_market_snapshots",
  ]) {
    assert.match(migration, new RegExp(`DELETE FROM ${table};`));
  }
});

test("active real Gate order lineage survives the reset until lifecycle completion", () => {
  assert.match(migration, /DELETE FROM v2_trade_thesis[\s\S]*SELECT trade_case_id FROM live_orders[\s\S]*'submitting','open','protected','closing'/);
  assert.match(migration, /DELETE FROM symbol_lifecycle[\s\S]*SELECT trade_case_id FROM live_orders[\s\S]*'submitting','open','protected','closing'/);
  assert.match(migration, /DELETE FROM trade_cases[\s\S]*SELECT trade_case_id FROM live_orders[\s\S]*'submitting','open','protected','closing'/);
});

test("fresh start never deletes real execution credentials, orders, controls or audit", () => {
  assert.doesNotMatch(migration, /DELETE FROM live_orders/);
  assert.doesNotMatch(migration, /DELETE FROM live_audit_events/);
  assert.doesNotMatch(migration, /DELETE FROM live_exchange_credentials/);
  assert.doesNotMatch(migration, /DELETE FROM live_trading_control/);
});
