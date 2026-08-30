export const RISK_POLICY = {
  // HTE 3.1 is the production strategy source for both paper and Gate live.
  // Live sizing keeps the same equity-scaled 4% stop-risk target as paper,
  // while Gate execution still independently rechecks actual equity, contract
  // limits, stop distance, slippage, fees, isolated margin and protective exits.
  singleTradeLossRate: 0.04,
  // Paper HTE 3.1 requires at least 5% equity of fee-adjusted TP2 net profit.
  // Use the same economic floor live so a 500U account scales to a 20U stop
  // budget and at least 25U conservative TP2 net instead of reviving micro trades.
  minimumTp2NetProfitRate: 0.05,
  // Two concurrent HTE positions must be able to coexist without one position
  // consuming nearly the entire account. 45% per position leaves a 10% reserve.
  maxMarginAllocationRate: 0.45,
  dailyRealizedLossPauseRate: 0.03,
  // This 10% limit is enforced against Market Sentinel's realized live-trading
  // equity curve, not against raw Gate account equity. Raw equity changes when
  // the owner transfers USDT between futures and spot and must not be treated
  // as trading losses.
  peakDrawdownRate: 0.10,
  maxLiveOpenPositions: 2,
  maxSameSideLivePositions: 2,
} as const;

function positive(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function round(value: number, digits = 8) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function equityScaledUsdt(equityUsdt: number, rate: number) {
  return round(positive(equityUsdt) * Math.max(0, Number.isFinite(rate) ? rate : 0));
}

export function singleTradeRiskBudgetUsdt(equityUsdt: number) {
  return equityScaledUsdt(equityUsdt, RISK_POLICY.singleTradeLossRate);
}

export function minimumTp2NetProfitBudgetUsdt(equityUsdt: number) {
  return equityScaledUsdt(equityUsdt, RISK_POLICY.minimumTp2NetProfitRate);
}

export function maxMarginAllocationUsdt(equityUsdt: number) {
  return equityScaledUsdt(equityUsdt, RISK_POLICY.maxMarginAllocationRate);
}

export function dailyLossPauseUsdt(accountEquityUsdt: number, dailyRealizedPnlUsdt: number) {
  const current = positive(accountEquityUsdt);
  const realizedLoss = Math.min(0, Number.isFinite(dailyRealizedPnlUsdt) ? dailyRealizedPnlUsdt : 0);
  const estimatedStartOfDayEquity = Math.max(current, current - realizedLoss);
  return equityScaledUsdt(estimatedStartOfDayEquity, RISK_POLICY.dailyRealizedLossPauseRate);
}

/** @deprecated Raw Gate-account peak drawdown is intentionally disabled. */
export function peakDrawdownLimitUsdt(_accountEquityPeakUsdt: number) {
  void _accountEquityPeakUsdt;
  return Number.POSITIVE_INFINITY;
}

export function publicRiskPolicy() {
  return {
    singleTradeLossPct: RISK_POLICY.singleTradeLossRate * 100,
    minimumTp2NetProfitPct: RISK_POLICY.minimumTp2NetProfitRate * 100,
    maxMarginAllocationPct: RISK_POLICY.maxMarginAllocationRate * 100,
    dailyRealizedLossPausePct: RISK_POLICY.dailyRealizedLossPauseRate * 100,
    peakDrawdownPct: RISK_POLICY.peakDrawdownRate * 100,
    maxLiveOpenPositions: RISK_POLICY.maxLiveOpenPositions,
    maxSameSideLivePositions: RISK_POLICY.maxSameSideLivePositions,
  };
}
