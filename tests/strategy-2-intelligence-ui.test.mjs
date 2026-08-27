import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Strategy 2.0 keeps one product identity while exposing the intelligence layer", async () => {
  const dashboard = await readFile(new URL("../app/strategy-2-dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /Sentinel Strategy 2\.0/);
  assert.doesNotMatch(dashboard, /Strategy 2\.1/);
  assert.match(dashboard, /12 Playbook 并行策略池 · 动态专家权重/);
  assert.match(dashboard, /迁移概率估计/);
  assert.match(dashboard, /影子 Net EV/);
  assert.match(dashboard, /模型分歧/);
  assert.match(dashboard, /OOD/);
  assert.match(dashboard, /Learning Update/);
  assert.match(dashboard, /Shadow-first/);
});

test("intelligence UI explicitly preserves live execution authority boundaries", async () => {
  const [dashboard, intelligence, api] = await Promise.all([
    readFile(new URL("../app/strategy-2-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/strategy-2-intelligence.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v2/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /Execution Engine 与实盘总开关始终拥有最终权限/);
  assert.match(dashboard, /不冒充真实收益相关系数/);
  assert.match(intelligence, /liveDecisionAuthority: false/);
  assert.match(intelligence, /canIncreaseRisk: false/);
  assert.match(intelligence, /canOverrideHardSafety: false/);
  assert.match(intelligence, /canAutoPromote: false/);
  assert.match(api, /counterfactualArchive/);
});

test("counterfactual archive uses existing V2 opportunity storage without a new schema", async () => {
  const archive = await readFile(new URL("../lib/strategy-2-counterfactual.ts", import.meta.url), "utf8");
  assert.match(archive, /v2Opportunities/);
  assert.match(archive, /WATCH/);
  assert.match(archive, /REJECT/);
  assert.match(archive, /countDistinct/);
  assert.doesNotMatch(archive, /create table/i);
});
