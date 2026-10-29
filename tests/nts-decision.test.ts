import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_NTS_CONFIG as C, normalizeNtsConfig } from "../lib/nts/config.ts";
import { breakerState, buildPacks, buildZones, computeBias, evaluateAdd, evaluateEntry, exitAction, geometry, sizingPct, stateInvalidated, sweepReclaim, retestConfirm, volScale, worstCaseLossPct } from "../lib/nts/decision.ts";
import { biasOf, bars, down, fakePack, packsOf, snap, sweepBars, up, zone, T0 } from "./nts-fixtures.ts";

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
  // 同样的入场输入，RSI/MACD 极端值不同 → evaluateEntry 结论相同
  const lvl = 100, b15 = sweepBars(lvl), z = zone(lvl * 0.999, lvl * 1.001), opp = zone(lvl * 1.03, lvl * 1.032);
  const ctx = { zones: [z, opp], atr1hPct: 0.004, sizeMult: 1, inEvent: null, dataOk: true, dataNote: "" };
  const s = snap({ bid: b15.at(-1)!.close - 0.01, ask: b15.at(-1)!.close + 0.01 });
  const x = evaluateEntry(s, { "15m": b15 }, { ...biasOf("LONG"), score: 0.66, confidence: 0.9 }, ctx, C);
  const y = evaluateEntry(s, { "15m": b15 }, { ...biasOf("LONG"), score: 0.54, confidence: 0.2 }, ctx, C);
  assert.equal(x.action, y.action);
});

test("支撑压力区：相近的摆动点按 0.4×ATR 聚成一个区，远处的另成一区；分数低于门槛的被丢弃", () => {
  // 来回摆动：低点分别在 100.0 / 100.2 / 100.3（应聚成一个区）与 90（另一区），高点在 110
  const lows = [100.0, 100.2, 100.3, 100.05, 90, 100.1], zig = Array.from({ length: 120 }, (_, i) => {
    const k = Math.floor(i / 10), phase = i % 10, low = lows[k % lows.length]!;
    const c = phase === 5 ? low : phase < 5 ? 110 - (110 - low) * (phase / 5) : low + (110 - low) * ((phase - 5) / 5);
    return { time: T0 + i * 3600, open: c, close: c, high: c + 0.05, low: c - 0.05, volume: 100 };
  });
  const cfg = normalizeNtsConfig({ ...C, zone: { ...C.zone, minScore: 0 } });
  const zs = buildZones({ "1h": zig }, 1.0, T0 + 120 * 3600, cfg);
  assert.ok(zs.length >= 2 && zs.length <= cfg.zone.maxZones);
  assert.ok(zs.some(z => z.touches >= 3), "重复触及的低点聚成一个多次触及的区");
  for (let i = 1; i < zs.length; i++) assert.ok(zs[i - 1]!.score >= zs[i]!.score, "按分数降序");
  assert.equal(buildZones({ "1h": zig }, 0, T0, cfg).length, 0, "ATR 无效 → 不出区");
  const strict = normalizeNtsConfig({ ...C, zone: { ...C.zone, minScore: 99 } });
  assert.equal(buildZones({ "1h": zig }, 1.0, T0 + 120 * 3600, strict).length, 0);
  const wide = buildZones({ "1h": zig }, 20, T0 + 120 * 3600, cfg), narrow = buildZones({ "1h": zig }, 0.05, T0 + 120 * 3600, cfg);
  assert.ok(wide.length <= narrow.length, "容差越大，区越少");
});

test("触发：刺破支撑后收回成立；没收回、刺破过深、量能不足、砸盘放量都不触发；空头镜像", () => {
  const lvl = 100, z = zone(lvl * 0.999, lvl * 1.001);
  const ok = sweepReclaim(sweepBars(lvl), z, "LONG", C);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(sweepReclaim(sweepBars(lvl, { reclaim: false }), z, "LONG", C).ok, false);
  assert.match(sweepReclaim(sweepBars(lvl, { depth: 0.02 }), z, "LONG", C).reason, /破位/);
  assert.match(sweepReclaim(sweepBars(lvl, { reclaimVol: 40 }), z, "LONG", C).reason, /量能/);
  assert.match(sweepReclaim(sweepBars(lvl, { sweepVol: 900 }), z, "LONG", C).reason, /放量砸盘/);
  assert.match(sweepReclaim(sweepBars(lvl, { strength: 0.2 }), z, "LONG", C).reason, /强度/);
  // 空头：价格取镜像（用 2*lvl - p）
  const mirror = sweepBars(lvl).map(b => ({ ...b, open: 2 * lvl - b.open, close: 2 * lvl - b.close, high: 2 * lvl - b.low, low: 2 * lvl - b.high }));
  assert.equal(sweepReclaim(mirror, z, "SHORT", C).ok, true);
});

