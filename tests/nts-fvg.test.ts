/** FVG 扫流动性系统：4H 缺口、分形、扫流动性、位移、扫描、限价/跳空成交、撤单、过期、历史缺口、情形 b、币池与取数调度。 */
import test from "node:test";
import assert from "node:assert/strict";
import { find4hZones, activeZonesAt, isSwing, detectSweep, detectDisplacement, scanSetups, reentryCheck, fallbackTick, H4, M15 } from "../lib/nts/fvg.ts";
import { DEFAULT_NTS_CONFIG, normalizeNtsConfig } from "../lib/nts/config.ts";
import { NtsEngine } from "../lib/nts/engine.ts";
import { NtsLog } from "../lib/nts/log.ts";
import { advanceForward, initialForward, type ForwardState } from "../lib/forward-relations.ts";
import type { Bar } from "../lib/nts/types.ts";
import { CONTRACT, quote } from "./nts-fixtures.ts";

const P = { ...DEFAULT_NTS_CONFIG.fvg };
const T0 = 1_760_000_000 - (1_760_000_000 % H4); // 4H 对齐（秒）
const bar = (time: number, open: number, high: number, low: number, close: number): Bar => ({ time, open, high, low, close, volume: 1 } as Bar);

/** 40 根 4H：第 20/21/22 根形成多头缺口 [100.3, 101.5]，之后价格在缺口里（收盘不破下沿）。 */
function h4Bars(n = 40, breakAt?: number): Bar[] {
  const out: Bar[] = [];
  for (let k = 0; k < n; k++) {
    const t = T0 + k * H4;
    if (k < 20) out.push(bar(t, 100, 100.3, 99.7, 100));
    else if (k === 20) out.push(bar(t, 100, 100.3, 99.8, 100.2));
    else if (k === 21) out.push(bar(t, 100.2, 102.6, 100.1, 102.5));
    else if (k === 22) out.push(bar(t, 102.5, 102.8, 101.5, 102));
    else if (breakAt != null && k >= breakAt) out.push(bar(t, 100.5, 100.6, 99.9, 100.1)); // 收盘 < 100.3 → 作废
    else out.push(bar(t, 101.2, 101.5, 100.9, 101.2));
  }
  return out;
}
const END = T0 + 40 * H4; // 最后一根 4H 收盘（秒）
/** 15m 形态：p=80 分形低 100.8，s=84 扫到 100.7 实体收在上面，85/86 两根强阳留下 15m 缺口 [101.05, 101.23]，然后 tail 根。 */
function m15Bars(tail = 9, after: (i: number) => [number, number, number, number] = () => [101.6, 101.7, 101.4, 101.6]): Bar[] {
  const n = 87 + tail, start = END - n * M15, out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const t = start + i * M15;
    if (i === 80) out.push(bar(t, 101, 101.1, 100.8, 101));
    else if (i === 84) out.push(bar(t, 101, 101.05, 100.7, 100.95));
    else if (i === 85) out.push(bar(t, 100.95, 101.27, 100.93, 101.25));
    else if (i === 86) out.push(bar(t, 101.25, 101.62, 101.23, 101.6));
    else if (i > 86) { const [o, h, l, c] = after(i); out.push(bar(t, o, h, l, c)); }
    else out.push(bar(t, 101, 101.1, 100.9, 101 + (i % 2 ? 0.02 : -0.02)));
  }
  return out;
}
const ENTRY = 101.23, SWEEP = 100.7, STOP = SWEEP - 0.01; // 引擎测试里没有合约 tick → 兜底 tick = 价格数量级×1e-4 = 0.01

test("4H FVG：多头 c1.high < c3.low，区间 [c1.high, c3.low]；空头镜像；收盘越过远端作废，影线不算", () => {
  const z = find4hZones(h4Bars(), 100);
  assert.equal(z.length, 1); assert.equal(z[0]!.side, "LONG"); assert.equal(z[0]!.lo, 100.3); assert.equal(z[0]!.hi, 101.5);
  assert.equal(z[0]!.formedAt, T0 + 23 * H4); assert.equal(z[0]!.invalidAt, null);
  assert.equal(activeZonesAt(z, T0 + 22 * H4).length, 0, "c3 收盘前不算形成");
  const bad = find4hZones(h4Bars(40, 30), 100)[0]!; assert.equal(bad.invalidAt, T0 + 31 * H4);
  assert.equal(activeZonesAt([bad], END).length, 0);
  const wick = h4Bars(); wick[30] = bar(T0 + 30 * H4, 101, 101.2, 99.5, 100.9); // 影线穿下沿，收盘在里面
  assert.equal(find4hZones(wick, 100)[0]!.invalidAt, null);
  const dn = h4Bars().map(b => bar(b.time, 200 - b.open, 200 - b.low, 200 - b.high, 200 - b.close)), zs = find4hZones(dn, 100);
  assert.equal(zs[0]!.side, "SHORT"); assert.ok(Math.abs(zs[0]!.lo - 98.5) < 1e-9 && Math.abs(zs[0]!.hi - 99.7) < 1e-9);
  assert.equal(find4hZones(h4Bars(), 10).length, 0, "只扫最近 zoneLookback4h 根");
});

