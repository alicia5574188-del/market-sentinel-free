import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [scanner, gateClient, marketRoute, v2Route, hteRoute, hte31Worker, hte31Recovery, strategyRepo, liveRepo, liveRisk, heavyUiAdmission] = await Promise.all([
  readFile(new URL("../lib/scanner.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/gate-client.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/market/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/v2/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/hte/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../worker/hte31-workers.ts", import.meta.url), "utf8"),
  readFile(new URL("../worker/hte31-recovery-manager.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/live-trading-repository.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/live-risk.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/ui-heavy-read-admission.ts", import.meta.url), "utf8"),
]);

test("deep scans stay below Cloudflare outgoing-connection ceiling and Free HTE serializes the extra candle request", () => {
  assert.match(scanner, /analyzeTargetsBounded/);
  assert.match(scanner, /offset \+= DEEP_TARGET_CONCURRENCY/);
  assert.doesNotMatch(scanner, /Promise\.allSettled\(targets\.map/);

  const targetConcurrency = Number(scanner.match(/DEEP_TARGET_CONCURRENCY\s*=\s*(\d+)/)?.[1]);
  const upstreamConcurrency = Number(gateClient.match(/ANALYSIS_UPSTREAM_CONCURRENCY\s*=\s*(\d+)/)?.[1]);
  assert.equal(targetConcurrency, 1);
  assert.equal(upstreamConcurrency, 4);

  const freeBranch = scanner.match(/if \(freeBackground\) \{[\s\S]*?const packet = await analyze\(\);[\s\S]*?const growthData = await growth\(\);[\s\S]*?return \{ packet, ticker, growthCandles: growthData\.candles, growthError: growthData\.error \};[\s\S]*?\}/)?.[0] ?? "";
  assert.ok(freeBranch, "Free HTE must complete deep analysis before starting the extra 18h candle request");
  assert.doesNotMatch(freeBranch, /Promise\.all\(\[analyze\(\), growth\(\)\]\)/);

  // In Free background the extra 18h candle request is no longer concurrent
  // with analyzeGateSymbol, so the live peak is the Gate client's bounded four.
  const freePeakOutgoingConnections = targetConcurrency * upstreamConcurrency;
  assert.ok(
    freePeakOutgoingConnections <= 6,
    `Free HTE scan can open ${freePeakOutgoingConnections} simultaneous outgoing connections, above Cloudflare ceiling`,
  );
});

test("selected market UI keeps the last trustworthy snapshot across transient Gate failures", () => {
  assert.match(marketRoute, /LAST_GOOD_TTL_MS\s*=\s*90_000/);
  assert.match(marketRoute, /lastGoodBySymbol/);
  assert.match(marketRoute, /staleFallback:\s*true/);
  assert.match(marketRoute, /X-Sentinel-Stale-Fallback/);
  assert.match(marketRoute, /if \(fallback\) return fallback/);
});

test("heavy foreground market reads still fail fast while retired Strategy 2 can no longer compete for the Worker isolate", () => {
  assert.match(heavyUiAdmission, /STALE_LEASE_MS\s*=\s*30_000/);
  assert.match(heavyUiAdmission, /acquireHeavyUiRead/);
  assert.match(heavyUiAdmission, /status:\s*429/);
  assert.match(heavyUiAdmission, /X-Sentinel-Load-Shed/);
  assert.match(marketRoute, /acquireHeavyUiRead\(`\/api\/market:\$\{symbol\}`\)/);
  assert.match(marketRoute, /heavyUiReadBusyResponse\("\/api\/market"\)/);
  assert.match(marketRoute, /finally\s*\{\s*lease\.release\(\);\s*\}/);
  assert.match(v2Route, /retiredLegacyApi/);
  assert.doesNotMatch(v2Route, /acquireHeavyUiRead|heavyUiReadBusyResponse|getStrategy2LearningDashboard|listRecentV2Opportunities/);
});

test("retired Strategy 2 dashboard performs no learning, counterfactual, opportunity or thesis reads", () => {
  assert.match(v2Route, /retiredLegacyApi/);
  assert.doesNotMatch(v2Route, /HEAVY_CACHE_MS|INTERACTIVE_LEARNING_LIMIT|INTERACTIVE_OPPORTUNITY_LIMIT|INTERACTIVE_THESIS_LIMIT/);
  assert.doesNotMatch(v2Route, /getStrategy2LearningDashboard|listRecentV2Opportunities|listV2TradeTheses/);
  assert.doesNotMatch(v2Route, /cachedLearning|cachedCounterfactual|Promise\.allSettled|optionalSourceErrors/);
});

test("legacy HTE foreground route cannot re-enter position management; HTE31 Trade Manager owns 24\/7 safety management", () => {
  assert.match(hteRoute, /retiredLegacyApi/);
  assert.doesNotMatch(hteRoute, /refreshOpenPositions|recoverOverdueSimulationTimeouts|runMarketScan|evaluateHumanTraderPool/);
  assert.match(hte31Worker, /export class HTE31TradeManager/);
  assert.match(hte31Worker, /listHte31OpenTrades/);
  assert.match(hte31Worker, /fetchGatePositionQuotes/);
  assert.match(hte31Worker, /applyHte31PositionQuote/);
  assert.match(hte31Worker, /nextHte31PostExitObservation/);
  assert.match(hte31Recovery, /replayStaleTrade/);
  assert.match(hte31Recovery, /await super\.alarm\(\)/);
});

test("same human trader cools itself after repeated losses without freezing the other traders", () => {
  assert.match(strategyRepo, /type TraderGuard/);
  assert.match(strategyRepo, /"ACTIVE" \| "COOLDOWN" \| "PAUSED"/);
  assert.match(strategyRepo, /lossStreak >= 2/);
  assert.match(strategyRepo, /120 \* 60_000/);
  assert.match(strategyRepo, /lossStreak >= 3/);
  assert.match(strategyRepo, /360 \* 60_000/);
  assert.match(strategyRepo, /traderGuardForSignal/);
  assert.match(strategyRepo, /guard && guard\.state !== "ACTIVE"/);
  assert.match(strategyRepo, /Dennis \/ Raschke \/ Turtle Soup 互不连坐/);
});

test("global Human Risk Governor requires cross-trader damage before streak escalation", () => {
  assert.match(strategyRepo, /streakTraderIds\.size >= 2 \? lossStreak : 0/);
  assert.match(strategyRepo, /hasCrossTraderEvidence = allTraderIds\.size >= 2/);
  assert.match(strategyRepo, /diversifiedLossStreak >= 8[\s\S]*"PAUSED"/);
  assert.match(strategyRepo, /diversifiedLossStreak >= 6[\s\S]*"DEFENSIVE"/);
  assert.match(strategyRepo, /diversifiedLossStreak >= 4[\s\S]*"CAUTION"/);
  assert.match(strategyRepo, /单一交易员，只由该交易员独立熔断，不升级全局门槛/);
  assert.match(strategyRepo, /governor\.state === "PAUSED"[\s\S]*return false/);
  assert.match(strategyRepo, /governor\.state === "CAUTION"/);
  assert.match(strategyRepo, /tradeMode === "exploration"[\s\S]*signal\.confidence >= 84/);
  assert.match(strategyRepo, /governor\.state === "DEFENSIVE"/);
  assert.match(strategyRepo, /tradeMode === "high_conviction"/);
  assert.match(strategyRepo, /experienceSamples[\s\S]*>= 12/);
  assert.match(strategyRepo, /expectancyR[\s\S]*>= 0\.12/);
});

test("Human Risk Governor can only reduce HTE live size and Gate independently rechecks current execution safety", () => {
  // The governor is already reflected in the HTE paper order's risk/notional.
  // Live must carry that bounded notional forward, never recreate the retired
  // contract_v2 multiplier path, and then independently cap it again from the
  // current Gate equity, available isolated margin, contract size and fees.
  assert.match(liveRepo, /contractNotionalUsdt:\s*row\.notionalUsdt/);
  assert.doesNotMatch(liveRepo, /entryRiskMultiplier\(/);
  assert.match(liveRisk, /candidateRiskBudgetUsdt\s*=\s*Math\.max\(0, trade\.contractNotionalUsdt \* candidateStopDistanceFraction\)/);
  assert.match(liveRisk, /riskBudgetUsdt\s*=\s*Math\.min\(accountRiskBudgetUsdt, candidateRiskBudgetUsdt \|\| accountRiskBudgetUsdt\)/);
  assert.match(liveRisk, /Math\.min\([\s\S]*trade\.contractNotionalUsdt,[\s\S]*riskNotionalCap,[\s\S]*marginAllocationUsdt \* trade\.leverage/);
  assert.match(liveRisk, /Gate 实际张数计算的止损风险超过该 HTE 3\.1 候选风险上限/);
});
