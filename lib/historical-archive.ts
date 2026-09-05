import { ANALOG_BAR_MS, cleanAnalogCandles } from "./historical-forecast.ts";
import type { Hte31Candle } from "./hte31-types.ts";

const DAY = 86_400_000;
export const ARCHIVE_BACKFILL_INTERVAL = 10 * 60_000;
export const ARCHIVE_CAP_BYTES = 256 * 1024 * 1024;
export const ARCHIVE_DAILY_WRITES = 3500;
type Packed = [number, number, number, number, number, number];
type KV = { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<unknown> };
type Store = KV & { transaction<T>(callback: (store: KV) => Promise<T>): Promise<T> };
type Gap = { from: number; to: number; nextAt: number };
type Meta = { days: number[]; bars: number; bytes: number; latestAt: number; before: number; nextFetch: number; rotation: number; failures: number; note: string; gaps?: Gap[]; writeDay?: number; writes?: number };
export type ArchiveProgress = { storedBars: number | null; from: number | null; to: number | null; searchedBars: number; nextBackfillAt: number; note: string };
export type ArchiveHistory = { candles: Hte31Candle[]; archive: ArchiveProgress };
const dayOf = (time: number) => Math.floor(time / DAY) * DAY;
const keyOf = (day: number) => `day:${day}`;
const pack = (r: Hte31Candle): Packed => [r.time, r.open, r.high, r.low, r.close, r.volume];
const unpack = (r: Packed): Hte31Candle => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] });

/** Stable per-symbol archive: no age eviction, no D1, no scheduler-generation reset.
 * Each request imports current data, attempts at most one older 72h page, then
 * reads recent 14 days plus 14 rotating older day chunks. Entire history stays
 * available locally; inference never reloads years of candles into one job. */
