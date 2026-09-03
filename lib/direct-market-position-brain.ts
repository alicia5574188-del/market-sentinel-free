import type { Hte31Candle } from "./hte31-types.ts";

export const DIRECT_POSITION_POLICY_VERSION = "adaptive-position-v2";

export type DirectPositionDecision = {
  policyVersion: typeof DIRECT_POSITION_POLICY_VERSION;
  action: "HOLD" | "PROTECT" | "EXIT";
  reason: string;
  observedAt: number;
  completedBars: number;
  progressR: number;
  fastStructureR: number;
  slowStructureR: number;
  proposedStopPrice: number | null;
  exitCode: "brain_invalidation" | "brain_time_decay" | null;
  reversalWatch: boolean;
};

type DirectPositionInput = {
  side: "LONG" | "SHORT";
  entryPrice: number;
  initialStopPrice: number;
  currentStopPrice: number;
  takeProfit1Price: number;
  target1HitAt: number | null;
  entryAt: number;
  maxHoldingMinutes: number;
  currentPrice: number;
  observedAt: number;
  roundTripCostBps: number;
  candles5m: Hte31Candle[];
};

function direction(side: DirectPositionInput["side"]) {
  return side === "LONG" ? 1 : -1;
}

function candleTime(candle: Hte31Candle) {
  return candle.time > 10_000_000_000 ? candle.time : candle.time * 1000;
}

function hold(input: DirectPositionInput, completedBars: number, progressR: number, fastStructureR: number, slowStructureR: number, reason: string): DirectPositionDecision {
  return {
    policyVersion: DIRECT_POSITION_POLICY_VERSION,
    action: "HOLD",
    reason,
    observedAt: input.observedAt,
    completedBars,
    progressR,
    fastStructureR,
    slowStructureR,
    proposedStopPrice: null,
    exitCode: null,
    reversalWatch: false,
  };
}

/**
 * Reassesses only completed five-minute evidence. It cannot loosen the stop or
 * reverse a trade. A reversal remains a new scanner decision after the old
 * position has closed and the cooldown has elapsed.
 */
export function evaluateDirectPosition(input: DirectPositionInput): DirectPositionDecision {
  const sideDirection = direction(input.side);
  const riskDistance = Math.abs(input.entryPrice - input.initialStopPrice);
  const completedBoundary = Math.floor(input.observedAt / 300_000) * 300_000;
  const rows = [...input.candles5m]
    .filter((candle) => candleTime(candle) >= input.entryAt && candleTime(candle) < completedBoundary)
    .sort((a, b) => candleTime(a) - candleTime(b))
    .filter((candle, index, all) => index === all.findIndex((row) => candleTime(row) === candleTime(candle)))
    .slice(-24);
  const progressR = riskDistance > 0 ? sideDirection * (input.currentPrice - input.entryPrice) / riskDistance : 0;
  if (!(riskDistance > 0) || rows.length < 6) return hold(input, rows.length, progressR, 0, 0, "完整5分钟结构不足，保持原交易计划");

  const latest = rows.at(-1)!;
  const fastAnchor = rows.at(-4)!;
  const slowAnchor = rows.at(-10) ?? rows[0];
  const fastStructureR = sideDirection * (latest.close - fastAnchor.close) / riskDistance;
  const slowStructureR = sideDirection * (latest.close - slowAnchor.close) / riskDistance;
  const lastThree = rows.slice(-3);
  const consecutiveOpposition = lastThree.length === 3 && lastThree.slice(1).every((row, index) => sideDirection * (row.close - lastThree[index].close) < 0);
  const structureInvalidated = progressR <= -0.25 && fastStructureR <= -0.35 && slowStructureR <= -0.45 && consecutiveOpposition;
  if (structureInvalidated) {
    return {
      policyVersion: DIRECT_POSITION_POLICY_VERSION,
      action: "EXIT",
      reason: `连续完成K线确认原方向结构失效：进度 ${progressR.toFixed(2)}R，短/中结构 ${fastStructureR.toFixed(2)}R/${slowStructureR.toFixed(2)}R`,
      observedAt: input.observedAt,
      completedBars: rows.length,
      progressR,
      fastStructureR,
      slowStructureR,
      proposedStopPrice: null,
      exitCode: "brain_invalidation",
      reversalWatch: true,
    };
  }

  const elapsedRatio = (input.observedAt - input.entryAt) / Math.max(1, input.maxHoldingMinutes * 60_000);
  if (elapsedRatio >= 0.65 && progressR < 0.15 && fastStructureR < 0 && slowStructureR < 0) {
    return {
      policyVersion: DIRECT_POSITION_POLICY_VERSION,
      action: "EXIT",
      reason: `持仓已使用 ${Math.round(elapsedRatio * 100)}% 时间预算但没有形成有效推进，结构继续转弱`,
      observedAt: input.observedAt,
      completedBars: rows.length,
      progressR,
      fastStructureR,
      slowStructureR,
      proposedStopPrice: null,
      exitCode: "brain_time_decay",
      reversalWatch: false,
    };
  }

  const tp1Reached = input.target1HitAt != null || sideDirection * (input.currentPrice - input.takeProfit1Price) >= 0;
  if (tp1Reached) {
    const feeRate = Math.max(0, input.roundTripCostBps) / 10_000;
    const feeAwareBreakEven = input.side === "LONG" ? input.entryPrice * (1 + feeRate) : input.entryPrice * (1 - feeRate);
    const recent = rows.slice(-4);
    const structuralStop = input.side === "LONG"
      ? Math.min(...recent.map((row) => row.low)) - riskDistance * 0.08
      : Math.max(...recent.map((row) => row.high)) + riskDistance * 0.08;
    const proposed = input.side === "LONG"
      ? Math.max(input.currentStopPrice, feeAwareBreakEven, structuralStop)
      : Math.min(input.currentStopPrice, feeAwareBreakEven, structuralStop);
    const remainsBehindPrice = input.side === "LONG" ? proposed < input.currentPrice : proposed > input.currentPrice;
    const improvesBy = sideDirection * (proposed - input.currentStopPrice) / riskDistance;
    if (remainsBehindPrice && improvesBy >= 0.03) {
      return {
        policyVersion: DIRECT_POSITION_POLICY_VERSION,
        action: "PROTECT",
        reason: `TP1后按费用与最近完成结构提高保护，锁定价 ${proposed}`,
        observedAt: input.observedAt,
        completedBars: rows.length,
        progressR,
        fastStructureR,
        slowStructureR,
        proposedStopPrice: proposed,
        exitCode: null,
        reversalWatch: false,
      };
    }
  }

  return hold(
    input,
    rows.length,
    progressR,
    fastStructureR,
    slowStructureR,
    `原方向仍有效：进度 ${progressR.toFixed(2)}R，短/中结构 ${fastStructureR.toFixed(2)}R/${slowStructureR.toFixed(2)}R`,
  );
}

export function hasAdaptivePositionPolicy(snapshotJson: string | null | undefined) {
  if (!snapshotJson) return false;
  try {
    const snapshot = JSON.parse(snapshotJson) as { positionPolicyVersion?: string };
    return snapshot.positionPolicyVersion === DIRECT_POSITION_POLICY_VERSION;
  } catch {
    return false;
  }
}