test("第二触发（回踩确认）：回踩进区不破位 + 一根同向确认K线 → 成立；确认已过、收盘破位、没有确认、放量砸盘都不触发；空头镜像", () => {
  const z = zone(99.9, 100.1), base = bars(30, 900, i => 100.4 + 0.04 * Math.sin(i)), t = base.at(-1)!.time;
  const B = (k: number, o: number, h: number, l: number, c: number, v = 100) => ({ time: t + 900 * k, open: o, high: h, low: l, close: c, volume: v });
  const touch = B(1, 100.35, 100.4, 100.05, 100.15), conf = B(2, 100.16, 100.5, 100.12, 100.45);
  const ok = retestConfirm([...base, touch, conf], z, "LONG", C);
  assert.equal(ok.ok, true, ok.reason); assert.equal(ok.reclaim, conf); assert.equal(ok.depth, 0);
  assert.match(retestConfirm([...base, touch, conf, B(3, 100.46, 100.7, 100.44, 100.65)], z, "LONG", C).reason, /已错过/);
  assert.match(retestConfirm([...base, B(1, 100.35, 100.4, 99.8, 99.85), conf], z, "LONG", C).reason, /破位/);
  assert.match(retestConfirm([...base, touch, B(2, 100.16, 100.2, 100.0, 100.05)], z, "LONG", C).reason, /确认/);
  assert.match(retestConfirm([...base, B(1, 100.35, 100.4, 100.05, 100.15, 900), conf], z, "LONG", C).reason, /放量砸盘/);
  assert.match(retestConfirm(base, z, "LONG", C).reason, /没有回踩进区/);
  assert.equal(retestConfirm([...base, touch, conf], z, "LONG", normalizeNtsConfig({ trigger: { retestStrength: 0.95 } })).ok, false);
  const m = (b: { time: number; open: number; high: number; low: number; close: number; volume: number }) => ({ ...b, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close });
  assert.equal(retestConfirm([...base, touch, conf].map(m), zone(99.9, 100.1), "SHORT", C).ok, true);
  // 配置可关掉第二触发；布尔值能正确合并
  assert.equal(normalizeNtsConfig({ trigger: { retest: false } }).trigger.retest, false);
  assert.equal(normalizeNtsConfig({ trigger: { retest: "no" } } as never).trigger.retest, true);
});
test("开仓即失效不开：日线收盘在 EMA50 另一侧时该方向不开仓（否则下一分钟就被状态失效平掉）", () => {
  const f = entryInputs(), daily = down(260, 86400);
  assert.equal(stateInvalidated("LONG", daily), true);
  const dec = evaluateEntry(f.s, { ...f.bars, "1d": daily }, biasOf("LONG"), f.ctx, C);
  assert.equal(dec.action, "NO_TRADE"); assert.ok(dec.vetoes.some(v => /EMA50/.test(v.reason)));
});
const entryInputs = (over: { opp?: ReturnType<typeof zone> | null; atr?: number; sizeMult?: number; spread?: number } = {}) => {
  const lvl = 100, b15 = sweepBars(lvl), close = b15.at(-1)!.close, z = zone(lvl * 0.999, lvl * 1.001, 75);
  const opp = over.opp === undefined ? zone(close * 1.02, close * 1.022, 70) : over.opp;
  const sp = over.spread ?? 0.0001;
  return { s: snap({ bid: close * (1 - sp / 2), ask: close * (1 + sp / 2) }), bars: { "15m": b15 }, z, opp, close,
    ctx: { zones: opp ? [z, opp] : [z], atr1hPct: over.atr ?? 0.004, sizeMult: over.sizeMult ?? 1, inEvent: null, dataOk: true, dataNote: "" } };
};
test("入场计划：满足条件 → ENTER，止损/目标/保本/R:R/仓位齐全，最坏亏损 ≤ 5% 本金", () => {
  const e = entryInputs(), d = evaluateEntry(e.s, e.bars, biasOf("LONG"), e.ctx, C);
  assert.equal(d.action, "ENTER", d.action === "NO_TRADE" ? d.reason + JSON.stringify(d.vetoes) : "");
  if (d.action !== "ENTER") return;
  const p = d.plan;
  assert.ok(p.rr >= C.trigger.rrMin); assert.ok(p.stop < p.entry && p.target > p.entry);
  assert.ok(p.worstLossPct <= C.maxLossPct * 1.0001, `worst ${p.worstLossPct}`);
  assert.ok(Math.abs(p.marginFirstPct - 0.02) < 1e-9 || p.marginFirstPct < 0.02);
  assert.ok(p.geo.hardStop < p.geo.avg && p.geo.breakeven > p.geo.avg && p.geo.tolerance > p.geo.avg && p.geo.tolerance < p.geo.breakeven);
});
test("入场否决：R:R 不足、前方没有对向区、点差过大、数据不足、事件窗口、中性偏向 —— 都有明确原因", () => {
  const c0 = entryInputs().close, near = entryInputs({ opp: zone(c0 * 1.004, c0 * 1.0042) });
  const r1 = evaluateEntry(near.s, near.bars, biasOf("LONG"), near.ctx, C); assert.equal(r1.action, "NO_TRADE");
  assert.ok(r1.vetoes.some(v => /R:R \d/.test(v.reason)), JSON.stringify(r1.vetoes));
  // 前方没有对向区：用 1H ATR × noOppAtrMult 作目标空间，不再一票否决；ATR 也缺失才否决
  const none = entryInputs({ opp: null }); const r2 = evaluateEntry(none.s, none.bars, biasOf("LONG"), none.ctx, C);
  assert.equal(r2.action, "ENTER"); if (r2.action === "ENTER") { assert.equal(r2.plan.targetMode, "ATR"); assert.equal(r2.plan.oppZone, null);
    assert.ok(Math.abs(r2.plan.roomPct - Math.min(0.004 * C.trigger.noOppAtrMult, C.maxTargetPct)) < 1e-12); }
  const noAtr = evaluateEntry(none.s, none.bars, biasOf("LONG"), { ...none.ctx, atr1hPct: null }, C);
  assert.equal(noAtr.action, "NO_TRADE"); assert.ok(noAtr.vetoes.some(v => /对向区域/.test(v.reason)));
  const wide = entryInputs({ spread: 0.002 }); assert.match((evaluateEntry(wide.s, wide.bars, biasOf("LONG"), wide.ctx, C) as { reason: string }).reason, /点差/);
  const e = entryInputs();
  assert.match((evaluateEntry(e.s, e.bars, biasOf("LONG"), { ...e.ctx, dataOk: false, dataNote: "1h K线不足" }, C) as { reason: string }).reason, /数据不足/);
  assert.match((evaluateEntry(e.s, e.bars, biasOf("LONG"), { ...e.ctx, inEvent: "FOMC" }, C) as { reason: string }).reason, /事件窗口/);
  // 中性带：不再一票否决，按触发方向开仓、仓位 × neutralSizeMult；neutralSizeMult=0 恢复旧行为（不做）
  const full = evaluateEntry(e.s, e.bars, biasOf("LONG"), e.ctx, C), neu = evaluateEntry(e.s, e.bars, biasOf(null, 0.05), e.ctx, C);
  assert.equal(neu.action, "ENTER"); assert.ok(full.action === "ENTER" && neu.action === "ENTER");
  if (full.action === "ENTER" && neu.action === "ENTER") { assert.equal(neu.plan.neutral, true); assert.equal(full.plan.neutral, false);
    assert.ok(Math.abs(neu.plan.marginFirstPct - full.plan.marginFirstPct * C.neutralSizeMult) < 1e-12); }
  assert.equal(evaluateEntry(e.s, e.bars, biasOf(null, 0.05), e.ctx, normalizeNtsConfig({ neutralSizeMult: 0 })).action, "NO_TRADE");
  // 偏向明确时只做偏向方向：同一组多头触发K线，偏空时不开多
  assert.equal(evaluateEntry(e.s, e.bars, biasOf("SHORT"), e.ctx, C).action === "ENTER" && (evaluateEntry(e.s, e.bars, biasOf("SHORT"), e.ctx, C) as { side: string }).side === "LONG", false);
  const lowVol = entryInputs({ atr: 0.0003 }); assert.ok(evaluateEntry(lowVol.s, lowVol.bars, biasOf("LONG"), lowVol.ctx, C).vetoes.some(v => /成本/.test(v.reason)));
});
test("入场否决的记录有上限（日志不会无限长）", () => {
  const e = entryInputs({ opp: null }); const many = Array.from({ length: 4 }, (_, i) => zone(99 - i * 0.1, 99.2 - i * 0.1, 60));
  const r = evaluateEntry(e.s, e.bars, biasOf("LONG"), { ...e.ctx, zones: [e.z, ...many] }, normalizeNtsConfig({ ...C, log: { ...C.log, maxVetoes: 2 } }));
  assert.ok(r.vetoes.length <= 2);
});

