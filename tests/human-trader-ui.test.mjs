import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, layout, route, chart, css, liveStatus] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/api/hte31/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/hte31/chart/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/hte31-chart.css", import.meta.url), "utf8"),
  readFile(new URL("../app/api/live/status/route.ts", import.meta.url), "utf8"),
]);

test("production UI is HTE 3.1 Clean and not a Strategy 2 overlay stack", () => {
  assert.match(page, /HUMAN TRADER ENGINE 3\.1 CLEAN/);
  assert.match(page, /Dennis/);
  assert.match(page, /Raschke/);
  assert.match(page, /Turtle Soup/);
  assert.match(page, /旧 HTE 3\.0 不进入这里/);
  assert.match(layout, /<body>\{children\}<\/body>/);
  assert.doesNotMatch(layout, /Strategy2Dashboard|Strategy2PlaybookDiagnostics|Strategy2LearningArena|RuntimeStabilityClient|UiStatusSemanticFix|LiveOrdersInline/);
});

test("main page only reads the clean HTE snapshot and never fans out to Gate", () => {
  assert.match(page, /readJson<CleanSnapshot>\("\/api\/hte31"\)/);
  assert.match(route, /getHte31Dashboard/);
  assert.match(route, /scanner\.readModel\(\)/);
  assert.doesNotMatch(route, /fetchGateUniverse|analyzeGateSymbol|fetchGateChartCandles/);
  assert.doesNotMatch(page, /fetchGateUniverse|analyzeGateSymbol|fetchGateChartCandles/);
});

test("order audit includes entry exit candlesticks and post-exit observer", () => {
  assert.match(page, /function CandleChart/);
  assert.match(page, /ENTRY/);
  assert.match(page, /STOP/);
  assert.match(page, /TP1/);
  assert.match(page, /TP2/);
  assert.match(page, /Post-Exit/);
  assert.match(page, /30m \/ 1h \/ 2h \/ 4h \/ 12h/);
  assert.match(page, /\/api\/hte31\/chart\?trade=/);
  assert.match(chart, /postExitStartAt/);
  assert.match(chart, /observationUntilAt/);
  assert.match(chart, /exitCapturePct/);
  assert.match(chart, /exitEfficiency/);
  assert.match(css, /post-exit-zone/);
});

test("small-price contracts use dynamic price precision", () => {
  assert.match(page, /abs >= 1000 \? 2 : abs >= 1 \? 4 : abs >= 0\.01 \? 6 : 8/);
  assert.doesNotMatch(page, /value\.toFixed\(2\).*fmtPrice/s);
});

test("live boundary preserves explicit controls but clean validation cannot enable new live entries", () => {
  assert.match(page, /type="password" autoComplete="off" value=\{apiKey\}/);
  assert.match(page, /type="password" autoComplete="off" value=\{apiSecret\}/);
  assert.match(page, /\/api\/live\/control/);
  assert.match(page, /\/api\/live\/credentials/);
  assert.match(page, /\/api\/live\/reconcile/);
  assert.match(page, /\/api\/live\/emergency/);
  assert.match(page, /HTE 3\.1 Clean 从零验证期间/);
  assert.match(page, /验证期暂不开放/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
  assert.match(liveStatus, /\^Human Trader · \(\[\^：\]\+\)：/);
});
