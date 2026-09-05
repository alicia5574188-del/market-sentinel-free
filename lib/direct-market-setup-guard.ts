export type DirectSetupGuardSample = {
  independentEventKey: string;
  resultR: number;
  exitAt: number;
};

export type DirectSetupGuardDecision = {
  state: "ACTIVE" | "PAUSED";
  revalidation: boolean;
  sampleCount: number;
  expectancyR: number;
  profitFactor: number | null;
  losingStreak: number;
  resumeAt: number | null;
  reason: string;
};

const SIX_HOURS = 6 * 60 * 60_000;
const TWELVE_HOURS = 12 * 60 * 60_000;

/** Isolates damage to one setup + direction + market regime. */
export function evaluateDirectSetupGuard(samples: DirectSetupGuardSample[], now = Date.now()): DirectSetupGuardDecision {
  const seen = new Set<string>();
  const events = [...samples].sort((a, b) => b.exitAt - a.exitAt).filter((sample) => {
    if (seen.has(sample.independentEventKey)) return false;
    seen.add(sample.independentEventKey);
    return true;
  });
  const profit = events.reduce((sum, row) => sum + Math.max(0, row.resultR), 0);
  const loss = Math.abs(events.reduce((sum, row) => sum + Math.min(0, row.resultR), 0));
  const expectancyR = events.length ? events.reduce((sum, row) => sum + row.resultR, 0) / events.length : 0;
  const profitFactor = loss > 0 ? profit / loss : profit > 0 ? 99 : null;
  let losingStreak = 0;
  for (const row of events) {
    if (row.resultR >= 0) break;
    losingStreak += 1;
  }
  const rapidFailure = events.length >= 3 && losingStreak >= 3;
  const negativeCell = events.length >= 4 && expectancyR <= -0.15 && (profitFactor ?? 0) < 0.8;
  const persistentFailure = events.length >= 12 && expectancyR < 0 && (profitFactor ?? 0) < 0.72;
  const failed = rapidFailure || negativeCell || persistentFailure;
  const delay = rapidFailure || persistentFailure ? TWELVE_HOURS : SIX_HOURS;
  const resumeAt = failed && events[0] ? events[0].exitAt + delay : null;
  const revalidation = Boolean(failed && resumeAt != null && now >= resumeAt);
  const metrics = `${events.length}笔独立样本 · Exp ${expectancyR.toFixed(2)}R · PF ${profitFactor == null ? "--" : profitFactor >= 99 ? "∞" : profitFactor.toFixed(2)} · 连亏 ${losingStreak}`;
  if (!failed) return { state: "ACTIVE", revalidation: false, sampleCount: events.length, expectancyR, profitFactor, losingStreak, resumeAt: null, reason: metrics };
  if (revalidation) return { state: "ACTIVE", revalidation: true, sampleCount: events.length, expectancyR, profitFactor, losingStreak, resumeAt, reason: `${metrics}；仅允许一笔高质量复考` };
  return { state: "PAUSED", revalidation: false, sampleCount: events.length, expectancyR, profitFactor, losingStreak, resumeAt, reason: `${metrics}；该打法/方向/行情组合已独立暂停` };
}
