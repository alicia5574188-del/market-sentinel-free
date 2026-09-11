import type { MarketState, PaperPlan } from "./liquidity-core.ts";
import type { ArenaTrade } from "./strategy-arena.ts";

export const LIVE_MIRROR_ENTRY_WINDOW_MS = 10_000;

export function arenaScenario(trade: ArenaTrade): MarketState {
  if (trade.family === "RANGE") return "RANGE";
  if (trade.family === "REVERSAL" || trade.strategyId.includes("failed") || trade.strategyId.includes("fade")) return "REVERSAL";
  return "BREAKOUT";
}

export function arenaProtectionStop(trade: ArenaTrade) {
  return trade.activeStopPrice ?? trade.stopPrice;
}

export function arenaTradePlan(trade: ArenaTrade): PaperPlan {
  const score = Math.max(1, Math.min(99, trade.context.candidateScore));
  return {
    id: trade.id, symbol: trade.symbol, observedAt: trade.openedAt, marketState: arenaScenario(trade), side: trade.side,
    entryTrigger: trade.entryPrice, invalidation: trade.stopPrice, target: trade.targetPrice,
    targetIdentity: `arena:${trade.id}`, score, oppositeScore: 100 - score, reason: [trade.strategyName, trade.reason],
    routeId: `arena:${trade.strategyId}`, routeKind: "LOCAL_BREAKOUT", targetTimeframe: "15m",
    confirmationScore: trade.context.confirmation, fakeoutRisk: trade.context.fakeoutRisk,
    activationDistanceRate: 1, state: "TRIGGERED", createdAt: trade.openedAt,
    expiresAt: trade.openedAt + 45 * 60_000,
    plannedRisk: trade.plannedRisk, notional: trade.notional, leverage: trade.leverage, margin: trade.margin,
    breakoutSignalCount: 4, realtimeSignalCount: 3,
  };
}

export function eligibleForLiveMirror(trade: ArenaTrade, liveEnabledAt: number | null, now: number) {
  return liveEnabledAt != null && trade.openedAt >= liveEnabledAt && now >= trade.openedAt
    && now - trade.openedAt <= LIVE_MIRROR_ENTRY_WINDOW_MS;
}

export function liveMirrorExitRequired(positionId: string, selectedTrade: ArenaTrade | null | undefined) {
  return !selectedTrade || selectedTrade.id !== positionId;
}
