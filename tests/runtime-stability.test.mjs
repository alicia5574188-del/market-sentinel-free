import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [scheduler, client, layout] = await Promise.all([
  readFile(new URL("../lib/background-scheduler.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/runtime-stability-client.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
]);

test("background health isolates modules and wakes stale schedulers", () => {
  assert.match(scheduler, /Promise\.allSettled/);
  assert.match(scheduler, /POSITION_STALE_MS\s*=\s*45_000/);
  assert.match(scheduler, /SCANNER_STALE_MS\s*=\s*180_000/);
  assert.match(scheduler, /await stub\.wake\(\)/);
  assert.match(scheduler, /autoRecoveryTriggered/);
  assert.match(scheduler, /live_coordinator/);
  assert.match(scheduler, /市场扫描/);
  assert.match(scheduler, /持仓监控/);
  assert.match(scheduler, /实盘协调器/);
  assert.match(scheduler, /issues:/);
});

test("client retries only safe read APIs and exposes exact health", () => {
  assert.match(client, /method !== "GET"/);
  assert.match(client, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(client, /response\.status === 429 \|\| response\.status >= 500/);
  assert.match(client, /RETRY_DELAYS = \[350, 900\]/);
  assert.match(client, /系统健康/);
  assert.match(client, /后台扫描、持仓监控与实盘协调器/);
  assert.match(client, /module\.label/);
});

test("runtime stability layer is mounted globally", () => {
  assert.match(layout, /RuntimeStabilityClient/);
  assert.match(layout, /runtime-stability\.css/);
});
