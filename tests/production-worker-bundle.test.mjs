import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

async function readBuiltWorkerSource() {
  const root = new URL("../dist/server/", import.meta.url);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const jsFiles = entries
    .filter((entry) => entry.isFile() && /\.(?:m?js)$/.test(entry.name))
    .map((entry) => new URL(entry.parentPath.replaceAll("\\", "/") + "/" + entry.name, "file://"));
  assert.ok(jsFiles.length > 0, "vinext must emit production Worker JavaScript");
  return (await Promise.all(jsFiles.map((file) => readFile(file, "utf8")))).join("\n");
}

test("production Worker bundle contains the cognitive Resonance runtime", async () => {
  const source = await readBuiltWorkerSource();
  assert.match(source, /resonance-v5-strategy-lifecycle/);
  assert.match(source, /Resonance/);
  assert.match(source, /市场记忆 · 自适应交易/);
  assert.match(source, /9个策略家族 \/ 13个变体统一评估与大脑选单/);
  assert.match(source, /HTE31MarketScanner/);
  assert.match(source, /HTE31TradeManager/);
  assert.match(source, /COGNITIVE_ADAPTATION/);
});

test("generated Wrangler config uses additive-only migration for clean simulation namespaces", async () => {
  const config = JSON.parse(await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"));
  assert.deepEqual(
    config.durable_objects?.bindings?.find(({ name }) => name === "MARKET_SCANNER"),
    { name: "MARKET_SCANNER", class_name: "HTE31MarketScanner" },
  );
  assert.deepEqual(
    config.durable_objects?.bindings?.find(({ name }) => name === "POSITION_MONITOR"),
    { name: "POSITION_MONITOR", class_name: "HTE31TradeManager" },
  );
  const migrations = config.migrations ?? [];
  const v4 = migrations.find(({ tag }) => tag === "v4");
  assert.ok(
    v4?.new_sqlite_classes?.includes("HTE31MarketScanner") && v4?.new_sqlite_classes?.includes("HTE31TradeManager"),
    "v4 must only create the fresh HTE31 namespaces",
  );
  assert.equal(migrations.some(({ deleted_classes: deleted }) => (deleted ?? []).length > 0), false);
  assert.equal(migrations.some(({ renamed_classes: renamed }) => (renamed ?? []).length > 0), false);
});
