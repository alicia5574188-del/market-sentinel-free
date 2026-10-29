/**
 * SMC 订单块（Order Block）决策引擎 —— 按用户给的视频（TradingAI SMC Order Block 方法）实现。纯函数：不读时钟、不碰网络与存储。
 *
 * 1. 订单块定义（视频原样）
 *    看涨订单块 OB+（需求区）：一根阴线，下一根强阳线的实体完全吞没它的实体，并且之后（confirmBars 根内）有收盘价突破这根阴线的最高价；
 *    这根阴线的整根K线范围（最低~最高）= 需求区。看跌订单块 OB−（供给区）镜像。
 * 2. 离开与回踩：价格必须先完全离开区域（出现一根整根在区外的K线 = 位移），之后再回到区里；只在回到区里时找反转信号。
 *    区被收盘价穿透（多头区收盘跌破区下沿）即作废；回踩次数超过 maxPriorVisits 的区不再用（视频：新鲜的区最有效）。
 * 3. 多周期：1D 订单块 = 大级别支撑压力；4H 市场结构（HH/HL vs LH/LL，结构突破 BOS）= 趋势方向；1H 订单块 + 15m 反转信号 = 日内执行。
 *    顺势优先：4H 上升结构只做需求区多单、下降结构只做供给区空单（1H/4H/1D 区均可）。
 *    逆势：只在 4H/1D 级别的强区、且有 15m 反转确认时才做。
 * 4. 15m 反转信号（在区内出现）：吞没形态；或双底/双顶（两个摆动低点都在区内且高度接近，随后收盘突破两者之间的颈线）。
 * 5. 止损：区外一点（区下沿 − stopAtrBuf × ATR(1H)）。目标：TP1 = 最近的对向订单块 / 4H 未被扫掉的摆动高低点（流动性）；TP2 = 再下一个（只记录）。
 * 6. FVG（公允价值缺口）：计算并记录；订单块的位移段里有同向 FVG 记为「有 FVG 共振」，只用于候选排序，不是硬条件。
 * 7. 仓位按用户固定规则（不在这里改）：首仓 2% 本金保证金、100 倍全仓，最多补一次 +3%（价格走到区的 50%「均衡位」且结构仍成立），
 *    补仓后回到保本价附近离场，硬止损始终在区外。1R（整笔最坏亏损）= 5% 本金：首仓最坏亏损超过 1R 不开；补仓后会超过 1R 就不补。
 * RSI/MACD 只进显示分（computeBias 的 aux），其它指标只记录，都不参与这里的放行/否决。
 */
import type { NtsConfig } from "./config.ts";
import { dirOf, type Bar, type Side, type Tf } from "./types.ts";
import { atrSeries, pivots, r } from "./indicators.ts";

export type Bars = Partial<Record<Tf, Bar[]>>;
export type ObKind = "DEMAND" | "SUPPLY";
export type OrderBlock = {
  tf: Tf; kind: ObKind; lo: number; hi: number; t: number; confirmT: number; leftT: number | null;
  /** 区自身周期上已经结束的回踩次数（不含正在进行的这一次） */
  priorVisits: number; inside: boolean; invalid: boolean; fvg: boolean;
};
export type Fvg = { tf: Tf; kind: "BULL" | "BEAR"; lo: number; hi: number; t: number; filled: boolean };
export type Structure = { trend: "UP" | "DOWN" | "NONE"; bosT: number | null; bosLevel: number | null; highs: string; lows: string; swingHighs: number[]; swingLows: number[] };