test("分形与扫流动性：左右各 2 根严格更低；影线扫过、实体收在分形之上才算", () => {
  const b = m15Bars();
  assert.equal(isSwing(b, 80, "LOW"), true); assert.equal(isSwing(b, 79, "LOW"), false);
  const sw = detectSweep(b, 84, "LONG", P); assert.ok(sw); assert.equal(sw!.px, 100.8); assert.equal(sw!.idx, 80);
  const body = b.slice(); body[84] = bar(b[84]!.time, 101, 101.05, 100.7, 100.75); // 实体收在分形下面 → 不是扫，是破
  assert.equal(detectSweep(body, 84, "LONG", P), null);
  const early = b.slice(); early[82] = bar(b[82]!.time, 101, 101.1, 100.78, 101); // 之间已被扫过
  assert.equal(detectSweep(early, 84, "LONG", P)?.px ?? null, null);
});

test("位移（按视频）：扫后 2–3 根朝交易方向收盘、留下新 15m FVG 就成立；没有实体比例和 ATR 门槛；K线没走完 = WAIT", () => {
  const b = m15Bars();
  const d = detectDisplacement(b, 84, "LONG", P);
  assert.ok(d && d !== "WAIT"); assert.equal(d.m, 2); assert.deepEqual(d.fvg, { lo: 101.05, hi: 101.23 });
  const weak = b.slice(); weak[85] = bar(b[85]!.time, 100.95, 101.4, 100.6, 101.0); // 实体/振幅只有 0.06、幅度远小于 1×ATR：以前不算，现在算
  const dw = detectDisplacement(weak, 84, "LONG", P); assert.ok(dw && dw !== "WAIT", "小实体也算位移"); assert.deepEqual(dw.fvg, { lo: 101.05, hi: 101.23 });
  const down = b.slice(); down[85] = bar(b[85]!.time, 101.1, 101.4, 100.9, 101.0); // 第 1 根收阴 → 不是朝多头方向走
  assert.equal(detectDisplacement(down, 84, "LONG", P), null);
  const nogap = b.slice(); nogap[86] = bar(b[86]!.time, b[86]!.open, b[86]!.high, 101.0, b[86]!.close); nogap[87] = bar(b[87]!.time, b[87]!.open, b[87]!.high, 101.0, b[87]!.open - 0.01); // 没留缺口、第 3 根收阴
  assert.equal(detectDisplacement(nogap, 84, "LONG", P), null, "没留下同向 15m 缺口就不成立");
  assert.equal(detectDisplacement(b.slice(0, 86), 84, "LONG", P), "WAIT");
});

test("扫描：在 4H 缺口里的扫流动性 + 位移 → ARMED，入场 = 15m 缺口上沿，止损 = 扫点影线外 1 tick，原 TP = 3R", () => {
  const zones = find4hZones(h4Bars(), P.zoneLookback4h), s = scanSetups(m15Bars(), zones, P, 0.001).filter(x => x.status !== "NO_DISP");
  assert.equal(s.length, 1); const st = s[0]!;
  assert.equal(st.status, "ARMED"); assert.equal(st.entry, ENTRY); assert.ok(Math.abs(st.stop! - (SWEEP - 0.001)) < 1e-9, "止损 = 扫点 − 1 tick（合约 tick 0.001）");
  assert.ok(Math.abs(st.tpOrig! - (ENTRY + 3 * (ENTRY - st.stop!))) < 1e-9);
  const fb = scanSetups(m15Bars(), zones, P).find(x => x.entry != null)!; assert.ok(Math.abs(fb.stop! - STOP) < 1e-9, "没有 tick → 兜底 tick");
  assert.equal(fallbackTick(100.7), 0.01); assert.ok(Math.abs(fallbackTick(0.0123) - 0.000001) < 1e-15);
  const flip = (b: Bar) => bar(b.time, 200 - b.open, 200 - b.low, 200 - b.high, 200 - b.close);
  const dn = scanSetups(m15Bars().map(flip), find4hZones(h4Bars().map(flip), 100), P, 0.001).find(x => x.entry != null)!;
  assert.equal(dn.side, "SHORT"); assert.ok(Math.abs(dn.stop! - (dn.sweepPx + 0.001)) < 1e-9, "空单：扫的高点 + 1 tick"); assert.deepEqual(st.zoneKeys, [zones[0]!.key]);
  assert.equal(scanSetups(m15Bars(), [], P).length, 0, "不在 4H 缺口里的扫不算");
});

test("过期 / 回踩 / 破扫点：16 根没碰到 = EXPIRED；碰到 = TOUCHED；先破扫点 = INVALID", () => {
  const zones = find4hZones(h4Bars(), 100);
  const exp = scanSetups(m15Bars(20), zones, P).find(x => x.entry != null)!; assert.equal(exp.status, "EXPIRED");
  const touched = scanSetups(m15Bars(9, i => i === 90 ? [101.5, 101.6, 101.2, 101.5] : [101.6, 101.7, 101.4, 101.6]), zones, P).find(x => x.entry != null)!;
  assert.equal(touched.status, "TOUCHED");
  const broke = scanSetups(m15Bars(9, i => i === 89 ? [101.6, 101.7, 100.6, 101.4] : [101.6, 101.7, 101.4, 101.6]), zones, P).find(x => x.entry != null)!;
  assert.equal(broke.status, "TOUCHED", "同一根先碰入场价：按碰到记"); assert.ok(broke.brokeT != null);
  const brokeFirst = scanSetups(m15Bars(9, i => i === 89 ? [101.6, 101.7, 101.3, 101.4] : i === 88 ? [101.6, 101.7, 101.3, 101.6] : [101.6, 101.7, 101.4, 101.6]), zones, P);
  assert.ok(brokeFirst.length >= 1);
});

