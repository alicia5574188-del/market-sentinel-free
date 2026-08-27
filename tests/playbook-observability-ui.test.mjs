import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Playbook diagnostics are explicitly read-only observation tooling", async () => {
  const [route, component] = await Promise.all([
    readFile(new URL("../app/api/v2/playbook-diagnostics/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/strategy-2-playbook-diagnostics.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(route, /observationOnly: true/);
  assert.match(route, /strategyLogicChanged: false/);
  assert.match(route, /不修改触发阈值、评分、风险、Execution Engine 或实盘权限/);
  assert.doesNotMatch(route, /live-trading-engine/);
  assert.doesNotMatch(route, /strategy-2-engine/);
  assert.doesNotMatch(route, /sentinel-v2-strategy/);

  assert.match(component, /Playbook 使用诊断/);
  assert.match(component, /观察模式 · 不改策略参数/);
  assert.match(component, /“未覆盖”只表示还没有完成学习样本，不等于策略没有运行/);
  assert.match(component, /TRADE候选/);
});

test("diagnostics enumerate all 12 Playbooks and explain missing coverage conservatively", async () => {
  const route = await readFile(new URL("../app/api/v2/playbook-diagnostics/route.ts", import.meta.url), "utf8");
  for (let index = 1; index <= 12; index += 1) {
    assert.match(route, new RegExp(`P${index}_`));
  }
  assert.match(route, /等待生命周期自然完成，不降低门槛/);
  assert.match(route, /先观察市场是否出现适配环境，不人为放宽条件/);
});
