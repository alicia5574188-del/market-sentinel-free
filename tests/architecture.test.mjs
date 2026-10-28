import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("runtime cannot reset PAPER during a strategy revision",async()=>{
  const worker=await read("worker/index-clean.ts");
  assert.match(worker,/private async ensureAdaptiveAccount/);
  const advance=worker.slice(worker.indexOf("private async advanceForwardNow"),worker.indexOf("private async refreshRegimeHourly"));
  assert.doesNotMatch(advance,/prepareForwardReset|initialMultiTurnForward\(/);
});

test("LIVE execution infrastructure stays isolated and serialized after PAPER commit",async()=>{
  const [worker,parity,live,member]=await Promise.all([read("worker/index-clean.ts"),read("lib/live-parity.ts"),read("lib/gate-live.ts"),read("worker/member-executor.ts")]);
  assert.match(live,/class GateLiveClient/);assert.match(member,/forwardMirrorSources/);
  assert.doesNotMatch(parity,/LIVE_SOURCE_ENTRY_MAX_DELAY_MS|实时复制窗口/);
  assert.match(parity,/mirrorSourceFresh\(t,t\.id,input\.now\)/);assert.match(parity,/liveEntryDriftGuard\(t,input\.entryPrice\)/);
  assert.match(parity,/minimumUplift/);
  assert.match(live,/throw new GateReadTimeoutError\(path\)/);
  const sync=worker.slice(worker.indexOf("protected async syncLive"),worker.indexOf("private suspendSymbol"));
  assert.match(sync,/desiredTrades=Object\.values\(desiredPortfolio\)\.sort/);
  assert.match(sync,/let snapshot=await client\.snapshot\(\(positions,at\)=>this\.prioritizeCommittedSourceCloses\(client,positions,at\)\)/);
  assert.match(sync,/entry\.exchangeOrderId = await client\.createEntry\(intent,submissionStillAllowed\)/);
  assert.doesNotMatch(sync,/staged\.length>=2/);
  const alarm=worker.slice(worker.indexOf("  async alarm(info?"),worker.indexOf("  async fetch(request:",worker.indexOf("  async alarm(info?")));
  assert.ok(alarm.indexOf("await this.advanceForwardNow(Date.now(),false)")>=0);
  assert.ok(alarm.indexOf("await this.syncLive(liveStarted)")>alarm.indexOf("await this.advanceForwardNow(Date.now(),false)"));
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


test("legacy /forward bookmark resolves before the page router and render faults are contained",async()=>{
  const worker=await read("worker/index-clean.ts");
  assert.match(worker,/url\.pathname==="\/forward"/);
  assert.match(worker,/Response\.redirect\(target\.toString\(\),307\)/);
  assert.match(worker,/page-handler-failure/);
  assert.match(worker,/页面正在自动恢复/);
});

test("LIVE mirror readiness uses fresh executable BBO, not PAPER entryReady admission state",async()=>{
  const [worker,parity]=await Promise.all([read("worker/index-clean.ts"),read("lib/live-parity.ts")]);
  const start=worker.indexOf("private mirrorQuoteReady");
  const end=worker.indexOf("private async queueLiveBinding",start);
  const block=worker.slice(start,end);
  assert.match(block,/contractMeta\[symbol\]!=null/);
  assert.match(block,/freshQuote/);
  assert.doesNotMatch(block,/entryReady===true/);
  assert.doesNotMatch(parity,/LIVE_SOURCE_ENTRY_MAX_DELAY_MS|实时复制窗口/,"infrastructure delay must not permanently expire an otherwise-valid source");
  assert.match(parity,/mirrorSourceFresh\(t,t\.id,input\.now\)/);
  assert.match(parity,/当前价已越过源单止损/);
  assert.match(parity,/liveEntryDriftGuard\(t,input\.entryPrice\)/);
});


test("LIVE structural stops use create-confirm-cancel replacement and never Gate TP/SL amend",async()=>{
  const [worker,gate]=await Promise.all([read("worker/index-clean.ts"),read("lib/gate-live.ts")]);
  const start=worker.indexOf("private async ensureLiveStop"),end=worker.indexOf("private systemEntryOrders",start),block=worker.slice(start,end);
  assert.doesNotMatch(block,/\.amendStop\(/);
  assert.doesNotMatch(gate,/async amendStop\(/);
  assert.match(block,/replacementStopTag/);
  assert.match(block,/replacementStopOrderId/);
  assert.match(block,/await client\.createStop\(stop\)/);
  assert.match(block,/await client\.cancelOrder\("PRICE_TRIGGER",position\.stopOrderId\)/);
  assert.match(block,/两张均为 close-only/);
});

test("LIVE page exposes recoverable copy status without a fixed realtime-copy window",async()=>{
  const ui=await read("app/live-console.tsx");
  assert.doesNotMatch(ui,/超过实时复制窗口/);
  assert.match(ui,/copyPending/);
  assert.match(ui,/SUBMISSION_UNCONFIRMED/);
  assert.match(ui,/\(mirror\?\.rows\?\?\[\]\)\.filter/);
  assert.match(ui,/r\.reason\?\?r\.status/);
  assert.match(ui,/confirmEnable&&!enabled/);
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
