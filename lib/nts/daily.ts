/**
 * 每日短线（DAILY）决策：日动量（time-series momentum）。参数 4 个，全部由样本内（2025-11-01→2026-05-01，BTC/ETH 真实 1m 回放，模拟盘成本）选出：
 *   - 每天老挝时间 07:00（UTC 00:00）那根 15m 收盘后决策一次（每天最多一笔，全账户只持一笔，BTC 优先）。
 *   - 方向 = 过去 24 小时收益的符号（lookbackBars = 96 根 15m）；sides="SHORT" 时只做空（样本内选定），"BOTH" 多空都做。
 *   - 初始止损 = 进场价 ∓ k × A，A = ATR15(EMA14) × √96 / 2（≈ 日波动的一半）；同一距离做追踪止损（以进场后最有利价为基准）。
 *   - 持仓最长到 24 小时（次日 06:58 老挝时间）收盘平仓。不补仓。
 * RSI/MACD 不参与方向/放行，只随进场日志记录。
 * 诚实结论（见 docs/一页说明）：样本内 PF 1.26，样本外 PF 0.73、44 天 Gate 夹具 PF 0.36 —— 未通过样本外；默认 strategy 仍为 "SMC"。
 */
import { ema, r, trueRange } from "./indicators.ts";
import type { Bar, Side } from "./types.ts";

export type DailyCfg = { sides: "SHORT" | "BOTH"; lookbackBars: number; k: number; trail: boolean; decideUtcHour: number; holdMs: number };
export type DailyPlan = {
  symbol: string; side: Side; entry: number; stop: number; trailDist: number; exitAt: number; ret24: number; atr15: number; band: number;
  marginFirstPct: number; stopPct: number; basis: string;
};
export type DailyDecision = { action: "ENTER"; side: Side; plan: DailyPlan } | { action: "NO_TRADE"; side: Side | null; reason: string };

/** 这根 15m（开盘时间 barTime 秒）是否是当天的决策根：收盘时刻 = UTC decideUtcHour:00。 */
export const isDailyDecisionBar = (barTime: number, cfg: DailyCfg) => ((barTime + 900) % 86_400) === (cfg.decideUtcHour * 3600) % 86_400;

export function evaluateDailyEntry(sym: string, bid: number, ask: number, b15: readonly Bar[], barTime: number, cfg: DailyCfg, marginFirstPct: number, nowMs: number): DailyDecision {
  const i = b15.findIndex(b => b.time === barTime);
  if (i < 0) return { action: "NO_TRADE", side: null, reason: "决策根 15m K线缺失" };
  if (i < cfg.lookbackBars + 20) return { action: "NO_TRADE", side: null, reason: `15m K线不足 ${i}/${cfg.lookbackBars + 20}` };
  const c = b15[i]!.close, c0 = b15[i - cfg.lookbackBars]!.close;
  const ret = c / c0 - 1;
  const atr15 = ema(trueRange(b15.slice(0, i + 1)), 14).at(-1)!;
  const band = atr15 * Math.sqrt(96) / 2, dist = cfg.k * band;
  if (!(ret !== 0 && Number.isFinite(ret))) return { action: "NO_TRADE", side: null, reason: "24 小时收益为 0" };
  const side: Side = ret > 0 ? "LONG" : "SHORT";
  if (cfg.sides === "SHORT" && side === "LONG") return { action: "NO_TRADE", side, reason: `24 小时 ${(ret * 100).toFixed(2)}% 为正；本系统只做空（样本内选定）` };
  const entry = side === "LONG" ? ask : bid, stop = side === "LONG" ? entry - dist : entry + dist;
  return { action: "ENTER", side, plan: { symbol: sym, side, entry, stop, trailDist: cfg.trail ? dist : 0, exitAt: (barTime + 900) * 1000 + cfg.holdMs, ret24: r(ret, 5)!,
    atr15: r(atr15, 4)!, band: r(band, 4)!, marginFirstPct, stopPct: r(dist / entry, 5)!,
    basis: `过去24h ${(ret * 100).toFixed(2)}% → ${side === "LONG" ? "做多" : "做空"}；止损/追踪 ${cfg.k}×A（A=ATR15×√96/2=${band.toFixed(2)}）；最长持有 ${Math.round(cfg.holdMs / 3_600_000)}h` } };
  void nowMs;
}

/** 持仓中的每日系统出场：追踪止损（按最有利价）与到期平仓。硬止损由账户引擎按 stopPrice 执行。 */
export function dailyExit(o: { side: Side; best: number; stop: number; trailDist: number; exitAt: number }, px: number, nowMs: number):
  { action: "HOLD"; best: number; trail: number | null } | { action: "CLOSE"; code: "TIME" | "TRAIL"; reason: string; best: number; trail: number | null } {
  const best = o.side === "LONG" ? Math.max(o.best, px) : Math.min(o.best, px);
  const trail = o.trailDist > 0 ? (o.side === "LONG" ? Math.max(o.stop, o.best - o.trailDist) : Math.min(o.stop, o.best + o.trailDist)) : null;
  if (nowMs >= o.exitAt) return { action: "CLOSE", code: "TIME", reason: "持有满 24 小时，到期平仓", best, trail };
  if (trail != null && trail !== o.stop && (o.side === "LONG" ? px <= trail : px >= trail)) return { action: "CLOSE", code: "TRAIL", reason: `触及追踪止损 ${trail.toFixed(2)}`, best, trail };
  return { action: "HOLD", best, trail };
}
