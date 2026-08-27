import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { tradeCases } from "../db/schema";

export type ContractV2HistoryRow = {
  confidence: number;
  grossMovePct: number | null;
  estimatedCostPct: number | null;
  netMovePct: number | null;
  netPnlUsdt: number | null;
  mfePct: number | null;
  maePct: number | null;
  holdMinutes: number | null;
  exitCode: string | null;
};

export function calculateContractV2HistoryStats(rows: ContractV2HistoryRow[], openCount = 0) {
  const closed = rows.filter((row) => row.netMovePct != null);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const row of closed) {
    equity += row.netMovePct ?? 0;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }

  const calibration = Array.from({ length: 5 }, (_, bucket) => {
    const low = 50 + bucket * 10;
    const high = low + 9;
    const bucketRows = closed.filter((row) => row.confidence >= low && row.confidence <= high);
    return {
      range: `${low}–${high}`,
      count: bucketRows.length,
      predicted: bucketRows.length ? bucketRows.reduce((sum, row) => sum + row.confidence, 0) / bucketRows.length : null,
      realized: bucketRows.length ? bucketRows.filter((row) => (row.netMovePct ?? 0) > 0).length / bucketRows.length * 100 : null,
    };
  });

  const wins = closed.filter((row) => (row.netMovePct ?? 0) > 0).length;
  return {
    emitted: closed.length + openCount,
    open: openCount,
    closed: closed.length,
    wins,
    winRate: closed.length ? wins / closed.length * 100 : null,
    averageGrossPct: closed.length ? closed.reduce((sum, row) => sum + (row.grossMovePct ?? 0), 0) / closed.length : null,
    averageCostPct: closed.length ? closed.reduce((sum, row) => sum + (row.estimatedCostPct ?? 0), 0) / closed.length : null,
    averageNetPct: closed.length ? closed.reduce((sum, row) => sum + (row.netMovePct ?? 0), 0) / closed.length : null,
    totalNetPnlUsdt: closed.reduce((sum, row) => sum + (row.netPnlUsdt ?? 0), 0),
    averageMfePct: closed.length ? closed.reduce((sum, row) => sum + (row.mfePct ?? 0), 0) / closed.length : null,
    averageMaePct: closed.length ? closed.reduce((sum, row) => sum + (row.maePct ?? 0), 0) / closed.length : null,
    averageHoldMinutes: closed.length ? closed.reduce((sum, row) => sum + (row.holdMinutes ?? 0), 0) / closed.length : null,
    targetExits: closed.filter((row) => row.exitCode === "take_profit").length,
    stopExits: closed.filter((row) => row.exitCode === "stop_loss" || row.exitCode === "breakeven").length,
    brierScore: closed.length ? closed.reduce((sum, row) => sum + (row.confidence / 100 - ((row.netMovePct ?? 0) > 0 ? 1 : 0)) ** 2, 0) / closed.length : null,
    maxDrawdownPct: maxDrawdown,
    calibration,
    uncalibrated: closed.length < 50,
  };
}

export async function getContractV2HistoryStats() {
  const db = getDb();
  const [closedRows, openCountRows] = await Promise.all([
    db.select({
      confidence: tradeCases.confidence,
      grossMovePct: tradeCases.grossMovePct,
      estimatedCostPct: tradeCases.estimatedCostPct,
      netMovePct: tradeCases.netMovePct,
      netPnlUsdt: tradeCases.netPnlUsdt,
      mfePct: tradeCases.mfePct,
      maePct: tradeCases.maePct,
      holdMinutes: tradeCases.holdMinutes,
      exitCode: tradeCases.exitCode,
    }).from(tradeCases).where(and(
      eq(tradeCases.status, "closed"),
      eq(tradeCases.simulationModel, "contract_v2"),
    )).orderBy(asc(tradeCases.entryAt)),
    db.select({ count: sql<number>`count(*)` }).from(tradeCases).where(and(
      eq(tradeCases.status, "holding"),
      eq(tradeCases.simulationModel, "contract_v2"),
    )),
  ]);

  return calculateContractV2HistoryStats(closedRows, Number(openCountRows[0]?.count ?? 0));
}
