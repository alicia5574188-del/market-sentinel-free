import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Forward Path Relation 3.0 is the only PAPER strategy authority and retired strategy stacks stay disconnected",async()=>{
  const core=await read("lib/forward-relations.ts");
  assert.match(core,/ADAPTIVE_ENGINE_VERSION=FORWARD_RELATION_V2_VERSION/);
  assert.match(core,/from "\.\/forward-relation-v2\.ts"/);
  assert.doesNotMatch(core,/ADAPTIVE_TARGET_POSITIONS|ADAPTIVE_REALTIME_POSITION_CAP/);
  assert.match(core,/FORWARD_EXECUTION_BBO_CAP=30/);
  assert.match(core,/FORWARD_MINUTE_CONFIRMATION_CAP=11/);
  for(const retired of["multi-turn","anchor-flow","region-launch","region-lifecycle","strategy-arena","regime-portfolio","all-regime-engine"])
    assert.doesNotMatch(core,new RegExp(`from .*\\b${retired.replace(/[.*+?^$()|[\\]{}]/g,"\\$&")}`));
  for(const mode of["RELATION","BREAKOUT","RETEST","FAILED_BREAKOUT","RANGE","SHOCK"])assert.match(core,new RegExp(`"${mode}"`));
  assert.match(core,/ROTATION_GAP=10/);
  assert.match(core,/TOTAL_RISK_RATE=\.10/);
  assert.match(core,/SIDE_RISK_RATE=\.065/);
  assert.match(core,/PROBE_RISK_POOL_RATE=\.015/);
  assert.match(core,/FAMILY_RISK_CAP_RATE=\.025/);
  assert.match(core,/FIVE_MINUTE_NEW_RISK_RATE=\.025/);
  assert.match(core,/portfolioRiskCharge/);
  assert.match(core,/premiumOnly/);
  assert.match(core,/from "\.\/forward-family-experiment\.ts"/);
  assert.doesNotMatch(core,/forward-entry-guard/);
  const family=await read("lib/forward-family-experiment.ts");
  assert.match(family,/FORWARD_FAMILY_EXPERIMENT_VERSION="forward-family-experiment-v3"/);
  assert.match(family,/recordFamilyOutcome/);assert.match(family,/meanRealizedNetRate/);assert.match(family,/meanCostRate/);
  assert.match(family,/edgeRatio<\.45/);assert.match(family,/livePathScore<\.55/);
  assert.match(core,/MAX_NEW_RESERVE_EXPERIMENTS_PER_5M=2/);assert.match(core,/reserveEntriesThisCycle/);
  assert.match(family,/relationFamilyId/);
  assert.match(family,/reserveExperimentValueBlock/);
  assert.match(family,/STRUCTURE_STOP/);
  assert.doesNotMatch(family,/stopPrice|targetPrice|profitFloor|GateLiveClient/);
  const minute=core.slice(core.indexOf("export function forwardUrgentMinuteSymbols"),core.indexOf("export function forwardWatchSymbols"));
  assert.doesNotMatch(minute,/s\.positions/);
  assert.match(minute,/o\.premium&&o\.eligible/);
  const rotation=core.slice(core.indexOf("function rotateIfNeeded"),core.indexOf("export function fillForwardPortfolio"));
  assert.match(rotation,/sideFull/);assert.match(rotation,/existingRisk\(s,candidate\.side\)/);
  assert.match(rotation,/structuredClone\(s\)/);
});

test("Structural Interrupt is a bounded exception to sample authority, never a restored structure-first stack",async()=>{
  const [core,interrupt]=await Promise.all([read("lib/forward-relations.ts"),read("lib/forward-structural-interrupt.ts")]);
  assert.match(core,/from "\.\/forward-structural-interrupt\.ts"/);
  assert.match(core,/if\(!isShock&&!o\.relationRuleId\)/);
  assert.match(core,/structuralInterruptBlockReason/);
  assert.match(core,/SHOCK_EVENT_RISK_RATE=\.015/);assert.match(core,/MAX_SHOCK_ENTRIES_PER_EVENT=2/);
  assert.match(core,/同一市场冲击默认只参与最优标的/);
  assert.match(interrupt,/phase:"PRE_ALERT"\|"WAIT_RETEST"\|"CONFIRMED"\|"COOLDOWN"/);
  assert.match(interrupt,/track\.phase==="WAIT_RETEST"/);assert.match(interrupt,/track\.hadPullback&&track\.restartSeen/);
  assert.match(interrupt,/preCount>=4&&preBreadth>=\.25/);assert.match(interrupt,/confirmed\.length>=3&&breadth>=\.20/);
  assert.match(interrupt,/singleExtreme=.*\.0065/);
  assert.doesNotMatch(core,/m\.ok\|\|body>avgBody\*2\.6/);
  assert.match(core,/1m确认通过/);
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
  assert.match(health,/relationDiagnostics/);assert.match(health,/entryDiagnostics/);assert.match(health,/candidateDiagnostics/);
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

test("operator UI and release config expose Forward Path Relation 3.0 with risk-based holdings and 30 execution BBO capacity",async()=>{
  const [dashboard,worker,workflow,wrangler]=await Promise.all([
    read("app/forward-dashboard.tsx"),read("worker/index-clean.ts"),read(".github/workflows/sentinel-v2-ci.yml"),read("wrangler.jsonc"),
  ]);
  assert.match(dashboard,/哨兵 · Forward Path Relation 3\.0/);assert.match(dashboard,/反向独立确认/);
  assert.match(worker,/SCAN_UNIVERSE_SIZE = 30/);assert.match(worker,/FORWARD_EXECUTION_BBO_CAP/);
  assert.match(workflow,/forward-path-relation-v3/);
  assert.match(wrangler,/MarketStream/);assert.match(wrangler,/MemberExecutor/);assert.match(wrangler,/MemberDirectory/);
});
