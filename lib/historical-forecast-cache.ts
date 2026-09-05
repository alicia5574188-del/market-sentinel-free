import type { Hte31Candle } from "./hte31-types.ts";
import { ANALOG_BAR_MS, ANALOG_HISTORY_MS, cleanAnalogCandles } from "./historical-forecast.ts";

type Store = { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<unknown> };
type FetchCandles = (symbol: string, from: number, to: number) => Promise<Hte31Candle[]>;
type Cache = { observedAt: number; candles: Hte31Candle[] };
const PAGE_MS = 72 * 60 * 60_000;

/** One bounded per-symbol DO key; no D1 history table or foreground producer. */
export async function loadHistoricalForecastCandles(store: Store, fetchCandles: FetchCandles, symbol: string, now: number) {
  if (!/^[A-Z0-9]{2,18}_USDT$/.test(symbol)) throw new Error("历史行情品种无效");
  const key = `analog-history-v1:${symbol}`;
  const cached = await store.get<Cache>(key);
  const previous = cleanAnalogCandles(cached?.candles ?? [], now);
  const lastTime = previous.at(-1)?.time;
  if (lastTime && lastTime * 1000 + ANALOG_BAR_MS === Math.floor(now / ANALOG_BAR_MS) * ANALOG_BAR_MS) return previous;
  const from = lastTime && now - lastTime * 1000 < PAGE_MS
    ? lastTime * 1000 : Math.floor((now - ANALOG_HISTORY_MS) / ANALOG_BAR_MS) * ANALOG_BAR_MS;
  const pages: { from: number; to: number }[] = [];
  for (let end = now; end > from; end -= PAGE_MS - ANALOG_BAR_MS) pages.push({ from: Math.max(from, end - PAGE_MS + ANALOG_BAR_MS), to: end });
  const fetched: Hte31Candle[] = [];
  // At most five bootstrap pages, two concurrent requests; later updates one page.
  for (let i = 0; i < pages.length; i += 2) {
    const results = await Promise.allSettled(pages.slice(i, i + 2).map((p) => fetchCandles(symbol, p.from, p.to)));
    for (const result of results) if (result.status === "fulfilled") fetched.push(...result.value);
    else if (!previous.length) throw result.reason;
  }
  const candles = cleanAnalogCandles([...previous, ...fetched], now).slice(-4032);
  if (fetched.length) await store.put(key, { observedAt: now, candles });
  return candles;
}
