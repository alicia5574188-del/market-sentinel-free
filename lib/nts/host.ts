/**
 * 交易系统宿主：把引擎（engine.ts）、日志（log.ts）、一次性日志重置（reset.ts）接到 Durable Object 的存储与纸面账户周期上。
 * 不依赖 Cloudflare 类型（存储/D1/取数都通过 deps 注入），所以可以在 node 里完整测试。
 * 铁律：只写纸面账户；不引用任何实盘模块；日志/取数/重置任何一步失败都只降级（记到 health），绝不抛进交易周期。
 */
import type { Contract, ForwardState, Quote } from "../forward-relations.ts";
import type { D1Like } from "../run-log-archive.ts";
import { DEFAULT_NTS_CONFIG, NTS_VERSION, normalizeNtsConfig, type NtsConfig } from "./config.ts";
import { NTS_CONFIG_KEY, NTS_STATE_KEY, NtsEngine, type Action, type FetchJob, type NtsState } from "./engine.ts";
import { NtsLog, logExportStream, type LogStorage, type NtsChunk } from "./log.ts";
import { NTS_RESET_KEY, backupExportStream, clearLogOnlyForward, newResetRecord, normalizeResetRecord, runResetStep, type ResetRecord } from "./reset.ts";
import type { Bar, Tf } from "./types.ts";

export interface HostStorage extends LogStorage {
  put(entries: Record<string, unknown>): Promise<void>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<number>;
}
export type HostDeps = {
  storage: HostStorage & { list<T>(opts: { prefix?: string; start?: string; startAfter?: string; limit?: number; reverse?: boolean }): Promise<Map<string, T>> };
  db: () => D1Like | null;
  candles: (sym: string, tf: Tf, limit: number) => Promise<Bar[]>;
  ticker: (sym: string) => Promise<{ funding: number | null; oi: number | null; mark: number | null; index: number | null } | null>;
  /** 与全局 Gate REST 令牌桶共用（0.4/s 上限）。false = 这一轮不发。 */
  spend: (now: number) => boolean;
  /** DO 的非告警写入预算。null = 本轮预算不足，跳过非关键写入。 */
  reserve: (rows: number, tag: string) => { finish: (ok: boolean) => void } | null;
  /** 清掉 DO 内存里的旧日志状态（旅程记录/游标）。 */
  resetMemory: () => void;
  now?: () => number;
};

