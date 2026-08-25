import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bottom navigation names the simulation and research area Quant", async () => {
  const semantics = await readFile(new URL("../app/ui-status-semantic-fix.tsx", import.meta.url), "utf8");
  assert.match(semantics, /\.bottom-nav button span/);
  assert.match(semantics, /"订单"\) label\.textContent = "量化"/);
});

test("opportunity tab exposes V3 data inputs, blockers and runtime health", async () => {
  const [layout, component, route] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/opportunity-strategy-diagnostics.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/strategy-lab/diagnostics/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /<OpportunityStrategyDiagnostics \/>/);
  assert.match(component, /V3 策略监控/);
  assert.match(component, /ATR 压缩/);
  assert.match(component, /相对 BTC\/ETH/);
  assert.match(component, /Spot CVD/);
  assert.match(component, /OI 变化/);
  assert.match(component, /四策略当前判定/);
  assert.match(component, /check\.detail/);
  assert.match(component, /后台策略引擎运行中/);
  assert.match(route, /evaluateShadowStrategies/);
  assert.match(route, /fetchGateChartCandles/);
  assert.match(route, /ensureBackgroundSchedulers/);
  assert.match(route, /checks: strategy\.entryPlan\?\.checks/);
});

test("V3 candle failures can no longer disappear as empty successful scans", async () => {
  const scanner = await readFile(new URL("../lib/scanner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(scanner, /fetchGateChartCandles[^\n]*\.catch\(\(\) => \[\]\)/);
  assert.match(scanner, /V3 策略数据/);
  assert.match(scanner, /shadowError/);
  assert.match(scanner, /ready: shadowSignals\.filter/);
});
