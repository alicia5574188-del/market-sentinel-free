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

test("production Worker bundle contains the HTE 3.1 clean runtime and inert archive classes", async () => {
  const source = await readBuiltWorkerSource();
  assert.match(source, /hte31-clean-1/);
  assert.match(source, /HTE 3\.1 Clean/);
  assert.match(source, /Clean 配置 \/ 持仓隔离/);
  assert.match(source, /HT1 \/ HT2 \/ HT3 独立评估/);
  assert.match(source, /HTE31MarketScanner/);
  assert.match(source, /HTE31TradeManager/);
  assert.match(source, /RetiredPositionMonitor/);
  assert.match(source, /RetiredMarketScanner/);
  assert.match(source, /RetiredMarketScannerV2/);
});

test("generated Wrangler config uses declarative exports as the HTE31 lifecycle source of truth", async () => {
  const config = JSON.parse(await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"));
  assert.equal(config.migrations, undefined, "declarative exports and legacy migrations must never be mixed");
  assert.deepEqual(
    config.durable_objects?.bindings?.find(({ name }) => name === "MARKET_SCANNER"),
    { name: "MARKET_SCANNER", class_name: "HTE31MarketScanner" },
  );
  assert.deepEqual(
    config.durable_objects?.bindings?.find(({ name }) => name === "POSITION_MONITOR"),
    { name: "POSITION_MONITOR", class_name: "HTE31TradeManager" },
  );
  for (const className of ["HTE31MarketScanner", "HTE31TradeManager", "LiveTradingCoordinator", "RetiredPositionMonitor", "RetiredMarketScanner", "RetiredMarketScannerV2"]) {
    assert.deepEqual(config.exports?.[className]?.type, "durable-object");
    assert.equal(config.exports?.[className]?.storage, "sqlite");
  }
  assert.deepEqual(config.exports?.PositionMonitor, { type: "durable-object", state: "renamed", renamed_to: "RetiredPositionMonitor" });
  assert.deepEqual(config.exports?.MarketScanner, { type: "durable-object", state: "renamed", renamed_to: "RetiredMarketScanner" });
  assert.deepEqual(config.exports?.MarketScannerV2, { type: "durable-object", state: "renamed", renamed_to: "RetiredMarketScannerV2" });
  assert.ok(
    (config.durable_objects?.bindings ?? []).every(({ class_name }) => !class_name.startsWith("Retired") && !["MarketScanner", "MarketScannerV2", "PositionMonitor"].includes(class_name)),
    "retired simulation namespaces must never be callable through production bindings",
  );
});
