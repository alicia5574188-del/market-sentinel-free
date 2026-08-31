import { evaluateHte31PerformanceCell, type Hte31PerformanceGate, type Hte31PerformanceSample } from "./hte31-performance-gate.ts";

// First successful production build of Resonance v1. Older trades remain in the
// historical ledger but must not decide whether the new policy is allowed to
// collect fresh paper samples.
export const RESONANCE_V1_STARTED_AT = Date.parse("2026-08-31T13:24:17.000Z");
export const RESONANCE_REVALIDATION_MS = 12 * 60 * 60_000;

export type ResonanceTradeSample = {
  entryAt: number;
  exitAt: number | null;
  traderId: string;
  assetRegime: string;
  side: "LONG" | "SHORT";
  netPnlUsdt: number | null;
  riskBudgetUsdt: number;
  exitCode: string | null;
};

export type ResonanceCellGate = Hte31PerformanceGate & {
  sampleCount: number;
  retryAfter: number | null;
  revalidating: boolean;
};

export function isCurrentResonanceTrade(row: Pick<ResonanceTradeSample, "entryAt">) {
  return row.entryAt >= RESONANCE_V1_STARTED_AT;
}

function isFailureLoss(row: Pick<ResonanceTradeSample, "netPnlUsdt" | "exitCode">) {
  return (row.netPnlUsdt ?? 0) < 0 && row.exitCode !== "breakeven";
}

export function resonanceCellRows(
  rows: ResonanceTradeSample[],
  traderId: string,
  assetRegime: string,
  side: "LONG" | "SHORT",
) {
  return rows.filter((row) => isCurrentResonanceTrade(row)
    && row.traderId === traderId
    && row.assetRegime === assetRegime
    && row.side === side
    && row.exitAt != null);
}

export function buildResonancePerformanceSample(rows: ResonanceTradeSample[]): Hte31PerformanceSample | null {
  if (!rows.length) return null;
  const resultsR = rows.map((row) => row.riskBudgetUsdt > 0 ? (row.netPnlUsdt ?? 0) / row.riskBudgetUsdt : 0);
  const grossProfitR = resultsR.reduce((sum, value) => sum + Math.max(0, value), 0);
  const grossLossR = resultsR.reduce((sum, value) => sum + Math.abs(Math.min(0, value)), 0);
  return {
    sampleCount: rows.length,
    wins: rows.filter((row) => (row.netPnlUsdt ?? 0) > 0).length,
    losses: rows.filter(isFailureLoss).length,
    expectancyR: resultsR.reduce((sum, value) => sum + value, 0) / rows.length,
    grossProfitR,
    grossLossR,
  };
}

/**
 * Negative cells are still protected, but paper learning cannot deadlock.
 * After a bounded pause the same current-version cell is allowed to collect a
 * fresh sample again. Old HTE data never starts or extends this pause.
 */
export function evaluateResonanceCellGate(
  allRows: ResonanceTradeSample[],
  traderId: string,
  assetRegime: string,
  side: "LONG" | "SHORT",
  now = Date.now(),
): ResonanceCellGate {
  const rows = resonanceCellRows(allRows, traderId, assetRegime, side);
  const sample = buildResonancePerformanceSample(rows);
  const base = evaluateHte31PerformanceCell(sample);
  if (base.state === "ACTIVE") {
    return { ...base, sampleCount: rows.length, retryAfter: null, revalidating: false };
  }

  const latestExit = rows[0]?.exitAt ?? null;
  const retryAfter = latestExit == null ? null : latestExit + RESONANCE_REVALIDATION_MS;
  if (retryAfter != null && retryAfter > now) {
    return {
      ...base,
      sampleCount: rows.length,
      retryAfter,
      revalidating: false,
      reason: `${base.reason} · Resonance 当前版本暂停至 ${new Date(retryAfter).toLocaleString("zh-CN")} 后自动重考`,
    };
  }

  return {
    state: "ACTIVE",
    profitFactor: base.profitFactor,
    sampleCount: rows.length,
    retryAfter: null,
    revalidating: true,
    reason: `${base.reason} · 暂停期已结束，允许 Resonance 当前版本重新取样`,
  };
}