/** 订单块识别 + 生命周期（离开 → 回踩次数 → 收盘穿透作废），只看已收盘的K线。 */
export function findOrderBlocks(bars: readonly Bar[], tf: Tf, cfg: NtsConfig): OrderBlock[] {
  const out: OrderBlock[] = [], n = bars.length, C = cfg.smc.confirmBars;
  for (let i = 0; i + 1 < n; i++) {
    const a = bars[i]!, b = bars[i + 1]!;
    for (const kind of ["DEMAND", "SUPPLY"] as ObKind[]) {
      const up = kind === "DEMAND";
      // 阴线 + 下一根阳线实体完全吞没阴线实体（看涨）；镜像（看跌）
      const ok = up ? a.close < a.open && b.close > b.open && b.open <= a.close && b.close >= a.open
        : a.close > a.open && b.close < b.open && b.open >= a.close && b.close <= a.open;
      if (!ok) continue;
      let confirm = -1;
      for (let j = i + 1; j < Math.min(n, i + 1 + C); j++) if (up ? bars[j]!.close > a.high : bars[j]!.close < a.low) { confirm = j; break; }
      if (confirm < 0) continue;
      const lo = a.low, hi = a.high;
      let fvg = false;
      for (let k = i + 1; k <= Math.min(n - 2, confirm + 1); k++) {
        const p = bars[k - 1]!, q = bars[k + 1]!;
        if (up ? q.low > p.high : q.high < p.low) { fvg = true; break; }
      }
      let leftT: number | null = null, outside = false, visits = 0, invalid = false;
      for (let m = confirm; m < n; m++) {
        const x = bars[m]!;
        if (up ? x.close < lo : x.close > hi) { invalid = true; break; }
        if (leftT == null) { if (up ? x.low > hi : x.high < lo) { leftT = x.time; outside = true; } continue; }
        const touch = up ? x.low <= hi : x.high >= lo;
        if (outside && touch) { visits++; outside = false; } else if (!outside && !touch) outside = true;
      }
      if (invalid) continue;
      out.push({ tf, kind, lo, hi, t: a.time, confirmT: bars[confirm]!.time, leftT, priorVisits: outside ? visits : Math.max(0, visits - 1), inside: leftT != null && !outside, invalid, fvg });
    }
  }
  return out;
}

/** 三根K线的公允价值缺口；被后续价格完全回补的标 filled。 */
export function findFvgs(bars: readonly Bar[], tf: Tf, keep = 12): Fvg[] {
  const out: Fvg[] = [];
  for (let k = 1; k + 1 < bars.length; k++) {
    const p = bars[k - 1]!, q = bars[k + 1]!;
    let g: Fvg | null = null;
    if (q.low > p.high) g = { tf, kind: "BULL", lo: p.high, hi: q.low, t: bars[k]!.time, filled: false };
    else if (q.high < p.low) g = { tf, kind: "BEAR", lo: q.high, hi: p.low, t: bars[k]!.time, filled: false };
    if (!g) continue;
    for (let m = k + 2; m < bars.length; m++) if (g.kind === "BULL" ? bars[m]!.low <= g.lo : bars[m]!.high >= g.hi) { g.filled = true; break; }
    out.push(g);
  }
  return out.filter(g => !g.filled).slice(-keep);
}

/** 4H 市场结构：摆动点（左右各 pivot4h 根）+ 结构突破（收盘越过最近一个已确认摆动高/低点）。 */
export function marketStructure(bars: readonly Bar[], cfg: NtsConfig): Structure {
  const L = cfg.smc.pivot4h, ps = pivots(bars, L, L);
  let trend: Structure["trend"] = "NONE", bosT: number | null = null, bosLevel: number | null = null;
  let lastH: { price: number; used: boolean } | null = null, lastL: { price: number; used: boolean } | null = null, pi = 0;
  for (let i = 0; i < bars.length; i++) {
    while (pi < ps.length && ps[pi]!.index + L <= i) { const p = ps[pi++]!; if (p.kind === "high") lastH = { price: p.price, used: false }; else lastL = { price: p.price, used: false }; }
    const c = bars[i]!.close;
    if (lastH && !lastH.used && c > lastH.price) { trend = "UP"; bosT = bars[i]!.time; bosLevel = lastH.price; lastH.used = true; }
    if (lastL && !lastL.used && c < lastL.price) { trend = "DOWN"; bosT = bars[i]!.time; bosLevel = lastL.price; lastL.used = true; }
  }
  const hs = ps.filter(p => p.kind === "high").slice(-2), ls = ps.filter(p => p.kind === "low").slice(-2);
  const lab = (xs: typeof hs, up: string, dn: string) => xs.length < 2 ? "—" : xs[1]!.price > xs[0]!.price ? up : dn;
  // 还没被价格扫掉的摆动高/低点 = 流动性（目标候选）
  const swingHighs: number[] = [], swingLows: number[] = [];
  for (const p of ps) {
    const after = bars.slice(p.index + 1);
    if (p.kind === "high" && !after.some(b => b.high > p.price)) swingHighs.push(p.price);
    if (p.kind === "low" && !after.some(b => b.low < p.price)) swingLows.push(p.price);
  }
  return { trend, bosT, bosLevel, highs: lab(hs, "HH", "LH"), lows: lab(ls, "HL", "LL"), swingHighs, swingLows };
}

