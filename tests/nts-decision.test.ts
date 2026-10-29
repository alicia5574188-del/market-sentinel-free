import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_NTS_CONFIG as C, normalizeNtsConfig } from "../lib/nts/config.ts";
import { breakerState, buildPacks, computeBias } from "../lib/nts/decision.ts";
import { evaluateSmcEntry, findFvgs, findOrderBlocks, marketStructure, reversalSignal, smcAddCheck, smcExit, worstLoss, type OrderBlock } from "../lib/nts/smc.ts";
import type { Bar } from "../lib/nts/types.ts";
import { down, snap, up, smcLongBars, smcLongView, SMC_CTX, T0 } from "./nts-fixtures.ts";

const trendBars = (f: typeof up) => ({ "1d": f(260, 86400), "4h": f(300, 14400), "1h": f(300, 3600), "15m": f(300, 900) });

test("bias: 多周期上升 → 偏多；下降 → 偏空；横盘 → 中性带内不交易", () => {
  const u = trendBars(up), d = trendBars(down), f = { ...trendBars(down), "1d": up(260, 86400) };
  const bu = computeBias(snap(), buildPacks(u), u, C), bd = computeBias(snap(), buildPacks(d), d, C), bf = computeBias(snap(), buildPacks(f), f, C);
  assert.equal(bu.side, "LONG"); assert.ok(bu.core >= C.neutralBand);
  assert.equal(bd.side, "SHORT"); assert.ok(bd.core <= -C.neutralBand);
  // 中性带：|core| < 带宽 → side=null。旧带宽 0.2 下这组横盘数据在带内；默认 0.1 下按 core 的符号归边。
  const C2 = normalizeNtsConfig({ neutralBand: 0.2 }), bf2 = computeBias(snap(), buildPacks(f), f, C2);
  assert.equal(bf2.side, null); assert.ok(Math.abs(bf2.core) < 0.2);
  assert.equal(bf.side, Math.abs(bf.core) < C.neutralBand ? null : bf.core > 0 ? "LONG" : "SHORT");
});
test("bias: 缺趋势数据 → 偏向 0、不交易，并写明原因；未接入的数据源被列出", () => {
  const b = computeBias(snap(), {}, {}, C);
  assert.equal(b.core, 0); assert.equal(b.side, null); assert.match(b.note, /数据不足/);
  assert.ok(b.unconnected.some(x => x.includes("多空账户比")));
});
test("bias: 资金费率极端拥挤是反向分项；OI 与价格同向增加为正", () => {
  const u = trendBars(up), p = buildPacks(u);
  const hot = computeBias(snap({ funding: 0.0008 }), p, u, C), cold = computeBias(snap({ funding: -0.0008 }), p, u, C);
  assert.equal(hot.comps.funding, -1); assert.equal(cold.comps.funding, 1);
  const oi = computeBias(snap({ oiChg: { h1: 0.01, h4: 0.02 } }), p, u, C);
  assert.ok((oi.comps.oi ?? 0) > 0);
});
test("RSI/MACD 只做辅助：不改变 core / side / 放行结果，显示分的调整不超过上限", () => {
  const u = trendBars(up), base = buildPacks(u);
  const hotPacks = { ...base, "1h": { ...base["1h"]!, rsi: 85, rsiDiv: "bear" as const, macd: { ...base["1h"]!.macd, h: -1, hDir: "down" as const, cross: "dead" as const } },
    "4h": { ...base["4h"]!, rsi: 90, macd: { ...base["4h"]!.macd, h: -1, hDir: "down" as const } } };
  const coldPacks = { ...base, "1h": { ...base["1h"]!, rsi: 15, macd: { ...base["1h"]!.macd, h: 1, hDir: "up" as const, cross: "golden" as const } }, "4h": { ...base["4h"]!, rsi: 10 } };
  const a = computeBias(snap(), hotPacks, u, C), b = computeBias(snap(), coldPacks, u, C), c = computeBias(snap(), base, u, C);
  assert.equal(a.core, c.core); assert.equal(b.core, c.core);
  assert.equal(a.side, c.side); assert.equal(b.side, c.side);
  assert.ok(Math.abs(a.score - a.core) <= C.aux.maxBiasAdj + 1e-9 && Math.abs(b.score - b.core) <= C.aux.maxBiasAdj + 1e-9);
  assert.notEqual(a.score, b.score);
  assert.ok(a.aux.rsi1h === 85 && a.aux.macdDir1h === "down" && a.aux.div1h === "bear", "RSI/MACD 数值、柱子方向、背离都被记录");
  assert.match(a.aux.note, /不参与放行/);
});
test("RSI/MACD 不能把中性带内的 core 推成可交易，也不能把可交易的 core 否决", () => {
  const f = { ...trendBars(down), "1d": up(260, 86400) }, p = buildPacks(f);
  const push = { ...p, "1h": { ...p["1h"]!, rsi: 10, macd: { ...p["1h"]!.macd, h: 5, hDir: "up" as const, cross: "golden" as const, div: "bull" as const } }, "4h": { ...p["4h"]!, rsi: 10 } };
  const C2 = normalizeNtsConfig({ neutralBand: 0.2 });
  assert.equal(computeBias(snap(), p, f, C2).side, null);
  assert.equal(computeBias(snap(), push, f, C2).side, null, "RSI/MACD 极端值也推不出中性带");
  assert.equal(computeBias(snap(), push, f, C).core, computeBias(snap(), p, f, C).core, "core 不含 RSI/MACD");
  assert.equal(computeBias(snap(), push, f, C).side, computeBias(snap(), p, f, C).side);
  // 入场决策（evaluateSmcEntry）的输入里根本没有偏向/RSI/MACD：只看订单块、结构、15m 信号
  assert.equal(evaluateSmcEntry.length, 7);
});

