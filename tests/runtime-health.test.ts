import assert from "node:assert/strict";
import test from "node:test";
import { runtimeReady, type RuntimeHealthShape } from "../lib/runtime-health.ts";

const symbols = Array.from({ length: 10 }, (_, index) => `S${index}`);
const live = (): RuntimeHealthShape => ({ state: "LIVE", stale: false, authorityReady: true, lastError: null,
  symbols, realtimeReadiness: { capacity: 10, actionableMarkets: 6, protectedMarketsReady: true } });

test("runtime readiness rejects every stale, incomplete, recovery, or transport-old view", () => {
  assert.equal(runtimeReady(live()), true);
  assert.equal(runtimeReady(null), false);
  assert.equal(runtimeReady(live(), false), false);
  for (const state of ["STARTING", "WARMING", "DEGRADED", "RECONNECTING", "RECOVERY_REQUIRED"]) assert.equal(runtimeReady({ ...live(), state }), false);
  assert.equal(runtimeReady({ ...live(), stale: true }), false);
  assert.equal(runtimeReady({ ...live(), authorityReady: false }), false);
  assert.equal(runtimeReady({ ...live(), lastError: "D1 mirror pending" }), true, "optional history mirroring is not a trading outage");
  assert.equal(runtimeReady({ ...live(), symbols: symbols.slice(0, 9) }), false);
  assert.equal(runtimeReady({ ...live(), symbols: [...symbols.slice(0, 9), symbols[0]] }), false);
  assert.equal(runtimeReady({ ...live(), realtimeReadiness: { capacity: 10, actionableMarkets: 0, protectedMarketsReady: true } }), false);
  assert.equal(runtimeReady({ ...live(), realtimeReadiness: { capacity: 10, actionableMarkets: 6, protectedMarketsReady: false } }), false);
  assert.equal(runtimeReady({ ...live(), realtimeReadiness: { capacity: 3, actionableMarkets: 3, protectedMarketsReady: true } }), false);
});
