import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const repository = readFileSync(new URL("../lib/hte31-repository.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../db/hte31-schema.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../drizzle/0014_hte31_simulation_epochs.sql", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/hte31/paper-reset/route.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

test("paper capital reset creates a new accounting epoch without deleting learning or history", () => {
  assert.match(schema, /hte31SimulationEpochs/);
  assert.match(repository, /epochClosed = closed\.filter\(\(row\) => row\.entryAt >= epoch\.startedAt\)/);
  assert.match(repository, /resetHte31PaperCapital/);
  assert.match(repository, /where\(eq\(hte31Trades\.status, "holding"\)\)/);
  assert.match(repository, /learningRows = await db\.select\(\)\.from\(hte31Learning\)/);
  assert.match(repository, /closedTrades: closed\.slice/);
  assert.doesNotMatch(migration, /DELETE FROM/i);
  assert.doesNotMatch(route, /DELETE FROM|delete\(hte31|db\.delete/i);
});

test("account-level loss streak resets with the epoch while trader guards keep all-time history", () => {
  assert.match(repository, /const accountRows = epoch \? rows\.filter\(\(row\) => row\.entryAt >= epoch\.startedAt\) : rows/);
  assert.match(repository, /const own = rows\.filter\(\(row\) => row\.traderId === traderId/);
  assert.match(repository, /for \(const row of accountRows\)/);
});

test("paper capital reset is owner-confirmed and blocked while a paper position is open", () => {
  assert.match(route, /role !== "owner"/);
  assert.match(route, /confirmed !== true/);
  assert.match(repository, /存在模拟持仓，平仓后才能重置模拟本金/);
  assert.match(page, /重置模拟本金/);
  assert.match(page, /历史订单和学习数据会保留/);
  assert.match(page, /disabled=\{Boolean\(dashboard\?\.openTrades\.length\)\}/);
});

test("dashboard keeps cumulative samples while current account PnL is epoch scoped", () => {
  assert.match(repository, /const closed = rows\.filter/);
  assert.match(repository, /const epochClosed = closed\.filter/);
  assert.match(repository, /sampleCount: closed\.length/);
  assert.match(page, /累计学习样本/);
});
