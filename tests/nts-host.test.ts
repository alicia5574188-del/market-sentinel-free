import test from "node:test";
import assert from "node:assert/strict";
import { initialForward, type Contract, type Quote } from "../lib/forward-relations.ts";
import { ARCHIVE_SCHEMA } from "../lib/run-log-archive.ts";
import { LIVING_LOG_SCHEMA } from "../lib/living/runlog-d1.ts";
import { NTS_STATE_KEY } from "../lib/nts/engine.ts";
import { NtsHost, type HostDeps } from "../lib/nts/host.ts";
import { NTS_RESET_KEY, newResetRecord } from "../lib/nts/reset.ts";
import { CONTRACT, memStorage, openScenario, quote, readAll, sqliteD1 } from "./nts-fixtures.ts";

const NOW = 1_760_000_000_000;
type Opts = { reset?: "done" | "none"; db?: boolean; reserve?: boolean; seed?: Record<string, unknown> };
function setup(o: Opts = {}) {
  const st = memStorage(o.seed ?? {});
  if (o.reset === "done") { const r = newResetRecord(NOW - 1e6); r.phase = "done"; r.resetLogged = true; r.hotCleared = true; r.verified = true; st.m.set(NTS_RESET_KEY, r); }
  const db = sqliteD1(); for (const s of [...ARCHIVE_SCHEMA, ...LIVING_LOG_SCHEMA]) db.raw.exec(s);
  const calls = { candles: 0, ticker: 0, memReset: 0, reserve: [] as [number, string][], spends: 0 };
  const t = { now: NOW, spend: true, reserve: o.reserve ?? true, candleFail: false };
  const deps: HostDeps = {
    storage: st as never, db: () => (o.db === false ? null : db),
    candles: async () => { calls.candles++; if (t.candleFail) throw new Error("gate 503"); return []; },
    ticker: async () => { calls.ticker++; if (t.candleFail) throw new Error("gate 503"); return { funding: 0.0001, oi: 1000, mark: 100, index: 100 }; },
    spend: () => { calls.spends++; return t.spend; }, reserve: (rows, tag) => { calls.reserve.push([rows, tag]); return t.reserve ? { finish: () => {} } : null; },
    resetMemory: () => { calls.memReset++; }, now: () => t.now,
  };
  return { st, db, calls, t, deps, host: new NtsHost(deps) };
}
const quotes = (q = quote(99.99, 100.01, NOW)): Record<string, Quote> => ({ BTC_USDT: q });
const contracts: Record<string, Contract> = { BTC_USDT: CONTRACT };

