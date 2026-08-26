import { minimumTp2NetProfitUsdt } from "./contract-simulation.ts";
import { RISK_POLICY, dailyLossPauseUsdt, maxMarginAllocationUsdt, peakDrawdownLimitUsdt, singleTradeRiskBudgetUsdt } from "./risk-policy.ts";
import type { GateContract, GateFuturesAccount, GatePositionClose } from "./gate-private";

export const MAX_LIVE_OPEN_POSITIONS = RISK_POLICY.maxLiveOpenPositions;
const MAX_ENTRY_DRIFT_PCT = 0.3;

export type LiveTradeCandidate = {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  entryLow: number;
  entryHigh: number;
  currentStopPrice: number;
  takeProfit2Price: number;
  leverage: number;
  contractNotionalUsdt: number;
};

export type LiveEntryPlan = {
  passed: boolean;
  reason: string | null;
  markPrice: number;
  accountEquityUsdt: number;
  minimumNetTp2Usdt: number;
  riskBudgetUsdt: number;
  projectedStopLossUsdt: number;
  targetNotionalUsdt: number;
  contractMultiplier: number;
  contracts: number;
  signedContracts: number;
  actualNotionalUsdt: number;
  requiredMarginUsdt: number;
  expectedGrossTp2Usdt: number;
  estimatedRoundTripCostUsdt: number;
  effectiveRoundTripCostBps: number;
  expectedNetTp2Usdt: number;
  worstCaseNetTp2Usdt: number;
  marketOrderSlipRatio: string;
  stopLossPrice: number;
  takeProfitPrice: number;
};