export type Signal = { kind: "ENGULF" | "DOUBLE"; barTime: number; extreme: number; note: string };
/** 15m 反转确认：最后一根已收盘 15m K线完成吞没，或完成双底/双顶颈线突破；形态的极值必须在区内（不能已收盘穿透区）。 */
export function reversalSignal(b15: readonly Bar[], z: OrderBlock, side: Side, atr15: number, cfg: NtsConfig): Signal | null {
  const n = b15.length; if (n < 3) return null;
  const c = b15[n - 1]!, p = b15[n - 2]!, up = side === "LONG";
  const inZone = (x: number) => x >= z.lo && x <= z.hi;
  const touched = (bar: Bar) => (up ? bar.low <= z.hi && bar.low >= z.lo - 1e-9 : bar.high >= z.lo && bar.high <= z.hi + 1e-9) || (up ? bar.low <= z.hi && bar.close >= z.lo : bar.high >= z.lo && bar.close <= z.hi);
  if (up ? c.close < z.lo : c.close > z.hi) return null;
  const eng = up ? p.close < p.open && c.close > c.open && c.open <= p.close && c.close >= p.open
    : p.close > p.open && c.close < c.open && c.open >= p.close && c.close <= p.open;
  if (eng && (touched(p) || touched(c))) {
    const ext = up ? Math.min(p.low, c.low) : Math.max(p.high, c.high);
    return { kind: "ENGULF", barTime: c.time, extreme: ext, note: up ? "15m 看涨吞没" : "15m 看跌吞没" };
  }
  // 双底 / 双顶
  const W = cfg.smc.doubleWindow, seg = b15.slice(Math.max(0, n - W)), off = n - seg.length;
  const ps = pivots(seg, 2, 2).filter(x => x.kind === (up ? "low" : "high"));
  for (let a = ps.length - 1; a >= 1; a--) {
    const p2 = ps[a]!, p1 = ps[a - 1]!;
    if (p2.index - p1.index < 3) continue;
    if (!inZone(p1.price) || !inZone(p2.price)) continue;
    if (Math.abs(p1.price - p2.price) > cfg.smc.doubleTolAtr * atr15) continue;
    const mid = seg.slice(p1.index, p2.index + 1), neck = up ? Math.max(...mid.map(b => b.high)) : Math.min(...mid.map(b => b.low));
    const brokeNow = up ? c.close > neck && p.close <= neck : c.close < neck && p.close >= neck;
    const between = seg.slice(p2.index + 1, seg.length - 1).every(b => (up ? b.close <= neck && b.close >= z.lo : b.close >= neck && b.close <= z.hi));
    if (brokeNow && between) return { kind: "DOUBLE", barTime: c.time, extreme: up ? Math.min(p1.price, p2.price) : Math.max(p1.price, p2.price), note: `${up ? "双底" : "双顶"} ${r(p1.price, 2)}/${r(p2.price, 2)} 颈线 ${r(neck, 2)}（第${p1.index + off}/${p2.index + off}根）` };
    break;
  }
  return null;
}

export type SmcPlan = {
  symbol: string; side: Side; entry: number; stop: number; target: number; tp2: number | null; rr: number; stopPct: number; targetPct: number;
  zone: { tf: Tf; kind: ObKind; lo: number; hi: number; t: number; priorVisits: number; fvg: boolean; score: number; tfs: Tf[]; touches: number };
  mode: "TREND" | "COUNTER"; trigger: "ENGULF" | "DOUBLE"; targetSrc: string; tp2Src: string | null;
  structure: { h4: Structure["trend"]; bosT: number | null; highs: string; lows: string; d1: Structure["trend"] };
  signal: Signal; sweep: Signal; addPrice: number | null; addAllowed: boolean; addNote: string;
  marginFirstPct: number; marginAddPct: number; worstFirstPct: number; worstLossPct: number;
  geo: { entry: number; add: number; avg: number; breakeven: number; tolerance: number; hardStop: number; firstStop: number };
  fvgNear: { kind: string; tf: Tf; lo: number; hi: number }[];
};
export type SmcVeto = { cand: string; reason: string };
export type SmcDecision =
  | { action: "ENTER"; side: Side; plan: SmcPlan; vetoes: SmcVeto[] }
  | { action: "NO_TRADE"; side: Side | null; reason: string; vetoes: SmcVeto[] };
