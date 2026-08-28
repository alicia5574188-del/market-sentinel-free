import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [scanner, marketRoute, v2Route, hteRoute, strategyRepo, liveRepo, heavyUiAdmission] = await Promise.all([
  readFile(new URL("../lib/scanner.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/market/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/v2/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/hte/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/live-trading-repository.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/ui-heavy-read-admission.ts", import.meta.url), "utf8"),
]);

test("deep scans bound symbol-level upstream fanout instead of bursting every target at once", () => {
  assert.match(scanner, /DEEP_TARGET_CONCURRENCY\s*=\s*2/);
  assert.match(scanner, /analyzeTargetsBounded/);
  assert.match(scanner, /offset \+= DEEP_TARGET_CONCURRENCY/);
  assert.doesNotMatch(scanner, /Promise\.allSettled\(targets\.map/);
});

test("selected market UI keeps the last trustworthy snapshot across transient Gate failures", () => {
  assert.match(marketRoute, /LAST_GOOD_TTL_MS\s*=\s*90_000/);
  assert.match(marketRoute, /lastGoodBySymbol/);
  assert.match(marketRoute, /staleFallback:\s*true/);
  assert.match(marketRoute, /X-Sentinel-Stale-Fallback/);
  assert.match(marketRoute, /if \(fallback\) return fallback/);
});

test("heavy foreground market and Strategy 2 reads fail fast instead of competing inside one Worker isolate", () => {
  assert.match(heavyUiAdmission, /STALE_LEASE_MS\s*=\s*30_000/);
  assert.match(heavyUiAdmission, /acquireHeavyUiRead/);
  assert.match(heavyUiAdmission, /status:\s*429/);
  assert.match(heavyUiAdmission, /X-Sentinel-Load-Shed/);
  assert.match(marketRoute, /acquireHeavyUiRead\(`\/api\/market:\$\{symbol\}`\)/);
  assert.match(marketRoute, /heavyUiReadBusyResponse\("\/api\/market"\)/);
  assert.match(marketRoute, /finally\s*\{\s*lease\.release\(\);\s*\}/);
  assert.match(v2Route, /acquireHeavyUiRead\("\/api\/v2"\)/);
  assert.match(v2Route, /heavyUiReadBusyResponse\("\/api\/v2"\)/);
  assert.match(v2Route, /finally\s*\{\s*lease\.release\(\);\s*\}/);
});

test("Strategy dashboard isolates optional failures and bounds heavy interactive reads", () => {
  assert.match(v2Route, /HEAVY_CACHE_MS\s*=\s*60_000/);
  assert.match(v2Route, /INTERACTIVE_LEARNING_LIMIT\s*=\s*400/);
  assert.match(v2Route, /INTERACTIVE_OPPORTUNITY_LIMIT\s*=\s*60/);
  assert.match(v2Route, /INTERACTIVE_THESIS_LIMIT\s*=\s*40/);
  assert.match(v2Route, /getStrategy2LearningDashboard\(INTERACTIVE_LEARNING_LIMIT\)/);
  assert.match(v2Route, /listRecentV2Opportunities\(INTERACTIVE_OPPORTUNITY_LIMIT\)/);
  assert.match(v2Route, /listV2TradeTheses\(INTERACTIVE_THESIS_LIMIT\)/);
  assert.match(v2Route, /cachedLearning/);
  assert.match(v2Route, /cachedCounterfactual/);
  assert.match(v2Route, /Promise\.allSettled/);
  assert.match(v2Route, /optionalSourceErrors/);
  assert.doesNotMatch(v2Route, /status:\s*503/);
});

test("HTE snapshot has a throttled safety-only fallback for stale or overdue open positions", () => {
  assert.match(hteRoute, /POSITION_UI_STALE_MS\s*=\s*45_000/);
  assert.match(hteRoute, /POSITION_SAFETY_REFRESH_GAP_MS\s*=\s*30_000/);
  const safety = hteRoute.match(/async function refreshStaleOpenPositionsForSafety\(\)[\s\S]*?\n}/)?.[0] ?? "";
  assert.match(safety, /now - trade\.lastEvaluatedAt > POSITION_UI_STALE_MS/);
  assert.match(safety, /trade\.maxHoldingMinutes \* 60_000/);
  assert.match(safety, /refreshOpenPositions\(null, \{ includeDashboard: false \}\)/);
  assert.doesNotMatch(safety, /runMarketScan|processShadowStrategies|evaluateHumanTraderPool/);
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

test("global Human Risk Governor reacts later than trader-level circuit breakers", () => {
  assert.match(strategyRepo, /lossStreak >= 8[\s\S]*"PAUSED"/);
  assert.match(strategyRepo, /lossStreak >= 6[\s\S]*"DEFENSIVE"/);
  assert.match(strategyRepo, /lossStreak >= 4[\s\S]*"CAUTION"/);
  assert.match(strategyRepo, /governor\.state === "PAUSED"[\s\S]*return false/);
  assert.match(strategyRepo, /governor\.state === "CAUTION"/);
  assert.match(strategyRepo, /tradeMode === "exploration"[\s\S]*signal\.confidence >= 84/);
  assert.match(strategyRepo, /governor\.state === "DEFENSIVE"/);
  assert.match(strategyRepo, /tradeMode === "high_conviction"/);
  assert.match(strategyRepo, /experienceSamples[\s\S]*>= 12/);
  assert.match(strategyRepo, /expectancyR[\s\S]*>= 0\.12/);
});

test("Human Risk Governor can only reduce live candidate size and Gate still rechecks execution safety", () => {
  assert.match(liveRepo, /item\.key === "human-risk-mode"/);
  assert.match(liveRepo, /Math\.max\(0, Math\.min\(1, metric\.score\)\)/);
  assert.match(liveRepo, /riskBudgetUsdt:\s*row\.riskBudgetUsdt \* multiplier/);
  assert.match(liveRepo, /contractNotionalUsdt:\s*row\.contractNotionalUsdt \* multiplier/);
  assert.match(liveRepo, /live entry planner still independently rechecks current equity/);
});
