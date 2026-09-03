export type Hte31PositionSide = "LONG" | "SHORT";

export type Hte31PositionSizingInput = {
  side: Hte31PositionSide;
  entryPrice: number;
  stopLossPrice: number;
  originalTakeProfit2Price: number;
  accountEquityUsdt: number;
  availableMarginUsdt: number;
  riskMultiplier: number;
  roundTripCostBps: number;
  liquidityVolumeUsd: number;
  atrPct: number | null;
  dataQuality: number;
  confidence: number;
  riskRate?: number;
  minimumTp2NetProfitUsdt?: number;
};

export type Hte31PositionSizing = {
  accepted: boolean;
  reason: string;
  leverage: number;
  leverageCap: number;
  leverageReason: string;
  marginUsdt: number;
  notionalUsdt: number;
  quantity: number;
  plannedRiskUsdt: number;
  minimumRiskUsdt: number;
  maximumRiskUsdt: number;
  targetRiskUsdt: number;
  takeProfit2Price: number;
  riskReward: number;
  plannedTp2GrossProfitUsdt: number;
  plannedTp2CostUsdt: number;
  plannedTp2NetProfitUsdt: number;
  minimumTp2NetProfitUsdt: number;
  maximumTp2NetProfitUsdt: number;
  tp2Adjusted: boolean;
  estimatedLiquidationPrice: number;
};

export const HTE31_PAPER_POSITION_POLICY = {
  minimumRiskRate: 0.03,
  targetRiskRate: 0.04,
  maximumRiskRate: 0.05,
  minimumTp2NetProfitUsdt: 50,
  maximumMarketRiskReward: 20,
  targetMarginAllocationRate: 0.08,
  maximumMarginAllocationRate: 0.35,
  maximumLeverage: 50,
  liquidationMaintenanceFactor: 0.92,
  liquidationStopBufferMultiple: 2.5,
  liquidationExtraBufferRate: 0.003,
} as const;

export const HTE31_PAPER_PORTFOLIO_POLICY = {
  maxOpenPositions: 3,
  maximumTotalPlannedRiskRate: 0.15,
  maxSameSidePositions: 3,
} as const;

export type Hte31OpenRisk = {
  side: Hte31PositionSide;
  riskBudgetUsdt: number;
};

