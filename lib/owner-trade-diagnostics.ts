import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { tradeCases } from "../db/schema";
import {
  hte31Learning,
  hte31PostExitObservations,
  hte31SimulationEpochs,
  hte31TradeCharts,
  hte31Trades,
} from "../db/hte31-schema";
import { buildHte31Counterfactual } from "./hte31-counterfactual";
import { getSettings } from "./settings-repository";
import type { Hte31Candle } from "./hte31-types";

export type OwnerTradeDiagnosticSource = "hte31" | "legacy" | "all";

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function candleTime(candle: Hte31Candle) {
  return candle.time > 10_000_000_000 ? candle.time : candle.time * 1000;
}

function mergeCandles(...groups: Hte31Candle[][]) {
  const map = new Map<number, Hte31Candle>();
  for (const candle of groups.flat()) map.set(candleTime(candle), candle);
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, candle]) => candle);
}

function epochFor(entryAt: number, epochs: Array<typeof hte31SimulationEpochs.$inferSelect>) {
  let selected: typeof hte31SimulationEpochs.$inferSelect | null = null;
  for (const epoch of epochs) {
    if (epoch.startedAt <= entryAt) selected = epoch;
    else break;
  }
  return selected;
}

function normalizeCurrentTrade(
  row: typeof hte31Trades.$inferSelect,
  epochs: Array<typeof hte31SimulationEpochs.$inferSelect>,
  observations: Array<typeof hte31PostExitObservations.$inferSelect>,
  chart: typeof hte31TradeCharts.$inferSelect | null,
  roundTripCostBps: number,
) {
  const { entryChecksJson, entryMetricsJson, ...trade } = row;
  const chartCandles = chart ? mergeCandles(
    parseJson<Hte31Candle[]>(chart.entryCandlesJson, []),
    parseJson<Hte31Candle[]>(chart.holdingCandlesJson, []),
    parseJson<Hte31Candle[]>(chart.postExitCandlesJson, []),
  ) : [];
  const epoch = epochFor(row.entryAt, epochs);
  return {
    source: "hte31" as const,
    ...trade,
    entryChecks: parseJson<unknown[]>(entryChecksJson, []),
    entryMetrics: parseJson<unknown[]>(entryMetricsJson, []),
    epoch: epoch ? {
      id: epoch.id,
      startedAt: epoch.startedAt,
      startingCapitalUsdt: epoch.startingCapitalUsdt,
    } : null,
    observations,
    chart: chart ? {
      available: true,
      candleCount: chartCandles.length,
      firstCandleAt: chartCandles.length ? candleTime(chartCandles[0]) : null,
      lastCandleAt: chartCandles.length ? candleTime(chartCandles.at(-1)!) : null,
      updatedAt: chart.updatedAt,
    } : { available: false, candleCount: 0, firstCandleAt: null, lastCandleAt: null, updatedAt: null },
    counterfactual: chartCandles.length
      ? buildHte31Counterfactual(row, chartCandles, roundTripCostBps, Date.now())
      : null,
  };
}

function normalizeLegacyTrade(row: typeof tradeCases.$inferSelect) {
  const {
    entryChecksJson,
    exitRulesJson,
    entryEvidenceJson,
    entryCounterEvidenceJson,
    entryMetricsJson,
    entrySnapshotJson: _entrySnapshotJson,
    exitEvidenceJson,
    exitMetricsJson,
    lessonJson,
    ...trade
  } = row;
  return {
    source: "legacy" as const,
    ...trade,
    entryChecks: parseJson<unknown[]>(entryChecksJson, []),
    exitRules: parseJson<unknown[]>(exitRulesJson, []),
    entryEvidence: parseJson<unknown[]>(entryEvidenceJson, []),
    entryCounterEvidence: parseJson<unknown[]>(entryCounterEvidenceJson, []),
    entryMetrics: parseJson<unknown[]>(entryMetricsJson, []),
    exitEvidence: parseJson<unknown[]>(exitEvidenceJson, []),
    exitMetrics: parseJson<unknown[]>(exitMetricsJson, []),
    lesson: parseJson<Record<string, unknown>>(lessonJson, {}),
  };
}

