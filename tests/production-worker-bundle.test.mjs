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

test("production Worker bundle contains the resumable scanner V2 runtime", async () => {
  const source = await readBuiltWorkerSource();
  // These are durable string keys/labels and therefore cannot disappear through
  // identifier minification. Their presence proves the source state machine is
  // actually inside the artifact Wrangler deploys.
  assert.match(source, /freeScanJob/);
  assert.match(source, /读取设置 \/ Universe 粗扫/);
  assert.match(source, /Human Trader 三交易员评估 \/ 订单生命周期/);
  assert.match(source, /MarketScannerV2/);
});

test("generated Wrangler config binds MARKET_SCANNER to the fresh V2 namespace", async () => {
  const config = JSON.parse(await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"));
  assert.deepEqual(
    config.durable_objects?.bindings?.find(({ name }) => name === "MARKET_SCANNER"),
    { name: "MARKET_SCANNER", class_name: "MarketScannerV2" },
  );
  assert.ok(
    (config.migrations ?? []).some(({ tag, new_sqlite_classes: classes }) => tag === "v3" && classes?.includes("MarketScannerV2")),
    "production config must create the fresh MarketScannerV2 SQLite namespace",
  );
});