export async function readHistoricalArchive(store: Store,
  fetchCandles: (symbol: string, from: number, to: number) => Promise<Hte31Candle[]>,
  symbol: string, now: number, seed: Hte31Candle[]): Promise<ArchiveHistory> {
  const current = cleanAnalogCandles(seed, now, now - 14 * DAY);
  const saved = await store.get<Meta>("meta");
  const meta: Meta = saved ?? { days: [], bars: 0, bytes: 0, latestAt: 0,
    before: current[0] ? dayOf(current[0].time * 1000) + DAY : dayOf(now),
    nextFetch: 0, rotation: 0, failures: 0, note: "正在向更早日期回补" };
  if (meta.writeDay !== dayOf(now)) { meta.writeDay = dayOf(now); meta.writes = 0; }
  // Reserve the entire transaction before requesting a page. 15 current day
  // chunks + at most 4 older chunks + 2 metadata writes fit inside 24 rows.
  const canWrite = (meta.writes ?? 0) <= ARCHIVE_DAILY_WRITES - 24;
  const incoming = [...current];
  if (canWrite && now >= meta.nextFetch && meta.before > 0 && meta.bytes < ARCHIVE_CAP_BYTES
    && current.at(-1) && now - current.at(-1)!.time * 1000 < 10 * 60_000) {
    const repair = meta.gaps?.find((gap) => gap.nextAt <= now);
    const to = repair?.to ?? meta.before;
    const from = repair?.from ?? Math.max(0, to - 3 * DAY);
    try {
      const older = cleanAnalogCandles(await fetchCandles(symbol, from, to - 1), now, 0)
        .filter((r) => r.time * 1000 >= from && r.time * 1000 < to);
      if (older.length) {
        incoming.push(...older); meta.failures = 0;
        const incomplete = older.length < (to - from) / ANALOG_BAR_MS;
        if (repair) {
          if (incomplete) repair.nextAt = now + DAY;
          else meta.gaps = meta.gaps!.filter((gap) => gap !== repair);
        } else if (!incomplete || (meta.gaps?.length ?? 0) < 16) {
          meta.before = from;
          if (incomplete) (meta.gaps ??= []).push({ from, to, nextAt: now + DAY });
        }
        meta.nextFetch = now + ARCHIVE_BACKFILL_INTERVAL;
        meta.note = incomplete ? "已保存有效历史，缺少的部分会单独重试" : "正在向更早日期回补";
      } else {
        // An empty page is not proof of a listing date. Retry it, then probe
        // farther back slowly; never manufacture candles or delete stored days.
        meta.failures++;
        if (repair) repair.nextAt = now + DAY;
        else if (meta.failures >= 3) meta.before = from;
        meta.nextFetch = now + (meta.failures >= 3 ? DAY : 60 * 60_000);
        meta.note = "交易所未返回该段历史，已减速探测";
      }
    } catch {
      meta.failures++;
      meta.nextFetch = now + Math.min(DAY, ARCHIVE_BACKFILL_INTERVAL * 2 ** Math.min(meta.failures, 7));
      meta.note = "历史请求失败，稍后从原位置重试";
    }
  }
  if (meta.bytes >= ARCHIVE_CAP_BYTES) meta.note = "历史容量保护中，已存数据保留，最新行情继续更新";
  if (meta.before <= 0) meta.note = "已到最早时间边界，最新行情继续更新";
  const grouped = new Map<number, Packed[]>();
  for (const row of incoming) {
    const day = dayOf(row.time * 1000);
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day)!.push(pack(row));
  }
  if (canWrite) await store.transaction(async (tx) => {
    for (const [day, rows] of grouped) {
      const previous = await tx.get<Packed[]>(keyOf(day)) ?? [];
      const merged = [...new Map([...previous, ...rows].map((r) => [r[0], r])).values()].sort((a, b) => a[0] - b[0]);
      const before = JSON.stringify(previous), after = JSON.stringify(merged);
      if (before === after) continue;
      if (meta.bytes + after.length - before.length > ARCHIVE_CAP_BYTES) {
        meta.note = "历史容量保护中，停止扩库并保留已有历史；最新行情仍参与判断";
        if (day < dayOf(now - 14 * DAY)) meta.before = Math.max(meta.before, day + DAY);
        continue;
      }
      await tx.put(keyOf(day), merged);
      meta.writes = (meta.writes ?? 0) + 1;
      meta.bars += merged.length - previous.length; meta.bytes += after.length - before.length;
      meta.latestAt = Math.max(meta.latestAt, merged.at(-1)![0] * 1000);
      if (!meta.days.includes(day)) meta.days.push(day);
    }
    meta.days.sort((a, b) => a - b);
    // Recover an outage gap between archived days and a newly imported recent
    // window. Keep repair work bounded instead of refetching the whole gap.
    for (let i = 1; i < meta.days.length && (meta.gaps?.length ?? 0) < 16; i++) {
      const from = meta.days[i - 1] + DAY, to = Math.min(meta.days[i], from + 3 * DAY);
      if (to > from && !meta.gaps?.some((gap) => gap.from <= from && gap.to >= to)) {
        (meta.gaps ??= []).push({ from, to, nextAt: now });
        break;
      }
    }
    meta.rotation %= Math.max(1, meta.days.length);
    // Checkpoint cursor and day writes atomically: restart cannot skip a page.
    meta.writes = (meta.writes ?? 0) + 1;
    await tx.put("meta", meta);
  });
  else meta.note = "今日历史写入预算已用完，明日续传；已有历史和最新行情继续参与判断";
  const recentStart = dayOf(now - 14 * DAY);
  const recent = meta.days.filter((day) => day >= recentStart);
  const older = meta.days.filter((day) => day < recentStart);
  const chosen = older.length ? Array.from({ length: Math.min(14, older.length) }, (_, i) => older[(meta.rotation + i) % older.length]) : [];
  meta.rotation = older.length ? (meta.rotation + chosen.length) % older.length : 0;
  if (canWrite) { meta.writes = (meta.writes ?? 0) + 1; await store.put("meta", meta); }
  const chunks = await Promise.all([...recent, ...chosen].map(async (day) => await store.get<Packed[]>(keyOf(day)) ?? []));
  const candles = cleanAnalogCandles([...chunks.flat().map(unpack), ...current], now, 0);
  return { candles, archive: { storedBars: meta.bars, from: meta.days[0] ?? null, to: meta.latestAt || null,
    searchedBars: candles.length, nextBackfillAt: meta.nextFetch, note: meta.note } };
}
