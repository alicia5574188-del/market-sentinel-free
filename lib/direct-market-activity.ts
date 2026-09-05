import {
  DIRECT_CORE_SETUPS,
  type DirectCoreSetup,
  type DirectMarketCandidate,
  type DirectSetupEvaluationSnapshot,
  type DirectTwelveHourActivity,
} from "./direct-market-types.ts";

export const DIRECT_ACTIVITY_WINDOW_MS = 12 * 60 * 60_000;

export type DirectTwelveHourActivityState = {
  current: DirectTwelveHourActivity;
  lastCompleted: DirectTwelveHourActivity | null;
};

export function emptyDirectTwelveHourActivity(now: number): DirectTwelveHourActivity {
  const windowStartAt = Math.floor(now / DIRECT_ACTIVITY_WINDOW_MS) * DIRECT_ACTIVITY_WINDOW_MS;
  return {
    windowStartAt,
    windowEndAt: windowStartAt + DIRECT_ACTIVITY_WINDOW_MS,
    generatedAt: now,
    lastObservedAt: null,
    coverageMs: 0,
    complete: false,
    evaluations: 0,
    triggeredSignals: 0,
    qualifiedSignals: 0,
    selectedSignals: 0,
    blockedEntries: 0,
    openedTrades: 0,
    setups: DIRECT_CORE_SETUPS.map(({ id: setup, label: setupLabel }) => ({
      setup,
      setupLabel,
      evaluations: 0,
      triggeredSignals: 0,
      qualifiedSignals: 0,
      selectedSignals: 0,
      blockedEntries: 0,
      openedTrades: 0,
      leadingBlocker: null,
      blockerCount: 0,
      blockers: {},
    })),
  };
}

function hasTruthfulSchema(activity: DirectTwelveHourActivityState | undefined) {
  const current = activity?.current;
  return Boolean(current
    && Number.isFinite(current.coverageMs)
    && "triggeredSignals" in current
    && current.setups.every((row) => "triggeredSignals" in row && "selectedSignals" in row && "blockedEntries" in row));
}

function fallbackEvaluation(candidate: DirectMarketCandidate, setup: DirectCoreSetup): DirectSetupEvaluationSnapshot {
  const selected = candidate.setup === setup;
  const triggered = selected && Boolean(candidate.checks.find((check) => check.key === "setup")?.passed);
  return {
    setup,
    setupLabel: DIRECT_CORE_SETUPS.find((row) => row.id === setup)?.label ?? setup,
    side: candidate.decision === "SHORT" ? "SHORT" : "LONG",
    score: selected ? candidate.setupScore : 0,
    triggered,
    qualified: selected && candidate.decision !== "WAIT",
    selected,
    blockers: selected ? candidate.counterEvidence : ["等待新统计口径的完整评估"],
  };
}

export function recordDirectTwelveHourActivity(input: {
  activity?: DirectTwelveHourActivityState;
  candidate: DirectMarketCandidate;
  openedSetup: DirectCoreSetup | null;
  openReason: string;
  expectedIntervalMs: number;
}): DirectTwelveHourActivityState {
  const { candidate, openedSetup, openReason, expectedIntervalMs } = input;
  const now = candidate.observedAt;
  let current = hasTruthfulSchema(input.activity) ? input.activity!.current : emptyDirectTwelveHourActivity(now);
  let lastCompleted = hasTruthfulSchema(input.activity) && input.activity!.lastCompleted?.complete
    ? input.activity!.lastCompleted
    : null;

  if (now >= current.windowEndAt || now < current.windowStartAt) {
    const minimumCoverage = DIRECT_ACTIVITY_WINDOW_MS - expectedIntervalMs * 3;
    if (current.coverageMs >= minimumCoverage) lastCompleted = { ...current, complete: true };
    current = emptyDirectTwelveHourActivity(now);
  }

  const evaluations = DIRECT_CORE_SETUPS.map(({ id }) => candidate.setupEvaluations?.find((row) => row.setup === id)
    ?? fallbackEvaluation(candidate, id));
  const coverageDelta = current.lastObservedAt == null
    ? 0
    : Math.min(Math.max(0, now - current.lastObservedAt), expectedIntervalMs * 2);
  const setups = current.setups.map((row) => {
    const evaluation = evaluations.find((item) => item.setup === row.setup)!;
    const selectedAndBlocked = evaluation.selected && evaluation.qualified && openedSetup !== row.setup;
    const blocker = evaluation.triggered && evaluation.qualified
      ? !evaluation.selected ? `同币择优采用${candidate.setupLabel}` : selectedAndBlocked ? openReason : ""
      : evaluation.blockers[0] ?? "当前位置没有完整触发";
    const blockers = blocker ? { ...row.blockers, [blocker]: (row.blockers[blocker] ?? 0) + 1 } : row.blockers;
    const [leadingBlocker, blockerCount] = Object.entries(blockers).sort((left, right) => right[1] - left[1])[0] ?? [null, 0];
    return {
      ...row,
      evaluations: row.evaluations + 1,
      triggeredSignals: row.triggeredSignals + Number(evaluation.triggered),
      qualifiedSignals: row.qualifiedSignals + Number(evaluation.qualified),
      selectedSignals: row.selectedSignals + Number(evaluation.selected && evaluation.triggered),
      blockedEntries: row.blockedEntries + Number(selectedAndBlocked),
      openedTrades: row.openedTrades + Number(openedSetup === row.setup),
      leadingBlocker,
      blockerCount,
      blockers,
      latestQualifiedSelection: evaluation.qualified ? {
        observedAt: now,
        symbol: candidate.symbol,
        selected: evaluation.selected,
        score: evaluation.score,
        preferredSetupLabel: candidate.setupLabel,
        preferredScore: candidate.setupScore,
      } : row.latestQualifiedSelection,
    };
  });

  return {
    current: {
      ...current,
      generatedAt: now,
      lastObservedAt: now,
      coverageMs: Math.min(DIRECT_ACTIVITY_WINDOW_MS, current.coverageMs + coverageDelta),
      evaluations: current.evaluations + 1,
      triggeredSignals: current.triggeredSignals + evaluations.filter((row) => row.triggered).length,
      qualifiedSignals: current.qualifiedSignals + evaluations.filter((row) => row.qualified).length,
      selectedSignals: current.selectedSignals + Number(evaluations.some((row) => row.selected && row.triggered)),
      blockedEntries: current.blockedEntries + Number(evaluations.some((row) => row.selected && row.qualified && openedSetup !== row.setup)),
      openedTrades: current.openedTrades + Number(openedSetup != null),
      setups,
    },
    lastCompleted,
  };
}
