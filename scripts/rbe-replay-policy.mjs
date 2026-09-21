// Research execution only. Never imported by the production Worker.
export function rbeExitIntent(decision, signalAt) {
  return decision?.shouldExit === true && decision.phase === "PRE_TURN_EXIT"
    ? { reason: "RBE", signalAt } : null;
}

export function nextOpenExit(intent, row) {
  if (!intent || row.time !== intent.signalAt) return null;
  return { price: row.open, time: row.time, reason: intent.reason };
}

export function originalStopFill(side, stop, row) {
  if (side === "LONG") return row.low <= stop ? Math.min(stop, row.open) : null;
  return row.high >= stop ? Math.max(stop, row.open) : null;
}

export function commonTopCohort(pairs) {
  return [...pairs].sort((a, b) => b.baseline.mfe - a.baseline.mfe)
    .slice(0, Math.max(1, Math.floor(pairs.length * .1)));
}

export function predictiveExits(pairs) {
  return pairs.filter(pair => pair.candidate.reason === "RBE");
}

