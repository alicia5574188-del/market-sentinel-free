import test from "node:test";
import assert from "node:assert/strict";
import { initialForward } from "../lib/forward-relations.ts";
import { ARCHIVE_SCHEMA } from "../lib/run-log-archive.ts";
import { LIVING_LOG_SCHEMA } from "../lib/living/runlog-d1.ts";
import { DEFAULT_NTS_CONFIG as C } from "../lib/nts/config.ts";
import { NtsLog } from "../lib/nts/log.ts";
import { BACKUP_DO_TABLE, RESET_D1_TABLES, backupExportStream, bakName, clearLogOnlyForward, newResetRecord, normalizeResetRecord, runResetStep, type ResetRecord } from "../lib/nts/reset.ts";
import { memStorage, readAll, sqliteD1 } from "./nts-fixtures.ts";

const T = 1_760_000_000_000;
function world() {
  const db = sqliteD1(), seed: Record<string, unknown> = {};
  for (const s of [...ARCHIVE_SCHEMA, ...LIVING_LOG_SCHEMA]) db.raw.exec(s);
  db.raw.exec(`CREATE TABLE IF NOT EXISTS strategy_runtime_log (id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, version TEXT NOT NULL, scanned_markets INTEGER NOT NULL,
  stable_markets INTEGER NOT NULL, realtime_markets INTEGER NOT NULL, regime_counts_json TEXT NOT NULL DEFAULT '{}', strategy_metrics_json TEXT NOT NULL DEFAULT '[]',
  shadow_open INTEGER NOT NULL, shadow_resolved INTEGER NOT NULL, active_strategies INTEGER NOT NULL, portfolio_open INTEGER NOT NULL, portfolio_equity REAL NOT NULL,
  portfolio_resolved INTEGER NOT NULL, portfolio_net_pnl REAL NOT NULL, strategy_candle_error TEXT, authority_state TEXT NOT NULL,
  live_requested INTEGER NOT NULL DEFAULT 0, live_operational INTEGER NOT NULL DEFAULT 0)`);
  for (let i = 0; i < 7; i++) db.raw.prepare(`INSERT INTO run_log_archive (id,kind,opened_at,archived_at,bytes,row_json) VALUES (?,?,?,?,?,?)`).run(`a${i}`, "position", T + i, T, 10, "{}");
  for (let i = 0; i < 3; i++) db.raw.prepare(`INSERT INTO run_log_stages (at,archived_at,entry_json) VALUES (?,?,?)`).run(T + i, T, "{}");
  db.raw.prepare(`INSERT INTO run_log_archive_meta (key,value,updated_at) VALUES ('stats','{}',?)`).run(T);
  for (let i = 0; i < 4; i++) db.raw.prepare(`INSERT INTO living_run_log (id,kind,at,archived_at,json) VALUES (?,?,?,?,?)`).run(`l${i}`, "case", T + i, T, "{}");
  db.raw.prepare(`INSERT INTO strategy_runtime_log (id,observed_at,version,scanned_markets,stable_markets,realtime_markets,shadow_open,shadow_resolved,active_strategies,portfolio_open,portfolio_equity,portfolio_resolved,portfolio_net_pnl,authority_state) VALUES ('s1',?, 'v',1,1,1,0,0,0,0,1000,0,0,'x')`).run(T);
  for (let i = 0; i < 5; i++) db.raw.prepare(`INSERT INTO run_log_equity_days (day,first_ts,last_ts,archived_at,rows_json) VALUES (?,?,?,?,?)`).run(`2026-10-0${i + 1}`, T, T, T, "[1,2,3]");
  for (let i = 0; i < 95; i++) seed[`log:review:v1:${String(i).padStart(4, "0")}`] = { i, text: "x".repeat(50) };
  seed["log:review:v1:unopened:1"] = { u: 1 }; seed["market-intelligence:trade-paths:v2"] = { trades: [1, 2] }; seed["market-intelligence:trade-paths:v1"] = { old: 1 }; seed["log:export:last"] = { at: T };
  // 必须保留的键：权益分钟线、订单账本/论文账户、NTS 自己的日志
  seed["log:eqmin:2026-10-01"] = { rows: [1, 2, 3] }; seed["forward:state"] = { balance: 1000 }; seed["order-journal:v1"] = { orders: [1] }; seed["nts:log:v1:0000000000000:000"] = { v: 1, recs: [] };
  return { db, st: memStorage(seed), seedKeys: Object.keys(seed) };
}
const DO_LOG = (k: string) => k.startsWith("log:review:v1:") || k.startsWith("market-intelligence:trade-paths:") || k === "log:export:last";
type W = ReturnType<typeof world>;
function mkHost(w: W, log: NtsLog, over: Partial<Parameters<typeof runResetStep>[1]> = {}, saves: ResetRecord[] = []) {
  return { db: w.db, storage: w.st, log, now: T + 5000, clearHot: () => true, save: async (r: ResetRecord) => { saves.push(structuredClone(r)); w.st.m.set("nts:reset:v1", structuredClone(r)); }, ...over };
}
async function drive(rec: ResetRecord, h: ReturnType<typeof mkHost>, max = 80) { for (let i = 0; i < max && rec.phase !== "done"; i++) await runResetStep(rec, h); return rec; }
const count = (db: ReturnType<typeof sqliteD1>, t: string) => (db.raw.prepare(`SELECT COUNT(*) n FROM "${t}"`).get() as { n: number }).n;
const logRecs = (log: NtsLog) => Object.values(log.take()).flatMap(c => c.recs);

