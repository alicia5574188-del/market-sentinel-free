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
  assert.match(gate, /GATE_PUBLIC_TIMEOUT_MS = 2_000/);
  assert.match(gate, /GATE_BULK_TICKER_TIMEOUT_MS = 4_000/);
  assert.match(gate, /gatePublic<GateTicker\[\]>\("\/futures\/usdt\/tickers", GATE_BULK_TICKER_TIMEOUT_MS\)/);
  assert.match(gate, /\/futures\/usdt\/candlesticks/);
  assert.doesNotMatch(worker + gate, /new WebSocket|futures\.order_book_update/);
  assert.match(worker, /MAX_ANCILLARY_CONCURRENCY = 2/);
  assert.match(worker, /plannedTotalDoRequestsPerDay: 50_400/);
  assert.match(worker, /plannedDoWritesPerDay: 54_080/);
  assert.match(worker, /NON_ALARM_WRITE_CAP = 8_000/);
  assert.match(worker, /plannedMaxD1BilledWritesPerDay: 4_800/);
  assert.match(worker, /RADAR_MS = 10_000/);
  assert.match(worker, /await fetchMarketTickers\(\)/);
  assert.match(worker, /stableCandidates/);
  const alarm = worker.slice(worker.indexOf("async alarm("), worker.indexOf("async fetch(request"));
  assert.ok(alarm.indexOf("processBooks") < alarm.indexOf("fetchMarketTickers"), "position books must run before the bulk radar");
  assert.ok(alarm.indexOf("syncLive") < alarm.indexOf("fetchMarketTickers"), "LIVE reconciliation must run before the bulk radar");
  assert.doesNotMatch(alarm, /lastError = `radar:/, "a radar timeout must not become a global execution fault");
  assert.doesNotMatch(alarm, /successes !== this\.runtime\.symbols\.length \? "DEGRADED"/, "partial candidate-book loss must not degrade the whole authority");
  assert.match(worker, /successes === 0 \? `\$\{this\.runtime\.symbols\.length\} market snapshots unavailable/);
  assert.match(worker, /completedCandleStrategyCandidate/);
  assert.match(worker, /residentCandleCandidate/);
  assert.doesNotMatch(worker, /alignedFlow: eventAlignedFlow/);
  assert.doesNotMatch(worker, /if \(!radarCandidateExecutionAllowed\(this\.runtime\.radar\.lastScanAt, now\)\) return/);
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

