import assert from "node:assert/strict";
import test from "node:test";
import { advanceReactionLab, initialReactionLab, observeReaction, recordReactionEvent,
  REACTION_OBSERVATION_MS } from "../lib/reaction-lab.ts";

const candidate = { id: "X_USDT:1000", symbol: "X_USDT", side: "LONG" as const, strength: 72,
  moveRate: 0.002, movementMultiple: 3, volume24hUsd: 50_000_000, confirmations: 2,
  firstSeenAt: 1_000, observedAt: 2_000, kind: "NEW_MONEY" as const,
  openInterestChangeRate: 0.001, referencePrice: 100 };

const started = () => recordReactionEvent({ state: initialReactionLab(0), candidate, midpoint: 100.2,
  stopRate: 0.0032, targetRate: 0.0085, now: 2_000 });

test("one anomaly creates paired non-executable continuation and reversal observations", () => {
  const state = started();
  const experiment = Object.values(state.active)[0];
  assert.equal(experiment.continuation.side, "LONG");
  assert.equal(experiment.reversal.side, "SHORT");
  assert.equal(experiment.continuation.status, "WATCHING");
  assert.equal(state.stats.CONTINUATION.opportunities, 1);
  assert.equal(recordReactionEvent({ state, candidate, midpoint: 100.3, stopRate: .0032, targetRate: .0085,
    now: 3_000 }), state);
});

test("continuation requires a pullback followed by two advancing aligned-flow observations", () => {
  let state = started();
  const id = Object.keys(state.active)[0];
  state = observeReaction({ state, experimentId: id, midpoint: 100.4, alignedFlow: 0, now: 4_000 });
  state = observeReaction({ state, experimentId: id, midpoint: 100.3, alignedFlow: 0, now: 6_000 });
  assert.equal(state.active[id].pullbackSeen, true);
  state = observeReaction({ state, experimentId: id, midpoint: 100.31, alignedFlow: .3, now: 8_000 });
  assert.equal(state.active[id].continuation.conditionStreak, 1);
  state = observeReaction({ state, experimentId: id, midpoint: 100.32, alignedFlow: .3, now: 10_000 });
  assert.equal(state.active[id].continuation.status, "OPEN");
  assert.equal(state.stats.CONTINUATION.triggered, 1);
  assert.equal(state.active[id].reversal.status, "WATCHING");
});

test("deep retrace plus two opposite-flow observations triggers only the reversal branch", () => {
  let state = started();
  const id = Object.keys(state.active)[0];
  state = observeReaction({ state, experimentId: id, midpoint: 100.5, alignedFlow: 0, now: 4_000 });
  state = observeReaction({ state, experimentId: id, midpoint: 100.1, alignedFlow: -.3, now: 6_000 });
  state = observeReaction({ state, experimentId: id, midpoint: 100.05, alignedFlow: -.3, now: 8_000 });
  assert.equal(state.active[id].reversal.status, "OPEN");
  assert.equal(state.stats.REVERSAL.triggered, 1);
  assert.equal(state.active[id].continuation.status, "WATCHING");
});

test("untriggered branches become explicit no-trade controls after three minutes", () => {
  let state = started();
  state = advanceReactionLab({ state, quotes: { X_USDT: 100.2 }, now: 2_000 + REACTION_OBSERVATION_MS,
    roundTripFrictionRate: .0018 });
  assert.equal(state.completed, 1);
  assert.equal(state.stats.CONTINUATION.noTrigger, 1);
  assert.equal(state.stats.REVERSAL.noTrigger, 1);
  assert.equal(state.recent[0].continuation.outcome, "NO_TRIGGER");
});

test("resolved route deducts full round-trip friction", () => {
  let state = started();
  const id = Object.keys(state.active)[0];
  state = observeReaction({ state, experimentId: id, midpoint: 100.4, alignedFlow: 0, now: 4_000 });
  state = observeReaction({ state, experimentId: id, midpoint: 100.3, alignedFlow: 0, now: 6_000 });
  state = observeReaction({ state, experimentId: id, midpoint: 100.31, alignedFlow: .3, now: 8_000 });
  state = observeReaction({ state, experimentId: id, midpoint: 100.32, alignedFlow: .3, now: 10_000 });
  const target = state.active[id].continuation.targetPrice!;
  state = advanceReactionLab({ state, quotes: { X_USDT: target * 1.0001 }, now: 20_000,
    roundTripFrictionRate: .0018 });
  assert.equal(state.active[id].continuation.outcome, "TARGET_FIRST");
  assert.ok((state.active[id].continuation.netReturnRate ?? 0) < (state.active[id].continuation.grossReturnRate ?? 0));
  assert.equal(state.stats.CONTINUATION.profitableAfterCost, 1);
});