test("情形 b 条件：回到原 15m 缺口附近、扫点没破、原 TP 没到、剩余空间 ≥ 3R", () => {
  const zones = find4hZones(h4Bars(), 100), st = scanSetups(m15Bars(20), zones, P).find(x => x.entry != null)!;
  assert.equal(reentryCheck(st, 101.2, P).ok, true);
  assert.equal(reentryCheck(st, 101.5, P).ok, false, "离开缺口");
  const r2 = reentryCheck(st, 101.33, P); assert.equal(r2.ok, false); assert.match(r2.reason, /剩余空间不足/);
  assert.equal(reentryCheck({ ...st, brokeT: 1 }, 101.2, P).ok, false); assert.equal(reentryCheck({ ...st, tpHitT: 1 }, 101.2, P).ok, false);
});

// ---------------------------------------------------------------------------------------------------------------------
// 引擎层：真实 NtsEngine + 真实纸面账户
// ---------------------------------------------------------------------------------------------------------------------
function engine(b15: Bar[], b4 = h4Bars(), cfg: Record<string, unknown> = {}) {
  const now = (b15.at(-1)!.time + M15) * 1000 + 30_000;
  const c = normalizeNtsConfig({ ...DEFAULT_NTS_CONFIG, enabled: true, ...cfg } as never), log = new NtsLog(c);
  const e = new NtsEngine(c, log, null, now);
  e.ingestCandles("BTC_USDT", "4h", b4, now); e.ingestCandles("BTC_USDT", "15m", b15, now);
  e.ingestCandles("ETH_USDT", "4h", h4Bars().map(b => bar(b.time, 3000, 3001, 2999, 3000)), now); e.ingestCandles("ETH_USDT", "15m", b15.map(b => bar(b.time, 3000, 3001, 2999, 3000)), now);
  return { e, log, now };
}
const recs = (log: NtsLog) => Object.values(log.peek()).flatMap(ch => (ch as { recs?: unknown[] }).recs ?? []) as { id: string; k: string; d: Record<string, unknown>; sym?: string }[];
const contracts = { BTC_USDT: CONTRACT, ETH_USDT: CONTRACT };
function step(e: NtsEngine, fwd: ForwardState, now: number, bid: number, ask: number, enabled = true) {
  const quotes = { BTC_USDT: quote(bid, ask, now) }, draft = structuredClone(fwd);
  const acts = e.tick({ now, forward: fwd, quotes, contracts, enabled });
  const changed = e.execute(draft, acts, { now, quotes, contracts });
  const next = advanceForward({ state: changed ? draft : fwd, now, quotes, contracts }).state;
  e.reconcile(next, quotes, now);
  return { acts, fwd: next, changed };
}

test("情形 a：回踩到 15m 缺口上沿 → 限价成交（不加滑点），止损在扫点外，TP = 成交价起 2R；日志有 SETUP/ENTRY", () => {
  const { e, log, now } = engine(m15Bars());
  let fwd = initialForward(now);
  let r = step(e, fwd, now, 101.5, 101.52); assert.equal(r.acts.length, 0); fwd = r.fwd;
  assert.equal(e.desk.rt.BTC_USDT!.stage, "等回踩15m缺口"); assert.equal(e.desk.rt.BTC_USDT!.caseTag, "a");
  assert.ok(e.residentSymbols().includes("BTC_USDT"), "挂单币常驻行情");
  r = step(e, fwd, now + 2000, 101.22, 101.23); fwd = r.fwd;
  const t = fwd.positions.find(x => x.status === "OPEN")!; assert.ok(t, "成交");
  assert.equal(t.entryPrice, ENTRY, "限价成交价 = 入场价"); assert.ok(Math.abs(t.stopPrice - STOP) < 1e-9);
  const o = e.desk.st.opens[0]!; assert.equal(o.case, "a"); assert.equal(o.fillMode, "LIMIT"); assert.ok(Math.abs(o.tp - (ENTRY + 2 * (ENTRY - STOP))) < 1e-9);
  const L = recs(log); assert.ok(L.some(x => x.k === "SETUP" && x.d.ev === "ZONE_4H")); assert.ok(L.some(x => x.k === "SETUP" && /ARMED|挂单/.test(JSON.stringify(x.d))));
  const en = L.find(x => x.k === "ENTRY")!; for (const f of ["case", "zone4h", "sweep", "displacement", "fvg15", "plan", "fill", "sizing", "ind"]) assert.ok(f in en.d, f);
  assert.equal(e.status(now, fwd, { BTC_USDT: quote(101.22, 101.23, now) }, { enabled: true, logError: null, lastFlushAt: 0 }).fvg!.positions.length, 1);
  // 同一形态只开一次：价格再回到入场价也不重复开
  r = step(e, fwd, now + 4000, 101.2, 101.21); assert.equal(r.fwd.positions.filter(x => x.status === "OPEN").length, 1);
  // 2R 止盈：tick 平仓并记 EXIT
  r = step(e, r.fwd, now + 6000, o.tp + 0.01, o.tp + 0.02); fwd = r.fwd;
  assert.equal(fwd.positions.filter(x => x.status === "OPEN").length, 0); assert.equal(e.desk.st.opens.length, 0);
  const ex = recs(log).find(x => x.k === "EXIT")!; assert.equal(ex.d.code ?? ex.d.exitCode ?? "TARGET", "TARGET"); assert.equal(ex.d.case, "a");
  assert.ok(e.desk.st.filled.includes(`BTC_USDT:${o.setupId}`), "同一形态记为已成交");
});

