import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [scanner, marketRoute, v2Route, strategyRepo] = await Promise.all([
  readFile(new URL("../lib/scanner.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/market/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/v2/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8"),
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

test("Strategy 2 dashboard isolates optional failures and caches bounded heavy learning reads", () => {
  assert.match(v2Route, /HEAVY_CACHE_MS\s*=\s*60_000/);
  assert.match(v2Route, /INTERACTIVE_LEARNING_LIMIT\s*=\s*800/);
  assert.match(v2Route, /getStrategy2LearningDashboard\(INTERACTIVE_LEARNING_LIMIT\)/);
  assert.match(v2Route, /cachedLearning/);
  assert.match(v2Route, /cachedCounterfactual/);
  assert.match(v2Route, /Promise\.allSettled/);
  assert.match(v2Route, /optionalSourceErrors/);
  assert.doesNotMatch(v2Route, /status:\s*503/);
});

test("persistent losses switch Strategy 2 execution into defense and exploration cannot silently use full base risk", () => {
  assert.match(strategyRepo, /state:\s*"NORMAL" \| "DEFENSIVE"/);
  assert.match(strategyRepo, /averageNetPct[\s\S]*recentAverageNetPct/);
  assert.match(strategyRepo, /tradeMode === "exploration"\) return false/);
  assert.match(strategyRepo, /signalRiskMultiplier\(signal\) < 0\.95/);
  assert.match(strategyRepo, /tradeMode === "high_conviction"/);
  assert.match(strategyRepo, /experienceSamples[\s\S]*>= 12/);
  assert.match(strategyRepo, /expectancyR[\s\S]*>= 0\.12/);
  assert.match(strategyRepo, /v2-risk-multiplier/);
});