const B = (i: number, o: number, hgh: number, l: number, c: number, step = 3600): Bar => ({ time: T0 + i * step, open: o, high: hgh, low: l, close: c, volume: 1 });
const lvlBars = (n: number, px: number, step = 3600, from = 0) => Array.from({ length: n }, (_, i) => B(from + i, px, px + 0.05, px - 0.05, px + (i % 2 ? 0.01 : -0.01), step));

test("订单块：阴线 → 下一根阳线实体吞没 + 收盘越过阴线高点 → 需求区 = 阴线的最高~最低；空头镜像", () => {
  const b = [B(0, 100.3, 100.35, 99.95, 100.0), B(1, 99.98, 100.9, 99.96, 100.85), B(2, 100.85, 101.2, 100.8, 101.1)];
  const ob = findOrderBlocks(b, "1h", C);
  assert.equal(ob.length, 1); assert.equal(ob[0]!.kind, "DEMAND"); assert.deepEqual([ob[0]!.lo, ob[0]!.hi], [99.95, 100.35]);
  assert.equal(ob[0]!.leftT, b[1]!.time + 3600, "价格完全离开区域的第一根K线被记下");
  const s = [B(0, 100.0, 100.4, 99.65, 100.3), B(1, 100.32, 100.34, 99.4, 99.45), B(2, 99.45, 99.5, 99.1, 99.2)];
  const so = findOrderBlocks(s, "1h", C);
  assert.equal(so.length, 1); assert.equal(so[0]!.kind, "SUPPLY"); assert.deepEqual([so[0]!.lo, so[0]!.hi], [99.65, 100.4]);
});
test("订单块：只吞没没突破高点（confirmBars 内）不算；实体没吞没不算", () => {
  const noBreak = [B(0, 100.3, 100.6, 99.95, 100.0), B(1, 99.98, 100.55, 99.96, 100.4), ...[2, 3, 4].map(i => B(i, 100.4, 100.5, 100.3, 100.45))];
  assert.equal(findOrderBlocks(noBreak, "1h", C).filter(o => o.kind === "DEMAND").length, 0);
  const noEngulf = [B(0, 100.3, 100.35, 99.95, 100.0), B(1, 100.05, 100.9, 100.0, 100.2), B(2, 100.2, 101, 100.15, 100.9)];
  assert.ok(!findOrderBlocks(noEngulf, "1h", C).some(o => o.t === noEngulf[0]!.time));
});
test("订单块失效：收盘穿过区域另一侧 → 作废，不再返回；回到区内会被计为一次到访", () => {
  const base = [B(0, 100.3, 100.35, 99.95, 100.0), B(1, 99.98, 100.9, 99.96, 100.85), B(2, 100.85, 101.2, 100.8, 101.1)];
  const visit = [...base, B(3, 101.1, 101.1, 100.2, 100.5), B(4, 100.5, 101.3, 100.45, 101.2)];
  const ob = findOrderBlocks(visit, "1h", C)[0]!;
  assert.ok(ob.priorVisits >= 1, "回到区内算到访");
  const broken = [...base, B(3, 101.1, 101.1, 99.8, 99.9)];
  assert.equal(findOrderBlocks(broken, "1h", C).filter(o => o.kind === "DEMAND").length, 0, "收盘跌破下沿 → 失效");
});
test("FVG：三根K线中第1根高点 < 第3根低点 → 看涨缺口；被回补后不再列出", () => {
  const b = [B(0, 100, 100.2, 99.9, 100.1), B(1, 100.1, 101.5, 100.1, 101.4), B(2, 101.4, 101.8, 100.6, 101.7)];
  const g = findFvgs(b, "1h");
  assert.equal(g.length, 1); assert.equal(g[0]!.kind, "BULL"); assert.deepEqual([g[0]!.lo, g[0]!.hi], [100.2, 100.6]);
  assert.equal(findFvgs([...b, B(3, 101.7, 101.7, 100.1, 100.5)], "1h").length, 0);
});
test("4H 结构：抬高的高点/低点 + 收盘突破前高 → UP（BOS）；镜像 → DOWN；没有摆动点 → NONE", () => {
  const zig = (dir: 1 | -1) => { const out: Bar[] = []; let px = 100, i = 0;
    for (let leg = 0; leg < 8; leg++) { const n = 5, d = (leg % 2 === 0 ? 1.2 : -0.7) * dir;
      for (let k = 0; k < n; k++) { const o = px, c = px + d / n; const u = c > o; out.push(B(i++, o, Math.max(o, c) + (u ? 0.05 : 0.02), Math.min(o, c) - (u ? 0.02 : 0.05), c, 14400)); px = c; } }
    return out; };
  const u = marketStructure(zig(1), C), d = marketStructure(zig(-1), C);
  assert.equal(u.trend, "UP"); assert.equal(u.highs, "HH"); assert.equal(u.lows, "HL"); assert.ok(u.bosT != null);
  assert.equal(d.trend, "DOWN"); assert.equal(d.highs, "LH"); assert.equal(d.lows, "LL");
  assert.equal(marketStructure(lvlBars(3, 100, 14400), C).trend, "NONE");
});
test("15m 信号：区内看涨吞没 → ENGULF；区内双底 + 颈线被突破 → DOUBLE；不在区内 / 没反转 → 无", () => {
  const z: OrderBlock = { tf: "1h", kind: "DEMAND", lo: 99.95, hi: 100.35, t: T0, confirmT: T0, leftT: T0, priorVisits: 0, inside: false, invalid: false, fvg: false };
  const pre = lvlBars(20, 100.8, 900);
  const eng = [...pre, B(20, 100.45, 100.5, 100.2, 100.25, 900), B(21, 100.24, 100.62, 100.22, 100.6, 900)];
  assert.equal(reversalSignal(eng, z, "LONG", 0.08, C)?.kind, "ENGULF");
  assert.equal(reversalSignal(eng.map(b => ({ ...b, low: b.low + 2, high: b.high + 2, open: b.open + 2, close: b.close + 2 })), z, "LONG", 0.08, C), null, "不在区内");
  const dbl = [...pre, B(20, 100.6, 100.62, 100.2, 100.3, 900), B(21, 100.3, 100.32, 100.1, 100.15, 900), B(22, 100.15, 100.4, 100.12, 100.38, 900), B(23, 100.38, 100.5, 100.3, 100.45, 900),
    B(24, 100.45, 100.47, 100.25, 100.3, 900), B(25, 100.3, 100.32, 100.11, 100.2, 900), B(26, 100.2, 100.35, 100.15, 100.3, 900), B(27, 100.3, 100.42, 100.28, 100.4, 900), B(28, 100.4, 100.58, 100.38, 100.56, 900)];
  const s = reversalSignal(dbl, z, "LONG", 0.08, C);
  assert.ok(s && ["DOUBLE", "ENGULF"].includes(s.kind), JSON.stringify(s));
  const none = [...pre, B(20, 100.45, 100.5, 100.2, 100.25, 900), B(21, 100.24, 100.3, 100.21, 100.27, 900)];
  assert.equal(reversalSignal(none, z, "LONG", 0.08, C), null);
});
test("入场计划：顺势 + 1H 需求区回踩 + 15m 吞没 → ENTER；止损在区外 + ATR 缓冲；TP1 = 前方对向订单块/前高；最坏亏损 ≤ 1R", () => {
  const bars = smcLongBars(), px = bars["15m"].at(-1)!.close;
  const d = evaluateSmcEntry("BTC_USDT", px * 0.99995, px * 1.00005, bars, smcLongView(bars), SMC_CTX, C);
  assert.equal(d.action, "ENTER", JSON.stringify(d)); if (d.action !== "ENTER") return;
  const p = d.plan;
  assert.equal(p.side, "LONG"); assert.equal(p.mode, "TREND"); assert.equal(p.trigger, "ENGULF");
  assert.ok(p.stop < p.zone.lo && Math.abs(p.stop - (Math.min(p.zone.lo, p.signal.extreme) - C.smc.stopAtrBuf * SMC_CTX.atr1h)) < 1e-9);
  assert.ok(p.target > p.entry && p.rr >= C.smc.rrMin);
  assert.ok(p.worstFirstPct <= C.maxLossPct && p.worstLossPct <= C.maxLossPct + 1e-9);
  assert.ok(p.addAllowed && p.addPrice! > p.zone.lo && p.addPrice! < p.entry, "补仓位在区内更深处");
  assert.ok(Math.abs(p.marginFirstPct - 0.02) < 1e-12 && Math.abs(p.marginAddPct - 0.03) < 1e-12);
});
test("可选不补仓（smc.add=false）：同一入场仍放行，但不设补仓位、只算首仓风险；出场只看 TP1，止损交给账户硬止损", () => {
  const bars = smcLongBars(), px = bars["15m"].at(-1)!.close, C2 = normalizeNtsConfig({ smc: { add: false } });
  assert.equal(C.smc.add, true, "默认仍是视频原版：补一次");
  assert.equal(C2.smc.add, false);
  const d = evaluateSmcEntry("BTC_USDT", px * 0.99995, px * 1.00005, bars, smcLongView(bars), SMC_CTX, C2);
  assert.equal(d.action, "ENTER", JSON.stringify(d)); if (d.action !== "ENTER") return;
  const p = d.plan;
  assert.equal(p.addPrice, null); assert.equal(p.addAllowed, false); assert.equal(p.marginAddPct, 0);
  assert.ok(Math.abs(p.worstLossPct - p.worstFirstPct) < 1e-12 && p.worstFirstPct <= C2.maxLossPct, "风险只来自首仓 2%");
  assert.ok(Math.abs(p.geo.avg - p.entry) < 1e-12);
  const o = { side: p.side, added: false, addPrice: p.addPrice, zone: p.zone, mode: p.mode, target: p.target, breakeven: p.geo.breakeven };
  assert.equal(smcAddCheck(o, p.zone.lo + 1e-6, bars["15m"], "UP").ok, false, "到了区的均衡位也不补");
  assert.equal(smcExit(o, (p.entry + p.target) / 2).action, "HOLD", "没有保本出场");
  assert.equal((smcExit(o, p.target) as { code: string }).code, "TARGET");
});

