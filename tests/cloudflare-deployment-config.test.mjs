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

test("MarketScanner shards Cloudflare Free deep scans across invocations and keeps cron watchdog", async () => {
  const source = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(source, /export class MarketScanner[\s\S]*?protected readonly intervalMs = 20_000/);
  assert.match(source, /profile: "free-background"[\s\S]*?deepLimit: 1/);
  assert.match(source, /async runIfDue\(\): Promise<SchedulerWorkerStatus>/);
  assert.match(source, /runScheduledSchedulers/);
  assert.match(source, /MARKET_SCANNER\.getByName\("market-scanner"\)\.runIfDue\(\)/);
  assert.match(source, /ctx\.waitUntil\(runScheduledSchedulers\(env\)\)/);
  assert.match(source, /staleActivity/);
  assert.match(source, /invalidAlarm/);
  assert.match(source, /startedAt \+ 45_000/);
  assert.match(source, /Math\.max\(Date\.now\(\) \+ 5_000, startedAt \+ 20_000\)/);
  assert.match(source, /Date\.now\(\) \+ 10_000/);
  assert.match(source, /state: "starting"/);
  assert.match(source, /market scanner cycle failed/);
});

test("Cloudflare Free HTE scan strips retired lifecycle work and stages upstream load", async () => {
  const source = await readFile(new URL("../lib/scanner.ts", import.meta.url), "utf8");
  assert.match(source, /const freeBackground = options\.profile === "free-background"/);
  assert.match(source, /if \(!freeBackground\) await retireLegacyShadowTrades\(\)/);
  assert.match(source, /if \(!freeBackground\) \{[\s\S]*?getPriorLong\(ticker\.symbol\)[\s\S]*?getExperience\(ticker\.symbol\)/);
  assert.match(source, /if \(freeBackground\) \{[\s\S]*?const packet = await analyze\(\);[\s\S]*?const growthData = await growth\(\)/);
  assert.match(source, /if \(!freeBackground\) \{[\s\S]*?legacyObservationOnly\(packet\)[\s\S]*?processDecision\(basePacket, settings\)/);

  const universe = source.indexOf("const universe = await fetchGateUniverse");
  const context = source.indexOf("const context = await getGlobalRiskContext", universe);
  const d1Reads = source.indexOf("const [previousV2, experienceBook] = await Promise.all", context);
  assert.ok(universe > 0, "universe stage must exist");
  assert.ok(context > universe, "global risk must start after universe headers/data complete");
  assert.ok(d1Reads > context, "D1 learning/context reads must start after upstream market stages");
});

test("scanner health exposes explicit hard-interruption diagnosis instead of blank error", async () => {
  const [worker, hte] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/hte/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /status\.state === "starting"[\s\S]*?now - status\.lastRunAt > 40_000/);
  assert.match(worker, /上一次市场扫描 invocation 在完成状态写入前中断/);
  assert.match(worker, /scanner: \{ state: scanner\.state, lastRunAt: scanner\.lastRunAt, lastSuccessAt: scanner\.lastSuccessAt, nextRunAt: scanner\.nextRunAt, lastError: scanner\.lastError \}/);
  assert.match(hte, /schedulerLastError/);
  assert.match(hte, /schedulerAttemptAgeMs/);
  assert.match(hte, /最近扫描错误/);
  assert.match(hte, /调度器最后尝试/);
});
