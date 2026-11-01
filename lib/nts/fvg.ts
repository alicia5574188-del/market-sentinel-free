/**
 * FVG 扫流动性系统（视频方法）——纯函数，不碰网络/存储，node 可直接测试。
 *
 *  1. 4H 公平价值缺口（FVG）：三根 4H K 线 c1/c2/c3，多头 c1.high < c3.low，区间 [c1.high, c3.low]；空头镜像 c1.low > c3.high，区间 [c3.high, c1.low]。
 *     4H 收盘越过远端（多头 close < 区间下沿、空头 close > 区间上沿）= 作废。影线穿过不算作废。历史缺口（最近 zoneLookback4h 根 4H）也算。
 *  2. 价格在 4H 多头缺口里时，15m 扫流动性：某根 15m 的最低价 < 之前一个已确认的 15m 分形低点（左右各 2 根），但实体（开/收较低者）收在该低点之上。
 *  3. 位移：扫完后 2–3 根 15m 都是同向实体 K（实体/振幅 ≥ 0.6），合计走了 ≥ 1.0×ATR(15m,14)，并且留下一个新的 15m 多头 FVG。
 *  4. 入场：在新 15m FVG 上沿挂限价；价格直接跳空穿过就按市价成交。约 16 根 15m 没成交或先跌破扫的低点 → 撤单。
 *  5. 止损 = 扫流动性那根影线的最低点再低 1 个价格最小变动单位（Gate order_price_round）；止盈 = 实际成交价 + 3R。空头全部镜像。
 *     不限止损宽度、不限订单数量（视频没有这些限制）。
 */
import type { Bar, Side } from "./types.ts";
import { atrSeries } from "./indicators.ts";

export const H4 = 14_400, M15 = 900;
export type FvgParams = {
  zoneLookback4h: number; swingL: number; swingR: number; swingLookback: number; bodyMin: number; dispAtr: number; atrLen: number;
  dispMaxBars: number; expiryBars: number; rr: number; scanBars: number; reentryTolPct: number;
};
/** 合约价格最小变动单位未知时的兜底：取价格数量级的 1e-4（Gate 主流合约的 tick 大多在这个量级或更细）。 */
export function fallbackTick(px: number): number { return px > 0 ? Math.pow(10, Math.floor(Math.log10(px)) - 4) : 1e-8; }
/** 止损 = 扫点外 1 tick。 */
export function stopFromSweep(side: Side, sweepPx: number, tick: number): number { return side === "LONG" ? sweepPx - tick : sweepPx + tick; }
export type Zone4h = { key: string; side: Side; lo: number; hi: number; formedAt: number; invalidAt: number | null; c1: number };
/** 15m 形态状态：
 *  SWEPT 已扫、位移还没走完（等后面 K 线收盘）；NO_DISP 位移不成立；ARMED 限价单挂着；TOUCHED K 线已碰到入场价（实盘 tick 没成交 = 错过）；
 *  EXPIRED 16 根没碰到；INVALID 先破了扫的低点（高点）。 */
export type SetupStatus = "SWEPT" | "NO_DISP" | "ARMED" | "TOUCHED" | "EXPIRED" | "INVALID";
export type Setup = {
  id: string; side: Side; sweepT: number; sweepPx: number; swingPx: number; swingT: number; zoneKeys: string[];
  status: SetupStatus; dispBars: number | null; dispMove: number | null; atr: number | null;
  fvg: { lo: number; hi: number } | null; entry: number | null; stop: number | null; tpOrig: number | null;
  armedT: number | null; expiresT: number | null; touchedT: number | null; brokeT: number | null; tpHitT: number | null; lastT: number;
};

const bodyLo = (b: Bar) => Math.min(b.open, b.close), bodyHi = (b: Bar) => Math.max(b.open, b.close);
const zoneKey = (side: Side, c1: Bar) => `${side === "LONG" ? "B" : "S"}${c1.time}`;

/** 全部 4H FVG（只用已收盘 K 线），带形成时间（c3 收盘，秒）与作废时间（第一根收盘越过远端的 4H 收盘时间，秒）。 */
export function find4hZones(b4: readonly Bar[], lookback = 100): Zone4h[] {
  const out: Zone4h[] = [], start = Math.max(0, b4.length - lookback);
  for (let i = start; i + 2 < b4.length; i++) {
    const c1 = b4[i]!, c3 = b4[i + 2]!;
    let z: Zone4h | null = null;
    if (c1.high < c3.low) z = { key: zoneKey("LONG", c1), side: "LONG", lo: c1.high, hi: c3.low, formedAt: c3.time + H4, invalidAt: null, c1: c1.time };
    else if (c1.low > c3.high) z = { key: zoneKey("SHORT", c1), side: "SHORT", lo: c3.high, hi: c1.low, formedAt: c3.time + H4, invalidAt: null, c1: c1.time };
    if (!z) continue;
    for (let k = i + 3; k < b4.length; k++) {
      const c = b4[k]!.close;
      if (z.side === "LONG" ? c < z.lo : c > z.hi) { z.invalidAt = b4[k]!.time + H4; break; }
    }
    out.push(z);
  }
  return out;
}
/** 在时刻 t（秒）已形成且未作废的缺口。 */
export const activeZonesAt = (zones: readonly Zone4h[], t: number) => zones.filter(z => z.formedAt <= t && (z.invalidAt == null || z.invalidAt > t));

