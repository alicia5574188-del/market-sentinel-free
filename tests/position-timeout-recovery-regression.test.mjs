import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [recovery, route] = await Promise.all([
  readFile(new URL("../lib/position-timeout-recovery.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/hte/route.ts", import.meta.url), "utf8"),
]);

test("overdue simulated positions can timeout without a fresh Gate quote", () => {
  assert.match(recovery, /recoverOverdueSimulationTimeouts/);
  assert.match(recovery, /now - trade\.entryAt >= trade\.maxHoldingMinutes \* 60_000/);
  assert.match(recovery, /trade\.lastPrice/);
  assert.match(recovery, /trade\.entryPrice/);
  assert.match(recovery, /processPositionQuote/);
  assert.match(recovery, /highPrice: null/);
  assert.match(recovery, /lowPrice: null/);
  assert.doesNotMatch(recovery, /fetchGate/);
  assert.doesNotMatch(recovery, /runMarketScan/);
});

test("HTE snapshot executes clock timeout recovery before ordinary stale quote refresh", () => {
  const hardIndex = route.indexOf("timeoutRecovery = await recoverOverdueSimulationTimeouts(requestedAt)");
  const quoteIndex = route.indexOf("positionSafety = await refreshStaleOpenPositionsForSafety()", hardIndex + 1);
  assert.ok(hardIndex > 0);
  assert.ok(quoteIndex > hardIndex);
  assert.match(route, /timeoutRecovery/);
  assert.match(route, /errors\.timeoutRecovery/);
});
