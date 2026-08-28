import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, layout, route, css, liveStatus] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/api/hte/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/human-trader.css", import.meta.url), "utf8"),
  readFile(new URL("../app/api/live/status/route.ts", import.meta.url), "utf8"),
]);

test("production UI is Human Trader Engine first instead of a Strategy 2 overlay stack", () => {
  assert.match(page, /HUMAN TRADER ENGINE 3\.0/);
  assert.match(page, /RISK GOVERNOR/);
  assert.match(page, /Dennis 趋势突破/);
  assert.match(page, /Raschke 趋势回踩/);
  assert.match(page, /Turtle Soup 假突破/);
  assert.match(page, /不投票 · 不加分凑单 · 一单一主交易员/);
  assert.match(layout, /<body>\{children\}<\/body>/);
  assert.doesNotMatch(layout, /Strategy2Dashboard|Strategy2PlaybookDiagnostics|Strategy2LearningArena|RuntimeStabilityClient|UiStatusSemanticFix|LiveOrdersInline/);
});

test("one HTE snapshot orchestrates the non-live dashboard without foreground Gate fanout", () => {
  assert.match(route, /Promise\.allSettled/);
  assert.match(route, /getStrategyLabDashboard\(\)/);
  assert.match(route, /listRecentV2Opportunities\(48\)/);
  assert.match(route, /listRecentV2Warnings\(12\)/);
  assert.match(route, /ensureBackgroundSchedulers\(\)/);
  assert.match(route, /scanner\.readModel\(\)/);
  assert.match(route, /humanOnlyDashboard/);
  assert.match(route, /trade\.regime\.startsWith\("S2\|HT"\)/);
  assert.doesNotMatch(route, /fetchGateUniverse|analyzeGateSymbol|fetchGateChartCandles/);
});

test("iPhone scroll safety uses native pan-y and no document-level interaction trap", () => {
  const root = css.match(/html,\s*\nbody\s*\{([^}]*)\}/s)?.[1] ?? "";
  assert.match(root, /overflow-y:\s*auto\s*!important/);
  assert.match(root, /touch-action:\s*pan-y/);
  assert.match(root, /-webkit-overflow-scrolling:\s*touch/);
  assert.doesNotMatch(page, /addEventListener\("touchmove"|preventDefault\(\)|MutationObserver|createPortal/);
});

test("live controls remain explicit and credentials stay ephemeral in the browser", () => {
  assert.match(page, /type="password" autoComplete="off" value=\{apiKey\}/);
  assert.match(page, /type="password" autoComplete="off" value=\{apiSecret\}/);
  assert.match(page, /\/api\/live\/control/);
  assert.match(page, /\/api\/live\/credentials/);
  assert.match(page, /\/api\/live\/reconcile/);
  assert.match(page, /\/api\/live\/emergency/);
  assert.match(page, /1_200/);
  assert.match(page, /按住 1\.2 秒紧急停机/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
  assert.match(liveStatus, /\^Human Trader · \(\[\^：\]\+\)：/);
});

test("fresh UI explains new-ledger boundaries instead of presenting legacy records as evidence", () => {
  assert.match(page, /旧 Strategy 2\.0 \/ P1–P12 记录不进入这里，也不参与新学习/);
  assert.match(page, /学习样本从 Human Trader Engine 3\.0 上线后的新交易重新累计/);
  assert.match(page, /旧策略交易、旧学习记忆、旧机会缓存和旧市场快照会在本次迁移中重置/);
});
