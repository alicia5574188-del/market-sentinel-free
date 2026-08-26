import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { tradeCases } from "../db/schema";
import {
  strategy2ExperienceKey,
  type Strategy2Experience,
  type Strategy2ExperienceBook,
} from "./sentinel-v2-strategy.ts";

function parseStrategy2Regime(value: string | null | undefined) {
  if (!value?.startsWith("S2|")) return null;
  const parts = value.split("|");
  if (parts.length < 4) return null;
  const playbook = parts[1];
  const globalRegime = parts.find((part) => part.startsWith("global:"))?.slice(7) ?? "unknown";
  const assetRegime = parts.find((part) => part.startsWith("asset:"))?.slice(6) ?? "unknown";
  return { playbook, globalRegime, assetRegime };
}

type Accumulator = {
  sampleCount: number;
  wins: number;
  losses: number;
  totalR: number;
  totalNetPct: number;
};

function add(target: Record<string, Accumulator>, key: string, r: number, netPct: number) {
  const row = target[key] ?? { sampleCount: 0, wins: 0, losses: 0, totalR: 0, totalNetPct: 0 };
  row.sampleCount += 1;
  row.wins += netPct > 0 ? 1 : 0;
  row.losses += netPct < 0 ? 1 : 0;
  row.totalR += r;
  row.totalNetPct += netPct;
  target[key] = row;
}

function present(row: Accumulator): Strategy2Experience {
  return {
    sampleCount: row.sampleCount,
    wins: row.wins,
    losses: row.losses,
    winRate: row.sampleCount ? row.wins / row.sampleCount : null,
    expectancyR: row.sampleCount ? row.totalR / row.sampleCount : null,
    averageNetPct: row.sampleCount ? row.totalNetPct / row.sampleCount : null,
  };
}

/**
 * Completed Strategy 2.0 trades are the highest-weight learning source.
 * Exact Regime × Playbook × Asset-Regime × Direction cells are kept together
 * with broader fallbacks so sparse new environments can still explore safely.
 */
export async function getStrategy2ExperienceBook(limit = 1500): Promise<Strategy2ExperienceBook> {
  const rows = await getDb().select({
    regime: tradeCases.regime,
    side: tradeCases.side,
    netMovePct: tradeCases.netMovePct,
    plannedRiskPct: tradeCases.plannedRiskPct,
  }).from(tradeCases).where(and(
    eq(tradeCases.status, "closed"),
    eq(tradeCases.simulationModel, "contract_v2"),
  )).orderBy(desc(tradeCases.exitAt)).limit(Math.max(50, Math.min(5000, limit)));

  const accumulators: Record<string, Accumulator> = {};
  for (const row of rows) {
    const parsed = parseStrategy2Regime(row.regime);
    if (!parsed || (row.side !== "LONG" && row.side !== "SHORT")) continue;
    const netPct = row.netMovePct ?? 0;
    const plannedRiskPct = Math.max(Math.abs(row.plannedRiskPct ?? 0), 0.05);
    const r = netPct / plannedRiskPct;
    add(accumulators, strategy2ExperienceKey(parsed.playbook, parsed.globalRegime, parsed.assetRegime, row.side), r, netPct);
    add(accumulators, strategy2ExperienceKey(parsed.playbook, "*", parsed.assetRegime, row.side), r, netPct);
    add(accumulators, strategy2ExperienceKey(parsed.playbook, "*", "*", row.side), r, netPct);
  }

  return Object.fromEntries(Object.entries(accumulators).map(([key, value]) => [key, present(value)]));
}
