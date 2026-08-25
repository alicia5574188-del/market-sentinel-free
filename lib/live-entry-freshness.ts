export const LIVE_ENTRY_MAX_AGE_MS = 2 * 60 * 1_000;

export function liveEntryCandidateCutoff(enabledAt: number, now = Date.now()) {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const safeEnabledAt = Number.isFinite(enabledAt) ? Math.max(0, enabledAt) : safeNow;
  return Math.max(safeEnabledAt, safeNow - LIVE_ENTRY_MAX_AGE_MS);
}
