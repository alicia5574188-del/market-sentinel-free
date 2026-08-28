import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Turtle Soup requires a mature extreme, meaningful sweep/reclaim and multi-source reversal confirmation", async () => {
  const source = await readFile(new URL("../lib/human-trader-engine.ts", import.meta.url), "utf8");
  const turtle = source.match(/function turtleSoup\([\s\S]*?\n}\n\n\/\*\*/)?.[0] ?? "";
  assert.match(turtle, /extremeMature/);
  assert.match(turtle, /currentAtr \* 0\.12/);
  assert.match(turtle, /currentAtr \* 0\.08/);
  assert.match(turtle, /confirmationVotes/);
  assert.match(turtle, /confirmationVotes >= 3/);
  assert.match(turtle, /sweepVolumeRatio >= 1\.15/);
  assert.match(turtle, /input\.volumeUsd >= 30_000_000/);
  assert.doesNotMatch(turtle, /"expansion_up", "expansion_down"/);
});

test("same human trader is cooled independently after two consecutive losses", async () => {
  const source = await readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8");
  assert.match(source, /type TraderGuard/);
  assert.match(source, /lossStreak >= 2/);
  assert.match(source, /120 \* 60_000/);
  assert.match(source, /lossStreak >= 3/);
  assert.match(source, /360 \* 60_000/);
  assert.match(source, /traderGuardForSignal/);
  assert.match(source, /guard\.state !== "ACTIVE"/);
  assert.match(source, /traderGuards/);
});

test("global governor no longer locks every trader after only three losses from one setup", async () => {
  const source = await readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8");
  assert.match(source, /lossStreak >= 8[\s\S]*"PAUSED"/);
  assert.match(source, /lossStreak >= 6[\s\S]*"DEFENSIVE"/);
  assert.match(source, /lossStreak >= 4[\s\S]*"CAUTION"/);
  assert.doesNotMatch(source, /lossStreak >= 3 \|\| recentWeak/);
});

test("small-priced contracts render with meaningful precision instead of collapsing to $0.01", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /function fmtPrice/);
  assert.match(page, /value >= 0\.01 \? 6/);
  assert.match(page, /fmtPrice\(trade\.entryPrice\)/);
  assert.match(page, /fmtPrice\(trade\.currentStopPrice\)/);
  assert.match(page, /fmtPrice\(trade\.takeProfit2Price\)/);
});
