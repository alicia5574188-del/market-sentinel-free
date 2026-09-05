import assert from "node:assert/strict";
import test from "node:test";
import {
  DIRECT_ACTIVITY_WINDOW_MS,
  emptyDirectTwelveHourActivity,
  recordDirectTwelveHourActivity,
} from "../lib/direct-market-activity.ts";
import type { DirectCoreSetup, DirectMarketCandidate, DirectSetupEvaluationSnapshot } from "../lib/direct-market-types.ts";

const INTERVAL_MS = 25_000;

function evaluations(selected: DirectCoreSetup): DirectSetupEvaluationSnapshot[] {
  return [
    { setup: "VOLUME_FORCE_FAILED_BREAKOUT", setupLabel: "量价力度假突破", side: "SHORT", score: 88, triggered: true, qualified: true, selected: selected === "VOLUME_FORCE_FAILED_BREAKOUT", blockers: [] },
    { setup: "EXHAUSTION_REVERSAL", setupLabel: "衰竭反转", side: "SHORT", score: 40, triggered: false, qualified: false, selected: selected === "EXHAUSTION_REVERSAL", blockers: ["价格尚未形成可验证衰竭"] },
    { setup: "MULTI_TIMEFRAME_RESONANCE", setupLabel: "多周期综合共振", side: "LONG", score: 82, triggered: true, qualified: true, selected: selected === "MULTI_TIMEFRAME_RESONANCE", blockers: [] },
  ];
}

function candidate(observedAt: number, selected: DirectCoreSetup = "VOLUME_FORCE_FAILED_BREAKOUT"): DirectMarketCandidate {
  return {
    symbol: "BTC_USDT", batchId: "batch", observedAt, freshness: "FRESH", scanStage: "DEEP",
    volumeRank: 1, volumeUsd: 1_000_000_000, riskClusterId: "btc-positive", btcCorrelation: 1,
    location: "TOP", paths: { up: 20, down: 65, rangeOrInvalid: 15 }, directionalScore: -0.7,
    netEdgeR: 1, confidence: 88, setup: selected, setupLabel: "量价力度假突破", setupScore: 88,
    setupEvaluations: evaluations(selected), decision: "SHORT", entryZone: [99, 100], invalidationPrice: 101,
    targets: [97, 95], evidence: [], counterEvidence: [], checks: [{ key: "setup", label: "核心打法触发", passed: true, detail: "" }],
    candles5m: [], assetRegime: "transition", maxHoldingMinutes: 120,
  };
}

test("every scan counts all three setups and keeps trigger, qualification, selection and entry blocking separate", () => {
  const now = Date.UTC(2026, 8, 4, 12, 0, 0);
  const first = recordDirectTwelveHourActivity({
    candidate: candidate(now), openedSetup: null, openReason: "组合已达到三笔持仓上限", expectedIntervalMs: INTERVAL_MS,
  });
  assert.equal(first.current.evaluations, 1);
  assert.equal(first.current.triggeredSignals, 2);
  assert.equal(first.current.qualifiedSignals, 2);
  assert.equal(first.current.selectedSignals, 1);
  assert.equal(first.current.blockedEntries, 1);
  assert.deepEqual(first.current.setups.map((row) => row.evaluations), [1, 1, 1]);
  const failed = first.current.setups.find((row) => row.setup === "VOLUME_FORCE_FAILED_BREAKOUT")!;
  assert.equal(failed.triggeredSignals, 1);
  assert.equal(failed.qualifiedSignals, 1);
  assert.equal(failed.selectedSignals, 1);
  assert.equal(failed.blockedEntries, 1);
  assert.equal(failed.leadingBlocker, "组合已达到三笔持仓上限");

  const second = recordDirectTwelveHourActivity({
    activity: first, candidate: candidate(now + INTERVAL_MS), openedSetup: "VOLUME_FORCE_FAILED_BREAKOUT", openReason: "已开仓", expectedIntervalMs: INTERVAL_MS,
  });
  assert.deepEqual(second.current.setups.map((row) => row.evaluations), [2, 2, 2]);
  assert.equal(second.current.openedTrades, 1);
  assert.equal(second.current.coverageMs, INTERVAL_MS);
});

