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
  assert.match(scanner, /buildAnalogCandidate/);
  assert.doesNotMatch(worker, /freshCohort\.length >= 3/);
  assert.match(worker, /fetchGatePositionQuotes\(executable\.map/);
  assert.match(worker, /currentForecast/);
  assert.match(worker, /SCANNER_CYCLE_INTERVAL_MS = 60_000/);
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
  assert.match(types, /HT5-R_MARKET_FIT_STRUCTURE_RECOVERY_V5/);
  assert.match(scanner, /market:.*job\.market/);
  assert.match(execution, /scalpAccountRisk/);
  assert.match(setupGuard, /losingStreak >= 3/);
});

test("five-minute pullback is the only active producer; analogue builder remains auxiliary", async () => {
  const brain = await readFile(new URL("../lib/direct-market-brain.ts", import.meta.url), "utf8");
  assert.match(brain, /buildHistoricalForecast/);
  assert.doesNotMatch(brain, /evaluateCoreSetups|normalizedPaths|EXHAUSTION_REVERSAL/);
  assert.match(liveRepository, /当前策略处于模拟验证阶段/);
});

test("configured scan coverage and risk-based capacity reach the production boundary", () => {
  assert.match(scanner, /fetchUniverse\(1,\s*HISTORICAL_UNIVERSE\)/);
  assert.match(scanner, /historicalUniverse\(await marketExchange/);
  assert.match(scanner, /job\.universe\.map/);
  assert.match(worker, /candidate\.observedAt\]\)\)/);
  assert.doesNotMatch(worker, /universe\.slice\(0, 15\)/);
  assert.doesNotMatch(execution, /account\.open\.length >= 3|maximumOpenPositions: 3|sameDirectionMaximum: 2/);
  assert.match(execution, /directMarketPositionCheckpointRows\(account\.open\.length \+ 1, todayRows\.map/);
  assert.match(execution, /gte\(hte31Trades\.exitAt, today\)/);
  assert.match(execution, /hte31PaperPortfolioBlockReason/);
  assert.match(execution, /analogRiskAllocation/);
  assert.match(page, /合计不超过12.00%/);
  assert.match(execution, /minimumTp2NetProfitUsdt: ANALOG_RISK_POLICY\.minimumTp2NetProfitUsdt/);
  assert.match(execution, /sizeToMinimumTp2NetProfit: true/);
  assert.doesNotMatch(execution, /scalpEntryRisk|lossPauseMs|dailyLossRate|haltedUntil/);
  assert.match(execution, /持续运行，不因连续亏损或当日模拟亏损暂停/);
  assert.match(page, /连续亏损也持续运行/);
  assert.doesNotMatch(page, /三连亏暂停三十分钟|日亏12\.0%暂停新开仓/);
});

test("top analogue evidence is one overlay of the current and five real close paths", async () => {
  const chart = await readFile(new URL("../app/historical-forecast-card.tsx", import.meta.url), "utf8");
  assert.match(chart, /OverlayLineChart/);
  assert.match(chart, /当前真实收盘线与最相似五段历史真实收盘线叠加图/);
  assert.match(chart, /matches\.slice\(0, ANALOG_MIN_SAMPLES\)/);
  assert.match(chart, /<polyline/);
  assert.doesNotMatch(chart, /CandlestickChart/);
  assert.match(chart, /没有平均线、预测线或虚构数据/);
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
  assert.match(page, /策略表现/);
  assert.doesNotMatch(page, /每12小时总结/);
  assert.match(page, /全量评估/);
  assert.match(page, /原始触发/);
  assert.match(page, /入场拦截/);
  assert.match(page, /<DecisionEvidenceCard/);
  assert.match(page, /const NAV: Tab\[\] = \["大脑", "订单", "管理"\]/);
  const rendered = page.slice(page.indexOf("return <main"));
  assert.doesNotMatch(rendered, /9 个家族|13 个独立变体|策略中心|市场雷达|成交额前十五/);
});
