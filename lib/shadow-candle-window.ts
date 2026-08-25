import type { Candle } from "./signal-engine.ts";

const FIVE_MINUTES_MS = 5 * 60_000;

function candleStartMs(time: number) {
  return time > 10_000_000_000 ? time : time * 1000;
}

export function shadowCompletedWindow(candles: Candle[], fromExclusive: number, observedAt: number) {
  const completed = candles
    .filter((candle) => {
      const start = candleStartMs(candle.time);
      const end = start + FIVE_MINUTES_MS;
      return end <= observedAt && end > fromExclusive;
    })
    .sort((a, b) => a.time - b.time);
  if (!completed.length) return { highPrice: null, lowPrice: null, lastCandleAt: null, count: 0 };
  return {
    highPrice: Math.max(...completed.map((candle) => candle.high)),
    lowPrice: Math.min(...completed.map((candle) => candle.low)),
    lastCandleAt: candleStartMs(completed.at(-1)!.time),
    count: completed.length,
  };
}