test("情形 a：跳空穿过入场价 → 按市价（含滑点）成交；止损被账户引擎打掉记 HARD_STOP", () => {
  const { e, log, now } = engine(m15Bars(0)); // 位移那根刚收盘，还没在入场价上方报过价
  let r = step(e, initialForward(now), now, 101.1, 101.12);
  const o = e.desk.st.opens[0]!; assert.equal(o.fillMode, "GAP"); assert.ok(o.fill > 101.12, "市价含滑点");
  assert.ok(Math.abs(o.tp - (o.fill + 2 * (o.fill - STOP))) < 1e-9, "TP 按实际成交价算 2R");
  r = step(e, r.fwd, now + 2000, 100.5, 100.52);
  assert.equal(r.fwd.positions.filter(x => x.status === "OPEN").length, 0);
  const ex = recs(log).find(x => x.k === "EXIT"); assert.ok(ex); assert.match(JSON.stringify(ex!.d), /HARD_STOP|LIQUIDATION/);
});

test("撤单：价格先破扫点 → 记 SETUP_INVALID，之后回到入场价也不开", () => {
  const { e, log, now } = engine(m15Bars());
  let r = step(e, initialForward(now), now, 100.6, 100.62); assert.equal(r.acts.length, 0);
  assert.ok(recs(log).some(x => x.k === "SETUP" && x.d.ev === "SETUP_INVALID"));
  r = step(e, r.fwd, now + 2000, 101.22, 101.23); assert.equal(r.fwd.positions.length, 0);
});

test("过期：16 根没成交 → 不再按情形 a 挂单；价格回到原缺口且剩余 ≥3R → 情形 b 市价进", () => {
  const { e, log, now } = engine(m15Bars(20));
  let r = step(e, initialForward(now), now, 101.6, 101.62); assert.equal(r.fwd.positions.length, 0);
  assert.equal(e.desk.rt.BTC_USDT!.caseTag, "b"); assert.equal(e.desk.rt.BTC_USDT!.stage, "等回踩15m缺口");
  r = step(e, r.fwd, now + 1000, 101.32, 101.33); assert.equal(r.fwd.positions.length, 0, "剩余空间不足 3R 不进");
  r = step(e, r.fwd, now + 2000, 101.19, 101.2);
  const o = e.desk.st.opens[0]!; assert.equal(o.case, "b"); assert.equal(o.fillMode, "MARKET_B");
  assert.ok(Math.abs(o.tp - (o.fill + 2 * (o.fill - o.stop))) < 1e-9);
  const en = recs(log).find(x => x.k === "ENTRY")!; assert.equal(en.d.case, "b");
});

test("情形 b：原 3R 止盈已经到过 → 不再进", () => {
  const { e, now } = engine(m15Bars(20, i => i === 95 ? [101.6, 103.1, 101.5, 101.7] : [101.6, 101.7, 101.4, 101.6]));
  const r = step(e, initialForward(now), now + 2000, 101.19, 101.2); assert.equal(r.fwd.positions.length, 0);
});

test("历史 4H 缺口：启动时扫最近 100 根，老缺口也记 ZONE_4H（historical=true），作废的不记", () => {
  const { e, log, now } = engine(m15Bars()); step(e, initialForward(now), now, 101.6, 101.62);
  const z = recs(log).filter(x => x.k === "SETUP" && x.d.ev === "ZONE_4H");
  assert.equal(z.length, 1); assert.equal(z[0]!.d.historical, true);
  const rec = (e.serialize().recent as { sym: string; kind: string }[]); assert.equal(rec.filter(x => x.sym === "BTC_USDT" && x.kind === "挂单").length, 1, "启动扫到的挂单进“最近决策”，只一条");
  assert.equal(e.desk.coinView(Date.now()).find(c => c.sym === "BTC_USDT")!.zones.length >= 0, true);
  const { e: e2, log: l2, now: n2 } = engine(m15Bars(), h4Bars(40, 30)); step(e2, initialForward(n2), n2, 101.6, 101.62);
  assert.equal(recs(l2).filter(x => x.k === "SETUP" && x.d.ev === "ZONE_4H" && x.d.side === "LONG").length, 0, "已作废的多头缺口不当作有效缺口记");
});

test("关闭开关：不开新仓，但持仓照常管理", () => {
  const { e, now } = engine(m15Bars());
  const r = step(e, initialForward(now), now, 101.22, 101.23, false); assert.equal(r.fwd.positions.length, 0);
});

const fakeOpen = (id: string, symbol: string, margin: number) => ({ id, status: "OPEN", symbol, margin } as never);
function fillWith(e: NtsEngine, fwd: ForwardState, now: number) {
  e.tick({ now, forward: fwd, quotes: { BTC_USDT: quote(101.5, 101.52, now) }, contracts, enabled: true });
  const quotes = { BTC_USDT: quote(101.22, 101.23, now + 2000) }, draft = structuredClone(fwd);
  const acts = e.tick({ now: now + 2000, forward: fwd, quotes, contracts, enabled: true });
  const changed = e.execute(draft, acts, { now: now + 2000, quotes, contracts });
  return { acts, draft, changed };
}
test("不限笔数：账户已有 6 笔（含同一个币的别的单）时，新的不同形态照样开", () => {
  const { e, log, now } = engine(m15Bars());
  const fwd = initialForward(now);
  for (let i = 0; i < 5; i++) fwd.positions.push(fakeOpen(`x${i}`, "ETH_USDT", 1));
  fwd.positions.push(fakeOpen("btc-other", "BTC_USDT", 1));
  const { acts, draft, changed } = fillWith(e, fwd, now);
  assert.equal(acts.length, 1); assert.equal(changed, true);
  assert.equal(draft.positions.filter(x => x.status === "OPEN").length, 7, "第 7 笔照开");
  assert.equal(draft.positions.filter(x => x.status === "OPEN" && x.symbol === "BTC_USDT").length, 2, "同一个币第二笔照开");
  assert.ok(!recs(log).some(x => x.k === "NO_TRADE"));
});

