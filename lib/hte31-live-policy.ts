// Gate consumes the exact strategy lineage, learned entry checks and leverage
// chosen by the unified paper brain. Exchange balance, contract sizing, fees
// and slippage remain real-account facts, while portfolio capacity mirrors the
// five-slot / 20%-planned-risk simulation envelope.
export const HTE31_LIVE_POLICY = {
  targetRiskRate: 0.04,
  maximumRiskRate: 0.05,
  minimumTp2NetProfitRate: 0.05,
  maximumMarginAllocationRate: 0.35,
  maxOpenPositions: 5,
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
