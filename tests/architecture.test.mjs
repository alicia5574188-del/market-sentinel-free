import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("runtime uses bounded futures REST snapshots, no continuous WebSocket", async () => {
  const [worker, gate] = await Promise.all([read("worker/index-clean.ts"), read("lib/gate-market.ts")]);
  assert.match(gate, /\/futures\/usdt\/order_book/);
  assert.match(gate, /with_id=true/);
  assert.match(gate, /\/futures\/usdt\/liq_orders/);
  assert.match(gate, /\/futures\/usdt\/contract_stats/);
  assert.doesNotMatch(gate, /liq_orders\?status=/);
  assert.match(gate, /X-Gate-Size-Decimal/);
  assert.match(gate, /volume_24h_settle/);
  assert.match(gate, /\/futures\/usdt\/candlesticks/);
  assert.doesNotMatch(worker + gate, /new WebSocket|futures\.order_book_update/);
  assert.match(worker, /MAX_ANCILLARY_CONCURRENCY = 2/);
  assert.match(worker, /plannedTotalDoRequestsPerDay: 50_400/);
  assert.match(worker, /plannedDoWritesPerDay: 54_080/);
  assert.match(worker, /NON_ALARM_WRITE_CAP = 8_000/);
  assert.match(worker, /plannedMaxD1BilledWritesPerDay: 4_800/);
  assert.match(worker, /DEFAULT_SYMBOLS = \["BTC_USDT", "ETH_USDT", "SOL_USDT"\]/);
  assert.doesNotMatch(worker, /ZEC_USDT|BNB_USDT/);
  assert.match(worker, /maxSubrequestsPerAlarm: 32/);
  assert.match(worker, /now - this\.runtime\.lastStopCheckpointAt < 60_000/);
});

test("only one new DO is bound and all legacy DO storage is explicitly deleted", async () => {
  const config = JSON.parse(await read("wrangler.jsonc"));
  assert.deepEqual(config.durable_objects.bindings, [{ name: "MARKET_STREAM", class_name: "MarketStream" }]);
  const create = config.migrations.at(-2);
  const retire = config.migrations.at(-1);
  assert.deepEqual(create.new_sqlite_classes, ["MarketStream"]);
  assert.equal(create.deleted_classes, undefined);
  for (const name of ["PositionMonitor", "MarketScanner", "LiveTradingCoordinator", "MarketScannerV2", "HTE31MarketScanner", "HTE31TradeManager", "HistoricalArchive"]) assert.ok(retire.deleted_classes.includes(name));
});

