import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHte31StrategyHealth } from "../lib/hte31-strategy-health.ts";

const base = {
  sampleCount: 12,
  expectancyR: 0.2,
  recentSampleCount: 8,
  recentExpectancyR: 0.2,
  baselineSampleCount: 4,
  baselineExpectancyR: 0.2,
  everProfitable: true,
  evaluations: 100,
  triggerActive: 10,
  ready: 2,
  nearReady: 1,
  topFailures: [{ label: "成交量确认", count: 20, rate: 0.2 }],
};

test("a once-profitable strategy is marked degraded when recent evidence turns negative", () => {
  const result = evaluateHte31StrategyHealth({
    ...base,
    baselineSampleCount: 12,
    baselineExpectancyR: 0.4,
    recentSampleCount: 6,
    recentExpectancyR: -0.35,
  });
  assert.equal(result.state, "DEGRADED");
  assert.match(result.action, /环境、方向、进场和出场/);
});

test("an unused strategy with active triggers is diagnosed as condition-starved", () => {
  const result = evaluateHte31StrategyHealth({ ...base, sampleCount: 0, ready: 0, triggerActive: 9 });
  assert.equal(result.state, "STARVED");
  assert.match(result.reason, /成交量确认/);
  assert.match(result.action, /模拟/);
});

test("an unused strategy without a trigger waits for its regime instead of being loosened", () => {
  const result = evaluateHte31StrategyHealth({ ...base, sampleCount: 0, ready: 0, triggerActive: 0 });
  assert.equal(result.state, "REGIME_WAIT");
  assert.match(result.action, /不为增加开单而降低核心定义/);
});

test("negative combinations pause without deleting the whole strategy", () => {
  const result = evaluateHte31StrategyHealth({ ...base, guardState: "PAUSED" });
  assert.equal(result.state, "PAUSED");
  assert.match(result.action, /保留策略本体/);
});
