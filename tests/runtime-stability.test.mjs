import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [scheduler, client, layout, liveEngine, page, liveStatus, gatePrivate, apiAuth, userAccounts, serviceWorker] = await Promise.all([
  readFile(new URL("../lib/background-scheduler.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/runtime-stability-client.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/live-trading-engine.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/api/live/status/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/gate-private.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api-auth.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/user-accounts.ts", import.meta.url), "utf8"),
  readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
]);

test("background health isolates modules and wakes only lightweight schedulers", () => {
  assert.match(scheduler, /Promise\.allSettled/);
  assert.match(scheduler, /POSITION_STALE_MS\s*=\s*45_000/);
  assert.match(scheduler, /SCANNER_STALE_MS\s*=\s*180_000/);
  assert.match(scheduler, /await stub\.wake\(\)/);
  assert.match(scheduler, /autoRecoveryTriggered/);
  assert.match(scheduler, /live_coordinator/);
  assert.match(scheduler, /市场扫描/);
  assert.match(scheduler, /持仓监控/);
  assert.match(scheduler, /实盘协调器/);
  assert.match(scheduler, /getLiveTradingSnapshot/);
  assert.doesNotMatch(scheduler, /await\s+stub\.reconcileNow\(/);
  assert.match(scheduler, /idleDisabled/);
  assert.match(scheduler, /自动实盘关闭且无活动实盘仓位/);
  assert.match(scheduler, /issues:/);
});

test("client retries only safe read APIs, coalesces overlapping polls, backs off failures and normalizes broken API bodies", () => {
  assert.match(client, /method !== "GET"/);
  assert.match(client, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(client, /response\.status === 429 \|\| response\.status >= 500/);
  assert.match(client, /RETRY_DELAYS = \[750, 1_800\]/);
  assert.match(client, /READ_TIMEOUT_MS\s*=\s*8_000/);
  assert.match(client, /MARKET_READ_TIMEOUT_MS\s*=\s*15_000/);
  assert.match(client, /MUTATION_TIMEOUT_MS\s*=\s*20_000/);
  assert.match(client, /LONG_MUTATION_TIMEOUT_MS\s*=\s*45_000/);
  assert.match(client, /DEEP_SCAN_TIMEOUT_MS\s*=\s*45_000/);
  assert.match(client, /READ_START_GAP_MS\s*=\s*120/);
  assert.match(client, /EDGE_BACKOFF_MS\s*=\s*1_500/);
  assert.match(client, /inFlightReads/);
  assert.match(client, /coalescedRead/);
  assert.match(client, /waitForReadStart/);
  assert.match(client, /markTransientBackoff/);
  assert.match(client, /new AbortController\(\)/);
  assert.match(client, /请求超时/);
  assert.match(client, /normalizeApiResponse/);
  assert.match(client, /返回了非 JSON 响应/);
  assert.match(client, /CF Ray/);
  assert.match(client, /canonicalRequestInput/);
  assert.match(client, /if \(!retryableRequest\(input, init\) \|\| !info\)/);
  assert.match(client, /系统健康/);
  assert.match(client, /后台扫描、持仓监控与实盘协调器/);
  assert.match(client, /module\.label/);
});

test("top-level navigation keeps the last good shell on transient Cloudflare resource failures", () => {
  assert.match(serviceWorker, /if \(url\.pathname\.startsWith\("\/api\/"\) \|\| url\.pathname === "\/__health"\) return;/);
  assert.match(serviceWorker, /const transientEdgeFailure = isNavigation && \(response\.status === 429 \|\| response\.status >= 500\)/);
  assert.match(serviceWorker, /Cloudflare 1102/);
  assert.match(serviceWorker, /await caches\.match\("\/"\)/);
  assert.match(serviceWorker, /X-Sentinel-Navigation-Fallback/);
  assert.match(serviceWorker, /if \(response\.ok\)/);
});

test("shared API auth failures stay inside JSON and normal account polls avoid a duplicate D1 select", () => {
  assert.match(apiAuth, /try\s*{\s*const user = await getChatGPTUser\(\)/);
  assert.match(apiAuth, /Response\.json\(\{ error:/);
  assert.match(apiAuth, /status:\s*503/);
  assert.match(userAccounts, /if \(existing\)[\s\S]*return existing;/);
  assert.match(userAccounts, /Only the first-login\/concurrent-create path needs a second read/);
});

test("live status polling reads durable state without joining the Gate execution queue", () => {
  assert.match(liveStatus, /getLiveTradingSnapshot/);
  assert.doesNotMatch(liveStatus, /liveTradingCoordinator/);
  assert.doesNotMatch(liveStatus, /coordinator\.ensure/);
  assert.doesNotMatch(liveStatus, /coordinator\.snapshot/);
});

test("Gate private reads retry safely while mutations stay single-attempt", () => {
  assert.match(gatePrivate, /const safeRead = method === "GET"/);
  assert.match(gatePrivate, /const maxAttempts = safeRead \? 2 : 1/);
  assert.match(gatePrivate, /response\.status === 429 \|\| response\.status >= 500/);
  assert.match(gatePrivate, /Gate \$\{path\} 读取超时/);
  assert.match(gatePrivate, /DEFAULT_GATE_READ_TIMEOUT_MS\s*=\s*7_000/);
  assert.match(gatePrivate, /DEFAULT_GATE_MUTATION_TIMEOUT_MS\s*=\s*8_000/);
});

test("runtime stability layer is mounted globally", () => {
  assert.match(layout, /RuntimeStabilityClient/);
  assert.match(layout, /runtime-stability\.css/);
});

test("transient reconciliation degradation pauses entries without disarming Auto Live", () => {
  assert.doesNotMatch(liveEngine, /await riskLock\(`后台对账失败：/);
  assert.match(liveEngine, /后台对账暂时不可用/);
  assert.match(liveEngine, /reconciliation_temporarily_paused/);
  assert.match(liveEngine, /recoveringFromTransientPause/);
  assert.match(liveEngine, /下一轮恢复新开仓/);
  assert.match(liveEngine, /credentialFailure[\s\S]*await riskLock\(`Gate API 凭据失效：/);
});

test("hard live safety violations still latch a real risk lock", () => {
  assert.match(liveEngine, /统一\/组合保证金模式[\s\S]*await riskLock\(reason\)/);
  assert.match(liveEngine, /无法确认日内盈亏完整性[\s\S]*await riskLock\(reason\)/);
  assert.match(liveEngine, /合约账户权益无效或已归零[\s\S]*await riskLock\(reason\)/);
  assert.match(liveEngine, /保护单未完整建立[\s\S]*riskLock/);
  assert.match(liveEngine, /未纳入账本的 Gate 仓位/);
});

test("UI separates market-data degradation from the real live-control state", () => {
  assert.match(page, /实盘状态读取中/);
  assert.match(page, /自动实盘开启 · 新开仓暂缓/);
  assert.match(page, /实盘风控锁定/);
});
