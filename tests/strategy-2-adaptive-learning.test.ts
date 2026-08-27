import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTIVE_LEARNING_FORWARD_EPOCH_MS,
  summarizeAdaptiveLearning,
  type AdaptiveLearningObservation,
} from "../lib/strategy-2-adaptive-learning.ts";
import {
  strategy2BeijingSession,
  strategy2BeijingSessionLabel,
} from "../lib/strategy-2-session.ts";

function observation(
  resultR: number,
  index: number,
  options: { target1Hit?: boolean; mfeR?: number; maeR?: number; exitAt?: number } = {},
): AdaptiveLearningObservation {
  const riskPct = 1;
  const target1Hit = options.target1Hit ?? resultR > 0;
  return {
    exitAt: options.exitAt ?? ADAPTIVE_LEARNING_FORWARD_EPOCH_MS - 48 * 3_600_000 + index * 3_600_000,
    netPct: resultR * riskPct,
    plannedRiskPct: riskPct,
    mfePct: (options.mfeR ?? (target1Hit ? 1.35 : 0.12)) * riskPct,
    maePct: (options.maeR ?? (resultR < 0 ? -1.10 : -0.28)) * riskPct,
    target1Hit,
  };
}

test("sparse exact cells inherit a hierarchical prior instead of relearning from zero", () => {
  const rows = [observation(-0.50, 0), observation(-0.50, 1)];
  const stats = summarizeAdaptiveLearning(rows, { meanR: 0.50, strength: 8 });
  assert.equal(stats.rawExpectancyR, -0.5);
  assert.ok((stats.posteriorExpectancyR ?? -1) > 0.20, `posterior=${stats.posteriorExpectancyR}`);
  assert.ok((stats.posteriorExpectancyR ?? 1) < 0.50);
});

test("recent losses can mark a formerly acceptable edge as degrading", () => {
  const rows = [
    ...Array.from({ length: 16 }, (_, index) => observation(0.40, index, { target1Hit: true, mfeR: 1.3, maeR: -0.25 })),
    ...Array.from({ length: 8 }, (_, index) => observation(-0.80, 16 + index, { target1Hit: false, mfeR: 0.18, maeR: -0.9 })),
  ];
  const stats = summarizeAdaptiveLearning(rows);
  assert.ok((stats.recentExpectancyR ?? 0) <= -0.35);
  assert.ok((stats.driftR ?? 0) <= -0.25);
  assert.equal(stats.edgeState, "degrading");
});

test("repeated no-T1 losses with >=1R adverse excursion are classified as directional failure", () => {
  const rows = Array.from({ length: 12 }, (_, index) => observation(-1, index, {
    target1Hit: false,
    mfeR: 0.10,
    maeR: -1.20,
  }));
  const stats = summarizeAdaptiveLearning(rows);
  assert.equal(stats.edgeState, "negative");
  assert.ok((stats.directionFailureRate ?? 0) > 0.90);
  assert.ok((stats.inverseT1PotentialRate ?? 0) > 0.90);
  assert.ok((stats.edgeUpperBoundR ?? 1) < 0);
});

test("consistent T1-reaching positive trades can become a confidence-bounded positive edge", () => {
  const rows = Array.from({ length: 20 }, (_, index) => observation(1.20, index, {
    target1Hit: true,
    mfeR: 1.55,
    maeR: -0.25,
  }));
  const stats = summarizeAdaptiveLearning(rows);
  assert.equal(stats.edgeState, "positive");
  assert.ok((stats.edgeLowerBoundR ?? -1) > 0);
  assert.equal(stats.t1HitRate, 1);
  assert.ok(stats.edgeConfidence >= 50);
});

test("forward validation cohort excludes all trades completed before the frozen learning epoch", () => {
  const rows = [
    observation(0.5, 0, { exitAt: ADAPTIVE_LEARNING_FORWARD_EPOCH_MS - 1 }),
    observation(-0.5, 1, { exitAt: ADAPTIVE_LEARNING_FORWARD_EPOCH_MS + 1 }),
    observation(1.0, 2, { exitAt: ADAPTIVE_LEARNING_FORWARD_EPOCH_MS + 3_600_000 }),
  ];
  const stats = summarizeAdaptiveLearning(rows);
  assert.equal(stats.forwardSampleCount, 2);
  assert.equal(stats.forwardExpectancyR, 0.25);
});

test("Beijing trading sessions cover all 24 hours without creating a shutdown window", () => {
  const utc = (hour: number) => Date.UTC(2026, 7, 27, hour, 0, 0);
  assert.equal(strategy2BeijingSession(utc(16)), "overnight"); // Beijing 00:00
  assert.equal(strategy2BeijingSession(utc(22)), "morning");   // Beijing 06:00
  assert.equal(strategy2BeijingSession(utc(4)), "afternoon"); // Beijing 12:00
  assert.equal(strategy2BeijingSession(utc(10)), "evening");  // Beijing 18:00
  assert.equal(strategy2BeijingSession(utc(15)), "evening");  // Beijing 23:00
  assert.match(strategy2BeijingSessionLabel("overnight"), /00:00–06:00/);
  assert.match(strategy2BeijingSessionLabel("afternoon"), /12:00–18:00/);
});
