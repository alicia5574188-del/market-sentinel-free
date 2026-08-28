import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const diagnostics = await readFile(new URL("../lib/hte31-diagnostics.ts", import.meta.url), "utf8");
const scanner = await readFile(new URL("../lib/hte31-scanner.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/hte31/route.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0013_hte31_trigger_shadow_learning.sql", import.meta.url), "utf8");
const engine = await readFile(new URL("../lib/human-trader-engine.ts", import.meta.url), "utf8");

test("HTE 3.1 diagnoses trigger failures without loosening formal entry gates", () => {
  assert.match(diagnostics, /dennis_trend:\s*new Set\(\["dennis-flow"\]\)/);
  assert.match(diagnostics, /raschke_pullback:\s*new Set\(\["raschke-flow"\]\)/);
  assert.match(diagnostics, /turtle_soup:\s*new Set\(\)/);
  assert.match(diagnostics, /failed\.length === 1/);
  assert.match(diagnostics, /signal\.state === "watching"/);
  assert.match(diagnostics, /automaticThresholdChanges:\s*false/);
  assert.match(diagnostics, /turtleSoupRelaxationEnabled:\s*false/);

  // Existing production thresholds remain unchanged by this diagnostics PR.
  assert.match(engine, /Math\.abs\(trend\) >= 0\.32/);
  assert.match(engine, /Math\.abs\(trend\) >= 0\.38/);
  assert.match(engine, /sweepVolumeRatio >= 1\.15/);
  assert.match(engine, /input\.volumeUsd >= 30_000_000/);
});

test("Near-Ready shadow learning is bounded and evidence-gated", () => {
  assert.match(diagnostics, /SHADOW_HORIZONS = \[30, 60, 120, 240\]/);
  assert.match(diagnostics, /SHADOW_DEDUPE_MS = 30 \* 60_000/);
  assert.match(diagnostics, /HTE31_SHADOW_MIN_SAMPLES = 30/);
  assert.match(diagnostics, /HTE31_SHADOW_MIN_PROFIT_FACTOR = 1\.3/);
  assert.match(diagnostics, /HTE31_SHADOW_MIN_EXPECTANCY_R = 0\.15/);
  assert.match(diagnostics, /不会自动修改正式阈值/);
  assert.match(scanner, /recordHte31DiagnosticCycle\(packet, signals, job\.settings\)/);
  assert.match(scanner, /Diagnostics and shadow learning are strictly auxiliary/);
});

test("dashboard explains risk multiplier and surfaces 1h\/6h trigger funnel", () => {
  assert.match(route, /1h 评估/);
  assert.match(route, /6h READY/);
  assert.match(route, /Near-Ready 影子完成/);
  assert.match(route, /风险预算倍率/);
  assert.match(route, /基础单笔风险仍约为账户权益 1%/);
});

test("migration creates isolated diagnostic and shadow tables", () => {
  assert.match(migration, /CREATE TABLE `hte31_trigger_buckets`/);
  assert.match(migration, /CREATE TABLE `hte31_shadow_samples`/);
  assert.match(migration, /hte31_shadow_symbol_status_idx/);
});
