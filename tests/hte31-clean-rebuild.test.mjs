import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

function applyMigration(db, filename) {
  const sql = readFileSync(new URL(`../drizzle/${filename}`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) db.exec(statement);
}

test("full migration chain creates an empty isolated HTE 3.1 ledger", () => {
  const db = new DatabaseSync(":memory:");
  const migrations = readdirSync(new URL("../drizzle/", import.meta.url)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const migration of migrations) applyMigration(db, migration);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const table of ["hte31_trades","hte31_evaluations","hte31_learning","hte31_trade_charts","hte31_post_exit_observations"]) assert.ok(tables.has(table), `${table} must exist`);
  assert.equal(db.prepare("SELECT count(*) AS n FROM hte31_trades").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM hte31_evaluations").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM hte31_learning").get().n, 0);
  db.close();
});

test("clean migration preserves real Gate data families and disarms only new entry authority", () => {
  const migration = readFileSync(new URL("../drizzle/0011_hte31_clean_rebuild.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /DELETE FROM\s+(?:live_orders|live_audit_events|live_exchange_credentials|trade_cases)/i);
  assert.match(migration, /UPDATE `live_trading_control`/);
  assert.match(migration, /`entry_enabled` = 0/);
  assert.match(migration, /`activation_epoch` = `activation_epoch` \+ 1/);
});

test("clean scanner never re-enters the retired production scan or old simulation repository", () => {
  const scanner = readFileSync(new URL("../lib/hte31-scanner.ts", import.meta.url), "utf8");
  assert.match(scanner, /evaluateHumanTraderPool/);
  assert.match(scanner, /recordHte31Evaluations/);
  assert.match(scanner, /tryOpenHte31Trade/);
  assert.doesNotMatch(scanner, /runMarketScan|getStrategy2ExperienceBook|processShadowStrategies|getStrategyLabDashboard|tradeCases|trade_cases/);
});

test("post-exit observer follows every closed clean trade through twelve hours", () => {
  const repository = readFileSync(new URL("../lib/hte31-repository.ts", import.meta.url), "utf8");
  assert.match(repository, /POST_EXIT_HORIZONS = \[0, 30, 60, 120, 240, 720\]/);
  assert.match(repository, /疑似假止损/);
  assert.match(repository, /退出偏早/);
  assert.match(repository, /退出偏晚/);
  assert.match(repository, /退出优秀/);
  assert.match(repository, /averageExitEfficiency/);
});

test("order chart persists entry holding and post-exit windows independently", () => {
  const [schema, api] = [
    readFileSync(new URL("../db/hte31-schema.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../app/api/hte31/chart/route.ts", import.meta.url), "utf8"),
  ];
  assert.match(schema, /entryCandlesJson/);
  assert.match(schema, /holdingCandlesJson/);
  assert.match(schema, /postExitCandlesJson/);
  assert.match(api, /markers/);
  assert.match(api, /initialStop/);
  assert.match(api, /takeProfit1/);
  assert.match(api, /takeProfit2/);
  assert.match(api, /observations/);
});

test("HTE 3.1 runs independently of the dashboard being open", () => {
  const [route, worker, wrangler] = [
    readFileSync(new URL("../app/api/hte31/route.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ];
  assert.doesNotMatch(route, /scanner\.ensure\s*\(/);
  assert.doesNotMatch(route, /position\.ensure\s*\(/);
  assert.match(route, /scanner\.status\s*\(/);
  assert.match(route, /scanner\.readModel\s*\(/);
  assert.match(worker, /async scheduled\([\s\S]*runScheduledSchedulers\(env\)/);
  assert.match(worker, /MARKET_SCANNER\.getByName\("market-scanner"\)\.runIfDue\(\)/);
  assert.match(wrangler, /"crons"\s*:\s*\["\* \* \* \* \*"\]/);
});

test("clean live page keeps the real Gate account summary visible", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /GATE CONTRACT ACCOUNT/);
  assert.match(page, />合约权益</);
  assert.match(page, /accountEquityLastUsdt/);
  assert.match(page, />当日已实现</);
  assert.match(page, /dailyRealizedPnlUsdt/);
  assert.match(page, />最近成功对账</);
  assert.match(page, /lastSuccessfulReconcileAt/);
});

test("expanded HTE31 trade review cannot widen the mobile viewport", () => {
  const css = readFileSync(new URL("../app/hte31.css", import.meta.url), "utf8");
  assert.match(css, /-webkit-text-size-adjust:100%/);
  assert.match(css, /\.clean-shell\{max-width:100vw;overflow-x:hidden\}/);
  assert.match(css, /\.order-card button\.review-toggle\{display:block;touch-action:manipulation\}/);
  assert.match(css, /\.candle-chart\{width:100%;max-width:100%;min-width:0;overflow:hidden\}/);
  assert.match(css, /\.observer-timeline\{width:100%;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain\}/);
  assert.match(css, /repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /calc\(100vw - 18px\)/);
});

test("HTE31 Durable Objects use a bounded low-write runtime", () => {
  const worker = readFileSync(new URL("../worker/hte31-workers.ts", import.meta.url), "utf8");
  assert.match(worker, /CLEAN_RUNTIME_VERSION = "hte31-low-write-1"/);
  assert.match(worker, /SCANNER_CYCLE_INTERVAL_MS = 60_000/);
  assert.match(worker, /TRADE_MANAGER_IDLE_INTERVAL_MS = 60_000/);
  assert.match(worker, /TRADE_MANAGER_IDLE_HEARTBEAT_MS = 5 \* 60_000/);
  assert.match(worker, /type ScannerRuntime = \{[\s\S]*rotationOffset:[\s\S]*job:[\s\S]*readModel:[\s\S]*status:/);
  assert.match(worker, /this\.ctx\.storage\.put\("runtime", runtime\)/);
  assert.doesNotMatch(worker, /this\.ctx\.storage\.put\("(?:job|status|readModel|rotationOffset)"/);
  assert.match(worker, /maxSteps = job\.phase === "config" \|\| job\.phase === "candles" \? 2 : 1/);
  assert.match(worker, /the 1-minute Cron is the independent watchdog/);
  assert.doesNotMatch(worker, /setAlarm\(fallback\)/);
  assert.match(worker, /stateChanged \|\| heartbeatDue/);
});
