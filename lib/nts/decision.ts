/**
 * 辅助记录（纯函数）：指标包、偏向分（只记录/显示，不参与 SMC 订单块的放行/否决）、当日停开。
 * 进出场决策在 smc.ts（视频的订单块方法）。旧的「偏向+区+扫荡/回踩」入场、H/G 补仓、6~12h 出场阶梯已删除。
 * RSI / MACD 只进入「显示分」和「置信度」。
 */
import type { NtsConfig } from "./config.ts";
import { dirOf, type Bar, type Side, type Tf } from "./types.ts";
import { indicatorPack, r, type IndicatorPack } from "./indicators.ts";

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

export type Geometry = { entry: number; add: number; avg: number; breakeven: number; tolerance: number; hardStop: number; firstStop: number };
export type BreakerState = { state: "OK" | "STOP_DAY"; sizeMult: number; allowEntry: boolean; reason: string; monthPct: number; dayR: number };
/** 当日停开：当日已实现亏损 ≤ −dayStopR × 1R 后当日不再开新仓（无月度熔断）。 */
export function breakerState(i: { monthPnl: number; monthStartEquity: number; dayPnl: number; oneR: number }, cfg: NtsConfig): BreakerState {
  const monthPct = i.monthStartEquity > 0 ? i.monthPnl / i.monthStartEquity : 0, dayR = i.oneR > 0 ? i.dayPnl / i.oneR : 0;
  if (dayR <= -cfg.breaker.dayStopR) return { state: "STOP_DAY", sizeMult: 0, allowEntry: false, reason: `今日 ${dayR.toFixed(2)}R ≤ −${cfg.breaker.dayStopR}R，今日停止新开仓`, monthPct, dayR };
  return { state: "OK", sizeMult: 1, allowEntry: true, reason: "正常", monthPct, dayR };
}