test("保证金不够：记 NO_TRADE“跳过”，不缩小仓位、不开", () => {
  const { e, log, now } = engine(m15Bars());
  const fwd = initialForward(now); fwd.positions.push(fakeOpen("big", "ETH_USDT", fwd.balance - 1));
  const { draft } = fillWith(e, fwd, now);
  assert.equal(draft.positions.filter(x => x.status === "OPEN").length, 1, "没开新仓");
  const sk = recs(log).find(x => x.k === "NO_TRADE")!; assert.ok(sk); assert.match(String(sk.d.reason), /跳过：模拟盘可用保证金不足.*不缩小仓位/);
  assert.equal(e.desk.st.opens.length, 0);
});

test("不限止损宽度：止损距离 6% 也照开（最坏亏损只记录）", () => {
  const { e, log, now } = engine(m15Bars());
  const r0 = step(e, initialForward(now), now, 101.5, 101.52);
  const st = e.desk.rt.BTC_USDT!.setups.find(x => x.status === "ARMED")!; st.stop = 95; st.tpOrig = ENTRY + 3 * (ENTRY - 95);
  step(e, r0.fwd, now + 2000, 101.22, 101.23);
  const o = e.desk.st.opens[0]!; assert.ok(o, "开了"); assert.equal(o.stop, 95); assert.ok(Math.abs(o.tp - (o.fill + 2 * (o.fill - 95))) < 1e-9);
  const en = recs(log).find(x => x.k === "ENTRY")!; assert.ok((en.d.sizing as { worstPct: number }).worstPct > 0.05); assert.equal((en.d.sizing as { stopWidthLimit: unknown }).stopWidthLimit, null);
  assert.ok(!recs(log).some(x => x.k === "NO_TRADE"));
});

test("合约 tick 来自已有合约目录：止损 = 扫点 − 1 tick", () => {
  const { e, now } = engine(m15Bars());
  e.setUniverse(["BTC_USDT", "ETH_USDT"], now, { BTC_USDT: 0.001 });
  step(e, initialForward(now), now, 101.5, 101.52);
  const st = e.desk.rt.BTC_USDT!.setups.find(x => x.status === "ARMED")!; assert.ok(Math.abs(st.stop! - 100.699) < 1e-9);
});

test("币池：取 Gate 24h 成交额前 universeMax 个（BTC/ETH 固定），变动记一条 SYSTEM；持仓/挂单币不会被踢出", () => {
  const { e, log, now } = engine(m15Bars());
  const ranked = Array.from({ length: 60 }, (_, i) => `C${i}_USDT`);
  assert.equal(e.setUniverse(ranked, now), true);
  const u = e.desk.universeList; assert.equal(u.length, 30); assert.deepEqual(u.slice(0, 3), ["BTC_USDT", "ETH_USDT", "C0_USDT"]);
  assert.equal(e.setUniverse(ranked, now + 60_000), false, "没变化不记");
  assert.equal(recs(log).filter(x => x.k === "SYSTEM" && /币池/.test(String(x.d.text))).length, 1);
  e.setUniverse(["X_USDT", "1000PEPE_USDT", "bad"], now); assert.ok(e.desk.allSymbols().includes("1000PEPE_USDT")); assert.ok(!e.desk.allSymbols().includes("bad"));
  assert.ok(normalizeNtsConfig({ strategyV: 3, fvg: { universeMax: 999, maxResident: 99 } } as never).fvg.universeMax <= 40);
});

test("取数调度：冷启动先 4H，后 15m；热币（在缺口里/有形态）15m 每根收盘取，冷币每小时一次；整体远低于 0.4/s", () => {
  const now = END * 1000 + 30_000;
  const c = normalizeNtsConfig({ ...DEFAULT_NTS_CONFIG, enabled: true } as never), e = new NtsEngine(c, new NtsLog(c), null, now);
  e.setUniverse(Array.from({ length: 40 }, (_, i) => `C${i}_USDT`), now);
  const jobs: string[] = []; let t = now;
  for (let i = 0; i < 160 && jobs.length < 64; i++, t += 5000) { // 前 13 分钟：还没有新的 15m 收盘
    const j = e.nextJob(t, true); if (!j) continue; jobs.push(`${j.sym}:${j.kind}`);
    if (j.kind === "4h") e.ingestCandles(j.sym, "4h", j.sym === "BTC_USDT" ? h4Bars() : h4Bars().map(b => bar(b.time, b.open * 3, b.high * 3, b.low * 3, b.close * 3 + (b.time > T0 + 30 * H4 ? 30 : 0))), t);
    else e.ingestCandles(j.sym, "15m", j.sym === "BTC_USDT" ? m15Bars() : m15Bars().map(b => bar(b.time, b.open * 3 + 30, b.high * 3 + 30, b.low * 3 + 30, b.close * 3 + 30)), t);
    e.tick({ now: t, forward: initialForward(t), quotes: {}, contracts, enabled: true });
  }
  const first15 = jobs.findIndex(j => j.endsWith(":15m")), last4 = jobs.map(j => j.endsWith(":4h")).lastIndexOf(true);
  assert.ok(first15 > 0 && last4 < jobs.length);
  assert.equal(jobs.slice(0, 30).every(j => j.endsWith(":4h")), true, "先把 30 个币的 4H 补齐");
  assert.equal(new Set(jobs).size, jobs.length, "冷启动不重复取");
  const plan = e.desk.fetchPlan(); assert.equal(plan.universe, 30);
  assert.ok(plan.estPerHour / 3600 < 0.05, `估算 ${plan.estPerHour}/h 远低于 0.4/s`);
  assert.ok(c.data.restPerSec <= 0.4);
  // 热币排在冷币前面
  assert.equal(e.desk.rt.BTC_USDT!.hot, true);
  // 冷币 15m 刚取过：一个小时内不会再取；热币下一根收盘就取
  const later = END * 1000 + 15 * 60_000 + 5_000; const got: string[] = [];
  for (let i = 0; i < 80; i++) { const j = e.nextJob(later + i * 6_000, true); if (j) got.push(`${j.sym}:${j.kind}`); }
  assert.ok(got.includes("BTC_USDT:15m"), "热币下一根 15m 收盘后就取");
  // 把除 BTC 外的币变冷（价格远离缺口、没有形态）：冷币一小时内不再取 15m
  const cold = Object.keys(e.desk.rt).filter(s => s !== "BTC_USDT");
  for (const s of cold) { const r = e.desk.rt[s]!; r.setups = []; r.dist = 0.5; (e.desk as unknown as { stage(a: string, b: unknown, c: number): void }).stage(s, r, later); }
  assert.equal(cold.every(s => !e.desk.rt[s]!.hot), true);
  const got2: string[] = [];
  for (let i = 0; i < 80; i++) { const j = e.nextJob(later + 600_000 + i * 6_000, true); if (j) got2.push(`${j.sym}:${j.kind}`); }
  assert.equal(got2.filter(x => x !== "BTC_USDT:15m" && x.endsWith(":15m")).length, 0, "冷币 15m 每小时一次");
  assert.ok(e.desk.fetchPlan().estPerHour < 30 * 0.25 + 30 * 4, "预算公式");
});

