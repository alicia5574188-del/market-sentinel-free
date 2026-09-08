import assert from "node:assert/strict";
import test from "node:test";
import { ingestReactionOutcomes, initialOutcomeResearch, OUTCOME_DISCOVERY_SAMPLES } from "../lib/outcome-research.ts";
import { initialReactionLab, recordReactionEvent, type ReactionExperiment, type ReactionLabState } from "../lib/reaction-lab.ts";

const candidate = (index: number) => ({ id: `X_USDT:${index}`, symbol: "X_USDT", side: "LONG" as const,
  strength: 72, moveRate: .003, movementMultiple: 4, volume24hUsd: 50_000_000, confirmations: 3,
  firstSeenAt: index * 1_000, observedAt: index * 1_000 + 100, kind: "NEW_MONEY" as const,
  openInterestChangeRate: .0005, referencePrice: 100 });

function completed(index: number, win: boolean): ReactionExperiment {
  const lab = recordReactionEvent({ state: initialReactionLab(index), candidate: candidate(index), midpoint: 100.3,
    stopRate: .004, targetRate: .009, startSpreadBps: 1.5, startDepthAlignment: .2, now: index * 1_000 + 100 });
  const experiment = Object.values(lab.active)[0];
  const triggerAt = experiment.startedAt + 20_000;
  return { ...experiment, continuation: { ...experiment.continuation, status: "RESOLVED", conditionStreak: 2,
    triggerRetraceRatio: .35, triggerAlignedFlow: .4, triggerStepRate: .0002, triggerAt, entryPrice: 100.2,
    stopPrice: 99.8, targetPrice: 101.1, expiresAt: triggerAt + 20 * 60_000, lastPrice: win ? 101.1 : 99.8,
    bestGrossReturnRate: win ? .009 : .001, worstGrossReturnRate: win ? -.001 : -.004,
    outcome: win ? "TARGET_FIRST" : "STOP_FIRST", resolvedAt: triggerAt + 60_000,
    exitPrice: win ? 101.1 : 99.8, grossReturnRate: win ? .009 : -.004,
    netReturnRate: win ? .0072 : -.0058, feeCovered: win, profitableAfterCost: win } };
}

const labWith = (experiment: ReactionExperiment): ReactionLabState => ({ ...initialReactionLab(0),
  recent: [experiment], completed: 1 });

test("research ingests each fully captured resolved route once", () => {
  const experiment = completed(1, true);
  let state = ingestReactionOutcomes(initialOutcomeResearch(0), labWith(experiment));
  assert.equal(state.aggregate.samples, 1);
  assert.equal(state.aggregate.wins, 1);
  assert.equal(state.groups["BRANCH:CONTINUATION"].samples, 1);
  assert.equal(state.winnerProfileSums.triggerRetraceRatio, .35);
  state = ingestReactionOutcomes(state, labWith(experiment));
  assert.equal(state.aggregate.samples, 1);
});

test("winner and loser profiles remain separate", () => {
  let state = initialOutcomeResearch(0);
  state = ingestReactionOutcomes(state, labWith(completed(1, true)));
  state = ingestReactionOutcomes(state, labWith(completed(2, false)));
  assert.equal(state.aggregate.samples, 2);
  assert.equal(state.aggregate.wins, 1);
  assert.equal(state.aggregate.losses, 1);
  assert.equal(state.winnerProfileSums.bestGrossReturnRate, .009);
  assert.equal(state.loserProfileSums.worstGrossReturnRate, -.004);
});

test("the first 100 samples are discovery and later samples are confirmation", () => {
  let state = initialOutcomeResearch(0);
  for (let index = 1; index <= OUTCOME_DISCOVERY_SAMPLES + 1; index += 1) {
    state = ingestReactionOutcomes(state, labWith(completed(index, index % 2 === 0)));
  }
  assert.equal(state.discovery.samples, OUTCOME_DISCOVERY_SAMPLES);
  assert.equal(state.confirmation.samples, 1);
  assert.equal(state.aggregate.samples, OUTCOME_DISCOVERY_SAMPLES + 1);
  assert.ok(state.candidatesFrozenAt != null);
  assert.ok(state.candidateGroupIds.includes("BRANCH:CONTINUATION"));
  assert.equal(state.groups["BRANCH:CONTINUATION"].discovery.samples, OUTCOME_DISCOVERY_SAMPLES);
  assert.equal(state.groups["BRANCH:CONTINUATION"].confirmation.samples, 1);
});

test("legacy routes without frozen feature context are skipped", () => {
  const current = completed(1, true);
  const legacy = { ...current, featureVersion: undefined } as unknown as ReactionExperiment;
  const state = ingestReactionOutcomes(initialOutcomeResearch(0), labWith(legacy));
  assert.equal(state.aggregate.samples, 0);
  assert.equal(state.skippedLegacy, 1);
});