export async function getOwnerTradeHistory(options: {
  source?: OwnerTradeDiagnosticSource;
  limit?: number;
  offset?: number;
} = {}) {
  const source = options.source ?? "all";
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 100)));
  const offset = Math.min(5000, Math.max(0, Math.trunc(options.offset ?? 0)));
  const take = Math.min(5200, offset + limit);
  const db = getDb();
  const settings = await getSettings();

  const [currentCountRow, legacyCountRow, epochs, learning] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(hte31Trades),
    db.select({ count: sql<number>`count(*)` }).from(tradeCases),
    db.select().from(hte31SimulationEpochs).orderBy(asc(hte31SimulationEpochs.startedAt)),
    db.select().from(hte31Learning).orderBy(desc(hte31Learning.updatedAt)).limit(500),
  ]);

  const currentRows = source === "legacy" ? [] : await db.select().from(hte31Trades)
    .orderBy(desc(hte31Trades.entryAt)).limit(take);
  const legacyRows = source === "hte31" ? [] : await db.select().from(tradeCases)
    .orderBy(desc(tradeCases.entryAt)).limit(take);

  const currentIds = currentRows.map((row) => row.id);
  const [observationRows, chartRows] = currentIds.length ? await Promise.all([
    db.select().from(hte31PostExitObservations)
      .where(inArray(hte31PostExitObservations.tradeId, currentIds))
      .orderBy(asc(hte31PostExitObservations.horizonMinutes)),
    db.select().from(hte31TradeCharts)
      .where(inArray(hte31TradeCharts.tradeId, currentIds)),
  ]) : [[], []];

  const observationsByTrade = new Map<string, Array<typeof hte31PostExitObservations.$inferSelect>>();
  for (const row of observationRows) {
    const bucket = observationsByTrade.get(row.tradeId) ?? [];
    bucket.push(row);
    observationsByTrade.set(row.tradeId, bucket);
  }
  const chartsByTrade = new Map(chartRows.map((row) => [row.tradeId, row] as const));

  const current = currentRows.map((row) => normalizeCurrentTrade(
    row,
    epochs,
    observationsByTrade.get(row.id) ?? [],
    chartsByTrade.get(row.id) ?? null,
    settings.roundTripCostBps,
  ));
  const legacy = legacyRows.map(normalizeLegacyTrade);
  const combined = [...current, ...legacy]
    .sort((a, b) => b.entryAt - a.entryAt)
    .slice(offset, offset + limit);

  const currentCount = Number(currentCountRow[0]?.count ?? 0);
  const legacyCount = Number(legacyCountRow[0]?.count ?? 0);
  const total = source === "hte31" ? currentCount : source === "legacy" ? legacyCount : currentCount + legacyCount;
  return {
    version: "owner-trade-diagnostics-v1",
    generatedAt: Date.now(),
    source,
    pagination: {
      limit,
      offset,
      returned: combined.length,
      total,
      nextOffset: offset + combined.length < total ? offset + combined.length : null,
    },
    counts: { hte31: currentCount, legacy: legacyCount, total: currentCount + legacyCount },
    epochs,
    learning,
    trades: combined,
  };
}

export async function getOwnerTradeDiagnostic(tradeId: string) {
  const db = getDb();
  const settings = await getSettings();
  const [current] = await db.select().from(hte31Trades).where(eq(hte31Trades.id, tradeId)).limit(1);
  if (current) {
    const [epochs, observations, chart, learning] = await Promise.all([
      db.select().from(hte31SimulationEpochs).orderBy(asc(hte31SimulationEpochs.startedAt)),
      db.select().from(hte31PostExitObservations)
        .where(eq(hte31PostExitObservations.tradeId, tradeId))
        .orderBy(asc(hte31PostExitObservations.horizonMinutes)),
      db.select().from(hte31TradeCharts).where(eq(hte31TradeCharts.tradeId, tradeId)).limit(1),
      db.select().from(hte31Learning)
        .where(eq(hte31Learning.id, `${current.traderId}|${current.assetRegime}|${current.side}`))
        .limit(1),
    ]);
    const chartRow = chart[0] ?? null;
    const entryCandles = chartRow ? parseJson<Hte31Candle[]>(chartRow.entryCandlesJson, []) : [];
    const holdingCandles = chartRow ? parseJson<Hte31Candle[]>(chartRow.holdingCandlesJson, []) : [];
    const postExitCandles = chartRow ? parseJson<Hte31Candle[]>(chartRow.postExitCandlesJson, []) : [];
    const candles = mergeCandles(entryCandles, holdingCandles, postExitCandles);
    const normalized = normalizeCurrentTrade(current, epochs, observations, chartRow, settings.roundTripCostBps);
    return {
      ...normalized,
      chart: chartRow ? {
        available: true,
        updatedAt: chartRow.updatedAt,
        entryCandles,
        holdingCandles,
        postExitCandles,
        mergedCandles: candles,
      } : null,
      learningCell: learning[0] ?? null,
      counterfactual: candles.length
        ? buildHte31Counterfactual(current, candles, settings.roundTripCostBps, Date.now())
        : null,
    };
  }

  const [legacy] = await db.select().from(tradeCases).where(eq(tradeCases.id, tradeId)).limit(1);
  return legacy ? normalizeLegacyTrade(legacy) : null;
}
