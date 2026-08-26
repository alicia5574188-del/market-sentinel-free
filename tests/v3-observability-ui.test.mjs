import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bottom navigation keeps concise original labels", async () => {
  const semantics = await readFile(new URL("../app/ui-status-semantic-fix.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(semantics, /normalizeNavigationCopy/);
  assert.doesNotMatch(semantics, /label\.textContent = "量化"/);
});

test("global layout mounts V2 panels without replacing the stable page shell", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(layout, /OpportunityStrategyDiagnostics/);
  assert.doesNotMatch(layout, /StrategyLabInline/);
  assert.match(layout, /<SentinelV2Panels \/>/);
  assert.match(layout, /<LiveOrdersInline \/>/);
});

test("V2 panels expose environment, transition, opportunity and thesis health on the three core pages", async () => {
  const panels = await readFile(new URL("../app/sentinel-v2-panels.tsx", import.meta.url), "utf8");
  assert.match(panels, /Sentinel Growth V2/);
  assert.match(panels, /环境先于信号/);
  assert.match(panels, /环境变化雷达/);
  assert.match(panels, /账户风险与交易逻辑健康度/);
  assert.match(panels, /TRADE/);
  assert.match(panels, /WATCH/);
  assert.match(panels, /REJECT/);
  assert.match(panels, /riskMultiplier/);
  assert.match(panels, /thesisHealth/);
});

test("opportunity detail is V2-first and collapses legacy diagnostics by default", async () => {
  const panels = await readFile(new URL("../app/sentinel-v2-panels.tsx", import.meta.url), "utf8");
  assert.match(panels, /selectedOpportunity/);
  assert.match(panels, /机会评分/);
  assert.match(panels, /环境/);
  assert.match(panels, /结构/);
  assert.match(panels, /时机/);
  assert.match(panels, /确认/);
  assert.match(panels, /还差什么/);
  assert.match(panels, /为什么拒绝/);
  assert.match(panels, /查看底层详细分析/);
  assert.match(panels, /v2-opportunity-detail-active:not\(\.v2-show-legacy-analysis\) \.analysis-matrix/);
  assert.match(panels, /\.risk-note\{display:none!important\}/);
  assert.match(panels, /V2 机会通过后仍需组合风险与 Execution Engine 复核/);
});

test("Strategy 2.0 opportunities still enter the normal order lifecycle with detailed explanation", async () => {
  const [growthRepository, v2Strategy] = await Promise.all([
    readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/sentinel-v2-strategy.ts", import.meta.url), "utf8"),
  ]);
  assert.match(growthRepository, /trigger:`Strategy 2\.0 · \$\{signal\.label\}/);
  assert.match(growthRepository, /多策略同向汇合/);
  assert.match(growthRepository, /processDecision\(growthPacket\(packet,\s*selected\),\s*settings\)/);
  assert.match(v2Strategy, /Sentinel Strategy 2\.0/);
  assert.match(v2Strategy, /Strategy 2\.0 综合许可/);
  assert.match(v2Strategy, /supportingPlaybooks/);
  assert.match(v2Strategy, /strategyConflict/);
});