export type SmcCtx = { atr1h: number | null; atr15: number | null; dataOk: boolean; dataNote: string; inEvent: string | null };
export type SmcView = { obs: OrderBlock[]; h4: Structure; d1: Structure; fvgs: Fvg[] };

/** 所有周期的订单块、4H/1D 结构、FVG：每个决策点算一次。 */
export function smcView(bars: Bars, cfg: NtsConfig): SmcView {
  const obs: OrderBlock[] = [];
  for (const tf of cfg.smc.obTfs) { const b = bars[tf]; if (b && b.length > 10) obs.push(...findOrderBlocks(b, tf, cfg)); }
  const empty: Structure = { trend: "NONE", bosT: null, bosLevel: null, highs: "—", lows: "—", swingHighs: [], swingLows: [] };
  const fvgs = [...(bars["1h"] ? findFvgs(bars["1h"], "1h", 8) : []), ...(bars["4h"] ? findFvgs(bars["4h"], "4h", 6) : [])];
  return { obs, h4: bars["4h"] ? marketStructure(bars["4h"], cfg) : empty, d1: bars["1d"] ? marketStructure(bars["1d"], cfg) : empty, fvgs };
}

/** 固定仓位下的最坏亏损（占本金）：名义 = 保证金 × 杠杆；价格亏损 + 止损滑点 + 双边手续费与滑点。 */
export function worstLoss(cfg: NtsConfig, legs: { margin: number; price: number }[], stop: number) {
  let loss = 0;
  for (const l of legs) { const notional = l.margin * cfg.leverage; loss += notional * (Math.abs(l.price - stop) / l.price + cfg.stopSlipPct + 2 * cfg.feeRate + 2 * cfg.slippagePct); }
  return loss;
}
const TF_RANK: Record<Tf, number> = { "15m": 0, "1h": 1, "4h": 2, "1d": 3 };