function number(value: string | number | null | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function failed(reason: string, partial: Partial<LiveEntryPlan> = {}): LiveEntryPlan {
  return {
    passed: false,
    reason,
    markPrice: 0,
    accountEquityUsdt: 0,
    minimumNetTp2Usdt: 0,
    riskBudgetUsdt: 0,
    projectedStopLossUsdt: 0,
    targetNotionalUsdt: 0,
    contractMultiplier: 0,
    contracts: 0,
    signedContracts: 0,
    actualNotionalUsdt: 0,
    requiredMarginUsdt: 0,
    expectedGrossTp2Usdt: 0,
    estimatedRoundTripCostUsdt: 0,
    effectiveRoundTripCostBps: 0,
    expectedNetTp2Usdt: 0,
    worstCaseNetTp2Usdt: 0,
    marketOrderSlipRatio: "0.003",
    stopLossPrice: 0,
    takeProfitPrice: 0,
    ...partial,
  };
}

export function gateAccountEquityUsdt(account: GateFuturesAccount) {
  const total = number(account.total);
  const unrealized = number(account.unrealised_pnl ?? account.unrealized_pnl);
  const classicEquity = total > 0 ? total + unrealized : 0;
  if (classicEquity > 0) return classicEquity;
  return Math.max(0, number(account.cross_available), number(account.available));
}

function roundToTick(price: number, tick: number, direction: "up" | "down") {
  if (!(tick > 0) || !(price > 0)) return price;
  const units = price / tick;
  const rounded = direction === "up" ? Math.ceil(units - 1e-10) : Math.floor(units + 1e-10);
  return Number((rounded * tick).toPrecision(15));
}

export function normalizeLiveProtectionPrices(input: {
  side: "LONG" | "SHORT";
  stopLossPrice: number;
  takeProfitPrice: number;
  priceTick: number;
}) {
  return {
    stopLossPrice: roundToTick(input.stopLossPrice, input.priceTick, input.side === "LONG" ? "up" : "down"),
    takeProfitPrice: roundToTick(input.takeProfitPrice, input.priceTick, input.side === "LONG" ? "down" : "up"),
  };
}

export function buildLiveEntryPlan(input: {
  trade: LiveTradeCandidate;
  contract: GateContract;
  account: GateFuturesAccount;
  /** @deprecated Risk is derived from the scaled Strategy 2.0 candidate and capped by current equity × 1%. */
  maxRiskPerAlertUsdt?: number;
  roundTripCostBps: number;
}): LiveEntryPlan {
  const { trade, contract, account } = input;
  if (contract.in_delisting || (contract.status && !/trad|active/i.test(contract.status))) return failed("Gate 合约已停止交易或正在下架");
  const markPrice = number(contract.mark_price || contract.last_price);
  const multiplier = number(contract.quanto_multiplier);
  if (markPrice <= 0 || multiplier <= 0) return failed("Gate 合约价格或乘数无效", { markPrice, contractMultiplier: multiplier });
  const contractSlip = number(contract.market_order_slip_ratio);
  const slip = contractSlip > 0 ? Math.min(contractSlip, 0.003) : 0.003;
  const worstCaseEntryPrice = trade.side === "LONG" ? markPrice * (1 + slip) : markPrice * (1 - slip);
  const priceTick = number(contract.order_price_round || contract.mark_price_round);
  const normalizedProtection = normalizeLiveProtectionPrices({
    side: trade.side,
    stopLossPrice: trade.currentStopPrice,
    takeProfitPrice: trade.takeProfit2Price,
    priceTick,
  });
  const stopLossPrice = normalizedProtection.stopLossPrice;
  const takeProfitPrice = normalizedProtection.takeProfitPrice;
  const driftPct = Math.abs(markPrice / trade.entryPrice - 1) * 100;
  const low = trade.entryLow * (1 - MAX_ENTRY_DRIFT_PCT / 100);
  const high = trade.entryHigh * (1 + MAX_ENTRY_DRIFT_PCT / 100);
  if (driftPct > MAX_ENTRY_DRIFT_PCT || markPrice < low || markPrice > high) {
    return failed(`实时价格已偏离策略入场区（${driftPct.toFixed(2)}%）`, { markPrice, contractMultiplier: multiplier });
  }
  const leverageMax = number(contract.leverage_max);
  if (trade.leverage < 1 || (leverageMax > 0 && trade.leverage > leverageMax)) {
    return failed("策略杠杆超过 Gate 当前合约上限", { markPrice, contractMultiplier: multiplier });
  }
  const stopIsValid = trade.side === "LONG" ? stopLossPrice < markPrice : stopLossPrice > markPrice;
  const takeProfitIsValid = trade.side === "LONG" ? takeProfitPrice > worstCaseEntryPrice : takeProfitPrice < worstCaseEntryPrice;
  if (!stopIsValid) return failed("按 Gate 价格精度取整后，保护止损不在开仓方向的有效一侧", { markPrice, contractMultiplier: multiplier, stopLossPrice, takeProfitPrice });
  if (!takeProfitIsValid) return failed("按 Gate 价格精度和允许滑点计算后，TP2 已无有效盈利空间", { markPrice, contractMultiplier: multiplier, stopLossPrice, takeProfitPrice });
  // Entries are explicitly switched to Gate isolated margin before submission,
  // so only Gate's isolated `available` field is a valid margin ceiling here.
  // `cross_available` describes cross-margin capacity and must not enlarge an isolated order.
  const availableUsdt = Math.max(0, number(account.available));
  const accountEquityUsdt = gateAccountEquityUsdt(account);
  const minimumNetTp2Usdt = minimumTp2NetProfitUsdt(accountEquityUsdt);
  if (accountEquityUsdt <= 0 || availableUsdt <= 0) {
    return failed("Gate 合约账户没有可用资金", { markPrice, contractMultiplier: multiplier, accountEquityUsdt, minimumNetTp2Usdt });
  }
  const stopDistanceFraction = Math.abs(worstCaseEntryPrice - stopLossPrice) / worstCaseEntryPrice;
  const accountRiskBudgetUsdt = singleTradeRiskBudgetUsdt(accountEquityUsdt);
  // The candidate notional has already been multiplied by Strategy 2.0's
  // exploration/permission/volatility/portfolio multiplier. Reconstruct the
  // candidate's own stop-defined risk here so live slippage cannot inflate a
  // 0.25x exploration idea back toward the full 1% account ceiling.
  const candidateStopDistanceFraction = trade.entryPrice > 0
    ? Math.abs(trade.entryPrice - stopLossPrice) / trade.entryPrice
    : 1;
  const candidateRiskBudgetUsdt = Math.max(0, trade.contractNotionalUsdt * candidateStopDistanceFraction);
  const riskBudgetUsdt = Math.min(accountRiskBudgetUsdt, candidateRiskBudgetUsdt || accountRiskBudgetUsdt);
  const riskNotionalCap = stopDistanceFraction > 0
    ? riskBudgetUsdt * markPrice / Math.abs(worstCaseEntryPrice - stopLossPrice)
    : 0;
  const marginAllocationUsdt = Math.min(maxMarginAllocationUsdt(accountEquityUsdt), availableUsdt / 1.1);
  const targetNotionalUsdt = Math.max(0, Math.min(
    trade.contractNotionalUsdt,
    riskNotionalCap,
    marginAllocationUsdt * trade.leverage,
  ));
  const minimum = Math.max(1, Math.ceil(number(contract.order_size_min)));
  const configuredMax = Math.floor(number(contract.order_size_max));
  const marketMax = Math.floor(number(contract.market_order_size_max));
  const maximum = marketMax > 0 ? Math.min(configuredMax || marketMax, marketMax) : configuredMax;
  let contracts = Math.floor(targetNotionalUsdt / (markPrice * multiplier));
  if (maximum > 0) contracts = Math.min(contracts, maximum);
  if (contracts < minimum) return failed("按 Gate 实际资金和风险上限换算后低于最小合约张数", {
    markPrice,
    accountEquityUsdt,
    minimumNetTp2Usdt,
    riskBudgetUsdt,
    targetNotionalUsdt,
    contractMultiplier: multiplier,
    contracts,
  });
  const actualNotionalUsdt = contracts * multiplier * markPrice;
  const requiredMarginUsdt = actualNotionalUsdt / trade.leverage;
  const projectedStopLossUsdt = contracts * multiplier * Math.abs(worstCaseEntryPrice - stopLossPrice);
  if (requiredMarginUsdt * 1.1 > availableUsdt) {
    return failed("Gate 可用保证金不足（已包含 10% 缓冲）", {
      markPrice,
      accountEquityUsdt,
      minimumNetTp2Usdt,
      riskBudgetUsdt,
      projectedStopLossUsdt,
      targetNotionalUsdt,
      contractMultiplier: multiplier,
      contracts,
      actualNotionalUsdt,
      requiredMarginUsdt,
    });
  }
  if (projectedStopLossUsdt > riskBudgetUsdt + 0.01) {
    return failed("按 Gate 实际张数计算的止损风险超过该 Strategy 2.0 候选风险上限", {
      markPrice,
      accountEquityUsdt,
      minimumNetTp2Usdt,
      riskBudgetUsdt,
      projectedStopLossUsdt,
      targetNotionalUsdt,
      contractMultiplier: multiplier,
      contracts,
      actualNotionalUsdt,
      requiredMarginUsdt,
    });
  }
  const expectedGrossTp2Usdt = trade.side === "LONG"
    ? contracts * multiplier * (takeProfitPrice - markPrice)
    : contracts * multiplier * (markPrice - takeProfitPrice);
  const gateRoundTripCostBps = Math.max(0, number(contract.taker_fee_rate)) * 2 * 10_000;
  const effectiveRoundTripCostBps = Math.max(0, input.roundTripCostBps, gateRoundTripCostBps);
  const conservativeFeeNotionalUsdt = contracts * multiplier * Math.max(markPrice, takeProfitPrice);
  const estimatedRoundTripCostUsdt = conservativeFeeNotionalUsdt * effectiveRoundTripCostBps / 10_000;
  const expectedNetTp2Usdt = expectedGrossTp2Usdt - estimatedRoundTripCostUsdt;
  const worstCaseNetTp2Usdt = projectedNetTp2Usdt({
    side: trade.side,
    entryPrice: worstCaseEntryPrice,
    takeProfitPrice,
    contracts,
    contractMultiplier: multiplier,
    roundTripCostBps: effectiveRoundTripCostBps,
    exitSlippageRatio: slip,
  });
  if (worstCaseNetTp2Usdt < minimumNetTp2Usdt) {
    return failed(`按 Gate 实时张数并预留允许滑点后，TP2预计净利润 ${worstCaseNetTp2Usdt.toFixed(2)}U，低于当前权益 ${(RISK_POLICY.minimumTp2NetProfitRate * 100).toFixed(2)}% 门槛 ${minimumNetTp2Usdt.toFixed(2)}U`, {
      markPrice,
      accountEquityUsdt,
      minimumNetTp2Usdt,
      riskBudgetUsdt,
      projectedStopLossUsdt,
      targetNotionalUsdt,
      contractMultiplier: multiplier,
      contracts,
      signedContracts: trade.side === "LONG" ? contracts : -contracts,
      actualNotionalUsdt,
      requiredMarginUsdt,
      expectedGrossTp2Usdt,
      estimatedRoundTripCostUsdt,
      effectiveRoundTripCostBps,
      expectedNetTp2Usdt,
      worstCaseNetTp2Usdt,
      marketOrderSlipRatio: slip.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""),
      stopLossPrice,
      takeProfitPrice,
    });
  }
  return {
    passed: true,
    reason: null,
    markPrice,
    accountEquityUsdt,
    minimumNetTp2Usdt,
    riskBudgetUsdt,
    projectedStopLossUsdt,
    targetNotionalUsdt,
    contractMultiplier: multiplier,
    contracts,
    signedContracts: trade.side === "LONG" ? contracts : -contracts,
    actualNotionalUsdt,
    requiredMarginUsdt,
    expectedGrossTp2Usdt,
    estimatedRoundTripCostUsdt,
    effectiveRoundTripCostBps,
    expectedNetTp2Usdt,
    worstCaseNetTp2Usdt,
    marketOrderSlipRatio: slip.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""),
    stopLossPrice,
    takeProfitPrice,
  };
}

