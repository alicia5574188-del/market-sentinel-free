import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const [page, layout, route, chart, css, liveStatus, scanner, catalog, worker, repository] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/api/hte31/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/hte31/chart/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/resonance.css", import.meta.url), "utf8"),
  readFile(new URL("../app/api/live/status/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/hte31-scanner.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/hte31-strategy-catalog.ts", import.meta.url), "utf8"),
  readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/hte31-repository.ts", import.meta.url), "utf8"),
]);

test("production UI exposes the useful three setups and direct operating truth while history stays readable", () => {
  assert.match(page, /Resonance/);
  assert.match(page, /历史方向交易 · 模拟验证/);
  for (const phrase of ["HT1", "HT2", "HT3", "HT4", "HT5", "HT1-R", "HT2-R", "HT3-R", "HT5-R", "HT6", "HT7", "HT8", "HT9"]) assert.match(catalog, new RegExp(phrase));
  for (const family of ["SF01", "SF02", "SF03", "SF04", "SF05", "SF06", "SF07", "SF08", "SF09"]) assert.match(catalog, new RegExp(family));
  assert.match(page, /HistoricalForecastCard/);
  for (const phrase of ["策略表现", "大脑决定"]) assert.match(page, new RegExp(phrase));
  assert.match(page, /function DecisionEvidenceCard/);
  const renderedSurface = page.slice(page.lastIndexOf("return ("));
  assert.doesNotMatch(renderedSurface, /策略中心|9 个家族|13 个独立变体|历史记忆准备中|有效独立样本/);
  assert.doesNotMatch(page, /旧 HTE 3\.0 不进入这里|SIMULATION LEDGER · CLEAN|HTE 3\.1 新账本|CLEAN RADAR|CLEAN RUNTIME/);
  assert.match(layout, /<body>[\s\S]*<ResonanceOperatorControls \/>[\s\S]*\{children\}[\s\S]*<\/body>/);
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

test("daily brain hides raw diagnostic scores and keeps full evidence under management", () => {
  const brain = page.slice(page.indexOf('{tab === "大脑" &&'), page.indexOf('{tab === "订单" &&'));
  assert.match(brain, /decisionSummary\.title/);
  assert.match(brain, /decisionSummary\.detail/);
  assert.doesNotMatch(brain, /<Bias|rz-score|marketView|<DecisionEvidenceCard|rz-signal-levels|执行结论/);
  const management = page.slice(page.indexOf('{tab === "管理" && <div className="rz-stack rz-management-settings">'));
  assert.match(management, /<details className="rz-decision-detail"><summary>决策诊断（按需查看）/);
  assert.match(management, /<DecisionEvidenceCard/);
  assert.match(management, /readModel\.openReason/);
  assert.doesNotMatch(css, /\.rz-hero|\.rz-score|\.rz-brain-reason/);
});

test("plain-language decision never presents a candidate or stale state as a filled trade", () => {
  const source = page.match(/function operatorDecision\([\s\S]*?\n}/)?.[0];
  assert.ok(source);
  const summarize = vm.runInNewContext(ts.transpile(`${source}\noperatorDecision;`));
  assert.equal(summarize(null, false).title, "正在读取运行状态");
  const snapshot = {
    degraded: false,
    dashboard: { paperReset: { status: "completed" }, settings: { scanEnabled: true }, directRisk: { state: "NORMAL" } },
    scanner: { readModel: { directCandidate: { symbol: "BTC_USDT", setupLabel: "多周期综合共振", decision: "LONG" } } },
  };
  assert.equal(summarize(snapshot, false).title, "BTC 信号待复核");
  assert.match(summarize(snapshot, false).detail, /不代表已开仓/);
  assert.equal(summarize(snapshot, true).title, "运行数据需要检查");
  snapshot.degraded = true;
  assert.equal(summarize(snapshot, true).title, "运行数据需要检查");
  assert.equal(summarize(snapshot, false).title, "BTC 信号待复核", "unrelated partial data must not mask the current candidate");
  snapshot.degraded = false;
  snapshot.dashboard.directRisk.state = "PAUSED";
  assert.equal(summarize(snapshot, false).title, "风险保护中");
  snapshot.dashboard.settings.scanEnabled = false;
  assert.equal(summarize(snapshot, false).title, "市场扫描已暂停");
  snapshot.dashboard.paperReset.status = "pending";
  assert.equal(summarize(snapshot, false).title, "等待新一轮模拟开始");
});

test("operator enums, technical metrics and chart labels display in Chinese", async () => {
  const source = await readFile(new URL("../lib/operator-language.ts", import.meta.url), "utf8");
  const display = vm.runInNewContext(ts.transpile(source.replace(/export /g, "") + "\n({operatorLabel, chineseOperatorText, riskClusterLabel});"));
  for (const value of ["MIDDLE", "FRESH", "DEFENSIVE", "HOLD", "PROTECT", "EXIT", "ENTRY", "starting", "verified", "isolated", "warning"]) {
    assert.match(display.operatorLabel(value), /[\u4e00-\u9fff]/);
    assert.notEqual(display.operatorLabel(value), value);
  }
  assert.equal(display.operatorLabel("MIDDLE"), "区间中部");
  assert.equal(display.operatorLabel("new_internal_state"), "状态待确认");
  assert.equal(display.riskClusterLabel("independent-ETH_USDT"), "ETH独立风险");
  assert.equal(display.chineseOperatorText("Funding/OI/Flow/Book/HTF/IV · 5m · 1.00R"), "资金费率/持仓量/资金流/订单簿/高周期/隐含波动率 · 5分钟 · 1.00倍风险");
  assert.doesNotMatch(page, />\s*(BRAIN|CONTRIBUTION|OPEN|CLOSED|ARCHIVE|PF|Entry Efficiency|Exit Efficiency|Web Push)\s*</);
  for (const phrase of ["第一止盈", "第二止盈", "入场效率", "盈利因子", "市场扫描", "持仓管理"]) assert.ok(page.includes(phrase));
  assert.match(page, /operatorLabel\(candidate\.location\)/);
  assert.match(page, /operatorLabel\(positionDecision\.action\)/);
  assert.match(page, /operatorLabel\(marker\.kind\)/);
});

test("trade cards preserve leverage economics and full expandable review", () => {
  assert.match(page, /function MiniChart/);
  assert.match(page, /\/api\/hte31\/chart\?trade=/);
  for (const phrase of ["杠杆", "隔离保证金", "名义仓位", "计划亏损", "第二止盈预计净利", "当前保护价", "第一止盈", "第二止盈"]) assert.match(page, new RegExp(phrase));
  assert.match(page, /plannedTp2NetUsdt/);
  assert.match(page, /chart\.markers\.map/);
  assert.match(page, /post-exit-zone/);
  for (const metric of ["仓内最大浮盈", "仓内最大浮亏", "出场后最大有利波动", "出场后最大不利波动", "收益捕获率", "退出效率"]) assert.match(page, new RegExp(metric));
  assert.match(page, /counterfactual/);
  assert.match(page, /diagnosis/);
  assert.match(page, /finalVerdict/);
  assert.match(chart, /buildHte31TradeFinalVerdict/);
  assert.match(chart, /exitCapturePct/);
  assert.match(chart, /exitEfficiency/);
  assert.match(chart, /markers:/);
  assert.match(css, /\.rz-chart/);
});

test("direct market learning waits for a complete truthful 12-hour observation", () => {
  assert.match(repository, /trade\.decisionAuthority !== "direct_market_brain"/);
  assert.match(repository, /trade\.decisionAuthority === "direct_market_brain"/);
  assert.match(repository, /\[0, 30, 60, 120, 240, 480, 720\]/);
  assert.match(repository, /qualityStatus: "READY"/);
  assert.match(repository, /coveragePct >= 95/);
  assert.match(page, /qualityStatus/);
});

test("small-price contracts retain eight-decimal precision and pnl never wraps", () => {
  const formatter = page.match(/function fmtPrice[\s\S]*?\n}/)?.[0] ?? "";
  assert.match(formatter, /abs >= 1000 \? 2 : abs >= 1 \? 4 : abs >= 0\.01 \? 6 : 8/);
  assert.match(formatter, /value\.toFixed\(digits\)/);
  assert.match(css, /\.rz-order-pnl[\s\S]*white-space:\s*nowrap/);
});

test("simulation reset is reachable from funds without duplicating its destructive action", () => {
  assert.match(page, /资金设置/);
  assert.match(page, /重置模拟本金/);
  assert.match(page, /\/api\/hte31\/paper-reset/);
  assert.match(page, /const NAV: Tab\[\] = \["大脑", "订单", "管理"\]/);
  assert.match(page, /tab === "管理"/);
  assert.match(page, /重新开始资金曲线/);
  const resetButtons = page.match(/onClick=\{\(\) => void resetPaper\(\)\}/g) ?? [];
  assert.equal(resetButtons.length, 1);
});

test("pre-trade signal cards expose the complete decision and risk plan", () => {
  assert.match(page, /function DecisionEvidenceCard/);
  for (const phrase of ["方向", "触发状态", "入场区", "入场价", "止损", "第一止盈", "第二止盈", "触发与硬闸门", "支持证据", "反证 / 缺失条件", "失效条件"]) {
    assert.match(page, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(page, /candidate\.checks\.map/);
  assert.match(page, /candidate\.evidence\.join/);
  assert.match(page, /candidate\.counterEvidence\.join/);
  assert.match(page, /candidate\.invalidationPrice/);
});

test("runtime settings preserve scanner diagnostics needed to detect silent stalls", () => {
  assert.match(page, /市场扫描/);
  assert.match(page, /当前阶段/);
  assert.match(page, /scanner\.phase/);
  assert.match(page, /scanner\?\.lastError/);
  assert.match(page, /scanner\?\.circuitOpen/);
  assert.match(page, /ageSeconds/);
  assert.match(page, /持仓管理/);
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
  assert.match(page, /SNAPSHOT_STORAGE_KEY/);
  assert.doesNotMatch(page, /localStorage[\s\S]{0,200}\/api\/live\/(?:control|credentials|reconcile|emergency)/);
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
  for (const phrase of ["Clean Scanner", "HTE 3.0", "新账本", "de-legacy", "Durable Object", "trade_cases", "13 个旧策略身份完整保留并归入"]) assert.equal(page.includes(phrase), false, phrase);
  assert.match(page, /模拟账户/);
  assert.match(page, /当前没有模拟持仓|暂无模拟持仓/);
  assert.match(page, /Gate 合约账户/);
});

test("high-frequency read is bounded, diagnostics are on demand, and health stays read-only", () => {
  assert.match(route, /boundedRead/);
  assert.match(route, /view === "strategies"/);
  assert.match(route, /staleSources/);
  assert.match(route, /diagnostics: null/);
  assert.match(scanner, /boundedMap\(job\.universe,2/);
  assert.match(scanner, /buildAnalogCandidate/);
  assert.doesNotMatch(scanner, /recordHte31StrategyEvaluations|recordHte31StrategyDiagnostic|openHte31PaperTrade/);
  const healthStart = worker.indexOf('if (url.pathname === "/__health")');
  const healthEnd = worker.indexOf('if (url.pathname === "/api/push/vapid-public-key")', healthStart);
  const health = worker.slice(healthStart, healthEnd);
  assert.match(health, /readHealthStatus/);
  assert.doesNotMatch(health, /ensureSchedulers/);
});

test("paper capital card reads the execution risk policy rather than the retired 3.5% evaluator", () => {
  assert.match(repository, /getDirectMarketRiskDecision\(\)/);
  assert.doesNotMatch(repository, /const directRisk = evaluateDirectMarketRisk/);
});

test("history backfill delays remain warnings and the mobile navigation uses a compact footprint", () => {
  assert.match(page, /historyOnlyRuntimeError/);
  assert.match(page, /usablePartialScan/);
  assert.match(page, /部分行情暂时未刷新/);
  assert.doesNotMatch(page, /healthBad = Boolean\(error \|\| snapshot\?\.scanner\.status\?\.lastError/);
  assert.match(css, /bottom: max\(6px, env\(safe-area-inset-bottom\)\)/);
});