export function evaluateSmcEntry(symbol: string, bid: number, ask: number, bars: Bars, view: SmcView, ctx: SmcCtx, cfg: NtsConfig): SmcDecision {
  const no = (reason: string, vetoes: SmcVeto[] = [], side: Side | null = null): SmcDecision => ({ action: "NO_TRADE", side, reason, vetoes: vetoes.slice(0, cfg.log.maxVetoes) });
  if (!ctx.dataOk) return no(`数据不足：${ctx.dataNote}`);
  if (ctx.inEvent) return no(`事件窗口：${ctx.inEvent}`);
  const b15 = bars["15m"]; if (!b15 || b15.length < 30 || !ctx.atr1h || !ctx.atr15) return no("15m K线或 ATR 不足");
  const mid = (bid + ask) / 2;
  if (!((ask - bid) / mid <= 0.0006)) return no(`点差 ${(((ask - bid) / mid) * 1e4).toFixed(1)}bp 过大`);
  const h4 = view.h4.trend, vetoes: SmcVeto[] = [];
  const last = b15[b15.length - 1]!;
  // 15m 最后一根已收盘K线接触到的、已离开过、足够新鲜、尚未作废的订单块
  const touching = view.obs.filter(z => z.leftT != null && z.leftT < last.time && z.priorVisits <= cfg.smc.maxPriorVisits &&
    (z.kind === "DEMAND" ? Math.min(last.low, b15[b15.length - 2]!.low) <= z.hi && last.close >= z.lo : Math.max(last.high, b15[b15.length - 2]!.high) >= z.lo && last.close <= z.hi));
  if (!touching.length) return no(`价格不在任何有效订单块内（4H 结构 ${h4}）`);
  type Cand = { z: OrderBlock; side: Side; mode: "TREND" | "COUNTER" };
  const cands: Cand[] = [];
  for (const z of touching) {
    const side: Side = z.kind === "DEMAND" ? "LONG" : "SHORT", trendOk = (side === "LONG" && h4 === "UP") || (side === "SHORT" && h4 === "DOWN");
    const tag = `${z.tf} ${z.kind === "DEMAND" ? "需求区" : "供给区"} ${r(z.lo, 1)}~${r(z.hi, 1)}`;
    if (trendOk) cands.push({ z, side, mode: "TREND" });
    else if (TF_RANK[z.tf] >= TF_RANK["4h"]) cands.push({ z, side, mode: "COUNTER" });
    else vetoes.push({ cand: tag, reason: `逆 4H 结构（${h4}）且只是 1H 区，不做逆势` });
  }
  cands.sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "TREND" ? -1 : 1) || TF_RANK[b.z.tf] - TF_RANK[a.z.tf] || Number(b.z.fvg) - Number(a.z.fvg));
  for (const { z, side, mode } of cands) {
    const d = dirOf(side), px = side === "LONG" ? ask : bid, tag = `${z.tf} ${side === "LONG" ? "需求区" : "供给区"} ${r(z.lo, 1)}~${r(z.hi, 1)}${mode === "COUNTER" ? "（逆势）" : ""}`;
    // 15m 收盘已穿透区：区作废（区自身周期还没收盘，这里先按 15m 判）
    const visitStart = b15.findIndex(b => b.time >= (z.leftT ?? 0));
    if (visitStart >= 0 && b15.slice(visitStart).some(b => (side === "LONG" ? b.close < z.lo : b.close > z.hi))) { vetoes.push({ cand: tag, reason: "15m 收盘已穿透订单块，区作废" }); continue; }
    const sig = reversalSignal(b15, z, side, ctx.atr15, cfg);
    if (!sig) { vetoes.push({ cand: tag, reason: "区内还没有 15m 反转信号（吞没/双底双顶）" }); continue; }
    const stop = (side === "LONG" ? Math.min(z.lo, sig.extreme) : Math.max(z.hi, sig.extreme)) - d * cfg.smc.stopAtrBuf * ctx.atr1h;
    const risk = d * (px - stop);
    if (!(risk > 0)) { vetoes.push({ cand: tag, reason: "入场价已在止损外侧" }); continue; }
    // 目标：对向订单块的近边 + 4H 未被扫的摆动点（流动性），按距离排序
    const lv: { p: number; src: string }[] = [];
    for (const o of view.obs) if (o.kind !== z.kind && o.leftT != null) { const p = side === "LONG" ? o.lo : o.hi; if (d * (p - px) > 0) lv.push({ p, src: `${o.tf} 对向订单块` }); }
    for (const p of side === "LONG" ? view.h4.swingHighs : view.h4.swingLows) if (d * (p - px) > 0) lv.push({ p, src: "4H 摆动点流动性" });
    lv.sort((a, b) => d * (a.p - b.p));
    let tp1 = lv[0] ?? null, tp2 = lv.find(x => tp1 && d * (x.p - tp1.p) > risk * 0.5) ?? null;
    if (!tp1) { tp1 = { p: px + d * cfg.smc.noTargetRR * risk, src: `前方无对向区/流动性：${cfg.smc.noTargetRR}R` }; tp2 = null; }
    const rr = d * (tp1.p - px) / risk;
    if (rr < cfg.smc.rrMin) { vetoes.push({ cand: tag, reason: `R:R ${rr.toFixed(2)} < ${cfg.smc.rrMin}（TP1 ${r(tp1.p, 2)} ${tp1.src}，止损 ${r(stop, 2)}）` }); continue; }
    const m1 = cfg.firstMarginPct, m2 = cfg.addMarginPct;
    const worstFirst = worstLoss(cfg, [{ margin: m1, price: px }], stop);
    if (worstFirst > cfg.maxLossPct) { vetoes.push({ cand: tag, reason: `区太宽：止损 ${((risk / px) * 100).toFixed(2)}%，首仓最坏亏损 ${(worstFirst * 100).toFixed(2)}% > 1R ${(cfg.maxLossPct * 100).toFixed(0)}%` }); continue; }
    const zMid = z.lo + (z.hi - z.lo) * cfg.smc.addAt;
    let addPrice: number | null = cfg.smc.add === false ? null : d * (px - zMid) > 0 ? zMid : null,
      addNote = cfg.smc.add === false ? "配置不补仓（smc.add=false）：只拿首仓到 TP1 或止损" : addPrice ? `区 ${cfg.smc.addAt * 100}% 位 ${r(zMid, 2)}` : "入场已在区的均衡位以内，不补";
    let worstAll = worstFirst;
    if (addPrice != null) {
      worstAll = worstLoss(cfg, [{ margin: m1, price: px }, { margin: m2, price: addPrice }], stop);
      if (worstAll > cfg.maxLossPct) { addNote = `补仓后最坏亏损 ${(worstAll * 100).toFixed(2)}% > 1R，本笔不补`; addPrice = null; worstAll = worstFirst; }
    }
    const a = addPrice ?? px, avg = addPrice != null ? (m1 * px + m2 * a) / (m1 + m2) : px;
    const geo = { entry: px, add: a, avg, breakeven: avg * (1 + d * cfg.breakevenPct), tolerance: avg * (1 + d * cfg.breakevenPct), hardStop: stop, firstStop: stop };
    const fvgNear = view.fvgs.filter(g => Math.abs((g.lo + g.hi) / 2 / px - 1) < 0.03).slice(-4).map(g => ({ kind: g.kind, tf: g.tf, lo: r(g.lo, 2)!, hi: r(g.hi, 2)! }));
    const plan: SmcPlan = {
      symbol, side, entry: px, stop, target: tp1.p, tp2: tp2?.p ?? null, rr: r(rr, 2)!, stopPct: risk / px, targetPct: Math.abs(tp1.p / px - 1),
      zone: { tf: z.tf, kind: z.kind, lo: z.lo, hi: z.hi, t: z.t, priorVisits: z.priorVisits, fvg: z.fvg, score: TF_RANK[z.tf], tfs: [z.tf], touches: z.priorVisits + 1 },
      mode, trigger: sig.kind, targetSrc: tp1.src, tp2Src: tp2?.src ?? null,
      structure: { h4, bosT: view.h4.bosT, highs: view.h4.highs, lows: view.h4.lows, d1: view.d1.trend },
      signal: sig, sweep: sig, addPrice, addAllowed: addPrice != null, addNote,
      marginFirstPct: m1, marginAddPct: addPrice != null ? m2 : 0, worstFirstPct: worstFirst, worstLossPct: worstAll, geo, fvgNear,
    };
    return { action: "ENTER", side, plan, vetoes: vetoes.slice(0, cfg.log.maxVetoes) };
  }
  return no(vetoes[0]?.reason ?? "没有候选", vetoes);
}