export function hte31PaperPortfolioBlockReason(input: {
  open: Hte31OpenRisk[];
  nextSide: Hte31PositionSide;
  nextRiskUsdt: number;
  accountEquityUsdt: number;
}) {
  const policy = HTE31_PAPER_PORTFOLIO_POLICY;
  if (input.open.length >= policy.maxOpenPositions) return `模拟账户同时最多 ${policy.maxOpenPositions} 笔持仓`;
  const sameSide = input.open.filter((row) => row.side === input.nextSide).length;
  if (sameSide >= policy.maxSameSidePositions) return `模拟账户同方向同时最多 ${policy.maxSameSidePositions} 笔持仓`;
  const totalRisk = input.open.reduce((sum, row) => sum + Math.max(0, row.riskBudgetUsdt), 0) + Math.max(0, input.nextRiskUsdt);
  const maximumRisk = Math.max(0, input.accountEquityUsdt) * policy.maximumTotalPlannedRiskRate;
  if (totalRisk > maximumRisk + 0.01) return `组合计划止损 ${totalRisk.toFixed(2)}U 超过权益 ${(policy.maximumTotalPlannedRiskRate * 100).toFixed(0)}% 上限 ${maximumRisk.toFixed(2)}U`;
  return null;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function positive(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function round(value: number, digits = 8) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function direction(side: Hte31PositionSide) {
  return side === "LONG" ? 1 : -1;
}

function liquidityLeverageCap(volumeUsd: number) {
  if (volumeUsd >= 500_000_000) return 50;
  if (volumeUsd >= 100_000_000) return 40;
  if (volumeUsd >= 25_000_000) return 25;
  return 15;
}

function volatilityLeverageCap(atrPct: number | null) {
  if (atrPct == null || !Number.isFinite(atrPct)) return 15;
  if (atrPct >= 3) return 12;
  if (atrPct >= 1.8) return 20;
  if (atrPct >= 1) return 30;
  return 50;
}

function emptyResult(reason: string): Hte31PositionSizing {
  return {
    accepted: false,
    reason,
    leverage: 1,
    leverageCap: 1,
    leverageReason: reason,
    marginUsdt: 0,
    notionalUsdt: 0,
    quantity: 0,
    plannedRiskUsdt: 0,
    minimumRiskUsdt: 0,
    maximumRiskUsdt: 0,
    targetRiskUsdt: 0,
    takeProfit2Price: 0,
    riskReward: 0,
    plannedTp2GrossProfitUsdt: 0,
    plannedTp2CostUsdt: 0,
    plannedTp2NetProfitUsdt: 0,
    minimumTp2NetProfitUsdt: HTE31_PAPER_POSITION_POLICY.minimumTp2NetProfitUsdt,
    maximumTp2NetProfitUsdt: Number.MAX_VALUE,
    tp2Adjusted: false,
    estimatedLiquidationPrice: 0,
  };
}

/**
 * Paper sizing only decides how much capital can safely express a setup.
 * Resonance owns the target price before this function is called. This layer
 * must never stretch a target toward a preferred USDT profit number: 50U is
 * only the minimum economic value required to take a paper trade, while the
 * market-defined target may be materially larger.
 */
export function buildHte31PaperPosition(input: Hte31PositionSizingInput): Hte31PositionSizing {
  const entryPrice = positive(input.entryPrice);
  const stopLossPrice = positive(input.stopLossPrice);
  const originalTakeProfit2Price = positive(input.originalTakeProfit2Price);
  const equityUsdt = positive(input.accountEquityUsdt);
  const availableMarginUsdt = Math.max(0, Number.isFinite(input.availableMarginUsdt) ? input.availableMarginUsdt : 0);
  if (!(entryPrice > 0 && stopLossPrice > 0 && originalTakeProfit2Price > 0 && equityUsdt > 0)) {
    return emptyResult("仓位输入无效");
  }

  const stopDistance = Math.abs(entryPrice - stopLossPrice);
  const stopDistanceRate = stopDistance / entryPrice;
  const originalTp2Distance = direction(input.side) * (originalTakeProfit2Price - entryPrice);
  const originalRiskReward = originalTp2Distance / stopDistance;
  if (!(stopDistanceRate > 0 && originalRiskReward > 0)) return emptyResult("结构止损或TP2方向无效");
  if (originalRiskReward > HTE31_PAPER_POSITION_POLICY.maximumMarketRiskReward + 1e-8) {
    return emptyResult(`市场目标 ${originalRiskReward.toFixed(2)}R 超过结构安全上限 ${HTE31_PAPER_POSITION_POLICY.maximumMarketRiskReward}R`);
  }

  const explicitRiskRate = input.riskRate == null ? null : clamp(input.riskRate, 0, HTE31_PAPER_POSITION_POLICY.maximumRiskRate);
  const minimumRiskUsdt = equityUsdt * (explicitRiskRate ?? HTE31_PAPER_POSITION_POLICY.minimumRiskRate);
  const maximumRiskUsdt = equityUsdt * (explicitRiskRate ?? HTE31_PAPER_POSITION_POLICY.maximumRiskRate);
  const normalTargetRiskUsdt = equityUsdt * (explicitRiskRate ?? HTE31_PAPER_POSITION_POLICY.targetRiskRate);
  const governedRiskUsdt = explicitRiskRate == null ? normalTargetRiskUsdt * clamp(input.riskMultiplier, 0, 1) : normalTargetRiskUsdt;
  const targetRiskUsdt = clamp(governedRiskUsdt, minimumRiskUsdt, maximumRiskUsdt);

  const liquidityCap = liquidityLeverageCap(positive(input.liquidityVolumeUsd));
  const volatilityCap = volatilityLeverageCap(input.atrPct);
  const qualityCap = input.dataQuality < 0.75 || input.confidence < 72
    ? 12
    : input.dataQuality < 0.82 || input.confidence < 78
      ? 25
      : HTE31_PAPER_POSITION_POLICY.maximumLeverage;
  const requiredLiquidationBufferRate = stopDistanceRate * HTE31_PAPER_POSITION_POLICY.liquidationStopBufferMultiple
    + HTE31_PAPER_POSITION_POLICY.liquidationExtraBufferRate;
  const liquidationSafeCap = Math.max(1, Math.floor(
    HTE31_PAPER_POSITION_POLICY.liquidationMaintenanceFactor / requiredLiquidationBufferRate,
  ));
  const leverageCap = clamp(Math.min(liquidityCap, volatilityCap, qualityCap, liquidationSafeCap), 1, HTE31_PAPER_POSITION_POLICY.maximumLeverage);
  const hardMarginCap = Math.min(
    availableMarginUsdt,
    equityUsdt * HTE31_PAPER_POSITION_POLICY.maximumMarginAllocationRate,
  );
  if (!(hardMarginCap > 0)) return emptyResult("模拟账户可用保证金不足");
  const targetMarginCap = Math.min(
    hardMarginCap,
    equityUsdt * HTE31_PAPER_POSITION_POLICY.targetMarginAllocationRate,
  );

  const roundTripCostRate = Math.max(0, Number.isFinite(input.roundTripCostBps) ? input.roundTripCostBps : 0) / 10_000;
  const netStopLossRate = stopDistanceRate + roundTripCostRate;
  const desiredNotionalUsdt = targetRiskUsdt / netStopLossRate;
  const requiredLeverage = Math.max(1, Math.ceil(desiredNotionalUsdt / targetMarginCap));
  const leverage = clamp(requiredLeverage, 1, leverageCap);
  // Most positions stay inside the 8% target. Exceptionally narrow structural
  // stops may need more collateral after the 50x safety cap is reached, but can
  // never cross the 35% hard fallback.
  const notionalUsdt = Math.min(desiredNotionalUsdt, hardMarginCap * leverage);
  const marginUsdt = notionalUsdt / leverage;
  const quantity = notionalUsdt / entryPrice;
  const plannedRiskUsdt = notionalUsdt * netStopLossRate;

  const takeProfit2Price = originalTakeProfit2Price;
  const riskReward = originalRiskReward;
  const grossTp2MoveRate = riskReward * stopDistanceRate;
  const plannedTp2GrossProfitUsdt = notionalUsdt * grossTp2MoveRate;
  const plannedTp2CostUsdt = notionalUsdt * roundTripCostRate;
  const plannedTp2NetProfitUsdt = plannedTp2GrossProfitUsdt - plannedTp2CostUsdt;
  const minimumTp2NetProfitUsdt = input.minimumTp2NetProfitUsdt ?? HTE31_PAPER_POSITION_POLICY.minimumTp2NetProfitUsdt;

  const liquidationDistanceRate = HTE31_PAPER_POSITION_POLICY.liquidationMaintenanceFactor / leverage;
  const estimatedLiquidationPrice = input.side === "LONG"
    ? entryPrice * (1 - liquidationDistanceRate)
    : entryPrice * (1 + liquidationDistanceRate);
  const liquidationSafe = liquidationDistanceRate >= requiredLiquidationBufferRate;

  const targetMarginPct = HTE31_PAPER_POSITION_POLICY.targetMarginAllocationRate * 100;
  const maximumMarginPct = HTE31_PAPER_POSITION_POLICY.maximumMarginAllocationRate * 100;
  const usedMarginPct = marginUsdt / equityUsdt * 100;
  const leverageReason = `需求 ${requiredLeverage}x / 上限 ${leverageCap}x；流动性 ${liquidityCap}x，波动 ${volatilityCap}x，质量 ${qualityCap}x，强平安全 ${liquidationSafeCap}x；隔离保证金目标净值${targetMarginPct.toFixed(0)}%${usedMarginPct > targetMarginPct + 0.01 ? `，安全回退 ${usedMarginPct.toFixed(1)}%` : ""}（硬上限${maximumMarginPct.toFixed(0)}%）`;
  let reason = `计划净风险(含费用) ${plannedRiskUsdt.toFixed(2)}U，市场目标 ${riskReward.toFixed(2)}R / 预计净利润 ${plannedTp2NetProfitUsdt.toFixed(2)}U`;
  let accepted = true;
  if (plannedRiskUsdt + 1e-8 < minimumRiskUsdt) {
    accepted = false;
    reason = `最高 ${leverageCap}x 后计划风险仅 ${plannedRiskUsdt.toFixed(2)}U，低于 ${minimumRiskUsdt.toFixed(2)}U`;
  } else if (plannedRiskUsdt - 1e-8 > maximumRiskUsdt) {
    accepted = false;
    reason = `计划风险 ${plannedRiskUsdt.toFixed(2)}U，超过 ${maximumRiskUsdt.toFixed(2)}U`;
  } else if (plannedTp2NetProfitUsdt + 1e-8 < minimumTp2NetProfitUsdt) {
    accepted = false;
    reason = `市场结构只提供约 ${plannedTp2NetProfitUsdt.toFixed(2)}U 净利润，低于最低 ${minimumTp2NetProfitUsdt.toFixed(0)}U；不为凑利润人为抬高TP`;
  } else if (!liquidationSafe) {
    accepted = false;
    reason = `预计强平缓冲 ${(liquidationDistanceRate * 100).toFixed(2)}% 不足以覆盖结构止损与安全余量`;
  }

  return {
    accepted,
    reason,
    leverage,
    leverageCap,
    leverageReason,
    marginUsdt: round(marginUsdt),
    notionalUsdt: round(notionalUsdt),
    quantity: round(quantity),
    plannedRiskUsdt: round(plannedRiskUsdt),
    minimumRiskUsdt: round(minimumRiskUsdt),
    maximumRiskUsdt: round(maximumRiskUsdt),
    targetRiskUsdt: round(targetRiskUsdt),
    takeProfit2Price: round(takeProfit2Price),
    riskReward: round(riskReward),
    plannedTp2GrossProfitUsdt: round(plannedTp2GrossProfitUsdt),
    plannedTp2CostUsdt: round(plannedTp2CostUsdt),
    plannedTp2NetProfitUsdt: round(plannedTp2NetProfitUsdt),
    minimumTp2NetProfitUsdt: round(minimumTp2NetProfitUsdt),
    maximumTp2NetProfitUsdt: Number.MAX_VALUE,
    tp2Adjusted: false,
    estimatedLiquidationPrice: round(Math.max(0, estimatedLiquidationPrice)),
  };
}
