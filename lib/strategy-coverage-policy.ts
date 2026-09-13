import type { AllRegimeStrategyId } from "./all-regime-engine.ts";
import type { MarketPhase, MarketStateCell, MarketStateFeatures } from "./strategy-coverage.ts";

export const STRATEGY_STATE_AUTHORITY: Partial<Record<AllRegimeStrategyId, readonly string[]>> = {
  range_reentry: [], channel_break: [], trend_pullback: [], bear_squeeze: [], bull_pullback: [],
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
  sourceDirection?: 1 | -1; localMoveRate?: number }, features: MarketStateFeatures & {
    marketBreadth4h?: number; marketMedianMove4h?: number; marketBreadth24h?: number;
    marketMedianMove24h?: number; btcMove24h?: number; regimeMarkets?: number;
  }) {
  const breadth4h = features.marketBreadth4h ?? 0.5; const move4h = features.marketMedianMove4h ?? 0;
  const breadth24h = features.marketBreadth24h ?? 0.5; const move24h = features.marketMedianMove24h ?? 0;
  if (["range_reentry", "channel_break", "trend_pullback", "bear_squeeze", "bull_pullback"].includes(route.strategyId)) {
    if ((features.regimeMarkets ?? 0) < 12) return false;
    if (route.strategyId === "range_reentry") return route.side === "LONG"
      && breadth24h >= .57 && move24h > .02 && breadth4h <= .43;
    if (route.strategyId === "channel_break") return route.side === "SHORT"
      && breadth24h > .43 && breadth24h < .71 && move24h <= 0;
    if (route.strategyId === "trend_pullback") return route.side === "LONG"
      && breadth24h <= .43 && move24h < 0 && move24h >= -.01 && move4h < 0 && (features.btcMove24h ?? 0) < 0;
    if (route.strategyId === "bear_squeeze") return route.side === "LONG"
      && breadth24h <= .57 && move24h < 0 && move4h < 0;
    return route.side === "LONG" && breadth24h >= .71 && move24h > .01 && move4h <= 0 && move4h > -.01;
  }
  return false;
}
