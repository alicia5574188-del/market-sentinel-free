import type { AllRegimeStrategyId } from "./all-regime-engine.ts";
import { classifyMarketState, type MarketPhase, type MarketStateCell, type MarketStateFeatures } from "./strategy-coverage.ts";

export const STRATEGY_STATE_AUTHORITY: Partial<Record<AllRegimeStrategyId, readonly string[]>> = {
  momentum_carry: [],
  tide_catchup: ["COMPRESSION:BROAD_UP:LOW_EDGE", "ORDERLY_TREND:BROAD_DOWN:HIGH_EDGE"],
  quiet_drift: ["COMPRESSION:MIXED:CENTER", "BALANCED_ROTATION:MIXED:CENTER"],
  impulse_recoil: ["EXPANSION:BROAD_UP:HIGH_EDGE"],
  impulse_fold: ["BALANCED_ROTATION:MIXED:HIGH_EDGE"],
  tide_relay: ["EXPANSION:BROAD_UP:HIGH_EDGE"],
};

export const MARKET_PHASE_AUTHORITY: Record<MarketPhase, "TRADE" | "WAIT"> = {
  COMPRESSION: "TRADE",
  EXPANSION: "TRADE",
  ORDERLY_TREND: "TRADE",
  BALANCED_ROTATION: "TRADE",
  TRANSITION: "WAIT",
};

export function strategyStateApproved(strategyId: AllRegimeStrategyId, state: MarketStateCell) {
  return STRATEGY_STATE_AUTHORITY[strategyId]?.includes(state.key) ?? false;
}

export function routeMarketApproved(route: { strategyId: AllRegimeStrategyId; side: "LONG" | "SHORT";
  sourceDirection?: 1 | -1; localMoveRate?: number }, features: MarketStateFeatures) {
  const state = classifyMarketState(features);
  if (MARKET_PHASE_AUTHORITY[state.phase] === "WAIT" || !strategyStateApproved(route.strategyId, state)) return false;
  const breadth = features.marketBreadth; const medianMove = features.marketMedianMove;
  const broadUp = breadth >= 0.6 && medianMove >= 0.001;
  const broadDown = breadth <= 0.4 && medianMove <= -0.001;
  if (route.strategyId === "momentum_carry") return false;
  if (route.strategyId === "tide_catchup") {
    const direction = route.side === "LONG" ? 1 : -1;
    return (direction > 0 ? broadUp : broadDown)
      && direction * (medianMove - (route.localMoveRate ?? 0)) >= 0.003;
  }
  if (route.strategyId === "tide_relay") return route.side === "LONG" ? broadUp : broadDown;
  if (route.strategyId === "quiet_drift") return Math.abs(medianMove) <= 0.0018;
  if (route.strategyId === "impulse_recoil") return true;
  if (route.strategyId === "impulse_fold") {
    const direction = route.sourceDirection ?? (route.side === "LONG" ? -1 : 1);
    const opposed = direction > 0 ? breadth <= 0.42 || medianMove <= -0.0008
      : breadth >= 0.58 || medianMove >= 0.0008;
    const neutral = breadth >= 0.38 && breadth <= 0.62 && Math.abs(medianMove) <= 0.0015;
    return opposed || neutral;
  }
  return false;
}
