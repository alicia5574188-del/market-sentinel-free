import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Cloudflare Free MarketScanner owns only one deep symbol per invocation", async () => {
  const [worker, scheduler] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/background-scheduler.ts", import.meta.url), "utf8"),
  ]);

  const marketScanner = worker.match(/export class MarketScanner[\s\S]*?export class LiveTradingCoordinator/)?.[0] ?? "";
  assert.match(marketScanner, /protected readonly intervalMs = 20_000/);
  assert.match(marketScanner, /profile: "free-background"[\s\S]*?deepLimit: 1/);
  assert.doesNotMatch(marketScanner, /deepLimit: 3/);
  assert.match(scheduler, /scanCadenceSeconds: 20/);
  assert.match(scheduler, /deepBatchSize: 1/);
});

test("hard-killed scanner invocations become observable without requiring the failed catch path", async () => {
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const marketScanner = worker.match(/export class MarketScanner[\s\S]*?export class LiveTradingCoordinator/)?.[0] ?? "";
  assert.match(marketScanner, /async status\(\): Promise<SchedulerWorkerStatus>/);
  assert.match(marketScanner, /status\.state === "starting"/);
  assert.match(marketScanner, /now - status\.lastRunAt > 40_000/);
  assert.match(marketScanner, /上一次市场扫描 invocation 在完成状态写入前中断/);
});
