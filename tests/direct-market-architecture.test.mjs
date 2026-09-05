import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [scanner, worker, activity, repository, liveRepository, page, migration, execution, positionBrain, types, setupGuard] = await Promise.all([
  readFile(new URL("../lib/hte31-scanner.ts", import.meta.url), "utf8"),
  readFile(new URL("../worker/hte31-workers.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/direct-market-activity.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/hte31-repository.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/live-trading-repository.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0017_direct_market_brain.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/direct-market-execution.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/direct-market-position-brain.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/direct-market-types.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/direct-market-setup-guard.ts", import.meta.url), "utf8"),
]);

test("new-entry scanner has no legacy strategy authority or high-frequency D1 writes", () => {
  for (const forbidden of ["evaluateHumanTraderPool", "evaluateAdvancedHumanTraders", "evaluateHte31ResearchStrategies", "recordHte31Evaluations", "recordHte31DiagnosticCycle", "tryOpenResonanceTrade"]) {
    assert.doesNotMatch(scanner, new RegExp(forbidden));
  }
  assert.match(scanner, /buildDirectMarketCandidate/);
  assert.match(worker, /freshCohort\.length >= 3/);
  assert.match(worker, /freshReady\.slice\(0, 3\)/);
  assert.match(worker, /for \(const \[index, candidate\] of finalists\.entries\(\)\)/);
  assert.match(worker, /SCANNER_CYCLE_INTERVAL_MS = 25_000/);
  assert.match(worker, /fetchGatePositionQuotes/);
  assert.match(execution, /validateDirectMarketEntry/);
  assert.match(worker, /recordDirectTwelveHourActivity/);
  assert.match(worker, /activity12h/);
  assert.match(activity, /row\.evaluations \+ 1/);
  assert.match(activity, /triggeredSignals/);
  assert.match(activity, /coverageMs >= minimumCoverage/);
  assert.match(repository, /buildDirectSetupPerformance/);
  assert.match(types, /HT3-R_FAILED_AUCTION/);
  assert.match(types, /HT4_EXHAUSTION_ANTI_CROWD/);
  assert.match(types, /RESONANCE_V1_WITH_HT5-R_TIMING/);
  assert.match(execution, /getDirectSetupGuardDecision/);
  assert.match(setupGuard, /losingStreak >= 3/);
});

test("adaptive position decisions use completed candles without adding periodic D1 writes", () => {
  assert.match(positionBrain, /action: "HOLD" \| "PROTECT" \| "EXIT"/);
  assert.match(positionBrain, /candleTime\(candle\) < completedBoundary/);
  assert.match(positionBrain, /brain_invalidation/);
  assert.match(worker, /positionReviewBuckets/);
  assert.match(repository, /positionDecisionMetrics/);
});

test("post-exit truth chain has all seven nodes and data quality isolation", () => {
  assert.match(repository, /\[0, 30, 60, 120, 240, 480, 720\]/);
  assert.match(repository, /coveragePct >= 95/);
  assert.match(repository, /MAX_POST_EXIT_RETRIES = 4/);
  assert.match(repository, /status: terminal \? "complete" : "pending"/);
  assert.match(repository, /nextRetryAt/);
  assert.match(repository, /decisionAuthority !== "direct_market_brain"/);
  assert.match(repository, /complete && trade\.decisionAuthority === "direct_market_brain"/);
  assert.match(migration, /quality_status/);
  assert.match(migration, /retry_count/);
  assert.match(migration, /next_retry_at/);
});

test("live entry accepts only the exact direct-brain simulated lineage", () => {
  assert.match(liveRepository, /new Set<string>\(\["direct_market_brain"\]\)/);
  assert.match(liveRepository, /entryTrigger\.startsWith\("DIRECT_MARKET_BRAIN"\)/);
  assert.match(liveRepository, /row\.decisionAuthority === "direct_market_brain"/);
});

test("phone UI exposes direct brain contribution and review without an abstract radar page", () => {
  assert.match(page, /谁在发力，谁在拖后腿/);
  assert.match(page, /每12小时总结/);
  assert.match(page, /全量评估/);
  assert.match(page, /原始触发/);
  assert.match(page, /入场拦截/);
  assert.match(page, /<DecisionEvidenceCard/);
  assert.match(page, /const NAV: Tab\[\] = \["大脑", "订单", "管理"\]/);
  const rendered = page.slice(page.indexOf("return <main"));
  assert.doesNotMatch(rendered, /9 个家族|13 个独立变体|策略中心|市场雷达|成交额前十五/);
});
