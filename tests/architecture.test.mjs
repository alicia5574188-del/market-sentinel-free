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
  assert.match(worker, /RADAR_MS = 10_000/);
  assert.match(worker, /await fetchMarketTickers\(\)/);
  assert.match(worker, /radar\.candidates/);
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
  const [worker, page, layout, workflow, css, live, auth, positionMetrics] = await Promise.all([
    read("worker/index-clean.ts"),
    read("app/page.tsx"),
    read("app/layout.tsx"),
    read(".github/workflows/sentinel-v2-ci.yml"),
    read("app/globals.css"),
    read("lib/gate-live.ts"),
    read("lib/owner-auth.ts"),
    read("lib/position-metrics.ts"),
  ]);
  assert.match(worker, /return handler\.fetch\(request, env, ctx\)/);
  assert.match(worker, /url\.pathname === "\/api\/history" && request\.method === "GET"/);
  assert.match(worker, /url\.pathname === "\/api\/account-logs" && request\.method === "GET"/);
  assert.doesNotMatch(worker, /\/api\/order-chart|\/api\/candles/);
  assert.doesNotMatch(worker, /fetchReviewCandles|mirrorChartCandles|chart_cache_json/);
  assert.match(worker, /FROM paper_positions/);
  assert.doesNotMatch(worker, /ORDER_ENTRY_CHART|ORDER_EXIT_CHART|review-entry:|review-exit:/);
  assert.match(worker, /fees_and_slippage AS feesAndSlippage/);
  assert.match(worker, /url\.pathname === "\/api\/auth\/login" && request\.method === "POST"/);
  assert.match(worker, /url\.pathname === "\/api\/live\/mode" && request\.method === "POST"/);
  assert.match(worker, /url\.pathname === "\/api\/live\/credentials" && \["GET", "PUT", "DELETE"\]\.includes\(request\.method\)/);
  assert.match(worker, /url\.pathname === "\/api\/paper\/reset" && request\.method === "POST"/);
  assert.match(worker, /url\.pathname === "\/api\/paper\/history\/clear" && request\.method === "POST"/);
  assert.match(worker, /body\.confirm !== expected/);
  assert.match(worker, /encryptGateCredentials/);
  assert.match(worker, /Gate 仍有持仓或挂单；请先清空后再删除 API/);
  assert.match(worker, /DELETE FROM live_exchange_credentials WHERE id=1/);
  assert.match(worker, /tag\.startsWith\("t-ms-e-"\) && !knownTags\.has\(tag\)/);
  assert.ok(worker.indexOf("const staged:") < worker.indexOf("await client.setLeverage"));
  assert.match(worker, /await this\.syncLive\(Date\.now\(\), false, true\)/);
  assert.match(worker, /if \(!await ownerAuthenticated\(request, env\)\) return json\(\{ error: "请先登录" \}, 401\)/);
  assert.match(worker, /sameOriginMutation\(request\)/);
  assert.match(worker, /const \{ outbox, live, paperCycle, bankruptcyOutbox, rejectionAudit, reactionLab, outcomeResearch, \.\.\.publicRuntime \} = this\.runtime/);
  assert.match(worker, /paperCycleSummary\(paperCycle, this\.authorityView\.equity\)/);
  assert.match(worker, /PAPER_CYCLE_BANKRUPTCY/);
  assert.match(worker, /PAPER_BANKRUPTCY/);
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
  assert.match(page, /tabScroll\.current\[tab\] = window\.scrollY/);
  assert.match(page, /window\.scrollTo\(\{ top: tabScroll\.current\[tab\]/);
  assert.match(page, /viewScroll\.current\[view\] = window\.scrollY/);
  assert.match(page, /hidden=\{tab !== "live"\}/);
  assert.doesNotMatch(page, /className="mode-switch"/);
  assert.match(page, /if \(tab !== "history"\) return/);
  assert.match(page, /setInterval\(\(\) => void readHistory\(!loadedAll\), 60_000\)/);
  assert.doesNotMatch(page, /function OrderReviewChart|\/api\/order-chart|蜡烛图/);
  assert.match(worker, /nextCursor/);
  assert.match(page, /runtime\.limits\.warmupSnapshots \?\? 4/);
  assert.doesNotMatch(page, /warmup < 30|30 - evidence\.warmup/);
  assert.match(page, /账户日志/);
  assert.match(page, /复制完整诊断/);
  assert.match(page, /权益达到 300 U 时/);
  assert.match(page, /num\(item\.entryPrice, 5\)/);
  assert.match(page, /num\(item\.exitPrice, 5\)/);
  assert.match(page, /recentClosedPositions/);
  assert.match(page, /当前持仓/);
  assert.match(page, /刚刚结束/);
  assert.match(css, /position:fixed!important/);
  assert.match(page, /const intent = positionIntent \?\? \(plan\?\.state === "PREPARED" \? plan : decision\)/);
  assert.match(page, /旧版即时保本止损/);
  assert.match(page, /软失效观察/);
  assert.match(page, /AbortController/);
  assert.match(page, /document\.hidden/);
  assert.match(page, /双向反应实验 V1/);
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
  assert.match(page, /安全登录有效30天/);
  assert.match(worker, /authSession[\s\S]*Set-Cookie[\s\S]*ownerSessionCookie/);
  assert.match(page, /研究版禁止开启/);
  assert.match(page, /实盘交易开关/);
  assert.match(page, /重置模拟账户/);
  assert.match(page, /清除模拟历史/);
  assert.match(page, /只影响 PAPER 模拟系统/);
  assert.match(page, /实盘账户/);
  assert.match(page, /实盘订单/);
  assert.match(page, /API 管理/);
  assert.match(page, /撤销系统遗留挂单/);
  assert.match(worker, /cancelAndConfirmSystemEntries/);
  assert.match(worker, /Gate 仍有 \$\{remaining\.length\} 张系统挂单未撤销/);
  assert.match(worker, /error instanceof LiveEntrySizingError/);
  assert.match(worker, /entrySkips/);
  assert.match(live, /function parseGateJson/);
  assert.match(live, /Math\.max\(1, Math\.floor\(sized\.notional \/ contractNotional\)\)/);
  assert.match(page, /旧计划未成交/);
  assert.match(live, /expiration: GATE_TRIGGER_DAY_SECONDS/);
  assert.match(live, /expiration: GATE_TRIGGER_DAY_SECONDS \* GATE_TRIGGER_MAX_DAYS/);
  assert.doesNotMatch(page, /function CandleChart/);
  assert.doesNotMatch(page, /function PositionLiveChart/);
  assert.match(page, /浮动盈亏/);
  assert.match(page, /保证金收益率/);
  assert.match(page, /查看订单数据/);
  assert.match(page, /实际 R 倍数/);
  assert.match(page, /查看本轮完整订单记录/);
  assert.match(positionMetrics, /export function unrealizedPnl/);
  assert.match(positionMetrics, /export function marginReturnRate/);
  assert.doesNotMatch(css, /\.review-chart|\.position-price-line/);
  assert.doesNotMatch(page, /loadedInterval === interval \? candles\.slice\(-72\) : \[\]/);
  assert.match(page, /分段流动性路线/);
  assert.match(page, /多个方案观察，单一方案执行/);
  assert.match(page, /软计划不占保证金/);
  assert.match(worker, /aggregateFourHourCandles/);
  assert.match(worker, /activeRoutes/);
  assert.match(worker, /justTriggeredEntry/);
  assert.match(worker, /realtimeEntryConfirmed/);
  assert.match(live, /PORTFOLIO_MARGIN_CAP/);
  assert.match(live, /openMargin/);
  assert.match(page, /实时 IOC/);
  assert.match(page, /双向实验只记录影子结果/);
  assert.match(page, /authorityOperational && evidence\?\.fresh && evidence\?\.ancillaryFresh/);
  assert.match(page, /订单.*实盘.*复盘.*设置/s);
  assert.doesNotMatch(layout, /requireChatGPTUser|redirect|signin-with-chatgpt/);
  assert.equal(await read("app/chatgpt-auth.ts").then(() => false, () => true), true);
  assert.equal(await read("lib/auth-paths.ts").then(() => false, () => true), true);
  assert.equal((workflow.match(/grep -Fq '资金异动雷达'/g) ?? []).length, 2);
  assert.equal((workflow.match(/WORKER_BASE_URL\/api\/history/g) ?? []).length, 2);
  assert.equal((workflow.match(/WORKER_BASE_URL\/api\/account-logs/g) ?? []).length, 2);
  assert.equal((workflow.match(/WORKER_BASE_URL\/api\/candles/g) ?? []).length, 0);
  assert.equal((workflow.match(/WORKER_BASE_URL\/api\/live\/credentials/g) ?? []).length, 2);
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

test("rejected entry audit is bounded, observational and reuses the bulk ticker path", async () => {
  const [audit, worker] = await Promise.all([read("lib/rejection-audit.ts"), read("worker/index-clean.ts")]);
  assert.match(audit, /REJECTION_AUDIT_HORIZON_MS = 20 \* 60_000/);
  assert.match(audit, /MAX_PENDING_REJECTION_AUDITS = 120/);
  assert.match(audit, /MAX_RECENT_REJECTION_AUDITS = 200/);
  assert.match(audit, /MAX_REJECTION_RULE_COMBINATIONS = 64/);
  assert.match(worker, /quotes: Object\.fromEntries\(rows\.map/);
  assert.match(worker, /primaryRules: rejectionAudit\.primaryRules \?\? \{\}/);
  assert.match(worker, /isolatedRules: rejectionAudit\.isolatedRules \?\? \{\}/);
  assert.match(worker, /combinations: rejectionAudit\.combinations \?\? \{\}/);
  assert.match(worker, /recent: rejectionAudit\.recent\.slice\(-20\)\.reverse\(\)/);
  assert.doesNotMatch(worker, /advanceRejectionAudit|recordRejectedCandidate/);
  assert.doesNotMatch(audit, /fetch\(|DB\.prepare|D1Database|GateLiveClient/);
});

test("paired reaction lab is bounded, non-executable and keeps no-trade controls", async () => {
  const [lab, worker, page] = await Promise.all([read("lib/reaction-lab.ts"), read("worker/index-clean.ts"), read("app/page.tsx")]);
  assert.match(lab, /REACTION_OBSERVATION_MS = 3 \* 60_000/);
  assert.match(lab, /MAX_ACTIVE_REACTIONS = 36/);
  assert.match(lab, /"CONTINUATION" \| "REVERSAL"/);
  assert.match(lab, /"NO_TRIGGER"/);
  assert.doesNotMatch(lab, /fetch\(|DB\.prepare|D1Database|GateLiveClient|reconcilePaper/);
  assert.match(worker, /const decision: Decision \| null = null/);
  assert.match(worker, /allowOpen: false/);
  assert.match(worker, /if \(body\.enabled\) return json\(\{ ok: false, error: "双向实验仍是影子研究，实盘新开仓已锁定"/);
  assert.match(worker, /advanceReactionLab/);
  assert.match(page, /只记影子结果，不产生新 PAPER \/ LIVE 订单/);
  assert.match(page, /旧单向方案审计（已归档）/);
});

test("win/loss research freezes pre-outcome features and cannot execute", async () => {
  const [research, lab, worker, page] = await Promise.all([read("lib/outcome-research.ts"), read("lib/reaction-lab.ts"),
    read("worker/index-clean.ts"), read("app/page.tsx")]);
  assert.match(research, /OUTCOME_DISCOVERY_SAMPLES = 100/);
  assert.match(research, /MAX_OUTCOME_PROCESSED = 512/);
  assert.match(research, /experiment\.featureVersion !== 1/);
  assert.match(research, /"DISCOVERY" as const : "CONFIRMATION" as const/);
  assert.match(research, /function freezeCandidates/);
  assert.match(research, /candidateGroupIds/);
  assert.doesNotMatch(research, /fetch\(|DB\.prepare|D1Database|GateLiveClient|reconcilePaper/);
  assert.match(lab, /triggerRetraceRatio: retraceRatio/);
  assert.match(lab, /triggerAlignedFlow: alignedFlow/);
  assert.match(worker, /ingestReactionOutcomes/);
  assert.match(page, /盈利 \/ 亏损归因研究/);
  assert.match(page, /不下单，也不会自动修改策略/);
});

test("PAPER and LIVE share bounded sizing and meaningful net-profit economics", async () => {
  const [core, live] = await Promise.all([read("lib/liquidity-core.ts"), read("lib/gate-live.ts")]);
  assert.match(core, /MIN_SINGLE_TRADE_RISK_RATE = 0\.005/);
  assert.match(core, /MAX_SINGLE_TRADE_RISK_RATE = 0\.01/);
  assert.match(core, /PORTFOLIO_RISK_CAP = 0\.10/);
  assert.match(core, /CORRELATED_DIRECTION_RISK_CAP = 0\.065/);
  assert.match(core, /DYNAMIC_PROTECTION_MIN_CONFIRMED_R = 1\.5/);
  assert.match(core, /DYNAMIC_PROTECTION_MIN_TARGET_PROGRESS = 0\.70/);
  assert.match(core, /MAX_NOTIONAL_TO_EQUITY = 4/);
  assert.match(core, /MIN_NET_TARGET_RETURN_ON_EQUITY = 0\.002/);
  assert.match(core, /Math\.min\(riskSizedNotional, input\.equity \* MAX_NOTIONAL_TO_EQUITY\)/);
  assert.match(live, /sizePaperPosition\(/);
  assert.match(live, /tradeEconomics\(/);
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
