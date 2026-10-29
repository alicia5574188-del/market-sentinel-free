/** Pure indicator maths. Every function works on completed bars, oldest first. No I/O. */
import type { Bar } from "./types.ts";

export const r = (v: number | null | undefined, d = 4): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(d)) : null;
const last = <T>(a: readonly T[]): T | undefined => a[a.length - 1];

export function sma(values: readonly number[], n: number): number[] {
  const out: number[] = []; let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!; if (i >= n) sum -= values[i - n]!;
    out.push(i >= n - 1 ? sum / n : NaN);
  }
  return out;
}
export function ema(values: readonly number[], n: number): number[] {
  const out: number[] = []; const k = 2 / (n + 1); let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (i < n - 1) { out.push(NaN); continue; }
    prev = i === n - 1 ? values.slice(0, n).reduce((a, b) => a + b, 0) / n : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
/** EMA seeded from the first valid value (used for MACD signal on a series that starts with NaN). */
function emaOfSeries(series: readonly number[], n: number): number[] {
  const out: number[] = []; const k = 2 / (n + 1); let prev = NaN; let seen = 0; let seed = 0;
  for (const v of series) {
    if (!Number.isFinite(v)) { out.push(NaN); continue; }
    seen++; seed += v;
    if (seen < n) { out.push(NaN); continue; }
    prev = seen === n ? seed / n : v * k + prev * (1 - k); out.push(prev);
  }
  return out;
}
export function wilder(values: readonly number[], n: number): number[] {
  const out: number[] = []; let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (i < n - 1) { out.push(NaN); continue; }
    prev = i === n - 1 ? values.slice(0, n).reduce((a, b) => a + b, 0) / n : (prev * (n - 1) + values[i]!) / n;
    out.push(prev);
  }
  return out;
}
export function trueRange(bars: readonly Bar[]): number[] {
  return bars.map((b, i) => i === 0 ? b.high - b.low
    : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1]!.close), Math.abs(b.low - bars[i - 1]!.close)));
}
export const atrSeries = (bars: readonly Bar[], n = 14) => wilder(trueRange(bars), n);
export function rsiSeries(closes: readonly number[], n = 14): number[] {
  const gains: number[] = [0], losses: number[] = [0];
  for (let i = 1; i < closes.length; i++) { const d = closes[i]! - closes[i - 1]!; gains.push(Math.max(0, d)); losses.push(Math.max(0, -d)); }
  const ag = wilder(gains.slice(1), n), al = wilder(losses.slice(1), n);
  return [NaN, ...ag.map((g, i) => Number.isFinite(g) ? (al[i] === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / al[i]!)) : NaN)];
}
export function macdSeries(closes: readonly number[], fast = 12, slow = 26, sig = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => Number.isFinite(ef[i]) && Number.isFinite(es[i]) ? ef[i]! - es[i]! : NaN);
  const signal = emaOfSeries(line, sig);
  const hist = line.map((v, i) => Number.isFinite(v) && Number.isFinite(signal[i]) ? v - signal[i]! : NaN);
  return { line, signal, hist };
}
export function bollinger(closes: readonly number[], n = 20, k = 2) {
  const m = sma(closes, n), i = closes.length - 1;
  if (!Number.isFinite(m[i])) return null;
  const slice = closes.slice(-n), mean = m[i]!;
  const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const upper = mean + k * sd, lower = mean - k * sd, px = closes[i]!;
  return { mid: mean, upper, lower, pctB: upper > lower ? (px - lower) / (upper - lower) : 0.5, bandwidth: mean > 0 ? (upper - lower) / mean : 0 };
}
export function bandwidthSeries(closes: readonly number[], n = 20, k = 2): number[] {
  const out: number[] = [];
  for (let i = 0; i < closes.length; i++) { const b = i >= n - 1 ? bollinger(closes.slice(0, i + 1), n, k) : null; out.push(b ? b.bandwidth : NaN); }
  return out;
}
export function adx(bars: readonly Bar[], n = 14) {
  if (bars.length < n * 2 + 2) return null;
  const tr: number[] = [], pdm: number[] = [], mdm: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i]!.high - bars[i - 1]!.high, dn = bars[i - 1]!.low - bars[i]!.low;
    pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(bars[i]!.high - bars[i]!.low, Math.abs(bars[i]!.high - bars[i - 1]!.close), Math.abs(bars[i]!.low - bars[i - 1]!.close)));
  }
  const str = wilder(tr, n), sp = wilder(pdm, n), sm = wilder(mdm, n);
  const pdi = sp.map((v, i) => 100 * v / str[i]!), mdi = sm.map((v, i) => 100 * v / str[i]!);
  const dx = pdi.map((p, i) => Number.isFinite(p) && Number.isFinite(mdi[i]) && p + mdi[i]! > 0 ? 100 * Math.abs(p - mdi[i]!) / (p + mdi[i]!) : NaN);
  const clean = dx.filter(Number.isFinite), a = wilder(clean, n), v = last(a);
  return Number.isFinite(v) ? { adx: v!, plusDi: last(pdi)!, minusDi: last(mdi)! } : null;
}
export function stochastic(bars: readonly Bar[], n = 14, kSmooth = 3, dSmooth = 3) {
  if (bars.length < n + kSmooth + dSmooth) return null;
  const raw: number[] = [];
  for (let i = n - 1; i < bars.length; i++) {
    const w = bars.slice(i - n + 1, i + 1), hi = Math.max(...w.map(b => b.high)), lo = Math.min(...w.map(b => b.low));
    raw.push(hi > lo ? 100 * (bars[i]!.close - lo) / (hi - lo) : 50);
  }
  const k = sma(raw, kSmooth), d = sma(k.filter(Number.isFinite), dSmooth), kk = last(k)!, dd = last(d)!;
  return Number.isFinite(kk) && Number.isFinite(dd) ? { k: kk, d: dd, j: 3 * kk - 2 * dd } : null;
}
export function cci(bars: readonly Bar[], n = 20) {
  if (bars.length < n) return null;
  const tp = bars.map(b => (b.high + b.low + b.close) / 3), w = tp.slice(-n), mean = w.reduce((a, b) => a + b, 0) / n;
  const md = w.reduce((a, b) => a + Math.abs(b - mean), 0) / n;
  return md > 0 ? (last(tp)! - mean) / (0.015 * md) : 0;
}
export function mfi(bars: readonly Bar[], n = 14) {
  if (bars.length < n + 1) return null;
  let pos = 0, neg = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const tp = (bars[i]!.high + bars[i]!.low + bars[i]!.close) / 3, pt = (bars[i - 1]!.high + bars[i - 1]!.low + bars[i - 1]!.close) / 3;
    const flow = tp * bars[i]!.volume; if (tp > pt) pos += flow; else if (tp < pt) neg += flow;
  }
  return neg === 0 ? (pos === 0 ? 50 : 100) : 100 - 100 / (1 + pos / neg);
}
export function obvSeries(bars: readonly Bar[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i]!.close - bars[i - 1]!.close;
    out.push(out[i - 1]! + (d > 0 ? bars[i]!.volume : d < 0 ? -bars[i]!.volume : 0));
  }
  return out;
}
/** Session VWAP anchored at the UTC day start of the last bar. */
export function vwapDeviation(bars: readonly Bar[]) {
  if (!bars.length) return null;
  const day = Math.floor(last(bars)!.time / 86400);
  let pv = 0, v = 0;
  for (const b of bars) if (Math.floor(b.time / 86400) === day) { pv += (b.high + b.low + b.close) / 3 * b.volume; v += b.volume; }
  if (v <= 0) return null;
  const vwap = pv / v; return { vwap, dev: last(bars)!.close / vwap - 1 };
}
export function volumeMultiple(bars: readonly Bar[], n = 20, at = bars.length - 1) {
  if (at < 1) return null;
  const w = bars.slice(Math.max(0, at - n), at); if (!w.length) return null;
  const avg = w.reduce((a, b) => a + b.volume, 0) / w.length;
  return avg > 0 ? bars[at]!.volume / avg : null;
}
/** percentile rank of the last finite value of `series` inside its own history (0..1). */
export function percentRank(series: readonly number[]): number | null {
  const s = series.filter(Number.isFinite); if (s.length < 20) return null;
  const v = last(s)!; return s.filter(x => x <= v).length / s.length;
}

