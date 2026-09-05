import assert from "node:assert/strict";
import test from "node:test";
import { DIRECT_ACTIVITY_WINDOW_MS, emptyDirectTwelveHourActivity, recordDirectTwelveHourActivity } from "../lib/direct-market-activity.ts";
import type { DirectMarketCandidate } from "../lib/direct-market-types.ts";
const INTERVAL_MS = 60_000;
function candidate(observedAt: number): DirectMarketCandidate {
  return { symbol: "BTC_USDT", batchId: "batch", observedAt, freshness: "FRESH", scanStage: "DEEP",
    volumeRank: 1, volumeUsd: 1e9, riskClusterId: "btc-positive", btcCorrelation: 1,
    location: "TOP", paths: { up: 20, down: 65, rangeOrInvalid: 15 }, directionalScore: -0.45,
    netEdgeR: 0.2, confidence: 65, setup: "ANALOG_PATH", setupLabel: "历史路径方向交易", setupScore: 65,
    setupEvaluations: [{ setup: "ANALOG_PATH", setupLabel: "历史路径方向交易", side: "SHORT", score: 65, triggered: true, qualified: true, selected: true, blockers: [] }],
    decision: "SHORT", entryZone: [99,100], invalidationPrice: 101, targets: [98,97], evidence: [], counterEvidence: [],
    checks: [{ key: "setup", label: "历史路径方向交易", passed: true, detail: "" }], candles5m: [], assetRegime: "transition", maxHoldingMinutes: 60 };
}
test("one active prediction has separate signal, qualification, rejection and actual-open counts", () => {
  const now = Date.UTC(2026,8,5,12);
  const first = recordDirectTwelveHourActivity({ candidate: candidate(now), openedSetup: null, openReason: "组合总风险已用满", expectedIntervalMs: INTERVAL_MS });
  assert.equal(first.current.evaluations, 1); assert.equal(first.current.triggeredSignals, 1);
  assert.equal(first.current.qualifiedSignals, 1); assert.equal(first.current.blockedEntries, 1);
  assert.equal(first.current.openedTrades, 0); assert.equal(first.current.setups.length, 1);
  assert.equal(first.current.setups[0].leadingBlocker, "组合总风险已用满");
  const second = recordDirectTwelveHourActivity({ activity: first, candidate: candidate(now + INTERVAL_MS), openedSetup: "ANALOG_PATH", openReason: "已开仓", expectedIntervalMs: INTERVAL_MS });
  assert.equal(second.current.openedTrades, 1); assert.equal(second.current.setups[0].evaluations, 2);
  assert.equal(second.current.coverageMs, INTERVAL_MS);
});
test("old strategy activity cannot crash or contaminate the new forecast epoch", () => {
  const now = Date.UTC(2026,8,5,12), old = emptyDirectTwelveHourActivity(now);
  old.setups[0].setup = "EXHAUSTION_REVERSAL"; old.evaluations = 400; old.coverageMs = 10 * 3_600_000;
  const next = recordDirectTwelveHourActivity({ activity: { current: old, lastCompleted: { ...old, complete: true } }, candidate: candidate(now), openedSetup: null, openReason: "等待", expectedIntervalMs: INTERVAL_MS });
  assert.equal(next.current.evaluations, 1); assert.equal(next.current.setups[0].setup, "ANALOG_PATH");
  assert.equal(next.lastCompleted, null); assert.equal(next.current.coverageMs, 0);
});
test("partial or interrupted coverage does not become a complete twelve-hour review", () => {
  const partial = emptyDirectTwelveHourActivity(Date.UTC(2026,8,5,0));
  partial.coverageMs = 3_600_000; partial.lastObservedAt = partial.windowEndAt - INTERVAL_MS;
  const rolled = recordDirectTwelveHourActivity({ activity: { current: partial, lastCompleted: null }, candidate: candidate(partial.windowEndAt + 1), openedSetup: null, openReason: "等待", expectedIntervalMs: INTERVAL_MS });
  assert.equal(rolled.lastCompleted, null); assert.equal(rolled.current.coverageMs, 0);
  partial.coverageMs = DIRECT_ACTIVITY_WINDOW_MS - INTERVAL_MS * 2;
  const complete = recordDirectTwelveHourActivity({ activity: { current: partial, lastCompleted: null }, candidate: candidate(partial.windowEndAt + 1), openedSetup: null, openReason: "等待", expectedIntervalMs: INTERVAL_MS });
  assert.equal(complete.lastCompleted?.complete, true);
});
test("a pullback with missing confirmation cannot count as a qualified entry or an entry rejection", () => {
  const c = candidate(Date.UTC(2026,8,5,12)); c.decision = "WAIT";
  c.setupEvaluations![0] = { ...c.setupEvaluations![0], triggered: false, qualified: false, blockers: ["回踩确认尚未完成"] };
  const activity = recordDirectTwelveHourActivity({ candidate: c, openedSetup: null, openReason: "等待", expectedIntervalMs: INTERVAL_MS });
  assert.equal(activity.current.qualifiedSignals, 0); assert.equal(activity.current.blockedEntries, 0);
  assert.equal(activity.current.setups[0].leadingBlocker, "回踩确认尚未完成");
});
