import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function applyMigration(db, filename) {
  const sql = readFileSync(new URL(`../drizzle/${filename}`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) db.exec(statement);
}

function insertConfirmed(db, { id, symbol, observedAt, entryPrice, stopPrice }) {
  db.prepare(`INSERT INTO alert_events (
    id, fingerprint, symbol, state, side, confidence, directional_score, posterior_long, data_quality, regime,
    observed_at, expires_at, entry_price, entry_low, entry_high, invalidation_price, trigger, thesis,
    evidence_json, counter_evidence_json, metrics_json, source_snapshot_json, outcome_state, notified
  ) VALUES (?, ?, ?, 'confirmed', 'LONG', 78, 0.51, 0.74, 0.88, '上升趋势 · 常态波动', ?, ?, ?, ?, ?, ?,
    '全部条件满足', '多源证据同向', '[{"title":"价格结构"}]', '[]', '[{"key":"trend"}]', '{}', 'open', 1)`).run(
    id, `fp:${id}`, symbol, observedAt, observedAt + 900_000, entryPrice, entryPrice - 0.1, entryPrice + 0.1, stopPrice,
  );
}

test("纠正迁移隔离旧观察记录且不改写真正的合约持仓", () => {
  const db = new DatabaseSync(":memory:");
  applyMigration(db, "0000_messy_oracle.sql");
  db.prepare("INSERT INTO app_settings (id, updated_at) VALUES (1, 0)").run();
  insertConfirmed(db, { id: "btc-old", symbol: "BTC_USDT", observedAt: 1000, entryPrice: 60_000, stopPrice: 59_000 });
  insertConfirmed(db, { id: "btc-new", symbol: "BTC_USDT", observedAt: 2000, entryPrice: 61_000, stopPrice: 60_000 });
  insertConfirmed(db, { id: "eth-new", symbol: "ETH_USDT", observedAt: 3000, entryPrice: 3_000, stopPrice: 2_940 });
  applyMigration(db, "0001_perfect_pandemic.sql");
  applyMigration(db, "0002_violet_vargas.sql");

  const trades = db.prepare("SELECT id, symbol, active_key, status, entry_price, exit_rules_json, leverage, margin_usdt, contract_notional_usdt, simulation_model FROM trade_cases ORDER BY symbol").all();
  assert.equal(trades.length, 2);
  assert.deepEqual(trades.map((row) => row.id), ["legacy:btc-new", "legacy:eth-new"]);
  assert.ok(trades.every((row) => row.active_key === row.symbol && row.status === "holding"));
  assert.ok(trades.every((row) => JSON.parse(row.exit_rules_json).length === 7));
  assert.ok(trades.every((row) => row.leverage >= 1 && row.margin_usdt > 0 && row.contract_notional_usdt > 0));
  assert.ok(trades.every((row) => row.simulation_model === "contract_v2_recalculated"));
  assert.equal(db.prepare("SELECT trial_capital_usdt FROM app_settings WHERE id = 1").get().trial_capital_usdt, 1000);
  assert.equal(db.prepare("SELECT count(*) AS count FROM symbol_lifecycle WHERE state = 'holding'").get().count, 2);
  assert.equal(db.prepare("SELECT trade_id FROM alert_events WHERE id = 'btc-new'").get().trade_id, "legacy:btc-new");
  assert.equal(db.prepare("SELECT trade_id FROM alert_events WHERE id = 'btc-old'").get().trade_id, null);

  db.prepare(`UPDATE trade_cases SET simulation_model = 'contract_v2', leverage = 4, margin_usdt = 25,
    contract_notional_usdt = 100, quantity = 0.033333, account_balance_before_usdt = 978
    WHERE symbol = 'ETH_USDT'`).run();
  db.prepare("INSERT INTO strategy_memory (id, symbol, side, updated_at) VALUES ('legacy-memory', 'BTC_USDT', 'LONG', 1)").run();
  applyMigration(db, "0003_fast_golden_guardian.sql");

  const archived = db.prepare(`SELECT status, active_key, simulation_model, leverage, margin_usdt,
    contract_notional_usdt, quantity, estimated_liquidation_price, gross_pnl_usdt, net_pnl_usdt, archived_at
    FROM trade_cases WHERE symbol = 'BTC_USDT'`).get();
  assert.equal(archived.status, "archived");
  assert.equal(archived.active_key, null);
  assert.equal(archived.simulation_model, "legacy_signal_v1");
  assert.equal(archived.leverage, 1);
  assert.equal(archived.margin_usdt, 0);
  assert.equal(archived.contract_notional_usdt, 0);
  assert.equal(archived.quantity, 0);
  assert.equal(archived.estimated_liquidation_price, null);
  assert.equal(archived.gross_pnl_usdt, null);
  assert.equal(archived.net_pnl_usdt, null);
  assert.ok(archived.archived_at > 0);

  const genuine = db.prepare(`SELECT status, active_key, simulation_model, leverage, margin_usdt,
    contract_notional_usdt, account_balance_before_usdt FROM trade_cases WHERE symbol = 'ETH_USDT'`).get();
  assert.equal(genuine.status, "holding");
  assert.equal(genuine.active_key, "ETH_USDT");
  assert.equal(genuine.simulation_model, "contract_v2");
  assert.equal(genuine.leverage, 4);
  assert.equal(genuine.margin_usdt, 25);
  assert.equal(genuine.contract_notional_usdt, 100);
  assert.equal(genuine.account_balance_before_usdt, 1000);
  assert.equal(db.prepare("SELECT state FROM symbol_lifecycle WHERE symbol = 'BTC_USDT'").get().state, "observing");
  assert.equal(db.prepare("SELECT state FROM symbol_lifecycle WHERE symbol = 'ETH_USDT'").get().state, "holding");
  assert.equal(db.prepare("SELECT count(*) AS count FROM strategy_memory").get().count, 0);

  applyMigration(db, "0004_lowly_mongoose.sql");
  db.prepare("INSERT INTO user_accounts (id, email, display_name, role, status, created_at, last_seen_at) VALUES ('account-1', 'owner@example.com', 'Owner', 'owner', 'active', 1, 1)").run();
  assert.equal(db.prepare("SELECT role FROM user_accounts WHERE email = 'owner@example.com'").get().role, "owner");
  const pushColumns = db.prepare("PRAGMA table_info(push_subscriptions)").all().map((row) => row.name);
  assert.ok(pushColumns.includes("account_id"));
  db.close();
});
