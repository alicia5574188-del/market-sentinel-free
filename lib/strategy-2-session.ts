export type Strategy2BeijingSession = "overnight" | "morning" | "afternoon" | "evening";

export const STRATEGY2_BEIJING_SESSION_ORDER: Strategy2BeijingSession[] = [
  "overnight",
  "morning",
  "afternoon",
  "evening",
];

export const STRATEGY2_BEIJING_SESSION_LABELS: Record<Strategy2BeijingSession, string> = {
  overnight: "凌晨 00:00–06:00",
  morning: "上午 06:00–12:00",
  afternoon: "中午/下午 12:00–18:00",
  evening: "晚间 18:00–24:00",
};

/**
 * Strategy 2.0 learns time-of-day in fixed Beijing-time buckets. China has no
 * daylight-saving shift, so the buckets stay stable while US/Europe session
 * effects are learned empirically from the actual trade outcomes rather than
 * being hard-coded as a market-open rule.
 */
export function strategy2BeijingSession(at: number | null | undefined): Strategy2BeijingSession {
  const value = Number.isFinite(at) ? Number(at) : Date.now();
  const utcHour = new Date(value).getUTCHours();
  const beijingHour = (utcHour + 8) % 24;
  if (beijingHour < 6) return "overnight";
  if (beijingHour < 12) return "morning";
  if (beijingHour < 18) return "afternoon";
  return "evening";
}

export function strategy2BeijingSessionLabel(session: Strategy2BeijingSession) {
  return STRATEGY2_BEIJING_SESSION_LABELS[session];
}
