import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const repositorySource = fs.readFileSync(new URL("../lib/live-trading-repository.ts", import.meta.url), "utf8");
const engineSource = fs.readFileSync(new URL("../lib/live-trading-engine.ts", import.meta.url), "utf8");
const statusSource = fs.readFileSync(new URL("../app/api/hte31/status/route.ts", import.meta.url), "utf8");

test("emergency reset keeps Auto Live disabled and drops only invalid dust equity baselines", () => {
  assert.match(engineSource, /positions\.some\(activePosition\) \|\| orders\.length \|\| priceOrders\.length/);
  assert.match(engineSource, /Gate 尚未完全清空，不能解除停机锁/);
  assert.match(repositorySource, /MIN_VALID_EQUITY_BASELINE_USDT = 0\.01/);
  assert.match(repositorySource, /entryEnabled: false/);
  assert.match(repositorySource, /accountEquityPeakUsdt: validEquityBaseline\(current\.accountEquityPeakUsdt\) \? current\.accountEquityPeakUsdt : null/);
  assert.match(repositorySource, /accountEquityLastUsdt: validEquityBaseline\(current\.accountEquityLastUsdt\) \? current\.accountEquityLastUsdt : null/);
  assert.match(repositorySource, /accountRiskCheckedAt: null/);
});

test("lightweight HTE31 status endpoint exposes runtime and paper health without the full dashboard payload", () => {
  assert.match(statusSource, /scanner:/);
  assert.match(statusSource, /position:/);
  assert.match(statusSource, /paper:/);
  assert.match(statusSource, /equityUsdt: dashboard\.account\.equityUsdt/);
  assert.match(statusSource, /sampleCount: dashboard\.stats\.sampleCount/);
  assert.doesNotMatch(statusSource, /trades: dashboard\.trades/);
  assert.doesNotMatch(statusSource, /evaluations: dashboard\.evaluations/);
});
