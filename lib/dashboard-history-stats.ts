import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { tradeCases } from "../db/schema";
import { calculateContractV2HistoryStats } from "./dashboard-history-calculator";

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
