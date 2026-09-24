import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Forward Relation 2.0 is the only PAPER strategy authority and retired strategy stacks stay disconnected",async()=>{
  const core=await read("lib/forward-relations.ts");
  assert.match(core,/ADAPTIVE_ENGINE_VERSION=FORWARD_RELATION_V2_VERSION/);
  assert.match(core,/from "\.\/forward-relation-v2\.ts"/);
  assert.match(core,/ADAPTIVE_TARGET_POSITIONS=10/);
  assert.match(core,/ADAPTIVE_REALTIME_POSITION_CAP=11/);
  for(const retired of["multi-turn","anchor-flow","region-launch","region-lifecycle","strategy-arena","regime-portfolio","all-regime-engine"])
    assert.doesNotMatch(core,new RegExp(`from .*\\b${retired.replace(/[.*+?^$()|[\\]{}]/g,"\\$&")}`));
  for(const mode of["RELATION","BREAKOUT","RETEST","FAILED_BREAKOUT","RANGE"])assert.match(core,new RegExp(`"${mode}"`));
  assert.match(core,/ROTATION_GAP=10/);
  assert.match(core,/TOTAL_RISK_RATE=\.10/);
  assert.match(core,/SIDE_RISK_RATE=\.065/);
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
  assert.match(hub,/class MarketDataHub/);assert.match(hub,/BYBIT/);assert.match(hub,/OKX/);assert.match(hub,/BINANCE/);
  assert.match(worker,/private marketHub = new MarketDataHub/);
  assert.match(worker,/Gate public websocket is execution-only/);
  assert.match(worker,/Bybit\/Binance remain the normal scan surface/);
  assert.match(worker,/forwardWatchSymbols/);
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

test("LIVE, member, auth and credential infrastructure remain isolated from strategy code",async()=>{
  const [live,member,auth,vault]=await Promise.all([
    read("lib/gate-live.ts"),read("worker/member-executor.ts"),read("lib/owner-auth.ts"),read("lib/credential-vault.ts"),
  ]);
  assert.match(live,/class GateLiveClient/);assert.match(live,/snapshotCore/);assert.match(live,/snapshotOrders/);
  assert.match(member,/memberExecutionClass/);assert.match(member,/forwardMirrorSources/);
  assert.match(auth,/verifyOwnerSession/);assert.match(vault,/encryptGateCredentials/);
  for(const source of[live,auth,vault])assert.doesNotMatch(source,/forward-relation-v2/);
});

test("operator UI and release config expose Forward Relation 2.0 with risk-based holdings and 30 execution BBO capacity",async()=>{
  const [dashboard,worker,workflow,wrangler]=await Promise.all([
    read("app/forward-dashboard.tsx"),read("worker/index-clean.ts"),read(".github/workflows/sentinel-v2-ci.yml"),read("wrangler.jsonc"),
  ]);
  assert.match(dashboard,/哨兵 · Forward Relation 2\.0/);assert.match(dashboard,/反向独立确认/);
  assert.match(worker,/SCAN_UNIVERSE_SIZE = 30/);assert.match(worker,/FORWARD_EXECUTION_BBO_CAP/);
  assert.match(workflow,/forward-relation-v2/);
  assert.match(wrangler,/MarketStream/);assert.match(wrangler,/MemberExecutor/);assert.match(wrangler,/MemberDirectory/);
});
