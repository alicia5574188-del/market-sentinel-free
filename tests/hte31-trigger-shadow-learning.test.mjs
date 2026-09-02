import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const diagnostics = await readFile(new URL("../lib/hte31-diagnostics.ts", import.meta.url), "utf8");
const scanner = await readFile(new URL("../lib/hte31-scanner.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/hte31/route.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0013_hte31_trigger_shadow_learning.sql", import.meta.url), "utf8");
const engine = await readFile(new URL("../lib/hte31-human-trader-engine.ts", import.meta.url), "utf8");

test("HTE 3.1 diagnoses trigger failures without loosening formal entry gates", () => {
  assert.match(diagnostics, /dennis_trend:\s*new Set\(\["dennis-flow"\]\)/);
  assert.match(diagnostics, /raschke_pullback:\s*new Set\(\["raschke-flow"\]\)/);
  assert.match(diagnostics, /turtle_soup:\s*new Set\(\)/);
  assert.match(diagnostics, /failed\.length === 1/);
  assert.match(diagnostics, /signal\.state === "watching"/);
  assert.match(diagnostics, /automaticThresholdChanges:\s*false/);
  assert.match(diagnostics, /turtleSoupRelaxationEnabled:\s*false/);

  // Existing production thresholds remain unchanged by diagnostics/de-legacy work.
  assert.match(engine, /Math\.abs\(trend\) >= 0\.32/);
  assert.match(engine, /Math\.abs\(trend\) >= 0\.38/);
  assert.match(engine, /sweepVolumeRatio >= 1\.15/);
  assert.match(engine, /input\.volumeUsd >= 30_000_000/);
});

test("the current cycle has no simulation-inside-simulation and uses actual paper evidence", () => {
  const cycle = diagnostics.slice(
    diagnostics.indexOf("export async function recordHte31DiagnosticCycle"),
    diagnostics.indexOf("function paperMaximumDrawdownR"),
  );
  assert.doesNotMatch(cycle, /advanceShadowSamples|createShadowSample|hte31ShadowSamples/);
  assert.match(diagnostics, /async function buildPaperRouterEvidence/);
  assert.match(diagnostics, /\.from\(hte31Trades\)/);
  assert.match(diagnostics, /isCurrentResonanceTrade/);
  const diagnosticIndex = scanner.indexOf("recordHte31DiagnosticCycle(packet, signals, activePosition)");
  const openIndex = scanner.indexOf("tryOpenResonanceTrade(packet, signals, job.candles, job.settings, job.market, job.marketView, job.review, router)");
  assert.ok(diagnosticIndex >= 0, "scanner must build paper-order router evidence");
  assert.ok(openIndex > diagnosticIndex, "brain selection must precede paper execution");
  assert.match(scanner.slice(diagnosticIndex, openIndex), /catch \(error\)/, "diagnostic failure must not block the formal trading path");
});

test("dashboard exposes cognitive learning instead of mechanical loss cooldown", () => {
  assert.match(route, /1h 评估/);
  assert.match(route, /6h READY/);
  assert.match(route, /实际订单与逐笔复盘驱动后续排序/);
  assert.match(route, /不做机械时间冷却/);
  assert.match(route, /连续亏损 .*已交给认知复盘/);
  assert.doesNotMatch(route, /风险预算倍率/);
});

test("migration creates isolated diagnostic and shadow tables", () => {
  assert.match(migration, /CREATE TABLE `hte31_trigger_buckets`/);
  assert.match(migration, /CREATE TABLE `hte31_shadow_samples`/);
  assert.match(migration, /hte31_shadow_symbol_status_idx/);
});
