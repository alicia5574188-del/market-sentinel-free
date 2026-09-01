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
  assert.match(page, /MemoryCard item=\{memory\.short\}/);
  assert.match(page, /MemoryCard item=\{memory\.swing\}/);
  assert.match(page, /MemoryCard item=\{memory\.cycle\}/);
  assert.doesNotMatch(page, /旧 HTE 3\.0 不进入这里|SIMULATION LEDGER · CLEAN|HTE 3\.1 新账本|CLEAN RADAR|CLEAN RUNTIME/);
  assert.match(layout, /<body>[\s\S]*\{children\}[\s\S]*<ResonanceOperatorControls \/>[\s\S]*<\/body>/);
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

test("trade cards preserve leverage economics and full expandable review", () => {
  assert.match(page, /function MiniChart/);
  assert.match(page, /\/api\/hte31\/chart\?trade=/);
  for (const phrase of ["杠杆", "隔离保证金", "名义仓位", "计划亏损", "TP2预计净利", "当前保护价", "TP1", "TP2"]) assert.match(page, new RegExp(phrase));
  assert.match(page, /plannedTp2NetUsdt/);
  assert.match(page, /chart\.markers\.map/);
  assert.match(page, /post-exit-zone/);
  for (const metric of ["仓内 MFE", "仓内 MAE", "出场后 MFE", "出场后 MAE", "Exit Capture", "Exit Efficiency"]) assert.match(page, new RegExp(metric));
  assert.match(page, /counterfactual/);
  assert.match(page, /diagnosis/);
  assert.match(chart, /exitCapturePct/);
  assert.match(chart, /exitEfficiency/);
  assert.match(chart, /markers:/);
  assert.match(css, /\.rz-chart/);
});

test("learning starts after every close and five trades are only a stage summary", () => {
  assert.match(page, /每笔交易都会立即复盘/);
  assert.match(page, /5 笔只用于阶段汇总/);
  assert.match(page, /latestAutopsy/);
  assert.match(page, /阶段汇总/);
  assert.match(page, /已经被数据否定的组合/);
  assert.match(page, /performanceGate/);
});

test("small-price contracts retain eight-decimal precision and pnl never wraps", () => {
  const formatter = page.match(/function fmtPrice[\s\S]*?\n}/)?.[0] ?? "";
  assert.match(formatter, /abs >= 1000 \? 2 : abs >= 1 \? 4 : abs >= 0\.01 \? 6 : 8/);
  assert.match(formatter, /value\.toFixed\(digits\)/);
  assert.match(css, /\.rz-order-pnl[\s\S]*white-space:\s*nowrap/);
});

test("simulation reset is visible from funds and settings, not merely present in dead code", () => {
  assert.match(page, /资金设置/);
  assert.match(page, /更多设置/);
  assert.match(page, /重置模拟本金/);
  assert.match(page, /\/api\/hte31\/paper-reset/);
  assert.match(page, /⚙ 设置/);
  assert.match(page, /tab === "设置"/);
  assert.match(page, /重新开始资金曲线/);
});

test("runtime settings preserve scanner diagnostics needed to detect silent stalls", () => {
  assert.match(page, /Scanner/);
  assert.match(page, /当前阶段/);
  assert.match(page, /scanner\?\.phase/);
  assert.match(page, /scanner\?\.lastError/);
  assert.match(page, /scanner\?\.circuitOpen/);
  assert.match(page, /ageSeconds/);
  assert.match(page, /Trade Manager/);
});

test("live boundary preserves credentials reconciliation emergency stop and mobile hold safety", () => {
  assert.match(page, /type="password" autoComplete="off" value=\{apiKey\}/);
  assert.match(page, /type="password" autoComplete="off" value=\{apiSecret\}/);
  assert.match(page, /\/api\/live\/control/);
  assert.match(page, /\/api\/live\/credentials/);
  assert.match(page, /method: "DELETE"/);
  assert.match(page, /删除凭据/);
  assert.match(page, /\/api\/live\/reconcile/);
  assert.match(page, /\/api\/live\/emergency/);
  assert.match(page, /按住 1\.2 秒紧急停机/);
  assert.match(page, /onContextMenu=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(page, /rz-hold-button/);
  assert.match(css, /\.rz-hold-button[\s\S]*user-select:\s*none/);
  assert.match(css, /-webkit-user-select:\s*none/);
  assert.match(css, /-webkit-touch-callout:\s*none/);
  assert.match(css, /touch-action:\s*manipulation/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
  assert.match(liveStatus, /\^Human Trader · \(\[\^：\]\+\)：/);
});

test("live page surfaces safety state and strategy lineage instead of hiding it", () => {
  assert.match(page, /实盘资格/);
  assert.match(page, /emergencyReason/);
  assert.match(page, /credential\.lastError/);
  assert.match(page, /strategyLabel/);
  assert.match(page, /strategyThesis/);
  assert.match(page, /marginMode/);
  assert.match(page, /order\.leverage/);
});

test("product surface omits migration and implementation copy", () => {
  for (const phrase of ["Clean Scanner", "HTE 3.0", "新账本", "de-legacy", "Durable Object", "trade_cases"]) assert.equal(page.includes(phrase), false, phrase);
  assert.match(page, /模拟账户/);
  assert.match(page, /当前没有模拟持仓|暂无模拟持仓/);
  assert.match(page, /Gate 合约账户/);
});