import assert from "node:assert/strict";
import test from "node:test";
import { assessEventEntry, selectRealtimePool, updateRadar, type RadarBaseline, type RadarTicker } from "../lib/market-radar.ts";
import type { BookSnapshot, FlowEvidence } from "../lib/liquidity-core.ts";

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
      confirmations: 0, quietScans: 5, eventSide: null, eventStrength: 0, eventMoveRate: 0,
      eventKind: null, eventReferencePrice: 0, eventOpenInterestChangeRate: 0, openInterest: 1_000 },
  };
  assert.equal(updateRadar(prior, [{ ...ticker(101), volume24hUsd: 500_000 }], new Set(["X_USDT"]), 10_000).candidates.length, 0);
  assert.equal(updateRadar(prior, [ticker(101)], new Set(), 10_000).candidates.length, 0);
});

test("one same-direction event keeps its identity through a quiet gap and freezes its type", () => {
  let baselines: Record<string, RadarBaseline> = {};
  for (let index = 0; index < 3; index += 1) baselines = updateRadar(baselines, [ticker(100)], new Set(["X_USDT"]), index * 10_000).baselines;
  let scan = updateRadar(baselines, [ticker(100.2, 1_001)], new Set(["X_USDT"]), 30_000);
  const eventId = scan.candidates[0]?.id;
  assert.equal(scan.candidates[0]?.kind, "NEW_MONEY");
  for (let index = 1; index <= 5; index += 1) scan = updateRadar(scan.baselines, [ticker(100.2, 1_001)], new Set(["X_USDT"]), 30_000 + index * 10_000);
  scan = updateRadar(scan.baselines, [ticker(100.45, 1_001)], new Set(["X_USDT"]), 90_000);
  assert.equal(scan.candidates[0]?.id, eventId);
  assert.equal(scan.candidates[0]?.kind, "NEW_MONEY");
});

const book = (spreadBps = 4, depth = 60_000): BookSnapshot => ({
  symbol: "X_USDT", observedAt: 1, sequence: 1, tickSize: 0.01,
  bids: [{ price: 100 - spreadBps / 20_000 * 100, size: depth }],
  asks: [{ price: 100 + spreadBps / 20_000 * 100, size: depth }],
});
const flow: FlowEvidence = { ofi: 0.8, micropriceDisplacementBps: 2, takerDelta: 0.7,
  openInterestDelta: 0.5, funding: 0, actualLiquidations: 0, priceResponseBps: 4 };
const candidate = {
  id: "X_USDT:1", symbol: "X_USDT", side: "LONG" as const, strength: 75, moveRate: 0.002,
  movementMultiple: 4, volume24hUsd: 100_000_000, confirmations: 2, firstSeenAt: 1, observedAt: 2,
  kind: "NEW_MONEY" as const, openInterestChangeRate: 0.001, referencePrice: 99.8,
};

test("event admission scores directional evidence while keeping execution gates hard", () => {
  const accepted = assessEventEntry({ candidate, midpoint: 100, snapshot: book(), flow, stopRate: 0.0032,
    targetRate: 0.0085, roundTripFrictionRate: 0.0018 });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.qualityScore, 4);
  assert.ok(accepted.expectedReturnRate > 0);
  const priceShock = assessEventEntry({ candidate: { ...candidate, kind: "PRICE_SHOCK" }, midpoint: 100,
    snapshot: book(), flow, stopRate: 0.0032, targetRate: 0.0085, roundTripFrictionRate: 0.0018 });
  assert.equal(priceShock.accepted, true);
  assert.equal(priceShock.qualityScore, 3);
  const weakAssessment = assessEventEntry({ candidate: { ...candidate, kind: "PRICE_SHOCK", strength: 59,
    confirmations: 2, movementMultiple: 2 }, midpoint: 100, snapshot: book(), flow: { ...flow, ofi: 0, takerDelta: 0,
    openInterestDelta: 0 }, stopRate: 0.0032, targetRate: 0.0085,
    roundTripFrictionRate: 0.0018 });
  assert.equal(weakAssessment.blocker, "方向证据 0/3");
  assert.deepEqual(weakAssessment.failedRules.map((rule) => rule.id), ["QUALITY_SCORE", "QUALITY_STRENGTH",
    "QUALITY_THIRD_CONFIRMATION", "QUALITY_NEW_MONEY", "QUALITY_ALIGNED_FLOW", "QUALITY_RELATIVE_MOVE"]);
  assert.equal(assessEventEntry({ candidate, midpoint: 100, snapshot: book(4, 1_000), flow,
    stopRate: 0.0032, targetRate: 0.0085, roundTripFrictionRate: 0.0018 }).blocker, "近端双边盘口深度不足");
  assert.equal(assessEventEntry({ candidate, midpoint: 100, snapshot: book(), flow: { ...flow, ofi: -1, takerDelta: -1 },
    stopRate: 0.0032, targetRate: 0.0085, roundTripFrictionRate: 0.0018 }).blocker, "实时主动资金明显反向");
  assert.equal(assessEventEntry({ candidate, midpoint: 100, snapshot: book(), flow,
    stopRate: 0.0032, targetRate: 0.006, roundTripFrictionRate: 0.0018 }).blocker, "交易成本占第一目标空间过高");
});

test("realtime pool keeps valid residents and replaces only candidates that expired", () => {
  assert.deepEqual(selectRealtimePool({
    locked: [], current: ["A_USDT", "B_USDT", "C_USDT"],
    candidates: ["D_USDT", "A_USDT", "E_USDT", "B_USDT", "C_USDT"],
    fallback: ["F_USDT"], limit: 3,
  }), ["A_USDT", "B_USDT", "C_USDT"]);
  assert.deepEqual(selectRealtimePool({
    locked: [], current: ["A_USDT", "B_USDT", "C_USDT"],
    candidates: ["D_USDT", "A_USDT", "E_USDT", "B_USDT"],
    fallback: ["F_USDT"], limit: 3,
  }), ["A_USDT", "B_USDT", "D_USDT"]);
  assert.deepEqual(selectRealtimePool({
    locked: ["C_USDT"], current: ["A_USDT", "B_USDT", "C_USDT"],
    candidates: ["D_USDT", "A_USDT", "B_USDT"],
    fallback: ["F_USDT"], limit: 3,
  }), ["C_USDT", "A_USDT", "B_USDT"]);
  assert.deepEqual(selectRealtimePool({
    locked: [], current: ["PRICE_SHOCK_A", "PRICE_SHOCK_B", "PRICE_SHOCK_C"],
    candidates: ["PRICE_SHOCK_A", "PRICE_SHOCK_B", "PRICE_SHOCK_C", "NEW_MONEY_WLD"],
    priorityCandidates: ["NEW_MONEY_WLD"], fallback: ["PRICE_SHOCK_D"], limit: 3,
  }), ["NEW_MONEY_WLD", "PRICE_SHOCK_A", "PRICE_SHOCK_B"]);
});
