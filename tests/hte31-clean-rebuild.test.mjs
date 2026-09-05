import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

function applyMigration(db, filename) {
  const sql = readFileSync(new URL(`../drizzle/${filename}`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) db.exec(statement);
}

test("full migration chain preserves the isolated HTE ledger", () => {
  const db = new DatabaseSync(":memory:");
  const migrations = readdirSync(new URL("../drizzle/", import.meta.url)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const migration of migrations) applyMigration(db, migration);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const table of ["hte31_trades","hte31_evaluations","hte31_learning","hte31_trade_charts","hte31_post_exit_observations"]) assert.ok(tables.has(table), `${table} must exist`);
  const chartColumns = new Set(db.prepare("PRAGMA table_info(hte31_trade_charts)").all().map((row) => row.name));
  assert.ok(chartColumns.has("entry_quality_json"));
  const researchColumns = new Set(db.prepare("PRAGMA table_info(hte31_shadow_samples)").all().map((row) => row.name));
  for (const column of ["sample_kind", "playbook_id", "max_holding_minutes", "terminal_at", "terminal_reason"]) assert.ok(researchColumns.has(column), column);
  const reset = db.prepare("SELECT status, reset_mode, active_brain_version, target_brain_version, requested_capital_usdt FROM hte31_paper_reset_state WHERE id = 'singleton'").get();
  assert.deepEqual({ ...reset }, {
    status: "pending",
    reset_mode: "force_archive",
    active_brain_version: "direct-market-brain-v1",
    target_brain_version: readFileSync(new URL("../lib/direct-market-types.ts", import.meta.url), "utf8").match(/DIRECT_MARKET_BRAIN_VERSION = "([^"]+)"/)[1],
    requested_capital_usdt: 1000,
  });
  assert.equal(db.prepare("SELECT count(*) AS n FROM hte31_trades").get().n, 0);
  db.close();
});