test("legacy or partial activity never masquerades as a complete twelve-hour window", () => {
  const now = Date.UTC(2026, 8, 4, 11, 59, 30);
  const legacy = {
    current: { windowStartAt: now - 11 * 60 * 60_000, windowEndAt: now + 30_000, generatedAt: now, complete: false, evaluations: 133, qualifiedSignals: 3, openedTrades: 0, setups: [] },
    lastCompleted: null,
  } as unknown as Parameters<typeof recordDirectTwelveHourActivity>[0]["activity"];
  const reset = recordDirectTwelveHourActivity({
    activity: legacy, candidate: candidate(now), openedSetup: null, openReason: "等待", expectedIntervalMs: INTERVAL_MS,
  });
  assert.equal(reset.lastCompleted, null);
  assert.equal(reset.current.evaluations, 1);
  assert.equal(reset.current.coverageMs, 0);

  const partial = emptyDirectTwelveHourActivity(Date.UTC(2026, 8, 4, 0, 0, 1));
  partial.coverageMs = 60 * 60_000;
  partial.lastObservedAt = partial.windowEndAt - INTERVAL_MS;
  const rolled = recordDirectTwelveHourActivity({
    activity: { current: partial, lastCompleted: null },
    candidate: candidate(partial.windowEndAt + 1), openedSetup: null, openReason: "等待", expectedIntervalMs: INTERVAL_MS,
  });
  assert.equal(rolled.lastCompleted, null);
  assert.equal(rolled.current.complete, false);
  assert.equal(rolled.current.coverageMs, 0);
});

test("only a continuously covered twelve-hour window becomes the latest completed review", () => {
  const current = emptyDirectTwelveHourActivity(Date.UTC(2026, 8, 4, 0, 0, 1));
  current.coverageMs = DIRECT_ACTIVITY_WINDOW_MS - INTERVAL_MS * 2;
  current.lastObservedAt = current.windowEndAt - INTERVAL_MS;
  const rolled = recordDirectTwelveHourActivity({
    activity: { current, lastCompleted: null },
    candidate: candidate(current.windowEndAt + 1), openedSetup: null, openReason: "等待", expectedIntervalMs: INTERVAL_MS,
  });
  assert.equal(rolled.lastCompleted?.complete, true);
  assert.equal(rolled.lastCompleted?.coverageMs, DIRECT_ACTIVITY_WINDOW_MS - INTERVAL_MS * 2);
  assert.equal(rolled.current.complete, false);
});

test("a qualified losing setup retains the actual same-symbol comparison without inventing an entry rejection", () => {
  const now = Date.UTC(2026, 8, 5, 5, 0, 0);
  const scan = candidate(now, "MULTI_TIMEFRAME_RESONANCE");
  scan.setupLabel = "多周期综合共振";
  scan.setupScore = 92;
  scan.setupEvaluations![2].score = 92;
  const first = recordDirectTwelveHourActivity({ candidate: scan, openedSetup: null, openReason: "等待组合比较", expectedIntervalMs: INTERVAL_MS });
  const failed = first.current.setups[0];
  assert.equal(failed.qualifiedSignals, 1);
  assert.equal(failed.selectedSignals, 0);
  assert.equal(failed.blockedEntries, 0);
  assert.equal(failed.leadingBlocker, "同币择优采用多周期综合共振");
  assert.deepEqual(failed.latestQualifiedSelection, {
    observedAt: now, symbol: "BTC_USDT", selected: false, score: 88,
    preferredSetupLabel: "多周期综合共振", preferredScore: 92,
  });
  const waiting = candidate(now + INTERVAL_MS);
  waiting.setupEvaluations = waiting.setupEvaluations!.map((row) => ({ ...row, qualified: false, triggered: false }));
  const later = recordDirectTwelveHourActivity({ activity: first, candidate: waiting, openedSetup: null, openReason: "等待", expectedIntervalMs: INTERVAL_MS });
  assert.deepEqual(later.current.setups[0].latestQualifiedSelection, failed.latestQualifiedSelection);
  assert.equal(later.current.setups[0].evaluations, 2);
});

test("priority observation can precede qualification and must not be presented as execution admission", () => {
  const scan = candidate(Date.UTC(2026, 8, 5, 5, 0, 0), "EXHAUSTION_REVERSAL");
  scan.decision = "WAIT";
  scan.setupEvaluations = scan.setupEvaluations!.map((row) => ({ ...row, qualified: false, triggered: row.selected }));
  const activity = recordDirectTwelveHourActivity({ candidate: scan, openedSetup: null, openReason: "等待反转确认", expectedIntervalMs: INTERVAL_MS });
  assert.equal(activity.current.selectedSignals, 1);
  assert.equal(activity.current.qualifiedSignals, 0);
  assert.equal(activity.current.blockedEntries, 0);
  assert.equal(activity.current.setups[1].latestQualifiedSelection, undefined);
});
