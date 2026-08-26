import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function applyMigration(db, filename) {
  const sql = readFileSync(new URL(`../drizzle/${filename}`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) db.exec(statement);
}

const migrations = [
  "0000_messy_oracle.sql",
  "0001_perfect_pandemic.sql",
  "0002_violet_vargas.sql",
  "0003_fast_golden_guardian.sql",
  "0004_lowly_mongoose.sql",
  "0005_many_tenebrous.sql",
  "0006_aberrant_harry_osborn.sql",
  "0007_dapper_meggan.sql",
  "0008_easy_ezekiel.sql",
  "0009_sentinel_v2_core.sql",
];

test("Sentinel V2 migration creates clean learning tables without deleting live configuration", () => {
  const db = new DatabaseSync(":memory:");
  for (const migration of migrations.slice(0, -1)) applyMigration(db, migration);
  db.prepare("INSERT INTO app_settings (id, updated_at) VALUES (1, 1)").run();
  db.prepare("INSERT INTO live_exchange_credentials (id, ciphertext, iv, key_hint, created_at, updated_at) VALUES (1, 'cipher', 'iv', 'hint', 1, 1)").run();
  db.prepare("INSERT INTO live_trading_control (id, updated_at) VALUES (1, 1)").run();
  db.prepare("INSERT INTO strategy_memory (id, symbol, side, updated_at) VALUES ('memory-v1', 'BTC_USDT', 'LONG', 1)").run();

  applyMigration(db, migrations.at(-1));

  assert.equal(db.prepare("SELECT count(*) AS count FROM strategy_memory").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM live_exchange_credentials").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM live_trading_control").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM app_settings").get().count, 1);
  assert.equal(db.prepare("SELECT value FROM v2_system_meta WHERE key = 'strategy_generation'").get().value, "sentinel-growth-v2");
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='v2_market_snapshots'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='v2_warning_events'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='v2_opportunity_decisions'").get());
  db.close();
});
