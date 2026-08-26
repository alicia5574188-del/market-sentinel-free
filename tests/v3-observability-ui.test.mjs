import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bottom navigation keeps concise original labels", async () => {
  const semantics = await readFile(new URL("../app/ui-status-semantic-fix.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(semantics, /normalizeNavigationCopy/);
  assert.doesNotMatch(semantics, /label\.textContent = "量化"/);
});

test("global layout mounts only the compact V2 market context, not strategy dashboards over every tab", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(layout, /OpportunityStrategyDiagnostics/);
  assert.doesNotMatch(layout, /StrategyLabInline/);
  assert.match(layout, /<SentinelV2ContextBar \/>/);
  assert.match(layout, /<LiveOrdersInline \/>/);
});

test("V2 opportunities keep playbook, environment and explanation inside normal orders", async () => {
  const growthRepository = await readFile(new URL("../lib/shadow-strategy-repository.ts", import.meta.url), "utf8");
  assert.match(growthRepository, /trigger: `\$\{selected\.playbookLabel\}/);
  assert.match(growthRepository, /thesis: `Sentinel Growth V2 当前由/);
  assert.match(growthRepository, /Transition \$\{evaluation\.context\.transitionRisk\}/);
  assert.match(growthRepository, /evidence/);
  assert.match(growthRepository, /processDecision\(growthPacket\(packet, selected, evaluation\), settings\)/);
});