/** 2 根分形：low[p] 严格低于左右各 L/R 根（高点镜像）。 */
export function isSwing(b: readonly Bar[], p: number, kind: "LOW" | "HIGH", L = 2, R = 2) {
  if (p - L < 0 || p + R >= b.length) return false;
  const v = kind === "LOW" ? b[p]!.low : b[p]!.high;
  for (let k = p - L; k <= p + R; k++) {
    if (k === p) continue;
    const w = kind === "LOW" ? b[k]!.low : b[k]!.high;
    if (kind === "LOW" ? !(v < w) : !(v > w)) return false;
  }
  return true;
}

/** 第 s 根 15m 是否扫了流动性（多头：扫分形低点）。返回被扫的分形（取被扫过的最极端的那个）或 null。 */
export function detectSweep(b: readonly Bar[], s: number, side: Side, p: Pick<FvgParams, "swingL" | "swingR" | "swingLookback">) {
  const bar = b[s]; if (!bar) return null;
  const long = side === "LONG";
  let best: { idx: number; px: number } | null = null;
  let extreme = long ? Infinity : -Infinity; // q+1..s-1 之间的最低低点 / 最高高点（分形不能已被扫过）
  for (let q = s - 1; q >= Math.max(p.swingL, s - p.swingLookback); q--) {
    if (q + 1 <= s - 1) extreme = long ? Math.min(extreme, b[q + 1]!.low) : Math.max(extreme, b[q + 1]!.high);
    if (q + p.swingR > s - 1) continue;                            // 分形要在扫的那根之前就已确认
    if (!isSwing(b, q, long ? "LOW" : "HIGH", p.swingL, p.swingR)) continue;
    const v = long ? b[q]!.low : b[q]!.high;
    if (long ? extreme < v : extreme > v) continue;                // 之间已经被扫过
    const swept = long ? bar.low < v && bodyLo(bar) > v : bar.high > v && bodyHi(bar) < v;
    if (swept && (!best || (long ? v < best.px : v > best.px))) best = { idx: q, px: v };
  }
  return best;
}

/** 扫完后的位移：返回 {m, fvg, move} 或 "WAIT"（K 线还没走完）或 null（不成立）。
 *  2 根：两根都是同向实体 K、合计 ≥ dispAtr×ATR、留下新 FVG；不够就看第 3 根（3 根都要是实体 K）。 */
export function detectDisplacement(b: readonly Bar[], s: number, side: Side, atr: number, p: Pick<FvgParams, "bodyMin" | "dispAtr" | "dispMaxBars">):
  { m: number; fvg: { lo: number; hi: number }; move: number } | "WAIT" | null {
  const dir = side === "LONG" ? 1 : -1;
  const strong = (k: number) => { const x = b[k]!, range = x.high - x.low; return range > 0 && dir * (x.close - x.open) > 0 && Math.abs(x.close - x.open) / range >= p.bodyMin; };
  const check = (m: number) => {
    const move = dir * (b[s + m]!.close - b[s + 1]!.open);
    if (!(Number.isFinite(atr) && atr > 0 && move >= p.dispAtr * atr)) return null;
    for (let j = s + 1; j + 1 <= s + m; j++) {
      const a = b[j - 1]!, c = b[j + 1]!;
      const gap = dir > 0 ? (a.high < c.low ? { lo: a.high, hi: c.low } : null) : (a.low > c.high ? { lo: c.high, hi: a.low } : null);
      if (!gap) continue;
      let touched = false;
      for (let k = j + 2; k <= s + m; k++) if (dir > 0 ? b[k]!.low <= gap.lo : b[k]!.high >= gap.hi) { touched = true; break; }
      if (!touched) return { m, fvg: gap, move };
    }
    return null;
  };
  for (let m = 1; m <= Math.max(2, p.dispMaxBars); m++) {
    if (s + m >= b.length) return "WAIT";
    if (!strong(s + m)) return null;
    if (m >= 2) { const ok = check(m); if (ok) return ok; }
  }
  return null;
}

