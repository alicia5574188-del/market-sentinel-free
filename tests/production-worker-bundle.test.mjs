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

test("production Worker bundle contains the HTE 3.1 clean runtime", async () => {
  const source = await readBuiltWorkerSource();
  assert.match(source, /hte31-clean-1/);
  assert.match(source, /HTE 3\.1 Clean/);
  assert.match(source, /Clean 配置 \/ 持仓隔离/);
  assert.match(source, /HT1 \/ HT2 \/ HT3 独立评估/);
  assert.match(source, /HTE31MarketScanner/);
  assert.match(source, /HTE31TradeManager/);
  assert.doesNotMatch(source, /class_name":"MarketScannerV2"/);
});

test("generated Wrangler config uses fresh clean simulation namespaces and retires legacy classes", async () => {
  const config = JSON.parse(await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"));
  assert.deepEqual(
    config.durable_objects?.bindings?.find(({ name }) => name === "MARKET_SCANNER"),
    { name: "MARKET_SCANNER", class_name: "HTE31MarketScanner" },
  );
  assert.deepEqual(
    config.durable_objects?.bindings?.find(({ name }) => name === "POSITION_MONITOR"),
    { name: "POSITION_MONITOR", class_name: "HTE31TradeManager" },
  );
  const v4 = (config.migrations ?? []).find(({ tag }) => tag === "v4");
  assert.ok(
    v4?.new_sqlite_classes?.includes("HTE31MarketScanner") && v4?.new_sqlite_classes?.includes("HTE31TradeManager"),
    "production config must create fresh HTE31 simulation Durable Object namespaces",
  );
  assert.deepEqual(
    [...(v4?.deleted_classes ?? [])].sort(),
    ["MarketScanner", "MarketScannerV2", "PositionMonitor"],
    "clean deployment must explicitly delete retired simulation Durable Object classes",
  );
  assert.ok(
    (config.durable_objects?.bindings ?? []).every(({ class_name }) => !["MarketScanner", "MarketScannerV2", "PositionMonitor"].includes(class_name)),
    "no production binding may keep a retired simulation class alive",
  );
});
