import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bottom navigation keeps concise original labels", async () => {
  const semantics = await readFile(new URL("../app/ui-status-semantic-fix.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(semantics, /normalizeNavigationCopy/);
  assert.doesNotMatch(semantics, /label\.textContent = "量化"/);
});

test("global layout does not mount strategy dashboards over every tab", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(layout, /OpportunityStrategyDiagnostics/);
  assert.doesNotMatch(layout, /StrategyLabInline/);
  assert.match(layout, /<LiveOrdersInline \/>/);
});

test("growth modules keep detailed trigger and explanation inside normal orders", async () => {
  const growthRepository = await readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8");
  assert.match(growthRepository, /trigger: `成长策略 · \$\{signal\.label\}/);
  assert.match(growthRepository, /thesis: `哨兵成长策略当前由/);
  assert.match(growthRepository, /evidence/);
  assert.match(growthRepository, /processDecision\(growthPacket\(packet, selected\), settings\)/);
});
