export const RISK_POLICY = {
  singleTradeLossRate: 0.01,
  minimumTp2NetProfitRate: 0.015,
  maxMarginAllocationRate: 0.20,
  dailyRealizedLossPauseRate: 0.03,
  peakDrawdownRate: 0.10,
  maxLiveOpenPositions: 3,
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

export function peakDrawdownLimitUsdt(accountEquityPeakUsdt: number) {
  return equityScaledUsdt(accountEquityPeakUsdt, RISK_POLICY.peakDrawdownRate);
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
