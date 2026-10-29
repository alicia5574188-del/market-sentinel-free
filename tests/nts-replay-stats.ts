/** 回放统计（测试辅助，不是测试）：进场频率按老挝自然日（UTC+7）分布、触发类型、补仓、出场原因。只看流程，不评价盈亏。 */
import { readAll } from "./nts-fixtures.ts";
import { runSim } from "./nts-sim.ts";
import { loadKlines } from "./nts-klines.ts";

export async function replayStats(config?: Record<string, unknown>) {
  const { series, first15, last15 } = loadKlines();
  const startMs = (first15 + 140 * 900) * 1000, endMs = (last15 + 900) * 1000;
  const r = await runSim({ series, startMs, endMs, stepMs: 60_000, config });
  const lines = await readAll(r.host.logStream()), recs = lines.filter(l => l.id) as Record<string, unknown>[];
  const laosDay = (t: number) => new Date(t + 7 * 3_600_000).toISOString().slice(0, 10);
  const days: Record<string, number> = {};
  for (let t = startMs; t < endMs; t += 86_400_000) days[laosDay(t)] = 0;
  const count = (xs: string[]) => xs.reduce<Record<string, number>>((a, x) => (a[x] = (a[x] ?? 0) + 1, a), {});
  const entries = recs.filter(l => l.k === "ENTRY"), exits = recs.filter(l => l.k === "EXIT"), adds = recs.filter(l => l.k === "ADD");
  for (const e of entries) days[laosDay(e.t as number)] = (days[laosDay(e.t as number)] ?? 0) + 1;
  const plan = (e: Record<string, unknown>) => ((e.d as Record<string, unknown>).plan ?? {}) as Record<string, unknown>;
  const perDay = Object.values(days), hist = count(perDay.map(String));
  return {
    r, recs, entries, exits, adds, hours: (endMs - startMs) / 3_600_000, days: perDay.length, perDayMap: days,
    perDayHist: hist, meanPerDay: entries.length / perDay.length,
    trigger: count(entries.map(e => String(plan(e).trigger))), neutral: entries.filter(e => plan(e).neutral === true).length,
    targetMode: count(entries.map(e => String(plan(e).targetMode))), sym: count(entries.map(e => String(e.sym))),
    side: count(entries.map(e => String((e.d as Record<string, unknown>).side))),
    exitReason: count(exits.map(e => String((e.d as Record<string, unknown>).code ?? (e.d as Record<string, unknown>).reason))),
  };
}