test("owner-authenticated live API stays isolated while the strategy arena UI is explicit", async () => {
  const [worker, page, layout, css, live, auth, positionMetrics] = await Promise.all([
    read("worker/index-clean.ts"), read("app/page.tsx"), read("app/layout.tsx"), read("app/globals.css"),
    read("lib/gate-live.ts"), read("lib/owner-auth.ts"), read("lib/position-metrics.ts"),
  ]);
  assert.match(worker, /return handler\.fetch\(request, env, ctx\)/);
  assert.match(worker, /url\.pathname === "\/api\/auth\/login" && request\.method === "POST"/);
  assert.match(worker, /url\.pathname === "\/api\/live\/mode" && request\.method === "POST"/);
  assert.match(worker, /url\.pathname === "\/api\/live\/credentials"/);
  assert.match(worker, /encryptGateCredentials/);
  assert.match(worker, /sameOriginMutation\(request\)/);
  assert.match(worker, /if \(!await ownerAuthenticated\(request, env\)\) return json\(\{ error: "请先登录" \}, 401\)/);
  assert.match(worker, /strategyArena: arenaSummary\(strategyArena\)/);
  assert.match(worker, /requestedEnabled: false, operational: false/);
  assert.match(live, /reduce_only: true/);
  assert.match(live, /credentials\.environment !== "live"/);
  assert.match(auth, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(page, /setInterval\(read, 15_000\)/);
  assert.match(page, /RUNTIME_REQUEST_TIMEOUT_MS = 30_000/);
  assert.match(page, /RUNTIME_DISPLAY_TTL_MS = 90_000/);
  assert.match(page, /tabScroll\.current\[tab\] = window\.scrollY/);
  assert.match(page, /viewScroll\.current\[view\] = window\.scrollY/);
  assert.match(page, /市场状态竞技场/);
  assert.match(page, /48个策略单元/);
  assert.match(page, /不依赖高频异动、逐笔成交或持仓量数据/);
  assert.match(page, /有效影子/);
  assert.match(page, /观察影子/);
  assert.match(page, /1000 U模拟账户交易记录/);
  assert.match(page, /唯一模拟合约账户/);
  assert.match(page, /开启实盘复制/);
  assert.doesNotMatch(page, /双模拟账本|独立策略模拟/);
  assert.doesNotMatch(page, /组合风险预算|目标 \+150 U|双向反应实验 V1|盈利与亏损研究|旧方案归档|账户日志/);
  assert.doesNotMatch(page, /fetch\("\/api\/history|fetch\("\/api\/account-logs/);
  assert.match(page, /所有者登录/);
  assert.match(page, /实盘交易开关/);
  assert.match(page, /撤销系统遗留挂单/);
  assert.match(page, /实盘账户/);
  assert.match(page, /实盘订单/);
  assert.match(page, /API 管理/);
  assert.match(page, /AbortController/);
  assert.match(page, /document\.hidden/);
  assert.match(css, /position:fixed!important/);
  assert.match(css, /strategy-grid/);
  assert.match(positionMetrics, /export function unrealizedPnl/);
  assert.match(positionMetrics, /export function marginReturnRate/);
  assert.doesNotMatch(layout, /requireChatGPTUser|redirect|signin-with-chatgpt/);
  assert.equal(await read("app/chatgpt-auth.ts").then(() => false, () => true), true);
  assert.equal(await read("lib/auth-paths.ts").then(() => false, () => true), true);
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
  assert.match(worker, /Promise\.all\(\[this\.processBooks\(now, cycleSymbols\), this\.updateAncillary\(now\)\]\)/);
  assert.match(worker, /this\.priorityMinuteSymbols\(now\)\.length[\s\S]*await this\.updateAncillary\(now\);[\s\S]*await this\.processBooks\(now, cycleSymbols\)/);
  assert.ok(worker.indexOf("await fetchActiveContracts()") < worker.indexOf("let books:"));
  assert.match(worker, /runtimeCache.*expiresAt/s);
  assert.match(worker, /this\.runtime\.d1Writes \+ billedWrites > 4_800/);
  assert.doesNotMatch(worker, /review-entry:|review-exit:/);
  assert.match(worker, /ORDER_CLOSE_DIAGNOSTIC/);
  assert.match(worker, /FROM paper_events WHERE event_type='PAPER_BANKRUPTCY'/);
  assert.match(worker, /event_type='ORDER_CLOSE_DIAGNOSTIC'[\s\S]*observed_at>=\? AND observed_at<=\?/);
  assert.match(worker, /completeTrades\.length > item\.report\.trades\.length/);
});

test("V4 adaptive shadow arena is bounded, cost-aware, and is the sole LIVE order source", async () => {
  const [arena, regime, worker, page, migration] = await Promise.all([
    read("lib/strategy-arena.ts"), read("lib/market-regime.ts"), read("worker/index-clean.ts"), read("app/page.tsx"),
    read("drizzle/0035_strategy_arena_fresh_start.sql"),
  ]);
  assert.match(arena, /STRATEGY_CATALOG/);
  assert.match(arena, /PROMOTION_WIN_STREAK = 3/);
  assert.match(arena, /PROMOTION_RECENT_WINDOW = 6/);
  assert.match(arena, /PAPER_DEMOTION_LOSSES = 3/);
  assert.match(arena, /ARENA_FRICTION_RATE = 0\.0014/);
  assert.match(arena, /ARENA_MAX_COST_SHARE = 0\.25/);
  assert.match(arena, /PORTFOLIO_REALTIME_CAPACITY = 10/);
  assert.match(arena, /recentObservations/);
  assert.match(arena, /cutoverPending/);
  assert.match(arena, /sizePaperPosition/);
  assert.match(arena, /selectSafeLeverage/);
  assert.match(arena, /contracts/);
  assert.match(arena, /quantoMultiplier/);
  assert.match(arena, /ARENA_MAX_OPEN = 240/);
  assert.match(arena, /ARENA_HISTORY_LIMIT = 240/);
  assert.match(arena, /MIN_PORTFOLIO_TRADE_RISK_USDT = 10/);
  assert.match(arena, /EMPIRICAL_COST/);
  assert.match(arena, /seenSignals\.length > 2_000/);
  assert.match(regime, /MARKET_REGIME_MIN_SAMPLES = 18/);
  assert.match(regime, /selectDiverseMarketPool/);
  assert.doesNotMatch(arena, /fetch\(|DB\.prepare|D1Database|GateLiveClient|reconcilePaper/);
  assert.match(worker, /const decision: Decision \| null = null/);
  assert.match(worker, /allowOpen: false/);
  assert.match(worker, /observeStrategyArena/);
  assert.match(worker, /advanceStrategyArena/);
  assert.match(worker, /desiredPortfolio = this\.runtime\.strategyArena\.portfolioOpen/);
  assert.match(worker, /eligibleForLiveMirror/);
  assert.match(worker, /mirrorNotionalFraction: trade\.notional \/ Math\.max\(trade\.accountEquityAtOpen/);
  assert.match(worker, /strategyArena: normalizeStrategyArena\(saved\.strategyArena\)/);
  assert.match(worker, /resetStrategyArenaAccount/);
  assert.match(page, /每个执行变体独立使用24小时最新/);
  assert.match(page, /观察影子/);
  assert.match(page, /动态风险/);
  assert.match(page, /重置1000 U模拟资金/);
  assert.match(worker, /SCAN_UNIVERSE_SIZE = 30/);
  assert.match(worker, /maxOpenPositions: null/);
  assert.match(migration, /DELETE FROM `paper_events`/);
  assert.match(migration, /DELETE FROM `paper_positions`/);
  assert.match(migration, /DELETE FROM `paper_plans`/);
  assert.doesNotMatch(migration, /live_exchange_credentials/);
});

test("legacy sizing and portfolio mirroring both retain bounded account risk", async () => {
  const [core, live] = await Promise.all([read("lib/liquidity-core.ts"), read("lib/gate-live.ts")]);
  assert.match(core, /MIN_SINGLE_TRADE_RISK_RATE = 0\.01/);
  assert.match(core, /MAX_SINGLE_TRADE_RISK_RATE = 0\.02/);
  assert.match(core, /PORTFOLIO_RISK_CAP = 0\.10/);
  assert.match(core, /CORRELATED_DIRECTION_RISK_CAP = 0\.065/);
  assert.match(core, /DYNAMIC_PROTECTION_MIN_CONFIRMED_R = 1\.5/);
  assert.match(core, /DYNAMIC_PROTECTION_MIN_TARGET_PROGRESS = 0\.70/);
  assert.match(core, /MAX_NOTIONAL_TO_EQUITY = 4/);
  assert.match(core, /MIN_NET_TARGET_RETURN_ON_EQUITY = 0\.002/);
  assert.match(core, /Math\.min\(riskSizedNotional, input\.equity \* MAX_NOTIONAL_TO_EQUITY\)/);
  assert.match(live, /sizePaperPosition\(/);
  assert.match(live, /tradeEconomics\(/);
  assert.match(live, /mirrorNotionalFraction/);
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
