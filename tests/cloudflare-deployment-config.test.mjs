import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("generated Cloudflare deployment config has unique bindings", async () => {
  const config = JSON.parse(
    await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"),
  );
  const bindings = [
    config.assets?.binding,
    config.version_metadata?.binding,
    ...(config.d1_databases ?? []).map(({ binding }) => binding),
    ...(config.durable_objects?.bindings ?? []).map(({ name }) => name),
    ...Object.keys(config.vars ?? {}),
  ].filter(Boolean);

  assert.deepEqual(
    bindings.filter((binding, index) => bindings.indexOf(binding) !== index),
    [],
  );
  assert.equal(
    (config.d1_databases ?? []).filter(({ binding }) => binding === "DB").length,
    1,
  );
  assert.equal(
    (config.compatibility_flags ?? []).filter(
      (flag) => flag === "nodejs_compat",
    ).length,
    1,
  );
  assert.deepEqual(
    (config.durable_objects?.bindings ?? []).filter(({ name }) => name === "LIVE_TRADING_COORDINATOR"),
    [{ name: "LIVE_TRADING_COORDINATOR", class_name: "LiveTradingCoordinator" }],
  );
  assert.ok((config.migrations ?? []).some(({ new_sqlite_classes: classes }) => classes?.includes("LiveTradingCoordinator")));
  assert.deepEqual(config.version_metadata, { binding: "CF_VERSION_METADATA" });
  assert.deepEqual(config.triggers?.crons, ["* * * * *"]);
});

test("Worker serves public bundles from ASSETS before the Vinext router", async () => {
  const source = await readFile(
    new URL("../worker/index.ts", import.meta.url),
    "utf8",
  );
  const publicAssetBranch = source.indexOf("if (isPublicAsset(url.pathname))");
  const assetFetch = source.indexOf("env.ASSETS.fetch(request)", publicAssetBranch);
  const assetReturn = source.indexOf(
    "if (assetResponse.status !== 404) return assetResponse",
    assetFetch,
  );
  const appRouter = source.indexOf("return handler.fetch(request, env, ctx)");

  assert.ok(publicAssetBranch >= 0);
  assert.ok(assetFetch > publicAssetBranch);
  assert.ok(assetReturn > assetFetch);
  assert.ok(appRouter > assetReturn);
});

test("MarketScanner is a resumable phased Durable Object job instead of a monolithic retry loop", async () => {
  const [worker, stateMachine] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/free-market-scan.ts", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /export class MarketScanner[\s\S]*?protected readonly intervalMs = 20_000/);
  assert.match(worker, /createFreeMarketScanJob/);
  assert.match(worker, /runFreeMarketScanStep/);
  assert.match(worker, /freeScanJob/);
  assert.match(worker, /phaseAttempts/);
  assert.match(worker, /priorAttempts >= 3/);
  assert.match(worker, /5 \* 60_000/);
  assert.match(worker, /circuitOpen: true/);
  assert.match(worker, /startedAt \+ 35_000/);
  assert.match(worker, /Date\.now\(\) \+ 1_000/);
  assert.match(worker, /Math\.max\(Date\.now\(\) \+ 5_000, startedAt \+ 20_000\)/);
  assert.match(worker, /MARKET_SCANNER\.getByName\("market-scanner"\)\.runIfDue\(\)/);
  assert.match(worker, /ctx\.waitUntil\(runScheduledSchedulers\(env\)\)/);

  const orderedPhases = ["bootstrap", "global_context", "market_context", "gate_deep", "candles", "evaluate", "finalize"];
  let cursor = -1;
  for (const phase of orderedPhases) {
    const next = stateMachine.indexOf(`job.phase === \"${phase}\"`, cursor + 1);
    if (phase === "finalize") {
      assert.match(stateMachine, /FreeMarketScanPhase = "bootstrap" \| "global_context" \| "market_context" \| "gate_deep" \| "candles" \| "evaluate" \| "finalize"/);
      break;
    }
    assert.ok(next > cursor, `${phase} phase must be present after the previous phase`);
    cursor = next;
  }
});

test("Cloudflare Free production path removes retired scanner lifecycle work and persists every heavy boundary", async () => {
  const source = await readFile(new URL("../lib/free-market-scan.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /retireLegacyShadowTrades|getPriorLong|getExperience|legacyObservationOnly/);
  assert.match(source, /phase === "bootstrap"[\s\S]*?fetchGateUniverse/);
  assert.match(source, /phase === "global_context"[\s\S]*?getGlobalRiskContext/);
  assert.match(source, /phase === "market_context"[\s\S]*?getLatestV2MarketContext/);
  assert.match(source, /phase === "gate_deep"[\s\S]*?analyzeGateSymbol/);
  assert.match(source, /phase === "candles"[\s\S]*?fetchGateChartCandles/);
  assert.match(source, /phase === "evaluate"[\s\S]*?getStrategy2ExperienceBook/);
  assert.match(source, /phase === "evaluate"[\s\S]*?processShadowStrategies/);
  assert.match(source, /const scan = await beginScan[\s\S]*?await completeScan/);
});

test("scanner health exposes exact phase and cannot wake through an open circuit", async () => {
  const [worker, hte, scheduler] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/hte/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/background-scheduler.ts", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /市场扫描阶段「\$\{status\.phase \?\? "unknown"\}」在完成状态写入前中断/);
  assert.match(worker, /phase: scanner\.phase \?\? null/);
  assert.match(worker, /phaseAttempt: scanner\.phaseAttempt \?\? 0/);
  assert.match(worker, /circuitOpen: scanner\.circuitOpen \?\? false/);
  assert.match(worker, /retryAfter: scanner\.retryAfter \?\? null/);
  assert.match(scheduler, /health === "recovering" && !status\.circuitOpen/);
  assert.match(scheduler, /if \(status\.circuitOpen\) return "degraded"/);
  assert.match(hte, /schedulerPhase/);
  assert.match(hte, /当前恢复阶段/);
  assert.match(hte, /不会从头无限重启/);
});
