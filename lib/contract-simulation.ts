import { RISK_POLICY, maxMarginAllocationUsdt, minimumTp2NetProfitBudgetUsdt, singleTradeRiskBudgetUsdt } from "./risk-policy.ts";

export type ContractSide = "LONG" | "SHORT";

export type ContractPlanInput = {
  side: ContractSide;
  entryPrice: number;
  stopLossPrice: number;
  atrPct: number | null;
  dataQuality: number;
  confidence: number;
  liquidityVolumeUsd: number;
  accountEquityUsdt: number;
  availableMarginUsdt: number;
  requestedRiskUsdt: number;
};

export type ContractPlan = {
  contractType: "USDT_PERPETUAL";
  marginMode: "isolated";
  leverage: number;
  leverageCap: number;
  leverageReason: string;
  marginUsdt: number;
  contractNotionalUsdt: number;
  quantity: number;
  estimatedLiquidationPrice: number;
  plannedLossUsdt: number;
};

export type ContractPnl = {
  grossPnlUsdt: number;
  estimatedCostUsdt: number;
  netPnlUsdt: number;
};

export const MIN_TP2_NET_PROFIT_EQUITY_RATE = RISK_POLICY.minimumTp2NetProfitRate;

export type TakeProfitViability = ContractPnl & {
  grossMovePct: number;
  estimatedCostPct: number;
  netMovePct: number;
  minimumNetProfitUsdt: number;
  passed: boolean;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function finitePositive(value: number, fallback = 0) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function round(value: number, digits = 8) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function minimumTp2NetProfitUsdt(accountEquityUsdt: number) {
  return minimumTp2NetProfitBudgetUsdt(accountEquityUsdt);
}

function liquidityLeverageCap(volumeUsd: number) {
  if (volumeUsd >= 500_000_000) return 8;
  if (volumeUsd >= 100_000_000) return 6;
  if (volumeUsd >= 25_000_000) return 4;
  return 3;
}

function volatilityLeverageCap(atrPct: number | null) {
  if (atrPct == null || !Number.isFinite(atrPct)) return 3;
  if (atrPct >= 3) return 2;
  if (atrPct >= 1.8) return 3;
  if (atrPct >= 1) return 5;
  return 8;
}

/**
 * Builds a deterministic paper USDT-perpetual position. Leverage is only a
 * margin-efficiency choice: the stop-defined USDT risk is fixed first and the
 * position is reduced when liquidity, volatility, quality or free margin caps it.
 */
export function buildContractPlan(input: ContractPlanInput): ContractPlan {
  const entryPrice = finitePositive(input.entryPrice);
  const stopDistanceFraction = entryPrice > 0
    ? Math.abs(entryPrice - input.stopLossPrice) / entryPrice
    : 1;
  const equity = finitePositive(input.accountEquityUsdt);
  const availableMargin = Math.max(0, Number.isFinite(input.availableMarginUsdt) ? input.availableMarginUsdt : 0);
  const accountRiskCap = singleTradeRiskBudgetUsdt(equity);
  const requestedRisk = Math.min(finitePositive(input.requestedRiskUsdt), accountRiskCap);
  const liquidityCap = liquidityLeverageCap(finitePositive(input.liquidityVolumeUsd));
  const volatilityCap = volatilityLeverageCap(input.atrPct);
  const qualityCap = input.dataQuality < 0.8 || input.confidence < 75 ? 3 : 8;
  const leverageCap = clamp(Math.min(liquidityCap, volatilityCap, qualityCap), 1, 8);
  const marginAllocationCap = Math.min(maxMarginAllocationUsdt(equity), availableMargin);
  const desiredNotional = stopDistanceFraction > 0 ? requestedRisk / stopDistanceFraction : 0;
  const requiredLeverage = marginAllocationCap > 0 ? Math.ceil(desiredNotional / marginAllocationCap) : 1;
  const leverage = clamp(requiredLeverage, 1, leverageCap);
  const contractNotionalUsdt = Math.max(0, Math.min(
    desiredNotional,
    marginAllocationCap * leverage,
    availableMargin * leverage,
  ));
  const marginUsdt = leverage > 0 ? contractNotionalUsdt / leverage : 0;
  const plannedLossUsdt = contractNotionalUsdt * stopDistanceFraction;
  const quantity = entryPrice > 0 ? contractNotionalUsdt / entryPrice : 0;
  const liquidationBuffer = 0.92 / leverage;
  const estimatedLiquidationPrice = input.side === "LONG"
    ? entryPrice * (1 - liquidationBuffer)
    : entryPrice * (1 + liquidationBuffer);
  const atrLabel = input.atrPct == null ? "ATR未知" : `5m ATR ${input.atrPct.toFixed(2)}%`;
  const liquidityLabel = input.liquidityVolumeUsd >= 1_000_000_000
    ? "高流动性"
    : input.liquidityVolumeUsd >= 100_000_000
      ? "中高流动性"
      : input.liquidityVolumeUsd >= 25_000_000
        ? "中等流动性"
        : "较低流动性";
  const qualityLabel = qualityCap === 3 ? "质量/可信度限制3x" : "数据质量通过";

  return {
    contractType: "USDT_PERPETUAL",
    marginMode: "isolated",
    leverage,
    leverageCap,
    leverageReason: `${liquidityLabel}上限${liquidityCap}x；${atrLabel}上限${volatilityCap}x；${qualityLabel}；按20%净值保证金上限取${leverage}x`,
    marginUsdt: round(marginUsdt),
    contractNotionalUsdt: round(contractNotionalUsdt),
    quantity: round(quantity),
    estimatedLiquidationPrice: round(Math.max(0, estimatedLiquidationPrice)),
    plannedLossUsdt: round(plannedLossUsdt),
  };
}

export function calculateContractPnl(notionalUsdt: number, grossMovePct: number, estimatedCostPct: number): ContractPnl {
  const notional = Math.max(0, Number.isFinite(notionalUsdt) ? notionalUsdt : 0);
  const grossPnlUsdt = notional * (Number.isFinite(grossMovePct) ? grossMovePct : 0) / 100;
  const estimatedCostUsdt = notional * Math.max(0, Number.isFinite(estimatedCostPct) ? estimatedCostPct : 0) / 100;
  return {
    grossPnlUsdt: round(grossPnlUsdt),
    estimatedCostUsdt: round(estimatedCostUsdt),
    netPnlUsdt: round(grossPnlUsdt - estimatedCostUsdt),
  };
}

/**
 * Projects the full-position net result at TP2 after the configured round-trip
 * cost. The minimum useful profit scales with current account equity rather
 * than a fixed USDT amount. This gate is evaluated only after the real leverage
 * and notional caps have been applied, so leverage is never raised merely to
 * make a trade pass.
 */
export function assessTakeProfitViability(input: {
  side: ContractSide;
  entryPrice: number;
  takeProfitPrice: number;
  notionalUsdt: number;
  accountEquityUsdt: number;
  roundTripCostBps: number;
  minimumNetProfitUsdt?: number;
}): TakeProfitViability {
  const entryPrice = finitePositive(input.entryPrice);
  const takeProfitPrice = finitePositive(input.takeProfitPrice);
  const rawMovePct = entryPrice > 0 && takeProfitPrice > 0
    ? (takeProfitPrice / entryPrice - 1) * 100
    : 0;
  const grossMovePct = input.side === "SHORT" ? -rawMovePct : rawMovePct;
  const estimatedCostPct = Math.max(0, Number.isFinite(input.roundTripCostBps) ? input.roundTripCostBps : 0) / 100;
  const hasExplicitMinimum = typeof input.minimumNetProfitUsdt === "number" && Number.isFinite(input.minimumNetProfitUsdt);
  const minimumNetProfitUsdt = Math.max(0, hasExplicitMinimum
    ? input.minimumNetProfitUsdt!
    : minimumTp2NetProfitUsdt(input.accountEquityUsdt));
  const pnl = calculateContractPnl(input.notionalUsdt, grossMovePct, estimatedCostPct);
  return {
    ...pnl,
    grossMovePct: round(grossMovePct),
    estimatedCostPct: round(estimatedCostPct),
    netMovePct: round(grossMovePct - estimatedCostPct),
    minimumNetProfitUsdt: round(minimumNetProfitUsdt),
    passed: pnl.netPnlUsdt >= minimumNetProfitUsdt,
  };
}