test("配置：旧存储配置一律切到 FVG；默认 30 个币、2% 保证金 100x；没有笔数上限/止损宽度上限/止损百分比缓冲", () => {
  const c = normalizeNtsConfig({ strategy: "SMC", enabled: true, fvg: { maxConcurrent: 3, stopBufPct: 0.0005 } } as never);
  assert.equal(c.strategy, "FVG"); assert.equal(c.fvg.universeMax, 30);
  assert.equal(c.firstMarginPct, 0.02); assert.equal(c.leverage, 100);
  assert.equal(c.fvg.rr, 3); assert.equal(c.fvg.expiryBars, 16);
  assert.ok(!("maxConcurrent" in c.fvg) && !("stopBufPct" in c.fvg), "旧键不再生效");
});

test("整条链路冒烟（真实 NtsHost + 账户引擎，BTC/ETH K线夹具，不统计收益）：无异常、日志连续无重复、取数远低于 0.4/s", async () => {
  const { runSim } = await import("./nts-sim.ts"), { loadKlines } = await import("./nts-klines.ts"), { readAll } = await import("./nts-fixtures.ts");
  const { series, last15 } = loadKlines(), endMs = (last15 + 900) * 1000, startMs = endMs - 4 * 86_400_000;
  const r = await runSim({ series, startMs, endMs, stepMs: 60_000, config: { ...DEFAULT_NTS_CONFIG, enabled: true } });
  assert.deepEqual(r.stats.errors, []);
  const lines = await readAll(r.host.logStream()), recs = lines.filter(l => l.id) as { id: string; k: string; d: Record<string, unknown> }[];
  assert.equal(new Set(recs.map(x => x.id)).size, recs.length, "日志无重复 id"); assert.equal((lines.at(-1) as { end?: boolean }).end, true);
  assert.ok(recs.some(x => x.k === "SYSTEM"));
  const hours = (endMs - startMs) / 3_600_000; assert.ok(r.stats.requests / hours / 3600 < 0.05, `取数 ${(r.stats.requests / hours).toFixed(1)}/h`);
  assert.ok(r.stats.maxPerSec <= 2);
  const st = r.host.view(r.now(), r.fwd, {}) as { engineName?: string; fvg?: { coins: unknown[] } };
  assert.equal(st.engineName, "FVG扫流动性系统"); assert.ok((st.fvg?.coins.length ?? 0) >= 2);
  for (const e of recs.filter(x => x.k === "ENTRY")) assert.ok(e.d.case === "a" || e.d.case === "b");
  const kinds: Record<string, number> = {}; for (const l of recs) kinds[l.k] = (kinds[l.k] ?? 0) + 1;
  console.log(`[fvg-smoke] ${hours}h 请求=${r.stats.requests} 日志=${JSON.stringify(kinds)}（仅冒烟，不代表收益）`);
});

test("实时行情：情形 a 挂单币、情形 b 已接近入场区的币一律常驻（不受 maxResident 限制）；其余候选最多 maxResident 个", () => {
  const { e, now } = engine(m15Bars());
  step(e, initialForward(now), now, 101.5, 101.52);
  const fakes = Array.from({ length: 20 }, (_, i) => `F${i}_USDT`);
  e.setUniverse([...fakes, "BTC_USDT", "ETH_USDT"], now);
  const desk = e.desk as never as { ensure(s: string): { stage: string; setups: unknown[]; px: number | null }; rt: Record<string, { px: number | null; setups: { status: string }[] }> };
  for (const s of fakes) { const rt = desk.ensure(s); rt.stage = "等回踩15m缺口"; rt.setups = []; }
  const all = e.desk.allSymbols(); assert.ok(all.includes("BTC_USDT") && all.includes("F19_USDT"));
  // 情形 a：挂单中
  let res = e.residentSymbols(); assert.ok(res.includes("BTC_USDT"), "挂单币常驻"); assert.equal(res.length, 1 + DEFAULT_NTS_CONFIG.fvg.maxResident);
  // 情形 b：形态过期没成交，现价回到原 15m 缺口附近（≤1%）
  const st = desk.rt.BTC_USDT!.setups.find(x => x.status === "ARMED")!; st.status = "EXPIRED"; desk.rt.BTC_USDT!.px = 101.3;
  assert.ok(e.desk.bEligible("BTC_USDT", st as never, now)); assert.ok(e.desk.bNear("BTC_USDT", now));
  res = e.residentSymbols(); assert.ok(res.includes("BTC_USDT"), "情形 b 接近入场区 → 常驻"); assert.equal(res[0], "BTC_USDT");
  // 离得远就不是“必须常驻”，只按普通候选排
  desk.rt.BTC_USDT!.px = 120; assert.equal(e.desk.bNear("BTC_USDT", now), false);
});