export type SmcOpen = { side: Side; added: boolean; addPrice: number | null; zone: { lo: number; hi: number }; mode: "TREND" | "COUNTER"; target: number; breakeven: number };
/** 补仓：价格走到区的均衡位，且结构仍成立（15m 没有收盘穿透区；顺势单的 4H 结构没有翻转）。 */
export function smcAddCheck(o: SmcOpen, px: number, b15: readonly Bar[], h4: Structure["trend"]) {
  if (o.added || o.addPrice == null) return { ok: false, reason: o.added ? "已补过一次" : "本笔不补仓" };
  const d = dirOf(o.side);
  if (d * (px - o.addPrice) > 0) return { ok: false, reason: "未到补仓位" };
  const lastC = b15[b15.length - 1]?.close;
  if (lastC != null && (o.side === "LONG" ? lastC < o.zone.lo : lastC > o.zone.hi)) return { ok: false, reason: "15m 收盘已穿透区，结构不成立，不补" };
  if (o.mode === "TREND" && h4 !== (o.side === "LONG" ? "UP" : "DOWN")) return { ok: false, reason: `4H 结构已变为 ${h4}，不补` };
  return { ok: true, reason: `到达区均衡位 ${r(o.addPrice, 2)}，结构仍成立` };
}
/** 出场：未补仓到 TP1 全平；补仓后回到保本价（均价 + breakevenPct，覆盖来回成本）平。硬止损由账户引擎按区外止损价执行。 */
export function smcExit(o: SmcOpen, exitPx: number) {
  const d = dirOf(o.side);
  if (o.added) {
    if (d * (exitPx - o.breakeven) >= 0) return { action: "CLOSE" as const, code: "BREAKEVEN", reason: "补仓后回到保本价，平仓", stage: "已补仓" };
    return { action: "HOLD" as const, code: "HOLD", reason: "补仓后等保本价", stage: "已补仓" };
  }
  if (d * (exitPx - o.target) >= 0) return { action: "CLOSE" as const, code: "TARGET", reason: "到达 TP1（最近对向订单块/流动性）", stage: "未补仓" };
  return { action: "HOLD" as const, code: "HOLD", reason: "持有，等 TP1", stage: "未补仓" };
}
export { atrSeries };