test("仓位：先按波动缩放，再按熔断倍数缩，补仓后最坏亏损始终 ≤ 5% 本金", () => {
  for (const scale of [1, 1.3, 1.6]) for (const mult of [1, 0.5]) {
    const z = sizingPct(C, scale, mult);
    assert.ok(z.worst <= C.maxLossPct * 1.0001, `scale ${scale} mult ${mult} worst ${z.worst}`);
    assert.ok(z.first <= C.firstMarginPct && z.add <= C.addMarginPct);
  }
  const full = sizingPct(C, 1, 1); assert.ok(full.first > 0.015, "标准波动下首仓约 2% 保证金");
  assert.equal(volScale(null, C), 1); assert.equal(volScale(0.0001, C), 1); assert.equal(volScale(0.1, C), C.vol.maxScale);
  assert.ok(worstCaseLossPct(C, 1, 0.02, 0.03) > worstCaseLossPct(C, 1, 0.02, 0));
});
test("几何：补仓后均价、保本价=均价+0.20%、容差价=均价+0.05%、硬止损=均价−0.75%；空头镜像", () => {
  const g = geometry("LONG", 100, 99.4, C, 1, 0.02, 0.03);
  assert.ok(Math.abs(g.avg - (0.02 * 100 + 0.03 * 99.4) / 0.05) < 1e-9);
  assert.ok(Math.abs(g.breakeven / g.avg - 1.002) < 1e-9 && Math.abs(g.tolerance / g.avg - 1.0005) < 1e-9 && Math.abs(g.hardStop / g.avg - (1 - 0.0075)) < 1e-9);
  const s = geometry("SHORT", 100, 100.6, C, 1, 0.02, 0.03);
  assert.ok(Math.abs(s.breakeven / s.avg - 0.998) < 1e-9 && Math.abs(s.hardStop / s.avg - 1.0075) < 1e-9);
});

