import { RISK_POLICY } from "./risk-policy.ts";

export type LivePortfolioSide = "LONG" | "SHORT";

export function liveDirectionalExposureBlockReason(
  activeSides: readonly LivePortfolioSide[],
  candidateSide: LivePortfolioSide,
) {
  const sameSideCount = activeSides.filter((side) => side === candidateSide).length;
  if (sameSideCount >= RISK_POLICY.maxSameSideLivePositions) {
    return `同方向实盘仓位已达 ${RISK_POLICY.maxSameSideLivePositions} 个，等待现有仓位结束后再允许新的 ${candidateSide} 开仓`;
  }
  return null;
}
