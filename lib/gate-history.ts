import type { Hte31Candle } from "./hte31-types.ts";

const GATE_BASE = "https://api.gateio.ws/api/v4";
const SYMBOL_PATTERN = /^[A-Z0-9]{2,18}_USDT$/;

export type HistoricalInterval = "1h" | "4h" | "1d";

export class GateHistoricalDataError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "GateHistoricalDataError";
  }
}

function finite(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseGateHistoricalCandles(payload: unknown): Hte31Candle[] {
  if (!Array.isArray(payload)) throw new GateHistoricalDataError("MALFORMED_PAYLOAD", "Gate historical payload is not an array");
  const parsed = payload.flatMap((row): Hte31Candle[] => {
    if (!Array.isArray(row)) return [];
    const time = finite(row[0]);
    const volume = finite(row[1]);
    const close = finite(row[2]);
    const high = finite(row[3]);
    const low = finite(row[4]);
    const open = finite(row[5]);
    if ([time, volume, close, high, low, open].some((value) => value == null)) return [];
    if (!(time! > 0 && open! > 0 && high! > 0 && low! > 0 && close! > 0 && volume! >= 0)) return [];
    if (high! < Math.max(open!, close!) || low! > Math.min(open!, close!) || high! < low!) return [];
    return [{ time: time!, volume: volume!, close: close!, high: high!, low: low!, open: open! }];
  });
  if (!parsed.length) throw new GateHistoricalDataError("EMPTY_HISTORY", "Gate historical response contains no valid candles");
  if (payload.length >= 8 && parsed.length / payload.length < 0.60) {
    throw new GateHistoricalDataError("MALFORMED_CANDLES", `Only ${parsed.length}/${payload.length} historical candles are valid`);
  }
  return [...new Map(parsed.map((row) => [row.time, row])).values()].sort((a, b) => a.time - b.time);
}

export async function fetchGateHistoricalCandles(symbol: string, interval: HistoricalInterval, limit = 240) {
  if (!SYMBOL_PATTERN.test(symbol)) throw new Error("Invalid Gate symbol");
  // Gate futures candlesticks support up to 2,000 points in one request, so
  // Resonance can deepen memory without introducing another pagination layer.
  const boundedLimit = Math.max(64, Math.min(2_000, Math.trunc(limit)));
  try {
    const response = await fetch(`${GATE_BASE}/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&interval=${interval}&limit=${boundedLimit}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
      headers: { Accept: "application/json", "User-Agent": "Resonance/2.0" },
    });
    if (!response.ok) throw new GateHistoricalDataError(`UPSTREAM_HTTP_${response.status}`, `Gate historical ${interval} returned ${response.status}`);
    return parseGateHistoricalCandles(await response.json());
  } catch (error) {
    if (error instanceof GateHistoricalDataError) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new GateHistoricalDataError("UPSTREAM_TIMEOUT", `Gate historical ${interval} timed out`);
    }
    throw new GateHistoricalDataError("UPSTREAM_FAILURE", error instanceof Error ? error.message : `Gate historical ${interval} failed`);
  }
}
