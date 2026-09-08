import assert from "node:assert/strict";
import test from "node:test";
import { advanceRejectionAudit, initialRejectionAudit, recordRejectedCandidate } from "../lib/rejection-audit.ts";
import type { EventEntryAssessment, RadarCandidate } from "../lib/market-radar.ts";

const candidate: RadarCandidate = { id: "X_USDT:1", symbol: "X_USDT", side: "LONG", strength: 60, moveRate: 0.002,
  movementMultiple: 2, volume24hUsd: 100_000_000, confirmations: 2, firstSeenAt: 1, observedAt: 2,
  kind: "PRICE_SHOCK", openInterestChangeRate: 0, referencePrice: 99.8 };
const assessment: EventEntryAssessment = { accepted: false, blocker: "方向证据 1/3", alignedFlow: 0, spreadBps: 4,
  nearBidDepthUsd: 60_000, nearAskDepthUsd: 60_000, extensionRate: 0.002, costShare: 0.2,
  conservativeWinRate: 0.485, expectedReturnRate: 0.001, qualityScore: 1, qualityRequired: 3,
  qualityEvidence: ["三轮扫描"], failedRules: [{ id: "QUALITY_SCORE", label: "方向证据 1/3", kind: "DIRECTION" }] };

test("one rejected event creates one frozen shadow trade and deduplicates later snapshots", () => {
  let state = recordRejectedCandidate({ state: initialRejectionAudit(1_000), candidate, assessment, midpoint: 100,
    stopRate: 0.0032, targetRate: 0.0085, now: 2_000 });
  state = recordRejectedCandidate({ state, candidate, assessment, midpoint: 100.1, stopRate: 0.0032,
    targetRate: 0.0085, now: 4_000 });
  assert.equal(Object.keys(state.pending).length, 1);
  const sample = Object.values(state.pending)[0];
  assert.equal(sample.entryPrice, 100);
  assert.equal(sample.targetPrice, 100.85);
  assert.equal(sample.stopPrice, 99.68);
});

test("bulk ticker path resolves rejected candidates and attributes after-cost outcomes to every failed rule", () => {
  const multiRule = { ...assessment, failedRules: [...assessment.failedRules,
    { id: "OPPOSITE_FLOW" as const, label: "实时主动资金明显反向", kind: "DIRECTION" as const }] };
  let state = recordRejectedCandidate({ state: initialRejectionAudit(1_000), candidate, assessment: multiRule,
    midpoint: 100, stopRate: 0.0032, targetRate: 0.0085, now: 2_000 });
  state = advanceRejectionAudit({ state, quotes: { X_USDT: 100.3 }, now: 12_000, roundTripFrictionRate: 0.0018 });
  assert.equal(Object.keys(state.pending).length, 1);
  state = advanceRejectionAudit({ state, quotes: { X_USDT: 100.9 }, now: 22_000, roundTripFrictionRate: 0.0018 });
  assert.equal(Object.keys(state.pending).length, 0);
  assert.equal(state.completed, 1);
  assert.equal(state.recent[0].outcome, "TARGET_FIRST");
  assert.equal(state.recent[0].profitableAfterCost, true);
  assert.equal(state.rules.QUALITY_SCORE.profitableAfterCost, 1);
  assert.equal(state.rules.OPPOSITE_FLOW.targetFirst, 1);
});

test("unresolved rejected candidate closes at the frozen twenty-minute horizon", () => {
  let state = recordRejectedCandidate({ state: initialRejectionAudit(1_000), candidate, assessment, midpoint: 100,
    stopRate: 0.0032, targetRate: 0.0085, now: 2_000 });
  state = advanceRejectionAudit({ state, quotes: { X_USDT: 100.1 }, now: 1_202_000, roundTripFrictionRate: 0.0018 });
  assert.equal(state.recent[0].outcome, "TIME_EXPIRED");
  assert.equal(state.recent[0].feeCovered, false);
  assert.equal(state.recent[0].profitableAfterCost, false);
});

test("shadow trade mirrors the event ten-minute no-progress exit", () => {
  let state = recordRejectedCandidate({ state: initialRejectionAudit(1_000), candidate, assessment, midpoint: 100,
    stopRate: 0.0032, targetRate: 0.0085, now: 2_000 });
  state = advanceRejectionAudit({ state, quotes: { X_USDT: 100.02 }, now: 602_000, roundTripFrictionRate: 0.0018 });
  assert.equal(state.recent[0].outcome, "STALLED_EXIT");
  assert.equal(state.rules.QUALITY_SCORE.stalledExit, 1);
});
