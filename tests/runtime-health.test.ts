import assert from "node:assert/strict";
import test from "node:test";
import { runtimeReady, type RuntimeHealthShape } from "../lib/runtime-health.ts";

const live = (): RuntimeHealthShape => ({ state: "LIVE", stale: false, authorityReady: true, lastError: null,
  symbols: ["A", "B", "C"], evidence: Object.fromEntries(["A", "B", "C"].map((symbol) => [symbol, { fresh: true, ancillaryFresh: true }])) });

test("runtime readiness rejects every stale, incomplete, recovery, or transport-old view", () => {
  assert.equal(runtimeReady(live()), true);
  assert.equal(runtimeReady(null), false);
  assert.equal(runtimeReady(live(), false), false);
  for (const state of ["STARTING", "WARMING", "DEGRADED", "RECONNECTING", "RECOVERY_REQUIRED"]) assert.equal(runtimeReady({ ...live(), state }), false);
  assert.equal(runtimeReady({ ...live(), stale: true }), false);
  assert.equal(runtimeReady({ ...live(), authorityReady: false }), false);
  assert.equal(runtimeReady({ ...live(), lastError: "mirror pending" }), false);
  assert.equal(runtimeReady({ ...live(), symbols: ["A", "B"] }), false);
  assert.equal(runtimeReady({ ...live(), symbols: ["A", "A", "C"] }), false);
  assert.equal(runtimeReady({ ...live(), evidence: { ...live().evidence, A: { fresh: false, ancillaryFresh: true } } }), false);
  assert.equal(runtimeReady({ ...live(), evidence: { ...live().evidence, A: { fresh: true, ancillaryFresh: false } } }), false);
});
