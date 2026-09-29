import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Market Intelligence V1 is the only PAPER new-entry authority",async()=>{
  const core=await read("lib/forward-relations.ts"),engine=await read("lib/market-intelligence-engine.ts");
  assert.match(core,/ADAPTIVE_ENGINE_VERSION=MARKET_INTELLIGENCE_VERSION/);
  assert.match(core,/market-intelligence-engine\.ts/);assert.match(core,/buildMarketIntelligence/);
  assert.match(core,/openIntelligenceTrade/);assert.match(core,/isIntelligenceOpportunity/);
  for(const mode of["RELATIVE","REVERSAL","CONTINUATION"])assert.match(core,new RegExp(`"${mode}"`));
  assert.match(engine,/MarketNarrative/);assert.match(engine,/MarketEvidence/);assert.match(engine,/residualPersistence/);
  assert.match(engine,/clusterId/);assert.match(engine,/tailRisk/);assert.match(engine,/expectedShortMinutes/);
  assert.match(core,/TOTAL_RISK_RATE=\.10/);assert.match(core,/SIDE_RISK_RATE=\.065/);assert.match(core,/TOTAL_MARGIN_RATE=\.75/);
  const advance=core.slice(core.indexOf("export function advanceForward"),core.indexOf("export function closeForwardForReset"));
  assert.match(advance,/s\.opportunities=built\.opportunities/);
  assert.doesNotMatch(advance,/buildExtremumRegime|advanceRelationEngine\(|interruptOpportunities\(|buildOpportunities\(/);
});

test("old strategy stacks remain compatibility-only and cannot manufacture new entries",async()=>{
  const core=await read("lib/forward-relations.ts");
  const advance=core.slice(core.indexOf("export function advanceForward"),core.indexOf("export function closeForwardForReset"));
  assert.doesNotMatch(advance,/relationCandidates\(|structuralInterruptCandidates\(|familyAdmissionBlock\(/);
  assert.match(core,/entryContext\?\.strategyVersion===MARKET_INTELLIGENCE_VERSION/);
  const summary=core.slice(core.indexOf("export function forwardSummary"));
  assert.match(summary,/relationEngine:\{version:s\.relationEngine\.version,retired:true/);
  assert.match(summary,/structuralInterrupt:\{version:STRUCTURAL_INTERRUPT_VERSION,retired:true/);
  assert.match(summary,/marketIntelligence:/);
});

test("multi-source analysis is non-blocking while Gate stays execution-only",async()=>{
  const hub=await read("lib/market-data-hub.ts"),worker=await read("worker/index-clean.ts");
  for(const venue of["BYBIT","OKX","KUCOIN","MEXC","HTX"])assert.match(hub,new RegExp(venue));
  assert.match(hub,/Promise\.any\(primary\.map\(fetchOne\)\)/);
  assert.match(hub,/Cached rows remain/);
  assert.match(hub,/interval:"1m"\|"5m"\|"1d"/);
  assert.match(worker,/Gate public websocket is execution-only/);assert.match(worker,/private marketHub = new MarketDataHub/);
  assert.match(worker,/daily:this\.turnDailyCandles/);
  const optional=worker.slice(worker.indexOf("private launchOptionalWork"),worker.indexOf("async alarm("));
  assert.match(optional,/refreshTurnDaily\(Date\.now\(\)\)/);
  const daily=worker.slice(worker.indexOf("private async refreshTurnDaily"),worker.indexOf("private async maybeWriteStrategyRuntimeLog"));
  assert.match(daily,/marketHub\.candles\(selected,"1d",120\)/);
  assert.match(daily,/external 1d temporarily unavailable/);
});

test("shadow geometry research is post-authority, optional and cannot become trading authority",async()=>{
  const [worker,shadow,core]=await Promise.all([
    read("worker/index-clean.ts"),read("lib/market-intelligence-shadow-research.ts"),read("lib/forward-relations.ts")
  ]);
  const optional=worker.slice(worker.indexOf("private launchOptionalWork"),worker.indexOf("async alarm("));
  assert.ok(optional.indexOf("await this.advanceForwardNow(Date.now(),true)")>=0);
  assert.ok(optional.indexOf("await this.advanceShadowResearchNow(Date.now())")>optional.indexOf("await this.advanceForwardNow(Date.now(),true)"));
  assert.match(worker,/reserveNonAlarmWrites\(writes,512\)/);
  assert.match(shadow,/SHADOW_MILESTONE_CAUSALITY_VERSION/);
  assert.match(shadow,/BACKFILLED/);assert.match(shadow,/LIVE_OBSERVED/);
  assert.match(shadow,/deriveRollingGeometry/);assert.match(shadow,/shortFlips90/);assert.match(shadow,/breadthCrosses90/);
  assert.doesNotMatch(shadow,/openIntelligenceTrade|closeTrade|setLiveMode|GateLiveClient|createEntry\(/);
  const advance=core.slice(core.indexOf("export function advanceForward"),core.indexOf("export function closeForwardForReset"));
  assert.doesNotMatch(advance,/shadowResearch|ShadowResearch/);
});

test("market narrative is exposed in bounded health diagnostics",async()=>{
  const worker=await read("worker/index-clean.ts"),health=worker.slice(worker.indexOf("private forwardHealth()"),worker.indexOf("protected liveMirrorView()"));
  assert.match(health,/marketIntelligenceCounts/);assert.match(health,/marketNarrative/);assert.match(health,/marketIntelligenceCoverage/);assert.match(health,/correlationClusters/);
  assert.match(health,/candidateDiagnostics/);assert.match(health,/slice\(0,8\)/);
  assert.doesNotMatch(health,/openTrade\(|fillForwardPortfolio\(|GateLiveClient/);
});

test("runtime cannot reset PAPER during a strategy revision",async()=>{
  const worker=await read("worker/index-clean.ts");
  assert.match(worker,/private async ensureAdaptiveAccount/);
  const advance=worker.slice(worker.indexOf("private async advanceForwardNow"),worker.indexOf("private async refreshRegimeHourly"));
  assert.doesNotMatch(advance,/prepareForwardReset|initialMultiTurnForward\(/);
});

test("LIVE execution infrastructure stays isolated and serialized after PAPER commit",async()=>{
  const [worker,parity,live,member]=await Promise.all([read("worker/index-clean.ts"),read("lib/live-parity.ts"),read("lib/gate-live.ts"),read("worker/member-executor.ts")]);
  assert.match(live,/class GateLiveClient/);assert.match(member,/forwardMirrorSources/);
  assert.match(parity,/LIVE_SOURCE_ENTRY_MAX_DELAY_MS = 30_000/);assert.match(parity,/minimumUplift/);
  const sync=worker.slice(worker.indexOf("protected async syncLive"),worker.indexOf("private suspendSymbol"));
  assert.match(sync,/desiredTrades=Object\.values\(desiredPortfolio\)\.sort/);
  assert.match(sync,/let snapshot=await client\.snapshot\(\)/);
  assert.match(sync,/entry\.exchangeOrderId = await client\.createEntry\(intent,submissionStillAllowed\)/);
  assert.doesNotMatch(sync,/staged\.length>=2/);
  const alarm=worker.slice(worker.indexOf("  async alarm(info?"),worker.indexOf("  async fetch(request:",worker.indexOf("  async alarm(info?")));
  assert.ok(alarm.indexOf("await this.advanceForwardNow(Date.now(),false)")>=0);
  assert.ok(alarm.indexOf("await this.syncLive(liveStarted)")>alarm.indexOf("await this.advanceForwardNow(Date.now(),false)"));
});

test("execution page exposes the same narrative used by strategy decisions",async()=>{
  const [dashboard,execution,workflow,wrangler]=await Promise.all([
    read("app/forward-dashboard.tsx"),read("app/market-intelligence-execution.tsx"),read(".github/workflows/sentinel-v2-ci.yml"),read("wrangler.jsonc")
  ]);
  assert.match(dashboard,/哨兵 · 市场智能系统/);assert.match(dashboard,/MarketIntelligenceExecution/);assert.match(dashboard,/market-intelligence-v1/);
  for(const text of["超大周期","大方向","短期优势","系统刚刚发现的细节","当前交易假设","持仓自己的理由"])assert.match(execution,new RegExp(text));
  assert.match(workflow,/market-intelligence-v1/);
  assert.match(workflow,/marketIntelligenceTracked >= 20/);assert.match(workflow,/marketIntelligenceCoverage\.dailyMarkets >= 3/);
  assert.match(execution,/数据覆盖/);assert.match(execution,/超大周期至少需要3个真实日线市场/);
  assert.match(wrangler,/MarketStream/);assert.match(wrangler,/MemberExecutor/);assert.match(wrangler,/MemberDirectory/);
});


test("Market Intelligence uses research lifecycle protection, not blind scalp locking or batch spraying",async()=>{
  const core=await read("lib/forward-relations.ts"),engine=await read("lib/market-intelligence-engine.ts"),
    lifecycle=await read("lib/market-intelligence-lifecycle.ts");
  const manage=core.slice(core.indexOf("function manageIntelligenceTrades"),core.indexOf("function markAndManage"));
  assert.match(manage,/evaluatePositionIntelligence/);
  assert.match(manage,/deriveProfitLifecycle/);
  assert.match(manage,/RESEARCH_PROFIT_PROTECT|RESEARCH_LIFECYCLE_EXIT/);
  assert.match(manage,/研究层进入利润保护/);
  assert.doesNotMatch(manage,/样本利润保护提升|已移除旧式动态锁利/);
  assert.match(lifecycle,/healthyTrend/);
  assert.match(lifecycle,/persistentDeterioration/);
  assert.match(lifecycle,/runnerHealthy/);
  assert.match(lifecycle,/initialExpectedNetRate/);
  assert.match(lifecycle,/platformFloorRate/);
  assert.match(lifecycle,/runnerPlatformNet/);
  assert.match(manage,/PROFIT_PLATFORM_BREACH/);
  assert.match(manage,/Runner利润平台/);
  assert.match(lifecycle,/action="PROTECT"/);
  assert.doesNotMatch(manage,/relationFailureBars.*>=2|THESIS_INVALIDATED/);
  const fill=core.slice(core.indexOf("export function fillForwardPortfolio"),core.indexOf("function nextCandleAt"));
  assert.match(fill,/opened=1;break/);
  const advance=core.slice(core.indexOf("export function advanceForward"),core.indexOf("export function closeForwardForReset"));
  assert.match(advance,/if\(marketReady&&dataDue\)seedEntryResponses/);
  assert.match(advance,/marketReady\?advanceEntryResponses/);
  assert.doesNotMatch(advance,/marketReady&&dataDue\?fillForwardPortfolio/);
  assert.doesNotMatch(advance,/rotateIfNeeded\(/);
  assert.match(engine,/thesisId=.*row\.signalSince/);
  assert.match(engine,/signalBars>=2/);
  assert.match(engine,/stableBias/);
  const boundaries=core.slice(core.indexOf("boundaries:{scope"));
  assert.match(boundaries,/Position Intelligence/);
  assert.match(boundaries,/单一细节、单一市场转向或连续两根5m都没有独立平仓权/);
});


test("Market Intelligence active exits are evidence-family gated, not two-bar thesis invalidation",async()=>{
  const [core,position,engine,execution]=await Promise.all([
    read("lib/forward-relations.ts"),read("lib/position-intelligence-engine.ts"),
    read("lib/market-intelligence-engine.ts"),read("app/market-intelligence-execution.tsx")
  ]);
  const manage=core.slice(core.indexOf("function manageIntelligenceTrades"),core.indexOf("function markAndManage"));
  assert.match(manage,/evaluatePositionIntelligence/);
  assert.doesNotMatch(manage,/if\(position\.decision==="EXIT"\)/);
  assert.match(manage,/lifecycle\.action==="EXIT"/);
  assert.doesNotMatch(manage,/invalidationBars|relationFailureBars.*>=2|THESIS_INVALIDATED/);
  assert.match(position,/coreConcern&&independentConfirm/);
  assert.match(position,/reviewBars>=2/);
  assert.match(position,/contextOnly:true/);
  assert.match(position,/dataConfidence>=60/);
  assert.match(engine,/same\.samples=\(same\.samples\?\?1\)\+1/);
  assert.match(engine,/LEADERSHIP_ROTATION/);
  assert.match(engine,/FLOW_ABSORBED_OR_STALLED/);
  assert.doesNotMatch(execution,/偏多细节|偏空细节/);
  assert.match(execution,/复核已持续/);
  assert.match(execution,/剩余空间/);
});


test("existing multi-source BBO refresh exposes liquidity migration without extra per-symbol REST fanout",async()=>{
  const [hub,worker,engine,position,execution]=await Promise.all([
    read("lib/market-data-hub.ts"),read("worker/index-clean.ts"),read("lib/market-intelligence-engine.ts"),
    read("lib/position-intelligence-engine.ts"),read("app/market-intelligence-execution.tsx")
  ]);
  for(const token of["bid1Size","bidSz","bestBidSize","contract_code","trade_turnover","bookImbalance","bidLiquidityChange","askLiquidityChange"])
    assert.match(hub,new RegExp(token));
  assert.match(worker,/external\?\.liquiditySourceCount/);
  assert.match(worker,/bidLiquidityChange:external\?\.bidLiquidityChange/);
  assert.match(engine,/BID_LIQUIDITY_WITHDRAWAL/);
  assert.match(engine,/ASK_LIQUIDITY_WITHDRAWAL/);
  assert.match(position,/alignedLiquidity/);
  assert.match(execution,/跨所流动性/);
});


test("counterfactual research is isolated from trading authority and exported for review",async()=>{
  const [worker,forward,research]=await Promise.all([
    read("worker/index-clean.ts"),read("lib/forward-relations.ts"),read("lib/market-intelligence-research.ts")
  ]);
  assert.doesNotMatch(forward,/market-intelligence-research|advanceCounterfactualResearch|counterfactualResearch/);
  const optional=worker.slice(worker.indexOf("private launchOptionalWork"),worker.indexOf("async alarm("));
  assert.match(optional,/advanceForwardNow\(Date\.now\(\),true\)/);
  assert.match(optional,/advanceCounterfactualResearchNow\(Date\.now\(\),true\)/);
  assert.ok(optional.indexOf("advanceForwardNow(Date.now(),true)")<optional.indexOf("advanceCounterfactualResearchNow(Date.now(),true)"),
    "research must run only after authoritative PAPER processing");
  assert.match(worker,/counterfactualResearch:counterfactualResearchView/);
  assert.match(research,/RESEARCH_CHECKPOINTS=\[5,15,30,60,120,240\]/);
  assert.match(research,/ACCOUNT_RESET/);
  assert.match(research,/FILTERED_NOT_MATURE/);
  assert.match(research,/EXECUTABLE_NOT_SELECTED/);
  assert.match(research,/marketAt/);
});



test("forward hypothesis research is bounded, causal, and cannot hard-veto big-winner entry paths",async()=>{
  const [core,research,store,execution]=await Promise.all([
    read("lib/forward-relations.ts"),read("lib/market-intelligence-hypothesis-research.ts"),
    read("lib/forward-store.ts"),read("app/market-intelligence-execution.tsx")
  ]);
  assert.match(core,/advanceMarketHypothesisResearch/);
  assert.match(core,/entryHypothesisGuidance/);
  assert.match(core,/positionHypothesisGuidance/);
  assert.match(research,/MARKET_HYPOTHESIS_ACTIVE_LIMIT=12/);
  assert.match(research,/MARKET_HYPOTHESIS_RESOLVED_LIMIT=48/);
  assert.match(research,/MARKET_HYPOTHESIS_MEMORY_LIMIT=16/);
  assert.match(research,/market-hypothesis-research-v2/);
  assert.match(research,/WEAKENING/);
  assert.match(research,/lastDecisionBucketAt/);
  assert.match(research,/independent=input\.score>=82/);
  assert.match(research,/不削弱原大赢家快速通道/);
  assert.doesNotMatch(research,/eligible=false|closeTrade\(|openIntelligenceTrade\(/);
  assert.match(store,/hypothesisResearch:\{\.\.\.next\.hypothesisResearch/);
  assert.match(store,/MARKET_HYPOTHESIS_ACTIVE_LIMIT/);
  assert.match(execution,/研究层正在提前推演什么/);
  assert.match(execution,/5 \/ 15 \/ 30 分钟/);
});

test("Forward long-run storage is hot/cold bounded and keeps thesis dedupe outside hot history",async()=>{
  const [store,forward]=await Promise.all([read("lib/forward-store.ts"),read("lib/forward-relations.ts")]);
  assert.match(store,/FORWARD_ACCOUNT_TARGET_BYTES\s*=\s*640\*1024/);
  assert.match(store,/FORWARD_HOT_HISTORY_FULL\s*=\s*32/);
  assert.match(store,/FORWARD_HOT_HISTORY_TOTAL\s*=\s*96/);
  assert.match(store,/function hotProjection/);
  assert.match(store,/compactClosedTrade/);
  assert.match(store,/sourceHistory:next\.history\.length/);
  assert.match(store,/full close record|immutable archive|archive:/i);
  assert.match(forward,/consumedTheses:Record<string,number>/);
  assert.match(forward,/CONSUMED_THESIS_LIMIT=512/);
  assert.match(forward,/rememberConsumedThesis\(s,o\.thesisId,now\)/);
  assert.match(forward,/o\.thesisId&&s\.consumedTheses\[o\.thesisId\]/);
  assert.match(forward,/next\.consumedTheses=\{\.\.\.prior\.consumedTheses\}/);
});


test("counterfactual checkpoints never use far-future current prices as historical evidence",async()=>{
  const research=await read("lib/market-intelligence-research.ts");
  assert.match(research,/CHECKPOINT_QUOTE_TOLERANCE_MS=90_000/);
  assert.match(research,/CHECKPOINT_CANDLE_LAG_MS=6\*60_000/);
  assert.match(research,/CHECKPOINT_UNAVAILABLE_AFTER_MS=7\*60_000/);
  assert.match(research,/unavailableCheckpoints/);
  assert.match(research,/marketAt<=raw\.targetAt\+CHECKPOINT_QUOTE_TOLERANCE_MS/);
  assert.match(research,/if\(!quoteNear&&!candleNear\)return null/);
  assert.doesNotMatch(research,/last\?\.close\?\?fallbackPrice\?\?startPrice/);
  assert.match(research,/pathCoverage:"FULL"\|"PARTIAL"/);
});


test("forward research cannot influence orders from a one-cycle detail change",async()=>{
  const [research,core]=await Promise.all([
    read("lib/market-intelligence-hypothesis-research.ts"),read("lib/forward-relations.ts")
  ]);
  assert.match(research,/targetHitStreak>=2/);
  assert.match(research,/observations>=3/);
  assert.match(research,/now-old\.startedAt>=8\*60_000/);
  assert.match(research,/stableInvalidation/);
  assert.match(research,/status==="CONFIRMED"&&h\.observations>=3&&h\.targetHits>=2/);
  assert.match(research,/decisionBucketAt/);
  const advance=core.slice(core.indexOf("export function advanceForward"),core.indexOf("export function closeForwardForReset"));
  assert.match(advance,/marketReady&&dataDue\)s\.hypothesisResearch=advanceMarketHypothesisResearch/);
  assert.match(advance,/built\.state\.narrative=priorNarrative/);
  const manage=core.slice(core.indexOf("function manageIntelligenceTrades"),core.indexOf("function markAndManage"));
  assert.doesNotMatch(manage,/if\(position\.decision==="EXIT"\)/);
  assert.match(manage,/initialExpectedNetRate/);
});


test("extreme residual magnitude cannot bypass stability confirmation after repeated symbol losses",async()=>{
  const core=await read("lib/forward-relations.ts");
  assert.match(core,/extremeResidualConfirmationProfile/);
  assert.match(core,/Math\.abs\(input\.residual\)>=\.05/);
  assert.match(core,/recentExtremeLosses/);
  assert.match(core,/minimumElapsedMs/);
  assert.match(core,/极端残差机会不按偏离幅度直接追单/);
});


test("profit platforms are discrete milestones, not continuous peak trailing stops",async()=>{
  const lifecycle=await read("lib/market-intelligence-lifecycle.ts");
  assert.match(lifecycle,/provenTrigger1/);
  assert.match(lifecycle,/provenTrigger2/);
  assert.match(lifecycle,/provenTrigger3/);
  assert.match(lifecycle,/platformLevel=runner\?runnerLevel:provenLevel/);
  assert.match(lifecycle,/普通新高不会逐tick追价/);
  assert.doesNotMatch(lifecycle,/provenPlatformNet=.*peakNet\*\.30/);
  assert.doesNotMatch(lifecycle,/runnerPlatformNet=.*peakNet\*/);
});


test("high-quality entries keep stable thesis authority through shallow realtime noise and forbid late chasing",async()=>{
  const [core,response]=await Promise.all([
    read("lib/forward-relations.ts"),read("lib/market-intelligence-entry-response.ts")
  ]);
  assert.match(response,/action:"WAIT"\|"PASS"\|"RETEST"\|"CANCEL"/);
  assert.match(response,/allowRetest/);
  assert.match(response,/保留武装状态/);
  assert.match(core,/stableEntryThesisProfile/);
  assert.match(core,/stableEntryLocationDecision/);
  assert.match(core,/phase\?:"ARMED"\|"RETEST_WAIT"/);
  const seed=core.slice(core.indexOf("function seedEntryResponses"),core.indexOf("function advanceEntryResponses"));
  assert.doesNotMatch(seed,/s\.entryValidations=\{\};/);
  assert.match(seed,/preserved:Record<string,EntryValidation>/);
  const advance=core.slice(core.indexOf("function advanceEntryResponses"),core.indexOf("export function fillForwardPortfolio"));
  assert.match(advance,/decision\.action==="RETEST"/);
  assert.match(advance,/超过允许追价/);
  assert.match(advance,/stableEntryLocationDecision/);
  assert.match(advance,/delete s\.entryValidations\[validation\.id\]/);
  assert.doesNotMatch(advance,/opened=1;s\.entryValidations=\{\}/);
  assert.match(core,/2秒级浅反向只能转为RETEST_WAIT/);
});


test("execution page always exposes entry execution state independently of top candidate ranking",async()=>{
  const execution=await read("app/market-intelligence-execution.tsx");
  assert.match(execution,/入场执行状态/);
  assert.match(execution,/不受候选榜前8名限制/);
  assert.match(execution,/等回调重启/);
  assert.match(execution,/已武装/);
  assert.match(execution,/本假设已取消/);
  assert.match(execution,/当前没有已武装或等待回调的入场假设/);
  assert.match(execution,/entryValidations\.map/);
});


test("Market Intelligence routes every environment to an active playbook instead of pausing trading",async()=>{
  const [router,core,execution,store]=await Promise.all([
    read("lib/market-intelligence-environment-router.ts"),read("lib/forward-relations.ts"),
    read("app/market-intelligence-execution.tsx"),read("lib/forward-store.ts")
  ]);
  for(const token of["TREND_CAPTURE","TRANSITION_PROBE","ROTATION_RELATIVE","SHOCK_PARTICIPATION"])
    assert.match(router,new RegExp(token));
  assert.match(router,/classifyMarketEnvironment/);
  assert.match(router,/environmentPerformanceFactor/);
  assert.match(router,/environmentProbeRetestDecision/);
  assert.match(router,/clip\(factor,.55,1.10\)/);
  assert.match(router,/riskScale:finalRisk/);
  assert.doesNotMatch(router,/riskScale:0/);
  assert.match(core,/environmentRiskScale=clip\(o\.environmentRiskScale\?\?1,.20,1.10\)/);
  assert.match(core,/minimumEffectiveRisk=equity\*\(o\.environmentProbe\?\.0010:.0035\)/);
  assert.match(core,/requiresProbeRetest/);
  assert.match(core,/主线参与通道/);
  assert.match(core,/next\.environmentPerformance=structuredClone\(prior\.environmentPerformance\)/);
  assert.match(core,/environmentRouter:\{\.\.\.s\.environmentContext,currentEnvironment:s\.environmentContext\.environment/);
  assert.match(core,/environmentContext:\{version:ENVIRONMENT_ROUTER_VERSION/);
  assert.match(execution,/当前市场环境与交易打法/);
  assert.match(execution,/始终保留参与权/);
  assert.match(execution,/趋势捕获|转折验证|相对强弱|主线参与/);
  assert.match(store,/account=\{\.\.\.next/,"environment performance memory must stay inside the bounded persisted account projection");
});

test("transition countertrend routes through Probe-Prove-Restart, not a static no-trade filter",async()=>{
  const [core,router]=await Promise.all([
    read("lib/forward-relations.ts"),read("lib/market-intelligence-environment-router.ts")
  ]);
  assert.match(router,/COUNTER/);
  assert.match(router,/forceRetest=true/);
  assert.match(router,/继续交易但风险缩放/);
  const advance=core.slice(core.indexOf("function advanceEntryResponses"),core.indexOf("export function fillForwardPortfolio"));
  assert.match(advance,/环境Probe尚未证明方向/);
  assert.match(advance,/第一段推动已出现/);
  assert.match(advance,/Probe已完成第一段推动和可控回调/);
  assert.match(advance,/Probe已回调，等待原方向重新推进/);
});


test("environment router has no direct-fill bypass and keeps regime memory across account reset",async()=>{
  const core=await read("lib/forward-relations.ts");
  const fill=core.slice(core.indexOf("export function fillForwardPortfolio"),core.indexOf("function nextCandleAt"));
  assert.match(fill,/environmentForceRetest/);
  assert.match(fill,/Probe→回调→再启动/);
  assert.match(core,/next\.environmentPerformance=structuredClone\(prior\.environmentPerformance\)/);
  assert.match(core,/next\.environmentContext=structuredClone\(prior\.environmentContext\)/);
  assert.match(core,/recordEnvironmentOutcome\(s\.environmentPerformance/);
  assert.match(core,/environmentRiskScale=clip\(o\.environmentRiskScale\?\?1,.20,1.10\)/);
});


test("LIVE mirror readiness uses fresh executable BBO, not PAPER entryReady admission state",async()=>{
  const [worker,parity]=await Promise.all([read("worker/index-clean.ts"),read("lib/live-parity.ts")]);
  const start=worker.indexOf("private mirrorQuoteReady");
  const end=worker.indexOf("private async queueLiveBinding",start);
  const block=worker.slice(start,end);
  assert.match(block,/contractMeta\[symbol\]!=null/);
  assert.match(block,/freshQuote/);
  assert.doesNotMatch(block,/entryReady===true/);
  assert.match(parity,/LIVE_SOURCE_ENTRY_MAX_DELAY_MS = 30_000/,"late-copy protection must remain in the LIVE sizing path");
});


test("LIVE copy actively refreshes Gate BBO after private reconciliation ages the PAPER quote",async()=>{
  const worker=await read("worker/index-clean.ts");
  const refreshStart=worker.indexOf("private async refreshMirrorExecutableQuotes");
  const refreshEnd=worker.indexOf("private async queueLiveBinding",refreshStart);
  const refresh=worker.slice(refreshStart,refreshEnd);
  assert.match(refresh,/processAdaptiveBooks\(Date\.now\(\),executable\)/);
  assert.match(refresh,/do not re-run|do not re-run/i);
  const syncStart=worker.indexOf("private async syncLiveOnce");
  const syncEnd=worker.indexOf("protected async setLiveMode",syncStart);
  const sync=worker.slice(syncStart,syncEnd);
  assert.match(sync,/refreshMirrorExecutableQuotes\(this\.forwardState!\.positions\.map\(t=>t\.symbol\),Date\.now\(\)\)/);
  assert.match(sync,/ensureMirrorExecutableQuote\(symbol,Date\.now\(\)\)/);
});


test("LIVE eligible source cannot hide behind generic quote/account waiting after a healthy pass",async()=>{
  const [worker,parity]=await Promise.all([read("worker/index-clean.ts"),read("lib/live-parity.ts")]);
  const syncStart=worker.indexOf("private async syncLiveOnce");
  const syncEnd=worker.indexOf("protected async setLiveMode",syncStart);
  const sync=worker.slice(syncStart,syncEnd);
  assert.match(worker,/private async mirrorSubmitQuote/);
  assert.match(worker,/freshQuote\([\s\S]*2_000/);
  assert.match(sync,/finalValidatedAt/);
  assert.match(sync,/code:"RETRYING"/);
  assert.match(sync,/No eligible source may leave a completed healthy reconciliation as an/);
  assert.match(parity,/unclassifiedWaitingCount/);
  assert.doesNotMatch(parity,/等待当前报价、账户与交易所确认/);
});


test("LIVE stop amend preserves Gate int64 identity without a Number round-trip",async()=>{
  const gate=await read("lib/gate-live.ts");
  const start=gate.indexOf("async amendStop(orderId: string");
  const end=gate.indexOf("\n  async cancelOrder",start);
  const block=gate.slice(start,end);
  assert.match(block,/rawBody=.*"order_id":\\?\$\{orderId\}/);
  assert.match(block,/price_orders\/amend/);
  assert.doesNotMatch(block,/Number\(orderId\)|parseInt\(orderId/);
  assert.doesNotMatch(block,/order_id:\s*orderId/);
});
