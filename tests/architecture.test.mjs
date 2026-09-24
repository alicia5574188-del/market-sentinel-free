import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("runtime uses bounded Gate stream snapshots with independent futures REST fallback", async () => {
  const [worker, gate, stream] = await Promise.all([read("worker/index-clean.ts"), read("lib/gate-market.ts"),read("lib/gate-stream.ts")]);
  assert.match(gate, /\/futures\/usdt\/order_book/);
  assert.match(gate, /with_id=true/);
  assert.match(gate, /\/futures\/usdt\/liq_orders/);
  assert.match(gate, /\/futures\/usdt\/contract_stats/);
  assert.doesNotMatch(gate, /liq_orders\?status=/);
  assert.match(gate, /X-Gate-Size-Decimal/);
  assert.match(gate, /volume_24h_settle/);
  assert.match(gate, /GATE_PUBLIC_TIMEOUT_MS = 2_000/);
  assert.match(gate, /GATE_BULK_TICKER_TIMEOUT_MS = 4_000/);
  assert.match(gate, /gatePublic<GateTicker\[\]>\("\/futures\/usdt\/tickers", GATE_BULK_TICKER_TIMEOUT_MS, 2\)/);
  assert.match(gate, /\/futures\/usdt\/candlesticks/);
  assert.doesNotMatch(stream, /futures\.order_book_update|setInterval/);
  assert.match(stream,/clearTimeout\(timer\)/);
  assert.match(stream,/futures\.order_book/);
  assert.match(stream,/message\.event===\"all\"/);
  assert.match(stream,/row\.w!==true/);
  assert.match(worker,/streamBook\(symbol\)/);
  assert.match(worker, /MAX_ANCILLARY_CONCURRENCY = 2/);
  assert.match(worker, /plannedTotalDoRequestsPerDay: 53_280/);
  assert.match(worker, /plannedDoWritesPerDay: PRIMARY_PLANNED_DO_ROWS/);
  assert.match(worker, /twoMemberReservedDoRowsPerDay: TWO_MEMBER_PLANNED_DO_ROWS/);
  assert.match(worker, /capacityCertified: false/);
  assert.match(worker, /NON_ALARM_WRITE_CAP = 8_000/);
  assert.match(worker, /plannedMaxD1BilledWritesPerDay: 4_800/);
  assert.match(worker, /RADAR_MS = 60_000/);
  assert.match(worker, /await fetchMarketTickers\(\)/);
  assert.match(worker, /stableCandidates/);
  const alarm = worker.slice(worker.indexOf("async alarm("), worker.indexOf("async fetch(request"));
  assert.ok(alarm.indexOf("processBooks") < alarm.indexOf("advanceForwardNow(Date.now(),false)"), "fresh books must precede critical forward management");
  assert.ok(alarm.indexOf("advanceForwardNow(Date.now(),false)") < alarm.indexOf("this.launchLiveWork()"), "persisted PAPER exits must precede LIVE dispatch");
  assert.ok(alarm.indexOf("this.launchLiveWork()") < alarm.indexOf("launchOptionalWork"), "LIVE dispatch must start before optional market work is launched");
  assert.doesNotMatch(alarm,/await this\.syncLive\(/,"private exchange latency must not hold the quote clock");
  const optionalStart=worker.indexOf("private launchOptionalWork");
  const optional=worker.slice(optionalStart,worker.indexOf("async alarm(",optionalStart));
  assert.match(optional,/refreshStrategyCandle[\s\S]*advanceForwardNow\(Date\.now\(\),true\)/,
    "only the post-refresh optional path may advance completed-candle AnchorFlow state");
  assert.doesNotMatch(optional,/refreshTurnDaily\(Date\.now\(\)\)/,
    "AnchorFlow direction is derived from retained 5m paths and must not spend optional requests refreshing daily candles");
  assert.doesNotMatch(alarm, /lastError = `radar:/, "a radar timeout must not become a global execution fault");
  assert.doesNotMatch(alarm, /successes !== this\.runtime\.symbols\.length \? "DEGRADED"/, "partial candidate-book loss must not degrade the whole authority");
  assert.doesNotMatch(alarm, /actionableMarkets === 0 \? `\$\{recoveringMarkets\} realtime markets warming/, "a temporarily empty entry-ready set must not become a global error");
  assert.doesNotMatch(worker, /successes === 0 \? `\$\{this\.runtime\.symbols\.length\} market snapshots unavailable/,
    "a failed staggered subset must never impersonate a full resident-pool outage");
  assert.match(worker, /authorityStale[\s\S]*scheduled market snapshots unavailable; executable freshness expired/);
  assert.match(worker, /completedCandleStrategyCandidate/);
  assert.match(worker, /residentCandleCandidate/);
  assert.doesNotMatch(worker, /alignedFlow: eventAlignedFlow/);
  assert.doesNotMatch(worker, /if \(!radarCandidateExecutionAllowed\(this\.runtime\.radar\.lastScanAt, now\)\) return/);
  assert.match(worker, /maxSubrequestsPerAlarm: 32/);
  assert.match(worker, /now - this\.runtime\.lastStopCheckpointAt < 60_000/);
});

test("the original authority and retirement remain unchanged; member namespaces are additive", async () => {
  const config = JSON.parse(await read("wrangler.jsonc"));
  assert.deepEqual(config.durable_objects.bindings, [{ name: "MARKET_STREAM", class_name: "MarketStream" },
    {name:"MEMBERS",class_name:"MemberDirectory"},{name:"MEMBER_EXECUTION",class_name:"MemberExecutor"}]);
  const create = config.migrations[5];
  const retire = config.migrations[6];
  assert.deepEqual(config.migrations[7],{tag:"v8-isolated-member-accounts",new_sqlite_classes:["MemberDirectory","MemberExecutor"]});
  assert.deepEqual(create.new_sqlite_classes, ["MarketStream"]);
  assert.equal(create.deleted_classes, undefined);
  for (const name of ["PositionMonitor", "MarketScanner", "LiveTradingCoordinator", "MarketScannerV2", "HTE31MarketScanner", "HTE31TradeManager", "HistoricalArchive"]) assert.ok(retire.deleted_classes.includes(name));
});

test("native dark LIVE console retains owner authentication and isolates financial authority", async () => {
  const [worker, page, dashboard, consoleUi, ui, layout, css, live, auth] = await Promise.all([
    read("worker/index-clean.ts"), read("app/page.tsx"), read("app/forward-dashboard.tsx"), read("app/live-console.tsx"),
    read("lib/operator-ui.ts"), read("app/layout.tsx"), read("app/forward-dashboard.css"), read("lib/gate-live.ts"), read("lib/owner-auth.ts"),
  ]);
  assert.match(worker, /url\.pathname === "\/api\/auth\/login" && request\.method === "POST"/);
  assert.match(worker, /url\.pathname === "\/api\/live\/mode" && request\.method === "POST"/);
  assert.match(worker, /sameOriginMutation\(request\)/);
  assert.match(worker, /if \(!await ownerAuthenticated\(request, env\)\) return json\(\{ error: "请先登录" \}, 401\)/);
  assert.match(worker, /encryptGateCredentials/);
  assert.match(worker, /desiredPortfolio\s*=\s*this\.liveDesiredPortfolio/);
  assert.match(worker, /allowNewEntries: false/);
  assert.match(live, /reduce_only: true/);
  assert.match(live, /redirect:"manual"/);
  assert.doesNotMatch(live, /redirect:"error"/);
  assert.match(live, /response\.status>=300&&response\.status<400/);
  assert.match(live, /REDIRECT_REJECTED/);
  assert.match(auth, /HttpOnly; Secure; SameSite=Strict/);
  for (const [name, ms] of [["RUNTIME_REQUEST_TIMEOUT_MS","12_000"],["RUNTIME_REFRESH_MS","10_000"],["RUNTIME_RETRY_MS","3_000"]])
    assert.match(page,new RegExp(`${name} = ${ms}`));
  assert.match(page, /window\.addEventListener\("pageshow",\s*resume\)/);
  assert.match(page, /window\.addEventListener\("online",\s*resume\)/);
  assert.match(page, /requestEpoch===epoch\.current/);
  assert.match(page, /setRuntime\(null\)/);
  assert.match(dashboard, /scroll\.current\[tab\]=window\.scrollY/);
  assert.match(dashboard, /\["live","◈","实盘"\]/);
  assert.match(dashboard, /\[liveMounted,setLiveMounted\]=useState\(false\)/,
    "LIVE console must not mount during the initial authenticated render");
  assert.match(dashboard, /if\(next===\"live\"\)setLiveMounted\(true\)/,
    "the first explicit LIVE visit must opt the console into keep-alive mode");
  assert.match(dashboard, /liveMounted&&<div className=\"fr-live-panel-host\" hidden=\{tab!==\"live\"\}[\s\S]*\{livePanel\}/,
    "after the first LIVE visit the console must stay mounted and only be hidden so tab switches preserve its data");
  assert.doesNotMatch(dashboard, /tab===\"live\"&&livePanel/,
    "LIVE tab selection must not remount the console and flash unknown values");
  assert.match(worker, /Cache-Control\",\"no-store, no-cache, must-revalidate, max-age=0\"/,
    "HTML navigation responses must not be reused across deployments with different hashed chunks");
  assert.match(page, /livePanel=\{<LiveConsole/);
  assert.doesNotMatch(page+dashboard+consoleUi, /legacyConsole|onLegacy|fr-return|进入旧账户|window\.(confirm|alert|prompt)|role="dialog"/);
  assert.match(consoleUi, /role="switch"/);
  assert.match(consoleUi, /disabled=\{!canControl/);
  assert.match(consoleUi, /if\(!canControl/);
  assert.match(consoleUi, /setConfirmEnable\(true\)/);
  assert.match(consoleUi, /onClick=\{\(\)=>setMode\(true\)\}/);
  assert.match(consoleUi, /submitting\.current/);
  assert.match(consoleUi, /onLive\(result\.live\)/);
  assert.match(ui, /credentials: "same-origin"/);
  assert.doesNotMatch(ui+page+consoleUi, /localStorage|sessionStorage|console\.log/);
  for(const label of ["实盘账户权益","所有者密码","API 管理","进场时间","出场时间","持仓时长","已平仓实盘记录"])
    assert.ok(consoleUi.includes(label));
  assert.match(consoleUi, /当前模拟账户。按权益比例复制/);
  assert.match(consoleUi, /沿用源单杠杆、保护和退出依据/);
  assert.match(layout, /哨兵 · AnchorFlow/);
  assert.match(layout, /themeColor: "#0b111a"/);
  const fontSizes=[...css.matchAll(/font-size:\s*(\d+)px/g)].map(v=>Number(v[1]));
  assert.ok(fontSizes.length>40&&Math.min(...fontSizes)>=14);
  assert.match(css, /grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(css, /\.fr-form input\{[^}]*font-size:17px/);
  assert.doesNotMatch(page, /\/api\/paper\/reset|\/api\/history|\/api\/account-logs/);
  assert.doesNotMatch(layout, /requireChatGPTUser|signin-with-chatgpt/);
});

test("at-least-once alarm and independent feed recovery are explicit", async () => {
  const worker = await read("worker/index-clean.ts");
  assert.match(worker, /lastProcessedSlot/);
  assert.match(worker, /Math\.floor\(now \/ LOOP_MS\)/);
  assert.ok(worker.indexOf("slot <= this.runtime.lastProcessedSlot") < worker.indexOf("setAlarm(prearmed)"));
  assert.match(worker, /\[2_000, 4_000, 8_000, 16_000, 30_000\]/);
  assert.match(worker, /GatePublicError/);
  assert.match(worker, /alarm < Date\.now\(\) - 6_000/);
  assert.ok(worker.indexOf("setAlarm(prearmed)") < worker.indexOf("saveCheckpoint(finishedAt)"));
  assert.match(worker, /this\.processBooks\(now, cycleSymbols\)/);
  assert.doesNotMatch(worker, /this\.processBooks\(slot \* LOOP_MS/);
  assert.match(worker, /usableSnapshot\(snapshot, Math\.max\(now, Date\.now\(\)\)/);
});

test("DO is PAPER authority while D1 is a bounded outbox mirror", async () => {
  const worker = await read("worker/index-clean.ts");
  assert.doesNotMatch(worker, /loadEquity|hydrateOpenPositions/);
  assert.match(worker, /if \(criticalChanged \|\| openedThisCycle\)/);
  assert.ok(worker.indexOf("saveCheckpoint(now, true)") < worker.indexOf("await this.drainOutbox(now)"));
  assert.match(worker, /const books = await this\.processBooks\(now, cycleSymbols\)/);
  assert.ok(worker.indexOf("this.publishCriticalHealth(Date.now(), books)") < worker.indexOf("this.launchOptionalWork(now, universeDue)"));
  assert.doesNotMatch(worker.slice(worker.indexOf("async alarm("), worker.indexOf("async fetch(request")), /await this\.launchOptionalWork/);
  assert.match(worker, /this\.ctx\.waitUntil\(tracked\)/);
  assert.match(worker, /runtimeCache.*expiresAt/s);
  assert.match(worker, /this\.runtime\.d1Writes \+ billedWrites > 4_800/);
  assert.doesNotMatch(worker, /review-entry:|review-exit:/);
  assert.match(worker, /ORDER_CLOSE_DIAGNOSTIC/);
  assert.match(worker, /FROM paper_events WHERE event_type='PAPER_BANKRUPTCY'/);
  assert.match(worker, /event_type='ORDER_CLOSE_DIAGNOSTIC'[\s\S]*observed_at>=\? AND observed_at<=\?/);
  assert.match(worker, /completeTrades\.length > item\.report\.trades\.length/);
});

test("retired systems remain isolated; only current PAPER can create new LIVE entries", async () => {
  const [arena, previousArena, allRegime, previousAllRegime, dualPaper, regime, regimePortfolio, gateLive, worker, page, migration,
    coveragePolicy, previousCoveragePolicy] = await Promise.all([
    read("lib/strategy-arena.ts"), read("lib/previous-strategy-arena.ts"), read("lib/all-regime-engine.ts"),
    read("lib/previous-all-regime-engine.ts"), read("lib/dual-paper.ts"), read("lib/market-regime.ts"), read("lib/regime-portfolio.ts"),
    read("lib/gate-live.ts"), read("worker/index-clean.ts"), read("app/page.tsx"),
    read("drizzle/0035_strategy_arena_fresh_start.sql"),
    read("lib/strategy-coverage-policy.ts"),
    read("lib/previous-strategy-coverage-policy.ts"),
  ]);
  assert.match(arena, /STRATEGY_CATALOG/);
  assert.match(arena, /STRATEGY_ARENA_VERSION = 12/);
  assert.match(allRegime, /ALL_REGIME_SYSTEM_NAME = "全境·复利引擎"/);
  for (const name of ["界返", "渠破", "势回", "熊缩", "牛接"]) assert.match(allRegime, new RegExp(name));
  assert.match(allRegime, /detectAllRegimeRoutes/);
  for (const name of ["势承", "潮补", "静移", "冲衡", "脉折", "潮接"]) assert.match(previousAllRegime, new RegExp(name));
  assert.match(previousArena, /STRATEGY_INITIAL_EQUITY = 1_000/);
  assert.match(previousArena, /previous-strategy-coverage-policy\.ts/);
  assert.match(previousCoveragePolicy, /tide_catchup: \["COMPRESSION:BROAD_UP:LOW_EDGE"/);
  assert.match(dualPaper, /CANONICAL_PAPER_REFERENCE_EQUITY = 10_000/);
  assert.match(dualPaper, /canonicalCopySizing: "SOURCE_EQUITY_FRACTION"/);
  assert.match(dualPaper, /canonicalEntryScaleFrozen: true/);
  assert.match(dualPaper, /canonicalAdmissionGate: false/);
  assert.match(dualPaper, /canonicalCapitalAgnostic: false/);
  assert.match(dualPaper, /canonicalPaperOpen/);
  assert.match(dualPaper, /blockedCandidates: regimeBlockedCandidates/);
  assert.doesNotMatch(dualPaper, /blockedCandidates: \[\]/);
  assert.match(dualPaper, /canonicalLivePortfolio/);
  assert.doesNotMatch(arena, /adaptiveMechanismForPlaybook/);
  assert.match(arena, /ARENA_FRICTION_RATE = 0\.0014/);
  assert.match(arena, /ARENA_MAX_COST_SHARE = 0\.25/);
  assert.match(arena, /PORTFOLIO_REALTIME_CAPACITY = 11/);
  assert.match(regimePortfolio, /REGIME_ACCOUNT_INITIAL_EQUITY = 1_000/);
  assert.match(regimePortfolio, /REGIME_STRATEGIES/);
  assert.match(regimePortfolio, /riskRate|\.015/);
  assert.match(regimePortfolio, /classifyRegime/);
  assert.match(regimePortfolio, /REGIME_HOURLY_REQUIRED_CANDLES = 721/);
  assert.match(regimePortfolio, /rows\.length >= REGIME_HOURLY_REQUIRED_CANDLES/);
  assert.match(regimePortfolio, /status: "FORMING"/);
  assert.match(worker, /formingRouteCount/);
  assert.match(worker, /REGIME_HOURLY_REQUIRED_CANDLES \+ 1/);
  assert.match(worker, /regime-hourly:/);
  assert.doesNotMatch(regimePortfolio, /PROMOTION|shadowResolved|recentResults/);
  assert.match(arena, /recentObservations/);
  assert.match(arena, /currentRouteChecks/);
  assert.match(arena, /cutoverPending/);
  assert.match(arena, /sizePaperPosition/);
  assert.match(arena, /selectSafeLeverage/);
  assert.match(arena, /contracts/);
  assert.match(arena, /quantoMultiplier/);
  assert.match(arena, /ARENA_MAX_OPEN = 240/);
  assert.match(arena, /ARENA_HISTORY_LIMIT = 240/);
  assert.match(arena, /PORTFOLIO_TRADE_RISK_TARGET_USDT = 30/);
  assert.match(arena, /PORTFOLIO_TRADE_RISK_RATE = 0\.03/);
  assert.doesNotMatch(arena, /EMPIRICAL_COST/);
  assert.match(arena, /seenSignals\.length > 2_000/);
  assert.match(regime, /MARKET_REGIME_MIN_SAMPLES = 18/);
  assert.match(regime, /selectDiverseMarketPool/);
  assert.doesNotMatch(arena, /fetch\(|DB\.prepare|D1Database|GateLiveClient|reconcilePaper/);
  assert.match(worker, /const decision: Decision \| null = null/);
  assert.match(worker, /cycleBookSymbols/);
  assert.match(worker, /approvedRouteScore/);
  assert.match(worker, /feedQuality/);
  assert.match(worker, /allowOpen: false/);
  assert.match(worker, /V4\/V5 are retired/);
  assert.match(worker, /advanceRegimePortfolio/);
  assert.match(worker, /advanceStrategyArena/);
  assert.match(worker, /desiredPortfolio\s*=\s*this\.liveDesiredPortfolio/);
  assert.match(worker, /if\(!trade\.forwardSource\)continue/);
  assert.match(worker, /previousStrategyArena: retiredPreviousArena/);
  assert.match(worker, /sourceAfterEnable/);
  assert.doesNotMatch(worker, /eligibleForLiveMirror/);
  assert.match(worker, /position\.currentStop = position\.parity\?lifecycle!\.trade!\.stopPrice:arenaProtectionStop/);
  assert.match(worker, /buildProportionalMirror\(\{source:trade\.forwardSource/);
  assert.match(worker, /strategyArena: retiredCurrentArena\(saved\.strategyArena\)/);
  assert.match(worker, /resetStrategyArenaAccount/);
  assert.match(worker, /minimumPortfolioRiskUsdt: 0/);
  assert.match(worker, /targetPortfolioRiskUsdt: 15/);
  assert.match(worker, /empiricalCostFloorRate: ARENA_FRICTION_RATE/);
  assert.match(arena, /POLARITY_STREAK = 3/);
  assert.match(arena, /reversed\.every\(\(row\) => row\.netReturnRate > 0\)/);
  assert.match(arena, /profitArmIsExit: true/);
  assert.doesNotMatch(arena, /Object\.keys\(state\.portfolioOpen\)\.length >= MAX_PORTFOLIO_POSITIONS/);
  assert.doesNotMatch(arena, /globalOpportunityRank \?\? 1\) > MAX_PORTFOLIO_POSITIONS/);
  assert.match(arena, /RUNNER_EXIT/);
  assert.match(arena, /cloneShadowForPortfolio/);
  assert.match(arena, /paperEvaluation: true/);
  assert.match(arena, /extremeSequenceAuthority: false/);
  assert.match(arena, /generatedRouteAuthority: false/);
  assert.match(arena, /legacyStrategyAuthority: false/);
  assert.match(coveragePolicy, /TRANSITION: "WAIT"/);
  assert.match(coveragePolicy, /breadth24h >= \.71/);
  assert.match(coveragePolicy, /regimeMarkets \?\? 0\) < 12/);
  assert.doesNotMatch(page, />观察影子</);
  assert.match(page, /runtimeBackendOperational\(runtime\)/);
  assert.match(page, /RUNTIME_RETRY_MS = 3_000/);
  assert.doesNotMatch(page, /页面摘要延迟，交易后台继续独立运行/);
  assert.doesNotMatch(arena, /state\.portfolioEquity \* 0\.5/);
  assert.match(arena, /state\.portfolioEquity \* MAX_NOTIONAL_TO_EQUITY/);
  assert.match(arena, /state\.portfolioEquity \* MIN_PORTFOLIO_NOTIONAL_TO_EQUITY/);
  assert.match(arena, /MEANINGFUL_SIZE/);
  assert.match(gateLive, /Math\.min\(MAX_NOTIONAL_TO_EQUITY, input\.mirrorNotionalFraction\)/);
  assert.match(worker, /maxNotionalMultiple: 0\.5/);
  assert.match(worker, /buildLiveStopIntent\(position, tick\)/);
  assert.match(worker, /entry\.exchangeOrderId = await client\.createEntry\(intent,submissionStillAllowed\);[\s\S]{0,1600}await this\.createImmediateLiveStop\(client, entry\)/);
  assert.match(gateLive, /side === "LONG" \? Math\.floor\(units \+ 1e-9\) : Math\.ceil\(units - 1e-9\)/);
  assert.match(worker, /SCAN_UNIVERSE_SIZE = 30/);
  assert.match(worker, /eligible\.has\(row\.symbol\) && forwardSymbolAllowed\(row\.symbol\)/);
  assert.match(worker, /import \{ forwardSymbolAllowed \} from "\.\.\/lib\/forward-evidence\.ts"/);
  assert.match(worker, /maxOpenPositions: null/);
  assert.match(migration, /DELETE FROM `paper_events`/);
  assert.match(migration, /DELETE FROM `paper_positions`/);
  assert.match(migration, /DELETE FROM `paper_plans`/);
  assert.doesNotMatch(migration, /live_exchange_credentials/);
});

test("Gate degradation is endpoint-aware, incremental, and only blocking after retained paths expire", async () => {
  const [gate, worker] = await Promise.all([
    read("lib/gate-market.ts"), read("worker/index-clean.ts"),
  ]);
  assert.match(gate, /https:\/\/fx-api\.gateio\.ws\/api\/v4/);
  assert.match(gate, /endpointBackoffUntil/);
  assert.match(gate, /x-gate-ratelimit-reset-timestamp/);
  assert.match(worker, /const RADAR_MS = 60_000/);
  assert.match(worker, /prior\.length >= 960 \? 4 : 1_000/);
  assert.match(worker, /slice\(-1_000\)/);
  assert.match(worker, /fetchStructureCandles\(selected,"1d",prior\.length>=TURN_DAILY_REQUIRED_CANDLES\?4:120\)/);
  assert.match(worker, /TURN_DAILY_REQUIRED_CANDLES = 90/);
  assert.match(worker, /mergeTurnDailyPath/);
  assert.match(worker, /strategyAuthorityVersion!==MULTI_TURN_VERSION/);
  assert.match(worker, /legacyDrainOnly/);
  assert.match(worker, /mergeStrategyCandlePath/);
  assert.match(worker, /STRATEGY_CANDLE_STALE_MS = 11 \* 60_000/);
  assert.doesNotMatch(gate, /apiSecret|apiKey|KEY|SIGN/);
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

test("production gates follow the current RegionLaunch PAPER authority", async () => {
  const [workflow,dashboard,access] = await Promise.all([
    read(".github/workflows/sentinel-v2-ci.yml"),
    read("app/forward-dashboard.tsx"),
    read("app/member-access.tsx"),
  ]);
  assert.equal((workflow.match(/runtime\.forward\.strategyAuthorityVersion == "multi-turn-v1"/g) ?? []).length,2);
  assert.equal((workflow.match(/runtime\.forward\.executionVersion == "anchor-flow-v1"/g) ?? []).length,2);
  assert.equal((workflow.match(/runtime\.forward\.regionVersion == "region-lifecycle-v1"/g) ?? []).length,2);
  assert.equal((workflow.match(/runtime\.forward\.regionLaunchVersion == "region-launch-v3"/g) ?? []).length,2);
  assert.equal((workflow.match(/runtime\.forward\.initialEquity == 1000/g) ?? []).length,2);
  assert.equal((workflow.match(/runtime\.forward\.liveEligible == false/g) ?? []).length,2);
  assert.equal((workflow.match(/runtime\.forward\.storage\.persistedAt >= \.runtime\.forward\.lastCycleAt/g) ?? []).length,2);
  assert.equal((workflow.match(/runtime\.liveMirror\.source == "CURRENT_FORWARD_ACCOUNT"/g) ?? []).length,2);
  assert.equal((workflow.match(/runtime\.liveMirror\.ownerControlled == true/g) ?? []).length,2);
  const currentGates=workflow.slice(workflow.lastIndexOf("- name: Verify advancing production health"));
  assert.equal((currentGates.match(/runtime\.limits\.scanUniverse == 30/g) ?? []).length,2);
  assert.equal((currentGates.match(/runtime\.limits\.realtimeCapacity == 11/g) ?? []).length,2);
  assert.equal((workflow.match(/grep -Fq '哨兵 · 多周期转折引擎'/g) ?? []).length,2);
  assert.match(access,/哨兵 · 多周期转折引擎/);
  assert.match(dashboard,/哨兵 · RegionLaunch/);
  assert.match(dashboard,/缠绕区域 \+ RegionLaunch/);
  assert.doesNotMatch(workflow,/runtime\.strategyArena\.rules\.strategyName == "五行情独立账户组合"/);
  assert.doesNotMatch(workflow,/runtime\.strategyData\.hourlyRequiredCandles == 721/);
  assert.match(workflow, /deployment-plan/);
  assert.match(workflow, /Verify frozen V5 route authority/);
  assert.match(workflow, /Require crypto-only V5 architecture/);
  assert.doesNotMatch(workflow, /run: npm run research:v11/);
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

test("ordinary production deploy accepts evolved paper equity", async () => {
  const workflow = await read(".github/workflows/sentinel-v2-ci.yml");
  const ordinaryDeploy = workflow.slice(workflow.lastIndexOf("- name: Verify advancing production health"));
  assert.equal((ordinaryDeploy.match(/plannedDoWritesPerDay == 63032/g)??[]).length,2);
  assert.equal((ordinaryDeploy.match(/twoMemberReservedDoRowsPerDay == 99192/g)??[]).length,2);
  assert.equal((ordinaryDeploy.match(/criticalProtection\.independentOfFinancialWrites == true/g)??[]).length,2);
  assert.equal((ordinaryDeploy.match(/criticalProtection\.cap == 8640/g)??[]).length,2);
  assert.equal((ordinaryDeploy.match(/resourceAccounting\.cap == 8000/g)??[]).length,2);
  assert.equal((ordinaryDeploy.match(/capacityCertified == false/g)??[]).length,2);
  assert.doesNotMatch(ordinaryDeploy,/plannedDoWritesPerDay < 55000/);
  assert.match(ordinaryDeploy, /\.runtime\.forward\.executionVersion == "anchor-flow-v1"/);
  assert.match(ordinaryDeploy, /\.runtime\.forward\.initialEquity == 1000/);
  assert.doesNotMatch(ordinaryDeploy, /\.runtime\.forward\.balance == 1000/);
  assert.doesNotMatch(ordinaryDeploy, /\.runtime\.forward\.equity == 1000/);
});


test("release guard accepts only exact additive member namespaces, never primary deletion or rewrites", async () => {
  const workflow = await read(".github/workflows/sentinel-v2-ci.yml");
  const section = workflow.split("Require unchanged primary migrations and additive isolated member namespaces")[1].split("      - name:")[0];
  const expression = section.match(/jq -e --arg database "\$D1_DATABASE_ID" '([\s\S]*?)' wrangler\.jsonc/)[1];
  const config = JSON.parse(await read("wrangler.jsonc"));
  const accepts = (value) => spawnSync("jq", ["-e", "--arg", "database", config.d1_databases[0].database_id, expression], { input: JSON.stringify(value), encoding: "utf8" }).status === 0;
  assert.equal(accepts(config), true);
  const mutations = [
    (c) => c.durable_objects.bindings.shift(),
    (c) => c.migrations[7].deleted_classes = ["MarketStream"],
    (c) => c.migrations[5].new_sqlite_classes = ["WrongPrimary"],
    (c) => c.migrations.push({ tag: "unreviewed", deleted_classes: ["MarketStream"] }),
    (c) => c.d1_databases[0].database_id = "another-account",
  ];
  for (const mutate of mutations) { const c = structuredClone(config); mutate(c); assert.equal(accepts(c), false); }
});


test("Multi-Turn modules obey one-way architecture boundaries", async () => {
  const paths=["lib/multi-turn-engine.ts","lib/multi-turn-exit.ts","lib/multi-turn-exit-controller.ts","lib/multi-turn-hold-value.ts","lib/multi-turn-profit-protection.ts","lib/multi-turn-clock.ts","lib/multi-turn-entry-policy.ts","lib/multi-turn-entry-memory.ts","lib/multi-turn-entry-opportunity.ts"];
  const sources=await Promise.all(paths.map(read));
  const forbidden=/worker\/|app\/|gate-live|forward-store|D1Database|DurableObject|ctx\.storage|requestedEnabled|createEntry\(|fetch\(/;
  for(let i=0;i<paths.length;i++)assert.doesNotMatch(sources[i],forbidden,`${paths[i]} crossed runtime/storage/LIVE/UI boundary`);
  assert.doesNotMatch(sources[5],/from\s+["']/,"clock arbitration must remain dependency-free");
  assert.doesNotMatch(sources[2],/forward-relations|multi-turn-entry/,"exit authority must not depend on entry/account orchestration");
  assert.doesNotMatch(sources[6],/forward-relations|multi-turn-exit|forward-store|gate-live/,"entry policy must not depend on exit/account/LIVE orchestration");
  assert.doesNotMatch(sources[7],/forward-relations|multi-turn-exit|forward-store|gate-live/,"entry memory must remain a pure short-lived admission layer");
  assert.doesNotMatch(sources[8],/forward-relations|multi-turn-exit|forward-store|gate-live/,"entry opportunity scoring must remain pure and independent from account/LIVE orchestration");
  assert.doesNotMatch(sources[0],/forward-relations|multi-turn-exit|multi-turn-entry|forward-store|gate-live/,"turn engine must remain signal-only");
});
