import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [scheduler, client, layout, liveEngine, page, liveStatus, gatePrivate, apiAuth, userAccounts, serviceWorker, recoveryPage, earlyGuard, worker, marketRoute, scannerRoute, gateClient] = await Promise.all([
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
  readFile(new URL("../public/recovery.html", import.meta.url), "utf8"),
  readFile(new URL("../public/sentinel-runtime-guard.js", import.meta.url), "utf8"),
  readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/market/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/scanner/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/gate-client.ts", import.meta.url), "utf8"),
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

test("client fallback retries only safe read APIs, coalesces polls, bounds concurrency, backs off failures and normalizes broken API bodies", () => {
  assert.match(client, /method !== "GET"/);
  assert.match(client, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(client, /response\.status === 429 \|\| response\.status >= 500/);
  assert.match(client, /RETRY_DELAYS = \[900, 2_200\]/);
  assert.match(client, /READ_TIMEOUT_MS\s*=\s*8_000/);
  assert.match(client, /MARKET_READ_TIMEOUT_MS\s*=\s*15_000/);
  assert.match(client, /MUTATION_TIMEOUT_MS\s*=\s*20_000/);
  assert.match(client, /LONG_MUTATION_TIMEOUT_MS\s*=\s*45_000/);
  assert.match(client, /DEEP_SCAN_TIMEOUT_MS\s*=\s*45_000/);
  assert.match(client, /READ_START_GAP_MS\s*=\s*240/);
  assert.match(client, /EDGE_BACKOFF_MS\s*=\s*2_500/);
  assert.match(client, /MAX_CONCURRENT_READS\s*=\s*3/);
  assert.match(client, /inFlightReads/);
  assert.match(client, /coalescedRead/);
  assert.match(client, /waitForReadStart/);
  assert.match(client, /markTransientBackoff/);
  assert.match(client, /acquireReadSlot/);
  assert.match(client, /withReadSlot/);
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

test("pre-hydration guard owns read admission before any React poller can start", () => {
  assert.match(layout, /<body>\s*<script src="\/sentinel-runtime-guard\.js" \/>\s*<RuntimeStabilityClient \/>\s*\{children\}/);
  assert.match(earlyGuard, /__SENTINEL_RESILIENT_FETCH_INSTALLED__/);
  assert.match(earlyGuard, /GLOBAL_START_GAP_MS\s*=\s*500/);
  assert.match(earlyGuard, /EDGE_CIRCUIT_MS\s*=\s*15_000/);
  assert.match(earlyGuard, /EXTENDED_EDGE_CIRCUIT_MS\s*=\s*30_000/);
  assert.match(earlyGuard, /MAX_CONCURRENT_READS\s*=\s*2/);
  assert.match(earlyGuard, /MAX_CONCURRENT_HEAVY_READS\s*=\s*1/);
  assert.match(earlyGuard, /pathname === "\/api\/market"\) return 30_000/);
  assert.match(earlyGuard, /pathname === "\/api\/v2"\) return 45_000/);
  assert.doesNotMatch(earlyGuard, /return pathname === "\/api\/market"/);
  assert.doesNotMatch(earlyGuard, /\|\| pathname === "\/api\/scanner"/);
  assert.match(earlyGuard, /response\.status === 429 \|\| response\.status >= 500/);
  assert.match(earlyGuard, /openCircuit/);
  assert.match(earlyGuard, /sentinel:edge-pressure/);
  assert.match(earlyGuard, /blank-shell/);
  assert.doesNotMatch(earlyGuard, /RETRY_DELAYS/);
});

test("production foreground market reads consume the background scanner model instead of recomputing Gate data", () => {
  assert.match(worker, /foregroundReadModel/);
  assert.match(worker, /foregroundMarket:\$\{packet\.symbol\}/);
  assert.match(worker, /async readModel\(\)/);
  assert.match(worker, /async marketSnapshot\(symbol: string\)/);
  assert.match(marketRoute, /bindings\.BACKGROUND_MODE === "cloudflare-free"[\s\S]*return backgroundMarketResponse\(symbol\)/);
  assert.match(marketRoute, /scanner\.marketSnapshot\(symbol\)/);
  assert.match(marketRoute, /前台不会回退为 Gate 重型计算/);
  assert.match(marketRoute, /return directMarketResponse\(symbol\)/);
  assert.match(scannerRoute, /bindings\.BACKGROUND_MODE === "cloudflare-free"[\s\S]*return backgroundScannerResponse\(\)/);
  assert.match(scannerRoute, /scanner\.readModel\(\)/);
  assert.match(scannerRoute, /前台不会自行向 Gate 发起重复扫描/);
  assert.match(scannerRoute, /return Response\.json\(await getQuickScanner\(\)/);
});

test("Gate public analysis has bounded endpoint fanout instead of firing every source simultaneously", () => {
  assert.match(gateClient, /ANALYSIS_UPSTREAM_CONCURRENCY\s*=\s*4/);
  assert.match(gateClient, /settleFactoriesBounded/);
  assert.match(gateClient, /const settled = await settleFactoriesBounded\(keys\.map/);
  assert.doesNotMatch(gateClient, /Promise\.allSettled\(keys\.map/);
  assert.match(gateClient, /settleFactoriesBounded\(unique\.map/);
});

test("top-level navigation uses a timed self-contained recovery page instead of hanging or stale dynamic HTML", () => {
  assert.match(serviceWorker, /CACHE_NAME = "market-sentinel-shell-v7"/);
  assert.match(serviceWorker, /RECOVERY_URL = "\/recovery\.html"/);
  assert.match(serviceWorker, /NAVIGATION_TIMEOUT_MS = 5_000/);
  assert.match(serviceWorker, /async function navigationFetch/);
  assert.match(serviceWorker, /new AbortController\(\)/);
  assert.match(serviceWorker, /controller\.abort\(\)/);
  assert.match(serviceWorker, /"\/sentinel-runtime-guard\.js"/);
  assert.match(serviceWorker, /if \(url\.pathname\.startsWith\("\/api\/"\) \|\| url\.pathname === "\/__health"\) return;/);
  assert.match(serviceWorker, /response\.status === 429 \|\| response\.status >= 500/);
  assert.match(serviceWorker, /return recoveryResponse\(\)/);
  assert.doesNotMatch(serviceWorker, /cache\.put\(isNavigation \? "\/"/);
  assert.doesNotMatch(serviceWorker, /caches\.match\("\/"\)/);
  assert.match(recoveryPage, /正在恢复连接/);
  assert.match(recoveryPage, /不会用旧数据冒充实时数据/);
  assert.match(recoveryPage, /DELAYS = \[4_000, 8_000, 16_000, 30_000, 30_000\]/);
  assert.match(recoveryPage, /location\.replace\("\/"\)/);
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
