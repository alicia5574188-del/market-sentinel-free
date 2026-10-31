import test from "node:test";
import assert from "node:assert/strict";
import { dailyExit, evaluateDailyEntry, isDailyDecisionBar, type DailyCfg } from "../lib/nts/daily.ts";
import { DEFAULT_NTS_CONFIG, normalizeNtsConfig } from "../lib/nts/config.ts";
import { NtsEngine } from "../lib/nts/engine.ts";
import { NtsLog } from "../lib/nts/log.ts";
import { initialForward } from "../lib/forward-relations.ts";
import type { Bar } from "../lib/nts/types.ts";
import { CONTRACT, quote } from "./nts-fixtures.ts";

const CFG: DailyCfg = DEFAULT_NTS_CONFIG.daily;
const DAY = 86_400, END = 1_761_955_200; // 2025-11-01 00:00 UTC (= 07:00 老挝时间)
/** n 根 tf 秒 K 线，最后一根在 END 收盘；price(i) 给收盘价。 */
function series(n: number, tf: number, price: (i: number) => number): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) { const c = price(i), o = i ? out[i - 1]!.close : c; out.push({ time: END - (n - i) * tf, open: o, close: c, high: Math.max(o, c) * 1.0008, low: Math.min(o, c) * 0.9992, volume: 100 }); }
  return out;
}
const falling = (n: number, tf: number) => series(n, tf, i => 100 * (1 - 0.0003 * i) + 0.05 * Math.sin(i));
const rising = (n: number, tf: number) => series(n, tf, i => 100 * (1 + 0.0003 * i) + 0.05 * Math.sin(i));

test("每日决策根：只有 UTC 00:00（老挝 07:00）收盘的那根 15m", () => {
  assert.equal(isDailyDecisionBar(END - 900, CFG), true);
  assert.equal(isDailyDecisionBar(END, CFG), false);
  assert.equal(isDailyDecisionBar(END - 1800, CFG), false);
  assert.equal(isDailyDecisionBar(END + DAY - 900, CFG), true);
  assert.equal(isDailyDecisionBar(END - 900 + 3600, { ...CFG, decideUtcHour: 1 }), true);
});
test("只做空：24h 下跌 → 做空，止损 = 进场 + k×A，到期 = 决策收盘 + 持有时长；24h 上涨 → 不做（写明原因）", () => {
  const b = falling(300, 900), bt = b.at(-1)!.time, px = b.at(-1)!.close;
  const d = evaluateDailyEntry("BTC_USDT", px - 0.01, px + 0.01, b, bt, CFG, 0.02, END * 1000);
  assert.equal(d.action, "ENTER"); if (d.action !== "ENTER") return;
  assert.equal(d.side, "SHORT"); assert.ok(d.plan.ret24 < 0);
  assert.ok(d.plan.stop > d.plan.entry); assert.ok(Math.abs(d.plan.stop - d.plan.entry - CFG.k * d.plan.band) < 1e-3);
  assert.ok(Math.abs(d.plan.trailDist - CFG.k * d.plan.band) < 1e-3); assert.equal(d.plan.exitAt, END * 1000 + CFG.holdMs);
  assert.match(d.plan.basis, /过去24h/);
  const u = rising(300, 900), ut = u.at(-1)!.time;
  const n = evaluateDailyEntry("BTC_USDT", 99, 101, u, ut, CFG, 0.02, END * 1000);
  assert.equal(n.action, "NO_TRADE"); if (n.action === "NO_TRADE") assert.match(n.reason, /只做空/);
});
test("多空模式（BOTH）：24h 上涨 → 做多，止损在下方；K 线不足 → 不做", () => {
  const u = rising(300, 900), ut = u.at(-1)!.time;
  const d = evaluateDailyEntry("ETH_USDT", 99, 101, u, ut, { ...CFG, sides: "BOTH" }, 0.02, END * 1000);
  assert.equal(d.action, "ENTER"); if (d.action === "ENTER") { assert.equal(d.side, "LONG"); assert.ok(d.plan.stop < d.plan.entry); }
  const short = rising(60, 900);
  assert.equal(evaluateDailyEntry("ETH_USDT", 99, 101, short, short.at(-1)!.time, CFG, 0.02, 0).action, "NO_TRADE");
});
test("每日出场：按最有利价追踪；回撤触及追踪价平仓；到期平仓", () => {
  const o = { side: "SHORT" as const, best: 100, stop: 102, trailDist: 2, exitAt: 10_000 };
  assert.equal(dailyExit(o, 101, 0).action, "HOLD");
  const h = dailyExit(o, 97, 0); assert.equal(h.action, "HOLD"); assert.equal(h.best, 97);
  const t = dailyExit({ ...o, best: 97 }, 99.2, 0); assert.equal(t.action, "CLOSE"); if (t.action === "CLOSE") { assert.equal(t.code, "TRAIL"); assert.equal(t.trail, 99); }
  const x = dailyExit(o, 100.5, 10_000); assert.equal(x.action, "CLOSE"); if (x.action === "CLOSE") assert.equal(x.code, "TIME");
  const l = dailyExit({ side: "LONG", best: 105, stop: 98, trailDist: 2, exitAt: 1e12 }, 102.9, 0); assert.equal(l.action, "CLOSE");
});
test("配置：默认仍是 SMC；strategy/daily 可设置并夹在安全范围", () => {
  assert.equal(DEFAULT_NTS_CONFIG.strategy, "SMC");
  assert.equal(normalizeNtsConfig({}).strategy, "SMC");
  assert.equal(normalizeNtsConfig({ strategy: "nonsense" }).strategy, "SMC");
  const c = normalizeNtsConfig({ strategy: "DAILY", daily: { sides: "BOTH", lookbackBars: 9999, k: 99, decideUtcHour: 25, holdMs: 1 } });
  assert.equal(c.strategy, "DAILY"); assert.equal(c.daily.sides, "BOTH");
  assert.ok(c.daily.lookbackBars <= 250 && c.daily.k <= 5 && c.daily.decideUtcHour === 1 && c.daily.holdMs >= 15 * 60_000);
});