const open = (over = {}) => { const g = geometry("LONG", 100, 99.4, C, 1, 0.02, 0.03); return { side: "LONG" as const, entry: 100, avg: g.avg, added: true, openedAt: 0, addedAt: 0, target: 101, geo: g, ...over }; };
const H = 3_600_000;
test("出场阶梯：0–6h 只在保本价平；6–12h 降到均价+0.05%；满 12h 市价平；日线失效立刻平", () => {
  const p = open(), g = p.geo;
  assert.equal(exitAction(p, g.breakeven - 0.01, 3 * H, false, C).action, "HOLD");
  assert.equal(exitAction(p, g.tolerance + 0.01, 3 * H, false, C).action, "HOLD", "0–6h 到了容差价也不平");
  assert.equal(exitAction(p, g.breakeven, 3 * H, false, C).action, "CLOSE");
  assert.equal(exitAction(p, g.tolerance + 0.001, 7 * H, false, C).action, "CLOSE", "6h 后容差价就平");
  assert.equal(exitAction(p, g.tolerance - 0.05, 7 * H, false, C).action, "HOLD");
  assert.equal(exitAction(p, g.avg - 0.5, 12 * H, false, C).code, "TIME_12H");
  assert.equal(exitAction(p, g.avg + 5, 1 * H, true, C).code, "STATE_INVALID");
  // 12h 从补仓时刻起算
  assert.equal(exitAction(open({ addedAt: 2 * H }), 99, 13 * H, false, C).action, "HOLD");
  assert.equal(exitAction(open({ addedAt: 2 * H }), 99, 14 * H, false, C).code, "TIME_12H");
});
test("出场（未补仓）：到目标平；8h 仍无浮盈且在入场价附近时间失效；空头镜像", () => {
  const p = open({ added: false, addedAt: null, target: 101 });
  assert.equal(exitAction(p, 101, H, false, C).code, "TARGET");
  assert.equal(exitAction(p, 100.2, H, false, C).action, "HOLD");
  assert.equal(exitAction(p, 100.1, 9 * H, false, C).code, "TIME_8H");
  assert.equal(exitAction(p, 100.4, 9 * H, false, C).action, "HOLD", "已有 +0.4% 浮盈不算失效");
  const gs = geometry("SHORT", 100, 100.6, C, 1, 0.02, 0.03);
  assert.equal(exitAction({ ...p, side: "SHORT", geo: gs, target: 99 }, 98.9, H, false, C).code, "TARGET");
});
test("日线状态失效：多头日线收盘跌破 EMA50 → 失效", () => {
  assert.equal(stateInvalidated("LONG", up(120, 86400)), false);
  const broke = [...up(100, 86400), ...bars(5, 86400, i => 100 * (1 + 0.0012 * 100) * (1 - 0.05 - i * 0.01))];
  assert.equal(stateInvalidated("LONG", broke), true);
  assert.equal(stateInvalidated("LONG", up(30, 86400)), false, "数据不足不判失效");
});

