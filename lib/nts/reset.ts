/**
 * 一次性清除"以前的运行日志"（用户已授权）。顺序固定：先完整备份 → 校验 → 才清除 → 写第一条"日志已重置"。
 *
 *   阶段 A  把要清的 Durable Object 日志键逐个抄进 D1 备份表 nts_backup_do（只读 DO，不删）。
 *   阶段 B  校验备份条数一致；然后把 5 张 D1 日志表整表改名为 <表>__bak_nts1（元数据操作，一个 batch 事务，不复制行，不耗行写入），
 *           同事务内重建空表。改名后旧数据原样留在 D1，可通过 /api/nts/log-backup 流式下载。
 *   阶段 C  宿主清内存里的旧日志状态；按批删除 DO 日志键（删除前再核对一次备份，值变了就先补备份）。
 *   完成    写 NTS 日志第一条 "日志已重置"。
 * 任何一步失败：停在该步、记录错误、下一轮重试；阶段 A 失败时绝不进入 B/C（不清除）。幂等：状态键 nts:reset:v1 记录进度，
 * 重启后从原处继续，改名/删除都先检查是否已做过，因此不会重复备份、不会重复清除、不会重复写"日志已重置"。
 * 不碰：订单历史（forward.history / paper_*）、权益曲线（run_log_equity_days / log:eqmin:）、实盘开关、纸面余额。
 */
import { ARCHIVE_SCHEMA, type D1Like } from "../run-log-archive.ts";
import { LIVING_LOG_SCHEMA } from "../living/runlog-d1.ts";
import type { ForwardState } from "../forward-relations.ts";
import type { NtsLog } from "./log.ts";

export const NTS_RESET_KEY = "nts:reset:v1";
export const NTS_RESET_VERSION = "nts-reset-v1";
export const BACKUP_TAG = "nts1";
export const BACKUP_DO_TABLE = "nts_backup_do";
/** DO 前缀：只含运行日志。 log:eqmin: （权益分钟线）故意不在其中。 */
export const RESET_DO_PREFIXES = ["log:review:v1:", "market-intelligence:trade-paths:"] as const;
export const RESET_DO_KEYS = ["log:export:last"] as const;

const STRATEGY_RUNTIME_LOG_DDL = [
  `CREATE TABLE IF NOT EXISTS strategy_runtime_log (id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, version TEXT NOT NULL, scanned_markets INTEGER NOT NULL,
  stable_markets INTEGER NOT NULL, realtime_markets INTEGER NOT NULL, regime_counts_json TEXT NOT NULL DEFAULT '{}', strategy_metrics_json TEXT NOT NULL DEFAULT '[]',
  shadow_open INTEGER NOT NULL, shadow_resolved INTEGER NOT NULL, active_strategies INTEGER NOT NULL, portfolio_open INTEGER NOT NULL, portfolio_equity REAL NOT NULL,
  portfolio_resolved INTEGER NOT NULL, portfolio_net_pnl REAL NOT NULL, strategy_candle_error TEXT, authority_state TEXT NOT NULL,
  live_requested INTEGER NOT NULL DEFAULT 0, live_operational INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS strategy_runtime_log_time_idx ON strategy_runtime_log(observed_at)`,
] as const;
const ddlFor = (list: readonly string[], table: string) => list.filter(s => s.includes(` ${table} `) || s.includes(` ${table}(`) || s.includes(`ON ${table}`) || s.includes(`ON ${table} `));
/** 要清的 D1 表（run_log_equity_days 不在其中：权益曲线不动）。 */
export const RESET_D1_TABLES: { table: string; ddl: readonly string[] }[] = [
  { table: "run_log_archive", ddl: ddlFor(ARCHIVE_SCHEMA, "run_log_archive") },
  { table: "run_log_stages", ddl: ddlFor(ARCHIVE_SCHEMA, "run_log_stages") },
  { table: "run_log_archive_meta", ddl: ddlFor(ARCHIVE_SCHEMA, "run_log_archive_meta") },
  { table: "living_run_log", ddl: LIVING_LOG_SCHEMA },
  { table: "strategy_runtime_log", ddl: STRATEGY_RUNTIME_LOG_DDL },
];
export const bakName = (table: string) => `${table}__bak_${BACKUP_TAG}`;

export type ResetPhase = "backup" | "rename" | "clear" | "done";
export type ResetRecord = {
  version: typeof NTS_RESET_VERSION; phase: ResetPhase; startedAt: number; doneAt: number | null; passes: number;
  cursor: string | null; scanned: number; copied: number; verified: boolean;
  d1: Record<string, { rows: number | null; bak: string | null; status: "pending" | "renamed" | "absent" }>;
  hotCleared: boolean; deleted: number; resetLogged: boolean; lastError: string | null; failures: number;
};
export const newResetRecord = (now: number): ResetRecord => ({ version: NTS_RESET_VERSION, phase: "backup", startedAt: now, doneAt: null, passes: 0, cursor: null, scanned: 0, copied: 0,
  verified: false, d1: {}, hotCleared: false, deleted: 0, resetLogged: false, lastError: null, failures: 0 });
