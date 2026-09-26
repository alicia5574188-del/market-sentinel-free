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
  for(const venue of["BYBIT","OKX","KUCOIN","BITGET","BINANCE"])assert.match(hub,new RegExp(venue));
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


test("Market Intelligence uses thesis lifecycle, not scalp profit locking or batch spraying",async()=>{
  const core=await read("lib/forward-relations.ts"),engine=await read("lib/market-intelligence-engine.ts");
  const manage=core.slice(core.indexOf("function manageIntelligenceTrades"),core.indexOf("function markAndManage"));
  assert.doesNotMatch(manage,/利润保护提升|PROFIT_GIVEBACK/);
  assert.match(manage,/已移除旧式动态锁利/);
  assert.match(manage,/invalidationBars:t\.relationFailureBars/);
  const fill=core.slice(core.indexOf("export function fillForwardPortfolio"),core.indexOf("function nextCandleAt"));
  assert.match(fill,/opened=1;break/);
  const advance=core.slice(core.indexOf("export function advanceForward"),core.indexOf("export function closeForwardForReset"));
  assert.match(advance,/marketReady&&dataDue\?fillForwardPortfolio/);
  assert.doesNotMatch(advance,/rotateIfNeeded\(/);
  assert.match(engine,/thesisId=.*row\.signalSince/);
  assert.match(engine,/signalBars>=2/);
  assert.match(engine,/stableBias/);
  const boundaries=core.slice(core.indexOf("boundaries:{scope"));
  assert.match(boundaries,/Market Intelligence 不使用动态锁利/);
});
