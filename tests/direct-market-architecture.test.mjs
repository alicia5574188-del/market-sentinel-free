import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [scanner, worker, repository, liveRepository, page, migration] = await Promise.all([
  readFile(new URL("../lib/hte31-scanner.ts", import.meta.url), "utf8"),
  readFile(new URL("../worker/hte31-workers.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/hte31-repository.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/live-trading-repository.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0017_direct_market_brain.sql", import.meta.url), "utf8"),
]);

test("new-entry scanner has no legacy strategy authority or high-frequency D1 writes", () => {
  for (const forbidden of ["evaluateHumanTraderPool", "evaluateAdvancedHumanTraders", "evaluateHte31ResearchStrategies", "recordHte31Evaluations", "recordHte31DiagnosticCycle", "tryOpenResonanceTrade"]) {
    assert.doesNotMatch(scanner, new RegExp(forbidden));
  }
  assert.match(scanner, /buildDirectMarketCandidate/);
  assert.match(worker, /freshReady\.length >= 3/);
  assert.match(worker, /SCANNER_CYCLE_INTERVAL_MS = 25_000/);
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

test("phone UI exposes fifteen-coin radar without legacy strategy center copy", () => {
  assert.match(page, /成交额前十五/);
  assert.match(page, /<DirectRadarCard/);
  assert.match(page, /const NAV: Tab\[\] = \["机会", "雷达", "订单", "实盘", "设置"\]/);
  const rendered = page.slice(page.indexOf("return <main"));
  assert.doesNotMatch(rendered, /9 个家族|13 个独立变体|策略中心/);
});
