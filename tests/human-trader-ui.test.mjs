import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, layout, route, chart, css, liveStatus, scanner] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/api/hte31/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/hte31/chart/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/resonance.css", import.meta.url), "utf8"),
  readFile(new URL("../app/api/live/status/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/hte31-scanner.ts", import.meta.url), "utf8"),
]);

test("production UI is Resonance while preserving all five playbooks", () => {
  assert.match(page, /Resonance/);
  assert.match(page, /市场记忆 · 自适应交易/);
  for (const phrase of ["Dennis", "Raschke", "Turtle Soup", "Exhaustion", "Swing"]) assert.match(page, new RegExp(phrase));
  assert.match(page, /系统有没有进步/);
  assert.match(page, /历史相似/);
  assert.doesNotMatch(page, /旧 HTE 3\.0 不进入这里|SIMULATION LEDGER · CLEAN|HTE 3\.1 新账本|CLEAN RADAR|CLEAN RUNTIME/);
  assert.match(layout, /<body>\{children\}<\/body>/);
  assert.doesNotMatch(layout, /Strategy2Dashboard|Strategy2PlaybookDiagnostics|Strategy2LearningArena|RuntimeStabilityClient|UiStatusSemanticFix|LiveOrdersInline/);
});

test("main page is observer-only and does not call an exchange directly", () => {
  assert.match(page, /readJson<Snapshot>\("\/api\/hte31"\)/);
  assert.match(route, /getHte31Dashboard/);
  assert.match(route, /scanner\.readModel\(\)/);
  assert.doesNotMatch(route, /fetchGateUniverse|analyzeGateSymbol|fetchGateChartCandles/);
  assert.doesNotMatch(page, /fetchGateUniverse|analyzeGateSymbol|fetchGateChartCandles|api\.gateio/);
  assert.match(scanner, /getMarketExchange/);
  assert.doesNotMatch(scanner, /from "\.\/gate-client/);
});

test("trade cards preserve leverage economics and expandable candlestick review", () => {
  assert.match(page, /function MiniChart/);
  assert.match(page, /\/api\/hte31\/chart\?trade=/);
  assert.match(page, />杠杆</);
  assert.match(page, />保证金</);
  assert.match(page, />计划风险</);
  assert.match(page, />TP2</);
  assert.match(page, /counterfactual/);
  assert.match(page, /diagnosis/);
  assert.match(chart, /exitCapturePct/);
  assert.match(chart, /exitEfficiency/);
  assert.match(css, /\.rz-chart/);
});

test("learning screen exposes system review and independently disabled negative cells", () => {
  assert.match(page, /整体复盘/);
  assert.match(page, /系统正在学什么/);
  assert.match(page, /已经被数据否定的组合/);
  assert.match(page, /performanceGate/);
});

test("small-price contracts retain dynamic precision and pnl never wraps", () => {
  const formatter = page.match(/function fmtPrice[\s\S]*?\n}/)?.[0] ?? "";
  assert.match(formatter, /Math\.abs\(value\) >= 1000 \? 2 : Math\.abs\(value\) >= 1 \? 4 : 6/);
  assert.match(formatter, /value\.toFixed\(digits\)/);
  assert.match(css, /\.rz-order-pnl[\s\S]*white-space:\s*nowrap/);
});

test("live boundary preserves owner-controlled credentials reconciliation and emergency stop", () => {
  assert.match(page, /type="password" autoComplete="off" value=\{apiKey\}/);
  assert.match(page, /type="password" autoComplete="off" value=\{apiSecret\}/);
  assert.match(page, /\/api\/live\/control/);
  assert.match(page, /\/api\/live\/credentials/);
  assert.match(page, /\/api\/live\/reconcile/);
  assert.match(page, /\/api\/live\/emergency/);
  assert.match(page, /按住 1\.2 秒紧急停机/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
  assert.match(liveStatus, /\^Human Trader · \(\[\^：\]\+\)：/);
});

test("product surface omits migration and implementation copy", () => {
  for (const phrase of ["Clean Scanner", "HTE 3.0", "新账本", "de-legacy", "Durable Object", "trade_cases"]) assert.equal(page.includes(phrase), false, phrase);
  assert.match(page, /模拟账户/);
  assert.match(page, /当前没有模拟持仓|暂无模拟持仓/);
  assert.match(page, /Gate 合约账户/);
});
