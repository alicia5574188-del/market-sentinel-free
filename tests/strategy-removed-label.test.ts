import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { memberForwardView } from "../lib/member-view.ts";
import { runtimeReady, runtimeStatusLabel, runtimeNotice } from "../lib/runtime-health.ts";

const T = 1_800_000_000_000;
const old = T - 3 * 86_400_000;

test("page runtime forward view carries strategyRemoved (系统页不再显示「策略周期未推进」)", () => {
  const src = readFileSync("worker/index-clean.ts", "utf8");
  const body = src.slice(src.indexOf("private forwardView("), src.indexOf("private forwardHealth("));
  assert.equal((body.match(/strategyRemoved: true/g) ?? []).length, 2, "both the normal and the recovery branch");
});

test("member projection keeps strategyRemoved, so the member label is not a false stall", () => {
  const view = memberForwardView({ mode: "PAPER", strategyRemoved: true, lastCycleAt: old, storage: { error: null, persistedAt: old }, positions: [], history: [] }, null, []);
  assert.equal(view?.strategyRemoved, true);
  const base = { stale: false, authorityReady: true, lastError: null, lastSuccessAt: T,
    realtimeReadiness: { capacity: 2, actionableMarkets: 2, protectedMarketsReady: true }, forward: view };
  assert.equal(runtimeStatusLabel({ ...base, state: "LIVE" }), "后台运行中");
  assert.equal(runtimeStatusLabel({ ...base, state: "IDLE", standby: { idle: true } }), "空仓待命");
  assert.equal(runtimeNotice({ ...base, state: "LIVE" }), null);
  assert.equal(runtimeReady({ ...base, state: "LIVE" }), true);
  // without the flag the same frozen cycle still reads as a stall (old behaviour kept for a live forward strategy)
  const stalled = memberForwardView({ mode: "PAPER", lastCycleAt: old, storage: { error: null, persistedAt: old } }, null, []);
  assert.equal(runtimeStatusLabel({ ...base, state: "LIVE", forward: stalled }), "后台运行中 · 策略周期未推进");
  // a real paper-account storage error is still reported
  assert.equal(runtimeStatusLabel({ ...base, state: "LIVE", forward: { ...view!, storage: { error: "disk", persistedAt: old } } }), "后台运行中 · 策略存储异常");
});
