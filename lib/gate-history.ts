import type { Hte31Candle } from "./hte31-types.ts";

const GATE_BASE = "https://api.gateio.ws/api/v4";
const SYMBOL_PATTERN = /^[A-Z0-9]{2,18}_USDT$/;

export type HistoricalInterval = "1h" | "4h" | "1d";

function finite(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCandles(payload: unknown): Hte31Candle[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((row): Hte31Candle[] => {
    if (!Array.isArray(row)) return [];
    const time = finite(row[0]);
    const volume = finite(row[1]);
    const close = finite(row[2]);
    const high = finite(row[3]);
    const low = finite(row[4]);
    const open = finite(row[5]);
    if ([time, volume, close, high, low, open].some((value) => value == null)) return [];
    return [{ time: time!, volume: volume!, close: close!, high: high!, low: low!, open: open! }];
  }).sort((a, b) => a.time - b.time);
}

export async function fetchGateHistoricalCandles(symbol: string, interval: HistoricalInterval, limit = 240) {
  if (!SYMBOL_PATTERN.test(symbol)) throw new Error("Invalid Gate symbol");
  // Gate futures candlesticks support up to 2,000 points in one request, so
  // Resonance can deepen memory without introducing another pagination layer.
  const boundedLimit = Math.max(64, Math.min(2_000, Math.trunc(limit)));
  const response = await fetch(`${GATE_BASE}/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&interval=${interval}&limit=${boundedLimit}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
    headers: { Accept: "application/json", "User-Agent": "Resonance/2.0" },
  });
  if (!response.ok) throw new Error(`Gate historical ${interval} returned ${response.status}`);
  return parseCandles(await response.json());
}