export function projectedNetTp2Usdt(input: {
  side: "LONG" | "SHORT";
  entryPrice: number;
  takeProfitPrice: number;
  contracts: number;
  contractMultiplier: number;
  roundTripCostBps: number;
  exitSlippageRatio?: number;
}) {
  const exitSlippageRatio = Math.max(0, input.exitSlippageRatio ?? 0);
  const conservativeExitPrice = input.side === "LONG"
    ? input.takeProfitPrice * (1 - exitSlippageRatio)
    : input.takeProfitPrice * (1 + exitSlippageRatio);
  // Charging the round-trip rate against the larger side's notional is a
  // conservative upper bound for entry plus exit taker fees.
  const feeNotional = Math.max(0, input.contracts) * Math.max(0, input.contractMultiplier)
    * Math.max(0, input.entryPrice, conservativeExitPrice);
  const gross = input.side === "LONG"
    ? input.contracts * input.contractMultiplier * (conservativeExitPrice - input.entryPrice)
    : input.contracts * input.contractMultiplier * (input.entryPrice - conservativeExitPrice);
  return gross - feeNotional * Math.max(0, input.roundTripCostBps) / 10_000;
}

export function liveAccountRiskLockReason(input: {
  dailyRealizedPnlUsdt: number;
  /** @deprecated Ignored: daily pause is equity-scaled. */
  dailyPauseUsdt?: number;
  accountEquityUsdt: number;
  accountEquityPeakUsdt: number;
  /** @deprecated Ignored: drawdown is peak-equity-scaled. */
  maxDrawdownUsdt?: number;
}) {
  const dailyPauseUsdt = dailyLossPauseUsdt(input.accountEquityUsdt, input.dailyRealizedPnlUsdt);
  if (dailyPauseUsdt > 0 && input.dailyRealizedPnlUsdt <= -dailyPauseUsdt) {
    return `Gate 当日已实现盈亏 ${input.dailyRealizedPnlUsdt.toFixed(2)}U，触及当日参考权益 3% 暂停线 ${dailyPauseUsdt.toFixed(2)}U`;
  }
  const drawdownUsdt = Math.max(0, input.accountEquityPeakUsdt - input.accountEquityUsdt);
  const maxDrawdownUsdt = peakDrawdownLimitUsdt(input.accountEquityPeakUsdt);
  if (maxDrawdownUsdt > 0 && drawdownUsdt >= maxDrawdownUsdt) {
    return `Gate 权益较实盘峰值回撤 ${drawdownUsdt.toFixed(2)}U，触及峰值权益 10% 上限 ${maxDrawdownUsdt.toFixed(2)}U`;
  }
  return null;
}

