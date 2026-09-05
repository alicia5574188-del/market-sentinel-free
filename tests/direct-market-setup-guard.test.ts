import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDirectSetupGuard } from "../lib/direct-market-setup-guard.ts";

const now = 1_800_000_000_000;

test("three independent consecutive losses pause only that strategy cell immediately", () => {
  const result = evaluateDirectSetupGuard(Array.from({ length: 3 }, (_, index) => ({
    independentEventKey: `loss-${index}`,
    resultR: -1,
    exitAt: now - index * 60_000,
  })), now);
  assert.equal(result.state, "PAUSED");
  assert.equal(result.losingStreak, 3);
  assert.match(result.reason, /独立暂停/);
});

test("correlated duplicate orders count once and a delayed cell gets one revalidation", () => {
  const result = evaluateDirectSetupGuard([
    { independentEventKey: "same", resultR: -1, exitAt: now - 13 * 60 * 60_000 },
    { independentEventKey: "same", resultR: -1, exitAt: now - 13 * 60 * 60_000 },
    { independentEventKey: "two", resultR: -1, exitAt: now - 14 * 60 * 60_000 },
    { independentEventKey: "three", resultR: -1, exitAt: now - 15 * 60 * 60_000 },
  ], now);
  assert.equal(result.sampleCount, 3);
  assert.equal(result.state, "ACTIVE");
  assert.equal(result.revalidation, true);
});
