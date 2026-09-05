import type { Hte31Candle } from "./hte31-types.ts";
import { ANALOG_BAR_MS, ANALOG_HISTORY_MS, cleanAnalogCandles } from "./historical-forecast.ts";

type Store = { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<unknown> };
type FetchCandles = (symbol: string, from: number, to: number) => Promise<Hte31Candle[]>;
type Cache = { observedAt: number; candles: Hte31Candle[]; repairAt?: number };
const PAGE_MS = 72 * 60 * 60_000;
const REPAIR_MS = 30 * 60_000;

/** One bounded per-symbol DO key; no D1 history table or foreground producer. */
export async function loadHistoricalForecastCandles(store: Store, fetchCandles: FetchCandles, symbol: string, now: number) {
  if (!/^[A-Z0-9]{2,18}_USDT$/.test(symbol)) throw new Error("历史行情品种无效");
  const key = `analog-history-v1:${symbol}`;
  const cached = await store.get<Cache>(key);
  const previous = cleanAnalogCandles(cached?.candles ?? [], now);
  const end = Math.floor(now / ANALOG_BAR_MS) * ANALOG_BAR_MS;
  const start = Math.ceil((now - ANALOG_HISTORY_MS) / ANALOG_BAR_MS) * ANALOG_BAR_MS;
  const times = new Set(previous.map((r) => r.time * 1000));
  let missing: number | null = null;
  // Repair recent interior gaps before extending the oldest history. A fresh
  // last bar alone must never mark a truncated historical cache as complete.
  for (let at = end - 2 * ANALOG_BAR_MS; at >= start; at -= ANALOG_BAR_MS) {
    if (!times.has(at)) { missing = at; break; }
  }
  const fresh = times.has(end - ANALOG_BAR_MS);
  const repair = missing != null && now >= (cached?.repairAt ?? 0);
  if (fresh && !repair) return previous;
  const pages: { from: number; to: number }[] = [];
  if (!previous.length && repair) {
    for (let to = end; to > start; to -= PAGE_MS - ANALOG_BAR_MS) pages.push({ from: Math.max(start, to - PAGE_MS + ANALOG_BAR_MS), to });
  } else {
    if (!fresh) pages.push({ from: Math.max(start, end - PAGE_MS + ANALOG_BAR_MS, (previous.at(-1)?.time ?? 0) * 1000), to: end });
    if (repair && !pages.some((p) => missing! >= p.from && missing! <= p.to)) {
      pages.push({ from: Math.max(start, missing! - PAGE_MS + ANALOG_BAR_MS), to: missing! + ANALOG_BAR_MS });
    }
  }
  const fetched: Hte31Candle[] = [];
  // Five bootstrap pages; warm updates at most one recent + one repair page.
  for (let i = 0; i < pages.length; i += 2) {
    const results = await Promise.allSettled(pages.slice(i, i + 2).map((p) => fetchCandles(symbol, p.from, p.to)));
    // Keep successful pages even when another request fails. Empty or missing
    // upstream history is retried with a cooldown, including newly listed coins.
    for (const result of results) if (result.status === "fulfilled") fetched.push(...result.value);
  }
  const candles = cleanAnalogCandles([...previous, ...fetched], now).slice(-4032);
  const improved = missing != null && candles.some((r) => r.time * 1000 <= missing! && !times.has(r.time * 1000));
  if (fetched.length || repair) await store.put(key, { observedAt: now, candles,
    repairAt: repair ? now + (improved ? 60_000 : REPAIR_MS) : cached?.repairAt });
  return candles;
}
