import type { DirectMarketRiskState } from "./direct-market-types.ts";

export type DirectMarketResult = {
  independentEventKey: string;
  resultR: number;
};

export type DirectMarketRiskDecision = {
  state: DirectMarketRiskState;
  riskRate: number;
  sampleCount: number;
  profitFactor: number | null;
  expectancyR: number;
  drawdownR: number;
  reason: string;
};

function uniqueEvents(rows: DirectMarketResult[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.independentEventKey)) return false;
    seen.add(row.independentEventKey);
    return true;
  });
}

function maximumDrawdownR(rows: DirectMarketResult[]) {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const row of [...rows].reverse()) {
    equity += row.resultR;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

export function evaluateDirectMarketRisk(rows: DirectMarketResult[]): DirectMarketRiskDecision {
  const events = uniqueEvents(rows);
  const sampleCount = events.length;
  const grossProfit = events.reduce((sum, row) => sum + Math.max(0, row.resultR), 0);
  const grossLoss = Math.abs(events.reduce((sum, row) => sum + Math.min(0, row.resultR), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : null;
  const expectancyR = sampleCount ? events.reduce((sum, row) => sum + row.resultR, 0) / sampleCount : 0;
  const drawdownR = maximumDrawdownR(events);
  const last8 = events.slice(0, 8);
  const last12 = events.slice(0, 12);
  const last20 = events.slice(0, 20);
  const average = (items: DirectMarketResult[]) => items.length ? items.reduce((sum, row) => sum + row.resultR, 0) / items.length : 0;
  const pf = (items: DirectMarketResult[]) => {
    const win = items.reduce((sum, row) => sum + Math.max(0, row.resultR), 0);
    const loss = Math.abs(items.reduce((sum, row) => sum + Math.min(0, row.resultR), 0));
    return loss > 0 ? win / loss : win > 0 ? 99 : null;
  };
  let state: DirectMarketRiskState;
  if (drawdownR >= 8 || (last20.length >= 20 && (average(last20) <= -0.35 || (pf(last20) ?? 99) < 0.7))) state = "PAUSED";
  else if (drawdownR >= 6 || (last12.length >= 12 && (average(last12) <= -0.25 || (pf(last12) ?? 99) < 0.8))) state = "DEFENSIVE";
  else if (drawdownR >= 4 || (last8.length >= 8 && (average(last8) < 0 || (pf(last8) ?? 99) < 1))) state = "CAUTION";
  else if (sampleCount < 12) state = "CALIBRATING";
  else if (sampleCount < 30 || expectancyR <= 0 || (profitFactor ?? 0) < 1.2) state = "VALIDATING";
  else state = "NORMAL";
  // The simulation learns by improving its entry/exit decision, not by making
  // early or losing-stage positions too small to produce useful evidence.
  // PAUSED remains a hard safety stop; every active state uses the same normal
  // per-trade risk and the sizing engine still enforces portfolio, liquidity,
  // volatility, data-quality and liquidation-distance caps.
  const riskRate = state === "PAUSED" ? 0 : 0.035;
  return {
    state,
    riskRate,
    sampleCount,
    profitFactor,
    expectancyR,
    drawdownR,
    reason: `${sampleCount} 个独立事件 · 期望 ${expectancyR.toFixed(2)}R · PF ${profitFactor == null ? "--" : profitFactor >= 99 ? "∞" : profitFactor.toFixed(2)} · 回撤 ${drawdownR.toFixed(2)}R`,
  };
}

/** Risk stages change admission quality, never the accepted trade's 3.5% size. */
export function directMarketRiskAdmission(input: {
  state: DirectMarketRiskState;
  confidence: number;
  historical?: boolean;
  netEdgeR: number;
  location: "TOP" | "MIDDLE" | "BOTTOM" | "BREAKOUT" | "BREAKDOWN";
}) {
  if (input.state === "PAUSED") return { allowed: false, reason: "即时风险保护已暂停新开仓" };
  const minimumConfidence = input.historical
    ? input.state === "DEFENSIVE" ? 72 : input.state === "CAUTION" ? 65 : 58
    : input.state === "DEFENSIVE" ? 82 : input.state === "CAUTION" ? 76 : 70;
  const minimumEdgeR = input.historical
    ? input.state === "DEFENSIVE" ? 0.25 : input.state === "CAUTION" ? 0.12 : 0.05
    : input.state === "DEFENSIVE" ? 0.9 : input.state === "CAUTION" ? 0.7 : 0.55;
  const locationAllowed = input.historical || !["CAUTION", "DEFENSIVE"].includes(input.state) || input.location !== "MIDDLE";
  const allowed = input.confidence >= minimumConfidence && input.netEdgeR >= minimumEdgeR && locationAllowed;
  return {
    allowed,
    reason: allowed
      ? `${input.state} 准入通过：把握 ${input.confidence}，净优势 ${input.netEdgeR.toFixed(2)}R`
      : `${input.state} 要求把握≥${minimumConfidence}、净优势≥${minimumEdgeR.toFixed(2)}R${locationAllowed ? "" : "且不能位于区间中部"}`,
  };
}