test("完整流程：先备份 → 改名保留旧表 → 删 DO 旧日志 → 写一条“日志已重置”；订单/权益/其它键原样", async () => {
  const w = world(), log = new NtsLog(C), rec = newResetRecord(T), toClear = w.seedKeys.filter(DO_LOG);
  await drive(rec, mkHost(w, log));
  assert.equal(rec.phase, "done"); assert.equal(rec.verified, true); assert.equal(rec.copied, toClear.length); assert.equal(rec.deleted, toClear.length);
  // D1：旧表整张留在 __bak_nts1，行数不变；新表为空；权益曲线表不动
  const expect: Record<string, number> = { run_log_archive: 7, run_log_stages: 3, run_log_archive_meta: 1, living_run_log: 4, strategy_runtime_log: 1 };
  for (const { table } of RESET_D1_TABLES) { assert.equal(count(w.db, bakName(table)), expect[table], table); assert.equal(count(w.db, table), 0, table + " 新表为空"); }
  assert.equal(count(w.db, "run_log_equity_days"), 5, "权益曲线不动");
  assert.equal(count(w.db, BACKUP_DO_TABLE), toClear.length);
  // DO：旧日志键没了，其它键都在
  for (const k of w.seedKeys) assert.equal(w.st.m.has(k), !DO_LOG(k), k);
  // 第一条日志
  const recs = logRecs(log).filter(r => r.k === "SYSTEM" && r.d.text === "日志已重置"); assert.equal(recs.length, 1);
  assert.equal(recs[0]!.id, "sys:reset:v1");
});
test("备份失败 → 一律不清除（D1 表、DO 键都原样），修好后继续；失败期间不会进入改名/删除阶段", async () => {
  const w = world(), log = new NtsLog(C), rec = newResetRecord(T), h = mkHost(w, log);
  w.db.ctl.fail = t => t.includes(`INSERT OR REPLACE INTO ${BACKUP_DO_TABLE}`);
  for (let i = 0; i < 12; i++) await runResetStep(rec, h);
  assert.equal(rec.phase, "backup"); assert.ok(rec.failures >= 12 && rec.lastError);
  assert.equal(w.st.st.deleted, 0, "没有删任何 DO 键");
  for (const { table } of RESET_D1_TABLES) { assert.equal(count(w.db, table), expect(table)); assert.equal(w.db.raw.prepare(`SELECT name FROM sqlite_master WHERE name=?`).get(bakName(table)), undefined); }
  assert.equal(logRecs(log).filter(r => r.d.text === "日志已重置").length, 0, "没清除就不写“日志已重置”");
  w.db.ctl.fail = null; await drive(rec, h);
  assert.equal(rec.phase, "done"); assert.equal(count(w.db, bakName("run_log_archive")), 7);
  function expect(t: string) { return ({ run_log_archive: 7, run_log_stages: 3, run_log_archive_meta: 1, living_run_log: 4, strategy_runtime_log: 1 } as Record<string, number>)[t]!; }
});
test("D1 备份表整体不可用（建表就失败）→ 不清除", async () => {
  const w = world(), rec = newResetRecord(T), h = mkHost(w, new NtsLog(C));
  w.db.ctl.fail = t => t.includes(`CREATE TABLE IF NOT EXISTS ${BACKUP_DO_TABLE}`);
  for (let i = 0; i < 6; i++) await runResetStep(rec, h);
  assert.equal(rec.phase, "backup"); assert.equal(w.st.st.deleted, 0); assert.equal(count(w.db, "run_log_archive"), 7);
});
test("备份校验：抄写期间 DO 里新增的旧日志键，会被重新抄写（备份条数 < 现存条数就不放行）", async () => {
  const w = world(), rec = newResetRecord(T), h = mkHost(w, new NtsLog(C));
  let n = 0, injected = false; const orig = w.st.list.bind(w.st);
  w.st.list = (async (o: Parameters<typeof orig>[0]) => { n++; if (!injected && n === 12) { injected = true; w.st.m.set("log:review:v1:late-key", { late: 1 }); } return orig(o); }) as typeof w.st.list;
  await drive(rec, h);
  assert.ok(injected); assert.equal(rec.phase, "done");
  assert.ok((w.db.raw.prepare(`SELECT k FROM ${BACKUP_DO_TABLE} WHERE k=?`).get("log:review:v1:late-key")), "晚到的键也在备份里");
  assert.equal(w.st.m.has("log:review:v1:late-key"), false);
});
test("幂等 + 断点续跑：每一步之后“重启”（只靠存下来的记录）也得到同样结果；再跑一轮什么都不变；只写一条“日志已重置”", async () => {
  const w = world(), saves: ResetRecord[] = [], log0 = new NtsLog(C);
  let rec: ResetRecord = newResetRecord(T), log = log0, steps = 0, resets = 0;
  while (rec.phase !== "done" && steps++ < 200) {
    await runResetStep(rec, mkHost(w, log, {}, saves));
    // 日志：每次“重启”从存储里重新读（含已写入的“日志已重置”），记录要先落盘
    const out = log.take(); if (Object.keys(out).length) await w.st.put(out); resets += Object.values(out).flatMap(c => c.recs).filter(r => r.d.text === "日志已重置").length;
    rec = normalizeResetRecord(structuredClone(w.st.m.get("nts:reset:v1")))!; log = new NtsLog(C); await log.load(w.st);
  }
  assert.equal(rec.phase, "done");
  const snapshot = JSON.stringify([[...w.st.m.keys()].sort(), RESET_D1_TABLES.map(t => [count(w.db, t.table), count(w.db, bakName(t.table))]), count(w.db, BACKUP_DO_TABLE)]);
  const writes = w.st.st.rowsWritten;
  for (let i = 0; i < 5; i++) { await runResetStep(rec, mkHost(w, log, {}, saves)); rec = normalizeResetRecord(structuredClone(w.st.m.get("nts:reset:v1")))!; }
  assert.equal(JSON.stringify([[...w.st.m.keys()].sort(), RESET_D1_TABLES.map(t => [count(w.db, t.table), count(w.db, bakName(t.table))]), count(w.db, BACKUP_DO_TABLE)]), snapshot, "再跑不改变任何东西");
  assert.equal(w.st.st.rowsWritten, writes, "完成后不再写 DO");
  assert.equal(resets + logRecs(log).filter(r => r.d.text === "日志已重置").length, 1);
  const all = [...w.st.m.entries()].filter(([k]) => k.startsWith("nts:log:v1:")).flatMap(([, c]) => (c as { recs: { d: { text?: string } }[] }).recs).filter(r => r.d.text === "日志已重置");
  assert.equal(all.length, 1, "存储里只有一条“日志已重置”");
});
test("改名阶段中途失败（第三张表）→ 停在原地、已改名的不重复改、重试后完成；数据一行不丢", async () => {
  const w = world(), rec = newResetRecord(T), h = mkHost(w, new NtsLog(C));
  w.db.ctl.fail = t => t.includes(`RENAME TO "run_log_archive_meta__bak_nts1"`);
  for (let i = 0; i < 20; i++) await runResetStep(rec, h);
  assert.equal(rec.phase, "rename"); assert.equal(rec.d1.run_log_archive?.status, "renamed"); assert.equal(rec.d1.run_log_archive_meta, undefined);
  assert.equal(count(w.db, "run_log_archive_meta"), 1, "失败的那张表原样"); assert.equal(w.st.st.deleted, 0, "没改完名就不删 DO");
  w.db.ctl.fail = null; await drive(rec, h);
  assert.equal(rec.phase, "done");
  for (const { table } of RESET_D1_TABLES) assert.equal(count(w.db, bakName(table)) > 0, true);
});
test("宿主还没法清内存/有持仓时（clearHot=false）不删任何 DO 键；之后放行才删", async () => {
  const w = world(), rec = newResetRecord(T); let ok = false; const h = mkHost(w, new NtsLog(C), { clearHot: () => ok });
  for (let i = 0; i < 15; i++) await runResetStep(rec, h);
  assert.equal(rec.phase, "clear"); assert.equal(w.st.st.deleted, 0);
  ok = true; await drive(rec, h); assert.equal(rec.phase, "done"); assert.ok(w.st.st.deleted > 0);
});
test("删除前核对：备份之后值变了的键，先补进备份再删（备份里是最新值）", async () => {
  const w = world(), rec = newResetRecord(T), h = mkHost(w, new NtsLog(C));
  for (let i = 0; i < 30 && rec.phase !== "clear"; i++) await runResetStep(rec, h);
  w.st.m.set("log:review:v1:0003", { changed: true });
  await drive(rec, h);
  const row = w.db.raw.prepare(`SELECT v FROM ${BACKUP_DO_TABLE} WHERE k='log:review:v1:0003'`).get() as { v: string };
  assert.deepEqual(JSON.parse(row.v), { changed: true });
});
test("备份可下载：NDJSON 流，D1 各备份表和 DO 键行数都对得上（含元信息与结尾）", async () => {
  const w = world(), rec = newResetRecord(T); await drive(rec, mkHost(w, new NtsLog(C)));
  const lines = await readAll(backupExportStream(w.db, rec, 3)), rows = lines.filter(l => l.table);
  const by = (t: string) => rows.filter(r => r.table === t).length;
  assert.equal(by("run_log_archive"), 7); assert.equal(by("run_log_stages"), 3); assert.equal(by("living_run_log"), 4); assert.equal(by("strategy_runtime_log"), 1); assert.equal(by("do_keys"), rec.copied);
  assert.ok((lines[0]!.meta as { kind: string }).kind.includes("backup")); assert.equal(lines.at(-1)!.rows, rows.length);
  const empty = await readAll(backupExportStream(w.db, null)); assert.equal(empty.filter(l => l.table).length, 0);
});
test("账户内的研究行被清，订单历史和余额不动", () => {
  const f = initialForward(T); f.history.push({ id: "h1", netPnl: 1 } as never); f.unopenedTrades = [{ id: "u1" } as never]; f.signalTally = { a: 1 } as never; f.balance = 1000.5;
  assert.equal(clearLogOnlyForward(f, T), true);
  assert.equal(f.unopenedTrades.length, 0); assert.equal(f.history.length, 1); assert.equal(f.balance, 1000.5);
  assert.equal(clearLogOnlyForward(f, T), false, "第二次没有东西可清");
});
