import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const prepare = (await readFile(new URL("../drizzle/0032_liquidity_core_prepare.sql", import.meta.url), "utf8")).replaceAll("--> statement-breakpoint", "");
const purge = (await readFile(new URL("../drizzle/0033_purge_legacy_system.sql", import.meta.url), "utf8")).replaceAll("--> statement-breakpoint", "");
const chartCache = (await readFile(new URL("../drizzle/0034_chart_cache.sql", import.meta.url), "utf8")).replaceAll("--> statement-breakpoint", "");
const credentialSchema = `CREATE TABLE live_exchange_credentials (
  id integer PRIMARY KEY DEFAULT 1 NOT NULL, exchange text NOT NULL, environment text NOT NULL, ciphertext text NOT NULL,
  iv text NOT NULL, crypto_version integer NOT NULL, key_hint text NOT NULL, gate_user_id text, owner_account_id text,
  permission_summary_json text NOT NULL, status text NOT NULL, last_verified_at integer, last_error text, created_at integer NOT NULL, updated_at integer NOT NULL
)`;

test("fresh prepare and purge produce only the minimal system plus credential table", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(prepare); db.exec(purge); db.exec(chartCache);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, ["live_exchange_credentials", "paper_events", "paper_plans", "paper_positions", "system_settings"]);
  assert.equal(db.prepare("SELECT mode,portfolio_risk_cap FROM system_settings WHERE id=1").get().mode, "PAPER");
  const cache = db.prepare("SELECT chart_cache_json,chart_cache_at FROM system_settings WHERE id=1").get();
  assert.equal(cache.chart_cache_json, null); assert.equal(cache.chart_cache_at, null);
});

test("real legacy credential schema and id=1 row survive prepare and destructive purge byte-for-byte", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(credentialSchema);
  const values = [1,"gate","live","ciphertext-original","iv-original",1,"abcd••••wxyz","123","owner",'{"futures":"read-only"}',"verified",123456,null,111,222];
  db.prepare("INSERT INTO live_exchange_credentials VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...values);
  for (const table of ["user_accounts","trade_cases","hte31_trades","live_orders","v2_opportunities","scalp_risk_days"]) db.exec(`CREATE TABLE ${table} (id TEXT)`);
  db.exec(prepare); db.exec(purge);
  assert.deepEqual(Object.values(db.prepare("SELECT * FROM live_exchange_credentials WHERE id=1").get()), values);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='hte31_trades'").get().count, 0);
});

test("prepare is idempotent and purge never names the credential table", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(prepare); db.exec(prepare); db.exec(purge); db.exec(purge);
  assert.doesNotMatch(purge, /DROP TABLE IF EXISTS `live_exchange_credentials`/);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM live_exchange_credentials").get().count, 0);
});

test("prepare resumes safely after a statement-boundary partial attempt", () => {
  const db = new DatabaseSync(":memory:");
  const statements = prepare.split(";").map((value) => value.trim()).filter(Boolean);
  db.exec(`${statements.slice(0, 2).join("; ")};`);
  db.exec(prepare);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name),
    ["cutover_preflight", "live_exchange_credentials", "paper_events", "paper_plans", "paper_positions", "system_settings"]);
});

test("D1 mirror accepts an absolute equity version exactly once", () => {
  const db = new DatabaseSync(":memory:"); db.exec(prepare);
  const settle = db.prepare("UPDATE system_settings SET paper_equity=?,equity_version=? WHERE id=1 AND equity_version<?");
  settle.run(1025, 2, 2); settle.run(1025, 2, 2);
  assert.equal(db.prepare("SELECT paper_equity FROM system_settings WHERE id=1").get().paper_equity, 1025);
  assert.equal(db.prepare("SELECT equity_version FROM system_settings WHERE id=1").get().equity_version, 2);
});

test("a stale D1 mirror event cannot overwrite a newer closed position", () => {
  const db = new DatabaseSync(":memory:"); db.exec(prepare);
  const upsert = db.prepare(`INSERT INTO paper_positions (id,symbol,market_state,side,status,entry_at,entry_price,initial_stop,current_stop,current_target,target_identity,planned_risk,notional,mirror_version)
    VALUES ('x','BTC_USDT','BREAKOUT','LONG',?,1,100,95,95,110,'BOOK:LONG:5500',10,1000,?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,mirror_version=excluded.mirror_version WHERE excluded.mirror_version > paper_positions.mirror_version`);
  upsert.run("CLOSED", 2); upsert.run("OPEN", 1);
  assert.equal(db.prepare("SELECT status FROM paper_positions WHERE id='x'").get().status, "CLOSED");
});
