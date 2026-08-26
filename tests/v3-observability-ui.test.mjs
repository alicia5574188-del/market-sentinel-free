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

test("V2 opportunities still enter the normal order lifecycle with detailed explanation", async () => {
  const [growthRepository, v2Strategy] = await Promise.all([
    readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/sentinel-v2-strategy.ts", import.meta.url), "utf8"),
  ]);
  assert.match(growthRepository, /trigger: `成长策略 · \$\{signal\.label\}/);
  assert.match(growthRepository, /evidence/);
  assert.match(growthRepository, /processDecision\(growthPacket\(packet, selected\), settings\)/);
  assert.match(v2Strategy, /Sentinel Growth V2/);
  assert.match(v2Strategy, /Sentinel V2 环境许可/);
});
