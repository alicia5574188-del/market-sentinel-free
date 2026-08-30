import { HTE31_PAPER_POSITION_POLICY } from "./hte31-position-sizing.ts";

export const HTE31_LIVE_POLICY = {
  targetRiskRate: HTE31_PAPER_POSITION_POLICY.targetRiskRate,
  maximumRiskRate: HTE31_PAPER_POSITION_POLICY.maximumRiskRate,
  minimumTp2NetProfitRate: HTE31_PAPER_POSITION_POLICY.minimumTp2NetProfitRate,
  maximumMarginAllocationRate: HTE31_PAPER_POSITION_POLICY.maximumMarginAllocationRate,
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
