import type { Candle } from "./signal-engine.ts";

const FIVE_MINUTES_MS = 5 * 60_000;

function candleStartMs(time: number) {
  return time > 10_000_000_000 ? time : time * 1000;
}

/**
 * Shadow fills deliberately use only whole 5m candles that START at or after
 * the already-covered boundary. This avoids attributing a candle's pre-entry
 * high/low to a trade opened in the middle of that candle. The returned
 * coveredThroughAt is the end of the last fully consumed candle and becomes
 * the next boundary, so rotating background scans can safely catch up later.
 */
export function shadowCompletedWindow(candles: Candle[], fromCoveredThrough: number, observedAt: number) {
  const completed = candles
    .filter((candle) => {
      const start = candleStartMs(candle.time);
      const end = start + FIVE_MINUTES_MS;
      return start >= fromCoveredThrough && end <= observedAt;
    })
    .sort((a, b) => a.time - b.time);
  if (!completed.length) return { highPrice: null, lowPrice: null, lastCandleAt: null, coveredThroughAt: null, count: 0 };
  const lastStart = candleStartMs(completed.at(-1)!.time);
  return {
    highPrice: Math.max(...completed.map((candle) => candle.high)),
    lowPrice: Math.min(...completed.map((candle) => candle.low)),
    lastCandleAt: lastStart,
    coveredThroughAt: lastStart + FIVE_MINUTES_MS,
    count: completed.length,
  };
}