test("clean rebuild migration preserves real exchange data families and disarms only new entry authority", () => {
  const migration = readFileSync(new URL("../drizzle/0011_hte31_clean_rebuild.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /DELETE FROM\s+(?:live_orders|live_audit_events|live_exchange_credentials|trade_cases)/i);
  assert.match(migration, /UPDATE `live_trading_control`/);
  assert.match(migration, /`entry_enabled` = 0/);
  assert.match(migration, /`activation_epoch` = `activation_epoch` \+ 1/);
});

test("scanner gives new-entry authority only to the direct market brain", () => {
  const scanner = readFileSync(new URL("../lib/hte31-scanner.ts", import.meta.url), "utf8");
  assert.match(scanner, /buildAnalogCandidate/);
  assert.match(scanner, /HISTORICAL_UNIVERSE/);
  assert.match(scanner, /boundedMap/);
  assert.doesNotMatch(scanner, /analyzeSymbol/);
  assert.match(scanner, /buildResonanceGlobalMarket/);
  assert.match(scanner, /getMarketExchange/);
  assert.doesNotMatch(scanner, /evaluateHumanTraderPool|evaluateAdvancedHumanTraders|evaluateHte31ResearchStrategies|recordHte31Evaluations|tryOpenResonanceTrade|tradeCases|trade_cases/);
});

test("legacy families remain historical while live parity requires the exact direct-brain snapshot", () => {
  const catalog = readFileSync(new URL("../lib/hte31-strategy-catalog.ts", import.meta.url), "utf8");
  const live = readFileSync(new URL("../lib/live-trading-repository.ts", import.meta.url), "utf8");
  assert.match(catalog, /HTE31_ALL_TRADER_IDS/);
  assert.match(live, /HTE31_LIVE_PARITY_TRADERS = new Set<string>\(\["direct_market_brain"\]\)/);
  assert.match(live, /snapshot\.authority !== DIRECT_MARKET_AUTHORITY/);
  assert.match(live, /snapshot\.candidate\?\.symbol !== trade\.symbol/);
});

test("thirteen-strategy evaluations stay below the D1 bind budget", () => {
  const repository = readFileSync(new URL("../lib/hte31-repository.ts", import.meta.url), "utf8");
  assert.match(repository, /HTE31_EVALUATION_BATCH_SIZE = 4/);
  assert.match(repository, /rows\.slice\(index, index \+ HTE31_EVALUATION_BATCH_SIZE\)/);
});

test("D1 holding checkpoints never delay protection or exits", () => {
  const repository = readFileSync(new URL("../lib/hte31-repository.ts", import.meta.url), "utf8");
  const exitWrite = repository.indexOf('if (exitCode && exitPrice != null)');
  const checkpoint = repository.indexOf('shouldPersistHte31HoldingCheckpoint({');
  const holdingWrite = repository.indexOf('await db.update(hte31Trades).set({', checkpoint);
  assert.ok(exitWrite >= 0 && checkpoint > exitWrite && holdingWrite > checkpoint);
  assert.match(repository.slice(exitWrite, checkpoint), /status: "closed"/);
  assert.match(repository.slice(exitWrite, checkpoint), /updateLearningAfterClose/);
});

test("historical shadow rows stay readable but current routing learns from actual paper orders", () => {
  const diagnostics = readFileSync(new URL("../lib/hte31-diagnostics.ts", import.meta.url), "utf8");
  const currentCycle = diagnostics.slice(
    diagnostics.indexOf("export async function recordHte31DiagnosticCycle"),
    diagnostics.indexOf("function paperMaximumDrawdownR"),
  );
  assert.doesNotMatch(currentCycle, /advanceShadowSamples|createShadowSample|hte31ShadowSamples/);
  assert.doesNotMatch(diagnostics, /\.insert\(hte31ShadowSamples\)|\.update\(hte31ShadowSamples\)/);
  assert.match(diagnostics, /buildPaperRouterEvidence/);
  assert.match(diagnostics, /\.from\(hte31Trades\)/);
});

test("post-exit observer still follows every closed trade through twelve hours", () => {
  const repository = readFileSync(new URL("../lib/hte31-repository.ts", import.meta.url), "utf8");
  assert.match(repository, /POST_EXIT_HORIZONS = \[0, 30, 60, 120, 240, 480, 720\]/);
  assert.match(repository, /coveragePct >= 95/);
  assert.match(repository, /qualityStatus: "READY"/);
  assert.match(repository, /疑似假止损/);
  assert.match(repository, /退出偏早/);
  assert.match(repository, /退出偏晚/);
  assert.match(repository, /退出优秀/);
  assert.match(repository, /averageExitEfficiency/);
});

test("order chart keeps entry holding post-exit and counterfactual windows", () => {
  const [schema, api] = [
    readFileSync(new URL("../db/hte31-schema.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../app/api/hte31/chart/route.ts", import.meta.url), "utf8"),
  ];
  assert.match(schema, /entryCandlesJson/);
  assert.match(schema, /holdingCandlesJson/);
  assert.match(schema, /postExitCandlesJson/);
  assert.match(schema, /entryQualityJson/);
  assert.match(api, /markers/);
  assert.match(api, /initialStop/);
  assert.match(api, /takeProfit1/);
  assert.match(api, /takeProfit2/);
  assert.match(api, /observations/);
  assert.match(api, /buildHte31Counterfactual/);
  assert.match(api, /buildResonanceEntryQuality/);
});

test("runtime remains independent of the dashboard being open", () => {
  const [route, worker, wrangler] = [
    readFileSync(new URL("../app/api/hte31/route.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ];
  assert.doesNotMatch(route, /scanner\.ensure\s*\(/);
  assert.doesNotMatch(route, /position\.ensure\s*\(/);
  assert.match(route, /scanner\.status\s*\(/);
  assert.match(route, /scanner\.readModel\s*\(/);
  assert.match(route, /DIAGNOSTICS_CACHE_MS = 60_000/);
  assert.match(route, /DIAGNOSTICS_STALE_FALLBACK_MS = 5 \* 60_000/);
  assert.match(route, /readCachedDiagnostics\(requestedAt\)/);
  assert.match(worker, /async scheduled\([\s\S]*runScheduledSchedulers\(env\)/);
  assert.match(worker, /MARKET_SCANNER\.getByName\("market-scanner"\)\.runIfDue\(\)/);
  assert.match(wrangler, /"crons"\s*:\s*\["\* \* \* \* \*"\]/);
});

test("Resonance live page keeps real Gate account state and emergency controls", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /Gate 合约账户/);
  assert.match(page, />账户权益</);
  assert.match(page, /accountEquityLastUsdt/);
  assert.match(page, />今日已实现</);
  assert.match(page, /dailyRealizedPnlUsdt/);
  assert.match(page, /lastSuccessfulReconcileAt/);
  assert.match(page, /按住 1\.2 秒紧急停机/);
});

test("expanded trade review cannot widen the mobile viewport", () => {
  const css = readFileSync(new URL("../app/resonance.css", import.meta.url), "utf8");
  assert.match(css, /\.rz-shell \{ width: min\(920px, 100%\)/);
  assert.match(css, /box-sizing: border-box/);
  assert.match(css, /\.rz-chart \{ width: 100%; height: auto/);
  assert.match(css, /\.rz-order-pnl[\s\S]*white-space: nowrap/);
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0,1fr\)\)/);
});

test("Durable Objects retain bounded no-scan-write runtime and persist the direct brain", () => {
  const worker = readFileSync(new URL("../worker/hte31-workers.ts", import.meta.url), "utf8");
  assert.match(worker, /CLEAN_RUNTIME_VERSION = DIRECT_MARKET_BRAIN_VERSION/);
  assert.match(worker, /D1 trades, learning, simulation epochs, live[\s\S]*remain untouched/);
  assert.match(worker, /SCANNER_CYCLE_INTERVAL_MS = 60_000/);
  assert.match(worker, /TRADE_MANAGER_IDLE_INTERVAL_MS = 60_000/);
  assert.match(worker, /TRADE_MANAGER_IDLE_HEARTBEAT_MS = 5 \* 60_000/);
  assert.match(worker, /type ScannerRuntime = \{[\s\S]*rotationOffset:[\s\S]*directBySymbol\?:[\s\S]*directHistory\?:[\s\S]*status:/);
  assert.match(worker, /this\.ctx\.storage\.put\("runtime", runtime\)/);
  assert.doesNotMatch(worker, /this\.ctx\.storage\.put\("(?:job|status|readModel|rotationOffset)"/);
  assert.match(worker, /maxSteps = job\.phase === "config" \|\| job\.phase === "deep" \|\| job\.phase === "candles" \? 2 : 1/);
  assert.match(worker, /createHte31ScanJob\(runtime\.rotationOffset, runtime\.readModel\?\.market \?\? null, lastObservedAt\)/);
  assert.match(worker, /directHistory[\s\S]*\.slice\(0, 96\)/);
  assert.match(worker, /stateChanged \|\| heartbeatDue/);
});