test("启动失败只记 bootError、不抛；交易周期钩子全部空转；30 秒后自动重试并恢复", async () => {
  const s = setup(); s.st.st.failList = false; const orig = s.st.get; let broken = true;
  (s.st as { get: unknown }).get = async (k: string) => { if (broken) throw new Error("storage down"); return orig(k); };
  assert.equal(await s.host.boot(NOW), false); assert.match(s.host.bootError!, /NTS_BOOT/);
  assert.equal(s.host.before(NOW, initialForward(NOW), quotes(), contracts), null); assert.equal(s.host.after(NOW, initialForward(NOW), quotes()), false);
  assert.deepEqual(s.host.entries(NOW), { entries: {}, rows: 0 }); assert.equal(s.host.background(NOW + 1000), null, "退避期内不重试");
  assert.equal(s.host.healthView(NOW, null, {}).degraded, true); assert.equal((s.host.view(NOW, null, {}) as { ready: boolean }).ready, false);
  broken = false; await s.host.background(NOW + 31_000); assert.equal(s.host.ready, true); assert.equal(s.host.bootError, null);
});
test("日志重置没完成前不开新仓（引擎收到 enabled=false）；完成后才放行", async () => {
  for (const [reset, expected] of [["none", false], ["done", true]] as const) {
    const s = setup({ reset }); await s.host.boot(NOW); let seen: boolean | null = null; const orig = s.host.engine.tick.bind(s.host.engine);
    s.host.engine.tick = (c => { seen = c.enabled; return orig(c); }) as never;
    s.host.before(NOW, initialForward(NOW), quotes(), contracts); assert.equal(seen, expected, reset);
    assert.equal(s.host.entriesAllowed, expected);
  }
});
test("开仓周期：账户副本里下单（2% 保证金、纸面）；原账户不被改；落盘条目含状态+日志；commit 后清脏", async () => {
  const s = setup({ reset: "done" }); await s.host.boot(NOW); const sc = openScenario(NOW), prev = initialForward(NOW), before = JSON.stringify(prev);
  s.host.engine.tick = (() => [sc.action]) as never;
  const draft = s.host.before(NOW, prev, quotes(sc.q), contracts); assert.ok(draft);
  assert.equal(JSON.stringify(prev), before, "原账户对象未被改动"); assert.equal(draft.positions.length, 1);
  const p = draft.positions[0]!; assert.equal((p as { liveEligible?: boolean }).liveEligible, false); assert.equal(p.leverage, 100);
  assert.ok(p.margin <= 20.02 && p.margin > 10, `首仓保证金 ≤ 2% × 1000U：${p.margin}`); assert.equal(s.host.mustPersist, true);
  const e = s.host.entries(NOW); assert.ok(NTS_STATE_KEY in e.entries); assert.ok(Object.keys(e.entries).some(k => k.startsWith("nts:log:")));
  s.host.committed(NOW); assert.equal(s.host.mustPersist, false); assert.equal(s.host.log.pending, 0);
});
test("提交失败：日志块放回缓冲、引擎状态回到本轮之前（账户也没改，二者一致）；之后可正常重试", async () => {
  const s = setup({ reset: "done" }); await s.host.boot(NOW); const sc = openScenario(NOW);
  s.host.engine.tick = (() => [sc.action]) as never; const openBefore = s.host.engine.s.open;
  const draft = s.host.before(NOW, initialForward(NOW), quotes(sc.q), contracts); assert.ok(draft); assert.ok(s.host.engine.s.open);
  const pend = s.host.log.pending; s.host.entries(NOW); assert.equal(s.host.log.pending, 0);
  s.host.failed(new Error("txn aborted")); assert.equal(s.host.engine.s.open, openBefore); assert.ok(s.host.log.pending >= pend, "日志块放回");
  assert.match(s.host.logError!, /NTS_COMMIT/); assert.equal(s.host.mustPersist, false);
  s.host.failed(new Error("again")); // 没有在途内容 → 无事发生
});
test("决策函数抛异常 → 不抛进交易周期，返回 null 并记 lastDecisionError", async () => {
  const s = setup({ reset: "done" }); await s.host.boot(NOW);
  s.host.engine.tick = (() => { throw new Error("boom"); }) as never;
  assert.equal(s.host.before(NOW, initialForward(NOW), quotes(), contracts), null); assert.match(s.host.engine.lastDecisionError!, /boom/);
  assert.ok(s.host.notes(NOW, null, quotes()).some(n => n.includes("决策异常")));
});
test("开关关闭：不再开新仓、不再订阅行情；已有持仓仍照常管理（tick 照跑）", async () => {
  const s = setup({ reset: "done" }); await s.host.boot(NOW); assert.deepEqual(s.host.symbols().sort(), ["BTC_USDT", "ETH_USDT"]);
  await s.host.setEnabled(false); assert.deepEqual(s.host.symbols(), []); assert.equal(s.host.entriesAllowed, false);
  let seen: { enabled: boolean } | null = null; const orig = s.host.engine.tick.bind(s.host.engine); s.host.engine.tick = (c => { seen = c; return orig(c); }) as never;
  s.host.before(NOW, initialForward(NOW), quotes(), contracts); assert.equal(seen!.enabled, false, "仍然调用 tick 以管理持仓，但不允许开仓");
  assert.equal(s.host.background(NOW + 100_000)?.constructor, Promise, "后台仍可刷日志/重置"); assert.equal(s.calls.candles + s.calls.ticker, 0, "关闭后不再向 Gate 取数");
  assert.equal((s.st.m.get("nts:config:v1") ?? s.st.m.get([...s.st.m.keys()].find(k => k.includes("config"))!)) != null, true, "开关落盘");
});
test("取数失败/没有令牌：只退避，不抛；有令牌才发请求", async () => {
  const s = setup({ reset: "done" }); await s.host.boot(NOW);
  s.t.spend = false; await s.host.background(NOW + 1000); assert.equal(s.calls.candles + s.calls.ticker, 0);
  s.t.spend = true; s.t.candleFail = true; await s.host.background(NOW + 2000);
  assert.ok(s.host.engine.restFails >= 1); assert.match(s.host.engine.lastFetchError ?? "", /503/);
  assert.ok(s.host.notes(NOW + 3000, null, quotes()).length > 0);
});
test("日志写失败：只记 logError，缓冲保留，下次重试成功；预算不足则本轮跳过", async () => {
  const s = setup({ reset: "done" }); await s.host.boot(NOW); assert.ok(s.host.log.pending > 0);
  s.st.st.failPut = true; await s.host.flushLog(NOW); assert.match(s.host.logError!, /NTS_LOG_WRITE/); assert.ok(s.host.log.pending > 0);
  assert.ok(s.host.healthView(NOW, null, quotes()).notes.some(n => n.includes("日志写入失败")));
  s.st.st.failPut = false; s.t.reserve = false; await s.host.flushLog(NOW + 1); assert.ok(s.host.log.pending > 0, "预算不足：不写");
  s.t.reserve = true; await s.host.flushLog(NOW + 2); assert.equal(s.host.log.pending, 0); assert.equal(s.host.logError, null);
});
test("下载导出：写入预算不足时，内存里还没落盘的记录也会出现在导出里，且不重复", async () => {
  const s = setup({ reset: "done" }); await s.host.boot(NOW); await s.host.flushLog(NOW);
  s.host.log.append({ id: "x:1", k: "SYSTEM", t: NOW + 10, d: { text: "pending-one" } }, NOW + 10); s.t.reserve = false;
  const lines = await readAll(s.host.logStream()), ids = lines.map(l => l.id).filter(Boolean);
  assert.ok(ids.includes("x:1")); assert.equal(new Set(ids).size, ids.length); assert.equal((lines.at(-1) as { end: boolean }).end, true);
  assert.ok(s.host.log.pending > 0, "导出不改变缓冲");
});
test("一次性重置经宿主走完：D1 缺失时永不开仓；D1 在时备份→热状态清除握手→写“日志已重置”→放行开仓", async () => {
  const none = setup({ db: false }); await none.host.boot(NOW);
  for (let i = 1; i <= 4; i++) { none.t.now = NOW + i * 70_000; await none.host.background(none.t.now); }
  assert.equal(none.host.resetDone, false); assert.equal(none.host.entriesAllowed, false); assert.ok(none.host.notes(none.t.now, null, {}).some(n => n.includes("旧日志")));

  const seed: Record<string, unknown> = { "log:eqmin:1": { keep: 1 } }; for (let i = 0; i < 5; i++) seed[`log:review:v1:${i}`] = { i };
  const s = setup({ seed }); await s.host.boot(NOW); let fwd = initialForward(NOW); fwd.signalTally = { a: 1 } as never;
  for (let i = 1; i <= 60 && !s.host.resetDone; i++) {
    s.t.now = NOW + 25_000 + i * 5_000; await s.host.background(s.t.now);
    const d = s.host.before(s.t.now, fwd, quotes(quote(99.99, 100.01, s.t.now)), contracts);
    if (d) fwd = d; if (s.host.mustPersist) { s.host.entries(s.t.now); s.host.committed(s.t.now); }
  }
  assert.equal(s.host.resetDone, true, JSON.stringify(s.host.resetView())); assert.equal(s.host.hotClearDone, true); assert.ok(s.calls.memReset >= 1);
  assert.deepEqual(fwd.signalTally, {}, "账户内的研究类日志行被清"); assert.equal(s.st.m.has("log:eqmin:1"), true); assert.equal(s.st.m.has("log:review:v1:0"), false);
  await s.host.flushLog(s.t.now); assert.equal(s.host.entriesAllowed, true);
  const lines = await readAll(s.host.logStream()); assert.equal(lines.filter(l => (l.d as { text?: string } | undefined)?.text === "日志已重置").length, 1);
  assert.ok((await readAll(s.host.backupStream()!)).some(l => l.table === "do_keys"), "旧日志备份可下载");
  // 重启（新宿主，同一存储）不会重复写，也不会再清
  const again = new NtsHost(s.deps); await again.boot(s.t.now + 1e6); for (let i = 0; i < 5; i++) await again.background(s.t.now + 1e6 + i * 10_000);
  await again.flushLog(s.t.now + 2e6);
  assert.equal((await readAll(again.logStream())).filter(l => (l.d as { text?: string } | undefined)?.text === "日志已重置").length, 1);
});