export function normalizeResetRecord(v: unknown): ResetRecord | null {
  const x = v as ResetRecord | undefined;
  return x && x.version === NTS_RESET_VERSION && typeof x.startedAt === "number" ? { ...newResetRecord(x.startedAt), ...x } : null;
}

export interface ResetStorage {
  list<T>(opts: { prefix?: string; start?: string; startAfter?: string; limit?: number }): Promise<Map<string, T>>;
  get<T>(key: string): Promise<T | undefined>;
  delete(keys: string[]): Promise<number>;
}
export type ResetHost = {
  db: D1Like; storage: ResetStorage; log: NtsLog; now: number;
  /** 清内存里的旧日志状态（旅程记录、游标、账户里的研究行）。宿主在这里把改动落到纸面账户副本；返回是否改了账户。 */
  clearHot: () => Promise<boolean> | boolean;
  /** 清除全部完成后再调用一次：让游标重新对齐（旧键已删）。 */
  afterClear?: () => void;
  save: (rec: ResetRecord) => Promise<void>;
};
const BATCH = 40;
const enc = (v: unknown) => JSON.stringify(v);

async function ensureBackupTable(db: D1Like) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${BACKUP_DO_TABLE} (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL, bytes INTEGER NOT NULL, at INTEGER NOT NULL)`).run();
}
async function tableExists(db: D1Like, name: string) {
  const row = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).bind(name).first<{ name: string }>();
  return !!row;
}
async function countRows(db: D1Like, name: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).first<{ n: number }>();
  return Number(row?.n ?? 0);
}
/** All DO keys to be cleared, in key order, one page at a time. */
async function listPage(storage: ResetStorage, cursor: string | null, limit: number) {
  const out: [string, unknown][] = [];
  const prefixes = [...RESET_DO_PREFIXES, ...RESET_DO_KEYS];
  // keys are walked prefix by prefix; the cursor is "<prefixIndex>|<lastKey>"
  let [pi, last] = cursor ? [Number(cursor.split("|")[0]), cursor.slice(cursor.indexOf("|") + 1)] : [0, ""];
  while (pi < prefixes.length && out.length < limit) {
    const want = limit - out.length;
    const got = await storage.list<unknown>({ prefix: prefixes[pi]!, startAfter: last || undefined, limit: want });
    for (const [k, v] of got) { out.push([k, v]); last = k; }
    if (got.size < want) { pi++; last = ""; } // this prefix is exhausted
  }
  return { rows: out, next: pi >= prefixes.length ? null : `${pi}|${last}` };
}

export async function runResetStep(rec: ResetRecord, h: ResetHost): Promise<ResetRecord> {
  if (rec.phase === "done") return rec;
  rec.passes++;
  try {
    if (rec.phase === "backup") {
      await ensureBackupTable(h.db);
      const page = await listPage(h.storage, rec.cursor, BATCH);
      if (page.rows.length) {
        const stmts = page.rows.map(([k, v]) => { const text = enc(v); return h.db.prepare(`INSERT OR REPLACE INTO ${BACKUP_DO_TABLE} (k,v,bytes,at) VALUES (?,?,?,?)`).bind(k, text, text.length, h.now); });
        await h.db.batch(stmts);
        rec.scanned += page.rows.length;
      }
      rec.cursor = page.next;
      if (page.next == null) {
        // 校验：备份表条数必须等于 DO 里现存的待清键数；不一致就重来一遍（键在抄写期间可能新增），绝不往下走
        let live = 0, cursor: string | null = null;
        do { const p = await listPage(h.storage, cursor, 200); live += p.rows.length; cursor = p.next; } while (cursor);
        const row = await h.db.prepare(`SELECT COUNT(*) AS n FROM ${BACKUP_DO_TABLE}`).first<{ n: number }>();
        const inBackup = Number(row?.n ?? 0);
        if (inBackup < live) { rec.cursor = null; rec.lastError = `备份校验未通过：DO ${live} 键，备份 ${inBackup} 键，重新抄写`; return await h.save(rec), rec; }
        rec.copied = inBackup; rec.verified = true; rec.phase = "rename"; rec.lastError = null;
      }
    } else if (rec.phase === "rename") {
      if (!rec.verified) throw new Error("备份未校验，拒绝清除");
      for (const { table, ddl } of RESET_D1_TABLES) {
        if (rec.d1[table]?.status === "renamed" || rec.d1[table]?.status === "absent") continue;
        const bak = bakName(table);
        if (await tableExists(h.db, bak)) { rec.d1[table] = { rows: rec.d1[table]?.rows ?? null, bak, status: "renamed" }; continue; }
        if (!(await tableExists(h.db, table))) { rec.d1[table] = { rows: 0, bak: null, status: "absent" }; continue; }
        const rows = await countRows(h.db, table);
        const idx = await h.db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`).bind(table).all<{ name: string }>();
        const stmts = [...idx.results.map(i => h.db.prepare(`DROP INDEX IF EXISTS "${i.name}"`)), h.db.prepare(`ALTER TABLE "${table}" RENAME TO "${bak}"`), ...ddl.map(s => h.db.prepare(s))];
        await h.db.batch(stmts); // 一个事务：改名 + 重建空表，要么全成要么全不成
        const kept = await countRows(h.db, bak);
        if (kept !== rows) throw new Error(`${table} 改名后行数 ${kept} ≠ 改名前 ${rows}`);
        rec.d1[table] = { rows, bak, status: "renamed" };
        break; // 一轮一张表
      }
      if (RESET_D1_TABLES.every(t => ["renamed", "absent"].includes(rec.d1[t.table]?.status ?? ""))) rec.phase = "clear";
    } else if (rec.phase === "clear") {
      if (!rec.hotCleared) {
        if (!(await h.clearHot())) { await h.save(rec); return rec; } // 宿主还没清完内存/账户里的研究行（或有持仓）：本轮不删任何东西
        rec.hotCleared = true;
      }
      const page = await listPage(h.storage, null, BATCH);
      if (page.rows.length) {
        // 删除前再核对：值变了（或抄写后新增）就先补进备份，再删
        const ids = page.rows.map(([k]) => k);
        const have = await h.db.prepare(`SELECT k, v FROM ${BACKUP_DO_TABLE} WHERE k IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ k: string; v: string }>();
        const map = new Map(have.results.map(r => [r.k, r.v]));
        const fix = page.rows.filter(([k, v]) => map.get(k) !== enc(v)).map(([k, v]) => { const text = enc(v);
          return h.db.prepare(`INSERT OR REPLACE INTO ${BACKUP_DO_TABLE} (k,v,bytes,at) VALUES (?,?,?,?)`).bind(k, text, text.length, h.now); });
        if (fix.length) await h.db.batch(fix);
        await h.storage.delete(ids);
        rec.deleted += ids.length;
      } else {
        rec.phase = "done"; rec.doneAt = h.now; h.afterClear?.();
      }
    }
    rec.lastError = null; rec.failures = 0;
  } catch (error) {
    rec.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 200); rec.failures++;
  }
  if (rec.phase === "done" && !rec.resetLogged) {
    h.log.append({ id: "sys:reset:v1", k: "SYSTEM", t: h.now, d: { text: "日志已重置", version: NTS_RESET_VERSION, backupTables: Object.fromEntries(Object.entries(rec.d1).map(([k, v]) => [k, v.bak])),
      backupDoTable: BACKUP_DO_TABLE, backupRows: rec.d1, backupDoKeys: rec.copied, deletedDoKeys: rec.deleted, untouched: "订单历史、权益曲线、实盘开关、纸面余额" } }, h.now);
    rec.resetLogged = true;
  }
  await h.save(rec);
  return rec;
}

/** 账户里的研究类日志行（未开仓的研究单、阶段年表、信号计数）；订单历史 history 原样保留。 */
export function clearLogOnlyForward(state: ForwardState, at: number) {
  const unopened = state.unopenedTrades?.length ?? 0, changes = state.stageChronicle?.changes?.length ?? 0, tally = Object.keys(state.signalTally ?? {}).length;
  if (!unopened && !changes && !tally) return false;
  state.unopenedTrades = [];
  if (state.stageChronicle) state.stageChronicle = { ...state.stageChronicle, changes: [] };
  state.signalTally = {}; state.signalTallyMeta = { backfilled: true, from: at };
  return true;
}

/** 备份下载：NDJSON 流（元信息 → 每张备份表分页 → DO 备份键分页）。不拼大字符串。 */
export function backupExportStream(db: D1Like, rec: ResetRecord | null, page = 100): ReadableStream<Uint8Array> {
  const te = new TextEncoder();
  const sources: { name: string; sql: string; key: "rowid" }[] = [];
  if (rec) { for (const [t, v] of Object.entries(rec.d1)) if (v.bak) sources.push({ name: t, sql: v.bak, key: "rowid" }); sources.push({ name: "do_keys", sql: BACKUP_DO_TABLE, key: "rowid" }); }
  let si = -1, last = 0, sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      try {
        if (si === -1) { si = 0; ctl.enqueue(te.encode(enc({ meta: { kind: "nts-old-run-log-backup", version: NTS_RESET_VERSION, at: rec?.doneAt ?? null, tables: rec?.d1 ?? {}, doKeys: rec?.copied ?? 0 } }) + "\n")); return; }
        // 每次 pull 必须 enqueue 或 close，否则读端会一直等：空表直接跳到下一张
        for (;;) {
          if (si >= sources.length) { ctl.enqueue(te.encode(enc({ end: true, rows: sent }) + "\n")); ctl.close(); return; }
          const src = sources[si]!;
          const got = await db.prepare(`SELECT rowid AS _rid, * FROM "${src.sql}" WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(last, page).all<Record<string, unknown>>();
          if (!got.results.length) { si++; last = 0; continue; }
          let out = "";
          for (const row of got.results) { const { _rid, ...rest } = row; last = Number(_rid); out += enc({ table: src.name, row: rest }) + "\n"; sent++; }
          ctl.enqueue(te.encode(out)); return;
        }
      } catch (error) { ctl.error(error); }
    },
  });
}
