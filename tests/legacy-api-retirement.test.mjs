import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const retiredRoutes = [
  "../app/api/hte/route.ts",
  "../app/api/v2/route.ts",
  "../app/api/v2/learning-arena/route.ts",
  "../app/api/v2/playbook-diagnostics/route.ts",
  "../app/api/strategy-lab/route.ts",
  "../app/api/strategy-lab/diagnostics/route.ts",
  "../app/api/strategy-lab/trades/route.ts",
];

test("current HTE31 page has no dependency on retired Strategy2/Strategy Lab APIs", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /["'`]\/api\/v2(?:[\/"'`?])/);
  assert.doesNotMatch(page, /["'`]\/api\/strategy-lab(?:[\/"'`?])/);
  assert.doesNotMatch(page, /["'`]\/api\/hte["'`?]/);
  assert.match(page, /\/api\/hte31/);
  assert.match(page, /\/api\/live\/status/);
  assert.match(page, /\/api\/settings/);
});

test("retired strategy routes cannot execute legacy strategy or position-refresh code", async () => {
  for (const path of retiredRoutes) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /retiredLegacyApi/);
    assert.doesNotMatch(source, /strategy-2|sentinel-v2|shadow-strategy|refreshOpenPositions|getStrategyLabDashboard|getStrategy2/);
  }
});

test("legacy retirement response remains authenticated and explicit 410 Gone", async () => {
  const source = await readFile(new URL("../app/api/legacy-retired.ts", import.meta.url), "utf8");
  assert.match(source, /requireApiAccount/);
  assert.match(source, /status:\s*410/);
  assert.match(source, /replacement:\s*"\/api\/hte31"/);
  assert.match(source, /唯一生产交易权威/);
});
