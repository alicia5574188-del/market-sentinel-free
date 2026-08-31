export const RESONANCE_POLICY_VERSION = "resonance-v1";

// Cloudflare production build for the first Resonance release completed at
// 2026-08-31T13:24:17Z. Trades entered before this instant belong to the
// pre-Resonance policy and remain historical evidence only; they must not
// directly cool down, pause, or performance-gate the new policy.
export const RESONANCE_POLICY_STARTED_AT = Date.parse("2026-08-31T13:24:17.000Z");

export function isCurrentResonanceTrade(entryAt: number) {
  return Number.isFinite(entryAt) && entryAt >= RESONANCE_POLICY_STARTED_AT;
}

export function resonanceLearningId(
  traderId: string,
  assetRegime: string,
  side: "LONG" | "SHORT",
  entryAt: number,
) {
  const base = `${traderId}|${assetRegime}|${side}`;
  return isCurrentResonanceTrade(entryAt) ? `${RESONANCE_POLICY_VERSION}|${base}` : base;
}

export function isCurrentResonanceLearningId(id: string) {
  return id.startsWith(`${RESONANCE_POLICY_VERSION}|`);
}
