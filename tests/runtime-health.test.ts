import assert from "node:assert/strict";
import test from "node:test";
import { runtimeAuthorityOperational, runtimeNotice, runtimeReady, runtimeStatusLabel, type RuntimeHealthShape } from "../lib/runtime-health.ts";

const symbols = Array.from({ length: 10 }, (_, index) => `S${index}`);
const live = (): RuntimeHealthShape => ({ state: "LIVE", stale: false, authorityReady: true, lastError: null,
  symbols, realtimeReadiness: { capacity: 10, actionableMarkets: 6, protectedMarketsReady: true } });

test("runtime readiness separates service health from current opportunity count", () => {
  assert.equal(runtimeReady(live()), true);
  assert.equal(runtimeReady(null), false);
  assert.equal(runtimeReady(live(), false), false);
  assert.equal(runtimeReady({ ...live(), state: "DEGRADED" }), true, "isolated market degradation is not an authority outage");
  for (const state of ["STARTING", "WARMING", "RECONNECTING", "RECOVERY_REQUIRED"]) assert.equal(runtimeReady({ ...live(), state }), false);
  assert.equal(runtimeReady({ ...live(), stale: true }), false);
  assert.equal(runtimeReady({ ...live(), authorityReady: false }), false);
  assert.equal(runtimeReady({ ...live(), lastError: "D1 mirror pending" }), true, "optional history mirroring is not a trading outage");
  assert.equal(runtimeReady({ ...live(), symbols: symbols.slice(0, 9) }), true, "pool fill is diagnostic, not service liveness");
  assert.equal(runtimeReady({ ...live(), realtimeReadiness: { capacity: 10, actionableMarkets: 0, protectedMarketsReady: true } }), true,
    "having no entry-ready market right now is normal and must not report an outage");
  assert.equal(runtimeReady({ ...live(), realtimeReadiness: { capacity: 10, actionableMarkets: 6, protectedMarketsReady: false } }), false);
  assert.equal(runtimeReady({ ...live(), realtimeReadiness: { capacity: 3, actionableMarkets: 3, protectedMarketsReady: true } }), true);
});

test("operator status reserves recovery wording for genuine authority failure", () => {
  const waiting = { ...live(), state: "DEGRADED", lastError: "10 realtime markets warming; entries blocked",
    realtimeReadiness: { capacity: 10, actionableMarkets: 0, protectedMarketsReady: true } };
  assert.equal(runtimeAuthorityOperational(waiting), true);
  assert.equal(runtimeStatusLabel(waiting), "后台运行中");
  assert.match(runtimeNotice(waiting) ?? "", /后台持续运行/);
  assert.doesNotMatch(runtimeNotice(waiting) ?? "", /系统正在自动恢复/);

  const reconnecting = { ...live(), state: "RECONNECTING", lastError: "10 market snapshots unavailable; retrying" };
  assert.equal(runtimeAuthorityOperational(reconnecting), false);
  assert.equal(runtimeStatusLabel(reconnecting), "行情重连中");
  assert.match(runtimeNotice(reconnecting) ?? "", /系统正在自动恢复/);

  const warming = { ...live(), state: "WARMING", realtimeReadiness: { capacity: 10, actionableMarkets: 0, protectedMarketsReady: true } };
  assert.equal(runtimeAuthorityOperational(warming), true);
  assert.equal(runtimeStatusLabel(warming), "后台运行中 · 数据预热");
});
