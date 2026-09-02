import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("generated Cloudflare deployment config has unique bindings", async () => {
  const config = JSON.parse(await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"));
  const bindings = [
    config.assets?.binding,
    config.version_metadata?.binding,
    ...(config.d1_databases ?? []).map(({ binding }) => binding),
    ...(config.durable_objects?.bindings ?? []).map(({ name }) => name),
    ...Object.keys(config.vars ?? {}),
  ].filter(Boolean);
  assert.deepEqual(bindings.filter((binding, index) => bindings.indexOf(binding) !== index), []);
  assert.equal((config.d1_databases ?? []).filter(({ binding }) => binding === "DB").length, 1);
  assert.equal((config.compatibility_flags ?? []).filter((flag) => flag === "nodejs_compat").length, 1);
  assert.deepEqual(
    (config.durable_objects?.bindings ?? []).filter(({ name }) => name === "LIVE_TRADING_COORDINATOR"),
    [{ name: "LIVE_TRADING_COORDINATOR", class_name: "LiveTradingCoordinator" }],
  );
  assert.deepEqual(config.triggers?.crons, ["* * * * *"]);
});

test("HTE 3.1 uses fresh bound namespaces while legacy classes stay unbound", async () => {
  const config = JSON.parse(await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"));
  assert.deepEqual(config.durable_objects?.bindings?.find(({ name }) => name === "MARKET_SCANNER"), { name: "MARKET_SCANNER", class_name: "HTE31MarketScanner" });
  assert.deepEqual(config.durable_objects?.bindings?.find(({ name }) => name === "POSITION_MONITOR"), { name: "POSITION_MONITOR", class_name: "HTE31TradeManager" });
  const migrations = config.migrations ?? [];
  const v4 = migrations.find(({ tag }) => tag === "v4");
  assert.ok(v4?.new_sqlite_classes?.includes("HTE31MarketScanner") && v4?.new_sqlite_classes?.includes("HTE31TradeManager"));
  assert.equal(migrations.some(({ deleted_classes: deleted }) => (deleted ?? []).length > 0), false, "clean deployment must be additive-only");
  assert.equal(migrations.some(({ renamed_classes: renamed }) => (renamed ?? []).length > 0), false, "clean deployment must not rename legacy storage");
  const boundClasses = new Set((config.durable_objects?.bindings ?? []).map(({ class_name }) => class_name));
  for (const retired of ["PositionMonitor", "MarketScanner", "MarketScannerV2"]) assert.equal(boundClasses.has(retired), false);
});

test("legacy DO exports are isolated tombstones that self-retire orphaned alarms", async () => {
  const source = await readFile(new URL("../worker/index-clean.ts", import.meta.url), "utf8");
  assert.match(source, /DurableObject/);
  assert.match(source, /LegacySchedulerTombstone extends DurableObject/);
  assert.match(source, /retireLegacyScheduler/);
  assert.match(source, /storage\.deleteAlarm\(\)/);
  assert.match(source, /storage\.deleteAll\(\)/);
  assert.doesNotMatch(source, /LegacyPositionMonitor|LegacyMarketScanner/);
  assert.doesNotMatch(source, /MarketScanner as|PositionMonitor as/);
  assert.doesNotMatch(source, /setAlarm\(/);
  for (const className of ["PositionMonitor", "MarketScanner", "MarketScannerV2"]) {
    assert.match(source, new RegExp(`export class ${className} extends LegacySchedulerTombstone`));
  }
  assert.match(source, /HTE31MarketScanner, HTE31TradeManager/);
});

test("Resonance scanner is phased and cannot restart the whole old scan loop", async () => {
  const [worker, scanner] = await Promise.all([
    readFile(new URL("../worker/hte31-workers.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/hte31-scanner.ts", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /CLEAN_RUNTIME_VERSION = "resonance-v4-unified-paper-live-parity"/);
  assert.match(worker, /export class HTE31MarketScanner/);
  assert.match(worker, /createHte31ScanJob/);
  assert.match(worker, /priorAttempt >= 3/);
  assert.match(worker, /5 \* 60_000/);
  assert.match(worker, /circuitOpen: true/);
  assert.match(worker, /Date\.now\(\) \+ 1_000/);
  assert.match(scanner, /Hte31ScanPhase = "config" \| "universe" \| "deep" \| "candles" \| "evaluate"/);
  for (const phase of ["config", "universe", "deep", "candles", "evaluate"]) assert.match(scanner, new RegExp(`job\\.phase === \\"${phase}\\"`));
  assert.doesNotMatch(scanner, /runMarketScan|getStrategy2ExperienceBook|saveV2Opportunities|processShadowStrategies|trade_cases/);
});

test("simulation trade manager is independent from scanner and owns post-exit observation", async () => {
  const worker = await readFile(new URL("../worker/hte31-workers.ts", import.meta.url), "utf8");
  assert.match(worker, /export class HTE31TradeManager/);
  assert.match(worker, /listHte31OpenTrades/);
  assert.match(worker, /fetchGatePositionQuotes/);
  assert.match(worker, /applyHte31PositionQuote/);
  assert.match(worker, /nextHte31PostExitObservation/);
  assert.match(worker, /completeHte31PostExitObservation/);
  const tradeManager = worker.slice(worker.indexOf("export class HTE31TradeManager"));
  assert.doesNotMatch(tradeManager, /runHte31ScanStep|evaluateHumanTraderPool|fetchGateUniverse/);
});

test("Worker serves public bundles from ASSETS before the app router", async () => {
  const source = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const publicAssetBranch = source.indexOf("if (isPublicAsset(url.pathname))");
  const assetFetch = source.indexOf("env.ASSETS.fetch(request)", publicAssetBranch);
  const appRouter = source.indexOf("return handler.fetch(request, env, ctx)");
  assert.ok(publicAssetBranch >= 0 && assetFetch > publicAssetBranch && appRouter > assetFetch);
});