test("补仓：H1–H5 硬条件全满足且 G≥2 才补；已补过一次不再补；偏向反向/状态失效不补", () => {
  const entry = 100, level = 99.15, b15 = sweepBars(level), d1 = up(120, 86400, 50, 0.004);
  const zs = [zone(level * 0.999, level * 1.001, 80, { touches: 3 })];
  const pos = { side: "LONG" as const, entry, added: false, scale: 1, firstZoneScore: 70 };
  const sn = snap({ oiChg: { h1: -0.01, h4: 0 }, funding: 0 });
  const bars_ = { "15m": b15, "1d": d1 };
  const ok = evaluateAdd(pos, sn, bars_, packsOf(), biasOf("LONG"), zs, null, C);
  assert.equal(ok.ok, true, ok.reason + JSON.stringify(ok.hard));
  assert.ok(ok.gPassed >= C.add.gMin);
  assert.equal(evaluateAdd({ ...pos, added: true }, sn, bars_, packsOf(), biasOf("LONG"), zs, null, C).ok, false);
  assert.equal(evaluateAdd(pos, sn, bars_, packsOf(), biasOf("SHORT"), zs, null, C).hard.H4.pass, false);
  assert.equal(evaluateAdd(pos, sn, bars_, packsOf(), biasOf("LONG"), zs, "FOMC", C).ok, false);
  assert.equal(evaluateAdd(pos, sn, bars_, packsOf(), biasOf("LONG"), [zone(level * 0.999, level * 1.001, 40, { touches: 1 })], null, C).ok, false, "结构位更弱不补");
  const hotAtr = packsOf({ "1h": fakePack({ atrRank: 0.99 }) });
  assert.equal(evaluateAdd(pos, sn, bars_, hotAtr, biasOf("LONG"), zs, null, C).hard.H5.pass, false);
  const far = sweepBars(99.05), farAdd = evaluateAdd(pos, sn, { ...bars_, "15m": far }, packsOf(), biasOf("LONG"), [zone(99.05 * 0.999, 99.05 * 1.001, 80, { touches: 3 })], null, C);
  assert.equal(farAdd.hard.H2.pass, false, "距首仓 0.6% 以外不补（补仓距离上限 0.6%）"); assert.equal(C.add.distMaxPct, 0.006);
  const fewG = evaluateAdd(pos, snap({ oiChg: { h1: 0.01, h4: 0 }, funding: 0.003 }), bars_, packsOf({ "1h": fakePack({ ema: { ...fakePack().ema, a50: -0.01 } }) }), biasOf("LONG"), zs, null, C);
  assert.equal(fewG.ok, false); assert.match(fewG.reason, /评分条件仅/);
});

test("熔断：本月 −3% 仓位减半，−5% 停止新开仓；当日 −1R 停当日；恢复后正常", () => {
  const k = (monthPnl: number, dayPnl = 0) => breakerState({ monthPnl, monthStartEquity: 1000, dayPnl, oneR: 50 }, C);
  assert.equal(k(0).state, "OK"); assert.equal(k(-29).state, "OK");
  assert.deepEqual([k(-30).state, k(-30).sizeMult, k(-30).allowEntry], ["HALF", 0.5, true]);
  assert.deepEqual([k(-50).state, k(-50).allowEntry], ["STOP_MONTH", false]);
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
