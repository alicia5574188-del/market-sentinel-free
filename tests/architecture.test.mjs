import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Extremum Regime V1 is the only PAPER new-entry authority and legacy stacks stay compatibility-only",async()=>{
  const core=await read("lib/forward-relations.ts"),engine=await read("lib/extremum-regime-engine.ts");
  assert.match(core,/ADAPTIVE_ENGINE_VERSION=EXTREMUM_REGIME_VERSION/);
  assert.match(core,/from "\.\/extremum-regime-engine\.ts"/);
  assert.match(core,/buildExtremumRegime/);assert.match(core,/openExtremumTrade/);assert.match(core,/isExtremumOpportunity/);
  for(const mode of["SWING","TREND_PULLBACK","IMPULSE"])assert.match(core,new RegExp(`"${mode}"`));
  assert.match(core,/FORWARD_EXECUTION_BBO_CAP=30/);assert.match(core,/FORWARD_MINUTE_CONFIRMATION_CAP=11/);
  assert.match(core,/TOTAL_RISK_RATE=\.10/);assert.match(core,/SIDE_RISK_RATE=\.065/);assert.match(core,/TOTAL_MARGIN_RATE=\.75/);
  assert.match(engine,/TREND_UP/);assert.match(engine,/TREND_DOWN/);assert.match(engine,/WEAKENING/);assert.match(engine,/TRANSITION/);
  assert.match(engine,/topPressure/);assert.match(engine,/bottomPressure/);assert.match(engine,/upSurvival/);assert.match(engine,/downSurvival/);
  assert.match(engine,/momentumOverride/);assert.match(engine,/RECLAIM_TEST/);assert.match(engine,/READY/);
  const advance=core.slice(core.indexOf("export function advanceForward"),core.indexOf("export function closeForwardForReset"));
  assert.match(advance,/s\.opportunities=built\.opportunities/);
  assert.doesNotMatch(advance,/advanceRelationEngine\(|interruptOpportunities\(|buildOpportunities\(/);
  const minute=core.slice(core.indexOf("export function forwardUrgentMinuteSymbols"),core.indexOf("export function forwardWatchSymbols"));
  assert.match(minute,/extremumUrgentMinuteSymbols/);assert.doesNotMatch(minute,/s\.positions/);
});

test("retired relation family and Structural Interrupt stacks cannot manufacture new entries after cutover",async()=>{
  const core=await read("lib/forward-relations.ts");
  const advance=core.slice(core.indexOf("export function advanceForward"),core.indexOf("export function closeForwardForReset"));
  assert.doesNotMatch(advance,/relationCandidates\(|structuralInterruptCandidates\(|familyAdmissionBlock\(/);
  assert.match(core,/entryContext\?\.strategyVersion===EXTREMUM_REGIME_VERSION/);
  const summary=core.slice(core.indexOf("export function forwardSummary"));
  assert.match(summary,/relationEngine:\{version:s\.relationEngine\.version,retired:true/);
  assert.match(summary,/structuralInterrupt:\{version:STRUCTURAL_INTERRUPT_VERSION,retired:true/);
  assert.match(summary,/平仓与反手是两个独立事件/);
});

test("runtime alarm uses the slim market path and no strategy cutover can reset PAPER",async()=>{
  const worker=await read("worker/index-clean.ts");
  assert.doesNotMatch(worker,/MULTI_TURN_AUTO_CUTOVER|ensureMultiTurnCutover|ensureAnchorFlowCutover/);
  assert.match(worker,/private async ensureAdaptiveAccount/);
  const advance=worker.slice(worker.indexOf("private async advanceForwardNow"),worker.indexOf("private async refreshRegimeHourly"));
  assert.doesNotMatch(advance,/prepareForwardReset|initialMultiTurnForward\(/);
  const alarm=worker.slice(worker.indexOf("async alarm("),worker.indexOf("async fetch(request"));
  assert.match(alarm,/processAdaptiveBooks\(now, cycleSymbols\)/);
  assert.match(alarm,/launchOptionalWork\(now, universeDue\)/);
  assert.doesNotMatch(alarm,/processLegacyBooks|advanceRegimePortfolio|advanceStrategyArena|ensureAnchorFlowCutover/);
});

test("Forward Relation analysis remains multi-source while Gate stays execution-only",async()=>{
  const hub=await read("lib/market-data-hub.ts"),worker=await read("worker/index-clean.ts");
  assert.match(hub,/class MarketDataHub/);assert.match(hub,/BYBIT/);assert.match(hub,/OKX/);assert.match(hub,/KUCOIN/);assert.match(hub,/BITGET/);assert.match(hub,/BINANCE/);
  assert.match(worker,/private marketHub = new MarketDataHub/);
  assert.match(worker,/Gate public websocket is execution-only/);
  assert.match(worker,/Bybit\/OKX\/KuCoin remain the normal scan surface/);
  assert.match(worker,/forwardWatchSymbols/);assert.match(hub,/multi-source-market-hub-v4/);assert.match(hub,/nextRetryAt/);
  assert.doesNotMatch(worker,/fetchMarketTickers\(\)/);
});

test("entry readiness needs only fresh executable Gate data and contract metadata",async()=>{
  const worker=await read("worker/index-clean.ts");
  const readiness=worker.slice(worker.indexOf("private symbolEntryReady"),worker.indexOf("private currentAuthorityProtectionSymbols"));
  assert.match(readiness,/sessionWarmup\[symbol\].*>=1/);
  assert.match(readiness,/contractMeta\[symbol\]/);
  assert.match(readiness,/STALE_AFTER_MS/);
  assert.doesNotMatch(readiness,/m15|h1|h4|ancillaryFresh/);
  const health=worker.slice(worker.indexOf("private publishCriticalHealth"),worker.indexOf("private launchOptionalWork"));
  assert.doesNotMatch(health,/ancillaryStarted|allWarm/);
});

test("health exposes bounded Forward diagnostics without adding strategy authority",async()=>{
  const worker=await read("worker/index-clean.ts"),health=worker.slice(worker.indexOf("private forwardHealth()"),worker.indexOf("protected liveMirrorView()"));
  assert.match(health,/extremumCounts/);assert.match(health,/entryDiagnostics/);assert.match(health,/candidateDiagnostics/);
  assert.match(health,/slice\(0,8\)/);
  assert.doesNotMatch(health,/openTrade\(|fillForwardPortfolio\(|GateLiveClient/);
});

test("LIVE, member, auth and credential infrastructure remain isolated from strategy code",async()=>{
  const [live,member,auth,vault]=await Promise.all([
    read("lib/gate-live.ts"),read("worker/member-executor.ts"),read("lib/owner-auth.ts"),read("lib/credential-vault.ts"),
  ]);
  assert.match(live,/class GateLiveClient/);assert.match(live,/snapshotCore/);assert.match(live,/snapshotOrders/);
  assert.match(member,/memberExecutionClass/);assert.match(member,/forwardMirrorSources/);
  assert.match(auth,/verifyOwnerSession/);assert.match(vault,/encryptGateCredentials/);
  for(const source of[live,auth,vault])assert.doesNotMatch(source,/forward-relation-v2/);
});

test("fresh PAPER entries wake one LIVE pass without an artificial two-order staging queue or stale catch-up",async()=>{
  const [worker,parity]=await Promise.all([read("worker/index-clean.ts"),read("lib/live-parity.ts")]);
  const sync=worker.slice(worker.indexOf("protected async syncLive"),worker.indexOf("private suspendSymbol"));
  assert.match(sync,/desiredTrades=Object\.values\(desiredPortfolio\)\.sort/);
  assert.doesNotMatch(sync,/staged\.length>=2/);
  assert.match(parity,/LIVE_SOURCE_ENTRY_MAX_DELAY_MS = 30_000/);
  assert.match(parity,/minimumUplift/);assert.match(parity,/LIVE_MIN_CONTRACT_UPLIFT_MAX_RISK_RATE = \.0075/);
});

test("PAPER commit and restored serialized LIVE pass share one persisted source generation",async()=>{
  const [worker,store]=await Promise.all([read("worker/index-clean.ts"),read("lib/forward-store.ts")]);
  const advance=worker.slice(worker.indexOf("private async advanceForwardNow"),worker.indexOf("private async refreshRegimeHourly"));
  assert.match(advance,/storage\.transaction\(async transaction => \{ await transaction\.put\(prepared\.entries\); \}\)/);
  assert.doesNotMatch(worker,/launchLiveWork\(|liveBackgroundWork|liveSourcePending|liveFastSourcePending/);
  const alarm=worker.slice(worker.indexOf("  async alarm(info?"),worker.indexOf("  async fetch(request:",worker.indexOf("  async alarm(info?")));
  assert.ok(alarm.indexOf("await this.advanceForwardNow(Date.now(),false)")>=0);
  assert.ok(alarm.indexOf("await this.syncLive(liveStarted)")>alarm.indexOf("await this.advanceForwardNow(Date.now(),false)"));
  assert.match(store,/FORWARD_SAMPLE_MANIFEST_STORAGE/);assert.match(store,/sampleManifestSha256/);
  assert.match(store,/changedSamplePages/);assert.match(store,/FORWARD_ACCOUNT_MAX_BYTES=1024\*1024/);
});

test("LIVE uses the restored full Gate snapshot and no split order-audit admission layer",async()=>{
  const worker=await read("worker/index-clean.ts");
  const sync=worker.slice(worker.indexOf("protected async syncLive"),worker.indexOf("private suspendSymbol"));
  assert.match(sync,/let snapshot=await client\.snapshot\(\)/);
  assert.doesNotMatch(sync,/orderAuditUsable|snapshotCore\(\)|snapshotOrders\(\)/);
  assert.match(sync,/entry\.exchangeOrderId = await client\.createEntry\(intent,submissionStillAllowed\)/);
});

test("Stage 3 exposes Extremum Regime V1 without removing operator or execution infrastructure",async()=>{
  const [dashboard,execution,worker,workflow,wrangler]=await Promise.all([
    read("app/forward-dashboard.tsx"),read("app/extremum-execution.tsx"),read("worker/index-clean.ts"),
    read(".github/workflows/sentinel-v2-ci.yml"),read("wrangler.jsonc"),
  ]);
  assert.match(dashboard,/哨兵 · 峰谷状态系统/);assert.match(dashboard,/ExtremumExecution/);assert.match(dashboard,/extremum-regime-v1/);
  assert.match(execution,/TOP|顶部压力/);assert.match(execution,/趋势生命/);assert.match(execution,/RECLAIM|confirmationStage|阶段/);
  assert.match(execution,/当前交易机会/);assert.match(execution,/持仓正在等待什么/);
  for(const tab of["overview","execution","paper","live","journal","settings"])assert.match(dashboard,new RegExp(`"${tab}"`));
  assert.match(worker,/SCAN_UNIVERSE_SIZE = 30/);assert.match(worker,/FORWARD_EXECUTION_BBO_CAP/);
  assert.match(workflow,/extremum-regime-v1/);
  assert.match(wrangler,/MarketStream/);assert.match(wrangler,/MemberExecutor/);assert.match(wrangler,/MemberDirectory/);
});
