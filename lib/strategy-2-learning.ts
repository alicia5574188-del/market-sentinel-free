import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { tradeCases } from "../db/schema";
import {
  strategy2ExperienceKey,
  type Strategy2Experience,
  type Strategy2ExperienceBook,
} from "./sentinel-v2-strategy.ts";

export type Strategy2LearningStage = "exploration" | "calibrating" | "validated" | "negative_edge";

export type Strategy2LearningCell = Strategy2Experience & {
  key: string;
  playbook: string;
  globalRegime: string;
  assetRegime: string;
  side: "LONG" | "SHORT";
  stage: Strategy2LearningStage;
  riskAction: string;
};

export type Strategy2LearningTrade = {
  tradeId: string;
  exitAt: number | null;
  playbook: string;
  globalRegime: string;
  assetRegime: string;
  side: "LONG" | "SHORT";
  netPct: number;
  resultR: number;
  cellSamples: number;
  cellExpectancyR: number | null;
  stage: Strategy2LearningStage;
  riskAction: string;
};

export type Strategy2LearningDashboard = {
  totalSamples: number;
  playbookCoverage: number;
  exactCellCount: number;
  positiveCells: number;
  negativeCells: number;
  cells: Strategy2LearningCell[];
  recentTrades: Strategy2LearningTrade[];
};

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

