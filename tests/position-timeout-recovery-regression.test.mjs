import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [legacyRecovery, legacyRoute, hte31Recovery] = await Promise.all([
  readFile(new URL("../lib/position-timeout-recovery.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/hte/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../worker/hte31-recovery-manager.ts", import.meta.url), "utf8"),
]);

test("retired contract_v2 timeout helper remains quote-independent and isolated from Gate scanning", () => {
  assert.match(legacyRecovery, /recoverOverdueSimulationTimeouts/);
  assert.match(legacyRecovery, /now - trade\.entryAt >= trade\.maxHoldingMinutes \* 60_000/);
  assert.match(legacyRecovery, /trade\.lastPrice/);
  assert.match(legacyRecovery, /trade\.entryPrice/);
  assert.match(legacyRecovery, /processPositionQuote/);
  assert.match(legacyRecovery, /highPrice: null/);
  assert.match(legacyRecovery, /lowPrice: null/);
  assert.doesNotMatch(legacyRecovery, /fetchGate/);
  assert.doesNotMatch(legacyRecovery, /runMarketScan/);
});

test("retired HTE API cannot invoke legacy timeout recovery; HTE31 replays missed candles before normal quote management", () => {
  assert.match(legacyRoute, /retiredLegacyApi/);
  assert.doesNotMatch(legacyRoute, /recoverOverdueSimulationTimeouts|refreshStaleOpenPositionsForSafety|refreshOpenPositions/);

  const replayIndex = hte31Recovery.indexOf("await replayStaleTrade(trade, settings, now)");
  const normalManagerIndex = hte31Recovery.indexOf("await super.alarm()", replayIndex + 1);
  assert.ok(replayIndex > 0);
  assert.ok(normalManagerIndex > replayIndex);
  assert.match(hte31Recovery, /fetchGateChartCandles\(trade\.symbol, trade\.lastEvaluatedAt, now\)/);
  assert.match(hte31Recovery, /sort\(\(a, b\) => a\.observedAt - b\.observedAt\)/);
  assert.match(hte31Recovery, /if \(result\.kind === "closed"\) return \{ replayed, closed: true \}/);
});