/** 在 15m 收盘 K 线里找全部形态（只看时间上与当时有效的 4H 同向缺口重叠的扫流动性）。 */
export function scanSetups(b: readonly Bar[], zones: readonly Zone4h[], p: FvgParams, tick?: number): Setup[] {
  const out: Setup[] = [];
  if (b.length < p.swingL + p.swingR + 3) return out;
  const atr = atrSeries(b as Bar[], p.atrLen);
  const start = Math.max(p.swingL + p.swingR + 1, b.length - p.scanBars);
  for (let s = start; s < b.length; s++) {
    const bar = b[s]!;
    for (const side of ["LONG", "SHORT"] as Side[]) {
      const zs = activeZonesAt(zones, bar.time).filter(z => z.side === side && bar.low <= z.hi && bar.high >= z.lo);
      if (!zs.length) continue;
      const sw = detectSweep(b, s, side, p); if (!sw) continue;
      const st: Setup = { id: `${side === "LONG" ? "L" : "S"}${bar.time}`, side, sweepT: bar.time, sweepPx: side === "LONG" ? bar.low : bar.high,
        swingPx: sw.px, swingT: b[sw.idx]!.time, zoneKeys: zs.map(z => z.key), status: "SWEPT", dispBars: null, dispMove: null, atr: Number.isFinite(atr[s]!) ? atr[s]! : null,
        fvg: null, entry: null, stop: null, tpOrig: null, armedT: null, expiresT: null, touchedT: null, brokeT: null, tpHitT: null, lastT: b[b.length - 1]!.time };
      const d = detectDisplacement(b, s, side, atr[s]!, p);
      if (d === "WAIT") { out.push(st); continue; }
      if (!d) { st.status = "NO_DISP"; out.push(st); continue; }
      const A = s + d.m, dir = side === "LONG" ? 1 : -1;
      st.dispBars = d.m; st.dispMove = d.move; st.fvg = d.fvg;
      st.entry = side === "LONG" ? d.fvg.hi : d.fvg.lo;
      st.stop = stopFromSweep(side, st.sweepPx, tick && tick > 0 ? tick : fallbackTick(st.sweepPx));
      st.tpOrig = st.entry + dir * p.rr * Math.abs(st.entry - st.stop);
      st.armedT = b[A]!.time + M15; st.expiresT = b[A]!.time + (p.expiryBars + 1) * M15; st.status = "ARMED";
      for (let k = A + 1; k < b.length; k++) {
        const x = b[k]!;
        const touch = side === "LONG" ? x.low <= st.entry : x.high >= st.entry;
        const broke = side === "LONG" ? x.low < st.sweepPx : x.high > st.sweepPx;
        const tp = side === "LONG" ? x.high >= st.tpOrig : x.low <= st.tpOrig;
        if (st.status === "ARMED") {
          if (k - A > p.expiryBars) st.status = "EXPIRED";
          else if (touch) { st.status = "TOUCHED"; st.touchedT = x.time; }
          else if (broke) st.status = "INVALID";
        }
        if (broke && st.brokeT == null) st.brokeT = x.time;
        if (tp && st.tpHitT == null) st.tpHitT = x.time;
      }
      if (st.status === "ARMED" && b.length - 1 - A >= p.expiryBars) st.status = "EXPIRED";
      out.push(st);
    }
  }
  return out;
}

/** 情形 (b) 再入场条件：老形态（已出过形态但没成交）+ 价格回到原 15m FVG（含容差）+ 扫的低点没破 + 原 3R 止盈没到过 +
 *  按当前价算剩余空间：|原TP − 现价| ≥ rr × |现价 − 止损|。 */
export function reentryCheck(st: Setup, px: number, p: Pick<FvgParams, "rr" | "reentryTolPct">): { ok: boolean; reason: string } {
  if (!st.fvg || st.entry == null || st.stop == null || st.tpOrig == null) return { ok: false, reason: "形态不完整" };
  if (st.brokeT != null) return { ok: false, reason: "扫的低点/高点已被跌破/突破" };
  if (st.tpHitT != null) return { ok: false, reason: "原 3R 止盈价已经到过" };
  const long = st.side === "LONG", tol = p.reentryTolPct;
  const inside = long ? px <= st.fvg.hi * (1 + tol) && px >= st.fvg.lo * (1 - tol) : px >= st.fvg.lo * (1 - tol) && px <= st.fvg.hi * (1 + tol);
  if (!inside) return { ok: false, reason: "价格不在原 15m 缺口附近" };
  if (long ? px <= st.stop : px >= st.stop) return { ok: false, reason: "价格已到止损外" };
  const reward = Math.abs(st.tpOrig - px), risk = Math.abs(px - st.stop);
  if (!(reward >= p.rr * risk)) return { ok: false, reason: `剩余空间不足 ${(reward / risk).toFixed(2)}R < ${p.rr}R` };
  return { ok: true, reason: `回到原入场区，剩余 ${(reward / risk).toFixed(2)}R` };
}

/** 价格离最近的有效同向缺口多远（0 = 在缺口里）。 */
export function zoneDistance(zones: readonly Zone4h[], px: number): number {
  let best = Infinity;
  for (const z of zones) {
    const d = px > z.hi ? (px - z.hi) / px : px < z.lo ? (z.lo - px) / px : 0;
    if (d < best) best = d;
  }
  return best;
}