function dailyEngine(now: number) {
  const eng = new NtsEngine({ ...DEFAULT_NTS_CONFIG, strategy: "DAILY" }, new NtsLog(DEFAULT_NTS_CONFIG), null, now);
  for (const sym of ["BTC_USDT", "ETH_USDT"]) {
    eng.ingestCandles(sym, "15m", falling(300, 900), now); eng.ingestCandles(sym, "1h", falling(300, 3600), now);
    eng.ingestCandles(sym, "4h", falling(300, 14_400), now); eng.ingestCandles(sym, "1d", falling(260, DAY), now);
    eng.ingestTicker(sym, { funding: 0.0001, oi: 1e6, mark: 91, index: 91 }, now);
  }
  return eng;
}
test("引擎 DAILY：决策根收盘后开空（2% 保证金、100x），ENTRY 日志写明依据，到期 TIME 平仓；ETH 同时信号只记否决", () => {
  const now = END * 1000 + 30_000, eng = dailyEngine(now), fwd = initialForward(now);
  const px = falling(300, 900).at(-1)!.close, q = quote(px - 0.005, px + 0.005, now);
  const c = { now, forward: fwd, quotes: { BTC_USDT: q, ETH_USDT: q }, contracts: { BTC_USDT: CONTRACT, ETH_USDT: CONTRACT }, enabled: true };
  const acts = eng.tick(c);
  assert.equal(acts.length, 1, JSON.stringify(eng.s.lastEval)); assert.equal(acts[0]!.type, "OPEN_DAILY");
  assert.equal(eng.execute(fwd, acts, c), true);
  const t = fwd.positions[0]!; assert.equal(t.side, "SHORT"); assert.equal(t.leverage, 100); assert.equal(t.liveEligible, false);
  assert.ok(t.margin <= 1000 * DEFAULT_NTS_CONFIG.firstMarginPct * 1.001 && t.margin > 10);
  assert.ok(eng.s.open?.daily && eng.s.open.plannedAdd == null, "不补仓");
  const recs = Object.values(eng.log.take()).flatMap(x => x.recs), e = recs.find(x => x.k === "ENTRY")!;
  assert.equal(e.d.strategy, "DAILY"); assert.match(String(e.d.basis), /过去24h/); assert.ok("ind" in e.d, "RSI/MACD 等指标随日志记录");
  assert.ok(recs.some(x => x.k === "NO_TRADE" && String(x.d.reason).includes("只持一笔")));
  const st = eng.status(now, fwd, c.quotes, { enabled: true, logError: null, lastFlushAt: 0 }) as { strategy?: string; position?: { daily?: unknown } };
  assert.equal(st.strategy, "DAILY"); assert.ok(st.position?.daily, "面板拿到追踪/到期信息");
  // 下一根 15m 不是决策根，持仓中只看出场
  const later = END * 1000 + CFG.holdMs + 1000, q2 = quote(px - 0.005, px + 0.005, later);
  const c2 = { ...c, now: later, quotes: { BTC_USDT: q2, ETH_USDT: q2 } };
  const a2 = eng.tick(c2); assert.equal(a2.length, 1); assert.equal(a2[0]!.type, "CLOSE");
  if (a2[0]!.type === "CLOSE") assert.equal(a2[0]!.code, "TIME");
  assert.equal(eng.execute(fwd, a2, c2), true); assert.equal(fwd.positions.length, 0); assert.equal(eng.s.open, null);
});
test("引擎 DAILY：非决策根不开仓、不写日志", () => {
  const now = (END + 900) * 1000 + 30_000, eng = dailyEngine(now), fwd = initialForward(now);
  for (const sym of ["BTC_USDT", "ETH_USDT"]) eng.ingestCandles(sym, "15m", falling(300, 900).map(b => ({ ...b, time: b.time + 900 })), now);
  const q = quote(90, 90.01, now);
  const acts = eng.tick({ now, forward: fwd, quotes: { BTC_USDT: q, ETH_USDT: q }, contracts: { BTC_USDT: CONTRACT, ETH_USDT: CONTRACT }, enabled: true });
  assert.equal(acts.length, 0);
  assert.equal(Object.values(eng.log.take()).flatMap(x => x.recs).filter(x => x.k === "NO_TRADE").length, 0);
});