const HOUR = 3_600_000;
const safe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export class NtsHost {
  cfg: NtsConfig = DEFAULT_NTS_CONFIG;
  engine!: NtsEngine;
  log!: NtsLog;
  reset: ResetRecord | null = null;
  ready = false;
  bootError: string | null = null;
  logError: string | null = null;
  lastFlushAt = 0;
  lastStateWriteAt = 0;
  private bootAt = 0;
  private bootRetryAt = 0;
  private fetching: Promise<void> | null = null;
  private resetBusy = false;
  private resetNextAt = 0;
  private stateDirty = false;
  private snapshot: NtsState | null = null;
  private takenKeys: string[] = [];
  private hotClearRequested = false;
  private hotClearApplied = false;
  hotClearDone = false;
  private resetMemoryDone = false;

  private deps: HostDeps;
  constructor(deps: HostDeps) { this.deps = deps; }
  private now() { return this.deps.now ? this.deps.now() : Date.now(); }

  async boot(now = this.now()) {
    if (this.ready || now < this.bootRetryAt) return this.ready;
    try {
      const [cfg, st, rst] = await Promise.all([this.deps.storage.get<Partial<NtsConfig>>(NTS_CONFIG_KEY), this.deps.storage.get<NtsState>(NTS_STATE_KEY), this.deps.storage.get<ResetRecord>(NTS_RESET_KEY)]);
      this.cfg = normalizeNtsConfig(cfg ?? undefined);
      this.log = new NtsLog(this.cfg);
      await this.log.load(this.deps.storage);
      this.engine = new NtsEngine(this.cfg, this.log, st ?? null, now);
      this.reset = normalizeResetRecord(rst);
      this.hotClearDone = this.reset?.hotCleared === true;
      this.ready = true; this.bootAt = now; this.bootError = null; this.lastStateWriteAt = now;
      // 第一次启动：写入一条系统记录（id 固定，重启不会重复）
      this.log.append({ id: "sys:boot:" + this.engine.s.startedAt, k: "SYSTEM", t: now, d: { text: "交易系统已启动（纸面账户）", version: NTS_VERSION, enabled: this.cfg.enabled, liveTouched: false } }, now);
    } catch (e) { this.bootError = "NTS_BOOT:" + safe(e); this.bootRetryAt = now + 30_000; }
    return this.ready;
  }

  get enabled() { return this.ready && this.cfg.enabled; }
  /** 需要常驻行情的合约。 */
  symbols(): string[] { return this.enabled ? [...this.cfg.symbols] : []; }
  /** 日志重置没完成之前不开新仓（避免新单的路径数据被清除动作误删）。 */
  get resetDone() { return this.reset?.phase === "done"; }
  get entriesAllowed() { return this.enabled && this.resetDone; }

  async setEnabled(on: boolean) {
    if (!this.ready) throw new Error("交易系统尚未就绪");
    this.cfg = { ...this.cfg, enabled: on }; this.engine.setConfig(this.cfg);
    await this.deps.storage.put(NTS_CONFIG_KEY, { ...this.cfg });
    this.log.append({ id: `sys:switch:${this.now()}`, k: "SYSTEM", t: this.now(), d: { text: on ? "新交易系统自动开仓：已打开" : "新交易系统自动开仓：已关闭（持仓照常管理）", enabled: on } }, this.now());
    return this.cfg.enabled;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // 纸面账户周期钩子
  // ------------------------------------------------------------------------------------------------------------------
  /** 在 advanceForward 之前：判断 → 在账户副本上下单。返回要送进引擎的账户副本（无改动返回 null）。永不抛出。 */
  before(now: number, previous: ForwardState, quotes: Record<string, Quote>, contracts: Record<string, Contract>): ForwardState | null {
    if (!this.ready) return null;
    let draft: ForwardState | null = null;
    try {
      const actions: Action[] = this.engine.tick({ now, forward: previous, quotes, contracts, enabled: this.entriesAllowed });
      if (this.hotClearRequested && !this.hotClearDone && previous.positions.length === 0 && this.engine.s.open == null) {
        draft = structuredClone(previous);
        clearLogOnlyForward(draft, now);
        this.deps.resetMemory();
        this.hotClearApplied = true;
      }
      if (actions.length) {
        this.snapshot = structuredClone(this.engine.s);
        draft ??= structuredClone(previous);
        if (this.engine.execute(draft, actions, { now, quotes, contracts })) this.stateDirty = true; else if (!this.hotClearApplied) draft = null;
      }
    } catch (e) { this.engine.lastDecisionError = safe(e); draft = null; }
    return draft;
  }
  /** advanceForward 之后：发现被账户引擎止损/强平的 NTS 单，补记出场。返回是否有变化（需要落盘）。 */
  after(now: number, next: ForwardState, quotes: Record<string, Quote>): boolean {
    if (!this.ready) return false;
    try { const c = this.engine.reconcile(next, quotes, now); if (c) this.stateDirty = true; return c; } catch (e) { this.engine.lastDecisionError = safe(e); return false; }
  }
  /** 本轮是否必须落盘（有动作/出场/日志重置的账户清理）。 */
  get mustPersist() { return this.stateDirty || this.hotClearApplied; }

  /** 随纸面账户同一个事务写入的条目：引擎状态（有变化或每小时一次）+ 待写日志块。 */
  entries(now: number): { entries: Record<string, unknown>; rows: number } {
    this.takenKeys = [];
    if (!this.ready) return { entries: {}, rows: 0 };
    const entries: Record<string, unknown> = {};
    if (this.stateDirty || now - this.lastStateWriteAt >= HOUR) entries[NTS_STATE_KEY] = structuredClone(this.engine.serialize());
    try {
      const chunks = this.log.take();
      for (const [k, v] of Object.entries(chunks)) { entries[k] = v; this.takenKeys.push(k); }
    } catch (e) { this.logError = "NTS_LOG_TAKE:" + safe(e); }
    return { entries, rows: Object.keys(entries).length };
  }
  committed(now: number) {
    this.stateDirty = false; this.lastStateWriteAt = now;
    this.takenKeys = []; this.lastFlushAt = now; this.logError = null;
    if (this.hotClearApplied) { this.hotClearDone = true; this.hotClearApplied = false; this.hotClearRequested = false; }
    this.snapshot = null;
  }
  /** 事务失败：日志块放回缓冲；引擎状态回到本轮之前（账户也没改，二者一致）。 */
  failed(error: unknown) {
    if (!this.snapshot && !this.takenKeys.length && !this.stateDirty && !this.hotClearApplied) return; // nothing of ours was in flight
    try { this.log.restore(this.takenKeys); } catch { /* ignore */ }
    this.takenKeys = [];
    if (this.snapshot) { this.engine.s = this.snapshot; this.snapshot = null; }
    this.stateDirty = false; this.hotClearApplied = false;
    this.logError = "NTS_COMMIT:" + safe(error);
  }

  // ------------------------------------------------------------------------------------------------------------------
  // 后台：取数、日志批量落盘、一次性重置。返回要交给 waitUntil 的 promise（没有就 null）。
  // ------------------------------------------------------------------------------------------------------------------
  background(now: number): Promise<void> | null {
    if (!this.ready) { if (now >= this.bootRetryAt) return this.boot(now).then(() => undefined); return null; }
    const tasks: Promise<void>[] = [];
    if (this.enabled && !this.fetching) {
      const job = this.engine.nextJob(now, true);
      if (job) {
        if (this.deps.spend(now)) { this.fetching = this.runJob(job, now).finally(() => { this.fetching = null; }); tasks.push(this.fetching); } else this.engine.refundJob();
      }
    }
    if (this.log.pending > 0 && now - this.lastFlushAt >= this.cfg.log.flushEveryMs) tasks.push(this.flushLog(now));
    if (!this.resetDone && !this.resetBusy && now >= this.resetNextAt && now - this.bootAt >= 20_000) tasks.push(this.stepReset(now));
    return tasks.length ? Promise.all(tasks).then(() => undefined) : null;
  }
  private async runJob(job: FetchJob, now: number) {
    try {
      if (job.kind === "ticker") {
        const t = await this.deps.ticker(job.sym);
        if (!t) throw new Error("ticker empty");
        this.engine.ingestTicker(job.sym, t, this.now());
      } else {
        const rows = await this.deps.candles(job.sym, job.kind, this.cfg.data.candleLimit[job.kind]);
        this.engine.ingestCandles(job.sym, job.kind, rows, this.now());
      }
    } catch (e) { this.engine.fetchFailed(job, safe(e), now); }
  }
  async flushLog(now: number) {
    const reservation = this.deps.reserve(Math.max(1, this.log.pending), "nts-log");
    if (!reservation) return;
    const chunks = this.log.take(), keys = Object.keys(chunks);
    if (!keys.length) { reservation.finish(false); return; }
    try { await this.deps.storage.put(chunks); reservation.finish(true); this.lastFlushAt = now; this.logError = null; }
    catch (e) { reservation.finish(false); this.log.restore(keys); this.logError = "NTS_LOG_WRITE:" + safe(e); }
  }
  private async stepReset(now: number) {
    this.resetBusy = true;
    try {
      const db = this.deps.db();
      if (!this.reset) this.reset = newResetRecord(now);
      if (!db) { this.reset.lastError = "D1 binding missing：不清除"; this.resetNextAt = now + 60_000; return; }
      const reservation = this.deps.reserve(50, "nts-reset");
      if (!reservation) { this.resetNextAt = now + 30_000; return; }
      let ok = false;
      try {
        const rec = await runResetStep(this.reset, {
          db, storage: this.deps.storage as never, log: this.log, now,
          clearHot: () => { this.hotClearRequested = true; return this.hotClearDone; },
          afterClear: () => this.deps.resetMemory(),
          save: async r => { await this.deps.storage.put(NTS_RESET_KEY, r); },
        });
        this.reset = rec; ok = true;
        if (rec.phase === "done") { this.resetMemoryDone = true; await this.flushLog(now); }
      } finally { reservation.finish(ok); }
      const fails = this.reset.failures;
      this.resetNextAt = now + (this.reset.lastError ? Math.min(60_000, 5_000 * 2 ** Math.min(4, fails)) : 3_000);
    } catch (e) { if (this.reset) this.reset.lastError = safe(e); this.resetNextAt = now + 30_000; }
    finally { this.resetBusy = false; }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // 读：面板、健康、导出
  // ------------------------------------------------------------------------------------------------------------------
  view(now: number, forward: ForwardState | null, quotes: Record<string, Quote>) {
    if (!this.ready) return { version: "nts-v1", ready: false, enabled: false, state: "启动中", error: this.bootError, paperOnly: true, liveTouched: false };
    const s = this.engine.status(now, forward, quotes, { enabled: this.cfg.enabled, logError: this.logError, lastFlushAt: this.lastFlushAt });
    return { ...s, ready: true, resetState: this.resetView(), notes: this.notes(now, forward, quotes) };
  }
  resetView() {
    const r = this.reset;
    return r ? { phase: r.phase, doneAt: r.doneAt, passes: r.passes, copied: r.copied, deleted: r.deleted, d1: r.d1, error: r.lastError, failures: r.failures } : { phase: "backup", doneAt: null, passes: 0, error: null };
  }
  /** 健康页提示（降级但不致命的事）。 */
  notes(now: number, forward: ForwardState | null, quotes: Record<string, Quote>): string[] {
    const out: string[] = [];
    if (this.bootError) out.push(this.bootError);
    if (this.logError) out.push(`交易系统日志写入失败（交易不受影响，会自动重试）：${this.logError}`);
    if (this.log && this.log.lostChunks > 0) out.push(`日志写入预算长期不足，已丢弃 ${this.log.lostChunks} 个最旧的未落盘日志块（交易不受影响）`);
    if (this.reset && this.reset.phase !== "done") out.push(this.reset.lastError ? `旧日志清除未完成，暂不开新仓：${this.reset.lastError}` : "旧日志备份/清除进行中，暂不开新仓");
    if (!this.reset) out.push("旧日志备份/清除尚未开始，暂不开新仓");
    if (this.engine?.lastDecisionError) out.push(`决策异常：${this.engine.lastDecisionError}`);
    if (this.cfg.enabled) {
      for (const sym of this.cfg.symbols) {
        const h = this.engine.dataHealth(sym, now);
        if (!h.ok) out.push(`${sym} 数据：${h.notes.join("、")}`);
        if (!quotes[sym]?.fresh) out.push(`${sym} 行情不新鲜`);
      }
    }
    void forward;
    return out;
  }
  healthView(now: number, forward: ForwardState | null, quotes: Record<string, Quote>) {
    const notes = this.ready ? this.notes(now, forward, quotes) : [this.bootError ?? "启动中"];
    return { enabled: this.enabled, ready: this.ready, degraded: notes.length > 0, notes: notes.slice(0, 6), logPending: this.log?.pending ?? 0, logAppended: this.log?.appended ?? 0, logLost: this.log?.lostChunks ?? 0,
      restPerHour: this.engine?.restWindow.length ?? 0, reset: this.resetView(), liveTouched: false };
  }
  logStream(): ReadableStream<Uint8Array> {
    return logExportStream(this.deps.storage, () => this.flushLog(this.now()), { kind: "nts-run-log", version: "nts-v1", at: this.now(), enabled: this.cfg.enabled,
      note: "每行一条 JSON；ENTRY=进场决策全文，TRACE=进场后走势，EXIT/POST_EXIT=出场与出场后走势，NO_TRADE=抽样的不做原因" }, 8, () => this.log.peek());
  }
  backupStream(): ReadableStream<Uint8Array> | null {
    const db = this.deps.db();
    return db ? backupExportStream(db, this.reset) : null;
  }
}
export type { NtsChunk };
