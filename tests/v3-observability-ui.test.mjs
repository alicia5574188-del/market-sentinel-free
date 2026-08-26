import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bottom navigation keeps concise original labels", async () => {
  const semantics = await readFile(new URL("../app/ui-status-semantic-fix.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(semantics, /normalizeNavigationCopy/);
  assert.doesNotMatch(semantics, /label\.textContent = "量化"/);
});

test("global layout mounts one unified Strategy 2.0 dashboard instead of stacked legacy strategy overlays", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /<Strategy2Dashboard \/>/);
  assert.doesNotMatch(layout, /SentinelV2Panels/);
  assert.doesNotMatch(layout, /Strategy2Visibility/);
  assert.doesNotMatch(layout, /StrategyLabInline/);
  assert.match(layout, /strategy-2-unified\.css/);
  assert.match(layout, /<LiveOrdersInline \/>/);
});

test("Strategy 2.0 dashboard unifies opportunity, radar, orders, pool activity and learning", async () => {
  const dashboard = await readFile(new URL("../app/strategy-2-dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /Sentinel Strategy 2\.0/);
  assert.match(dashboard, /12 Playbook 并行策略池/);
  assert.match(dashboard, /MARKET PULSE · STRATEGY 2\.0/);
  assert.match(dashboard, /PORTFOLIO \+ LEARNING · STRATEGY 2\.0/);
  assert.match(dashboard, /Strategy 2\.0 学习矩阵/);
  assert.match(dashboard, /Global × Asset × Playbook × Direction/);
  assert.match(dashboard, /TRADE/);
  assert.match(dashboard, /WATCH/);
  assert.match(dashboard, /REJECT/);
  assert.doesNotMatch(dashboard, /Sentinel Growth V2/);
  assert.doesNotMatch(dashboard, /MARKET PULSE · V2/);
  assert.doesNotMatch(dashboard, /PORTFOLIO CONTROL · V2/);
});

test("legacy symbol-direction memory is hidden and trade review is relabeled as Strategy 2.0 learning", async () => {
  const [dashboard, css] = await Promise.all([
    readFile(new URL("../app/strategy-2-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/strategy-2-unified.css", import.meta.url), "utf8"),
  ]);
  assert.match(css, /\.order-ledger \.memory-card\{display:none!important\}/);
  assert.match(css, /strategy2-unified-market/);
  assert.match(dashboard, /本单复盘已进入 Strategy 2\.0 学习记录/);
  assert.match(dashboard, /结构化结果已纳入经验矩阵/);
  assert.match(dashboard, /不再汇总成“BTC LONG”旧记忆/);
  assert.match(dashboard, /Strategy 2\.0 机会评分校准/);
});

test("unified dashboard API exposes the real Strategy 2.0 learning matrix", async () => {
  const [api, learning] = await Promise.all([
    readFile(new URL("../app/api/v2/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/strategy-2-learning.ts", import.meta.url), "utf8"),
  ]);
  assert.match(api, /getStrategy2LearningDashboard\(\)/);
  assert.match(api, /strategyPool/);
  assert.match(api, /learning/);
  assert.match(learning, /Exact Regime × Playbook × Asset-Regime × Direction/);
  assert.match(learning, /strategy2ExperienceKey\(parsed\.playbook, parsed\.globalRegime, parsed\.assetRegime, row\.side\)/);
  assert.match(learning, /getStrategy2LearningDashboard/);
  assert.match(learning, /negative_edge/);
  assert.match(learning, /小风险探索，不因少量输赢过度调整/);
  assert.match(learning, /停止该环境组合，等待新证据/);
});

test("opportunity detail is Strategy 2.0-first and legacy raw diagnostics are collapsed by default", async () => {
  const [dashboard, css] = await Promise.all([
    readFile(new URL("../app/strategy-2-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/strategy-2-unified.css", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /机会评分/);
  assert.match(dashboard, /环境/);
  assert.match(dashboard, /结构/);
  assert.match(dashboard, /时机/);
  assert.match(dashboard, /确认/);
  assert.match(dashboard, /还差什么/);
  assert.match(dashboard, /为什么拒绝/);
  assert.match(dashboard, /查看底层详细分析/);
  assert.match(css, /strategy2-opportunity-detail-active:not\(\.strategy2-show-legacy-analysis\).*\.analysis-matrix/);
  assert.match(css, /\.risk-note\{display:none!important\}/);
  assert.match(dashboard, /Strategy 2\.0 通过后仍需组合风险与 Execution Engine 复核/);
});

test("Strategy 2.0 opportunities still enter the normal order lifecycle with detailed explanation", async () => {
  const [growthRepository, strategy] = await Promise.all([
    readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/sentinel-v2-strategy.ts", import.meta.url), "utf8"),
  ]);
  assert.match(growthRepository, /trigger:`Strategy 2\.0 · \$\{signal\.label\}/);
  assert.match(growthRepository, /多策略同向汇合/);
  assert.match(growthRepository, /processDecision\(growthPacket\(packet,\s*selected\),\s*settings\)/);
  assert.match(strategy, /Sentinel Strategy 2\.0/);
  assert.match(strategy, /Strategy 2\.0 综合许可/);
  assert.match(strategy, /supportingPlaybooks/);
  assert.match(strategy, /strategyConflict/);
});
