/**
 * 决策函数（纯函数，不读时钟、不碰网络、不碰存储）。同样的输入永远得到同样的输出。
 * 流程：偏向分 → 支撑压力区 → 触发（扫荡后收回）→ 计划（止损/目标/R:R/仓位）→ 补仓 → 出场阶梯 → 当日停开（无月度熔断）。
 * RSI / MACD 只进入「显示分」和「置信度」，所有放行/否决条件只读 core 偏向分和价格结构。
 */
import type { NtsConfig } from "./config.ts";
import { dirOf, TF_SEC, type Bar, type Side, type Tf } from "./types.ts";
import { atrSeries, ema, indicatorPack, pivots, r, volumeMultiple, type IndicatorPack } from "./indicators.ts";

export type Bars = Partial<Record<Tf, Bar[]>>;
export type Packs = Partial<Record<Tf, IndicatorPack | null>>;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const sgn = (v: number | null | undefined, eps: number) => (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) <= eps ? 0 : v > 0 ? 1 : -1);

export type Snap = {
  symbol: string; now: number; bid: number; ask: number;
  funding: number | null; fundingChg: number | null; basis: number | null;
  oiChg: { h1: number | null; h4: number | null };
  longShortRatio?: number | null;
};

/** One indicator pack per timeframe, computed once per decision point. */
export function buildPacks(bars: Bars): Packs {
  const out: Packs = {};
  for (const tf of ["1d", "4h", "1h", "15m"] as Tf[]) out[tf] = bars[tf] && bars[tf]!.length >= 40 ? indicatorPack(tf, bars[tf]!) : null;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. 市场偏向分
// ---------------------------------------------------------------------------------------------------------------------
export type BiasResult = {
  /** 决策只看这个：趋势/OI/资金费/基差的加权，−1..+1 */
  core: number;
  /** 显示分 = core + RSI/MACD 小幅调整（不参与任何放行/否决） */
  score: number;
  side: Side | null;
  confidence: number;
  comps: { trend: number | null; oi: number | null; funding: number | null; basis: number | null; tf: Record<string, number | null> };
  aux: { rsi1h: number | null; rsi4h: number | null; macdH1h: number | null; macdH4h: number | null; macdDir1h: string; macdDir4h: string;
    div1h: string | null; div4h: string | null; raw: number; biasAdj: number; confAdj: number; note: string };
  unconnected: string[];
  note: string;
};

export function computeBias(snap: Snap, packs: Packs, bars: Bars, cfg: NtsConfig): BiasResult {
  const unconnected: string[] = ["多空账户比(未接入)", "季度基差(未接入)", "事件日历(未配置)"];
  const tfScores: Record<string, number | null> = {};
  let tw = 0, ts = 0;
  for (const tf of ["1d", "4h", "1h"] as const) {
    const p = packs[tf];
    if (!p || p.ema.a50 == null || p.ema.e20 == null || p.ema.e50 == null) { tfScores[tf] = null; continue; }
    const s = 0.4 * sgn(p.ema.a50, 0.0005) + 0.3 * sgn(p.ema.e20 - p.ema.e50, 0) + 0.3 * sgn(p.ema.s50, 0.0003);
    tfScores[tf] = r(s, 3); const w = cfg.tfWeights[tf]; tw += w; ts += w * s;
  }
  const trend = tw > 0 ? ts / tw : null;
  // OI 与价格：价涨 OI 涨 = 新多进场(+1)；价涨 OI 降 = 空头回补(+0.25)；镜像
  let oi: number | null = null;
  const b1 = bars["1h"];
  if (snap.oiChg.h4 != null && b1 && b1.length > 5) {
    const dp = b1[b1.length - 1]!.close / b1[b1.length - 5]!.close - 1, doi = snap.oiChg.h4;
    const m = Math.min(1, Math.abs(doi) / 0.01);
    oi = Math.abs(dp) < 0.001 ? 0 : Math.sign(dp) * (doi > 0 ? 1 : 0.25) * m;
  } else unconnected.push("OI历史不足");
  // 资金费率：极端拥挤是反向信号（温和）
  let funding: number | null = null;
  if (snap.funding != null) funding = -Math.sign(snap.funding) * clamp((Math.abs(snap.funding) - 0.0001) / 0.0004, 0, 1);
  else unconnected.push("资金费率缺失");
  let basis: number | null = null;
  if (snap.basis != null) basis = clamp(snap.basis / 0.002, -1, 1);
  else unconnected.push("永续基差缺失");
  const parts: [number | null, number][] = [[trend, cfg.biasWeights.trend], [oi, cfg.biasWeights.oi], [funding, cfg.biasWeights.funding], [basis, cfg.biasWeights.basis]];
  let wsum = 0, vsum = 0;
  for (const [v, w] of parts) if (v != null) { wsum += w; vsum += v * w; }
  const core = trend == null || wsum <= 0 ? 0 : clamp(vsum / wsum, -1, 1);
  // 辅助：RSI / MACD（1H、4H）。小幅加减分，只影响显示分与置信度。
  const a = auxAdjust(packs, cfg);
  const score = clamp(core + a.biasAdj * (core === 0 ? 0 : 1), -1, 1);
  const side: Side | null = trend == null ? null : core >= cfg.neutralBand ? "LONG" : core <= -cfg.neutralBand ? "SHORT" : null;
  const confidence = clamp(0.5 + 0.5 * Math.abs(core) + (side ? dirOf(side) * a.confSigned : 0), 0, 1);
  return { core: r(core, 4)!, score: r(score, 4)!, side, confidence: r(confidence, 3)!,
    comps: { trend: r(trend, 4), oi: r(oi, 3), funding: r(funding, 3), basis: r(basis, 3), tf: tfScores },
    aux: { ...a.view, raw: r(a.raw, 3)!, biasAdj: r(a.biasAdj, 4)!, confAdj: r(a.confSigned, 4)! },
    unconnected,
    note: trend == null ? "趋势数据不足，偏向分按0处理" : side ? `偏向${side === "LONG" ? "多" : "空"}（core ${core.toFixed(2)}）` : `core ${core.toFixed(2)} 在中性带 ±${cfg.neutralBand} 内` };
}

function auxAdjust(packs: Packs, cfg: NtsConfig) {
  const terms: number[] = [];
  const view = { rsi1h: null as number | null, rsi4h: null as number | null, macdH1h: null as number | null, macdH4h: null as number | null,
    macdDir1h: "flat", macdDir4h: "flat", div1h: null as string | null, div4h: null as string | null, note: "" };
  for (const tf of ["1h", "4h"] as const) {
    const p = packs[tf]; if (!p) continue;
    if (tf === "1h") { view.rsi1h = p.rsi; view.macdH1h = p.macd.h; view.macdDir1h = p.macd.hDir; view.div1h = p.rsiDiv ?? p.macd.div; }
    else { view.rsi4h = p.rsi; view.macdH4h = p.macd.h; view.macdDir4h = p.macd.hDir; view.div4h = p.rsiDiv ?? p.macd.div; }
    if (p.rsi != null) terms.push(p.rsi >= cfg.aux.rsiOverbought ? -1 : p.rsi <= cfg.aux.rsiOversold ? 1 : ((p.rsi - 50) / 50) * 0.3);
    if (p.macd.h != null) terms.push((p.macd.hDir === "up" ? 0.5 : p.macd.hDir === "down" ? -0.5 : 0) + (p.macd.cross === "golden" ? 0.5 : p.macd.cross === "dead" ? -0.5 : 0));
    const div = p.rsiDiv ?? p.macd.div; if (div) terms.push(div === "bull" ? 0.5 : -0.5);
  }
  const raw = terms.length ? clamp(terms.reduce((x, y) => x + y, 0) / Math.max(4, terms.length), -1, 1) : 0;
  view.note = terms.length ? "RSI/MACD 仅微调显示分与置信度，不参与放行/否决" : "RSI/MACD 数据不足";
  return { raw, biasAdj: raw * cfg.aux.maxBiasAdj, confSigned: raw * cfg.aux.maxConfAdj, view };
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. 支撑压力区
// ---------------------------------------------------------------------------------------------------------------------
export type Zone = { lo: number; hi: number; mid: number; score: number; touches: number; tfs: Tf[]; reaction: number; lastTouch: number;
  parts: { touch: number; react: number; recent: number; vol: number; tf: number; conf: number } };

export function buildZones(bars: Bars, atr1h: number, nowSec: number, cfg: NtsConfig): Zone[] {
  if (!(atr1h > 0)) return [];
  type Item = { price: number; tf: Tf; time: number; react: number; vol: number };
  const items: Item[] = [];
  for (const tf of ["15m", "1h", "4h", "1d"] as Tf[]) {
    const all = bars[tf]; if (!all || all.length < 20) continue;
    const seg = all.slice(-cfg.zone.lookback[tf]), atr = atrSeries(seg);
    for (const p of pivots(seg, cfg.zone.pivotLeft, cfg.zone.pivotRight)) {
      const after = seg.slice(p.index + 1, p.index + 11); if (!after.length) continue;
      const a = atr[p.index]; if (!Number.isFinite(a) || !(a > 0)) continue;
      const move = p.kind === "high" ? p.price - Math.min(...after.map(b => b.low)) : Math.max(...after.map(b => b.high)) - p.price;
      items.push({ price: p.price, tf, time: p.time, react: move / a, vol: volumeMultiple(seg, 20, p.index) ?? 1 });
    }
  }
  items.sort((x, y) => x.price - y.price);
  const tol = cfg.zone.clusterAtr * atr1h, clusters: Item[][] = [];
  for (const it of items) {
    const c = clusters[clusters.length - 1];
    if (c && it.price - c[0]!.price <= tol) c.push(it); else clusters.push([it]);
  }
  const zones: Zone[] = [];
  for (const c of clusters) {
    const lo = c[0]!.price, hi = c[c.length - 1]!.price, tfs = [...new Set(c.map(x => x.tf))];
    const touchS = Math.min(1, c.length / 4) * 30;
    const reaction = c.reduce((a, x) => a + x.react, 0) / c.length, reactS = Math.min(1, reaction / 3) * 20;
    const lastTouch = Math.max(...c.map(x => x.time)), ageDays = Math.max(0, (nowSec - lastTouch) / 86400), recentS = Math.exp(-ageDays / 20) * 15;
    const volS = Math.min(1, (c.reduce((a, x) => a + x.vol, 0) / c.length) / 2) * 10;
    const tfS = Math.max(...tfs.map(t => cfg.zone.tfWeight[t])) * 15, confS = ((tfs.length - 1) / 3) * 10;
    const score = touchS + reactS + recentS + volS + tfS + confS;
    const mid = (lo + hi) / 2, pad = Math.max(0, (tol * 0.5 - (hi - lo)) / 2);
    zones.push({ lo: lo - pad, hi: hi + pad, mid, score: r(score, 1)!, touches: c.length, tfs, reaction: r(reaction, 2)!, lastTouch,
      parts: { touch: r(touchS, 1)!, react: r(reactS, 1)!, recent: r(recentS, 1)!, vol: r(volS, 1)!, tf: r(tfS, 1)!, conf: r(confS, 1)! } });
  }
  return zones.filter(z => z.score >= cfg.zone.minScore).sort((a, b) => b.score - a.score).slice(0, cfg.zone.maxZones);
}
/** Zones that can act as support: their lower edge is at or below price (a zone that contains price counts). Nearest first. */
export const supportsBelow = (zones: Zone[], px: number) => zones.filter(z => z.lo <= px).sort((a, b) => Math.abs(a.mid - px) - Math.abs(b.mid - px));
export const resistancesAbove = (zones: Zone[], px: number) => zones.filter(z => z.hi >= px).sort((a, b) => Math.abs(a.mid - px) - Math.abs(b.mid - px));

// ---------------------------------------------------------------------------------------------------------------------
// 3. 触发：扫荡前低/前高后收回
// ---------------------------------------------------------------------------------------------------------------------
export type Sweep = { ok: boolean; reason: string; sweepIdx?: number; extreme?: number; depth?: number; reclaim?: Bar; reclaimVolX?: number | null;
  sweepVolX?: number | null; strength?: number };
/** `bars` are completed bars; the last one is the candidate reclaim bar. */
export function sweepReclaim(bars: readonly Bar[], zone: Zone, side: Side, cfg: NtsConfig): Sweep {
  const n = bars.length; if (n < 25) return { ok: false, reason: "15m K线不足" };
  const d = dirOf(side), level = side === "LONG" ? zone.lo : zone.hi, rc = bars[n - 1]!;
  const from = Math.max(0, n - 1 - cfg.trigger.reclaimBars);
  let idx = -1, extreme = level;
  for (let k = from; k < n; k++) {
    const b = bars[k]!;
    const hit = side === "LONG" ? b.low < level * (1 - cfg.trigger.sweepMinPct) : b.high > level * (1 + cfg.trigger.sweepMinPct);
    if (hit && (idx < 0 || (side === "LONG" ? b.low < extreme : b.high > extreme))) { idx = k; extreme = side === "LONG" ? b.low : b.high; }
  }
  if (idx < 0) return { ok: false, reason: `最近${cfg.trigger.reclaimBars + 1}根15m没有刺破区域${side === "LONG" ? "下沿" : "上沿"}` };
  const depth = Math.abs(extreme - level) / level;
  if (depth > cfg.trigger.sweepMaxPct) return { ok: false, reason: `刺破 ${(depth * 100).toFixed(2)}% 超过 ${(cfg.trigger.sweepMaxPct * 100).toFixed(2)}%，视为破位`, depth };
  const back = d * (rc.close - level) > 0;
  if (!back) return { ok: false, reason: "刺破后尚未收回区域", depth };
  for (let k = idx; k < n - 1; k++) if (d * (bars[k]!.close - level) > 0) return { ok: false, reason: "收回发生在更早的K线（已错过）", depth };
  const range = Math.max(1e-12, rc.high - rc.low);
  const strength = side === "LONG" ? (rc.close - rc.low) / range : (rc.high - rc.close) / range;
  const bodyOk = side === "LONG" ? rc.close > rc.open : rc.close < rc.open;
  const rv = volumeMultiple(bars, 20, n - 1), sv = volumeMultiple(bars, 20, idx);
  if (strength < cfg.trigger.closeStrength || !bodyOk) return { ok: false, reason: `收回K线收盘强度 ${strength.toFixed(2)} 不够或实体方向不对`, depth, strength };
  if (rv == null || rv < cfg.trigger.volMinMult) return { ok: false, reason: `收回K线量能 ${rv == null ? "—" : rv.toFixed(2)}× 不足 ${cfg.trigger.volMinMult}×`, depth, strength, reclaimVolX: rv };
  if (sv != null && sv > cfg.trigger.volMaxMult) return { ok: false, reason: `刺破那根量能 ${sv.toFixed(2)}× 超过 ${cfg.trigger.volMaxMult}×（放量砸盘不接）`, depth, strength, sweepVolX: sv };
  return { ok: true, reason: "扫荡后收回成立", sweepIdx: idx, extreme, depth, reclaim: rc, reclaimVolX: rv, sweepVolX: sv, strength };
}

/**
 * 次级触发「回踩确认」：最近 retestBars 根 15m 内价格回踩进区（多：最低价 ≤ 区上沿），期间没有收盘跌破区下沿
 * （刺破下沿不超过 sweepMaxPct），且最后一根是同向确认K线：实体同向、收盘强度达标、收盘回到区中线之上并高于前一根收盘。
 * 确认只认第一根（更早已确认 = 已错过）。空头镜像。
 */
export function retestConfirm(bars: readonly Bar[], zone: Zone, side: Side, cfg: NtsConfig): Sweep {
  const n = bars.length; if (n < 25) return { ok: false, reason: "15m K线不足" };
  const d = dirOf(side), rc = bars[n - 1]!, far = side === "LONG" ? zone.lo : zone.hi, near = side === "LONG" ? zone.hi : zone.lo;
  const from = Math.max(1, n - 1 - cfg.trigger.retestBars);
  let idx = -1, extreme = near;
  for (let k = from; k < n; k++) {
    const b = bars[k]!, touch = side === "LONG" ? b.low <= near : b.high >= near;
    if (touch && (idx < 0 || (side === "LONG" ? b.low < extreme : b.high > extreme))) { idx = k; extreme = side === "LONG" ? b.low : b.high; }
  }
  if (idx < 0) return { ok: false, reason: `最近${cfg.trigger.retestBars + 1}根15m没有回踩进区` };
  for (let k = from; k < n; k++) if (d * (bars[k]!.close - far) < 0) return { ok: false, reason: "回踩期间收盘已跌破区域（破位）" };
  const depth = Math.max(0, -d * (extreme - far) / far);
  if (depth > cfg.trigger.sweepMaxPct) return { ok: false, reason: `回踩刺破 ${(depth * 100).toFixed(2)}% 超过 ${(cfg.trigger.sweepMaxPct * 100).toFixed(2)}%`, depth };
  const range = Math.max(1e-12, rc.high - rc.low), strength = side === "LONG" ? (rc.close - rc.low) / range : (rc.high - rc.close) / range;
  const confirm = (b: Bar, prev: Bar) => {
    const st = side === "LONG" ? (b.close - b.low) / Math.max(1e-12, b.high - b.low) : (b.high - b.close) / Math.max(1e-12, b.high - b.low);
    return d * (b.close - b.open) > 0 && st >= cfg.trigger.retestStrength && d * (b.close - zone.mid) > 0 && d * (b.close - prev.close) > 0;
  };
  if (!confirm(rc, bars[n - 2]!)) return { ok: false, reason: `回踩后尚无确认K线（收盘强度 ${strength.toFixed(2)}）`, depth, strength };
  for (let k = idx + 1; k < n - 1; k++) if (confirm(bars[k]!, bars[k - 1]!)) return { ok: false, reason: "确认发生在更早的K线（已错过）", depth };
  const rv = volumeMultiple(bars, 20, n - 1), sv = volumeMultiple(bars, 20, idx);
  if (sv != null && sv > cfg.trigger.volMaxMult) return { ok: false, reason: `回踩那根量能 ${sv.toFixed(2)}× 超过 ${cfg.trigger.volMaxMult}×（放量砸盘不接）`, depth, strength, sweepVolX: sv };
  return { ok: true, reason: "回踩确认成立", sweepIdx: idx, extreme, depth, reclaim: rc, reclaimVolX: rv, sweepVolX: sv, strength };
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. 计划：止损、目标、R:R、仓位
// ---------------------------------------------------------------------------------------------------------------------
export type Geometry = { entry: number; add: number; avg: number; breakeven: number; tolerance: number; hardStop: number; firstStop: number };
export const volScale = (atr1hPct: number | null, cfg: NtsConfig) =>
  atr1hPct == null ? 1 : clamp(atr1hPct / cfg.vol.refAtr1hPct, 1, cfg.vol.maxScale);
/** 整笔最坏亏损占本金的比例（补仓后，硬止损、止损滑点、双边手续费与滑点、半天资金费）。 */
export function worstCaseLossPct(cfg: NtsConfig, scale: number, marginFirstPct: number, marginAddPct: number) {
  const notional = (marginFirstPct + marginAddPct) * cfg.leverage;
  return notional * (cfg.hardStopPct * scale + cfg.stopSlipPct + 2 * cfg.feeRate + 2 * cfg.slippagePct + 0.0001);
}
/** 保证金占本金比例：先按 1/scale 缩，再乘 sizeMult（中性带半仓等），再保证补仓后最坏亏损 ≤ 1R。 */
export function sizingPct(cfg: NtsConfig, scale: number, sizeMult: number) {
  let first = (cfg.firstMarginPct / scale) * sizeMult, add = (cfg.addMarginPct / scale) * sizeMult;
  const worst = worstCaseLossPct(cfg, scale, first, add);
  if (worst > cfg.maxLossPct * 1.0001) { const k = cfg.maxLossPct / worst; first *= k; add *= k; }
  return { first, add, worst: worstCaseLossPct(cfg, scale, first, add) };
}
export function geometry(side: Side, entry: number, add: number | null, cfg: NtsConfig, scale: number, m1 = cfg.firstMarginPct, m2 = cfg.addMarginPct): Geometry {
  const d = dirOf(side), a = add ?? entry, avg = (m1 * entry + m2 * a) / (m1 + m2);
  return { entry, add: a, avg, breakeven: avg * (1 + d * cfg.breakevenPct), tolerance: avg * (1 + d * cfg.tolerancePct),
    hardStop: avg * (1 - d * cfg.hardStopPct * scale), firstStop: entry * (1 - d * cfg.firstStopPct * scale) };
}

export type Veto = { cand: string; reason: string };
export type Plan = {
  symbol: string; side: Side; entry: number; stop: number; target: number; rr: number; stopPct: number; targetPct: number; roomPct: number;
  zone: { lo: number; hi: number; score: number; tfs: Tf[]; touches: number };
  oppZone: { lo: number; hi: number; score: number } | null;
  /** SWEEP = 扫荡后收回（主触发）；RETEST = 回踩确认（次级触发） */
  trigger: "SWEEP" | "RETEST";
  /** OPP_ZONE = 到对向区；ATR = 无对向区时按 ATR 倍数 */
  targetMode: "OPP_ZONE" | "ATR";
  /** 中性带内按触发方向开仓时为 true（仓位已乘 neutralSizeMult） */
  neutral: boolean;
  sweep: { extreme: number; depthPct: number; barTime: number; volX: number | null; sweepVolX: number | null; strength: number };
  scale: number; expectedMovePct: number;
  marginFirstPct: number; marginAddPct: number; worstLossPct: number;
  addZone: { lo: number; hi: number; score: number } | null; geo: Geometry;
};
export type EntryDecision =
  | { action: "ENTER"; side: Side; plan: Plan; vetoes: Veto[]; bias: BiasResult }
  | { action: "NO_TRADE"; side: Side | null; reason: string; vetoes: Veto[]; bias: BiasResult };

export type EntryCtx = { zones: Zone[]; atr1hPct: number | null; sizeMult: number; inEvent: string | null; dataOk: boolean; dataNote: string };

export function evaluateEntry(snap: Snap, bars: Bars, bias: BiasResult, ctx: EntryCtx, cfg: NtsConfig): EntryDecision {
  const no = (reason: string, vetoes: Veto[] = [], side: Side | null = bias.side): EntryDecision => ({ action: "NO_TRADE", side, reason, vetoes: vetoes.slice(0, cfg.log.maxVetoes), bias });
  if (!ctx.dataOk) return no(`数据不足：${ctx.dataNote}`);
  if (ctx.inEvent) return no(`事件窗口：${ctx.inEvent}`);
  const neutral = !bias.side;
  if (bias.core === 0 && bias.comps.trend == null) return no(bias.note);
  if (neutral && !(cfg.neutralSizeMult > 0)) return no(bias.note);
  const b15 = bars["15m"]; if (!b15 || b15.length < 25) return no("15m K线不足");
  const mid = (snap.bid + snap.ask) / 2, spread = (snap.ask - snap.bid) / mid;
  if (!(spread <= 0.0006)) return no(`点差 ${(spread * 1e4).toFixed(1)}bp 过大`);
  const scale = volScale(ctx.atr1hPct, cfg), vetoes: Veto[] = [];
  const stopPct = cfg.firstStopPct * scale;
  // 偏向明确：只做偏向方向。中性带：两个方向都看（偏向分更靠近的一侧优先），仓位打折。
  const sides: Side[] = bias.side ? [bias.side] : bias.core >= 0 ? ["LONG", "SHORT"] : ["SHORT", "LONG"];
  for (const side of sides) {
    const d = dirOf(side), px = side === "LONG" ? snap.ask : snap.bid;
    // 出场的"状态失效"（日线收盘在 EMA50 另一侧）此刻已成立 → 开了下一分钟就会被市价平掉，只白付手续费，不开。
    if (bars["1d"] && stateInvalidated(side, bars["1d"])) { vetoes.push({ cand: side === "LONG" ? "多" : "空", reason: "日线收盘在 EMA50 另一侧，开仓即状态失效" }); continue; }
    const cands = side === "LONG" ? supportsBelow(ctx.zones, mid) : resistancesAbove(ctx.zones, mid);
    if (!cands.length) { vetoes.push({ cand: side === "LONG" ? "多" : "空", reason: `没有${side === "LONG" ? "支撑" : "压力"}区可供触发` }); continue; }
    for (const z of cands.slice(0, 4)) {
      const tag = `${side === "LONG" ? "支撑" : "压力"}区 ${r(z.lo, 1)}~${r(z.hi, 1)}(分${z.score})`;
      let sw = sweepReclaim(b15, z, side, cfg), trig: Plan["trigger"] = "SWEEP";
      if (!sw.ok && cfg.trigger.retest) { const rt = retestConfirm(b15, z, side, cfg); if (rt.ok) { sw = rt; trig = "RETEST"; } else sw = { ...sw, reason: `${sw.reason}；回踩：${rt.reason}` }; }
      if (!sw.ok) { vetoes.push({ cand: tag, reason: sw.reason }); continue; }
      const rcClose = sw.reclaim!.close;
      if (d * (px - rcClose) / rcClose > cfg.trigger.maxChasePct) { vetoes.push({ cand: tag, reason: "已离收回价太远（追价）" }); continue; }
      const stop = px * (1 - d * stopPct);
      if (d * (sw.extreme! - stop) < 0) { vetoes.push({ cand: tag, reason: "扫荡极值比止损还远，结构止损不成立" }); continue; }
      const opp = side === "LONG" ? ctx.zones.filter(o => o.lo >= px * 1.002).sort((a, b) => a.mid - b.mid)[0]
        : ctx.zones.filter(o => o.hi <= px * 0.998).sort((a, b) => b.mid - a.mid)[0];
      let room: number, targetMode: Plan["targetMode"];
      if (opp) { room = Math.min(Math.abs((side === "LONG" ? opp.lo : opp.hi) / px - 1), cfg.maxTargetPct); targetMode = "OPP_ZONE"; }
      else if (ctx.atr1hPct != null && ctx.atr1hPct > 0 && cfg.trigger.noOppAtrMult > 0) { room = Math.min(ctx.atr1hPct * cfg.trigger.noOppAtrMult, cfg.maxTargetPct); targetMode = "ATR"; }
      else { vetoes.push({ cand: tag, reason: "前方没有对向区域且 ATR 缺失，R:R 无法评估" }); continue; }
      const rr = room / stopPct;
      if (rr < cfg.trigger.rrMin) { vetoes.push({ cand: tag, reason: `R:R ${rr.toFixed(2)} < ${cfg.trigger.rrMin}（空间 ${(room * 100).toFixed(2)}% / 止损 ${(stopPct * 100).toFixed(2)}%，${targetMode === "ATR" ? "ATR目标" : "对向区"}）` }); continue; }
      const em = (ctx.atr1hPct ?? 0) * Math.sqrt(cfg.trigger.expectedMoveHours);
      if (em < cfg.trigger.costMult * cfg.roundTripCostPct) { vetoes.push({ cand: tag, reason: `预期波动 ${(em * 100).toFixed(2)}% 不足成本 ${(cfg.trigger.costMult * cfg.roundTripCostPct * 100).toFixed(2)}%` }); continue; }
      const sz = sizingPct(cfg, scale, ctx.sizeMult * (neutral ? cfg.neutralSizeMult : 1));
      // 补仓候选区：同向、更强、在首仓外侧 distMin~distMax
      const addZ = cands.filter(o => o !== z && o.score >= z.score && o.touches >= cfg.add.minTouches && d * (o.mid - px) < 0).find(o => {
        const dist = Math.abs(o.mid / px - 1); return dist >= cfg.add.distMinPct * scale && dist <= cfg.add.distMaxPct * scale; }) ?? null;
      const target = px * (1 + d * Math.min(cfg.firstTargetPct, room));
      const geo = geometry(side, px, addZ ? (side === "LONG" ? addZ.hi : addZ.lo) : px * (1 - d * 0.005 * scale), cfg, scale, sz.first, sz.add);
      const plan: Plan = { symbol: snap.symbol, side, entry: px, stop, target, rr: r(rr, 2)!, stopPct, targetPct: Math.abs(target / px - 1), roomPct: room,
        trigger: trig, targetMode, neutral,
        zone: { lo: z.lo, hi: z.hi, score: z.score, tfs: z.tfs, touches: z.touches }, oppZone: opp ? { lo: opp.lo, hi: opp.hi, score: opp.score } : null,
        sweep: { extreme: sw.extreme!, depthPct: sw.depth!, barTime: sw.reclaim!.time, volX: r(sw.reclaimVolX, 2), sweepVolX: r(sw.sweepVolX, 2), strength: r(sw.strength, 2)! },
        scale: r(scale, 3)!, expectedMovePct: em, marginFirstPct: sz.first, marginAddPct: sz.add, worstLossPct: sz.worst,
        addZone: addZ ? { lo: addZ.lo, hi: addZ.hi, score: addZ.score } : null, geo };
      return { action: "ENTER", side, plan, vetoes: vetoes.slice(0, cfg.log.maxVetoes), bias };
    }
  }
  return no(neutral ? `${bias.note}；中性带两向都没有触发` : "没有候选区满足触发条件", vetoes);
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. 补仓 H1~H5（全部满足）+ G1~G4（至少 2 条）
// ---------------------------------------------------------------------------------------------------------------------
export type AddCheck = { ok: boolean; price: number | null; zone: Zone | null; hard: Record<"H1" | "H2" | "H3" | "H4" | "H5", { pass: boolean; why: string }>;
  soft: Record<"G1" | "G2" | "G3" | "G4", { pass: boolean | null; why: string }>; gPassed: number; reason: string };
export type OpenCtx = { side: Side; entry: number; added: boolean; scale: number; firstZoneScore: number };

export function evaluateAdd(pos: OpenCtx, snap: Snap, bars: Bars, packs: Packs, bias: BiasResult, zones: Zone[], inEvent: string | null, cfg: NtsConfig): AddCheck {
  const side = pos.side, d = dirOf(side), b15 = bars["15m"] ?? [];
  const hard = {} as AddCheck["hard"], soft = {} as AddCheck["soft"];
  const mid = (snap.bid + snap.ask) / 2;
  const cands = zones.filter(z => (side === "LONG" ? z.mid < pos.entry : z.mid > pos.entry)).sort((a, b) => Math.abs(a.mid - pos.entry) - Math.abs(b.mid - pos.entry))
    .filter(z => z.score >= pos.firstZoneScore || z.touches >= cfg.add.minTouches);
  let zone: Zone | null = null, sw: Sweep | null = null, h3why = "没有候选结构位";
  for (const z of cands) {
    const s = sweepReclaim(b15, z, side, cfg);
    if (s.ok) { zone = z; sw = s; break; }
    if (!zone) h3why = s.reason;
  }
  const price = sw?.reclaim?.close ?? null;
  const dist = price != null ? Math.abs(price / pos.entry - 1) : null;
  hard.H1 = zone ? { pass: zone.touches >= cfg.add.minTouches && zone.score >= pos.firstZoneScore, why: `结构位 ${r(zone.lo, 1)}~${r(zone.hi, 1)} 测试${zone.touches}次，分${zone.score}（需≥首仓区分${pos.firstZoneScore}）` }
    : { pass: false, why: "没有同向结构位被扫荡后收回" };
  hard.H2 = dist != null ? { pass: dist >= cfg.add.distMinPct * pos.scale && dist <= cfg.add.distMaxPct * pos.scale, why: `距首仓 ${(dist * 100).toFixed(2)}%（要求 ${(cfg.add.distMinPct * pos.scale * 100).toFixed(2)}%~${(cfg.add.distMaxPct * pos.scale * 100).toFixed(2)}%）` }
    : { pass: false, why: "无补仓价" };
  hard.H3 = { pass: !!sw, why: sw ? `刺破 ${(sw.depth! * 100).toFixed(2)}% 后收回，补仓价=收回15m收盘 ${sw.reclaim!.close}` : h3why };
  const d1 = bars["1d"] ?? [], e50 = ema(d1.map(b => b.close), 50), lastE = e50[e50.length - 1], lastC = d1[d1.length - 1]?.close;
  const stateOk = Number.isFinite(lastE) && lastC != null && d * (lastC - lastE!) > 0, sameDir = bias.side === side;
  hard.H4 = { pass: !pos.added && !inEvent && stateOk && sameDir, why: pos.added ? "已补过一次" : inEvent ? `事件窗口：${inEvent}` : !stateOk ? "日线收盘已越过EMA50（状态失效）" : !sameDir ? "偏向已不同向" : "状态仍成立、未补过、不在事件窗口" };
  const rank = packs["1h"]?.atrRank ?? null, sv = sw?.sweepVolX ?? null;
  hard.H5 = { pass: rank != null && rank <= cfg.add.atrPctMax && (sv == null || sv <= cfg.add.volMaxMult), why: `1H ATR% 分位 ${rank ?? "—"}（≤${cfg.add.atrPctMax}），刺破量能 ${sv == null ? "—" : sv.toFixed(2)}×（≤${cfg.add.volMaxMult}×）` };
  const oi = snap.oiChg.h1;
  soft.G1 = oi == null ? { pass: null, why: "OI历史不足(未接入)" } : { pass: oi <= -cfg.add.oiDropPct, why: `OI 1h 变化 ${(oi * 100).toFixed(2)}%（需下降≥${(cfg.add.oiDropPct * 100).toFixed(1)}%）` };
  soft.G2 = snap.funding == null ? { pass: null, why: "资金费率缺失" } : { pass: d * snap.funding <= cfg.add.funding, why: `资金费率 ${(snap.funding * 100).toFixed(4)}%（同向拥挤>${(cfg.add.funding * 100).toFixed(2)}%则不过）` };
  soft.G3 = sw ? { pass: (sw.strength ?? 0) >= 2 / 3, why: `收盘强度 ${(sw.strength ?? 0).toFixed(2)}（需在区间外侧1/3）` } : { pass: false, why: "无收回K线" };
  const p1 = packs["1h"], a50 = p1?.ema.a50 ?? null;
  soft.G4 = a50 == null ? { pass: null, why: "1H EMA50 数据不足" } : { pass: d * a50 > 0, why: `1H 收盘相对EMA50 ${(a50 * 100).toFixed(2)}%` };
  void mid;
  const gPassed = Object.values(soft).filter(g => g.pass === true).length;
  const hardOk = Object.values(hard).every(h => h.pass);
  const ok = hardOk && gPassed >= cfg.add.gMin;
  const reason = ok ? "H1~H5 全部满足且 G≥" + cfg.add.gMin : !hardOk ? "硬条件未齐：" + Object.entries(hard).filter(([, h]) => !h.pass).map(([k]) => k).join("/") : `评分条件仅 ${gPassed}/4`;
  return { ok, price, zone, hard, soft, gPassed, reason };
}

// ---------------------------------------------------------------------------------------------------------------------
// 6. 出场阶梯与失效
// ---------------------------------------------------------------------------------------------------------------------
export type ExitCtx = { side: Side; entry: number; avg: number; added: boolean; openedAt: number; addedAt: number | null; target: number; geo: Geometry };
export type ExitAction = { action: "HOLD" | "CLOSE"; reason: string; code: string; stage: string; targetPrice: number | null };
/** `bid` is the executable exit price (bid for a long, ask for a short). Hard stop / liquidation are handled by the paper engine. */
export function exitAction(p: ExitCtx, exitPx: number, now: number, stateInvalid: boolean, cfg: NtsConfig): ExitAction {
  const d = dirOf(p.side), H = 3_600_000;
  if (stateInvalid) return { action: "CLOSE", reason: "状态失效：日线收盘越过 EMA50，市价平仓", code: "STATE_INVALID", stage: "失效", targetPrice: null };
  if (p.added && p.addedAt != null) {
    const h = (now - p.addedAt) / H;
    if (h >= cfg.timeStopH) return { action: "CLOSE", reason: `补仓后满 ${cfg.timeStopH}h，市价平仓`, code: "TIME_12H", stage: "12h", targetPrice: null };
    if (h >= cfg.toleranceFromH) {
      const hit = d * (exitPx - p.geo.tolerance) >= 0;
      return { action: hit ? "CLOSE" : "HOLD", reason: hit ? "6~12h：回到均价+0.05%，容差价平仓" : "6~12h：等容差价", code: "TOLERANCE", stage: "6-12h", targetPrice: p.geo.tolerance };
    }
    const hit = d * (exitPx - p.geo.breakeven) >= 0;
    return { action: hit ? "CLOSE" : "HOLD", reason: hit ? "0~6h：回到保本价，平仓" : "0~6h：只在保本价平", code: "BREAKEVEN", stage: "0-6h", targetPrice: p.geo.breakeven };
  }
  if (d * (exitPx - p.target) >= 0) return { action: "CLOSE", reason: "未补仓：到达目标", code: "TARGET", stage: "未补仓", targetPrice: p.target };
  const h = (now - p.openedAt) / H;
  if (h >= cfg.unaddedTimeStopH && d * (exitPx / p.entry - 1) < cfg.unaddedTimeStopGainPct && Math.abs(exitPx / p.entry - 1) <= 0.003)
    return { action: "CLOSE", reason: `未补仓 ${cfg.unaddedTimeStopH}h 仍无 +${cfg.unaddedTimeStopGainPct * 100}% 浮盈且在入场价附近，时间失效`, code: "TIME_8H", stage: "未补仓", targetPrice: p.target };
  return { action: "HOLD", reason: "持有", code: "HOLD", stage: "未补仓", targetPrice: p.target };
}
/** 日线状态失效：多头日线收盘在 EMA50 下方；空头镜像。 */
export function stateInvalidated(side: Side, daily: readonly Bar[]) {
  if (daily.length < 55) return false;
  const e = ema(daily.map(b => b.close), 50), v = e[e.length - 1], c = daily[daily.length - 1]!.close;
  return Number.isFinite(v) && dirOf(side) * (c - v!) < 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// 7. 当日停开（月度熔断已移除）
// ---------------------------------------------------------------------------------------------------------------------
export type BreakerState = { state: "OK" | "STOP_DAY"; sizeMult: number; allowEntry: boolean; reason: string; monthPct: number; dayR: number };
/** monthPnl / dayPnl are realised net PnL of this system in account currency; startEquity is the month's opening equity. */
export function breakerState(i: { monthPnl: number; monthStartEquity: number; dayPnl: number; oneR: number }, cfg: NtsConfig): BreakerState {
  const monthPct = i.monthStartEquity > 0 ? i.monthPnl / i.monthStartEquity : 0, dayR = i.oneR > 0 ? i.dayPnl / i.oneR : 0;
  if (dayR <= -cfg.breaker.dayStopR) return { state: "STOP_DAY", sizeMult: 0, allowEntry: false, reason: `今日 ${dayR.toFixed(2)}R ≤ −${cfg.breaker.dayStopR}R，今日停止新开仓`, monthPct, dayR };
  return { state: "OK", sizeMult: 1, allowEntry: true, reason: "正常", monthPct, dayR };
}
export const tfSeconds = (tf: Tf) => TF_SEC[tf];