test("owner-authenticated live API is isolated while the operator UI explains every decision", async () => {
  const [worker, page, layout, workflow, css, live, auth] = await Promise.all([
    read("worker/index-clean.ts"),
    read("app/page.tsx"),
    read("app/layout.tsx"),
    read(".github/workflows/sentinel-v2-ci.yml"),
    read("app/globals.css"),
    read("lib/gate-live.ts"),
    read("lib/owner-auth.ts"),
  ]);
  assert.match(worker, /return handler\.fetch\(request, env, ctx\)/);
  assert.match(worker, /url\.pathname === "\/api\/history" && request\.method === "GET"/);
  assert.match(worker, /url\.pathname === "\/api\/candles" && request\.method === "GET"/);
  assert.match(worker, /GATE_USDT_FUTURES/);
  assert.match(worker, /\["1m", "15m", "1h"\]\.includes\(interval\)/);
  assert.match(worker, /SELECT chart_cache_json AS chartCache,chart_cache_at AS chartCacheAt FROM system_settings/);
  assert.match(worker, /mirrorChartCandles/);
  assert.match(worker, /actual candles warming/);
  assert.match(worker, /serving last actual candles/);
  assert.match(worker, /FROM paper_positions/);
  assert.match(worker, /url\.pathname === "\/api\/auth\/login" && request\.method === "POST"/);
  assert.match(worker, /url\.pathname === "\/api\/live\/mode" && request\.method === "POST"/);
  assert.match(worker, /url\.pathname === "\/api\/live\/credentials" && \["GET", "PUT", "DELETE"\]\.includes\(request\.method\)/);
  assert.match(worker, /encryptGateCredentials/);
  assert.match(worker, /Gate 仍有持仓或挂单；请先清空后再删除 API/);
  assert.match(worker, /DELETE FROM live_exchange_credentials WHERE id=1/);
  assert.match(worker, /tag\.startsWith\("t-ms-e-"\) && !knownTags\.has\(tag\)/);
  assert.ok(worker.indexOf("const staged:") < worker.indexOf("await client.setLeverage"));
  assert.match(worker, /await this\.syncLive\(Date\.now\(\), false, true\)/);
  assert.match(worker, /if \(!await ownerAuthenticated\(request, env\)\) return json\(\{ error: "请先登录" \}, 401\)/);
  assert.match(worker, /sameOriginMutation\(request\)/);
  assert.match(worker, /const \{ outbox, live, \.\.\.publicRuntime \} = this\.runtime/);
  assert.match(worker, /\["SUBMITTING", "OPEN"\]\.includes\(entry\.status\).*entry\.plannedRisk/s);
  assert.match(worker, /prior\.planId === plan\.id && prior\.status !== "CANCELLED"/);
  assert.match(worker, /availableForNewEntries - intent\.margin/);
  assert.match(live, /\/futures\/usdt\/price_orders/);
  assert.match(live, /\/futures\/usdt\/orders/);
  assert.match(live, /reduce_only: true/);
  assert.match(live, /PORTFOLIO_RISK_CAP/);
  assert.match(live, /credentials\.environment !== "live"/);
  assert.match(auth, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(page, /setInterval\(read, 15_000\)/);
  assert.match(page, /RUNTIME_REQUEST_TIMEOUT_MS = 30_000/);
  assert.match(page, /RUNTIME_DISPLAY_TTL_MS = 90_000/);
  assert.doesNotMatch(page, /responseFresh && !error/);
  assert.match(page, /authorityOperational && evidence\?\.fresh && evidence\?\.ancillaryFresh/);
  assert.match(page, /合约名义价值/);
  assert.match(page, /模拟杠杆/);
  assert.match(page, /预计保证金/);
  assert.match(page, /window\.scrollTo\(0, 0\)/);
  assert.match(css, /position:fixed!important/);
  assert.match(page, /const intent = plan\?\.state === "PREPARED" \? plan : decision/);
  assert.match(page, /AbortController/);
  assert.match(page, /document\.hidden/);
  assert.match(page, /系统现在的决定/);
  assert.match(page, /模拟账户权益/);
  assert.match(page, /\{tab === "brain" && <>\s*<section className="brain-hero">/);
  assert.ok(page.indexOf('{tab === "brain" && <>') < page.indexOf('模拟账户权益'));
  assert.ok(page.indexOf('</>}\n\n    <nav className="tabs">') > page.indexOf('模拟账户权益'));
  assert.match(page, /当前持仓浮盈亏/);
  assert.match(page, /组合风险预算/);
  assert.match(page, /准备进场/);
  assert.match(page, /判断错误就退出/);
  assert.match(page, /为什么.*进场|距离触发价|上下流动性优势不足/);
  assert.match(page, /所有者登录/);
  assert.match(page, /确认开启实盘/);
  assert.match(page, /实盘交易开关/);
  assert.match(page, /实盘账户/);
  assert.match(page, /实盘订单/);
  assert.match(page, /API 管理/);
  assert.match(page, /撤销系统遗留挂单/);
  assert.match(page, /function CandleChart/);
  assert.match(page, /loadedInterval === interval \? candles\.slice\(-72\) : \[\]/);
  assert.match(page, /Gate USDT 合约 · 已收盘数据/);
  assert.match(page, /1分钟.*15分钟.*1小时/s);
  assert.match(page, /Gate 价格触发/);
  assert.match(page, /Gate 限价/);
  assert.match(page, /authorityOperational && evidence\?\.fresh && evidence\?\.ancillaryFresh/);
  assert.match(page, /订单.*实盘.*历史.*设置/s);
  assert.doesNotMatch(layout, /requireChatGPTUser|redirect|signin-with-chatgpt/);
  assert.equal(await read("app/chatgpt-auth.ts").then(() => false, () => true), true);
  assert.equal(await read("lib/auth-paths.ts").then(() => false, () => true), true);
  assert.equal((workflow.match(/grep -Fq '流动性三态'/g) ?? []).length, 2);
  assert.equal((workflow.match(/WORKER_BASE_URL\/api\/history/g) ?? []).length, 2);
  assert.equal((workflow.match(/WORKER_BASE_URL\/api\/candles\?symbol=BTC_USDT&interval=15m/g) ?? []).length, 2);
  assert.equal((workflow.match(/WORKER_BASE_URL\/api\/live\/credentials/g) ?? []).length, 2);
  assert.equal((workflow.match(/for attempt in 1 2 3 4 5 6/g) ?? []).length, 2);
});

test("at-least-once alarm and independent feed recovery are explicit", async () => {
  const worker = await read("worker/index-clean.ts");
  assert.match(worker, /lastProcessedSlot/);
  assert.match(worker, /Math\.floor\(now \/ LOOP_MS\)/);
  assert.ok(worker.indexOf("slot <= this.runtime.lastProcessedSlot") < worker.indexOf("setAlarm(prearmed)"));
  assert.match(worker, /\[2_000, 4_000, 8_000, 16_000, 30_000\]/);
  assert.match(worker, /GatePublicError/);
  assert.match(worker, /alarm < Date\.now\(\) - 6_000/);
  assert.ok(worker.indexOf("setAlarm(next)") < worker.indexOf("saveCheckpoint(now)"));
  assert.match(worker, /this\.processBooks\(now, cycleSymbols\)/);
  assert.doesNotMatch(worker, /this\.processBooks\(slot \* LOOP_MS/);
  assert.match(worker, /usableSnapshot\(snapshot, Math\.max\(now, Date\.now\(\)\)/);
});

test("DO is PAPER authority while D1 is a bounded outbox mirror", async () => {
  const worker = await read("worker/index-clean.ts");
  assert.doesNotMatch(worker, /loadEquity|hydrateOpenPositions/);
  assert.match(worker, /if \(criticalChanged \|\| openedThisCycle\)/);
  assert.ok(worker.indexOf("saveCheckpoint(now, true)") < worker.indexOf("await this.drainOutbox(now)"));
  assert.match(worker, /const booksPromise = this\.processBooks/);
  assert.ok(worker.indexOf("await fetchActiveContracts()") < worker.indexOf("const booksPromise = this.processBooks"));
  assert.match(worker, /runtimeCache.*expiresAt/s);
  assert.match(worker, /this\.runtime\.d1Writes \+ billedWrites > 4_800/);
});

test("cutover is credential-bound and removes legacy DOs only after v6 health", async () => {
  const workflow = await read(".github/workflows/sentinel-v2-ci.yml");
  assert.match(workflow, /id,exchange,environment,ciphertext,iv,crypto_version,key_hint,gate_user_id,owner_account_id,permission_summary_json,status,last_verified_at,last_error,created_at,updated_at/);
  assert.match(workflow, /index\.prepare\.js/);
  assert.match(workflow, /class RetiredDurableObject extends DurableObject/);
  assert.ok(workflow.indexOf("index.prepare.js") < workflow.indexOf("Deploy v6 prepare config"));
  assert.match(workflow, /for attempt in 1 2 3 4 5/);
  assert.match(workflow, /valid non-zero inventory result is authoritative/);
  assert.match(workflow, /wrangler\.compat-preflight\.json/);
  assert.match(workflow, /index\.cutover-preview\.js/);
  assert.match(workflow, /export class MarketStream extends DurableObject/);
  assert.match(workflow, /WORKER_BASE_URL\/api\/live\/preflight/);
  assert.match(workflow, /\.durable_objects == null/);
  assert.match(workflow, /tag: "v6-liquidity-three-state"/);
  assert.equal((workflow.match(/rules: \.rules/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /versions upload|CUTOVER_AUDIT_PREVIEW|CUTOVER_PREFLIGHT_URL/);
  assert.ok(workflow.indexOf("wrangler.compat-preflight.json") < workflow.indexOf("Require two fresh read-only Gate"));
  assert.ok(workflow.indexOf("Require two fresh read-only Gate") < workflow.indexOf("Deploy v6 prepare config"));
  assert.match(workflow, /phase" == "audit"/);
  assert.doesNotMatch(workflow, /Generate masked TTL token and deploy trusted read-only preflight/);
  assert.ok(workflow.indexOf("wrangler.prepare.json") < workflow.indexOf("Deploy reviewed final v7"));
  assert.ok(workflow.indexOf("Require continuously advancing v6 health") < workflow.indexOf("Deploy reviewed final v7"));
  assert.ok(workflow.indexOf("Recheck Gate twice") < workflow.indexOf("Deploy reviewed final v7"));
  assert.ok(workflow.indexOf("Deploy reviewed final v7") < workflow.indexOf("0033 D1 purge last"));
  assert.match(workflow, /tables_csv/);
});
