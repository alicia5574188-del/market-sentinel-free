import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const repository = readFileSync(new URL("../lib/hte31-repository.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../db/hte31-schema.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../drizzle/0014_hte31_simulation_epochs.sql", import.meta.url), "utf8");
const resetMigration = readFileSync(new URL("../drizzle/0018_safe_paper_reset.sql", import.meta.url), "utf8");
const freshStartMigration = readFileSync(new URL("../drizzle/0019_adaptive_brain_fresh_start.sql", import.meta.url), "utf8");
const releaseMigration = readFileSync(new URL("../drizzle/0020_direct_market_v2_cutover.sql", import.meta.url), "utf8");
const release = readFileSync(new URL("../lib/direct-market-release.ts", import.meta.url), "utf8");
const directTypes = readFileSync(new URL("../lib/direct-market-types.ts", import.meta.url), "utf8");
const execution = readFileSync(new URL("../lib/direct-market-execution.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../worker/hte31-workers.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/hte31/paper-reset/route.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

test("paper capital reset creates a new accounting epoch without deleting learning or history", () => {
  assert.match(schema, /hte31SimulationEpochs/);
  assert.match(repository, /epochClosed = closed\.filter\(\(row\) => row\.entryAt >= epoch\.startedAt\)/);
  assert.match(repository, /resetHte31PaperCapital/);
  assert.match(repository, /where\(eq\(hte31Trades\.status, "holding"\)\)/);
  assert.match(repository, /learningRows = await db\.select\(\)\.from\(hte31Learning\)/);
  assert.match(repository, /closedTrades: currentClosed\.slice/);
  assert.match(repository, /archivedTrades: archivedClosed\.slice/);
  assert.doesNotMatch(migration, /DELETE FROM/i);
  assert.doesNotMatch(resetMigration, /DELETE FROM/i);
  assert.doesNotMatch(freshStartMigration, /DELETE FROM/i);
  assert.doesNotMatch(releaseMigration, /DELETE FROM/i);
  assert.doesNotMatch(route, /DELETE FROM|delete\(hte31|db\.delete/i);
});

test("every major brain version declares and enforces one paper cutover", () => {
  const version = directTypes.match(/DIRECT_MARKET_BRAIN_VERSION = "([^"]+)"/)?.[1];
  const migrationTag = release.match(/migrationTag: "([^"]+)"/)?.[1];
  assert.ok(version && migrationTag);
  assert.match(release, /cutover: "force_archive_paper"/);
  assert.ok(releaseMigration.includes(version), "release migration must name the current brain version");
  assert.equal(migrationTag, "0020_direct_market_v2_cutover");
  assert.match(execution, /ensureDirectMarketReleaseCutover\(settings\.trialCapitalUsdt, executionNow\)/);
  assert.match(worker, /ensureDirectMarketReleaseCutover\(settings\.trialCapitalUsdt, startedAt\)/);
  assert.match(release, /state\?\.status === "completed" && state\.targetBrainVersion === DIRECT_MARKET_RELEASE\.brainVersion/);
  assert.match(repository, /activeBrainVersion: state\.targetBrainVersion \?\? state\.activeBrainVersion/);
});

test("adaptive-brain fresh start archives old paper positions at fresh quotes and keeps their review trail", () => {
  assert.match(freshStartMigration, /'force_archive'/);
  assert.match(worker, /paperReset\.resetMode === "force_archive"/);
  assert.match(worker, /applyHte31PositionQuote\(quote, settings, positionDecision, \{ forceArchiveForReset \}\)/);
  const forcedExit = repository.indexOf("if (lifecycle.forceArchiveForReset)");
  const normalStop = repository.indexOf("else if (stopHit)", forcedExit);
  const observations = repository.indexOf("for (const horizonMinutes of POST_EXIT_HORIZONS)", forcedExit);
  assert.ok(forcedExit >= 0 && normalStop > forcedExit && observations > normalStop);
  assert.match(repository.slice(forcedExit, observations), /exitCode = "version_reset"/);
});

test("account loss governance respects both the simulation epoch and current Resonance policy", () => {
  assert.match(repository, /const policyRows = rows\.filter\(\(row\) => isCurrentResonanceTrade\(row\.entryAt\)\)/);
  assert.match(repository, /const accountGateStartedAt = Math\.max\(epoch\?\.startedAt \?\? 0, RESONANCE_POLICY_STARTED_AT\)/);
  assert.match(repository, /const accountRows = policyRows\.filter\(\(row\) => row\.entryAt >= accountGateStartedAt\)/);
  assert.match(repository, /const own = policyRows\.filter\(\(row\) => row\.traderId === traderId/);
  assert.match(repository, /for \(const row of accountRows\)/);
});

test("paper capital reset is owner-confirmed, queued, and finalized only after positions close", () => {
  assert.match(route, /role !== "owner"/);
  assert.match(route, /confirmed !== true/);
  assert.match(repository, /status: "pending"/);
  assert.match(repository, /finalizePendingHte31PaperCapitalReset/);
  assert.match(repository, /if \(open\.length\) return/);
  assert.match(resetMigration, /'singleton', 'pending'/);
  assert.match(page, /重置模拟本金/);
  assert.match(page, /等待持仓结束/);
  assert.match(page, /dashboard\?\.paperReset\.status === "pending"/);
});

test("dashboard scopes current statistics to the active direct-brain epoch", () => {
  assert.match(repository, /const closed = rows\.filter/);
  assert.match(repository, /const epochClosed = closed\.filter/);
  assert.match(repository, /const currentClosed = closed\.filter/);
  assert.match(repository, /row\.decisionAuthority === DIRECT_MARKET_AUTHORITY/);
  assert.match(repository, /row\.brainVersion === DIRECT_MARKET_BRAIN_VERSION/);
  assert.match(repository, /sampleCount: currentClosed\.length/);
  assert.match(page, /dashboard\?\.stats\.sampleCount/);
  assert.match(page, /笔已完成/);
});
