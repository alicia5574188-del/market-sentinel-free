import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { tradeCases } from "../db/schema";
import { buildStrategy2LearningArena } from "./strategy-2-learning-arena-core.ts";

export * from "./strategy-2-learning-arena-core.ts";

export async function getStrategy2LearningArena(limit = 1000) {
  const rows = await getDb().select({
    id: tradeCases.id,
    entryAt: tradeCases.entryAt,
    exitAt: tradeCases.exitAt,
    regime: tradeCases.regime,
    side: tradeCases.side,
    netMovePct: tradeCases.netMovePct,
    plannedRiskPct: tradeCases.plannedRiskPct,
    netPnlUsdt: tradeCases.netPnlUsdt,
    exitCode: tradeCases.exitCode,
    target1HitAt: tradeCases.target1HitAt,
    mfePct: tradeCases.mfePct,
    maePct: tradeCases.maePct,
  }).from(tradeCases).where(and(
    eq(tradeCases.status, "closed"),
    eq(tradeCases.simulationModel, "contract_v2"),
  )).orderBy(desc(tradeCases.exitAt)).limit(Math.max(100, Math.min(2500, limit)));

  return buildStrategy2LearningArena(rows);
}
