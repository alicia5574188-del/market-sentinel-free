// Live Gate execution deliberately keeps its own conservative equity-scaled
// economics. Resonance paper learning now uses a fixed 50U opportunity floor
// and market-led targets, but that must never silently change real-money risk
// or force a small live account to chase the same absolute dollar profit.
export const HTE31_LIVE_POLICY = {
  targetRiskRate: 0.04,
  maximumRiskRate: 0.05,
  minimumTp2NetProfitRate: 0.05,
  maximumMarginAllocationRate: 0.60,
  maxOpenPositions: 2,
} as const;

function positive(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function hte31LiveTargetRiskUsdt(equityUsdt: number) {
  return positive(equityUsdt) * HTE31_LIVE_POLICY.targetRiskRate;
}

export function hte31LiveMaximumRiskUsdt(equityUsdt: number) {
  return positive(equityUsdt) * HTE31_LIVE_POLICY.maximumRiskRate;
}

export function hte31LiveMinimumTp2NetUsdt(equityUsdt: number) {
  return positive(equityUsdt) * HTE31_LIVE_POLICY.minimumTp2NetProfitRate;
}

export function hte31LiveMaxMarginUsdt(equityUsdt: number) {
  return positive(equityUsdt) * HTE31_LIVE_POLICY.maximumMarginAllocationRate;
}
