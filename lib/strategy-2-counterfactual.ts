import { and, count, countDistinct, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "../db";
import { v2Opportunities } from "../db/v2-schema.ts";

export type Strategy2CounterfactualArchiveStats = {
  trackedDecisionCount: number;
  maturedDecisionCount: number;
  uniqueSymbols: number;
  windowHours: number;
  maturityMinutes: number;
  source: "persistent_v2_opportunity_archive";
};

export async function getStrategy2CounterfactualArchiveStats(input: {
  observedAt?: number;
  windowMs?: number;
  maturityMs?: number;
} = {}): Promise<Strategy2CounterfactualArchiveStats> {
  const observedAt = input.observedAt ?? Date.now();
  const windowMs = Math.max(60 * 60_000, input.windowMs ?? 24 * 60 * 60_000);
  const maturityMs = Math.max(15 * 60_000, input.maturityMs ?? 60 * 60_000);
  const cutoff = observedAt - windowMs;
  const maturityCutoff = observedAt - maturityMs;
  const counterfactualStates = ["WATCH", "REJECT"] as const;
  const baseFilter = and(
    gte(v2Opportunities.observedAt, cutoff),
    inArray(v2Opportunities.state, counterfactualStates),
  );
  const matureFilter = and(
    baseFilter,
    lte(v2Opportunities.observedAt, maturityCutoff),
  );

  const [[tracked], [matured]] = await Promise.all([
    getDb().select({
      trackedDecisionCount: count(),
      uniqueSymbols: countDistinct(v2Opportunities.symbol),
    }).from(v2Opportunities).where(baseFilter),
    getDb().select({
      maturedDecisionCount: count(),
    }).from(v2Opportunities).where(matureFilter),
  ]);

  return {
    trackedDecisionCount: Number(tracked?.trackedDecisionCount ?? 0),
    maturedDecisionCount: Number(matured?.maturedDecisionCount ?? 0),
    uniqueSymbols: Number(tracked?.uniqueSymbols ?? 0),
    windowHours: Math.round(windowMs / 60 / 60_000),
    maturityMinutes: Math.round(maturityMs / 60_000),
    source: "persistent_v2_opportunity_archive",
  };
}
