import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHte31PerformanceCell } from "../lib/hte31-performance-gate.ts";

test("four-sample negative cell pauses without disabling other strategy cells", () => {
  const result = evaluateHte31PerformanceCell({
    sampleCount: 4,
    wins: 1,
    losses: 3,
    expectancyR: -0.32,
    grossProfitR: 0.5,
    grossLossR: 1.8,
  });
  assert.equal(result.state, "PAUSED");
  assert.match(result.reason, /交易员\/环境\/方向组合/);
});

test("three straight losses pause earlier than the old twelve-sample trader gate", () => {
  const result = evaluateHte31PerformanceCell({
    sampleCount: 3,
    wins: 0,
    losses: 3,
    expectancyR: -0.7,
    grossProfitR: 0,
    grossLossR: 2.1,
  });
  assert.equal(result.state, "PAUSED");
});

test("sparse mixed cell stays active so global entry frequency is not reduced", () => {
  const result = evaluateHte31PerformanceCell({
    sampleCount: 3,
    wins: 1,
    losses: 2,
    expectancyR: -0.12,
    grossProfitR: 1.1,
    grossLossR: 1.45,
  });
  assert.equal(result.state, "ACTIVE");
});

test("positive expectancy cell remains active", () => {
  const result = evaluateHte31PerformanceCell({
    sampleCount: 8,
    wins: 4,
    losses: 4,
    expectancyR: 0.24,
    grossProfitR: 4.2,
    grossLossR: 2.3,
  });
  assert.equal(result.state, "ACTIVE");
  assert.ok((result.profitFactor ?? 0) > 1);
});
