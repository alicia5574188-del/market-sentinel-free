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

test("production Worker bundle contains the direct market brain runtime", async () => {
  const source = await readBuiltWorkerSource();
  assert.match(source, /direct-market-brain-v5-entry-integrity/);
  assert.match(source, /Resonance/);
  assert.match(source, /大脑决策 · 三策略贡献 · 12小时复盘/);
  assert.match(source, /量价力度假突破/);
  assert.match(source, /衰竭反转/);
  assert.match(source, /多周期综合共振/);
  assert.match(source, /谁在发力，谁在拖后腿/);
  assert.match(source, /每12小时总结/);
  assert.match(source, /最大持仓/);
  assert.match(source, /HTE31MarketScanner/);
  assert.match(source, /HTE31TradeManager/);
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
