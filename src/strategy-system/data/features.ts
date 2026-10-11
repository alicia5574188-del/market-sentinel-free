import type { Candle } from '../types.ts';

export function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    sum += tr;
  }
  return sum / period;
}

export function calcRange(candles: Candle[], lookback = 50, exclude = 0) {
  const end = Math.max(0, candles.length - exclude);
  const start = Math.max(0, end - lookback);
  const recent = candles.slice(start, end);
  if (recent.length === 0) return { high: 0, low: 0 };
  let high = recent[0].high;
  let low = recent[0].low;
  for (const c of recent) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  return { high, low };
}

export function calcVolumeMean(candles: Candle[], period = 20, exclude = 0): number {
  const end = Math.max(0, candles.length - exclude);
  const recent = candles.slice(Math.max(0, end - period), end);
  if (recent.length === 0) return 0;
  return recent.reduce((s, c) => s + c.volume, 0) / recent.length;
}

export function calcHigherHighs(candles: Candle[], period = 10): boolean {
  if (candles.length < period + 1) return false;
  const r = candles.slice(-period);
  for (let i = 1; i < r.length; i++) if (r[i].high <= r[i - 1].high) return false;
  return true;
}

export function calcLowerLows(candles: Candle[], period = 10): boolean {
  if (candles.length < period + 1) return false;
  const r = candles.slice(-period);
  for (let i = 1; i < r.length; i++) if (r[i].low >= r[i - 1].low) return false;
  return true;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