test("入场否决：逆势的 1H 区、15m 收盘穿透、没有反转信号、R:R 不足、点差过大、数据不足、事件窗口 —— 都有明确原因", () => {
  const bars = smcLongBars(), px = bars["15m"].at(-1)!.close, bid = px * 0.99995, ask = px * 1.00005;
  const why = (d: ReturnType<typeof evaluateSmcEntry>) => d.action === "ENTER" ? "ENTER" : JSON.stringify(d);
  assert.match(why(evaluateSmcEntry("BTC_USDT", bid, ask, bars, smcLongView(bars, "DOWN"), SMC_CTX, C)), /逆势/);
  const ct = smcLongBars({ closeThrough: true }), cp = ct["15m"].at(-1)!.close;
  assert.notEqual(evaluateSmcEntry("BTC_USDT", cp * 0.99995, cp * 1.00005, ct, smcLongView(ct), SMC_CTX, C).action, "ENTER");
  const ne = smcLongBars({ engulf: false }), np = ne["15m"].at(-1)!.close;
  assert.match(why(evaluateSmcEntry("BTC_USDT", np * 0.99995, np * 1.00005, ne, smcLongView(ne), SMC_CTX, C)), /反转/);
  const tight = smcLongView(bars, "UP", [100.9]); tight.obs = tight.obs.filter(o => o.kind === "DEMAND");
  assert.match(why(evaluateSmcEntry("BTC_USDT", bid, ask, bars, tight, SMC_CTX, C)), /R:R|盈亏比/);
  assert.match(why(evaluateSmcEntry("BTC_USDT", px * 0.999, px * 1.001, bars, smcLongView(bars), SMC_CTX, C)), /点差/);
  assert.match(why(evaluateSmcEntry("BTC_USDT", bid, ask, bars, smcLongView(bars), { ...SMC_CTX, dataOk: false, dataNote: "15m 数据不足" }, C)), /数据不足/);
  assert.match(why(evaluateSmcEntry("BTC_USDT", bid, ask, bars, smcLongView(bars), { ...SMC_CTX, inEvent: "CPI" }, C)), /CPI|事件/);
});
test("最坏亏损：首仓 2% × 100x 打到止损（含手续费、滑点）；补仓后合计不超过 1R 才允许补", () => {
  const w1 = worstLoss(C, [{ margin: 0.02, price: 100 }], 99);
  assert.ok(Math.abs(w1 - 0.02 * 100 * (0.01 + C.stopSlipPct + 2 * C.feeRate + 2 * C.slippagePct)) < 1e-9, `w1 ${w1}`);
  const w2 = worstLoss(C, [{ margin: 0.02, price: 100 }, { margin: 0.03, price: 99.5 }], 99);
  assert.ok(w2 > w1);
});
test("补仓检查：没到补仓位不补；15m 收盘穿透区 → 取消；4H 结构翻转 → 取消；条件都满足 → 补", () => {
  const o = { side: "LONG" as const, added: false, addPrice: 100.15, zone: { lo: 99.95, hi: 100.35 }, mode: "TREND" as const, target: 102.47, breakeven: 100.8 };
  const b15 = lvlBars(10, 100.2, 900);
  assert.match(smcAddCheck(o, 100.3, b15, "UP").reason, /未到补仓位/);
  assert.equal(smcAddCheck(o, 100.1, b15, "UP").ok, true);
  assert.match(smcAddCheck(o, 100.1, [...b15, B(10, 100.1, 100.12, 99.7, 99.8, 900)], "UP").reason, /穿透/);
  assert.match(smcAddCheck(o, 100.1, b15, "DOWN").reason, /4H/);
  assert.equal(smcAddCheck({ ...o, added: true }, 100.1, b15, "UP").ok, false, "只补一次");
});
test("出场：未补仓到 TP1 平（TARGET）；补仓后回到新均价保本附近就平（BREAKEVEN）；其余持有，止损由账户硬止损负责", () => {
  const o = { side: "LONG" as const, added: false, addPrice: 100.15, zone: { lo: 99.95, hi: 100.35 }, mode: "TREND" as const, target: 102.47, breakeven: 100.8 };
  assert.equal(smcExit(o, 102.5).action, "CLOSE"); assert.equal((smcExit(o, 102.5) as { code: string }).code, "TARGET");
  assert.equal(smcExit(o, 101).action, "HOLD");
  const a = { ...o, added: true, breakeven: 100.55 };
  assert.equal((smcExit(a, 100.56) as { code: string }).code, "BREAKEVEN");
  assert.equal(smcExit(a, 100.4).action, "HOLD");
  const s = { ...o, side: "SHORT" as const, target: 98, breakeven: 99.5 };
  assert.equal((smcExit(s, 97.9) as { code: string }).code, "TARGET");
});

