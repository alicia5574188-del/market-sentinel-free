/** 只管显示：FVG 单 +1R 后止损移到保本价（入场价往盈利方向 1 tick），被打到时账户引擎记的是通用的 STRUCTURE_STOP。
 *  这里把它认出来，面板写成"保本止损"并带上原止损。不改任何交易规则。 */
export type BeTradeLike = { side: "LONG" | "SHORT"; entryPrice: number; stopPrice: number; status: "OPEN" | "CLOSED"; exitReason: string | null;
  rule?: { id?: string } | null; entryContext?: { living?: unknown } | null; breakeven?: { origStop: number; stop: number; at: number } | null };
const fmt = (v: number) => { const a = Math.abs(v); const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8; return v.toFixed(d).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1"); };
export function beInfo(t: BeTradeLike): { origStop: number | null; stop: number } | null {
  if (t.breakeven && t.breakeven.stop > 0) return { origStop: t.breakeven.origStop > 0 ? t.breakeven.origStop : null, stop: t.stopPrice || t.breakeven.stop };
  // 老记录没有 breakeven 字段：NTS 单（非 living）止损在入场价的盈利一侧（或等于入场价）= 保本止损，原止损没记下
  if (t.rule?.id !== "nts-v1" || t.entryContext?.living || !(t.stopPrice > 0) || !(t.entryPrice > 0)) return null;
  const d = t.side === "LONG" ? 1 : -1;
  return d * (t.stopPrice - t.entryPrice) >= 0 ? { origStop: null, stop: t.stopPrice } : null;
}
export const beStopFact = (t: BeTradeLike) => { const b = beInfo(t); if (!b) return null;
  return { label: "保本止损", value: `${fmt(b.stop)}（原止损 ${b.origStop != null ? fmt(b.origStop) : "没记下"}）` }; };
export const beExitShort = (t: BeTradeLike) => (t.status === "CLOSED" && t.exitReason === "STRUCTURE_STOP" && beInfo(t) ? "保本止损" : null);
export function beExitPlain(t: BeTradeLike) {
  if (t.status !== "CLOSED" || t.exitReason !== "STRUCTURE_STOP") return null;
  const b = beInfo(t); if (!b) return null;
  return `保本止损：价格先到 +1R，止损从原止损 ${b.origStop != null ? fmt(b.origStop) : "（没记下）"} 移到保本价 ${fmt(b.stop)}（入场价 ${fmt(t.entryPrice)} 往盈利方向 1 tick），之后价格回到这里平仓。保本价只多 1 tick，手续费会让这笔小亏。`;
}
