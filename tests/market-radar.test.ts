import assert from "node:assert/strict";
import test from "node:test";
import { updateRadar, type RadarBaseline, type RadarTicker } from "../lib/market-radar.ts";

const ticker = (last: number, openInterest = 1_000): RadarTicker => ({
  symbol: "X_USDT", last, volume24hUsd: 20_000_000, fundingRate: 0, openInterest,
});

test("all-market radar requires a personal baseline before flagging a price shock", () => {
  let baselines: Record<string, RadarBaseline> = {};
  for (let index = 0; index < 3; index += 1) {
    const scan = updateRadar(baselines, [ticker(100 + index * 0.01)], new Set(["X_USDT"]), index * 10_000);
    baselines = scan.baselines;
    assert.equal(scan.candidates.length, 0);
  }
  const shock = updateRadar(baselines, [ticker(100.25, 1_005)], new Set(["X_USDT"]), 30_000);
  assert.equal(shock.scanned, 1);
  assert.equal(shock.candidates[0]?.side, "LONG");
  assert.equal(shock.candidates[0]?.kind, "NEW_MONEY");
  assert.equal(shock.candidates[0]?.confirmations, 1);
});

test("an anomaly survives quiet confirmation scans long enough for realtime entry analysis", () => {
  let baselines: Record<string, RadarBaseline> = {};
  for (let index = 0; index < 3; index += 1) baselines = updateRadar(baselines, [ticker(100)], new Set(["X_USDT"]), index * 10_000).baselines;
  let scan = updateRadar(baselines, [ticker(100.2)], new Set(["X_USDT"]), 30_000);
  scan = updateRadar(scan.baselines, [ticker(100.21)], new Set(["X_USDT"]), 40_000);
  assert.equal(scan.candidates[0]?.confirmations, 2);
  assert.equal(scan.candidates[0]?.id, "X_USDT:30000");
});

test("illiquid and non-trading contracts never enter the candidate pool", () => {
  const prior: Record<string, RadarBaseline> = {
    X_USDT: { last: 100, observedAt: 0, samples: 5, movementEma: 0.0001, eventStartedAt: null,
      confirmations: 0, quietScans: 5, eventSide: null, eventStrength: 0, eventMoveRate: 0, openInterest: 1_000 },
  };
  assert.equal(updateRadar(prior, [{ ...ticker(101), volume24hUsd: 500_000 }], new Set(["X_USDT"]), 10_000).candidates.length, 0);
  assert.equal(updateRadar(prior, [ticker(101)], new Set(), 10_000).candidates.length, 0);
});
