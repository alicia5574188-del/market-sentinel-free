import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bottom navigation keeps concise original labels", async () => {
  const semantics = await readFile(new URL("../app/ui-status-semantic-fix.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(semantics, /normalizeNavigationCopy/);
  assert.doesNotMatch(semantics, /label\.textContent = "量化"/);
});

test("global layout mounts one unified strategy dashboard instead of stacked legacy overlays", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /<Strategy2Dashboard \/>/);
  assert.doesNotMatch(layout, /SentinelV2Panels/);
  assert.doesNotMatch(layout, /Strategy2Visibility/);
  assert.doesNotMatch(layout, /StrategyLabInline/);
  assert.match(layout, /strategy-2-unified\.css/);
  assert.match(layout, /<LiveOrdersInline \/>/);
});

test("existing dashboard shell remains compatible while production labels are upgraded to Human Trader semantics", async () => {
  const [dashboard, semantics] = await Promise.all([
    readFile(new URL("../app/strategy-2-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ui-status-semantic-fix.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /MARKET PULSE · STRATEGY 2\.0/);
  assert.match(dashboard, /PORTFOLIO \+ LEARNING · STRATEGY 2\.0/);
  assert.match(dashboard, /Global × Asset × Playbook × Direction/);
  assert.match(dashboard, /TRADE/);
  assert.match(dashboard, /WATCH/);
  assert.match(dashboard, /REJECT/);
  assert.match(semantics, /Human Trader Engine · 3 位独立交易员/);
  assert.match(semantics, /Human Trader 市场智能/);
  assert.match(semantics, /Human Trader 执行与学习/);
  assert.match(semantics, /Trader → Setup → Risk Governor → Execution → Learning/);
  assert.doesNotMatch(dashboard, /Sentinel Growth V2/);
});

test("legacy symbol-direction memory stays hidden and the adaptive learning surface remains available", async () => {
  const [dashboard, css, semantics] = await Promise.all([
    readFile(new URL("../app/strategy-2-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/strategy-2-unified.css", import.meta.url), "utf8"),
    readFile(new URL("../app/ui-status-semantic-fix.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(css, /\.order-ledger \.memory-card\{display:none!important\}/);
  assert.match(css, /strategy2-unified-market/);
  assert.match(dashboard, /结构化结果已纳入经验矩阵/);
  assert.match(dashboard, /不再汇总成“BTC LONG”旧记忆/);
  assert.match(semantics, /Human Trader Setup 校准/);
});

test("unified dashboard API exposes the adaptive hierarchical learner used by HT playbook identities", async () => {
  const [api, learning, adaptive, strategy] = await Promise.all([
    readFile(new URL("../app/api/v2/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/strategy-2-learning.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/strategy-2-adaptive-learning.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/sentinel-v2-strategy.ts", import.meta.url), "utf8"),
  ]);
  assert.match(api, /getStrategy2LearningDashboard\([^)]*\)/);
  assert.match(api, /strategyPool/);
  assert.match(api, /learning/);
  assert.match(learning, /Exact Regime × Playbook × Asset-Regime × Direction/);
  assert.match(learning, /strategy2ExperienceKey\(row\.playbook, row\.globalRegime, row\.assetRegime, row\.side\)/);
  assert.match(learning, /makeAdaptivePrior/);
  assert.match(learning, /getStrategy2LearningDashboard/);
  assert.match(learning, /negative_edge/);
  assert.match(learning, /degrading/);
  assert.match(adaptive, /recencyWeight/);
  assert.match(adaptive, /directionFailureRate/);
  assert.match(adaptive, /inverseT1PotentialRate/);
  assert.match(adaptive, /ADAPTIVE_LEARNING_FORWARD_EPOCH_MS/);
  assert.match(strategy, /LEARNED_EDGE_NEGATIVE/);
  assert.match(strategy, /learningScore/);
  assert.match(strategy, /HT1_DENNIS_TREND|evaluateHumanTraderPool/);
});

test("opportunity detail keeps setup, environment, risk and explanation observability", async () => {
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
});

test("Human Trader opportunities enter the normal lifecycle with one owner and no multi-strategy vote", async () => {
  const [growthRepository, strategy, engine] = await Promise.all([
    readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/sentinel-v2-strategy.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/human-trader-engine.ts", import.meta.url), "utf8"),
  ]);
  assert.match(growthRepository, /Human Trader Engine 3\.0 当前由/);
  assert.match(growthRepository, /Human Risk Governor/);
  assert.match(growthRepository, /processDecision\(growthPacket\(packet,\s*selected,\s*governor\),\s*settings\)/);
  assert.match(strategy, /Human Trader Engine 单一开仓权/);
  assert.match(strategy, /At most one human trader owns a symbol/);
  assert.match(strategy, /supportingPlaybooks:\s*\[\]/);
  assert.match(strategy, /strategyConflict:\s*0/);
  assert.match(engine, /Exactly three independent traders/);
  assert.doesNotMatch(growthRepository, /多策略同向汇合/);
  assert.doesNotMatch(strategy, /Strategy 2\.0 综合许可/);
});
