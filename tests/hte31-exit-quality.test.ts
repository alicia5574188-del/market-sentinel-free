import test from "node:test";
import assert from "node:assert/strict";
import {
  hte31TimeoutExitReason,
  isSustainedHte31StopRecovery,
} from "../lib/hte31-exit-quality.ts";

test("TP1-achieving timeout is described as partial realization, not total thesis failure", () => {
  const reason = hte31TimeoutExitReason({
    maxHoldingMinutes: 100,
    target1Hit: true,
    maximumFavorableR: 1.58,
  });
  assert.match(reason, /已兑现至少第一目标/);
  assert.doesNotMatch(reason, /仍未兑现预期行为/);
});

test("temporary rebound followed by adverse continuation is not a fake stop", () => {
  assert.equal(isSustainedHte31StopRecovery({
    exitCode: "stop_loss",
    favorableR: 1.2,
    currentRecoveryR: 0,
    adverseR: 2.4,
  }), false);
});

test("sustained recovery can still be labeled a suspected fake stop", () => {
  assert.equal(isSustainedHte31StopRecovery({
    exitCode: "stop_loss",
    favorableR: 1.3,
    currentRecoveryR: 0.8,
    adverseR: 0.4,
  }), true);
});