test("月度熔断已移除：本月亏多少都不减仓、不停开；只保留当日 −1R 停当日；旧配置里的月度键被忽略", () => {
  const k = (monthPnl: number, dayPnl = 0) => breakerState({ monthPnl, monthStartEquity: 1000, dayPnl, oneR: 50 }, C);
  assert.equal(k(0).state, "OK"); assert.equal(k(-29).state, "OK");
  for (const m of [-30, -50, -200, -900]) assert.deepEqual([k(m).state, k(m).sizeMult, k(m).allowEntry], ["OK", 1, true], `本月 ${m}U`);
  const old = normalizeNtsConfig({ breaker: { monthHalvePct: 0.03, monthStopPct: 0.05, dayStopR: 1 } } as never);
  assert.deepEqual(Object.keys(old.breaker).sort(), ["dayStopR", "tzOffsetHours"]);
  assert.equal(breakerState({ monthPnl: -100, monthStartEquity: 1000, dayPnl: 0, oneR: 50 }, old).allowEntry, true);
  assert.deepEqual([k(0, -50).state, k(0, -50).allowEntry], ["STOP_DAY", false]);
  assert.equal(k(20).state, "OK");
});
test("配置安全栏：开关、杠杆、1R 等被限制在安全范围内", () => {
  const c = normalizeNtsConfig({ ...C, leverage: 500, maxLossPct: 0.5, firstMarginPct: 0.9 } as never);
  assert.ok(c.leverage <= 100 && c.maxLossPct <= 0.05 && c.firstMarginPct <= 0.1);
  assert.equal(DEFAULT_NTS_CONFIG_ENABLED(), true);
});
import { DEFAULT_NTS_CONFIG } from "../lib/nts/config.ts";
const DEFAULT_NTS_CONFIG_ENABLED = () => DEFAULT_NTS_CONFIG.enabled;
