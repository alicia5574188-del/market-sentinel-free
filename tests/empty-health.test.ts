import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { emptyAccountStandby, marketDataStale, runtimeBackendOperational, runtimeReady, runtimeStatusLabel, runtimeNotice,
  type RuntimeHealthShape } from "../lib/runtime-health.ts";

const STALE = 30_000, NOW = 1_800_000_000_000;
const empty = { authorityReady: true, forwardLoaded: true, forwardError: null, paperPositions: 0, livePositions: 0, liveEntries: 0 };
const forward = { mode: "PAPER", lastCycleAt: NOW - 3_600_000, storage: { persistedAt: NOW - 3_599_000, error: null } };
/** what the DO publishes while idle: market feed silent for hours, nothing held */
const idlePayload = (): RuntimeHealthShape => ({ state: "IDLE", stale: false, authorityReady: true, lastError: null,
  lastSuccessAt: NOW - 6 * 3_600_000, standby: { idle: true, label: "空仓待命" }, forward,
  realtimeReadiness: { capacity: 30, actionableMarkets: 0, protectedMarketsReady: true } });

test("empty account: silent market feed is standby, not a fault", () => {
  assert.equal(emptyAccountStandby(empty), true);
  assert.equal(marketDataStale({ authorityReady: true, standby: true, lastSuccessAt: NOW - 6 * 3_600_000, now: NOW, staleAfterMs: STALE }), false);
  assert.equal(marketDataStale({ authorityReady: true, standby: true, lastSuccessAt: null, now: NOW, staleAfterMs: STALE }), false);
  const p = idlePayload();
  assert.equal(runtimeBackendOperational(p), true);
  assert.equal(runtimeReady(p), true, "/__health ok/ready must be true while idle");
  assert.equal(runtimeStatusLabel(p), "空仓待命");
  assert.equal(runtimeNotice(p), null, "no 'sources unavailable' warning while idle");
});

test("any paper position, live position or live entry ends standby and the freshness check returns", () => {
  for (const patch of [{ paperPositions: 1 }, { livePositions: 1 }, { liveEntries: 1 }]) {
    assert.equal(emptyAccountStandby({ ...empty, ...patch }), false, JSON.stringify(patch));
  }
  assert.equal(emptyAccountStandby({ ...empty, forwardLoaded: false }), false);
  assert.equal(emptyAccountStandby({ ...empty, forwardError: "storage" }), false);
  assert.equal(emptyAccountStandby({ ...empty, authorityReady: false }), false);
  // holding a position, market data old -> stale (alarm)
  assert.equal(marketDataStale({ authorityReady: true, standby: false, lastSuccessAt: NOW - 31_000, now: NOW, staleAfterMs: STALE }), true);
  assert.equal(marketDataStale({ authorityReady: true, standby: false, lastSuccessAt: null, now: NOW, staleAfterMs: STALE }), true);
  assert.equal(marketDataStale({ authorityReady: true, standby: false, lastSuccessAt: NOW - 5_000, now: NOW, staleAfterMs: STALE }), false);
  assert.equal(marketDataStale({ authorityReady: false, standby: true, lastSuccessAt: NOW, now: NOW, staleAfterMs: STALE }), true,
    "an unrecovered authority is never masked by standby");
  const holding: RuntimeHealthShape = { ...idlePayload(), state: "RECONNECTING", stale: true, standby: null,
    lastError: "Bybit/OKX/KuCoin分析源与Gate执行源同时不可用" };
  assert.equal(runtimeReady(holding), false);
  assert.equal(runtimeStatusLabel(holding), "行情重连中");
});

test("a stray IDLE state without the standby flag never passes as healthy", () => {
  assert.equal(runtimeBackendOperational({ ...idlePayload(), standby: null }), false);
  assert.equal(runtimeReady({ ...idlePayload(), standby: { idle: false } }), false);
  assert.equal(runtimeReady({ ...idlePayload(), stale: true }), false);
  assert.equal(runtimeReady({ ...idlePayload(), authorityReady: false }), false);
  assert.equal(runtimeReady({ ...idlePayload(), forward: { ...forward, storage: { error: "x" } } }), false, "storage failure still reported");
});

test("worker wiring: every health surface uses the standby-aware check; live switch and reset logic untouched", () => {
  const w = readFileSync(new URL("../worker/index-clean.ts", import.meta.url), "utf8");
  // old raw staleness expressions are gone from owner-home, /health-status and /runtime
  assert.doesNotMatch(w, /const stale\s*=\s*!this\.authorityReady\s*\|\|\s*this\.runtime\.lastSuccessAt\s*==\s*null/);
  assert.equal((w.match(/this\.marketStale\(/g) ?? []).length >= 3, true);
  assert.match(w, /standby: this\.standbyView\(\)/);
  const helpers = w.slice(w.indexOf("private idleStandby"), w.indexOf("private stripResetBlockedNote"));
  assert.match(helpers, /activeLivePositions\(\)\.length/);
  assert.match(helpers, /activeLiveEntries\(\)\.length/);
  assert.doesNotMatch(helpers, /requestedEnabled|operational\s*=|setLive|gateFetch|fetch\(|storage\.(put|delete)/, "pure read: no switch, no Gate, no write");
  // protected-quote path (held positions) is unchanged: DEGRADED still driven by protectedMarketsReady
  assert.match(w, /!readiness\.protectedMarketsReady\?"DEGRADED"/);
  // the market refresh itself is still skipped only when nothing is held
  assert.match(w, /if\(!this\.forwardState\?\.positions\.length\)return;\s*\n\s*const task=this\.marketHub\.launchRefresh/);
  // reset logic unchanged
  assert.match(w, /applyStripCoreReset/);
  assert.match(w, /liveMirrorBlocker\(\)/);
});
