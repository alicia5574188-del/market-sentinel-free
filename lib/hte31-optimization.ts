import { desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { hte31Trades } from "../db/hte31-schema";
import { getHte31Diagnostics } from "./hte31-diagnostics";
import { buildHte31OptimizationAnalysis } from "./hte31-optimization-core";

export { buildHte31OptimizationAnalysis, summarizeHte31TradeGroup } from "./hte31-optimization-core";
export type { Hte31OptimizationTrade } from "./hte31-optimization-core";

export async function getHte31OptimizationReport(now = Date.now()) {
  const [rows, diagnostics] = await Promise.all([
    getDb().select().from(hte31Trades).where(eq(hte31Trades.status, "closed")).orderBy(desc(hte31Trades.exitAt)).limit(500),
    getHte31Diagnostics(now),
  ]);
  const analysis = buildHte31OptimizationAnalysis(rows);
  const frequency = Object.fromEntries(Object.entries(diagnostics.windows.h6.traders).map(([traderId, row]) => [traderId, {
    evaluations: row.evaluations,
    ready: row.ready,
    nearReady: row.nearReady,
    readyRate: row.readyRate,
    topFailures: row.topFailures,
  }]));
  const shadow = Object.fromEntries(Object.entries(diagnostics.shadow).map(([traderId, row]) => [traderId, {
    completed: row.completed,
    pending: row.pending,
    expectancyR: row.expectancyR,
    profitFactor: row.profitFactor,
    dominantMissingCondition: row.dominantMissingCondition,
    qualifiesForCalibration: row.qualifiesForCalibration,
  }]));
  return {
    version: "hte31-optimization-v1",
    observedAt: now,
    ...analysis,
    frequency6h: frequency,
    shadow,
    policy: {
      automaticThresholdChanges: false,
      principle: "只暂停有独立负期望证据的组合；Shadow 达到样本门槛前不放宽正式条件；不靠全局降频制造收益改善。",
    },
  };
}
