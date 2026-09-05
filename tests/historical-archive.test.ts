import test from "node:test";
import assert from "node:assert/strict";
import { readHistoricalArchive, ARCHIVE_BACKFILL_INTERVAL, ARCHIVE_DAILY_WRITES } from "../lib/historical-archive.ts";
import { ANALOG_BAR_MS, cleanAnalogCandles, buildHistoricalForecast } from "../lib/historical-forecast.ts";
import { historicalUniverse, HISTORICAL_UNIVERSE, chooseDirectMarketTarget } from "../lib/direct-market-universe.ts";
import type { Hte31Candle } from "../lib/hte31-types.ts";
const DAY = 86_400_000, now = Date.UTC(2026, 8, 5, 12);
function rows(from: number, to: number): Hte31Candle[] {
  return Array.from({ length: Math.max(0, Math.floor((to - from) / ANALOG_BAR_MS)) }, (_, i) => {
    const time = from + i * ANALOG_BAR_MS, open = 100 + Math.sin(time / DAY) * 3;
    return { time: time / 1000, open, close: open + 0.01, high: open + 0.03, low: open - 0.02, volume: 100 };
  });
}
function memory() {
  let values = new Map<string, unknown>();
  const kv = { async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
    async put<T>(key: string, value: T) { values.set(key, structuredClone(value)); } };
  return { ...kv, async transaction<T>(callback: (store: typeof kv) => Promise<T>) {
    const before = structuredClone(values);
    try { return await callback(kv); } catch (error) { values = before; throw error; }
  } };
}
test("archive keeps imported history, fetches one bounded page, and throttles by persisted cursor", async () => {
  const store = memory(), seed = rows(now - 14 * DAY, now); let calls = 0;
  const fetch = async (_s: string, from: number, to: number) => {
    calls++; assert.ok(to - from <= 3 * DAY); return rows(from, to + 1);
  };
  const first = await readHistoricalArchive(store, fetch, "BTC_USDT", now, seed);
  assert.equal(calls, 1); assert.ok(first.archive.storedBars! > 4032);
  assert.ok(first.candles.some((r) => r.time * 1000 < now - 14 * DAY));
  await readHistoricalArchive(store, fetch, "BTC_USDT", now + 1000, seed);
  assert.equal(calls, 1);
  const next = await readHistoricalArchive(store, fetch, "BTC_USDT", now + ARCHIVE_BACKFILL_INTERVAL, rows(now - 14 * DAY, now + ARCHIVE_BACKFILL_INTERVAL));
  assert.equal(calls, 2); assert.ok(next.archive.from! < first.archive.from!);
  assert.ok(next.archive.storedBars! > first.archive.storedBars!);
});
test("years-old data survives new current windows and participates through bounded local rotation", async () => {
  const store = memory(), seed = rows(now - 14 * DAY, now);
  const fetch = async (_s: string, from: number, to: number) => rows(from, to + 1);
  const first = await readHistoricalArchive(store, fetch, "BTC_USDT", now, seed);
  const later = now + 2 * 365 * DAY;
  const next = await readHistoricalArchive(store, fetch, "BTC_USDT", later, rows(later - 14 * DAY, later));
  assert.ok(next.archive.from! <= first.archive.from!);
  assert.ok(next.candles.some((r) => r.time * 1000 < later - 365 * DAY));
  assert.ok(next.candles.length <= 30 * 288);
  assert.equal(cleanAnalogCandles(next.candles, later).length, next.candles.length);
  assert.ok(buildHistoricalForecast({ candles: next.candles, now: later, costBps: 12, stopPct: 0.5 }).historyFrom! < later - 365 * DAY);
});
test("rate limits preserve the cursor and seed, back off, and resume the same historical interval", async () => {
  const store = memory(), seed = rows(now - 14 * DAY, now); const attempts: number[] = [];
  const failed = async (_s: string, from: number) => { attempts.push(from); throw new Error("429"); };
  const first = await readHistoricalArchive(store, failed, "BTC_USDT", now, seed);
  assert.equal(first.archive.storedBars, seed.length); assert.match(first.archive.note, /请求失败/);
  await readHistoricalArchive(store, failed, "BTC_USDT", now + 1000, seed);
  assert.equal(attempts.length, 1);
  const resumedAt = first.archive.nextBackfillAt;
  await readHistoricalArchive(store, async (_s, from, to) => { attempts.push(from); return rows(from, to + 1); }, "BTC_USDT", resumedAt, rows(now - 14 * DAY, resumedAt));
  assert.equal(attempts.length, 2); assert.equal(attempts[0], attempts[1]);
});
test("partial pages are stored with a retained repair record instead of silently called complete", async () => {
  const store = memory();
  const result = await readHistoricalArchive(store, async (_s, from, to) => rows(from, to + 1).filter((_, i) => i !== 10), "BTC_USDT", now, rows(now - 14 * DAY, now));
  const meta = await store.get<{ gaps: unknown[] }>("meta");
  assert.equal(meta!.gaps.length, 1); assert.match(result.archive.note, /缺少/);
});
test("fixed six-coin coverage ignores a new volume leader and gives every available member a turn", () => {
  const rows = [...HISTORICAL_UNIVERSE, "HOT_USDT", "XAU_USDT"].map((symbol, i) => ({ symbol, price: 100, volumeUsd: (i + 1) * 1e9,
    changePercentage: 0, fundingRate: 0, basisPct: 0, coarseScore: 1, confidence: 50, state: "observing" as const, stateLabel: "", side: "WAIT" as const }));
  const pool = historicalUniverse(rows); assert.equal(pool.length, 6);
  const seen: Record<string, number> = {};
  for (let i = 0; i < 6; i++) { const target = chooseDirectMarketTarget(pool, i, seen)!; assert.ok(!seen[target.symbol]); seen[target.symbol] = now + i; }
  assert.equal(Object.keys(seen).length, 6);
});
test("archive request, packed storage, and inference budgets stay bounded", () => {
  const backfillsPerDay = HISTORICAL_UNIVERSE.length * Math.ceil(DAY / ARCHIVE_BACKFILL_INTERVAL);
  assert.equal(backfillsPerDay, 864);
  const scansPerDay = Math.ceil(DAY / 25_000);
  const archiveWrites = scansPerDay * 4 + backfillsPerDay * 5 + 6 * 20;
  assert.ok(archiveWrites < 20_000);
  assert.equal(ARCHIVE_DAILY_WRITES * HISTORICAL_UNIVERSE.length, 21_000);
  assert.ok(scansPerDay * 50 < 200_000);
  assert.ok(JSON.stringify(rows(now - 30 * DAY, now)).length < 2_000_000);
});

test("daily write guard preserves history and keeps fresh candles usable, then resets on the next UTC day", async () => {
  const store = memory(), seed = rows(now - 14 * DAY, now); let calls = 0;
  const fetch = async (_s: string, from: number, to: number) => { calls++; return rows(from, to + 1); };
  await readHistoricalArchive(store, fetch, "BTC_USDT", now, seed);
  const meta = await store.get<Record<string, unknown>>("meta");
  await store.put("meta", { ...meta, writes: ARCHIVE_DAILY_WRITES });
  const blocked = await readHistoricalArchive(store, fetch, "BTC_USDT", now + ARCHIVE_BACKFILL_INTERVAL, rows(now - 14 * DAY, now + ARCHIVE_BACKFILL_INTERVAL));
  assert.equal(calls, 1); assert.match(blocked.archive.note, /明日续传/);
  assert.equal(blocked.candles.at(-1)!.time * 1000, now + ARCHIVE_BACKFILL_INTERVAL - ANALOG_BAR_MS);
  await readHistoricalArchive(store, fetch, "BTC_USDT", now + DAY, rows(now - 13 * DAY, now + DAY));
  assert.equal(calls, 2);
});
