/**
 * 交易系统运行日志：追加式、分块、按 id 去重。
 *  - 一条记录 = 一行 JSON；若干条记录合成一个 chunk（≤ maxChunkBytes），一个 chunk 一个 DO 存储键。
 *  - 键名 nts:log:v1:<小时起点13位>:<序号3位>，字典序 = 时间序。
 *  - 写入走内存缓冲，按 flushEveryMs 批量落盘；关键记录（进场/补仓/出场）由引擎随成交事务一起写。
 *  - 导出走流（ReadableStream + storage.list 分页），永远不拼一个大字符串。
 * 日志失败不影响交易：所有调用方 try/catch；失败只记到 health。
 */
import type { NtsConfig } from "./config.ts";

export const NTS_LOG_PREFIX = "nts:log:v1:";
export type NtsRecKind = "ENTRY" | "NO_TRADE" | "ADD" | "ADD_SKIP" | "TRACE" | "EXIT" | "POST_EXIT" | "SYSTEM" | "DATA";
export type NtsRec = { id: string; k: NtsRecKind; t: number; sym?: string; tid?: string; d: Record<string, unknown> };
export type NtsChunk = { v: 1; recs: NtsRec[] };

export interface LogStorage {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(opts: { prefix?: string; start?: string; startAfter?: string; limit?: number; reverse?: boolean }): Promise<Map<string, T>>;
}

const HOUR = 3_600_000;
export const chunkKey = (t: number, seq: number) => `${NTS_LOG_PREFIX}${String(Math.floor(t / HOUR) * HOUR).padStart(13, "0")}:${String(seq).padStart(3, "0")}`;
const sizeOf = (rec: NtsRec) => JSON.stringify(rec).length + 1;

export class NtsLog {
  private tail: { key: string; chunk: NtsChunk; bytes: number; hour: number; seq: number } | null = null;
  private seen = new Set<string>();
  private dirty = new Set<string>();
  private held = new Map<string, NtsChunk>();
  appended = 0;
  dropped = 0;
  /** 写入长期被预算拒绝时，内存里最多留这么多个未落盘块（约 48×90KB≈4MB 上限），更早的丢弃并计数。 */
  static readonly MAX_HELD = 48;
  lostChunks = 0;
  private cfg: NtsConfig;
  constructor(cfg: NtsConfig) { this.cfg = cfg; }

  /** Load the newest chunks so ids are not written twice after a restart. */
  async load(storage: LogStorage) {
    const got = await storage.list<NtsChunk>({ prefix: NTS_LOG_PREFIX, reverse: true, limit: 3 });
    let first = true;
    for (const [key, chunk] of got) {
      for (const r of chunk.recs ?? []) this.seen.add(r.id);
      if (first) {
        const m = /:(\d{13}):(\d{3})$/.exec(key);
        this.tail = { key, chunk: { v: 1, recs: [...(chunk.recs ?? [])] }, bytes: (chunk.recs ?? []).reduce((a, r) => a + sizeOf(r), 0), hour: Number(m?.[1] ?? 0), seq: Number(m?.[2] ?? 0) };
        first = false;
      }
    }
  }
  has(id: string) { return this.seen.has(id); }
  /** Returns false if the id is already in the log (idempotent). */
  append(rec: NtsRec, now: number) {
    if (this.seen.has(rec.id)) { this.dropped++; return false; }
    const bytes = sizeOf(rec), hour = Math.floor(now / HOUR) * HOUR;
    const t = this.tail;
    if (!t || t.hour !== hour || t.bytes + bytes > this.cfg.log.maxChunkBytes) {
      const seq = t && t.hour === hour ? t.seq + 1 : 0;
      this.tail = { key: chunkKey(now, seq), chunk: { v: 1, recs: [] }, bytes: 0, hour, seq };
    }
    const tl = this.tail!;
    tl.chunk.recs.push(rec); tl.bytes += bytes; this.seen.add(rec.id); this.dirty.add(tl.key); this.held.set(tl.key, tl.chunk);
    this.appended++;
    while (this.dirty.size > NtsLog.MAX_HELD) { const oldest = this.dirty.values().next().value as string; if (oldest === tl.key) break; this.dirty.delete(oldest); this.held.delete(oldest); this.lostChunks++; }
    if (this.seen.size > 6000) { const keep = [...this.seen].slice(-3000); this.seen = new Set(keep); }
    return true;
  }
  get pending() { return this.dirty.size; }
  /** Entries to persist now. Call `restore` if the write failed. */
  take(): Record<string, NtsChunk> {
    const out: Record<string, NtsChunk> = {};
    for (const k of this.dirty) { const c = this.held.get(k); if (c) out[k] = structuredClone(c); }
    this.dirty.clear(); this.held.clear();
    return out;
  }
  /** 还没落盘的块（只读，不清缓冲）：下载导出时叠加在已落盘的块上，写入预算不足也不丢。 */
  peek(): Record<string, NtsChunk> {
    const out: Record<string, NtsChunk> = {};
    for (const k of this.dirty) { const c = this.held.get(k); if (c) out[k] = structuredClone(c); }
    return out;
  }
  restore(keys: string[]) {
    for (const k of keys) { this.dirty.add(k); if (this.tail?.key === k) this.held.set(k, this.tail.chunk); }
  }
}

/** NDJSON stream of every record. `flush` runs first so unwritten records are included. Never builds one big string. */
export function logExportStream(storage: LogStorage, flush: () => Promise<void>, header: Record<string, unknown>, page = 8, pending: () => Record<string, NtsChunk> = () => ({})): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let cursor: string | undefined, started = false, done = false, count = 0, pend: Map<string, NtsChunk> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      try {
        if (!started) { started = true; try { await flush(); } catch { /* export what is on disk */ } try { pend = new Map(Object.entries(pending())); } catch { pend = new Map(); } ctl.enqueue(enc.encode(JSON.stringify({ meta: header }) + "\n")); return; }
        if (done) { ctl.close(); return; }
        const got = await storage.list<NtsChunk>({ prefix: NTS_LOG_PREFIX, startAfter: cursor, limit: page });
        const waiting = [...(pend ?? new Map<string, NtsChunk>())].filter(([k]) => (cursor == null || k > cursor)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
        if (!got.size) {
          // 磁盘已读完：把还没落盘的块补在最后（写入预算不足时也不丢），然后结束
          done = true; let out = "";
          for (const [k, c] of waiting) { pend!.delete(k); for (const r of c.recs ?? []) { out += JSON.stringify(r) + "\n"; count++; } }
          ctl.enqueue(enc.encode(out + JSON.stringify({ end: true, records: count }) + "\n")); return;
        }
        let out = "";
        for (const [key, chunk] of got) {
          for (const [k, c] of waiting) if (k < key && pend!.has(k)) { pend!.delete(k); for (const r of c.recs ?? []) { out += JSON.stringify(r) + "\n"; count++; } }
          cursor = key; const use = pend?.get(key) ?? chunk; pend?.delete(key);
          for (const r of use.recs ?? []) { out += JSON.stringify(r) + "\n"; count++; }
        }
        ctl.enqueue(enc.encode(out));
      } catch (error) { ctl.error(error); }
    },
  });
}