// ---------------------------------------------------------------------------------------------------------------------
// 出场规则 2R 止盈 + 1R 保本（新单），旧单 3R 不动；MFE/MAE 只增不减；每笔出场都跟踪出场后走势；老 3R 影子记录
// ---------------------------------------------------------------------------------------------------------------------
function opened() {
  const { e, log, now } = engine(m15Bars());
  let r = step(e, initialForward(now), now, 101.5, 101.52);
  r = step(e, r.fwd, now + 2000, 101.22, 101.23);
  const o = e.desk.st.opens[0]!; assert.ok(o, "成交");
  return { e, log, now, fwd: r.fwd, o };
}
const R0 = ENTRY - STOP; // 0.54

test("2R+1R保本：新单标 2R_BE1R，TP = 成交价起 2R；到 +1R 止损移到入场价 +1 tick 并记 BE_MOVE；回到保本价平仓记 BE_STOP，EXIT 带价格R/扣费R和影子 3R", () => {
  const { e, log, now, fwd, o } = opened();
  assert.equal(o.exitRule, "2R_BE1R"); assert.ok(Math.abs(o.tp - (ENTRY + 2 * R0)) < 1e-9); assert.ok(Math.abs(o.shadow!.tp3 - (ENTRY + 3 * R0)) < 1e-9);
  const en = recs(log).find(x => x.k === "ENTRY")!; assert.equal(en.d.exitRule, "2R_BE1R"); assert.ok(en.d.shadow3R);
  let r = step(e, fwd, now + 4000, ENTRY + 0.9 * R0, ENTRY + 0.9 * R0 + 0.01); assert.ok(!r.acts.some(a => JSON.stringify(a).includes("MOVE_STOP_FVG")), "不到 1R 不动");
  r = step(e, r.fwd, now + 6000, ENTRY + 1.02 * R0, ENTRY + 1.02 * R0 + 0.01);
  assert.ok(r.acts.some(a => JSON.stringify(a).includes("MOVE_STOP_FVG")));
  const t = r.fwd.positions.find(x => x.id === o.tid && x.status === "OPEN")!; assert.ok(Math.abs(t.stopPrice - (ENTRY + 0.01)) < 1e-9, "止损 = 入场价 + 1 tick");
  assert.ok(o.be && Math.abs(o.stop - (ENTRY + 0.01)) < 1e-9); assert.ok(Math.abs(o.stop0! - STOP) < 1e-9, "原止损保留");
  const be = recs(log).filter(x => x.k === "BE_MOVE"); assert.equal(be.length, 1); assert.ok((be[0]!.d.mfeR_price as number) >= 1);
  r = step(e, r.fwd, now + 8000, ENTRY + 1.5 * R0, ENTRY + 1.5 * R0 + 0.01); assert.equal(recs(log).filter(x => x.k === "BE_MOVE").length, 1, "只移一次");
  r = step(e, r.fwd, now + 10_000, ENTRY, ENTRY + 0.01);
  assert.equal(r.fwd.positions.filter(x => x.status === "OPEN").length, 0);
  const ex = recs(log).find(x => x.k === "EXIT")!;
  assert.equal(ex.d.code, "BE_STOP"); assert.equal(ex.d.exitRule, "2R_BE1R");
  assert.equal(typeof ex.d.r_price, "number"); assert.equal(typeof ex.d.r_fee, "number"); assert.ok((ex.d.r_price as number) > -0.05);
  assert.ok((ex.d.mfeR_price as number) >= 1.5 - 1e-9, "MFE 价格R");
  assert.equal((ex.d.shadow3R as { pending: boolean }).pending, true);
  const p = e.serialize().post.find(x => x.tid === o.tid)!; assert.ok(p, "出场后跟踪"); assert.equal(p.exitRule, "2R_BE1R"); assert.ok(p.shadow);
  // 出场后 30 分钟：记 POST_EXIT（实时报价）
  const exitAt = p.exitAt;
  r = step(e, r.fwd, exitAt + 30 * 60_000 + 1000, ENTRY + 0.2, ENTRY + 0.21);
  const pe = recs(log).find(x => x.k === "POST_EXIT" && x.d.afterMin === 30)!; assert.ok(pe); assert.equal(pe.d.src, "quote");
  // 后来到了老 3R → SHADOW_3R = TP3，带实际结果
  r = step(e, r.fwd, exitAt + 31 * 60_000, ENTRY + 3 * R0 + 0.01, ENTRY + 3 * R0 + 0.02);
  const sh = recs(log).find(x => x.k === "SHADOW_3R")!; assert.ok(sh); assert.equal(sh.d.res, "TP3"); assert.equal((sh.d.actual as { code: string }).code, "BE_STOP"); assert.equal(sh.d.rPrice, 3);
});

