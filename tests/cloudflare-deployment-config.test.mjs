import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("generated Cloudflare deployment config has unique bindings", async () => {
  const config = JSON.parse(
    await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"),
  );
  const bindings = [
    config.assets?.binding,
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