export function protectionTriggerRules(side: "LONG" | "SHORT") {
  return side === "LONG" ? { takeProfit: 1, stopLoss: 2 } : { takeProfit: 2, stopLoss: 1 };
}

function timestampSeconds(value: number | null | undefined) {
  if (!value || !Number.isFinite(value)) return null;
  return value > 10_000_000_000 ? value / 1_000 : value;
}

export function attributablePositionCloses(records: GatePositionClose[], order: {
  symbol: string;
  side: "LONG" | "SHORT";
  createdAt: number;
  submittedAt?: number | null;
  closedAt?: number | null;
}) {
  const firstOpenStart = order.createdAt / 1_000 - 10;
  const firstOpenEnd = (order.submittedAt ?? order.createdAt) / 1_000 + 30;
  // Keep a small exchange-indexing grace period without allowing a later
  // same-symbol lifecycle to leak into this order's realized PnL.
  const closeEnd = (order.closedAt ?? Date.now()) / 1_000 + 15;
  const expectedSide = order.side === "LONG" ? "long" : "short";
  return records.filter((record) => {
    if (record.contract !== order.symbol || record.side && record.side !== expectedSide) return false;
    const closeTime = timestampSeconds(record.time);
    if (closeTime != null && (closeTime < firstOpenStart || closeTime > closeEnd)) return false;
    const firstOpenTime = timestampSeconds(record.first_open_time);
    if (firstOpenTime != null && (firstOpenTime < firstOpenStart || firstOpenTime > firstOpenEnd)) return false;
    return firstOpenTime != null || closeTime != null;
  });
}