export type Pivot = { index: number; time: number; price: number; kind: "high" | "low" };
/** Fractal swing points confirmed by `left` bars before and `right` bars after. */
export function pivots(bars: readonly Bar[], left = 3, right = 3): Pivot[] {
  const out: Pivot[] = [];
  for (let i = left; i < bars.length - right; i++) {
    let hi = true, lo = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j]!.high >= bars[i]!.high) hi = false;
      if (bars[j]!.low <= bars[i]!.low) lo = false;
      if (!hi && !lo) break;
    }
    if (hi) out.push({ index: i, time: bars[i]!.time, price: bars[i]!.high, kind: "high" });
    if (lo) out.push({ index: i, time: bars[i]!.time, price: bars[i]!.low, kind: "low" });
  }
  return out;
}

/** Divergence between price swing points and an oscillator over the recent window. */
export function divergence(bars: readonly Bar[], osc: readonly number[], lookback = 40): "bull" | "bear" | null {
  const start = Math.max(0, bars.length - lookback), seg = bars.slice(start), p = pivots(seg, 2, 2).map(x => ({ ...x, index: x.index + start }));
  const highs = p.filter(x => x.kind === "high").slice(-2), lows = p.filter(x => x.kind === "low").slice(-2);
  if (highs.length === 2 && highs[1]!.price > highs[0]!.price) {
    const a = osc[highs[0]!.index], b = osc[highs[1]!.index];
    if (Number.isFinite(a) && Number.isFinite(b) && b! < a!) return "bear";
  }
  if (lows.length === 2 && lows[1]!.price < lows[0]!.price) {
    const a = osc[lows[0]!.index], b = osc[lows[1]!.index];
    if (Number.isFinite(a) && Number.isFinite(b) && b! > a!) return "bull";
  }
  return null;
}