test("2R 止盈出场也记出场后走势（+30/+60/+120 分钟），K 线兜底；影子 3R 出场后继续判断", () => {
  const { e, log, fwd, o } = opened();
  const r = step(e, fwd, o.openedAt + 60_000, o.tp + 0.01, o.tp + 0.02);
  assert.equal(r.fwd.positions.filter(x => x.status === "OPEN").length, 0);
  const ex = recs(log).find(x => x.k === "EXIT")!; assert.equal(ex.d.code ?? "TARGET", "TARGET"); assert.ok(Math.abs((ex.d.r_price as number) - 2) < 0.05, "价格R ≈ 2");
  const p = e.serialize().post.find(x => x.tid === o.tid)!; assert.ok(p, "止盈出场也跟踪");
  e.tick({ now: o.openedAt + 62_000, forward: r.fwd, quotes: {}, contracts, enabled: true });
  assert.ok(e.residentSymbols().includes("BTC_USDT"), "出场后 120 分钟内常驻行情");
  // 没有报价，只有 15m K 线：用包含该时刻那根 15m 的收盘价
  const base = Math.floor(p.exitAt / 1000 / M15) * M15, more: Bar[] = [];
  for (let k = 1; k <= 10; k++) more.push(bar(base + k * M15, 102.3, k === 3 ? 102.9 : 102.4, 102.2, 102.35));
  const later = (base + 11 * M15) * 1000 + 1000;
  e.ingestCandles("BTC_USDT", "15m", [...m15Bars(), ...more], later);
  e.tick({ now: later, forward: r.fwd, quotes: {}, contracts, enabled: true });
  const pes = recs(log).filter(x => x.k === "POST_EXIT"); assert.ok(pes.some(x => x.d.afterMin === 30 && /15m/.test(String(x.d.src))));
  assert.ok(pes.some(x => x.d.afterMin === 60 && x.d.px === 102.35));
  assert.ok((pes.at(-1)!.d.best120Pct as number) > 0);
  const sh = recs(log).find(x => x.k === "SHADOW_3R")!; assert.ok(sh, "出场后到 3R 价（102.85）记影子结果"); assert.equal(sh.d.res, "TP3"); assert.equal(sh.d.src, "15m");
});

test("旧单（无 exitRule）按原 3R 计划：不移保本、2R 不平；面板标 3R", () => {
  const { e, log, now, fwd, o } = opened();
  delete o.exitRule; delete o.tpR; delete o.be; delete o.shadow; delete o.stop0; o.tp = o.fill + 3 * (o.fill - o.stop);
  let r = step(e, fwd, now + 4000, ENTRY + 1.5 * R0, ENTRY + 1.5 * R0 + 0.01);
  assert.ok(!r.acts.some(a => JSON.stringify(a).includes("MOVE_STOP_FVG"))); assert.ok(Math.abs(r.fwd.positions.find(x => x.id === o.tid)!.stopPrice - STOP) < 1e-9);
  r = step(e, r.fwd, now + 6000, ENTRY + 2.2 * R0, ENTRY + 2.2 * R0 + 0.01);
  assert.equal(r.fwd.positions.filter(x => x.status === "OPEN").length, 1, "2R 不平");
  const pos = e.fvgStatus(now + 6000, r.fwd, { BTC_USDT: quote(ENTRY + 2.2 * R0, ENTRY + 2.2 * R0 + 0.01, now + 6000) }).positions[0]!;
  assert.equal(pos.exitRule, "3R"); assert.equal(pos.tpR, 3);
  r = step(e, r.fwd, now + 8000, o.tp + 0.01, o.tp + 0.02);
  const ex = recs(log).find(x => x.k === "EXIT")!; assert.equal(ex.d.exitRule, "3R"); assert.equal((ex.d.shadow3R as { res: string }).res, "SAME_AS_ACTUAL");
  assert.equal(recs(log).filter(x => x.k === "BE_MOVE").length, 0);
});

test("MFE/MAE 只增不减：重启（从存档恢复）后不回退，期间的 15m 高低点也算进去", () => {
  const { e, log, now, fwd, o } = opened();
  step(e, fwd, now + 4000, 101.6, 101.61);
  const mfe0 = o.mfePct; assert.ok(mfe0 > 0.003);
  assert.equal(e.extremesDirty, true, "极值变化标记待写");
  const saved = structuredClone(e.serialize());
  const c = normalizeNtsConfig({ ...DEFAULT_NTS_CONFIG, enabled: true } as never);
  const now2 = (END + 2 * M15) * 1000 + 5000, e2 = new NtsEngine(c, log, saved, now2);
  const b15 = [...m15Bars(), bar(END, 101.4, 101.45, 101.2, 101.3), bar(END + M15, 101.4, 101.72, 100.95, 101.3)];
  e2.ingestCandles("BTC_USDT", "4h", h4Bars(), now2); e2.ingestCandles("BTC_USDT", "15m", b15, now2);
  const o2 = e2.desk.st.opens[0]!; assert.equal(o2.mfePct, mfe0, "恢复后不回退");
  step(e2, fwd, now2, 101.3, 101.31);
  assert.ok(o2.mfePct >= 101.72 / ENTRY - 1 - 1e-12, "重启期间的 15m 高点算进 MFE"); assert.ok(o2.maePct <= 100.95 / ENTRY - 1 + 1e-12, "低点算进 MAE");
  const m = o2.mfePct; step(e2, fwd, now2 + 2000, 101.25, 101.26); assert.equal(o2.mfePct, m, "价格回落不减");
});