type ClosedStrategy2Row = {
  id: string;
  exitAt: number | null;
  regime: string | null;
  side: string;
  netMovePct: number | null;
  plannedRiskPct: number | null;
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

function learningStage(sampleCount: number, expectancyR: number | null): Strategy2LearningStage {
  if (sampleCount >= 15 && (expectancyR ?? 0) <= -0.30) return "negative_edge";
  if (sampleCount < 5) return "exploration";
  if (sampleCount < 15) return "calibrating";
  return "validated";
}

function riskAction(stage: Strategy2LearningStage, expectancyR: number | null) {
  if (stage === "negative_edge") return "停止该环境组合，等待新证据";
  if (stage === "exploration") return "小风险探索，不因少量输赢过度调整";
  if ((expectancyR ?? 0) < -0.10) return "历史优势偏弱，降低风险倍率";
  if (stage === "validated" && (expectancyR ?? 0) >= 0.20) return "历史优势已验证，可保持正常风险";
  return "继续校准，按实时机会质量决定风险";
}

async function loadClosedStrategy2Rows(limit: number): Promise<ClosedStrategy2Row[]> {
  return getDb().select({
    id: tradeCases.id,
    exitAt: tradeCases.exitAt,
    regime: tradeCases.regime,
    side: tradeCases.side,
    netMovePct: tradeCases.netMovePct,
    plannedRiskPct: tradeCases.plannedRiskPct,
  }).from(tradeCases).where(and(
    eq(tradeCases.status, "closed"),
    eq(tradeCases.simulationModel, "contract_v2"),
  )).orderBy(desc(tradeCases.exitAt)).limit(Math.max(50, Math.min(5000, limit)));
}

function rowResult(row: ClosedStrategy2Row) {
  const netPct = row.netMovePct ?? 0;
  const plannedRiskPct = Math.max(Math.abs(row.plannedRiskPct ?? 0), 0.05);
  return { netPct, r: netPct / plannedRiskPct };
}

/**
 * Completed Strategy 2.0 trades are the highest-weight learning source.
 * Exact Regime × Playbook × Asset-Regime × Direction cells are kept together
 * with broader fallbacks so sparse new environments can still explore safely.
 */
export async function getStrategy2ExperienceBook(limit = 1500): Promise<Strategy2ExperienceBook> {
  const rows = await loadClosedStrategy2Rows(limit);
  const accumulators: Record<string, Accumulator> = {};
  for (const row of rows) {
    const parsed = parseStrategy2Regime(row.regime);
    if (!parsed || (row.side !== "LONG" && row.side !== "SHORT")) continue;
    const { netPct, r } = rowResult(row);
    add(accumulators, strategy2ExperienceKey(parsed.playbook, parsed.globalRegime, parsed.assetRegime, row.side), r, netPct);
    add(accumulators, strategy2ExperienceKey(parsed.playbook, "*", parsed.assetRegime, row.side), r, netPct);
    add(accumulators, strategy2ExperienceKey(parsed.playbook, "*", "*", row.side), r, netPct);
  }
  return Object.fromEntries(Object.entries(accumulators).map(([key, value]) => [key, present(value)]));
}

/**
 * User-facing Strategy 2.0 learning view. Only exact cells are shown so the UI
 * never mixes unrelated playbooks into the old symbol+direction memory model.
 */
export async function getStrategy2LearningDashboard(limit = 1500): Promise<Strategy2LearningDashboard> {
  const rows = await loadClosedStrategy2Rows(limit);
  const exact: Record<string, { meta: { playbook: string; globalRegime: string; assetRegime: string; side: "LONG" | "SHORT" }; acc: Accumulator }> = {};
  const parsedRows: { row: ClosedStrategy2Row; playbook: string; globalRegime: string; assetRegime: string; side: "LONG" | "SHORT"; netPct: number; r: number }[] = [];

  for (const row of rows) {
    const parsed = parseStrategy2Regime(row.regime);
    if (!parsed || (row.side !== "LONG" && row.side !== "SHORT")) continue;
    const side = row.side;
    const { netPct, r } = rowResult(row);
    const key = strategy2ExperienceKey(parsed.playbook, parsed.globalRegime, parsed.assetRegime, side);
    const existing = exact[key]?.acc ?? { sampleCount: 0, wins: 0, losses: 0, totalR: 0, totalNetPct: 0 };
    existing.sampleCount += 1;
    existing.wins += netPct > 0 ? 1 : 0;
    existing.losses += netPct < 0 ? 1 : 0;
    existing.totalR += r;
    existing.totalNetPct += netPct;
    exact[key] = { meta: { playbook: parsed.playbook, globalRegime: parsed.globalRegime, assetRegime: parsed.assetRegime, side }, acc: existing };
    parsedRows.push({ row, ...parsed, side, netPct, r });
  }

  const cells = Object.entries(exact).map(([key, value]) => {
    const stats = present(value.acc);
    const stage = learningStage(stats.sampleCount, stats.expectancyR);
    return {
      key,
      ...value.meta,
      ...stats,
      stage,
      riskAction: riskAction(stage, stats.expectancyR),
    } satisfies Strategy2LearningCell;
  }).sort((a, b) => b.sampleCount - a.sampleCount || (b.expectancyR ?? -99) - (a.expectancyR ?? -99));

  const cellByKey = new Map(cells.map((cell) => [cell.key, cell]));
  const recentTrades = parsedRows.slice(0, 12).map((item) => {
    const key = strategy2ExperienceKey(item.playbook, item.globalRegime, item.assetRegime, item.side);
    const cell = cellByKey.get(key)!;
    return {
      tradeId: item.row.id,
      exitAt: item.row.exitAt,
      playbook: item.playbook,
      globalRegime: item.globalRegime,
      assetRegime: item.assetRegime,
      side: item.side,
      netPct: item.netPct,
      resultR: item.r,
      cellSamples: cell.sampleCount,
      cellExpectancyR: cell.expectancyR,
      stage: cell.stage,
      riskAction: cell.riskAction,
    } satisfies Strategy2LearningTrade;
  });

  return {
    totalSamples: parsedRows.length,
    playbookCoverage: new Set(parsedRows.map((item) => item.playbook)).size,
    exactCellCount: cells.length,
    positiveCells: cells.filter((cell) => cell.sampleCount >= 6 && (cell.expectancyR ?? 0) > 0).length,
    negativeCells: cells.filter((cell) => cell.stage === "negative_edge").length,
    cells: cells.slice(0, 24),
    recentTrades,
  };
}
