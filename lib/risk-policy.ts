export const RISK_POLICY = {
  singleTradeLossRate: 0.01,
  // Strategy 2.0 deliberately explores with only a fraction of the 1% base
  // risk. The old 1.5%-of-equity TP2 gate made those small positions
  // impossible to execute live even when their R/R was good. Keep an economic
  // floor, but scale it to 0.25% of equity so exploration can produce real
  // samples without raising the hard account-risk ceiling.
  minimumTp2NetProfitRate: 0.0025,
  maxMarginAllocationRate: 0.20,
  dailyRealizedLossPauseRate: 0.03,
  // This 10% limit is enforced against Market Sentinel's realized live-trading
  // equity curve, not against raw Gate account equity. Raw equity changes when
  // the owner transfers USDT between futures and spot and must not be treated
  // as trading losses.
  peakDrawdownRate: 0.10,
  maxLiveOpenPositions: 3,
  maxSameSideLivePositions: 2,
} as const;

// `live-trading-engine.ts` historically imports `singleTradeRiskBudgetUsdt`
// directly during crash/restart post-fill recovery. HTE 3.1 now owns Gate live
// entry, so that compatibility export must reflect the HTE normal 4% risk
// target. Legacy contract_v2 code must use the explicitly named legacy helper
// below and must never regain authority over HTE 3.1 live recovery.
const HTE31_LIVE_RECOVERY_RISK_RATE = 0.04;

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

/** HTE 3.1 Gate live compatibility helper used by post-fill recovery. */
export function singleTradeRiskBudgetUsdt(equityUsdt: number) {
  return equityScaledUsdt(equityUsdt, HTE31_LIVE_RECOVERY_RISK_RATE);
}

/** Retired contract_v2 exploration policy; never use for HTE 3.1 live entry/recovery. */
export function legacySingleTradeRiskBudgetUsdt(equityUsdt: number) {
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