/** Short tags for the last 1~3 bars. Labels only; never used as a gate. */
export function candlePatterns(bars: readonly Bar[]): string[] {
  const out: string[] = []; const n = bars.length; if (n < 3) return out;
  const c = bars[n - 1]!, p = bars[n - 2]!, q = bars[n - 3]!;
  const body = Math.abs(c.close - c.open), range = Math.max(1e-12, c.high - c.low);
  const upper = c.high - Math.max(c.open, c.close), lower = Math.min(c.open, c.close) - c.low;
  if (body / range < 0.1) out.push("十字星");
  if (lower > 2 * body && lower / range > 0.55 && upper / range < 0.15) out.push("锤子线/下影针");
  if (upper > 2 * body && upper / range > 0.55 && lower / range < 0.15) out.push("上影针/流星");
  const pb = Math.abs(p.close - p.open);
  if (c.close > c.open && p.close < p.open && c.close >= p.open && c.open <= p.close && body > pb) out.push("看涨吞没");
  if (c.close < c.open && p.close > p.open && c.open >= p.close && c.close <= p.open && body > pb) out.push("看跌吞没");
  if (c.high <= p.high && c.low >= p.low) out.push("内包线");
  if (q.close < q.open && Math.abs(p.close - p.open) / Math.max(1e-12, p.high - p.low) < 0.3 && c.close > c.open && c.close > (q.open + q.close) / 2) out.push("早晨之星");
  if (q.close > q.open && Math.abs(p.close - p.open) / Math.max(1e-12, p.high - p.low) < 0.3 && c.close < c.open && c.close < (q.open + q.close) / 2) out.push("黄昏之星");
  return out;
}

export type IndicatorPack = {
  tf: string; close: number;
  ema: { e20: number | null; e50: number | null; e200: number | null; s20: number | null; s50: number | null; s200: number | null; a20: number | null; a50: number | null; a200: number | null };
  atr: number | null; atrPct: number | null; atrRank: number | null;
  rsi: number | null; rsiDiv: "bull" | "bear" | null;
  macd: { m: number | null; s: number | null; h: number | null; hDir: "up" | "down" | "flat"; cross: "golden" | "dead" | null; div: "bull" | "bear" | null };
  boll: { pctB: number | null; bw: number | null; bwRank: number | null; upper: number | null; lower: number | null };
  adx: { adx: number | null; pdi: number | null; mdi: number | null };
  stoch: { k: number | null; d: number | null; j: number | null };
  vwapDev: number | null; volX: number | null; obv: "up" | "down" | "flat"; cci: number | null; mfi: number | null;
  hhDist: number | null; llDist: number | null; patterns: string[];
};

const dirWord = (a: number | undefined, b: number | undefined, eps: number): "up" | "down" | "flat" =>
  !Number.isFinite(a) || !Number.isFinite(b) ? "flat" : a! - b! > eps ? "up" : b! - a! > eps ? "down" : "flat";

/** One compact snapshot of every logged indicator for one timeframe. Computed once per decision point. */
export function indicatorPack(tf: string, bars: readonly Bar[], swingLookback = 60): IndicatorPack | null {
  if (bars.length < 40) return null;
  const closes = bars.map(b => b.close), px = last(closes)!, i = closes.length - 1;
  const e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = ema(closes, 200);
  const slope = (e: number[], k: number) => Number.isFinite(e[i]) && Number.isFinite(e[i - k]) && e[i - k]! > 0 ? e[i]! / e[i - k]! - 1 : null;
  const atr = atrSeries(bars), atrV = last(atr), rsi = rsiSeries(closes), mac = macdSeries(closes), bol = bollinger(closes), bw = bandwidthSeries(closes.slice(-260));
  const ad = adx(bars), st = stochastic(bars), vw = vwapDeviation(bars), obv = obvSeries(bars);
  const hist = mac.hist, h = last(hist), hp = hist[i - 1];
  const win = bars.slice(-swingLookback), hh = Math.max(...win.map(b => b.high)), ll = Math.min(...win.map(b => b.low));
  const obvNow = obv[i]!, obvThen = obv[Math.max(0, i - 20)]!, vol = bars.slice(-20).reduce((a, b) => a + b.volume, 0);
  return {
    tf, close: px,
    ema: { e20: r(e20[i], 2), e50: r(e50[i], 2), e200: r(e200[i], 2),
      s20: r(slope(e20, 5), 5), s50: r(slope(e50, 5), 5), s200: r(slope(e200, 5), 5),
      a20: Number.isFinite(e20[i]) ? r(px / e20[i]! - 1, 5) : null, a50: Number.isFinite(e50[i]) ? r(px / e50[i]! - 1, 5) : null,
      a200: Number.isFinite(e200[i]) ? r(px / e200[i]! - 1, 5) : null },
    atr: r(atrV, 2), atrPct: Number.isFinite(atrV) && px > 0 ? r(atrV! / px, 5) : null, atrRank: r(percentRank(atr.map((v, k) => v / (closes[k] || 1))), 3),
    rsi: r(last(rsi), 2), rsiDiv: divergence(bars, rsi),
    macd: { m: r(last(mac.line), 4), s: r(last(mac.signal), 4), h: r(h, 4), hDir: dirWord(h, hp, 0),
      cross: Number.isFinite(h) && Number.isFinite(hp) ? (h! > 0 && hp! <= 0 ? "golden" : h! < 0 && hp! >= 0 ? "dead" : null) : null,
      div: divergence(bars, mac.hist) },
    boll: { pctB: r(bol?.pctB, 3), bw: r(bol?.bandwidth, 5), bwRank: r(percentRank(bw), 3), upper: r(bol?.upper, 2), lower: r(bol?.lower, 2) },
    adx: { adx: r(ad?.adx, 2), pdi: r(ad?.plusDi, 2), mdi: r(ad?.minusDi, 2) },
    stoch: { k: r(st?.k, 2), d: r(st?.d, 2), j: r(st?.j, 2) },
    vwapDev: r(vw?.dev, 5), volX: r(volumeMultiple(bars), 2),
    obv: vol > 0 ? dirWord(obvNow, obvThen, vol * 0.05) : "flat", cci: r(cci(bars), 1), mfi: r(mfi(bars), 1),
    hhDist: hh > 0 ? r(hh / px - 1, 5) : null, llDist: ll > 0 ? r(ll / px - 1, 5) : null,
    patterns: candlePatterns(bars),
  };
}
