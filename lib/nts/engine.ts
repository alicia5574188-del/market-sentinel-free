/**
 * 新交易系统引擎（纸面账户）。纯逻辑 + 内存状态，不直接碰 Cloudflare、Gate、D1。
 * 宿主（Durable Object）负责：取数（fetchJob）、把引擎给出的动作应用到纸面账户（execute）、持久化 `serialize()` 和日志块。
 *
 * 决策（默认 strategy="FVG"，2026-11-01 起）= 视频的「FVG 扫流动性系统」（fvg.ts 纯规则 + fvg-desk.ts 多币池/调度/开平仓）：
 *   4H FVG 区内，15m 扫掉前一个 2 根分形低/高点（实体收回），随后 2–3 根朝交易方向收盘并留下同向 15m FVG（无实体/ATR 门槛，ATR 只记录） →
 *   在 15m FVG 上沿（空单下沿）挂限价，16 根内有效，先破扫点撤单；止损 = 扫点外 1 tick；止盈 = 实际成交价起 2R，价格到 +1R 止损移到保本（入场价 +1 tick）；上线前开的单仍按 3R；每笔另记老 3R 规则的影子结果。
 *   严格按视频：不限订单数（同一个币可多笔，同一形态只开一次）、不限止损宽度、没有当日停开；模拟盘可用保证金不够时记“跳过”，不缩仓。
 * 旧 SMC 订单块（smc.ts）只用来把切换前已开的那一笔按原规则（smcExit）管到平仓，不再开新单。
 *
 * 每个 2 秒 tick：
 *   tick()   → 只读判断，返回要做的动作（开仓/补仓/平仓）。没有新 15m K 线、没有持仓时几乎零开销。
 *   execute()→ 在账户副本上套用动作，记录进场/补仓/出场日志。
 *   reconcile() → 发现被止损/强平的 NTS 单（由账户引擎平掉），补记出场日志与统计。
 * 实盘：本文件不引用任何实盘模块，下的单只进纸面账户（liveEligible=false）。
 */
import { addToPaperTrade, closePaperTrade, openPaperTrade, type Contract, type ForwardState, type Quote, type Trade } from "../forward-relations.ts";
import { DEFAULT_NTS_CONFIG, NTS_VERSION, normalizeNtsConfig, type NtsConfig } from "./config.ts";
import { breakerState, buildPacks, computeBias, type BiasResult, type BreakerState, type Geometry, type Packs, type Snap, type Bars } from "./decision.ts";
import { evaluateSmcEntry, marketStructure, smcAddCheck, smcExit, smcView, type SmcDecision, type SmcPlan, type SmcView, type Structure } from "./smc.ts";
import { dailyExit, evaluateDailyEntry, isDailyDecisionBar, type DailyPlan } from "./daily.ts";
import type { NtsLog, NtsRec } from "./log.ts";
import { dirOf, TF_SEC, type Bar, type Side, type Tf } from "./types.ts";
import { r } from "./indicators.ts";
import { exitRuleOf, isBeRule, FvgDesk, normalizeFvgState, priceR, stepShadow, stop0Of, type ExitRule, type FvgAction, type FvgOpen, type FvgState, type Shadow3R } from "./fvg-desk.ts";

const HOUR = 3_600_000, MIN = 60_000, ALL_TF: Tf[] = ["15m", "1h", "4h", "1d"];
export type NtsSymbol = "BTC_USDT" | "ETH_USDT";
export const NTS_STATE_KEY = "nts:state:v1";
export const NTS_CONFIG_KEY = "nts:config:v1";
export const ntsTradeId = (sym: string, barTime: number) => `nts-${sym}-${barTime}`;
export const isNtsTrade = (t: { id: string }) => t.id.startsWith("nts-");

type DerivSample = { t: number; oi: number | null; funding: number | null; mark: number | null; index: number | null };
type Brief = { at: number; sym: string; kind: string; text: string };
export type NtsOpen = {
  tid: string; sym: string; side: Side; openedAt: number; entry1: number; addedAt: number | null; addPrice: number | null; avg: number; geo: Geometry;
  target: number; stop: number; scale: number; zoneScore: number; zoneKey: string; equityAtOpen: number; oneR: number;
  /** SMC：订单块、顺势/逆势、计划补仓价（null = 本笔不补/已取消）、4H 结构缓存 */
  zone: { lo: number; hi: number; tf: string; kind: string }; mode: "TREND" | "COUNTER"; plannedAdd: number | null; h4: Structure["trend"]; h4Bar: number;
  mfePct: number; maePct: number; mfeR: number; maeR: number; lastTraceAt: number; lastBarEval: number; stage: string; margin1: number;
  /** 每日短线（strategy="DAILY"）的持仓：最有利价、追踪距离、到期时间、当前追踪止损 */
  daily?: { best: number; trailDist: number; exitAt: number; trail: number | null; ret24: number };
};
type PostExit = { tid: string; sym: string; side: Side; exitAt: number; exitPx: number; done: number[]; best: number; worst: number;
  /** 出场后 120 分钟内最有利/最不利（实时报价 + 出场后开始的 15m 高低点）；barT = 已处理到的 15m 起点（ms）。 */
  best120?: number; worst120?: number; barT?: number;
  /** FVG：影子 3R 还没结论时继续按出场后的路径判断（最多 48 小时）；actual = 实际结果，用于对比。 */
  exitRule?: ExitRule; fill?: number; stop0?: number; qty?: number; entryFee?: number; oneR?: number; shadow?: Shadow3R | null;
  actual?: { code: string; rPrice: number | null; rFee: number | null } };
type Period = { key: string; startEquity: number; pnl: number; trades: number; wins: number; r: number };
type LastEval = { at: number; barTime: number; action: string; side: Side | null; reason: string; core: number | null; score: number | null; plan: SmcPlan | null;
  structure?: { h4: string; highs: string; lows: string; d1: string };
  zones: { lo: number; hi: number; score: number; kind: string; tfs: Tf[] }[]; vetoes: number };
export type ExitSummary = { tid: string; sym: string; side: Side; at: number; reason: string; code: string; netPnl: number; r: number; holdMin: number; mfePct: number; maePct: number;
  /** FVG：r/mfeR/maeR = 扣手续费的 R（净盈亏 ÷ 1R 风险金额）；*_price = 只看价格的 R（价格移动 ÷ |成交价 − 原止损|）。 */
  rPrice?: number | null; mfeR?: number; maeR?: number; mfeR_price?: number | null; maeR_price?: number | null; exitRule?: ExitRule };
export type NtsState = {
  v: 1; version: string; open: NtsOpen | null; day: Period; month: Period; recent: Brief[]; lastExit: ExitSummary | null; post: PostExit[];
  decided: Record<string, number>; noTradeSlot: Record<string, number>; handled: string[];
  deriv: Record<string, DerivSample[]>; lastEval: Record<string, LastEval>; startedAt: number;
  /** FVG 系统：持仓（可多笔）、已成交形态、已用过的 4H 缺口、当前币池。 */
  fvg?: FvgState;
};
export type FetchJob = { sym: string; kind: Tf | "ticker" };
export type Action =
  | { type: "OPEN"; sym: string; decision: Extract<SmcDecision, { action: "ENTER" }>; barTime: number; snapshot: Record<string, unknown> }
  | { type: "ADD"; check: { ok: boolean; reason: string; price: number }; barTime: number }
  | { type: "CLOSE"; code: string; reason: string; stage: string }
  | { type: "OPEN_DAILY"; sym: string; plan: DailyPlan; barTime: number; snapshot: Record<string, unknown> }
  | { type: "FVG"; a: FvgAction };
type SymData = { bars: Partial<Record<Tf, Bar[]>>; fetchedAt: Partial<Record<Tf, number>>; failedAt: Partial<Record<Tf, number>>; fails: number; tickerAt: number; tickerFailedAt: number };

const emptyPeriod = (key: string, eq: number): Period => ({ key, startEquity: eq, pnl: 0, trades: 0, wins: 0, r: 0 });
export const freshNtsState = (now: number): NtsState => ({ v: 1, version: NTS_VERSION, open: null, day: emptyPeriod("", 0), month: emptyPeriod("", 0), recent: [], lastExit: null, post: [],
  decided: {}, noTradeSlot: {}, handled: [], deriv: {}, lastEval: {}, startedAt: now, fvg: normalizeFvgState(null) });

/** 重启后等数据补齐的最长时间（从 15m 收盘算起）；超过就按数据不足决策并记录。 */
export const WARMUP_WAIT_MS = 8 * 60_000;

export class NtsEngine {
  cfg: NtsConfig;
  s: NtsState;
  data: Record<string, SymData> = {};
  private tokens: number; private tokenAt: number;
  restRequests = 0; restFails = 0; lastFetchError: string | null = null; lastFetchAt = 0;
  restWindow: number[] = [];
  lastDecisionError: string | null = null;
  /** FVG 持仓的 MFE/MAE（价格极值）或出场后跟踪有变化但还没落盘：宿主在下一次已有的写入里顺带写状态（不单独触发写入）。 */
  extremesDirty = false;
  log: NtsLog;
  desk: FvgDesk;
  constructor(cfg: Partial<NtsConfig> | NtsConfig | null | undefined, log: NtsLog, saved?: NtsState | null, now = Date.now()) {
    this.log = log;
    this.cfg = normalizeNtsConfig(cfg as never);
    this.s = saved && saved.v === 1 ? { ...freshNtsState(now), ...saved } : freshNtsState(now);
    this.tokens = 1; this.tokenAt = now;
    for (const sym of this.cfg.symbols) this.data[sym] = { bars: {}, fetchedAt: {}, failedAt: {}, fails: 0, tickerAt: 0, tickerFailedAt: 0 };
    this.s.fvg = normalizeFvgState(this.s.fvg);
    const getCfg = () => this.cfg;
    this.desk = new FvgDesk({ get cfg() { return getCfg(); }, data: this.data as never, state: () => (this.s.fvg ??= normalizeFvgState(null)),
      append: (rec, t) => this.safeAppend(rec, t), brief: (t, sym, kind, text) => this.brief(t, sym, kind, text), version: NTS_VERSION });
  }
  setConfig(cfg: Partial<NtsConfig> | NtsConfig) { this.cfg = normalizeNtsConfig(cfg as never); }
  serialize(): NtsState { return this.s; }
  get isFvg() { return this.cfg.strategy === "FVG"; }
  /** 决策盯的币：FVG = 动态币池（+持仓币）；旧系统 = BTC/ETH。 */
  get symbols() { return this.isFvg ? this.desk.allSymbols() as readonly string[] : this.cfg.symbols as readonly string[]; }
  private get fvgOpens(): FvgOpen[] { return (this.s.fvg ??= normalizeFvgState(null)).opens; }
  /** 需要常驻实时行情的币（≤ fvg.maxResident + 旧持仓）。旧系统 = BTC/ETH。 */
  residentSymbols(): string[] {
    if (!this.isFvg) return [...this.cfg.symbols];
    return [...new Set([...(this.s.open ? [this.s.open.sym] : []), ...this.desk.residentSymbols()])];
  }
  /** 宿主传入按 24h 成交额排序的合约（已有目录）。 */
  setUniverse(ranked: readonly string[], now: number, ticks?: Record<string, number>) { try { if (this.isFvg) this.desk.setTicks(ticks); return this.isFvg ? this.desk.setUniverse(ranked, now) : false; } catch (e) { this.lastDecisionError = String(e).slice(0, 160); return false; } }
  /** NTS 是否还有任何持仓（旧单或 FVG 单）。 */
  get hasOpen() { return this.s.open != null || this.fvgOpens.length > 0; }

  // ---------------------------------------------------------------------------------------------------------------
  // 取数：自己的令牌桶（≤ restPerSec），一次最多给宿主一个任务。
  // ---------------------------------------------------------------------------------------------------------------
  private refill(now: number) {
    this.tokens = Math.min(2, this.tokens + Math.max(0, now - this.tokenAt) / 1000 * this.cfg.data.restPerSec); this.tokenAt = now;
  }
  private backoff(d: SymData) { return Math.min(10 * MIN, 30_000 * 2 ** Math.min(5, d.fails)); }
  /** Which request is due next, or null. Taking the job spends a token. */
  nextJob(now: number, wantData: boolean): FetchJob | null {
    if (!wantData) return null;
    this.refill(now); if (this.tokens < 1) return null;
    if (this.isFvg) {
      const job = this.desk.pickJob(now, d => this.backoff(d as SymData));
      if (!job) return null;
      this.tokens -= 1; this.restRequests++; this.restWindow.push(now); this.restWindow = this.restWindow.filter(t => now - t < HOUR);
      return job;
    }
    let best: { job: FetchJob; pri: number } | null = null;
    for (const sym of this.symbols) {
      const d = this.data[sym]!;
      for (const tf of ["1d", "4h", "1h", "15m"] as Tf[]) {
        const bars = d.bars[tf], last = bars?.[bars.length - 1];
        const nextClose = last ? (last.time + 2 * TF_SEC[tf]) * 1000 + 4_000 : 0;
        const due = !last || now >= nextClose;
        const retryOk = now - (d.failedAt[tf] ?? 0) >= this.backoff(d) && now - (d.fetchedAt[tf] ?? 0) >= 20_000;
        // 冷启动先补大周期和衍生品，15m 最后（15m 一到就会触发决策）
        if (due && retryOk) { const pri = !last ? (tf === "15m" ? 0.6 : 0.5) : (tf === "15m" ? 1 : 1.5); if (!best || pri < best.pri) best = { job: { sym, kind: tf }, pri }; }
      }
      if (now - d.tickerAt >= this.cfg.data.derivEveryMs && now - d.tickerFailedAt >= this.backoff(d)) {
        const pri = d.tickerAt ? 2 : 0.2; if (!best || pri < best.pri) best = { job: { sym, kind: "ticker" }, pri };
      }
    }
    if (!best) return null;
    this.tokens -= 1; this.restRequests++; this.restWindow.push(now); this.restWindow = this.restWindow.filter(t => now - t < HOUR);
    return best.job;
  }
  /** 全局令牌桶没批准这次请求：把引擎自己的令牌和计数还回去（没有真正发出请求）。 */
  private vetoSlot: Record<string, { slot: number; n: number }> = {};
  refundJob() { this.tokens = Math.min(2, this.tokens + 1); this.restRequests = Math.max(0, this.restRequests - 1); this.restWindow.pop(); }
  ingestCandles(sym: string, tf: Tf, rows: { time: number; open: number; high: number; low: number; close: number; volume: number }[], now: number) {
    const d = this.data[sym]; if (!d) return;
    d.bars[tf] = rows.slice(-this.cfg.data.candleLimit[tf]); d.fetchedAt[tf] = now; d.fails = 0; this.lastFetchAt = now; this.lastFetchError = null;
  }
  ingestTicker(sym: string, t: { funding: number | null; oi: number | null; mark: number | null; index: number | null }, now: number) {
    const d = this.data[sym]; if (!d) return;
    d.tickerAt = now; d.fails = 0; this.lastFetchAt = now; this.lastFetchError = null;
    const arr = this.s.deriv[sym] ??= [];
    arr.push({ t: now, ...t }); if (arr.length > 12) arr.splice(0, arr.length - 12);
  }
  fetchFailed(job: FetchJob, error: string, now: number) {
    const d = this.data[job.sym]; if (!d) return;
    d.fails++; this.restFails++; this.lastFetchError = error.slice(0, 160);
    if (job.kind === "ticker") d.tickerFailedAt = now; else d.failedAt[job.kind] = now;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 数据体检
  // ---------------------------------------------------------------------------------------------------------------
  dataHealth(sym: string, now: number) {
    if (this.isFvg) return this.desk.dataHealth(sym, now);
    const d = this.data[sym], notes: string[] = [];
    if (!d) return { ok: false, notes: ["未订阅"], bars: {} as Record<string, { n: number; ageMin: number | null }> };
    const bars: Record<string, { n: number; ageMin: number | null }> = {};
    for (const tf of ALL_TF) {
      const b = d.bars[tf], last = b?.[b.length - 1], n = b?.length ?? 0;
      const age = last ? (now / 1000 - (last.time + TF_SEC[tf])) / 60 : null;
      bars[tf] = { n, ageMin: age == null ? null : Math.round(age) };
      if (n < this.cfg.data.minCandles[tf]) notes.push(`${tf} K线 ${n}/${this.cfg.data.minCandles[tf]}`);
      else if (age != null && age > (this.cfg.data.staleBarFactor * TF_SEC[tf]) / 60) notes.push(`${tf} K线过期 ${Math.round(age)}分钟`);
    }
    const dv = this.s.deriv[sym], lastD = dv?.[dv.length - 1];
    if (!lastD) notes.push("衍生品快照未到"); else if (now - lastD.t > this.cfg.data.derivEveryMs * 3) notes.push("衍生品快照过期");
    return { ok: notes.length === 0, notes, bars };
  }
  private derivView(sym: string, now: number) {
    const arr = this.s.deriv[sym] ?? [], last = arr[arr.length - 1];
    const at = (ms: number, tol: number) => { const target = now - ms; let best: DerivSample | null = null;
      for (const x of arr) if (Math.abs(x.t - target) <= tol && (!best || Math.abs(x.t - target) < Math.abs(best.t - target))) best = x; return best; };
    const chg = (ms: number) => { const p = at(ms, 25 * MIN); return last?.oi != null && p?.oi != null && p.oi > 0 ? last.oi / p.oi - 1 : null; };
    const fp = at(8 * HOUR, 90 * MIN);
    return { funding: last?.funding ?? null, fundingChg: last?.funding != null && fp?.funding != null ? last.funding - fp.funding : null,
      basis: last?.mark != null && last.index != null && last.index > 0 ? last.mark / last.index - 1 : null, oiChg: { h1: chg(HOUR), h4: chg(4 * HOUR) } };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 周期统计与当日停开（月度只统计、不减仓不停开）
  // ---------------------------------------------------------------------------------------------------------------
  private keys(now: number) { const iso = new Date(now + this.cfg.breaker.tzOffsetHours * HOUR).toISOString(); return { day: iso.slice(0, 10), month: iso.slice(0, 7) }; }
  rollPeriods(now: number, balance: number) {
    const k = this.keys(now);
    if (this.s.month.key !== k.month) this.s.month = emptyPeriod(k.month, balance);
    if (this.s.day.key !== k.day) this.s.day = emptyPeriod(k.day, balance);
  }
  breaker(now: number, balance: number): BreakerState {
    this.rollPeriods(now, balance);
    return breakerState({ monthPnl: this.s.month.pnl, monthStartEquity: this.s.month.startEquity, dayPnl: this.s.day.pnl, oneR: this.cfg.maxLossPct * Math.max(1, this.s.month.startEquity) }, this.cfg);
  }
  /** 最近决策：每根收盘 15m 都更新。同一币种、同一类原因（去掉数字后相同）连续出现时只刷新时间和文字，不刷屏。只在内存/状态里，不额外写盘。 */
  private briefNoTrade(now: number, sym: string, text: string) {
    const cls = (t: string) => t.replace(/[-+]?\d+(?:\.\d+)?/g, "#").slice(0, 60);
    const i = this.s.recent.findIndex(x => x.sym === sym);
    if (i >= 0 && this.s.recent[i]!.kind === "不做" && cls(this.s.recent[i]!.text) === cls(text)) this.s.recent.splice(i, 1);
    this.brief(now, sym, "不做", text);
  }
  private brief(now: number, sym: string, kind: string, text: string) {
    if (this.isFvg && this.s.recent.some(x => x.sym === sym && x.text === text.slice(0, 200))) return; // FVG：重启重扫同一形态不重复
    this.s.recent.unshift({ at: now, sym, kind, text: text.slice(0, 200) }); if (this.s.recent.length > 14) this.s.recent.length = 14; }

  // ---------------------------------------------------------------------------------------------------------------
  // tick：只读判断
  // ---------------------------------------------------------------------------------------------------------------
  tick(c: { now: number; forward: ForwardState; quotes: Record<string, Quote>; contracts: Record<string, Contract>; enabled: boolean }): Action[] {
    const { now, forward } = c, actions: Action[] = [];
    try {
      this.rollPeriods(now, forward.balance);
      this.sampleOpen(c);
      this.samplePost(c);
      const open = this.s.open;
      if (this.isFvg) {
        this.syncWatch(now);
        this.sampleFvg(c);
        if (open) this.manageOpen(open, c, actions); // 切换前的旧 SMC 单：按原规则管到平仓
        for (const a of this.desk.tick({ now, forward, quotes: c.quotes, enabled: c.enabled })) actions.push({ type: "FVG", a });
        if (this.desk.dirty) { this.desk.dirty = false; this.extremesDirty = true; }
        return actions;
      }
      if (open) { this.manageOpen(open, c, actions); return actions; }
      if (!c.enabled) return actions;
      const bk = this.breaker(now, forward.balance);
      if (forward.positions.some(t => t.status === "OPEN")) return actions;
      this.decideAll(c, bk, actions);
    } catch (error) { this.lastDecisionError = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160); }
    return actions;
  }
  private manageOpen(open: NtsOpen, c: { now: number; forward: ForwardState; quotes: Record<string, Quote> }, actions: Action[]) {
    const { now, forward } = c;
    {
      {
        const t = forward.positions.find(x => x.id === open.tid && x.status === "OPEN");
        const q = c.quotes[open.sym];
        if (t && q && q.fresh) {
          const px = open.side === "LONG" ? q.bestBid : q.bestAsk;
          if (open.daily) {
            const ex = dailyExit({ side: open.side, best: open.daily.best, stop: open.stop, trailDist: open.daily.trailDist, exitAt: open.daily.exitAt }, px, now);
            open.daily.best = ex.best; open.daily.trail = ex.trail; open.stage = ex.trail != null && ex.trail !== open.stop ? `追踪止损 ${r(ex.trail, 2)}` : "初始止损";
            if (ex.action === "CLOSE") actions.push({ type: "CLOSE", code: ex.code, reason: ex.reason, stage: open.stage });
            return;
          }
          const so = { side: open.side, added: open.addedAt != null, addPrice: open.plannedAdd, zone: open.zone, mode: open.mode, target: open.target, breakeven: open.geo.breakeven };
          const ex = smcExit(so, px);
          open.stage = ex.stage;
          if (ex.action === "CLOSE") { actions.push({ type: "CLOSE", code: ex.code, reason: ex.reason, stage: ex.stage }); return; }
          // 补仓：每个 tick 看价格是否到了区的均衡位（4H 结构按 4H K线缓存）
          if (!open.addedAt && open.plannedAdd != null) {
            const bars = this.bars(open.sym), b15 = bars["15m"] ?? [], b4 = bars["4h"], bt = b15[b15.length - 1]?.time ?? 0, t4 = b4?.[b4.length - 1]?.time ?? 0;
            if (b4 && t4 !== open.h4Bar) { open.h4 = marketStructure(b4, this.cfg).trend; open.h4Bar = t4; }
            const entryPx = open.side === "LONG" ? q.bestAsk : q.bestBid;
            const chk = smcAddCheck(so, entryPx, b15, open.h4);
            if (chk.ok) actions.push({ type: "ADD", check: { ...chk, price: entryPx }, barTime: bt });
            else if (chk.reason !== "未到补仓位") { this.logAddSkip(open, chk.reason, bt, now); open.plannedAdd = null; }
          }
        }
      }
    }
    void now;
  }
  private decideAll(c: { now: number; forward: ForwardState; quotes: Record<string, Quote>; contracts: Record<string, Contract> }, bk: BreakerState, actions: Action[]) {
    const { now, forward } = c;
    {
      const cands: Action[] = [];
      for (const sym of this.symbols) {
        const d = this.data[sym], b15 = d?.bars["15m"], bar = b15?.[b15.length - 1];
        if (!bar || this.s.decided[sym] === bar.time) continue;
        if (now - (bar.time + 900) * 1000 > 10 * MIN) { this.s.decided[sym] = bar.time; continue; } // 启动太晚/断线：这根错过了，不追
        const q = c.quotes[sym], health = this.dataHealth(sym, now);
        // 重启后K线/衍生品还在补拉（约 1 分钟）：先等，不拿半截数据做决定；等到收盘后 8 分钟还不齐才按"数据不足"记一条
        if (!health.ok && now - (bar.time + 900) * 1000 < WARMUP_WAIT_MS) continue;
        if (health.ok && !(q && q.fresh)) continue; // 等行情，最多等到上面的 10 分钟窗口
        if (this.cfg.strategy === "DAILY" && !isDailyDecisionBar(bar.time, this.cfg.daily)) { this.s.decided[sym] = bar.time; continue; }
        this.s.decided[sym] = bar.time;
        if (this.cfg.strategy === "DAILY") { const act = this.decideDaily(sym, bar.time, now, q, c.contracts[sym], health, bk, forward.balance); if (act) cands.push(act); continue; }
        const act = this.decide(sym, bar.time, now, q, c.contracts[sym], health, bk, forward.balance);
        if (act) cands.push(act);
      }
      if (cands.length) {
        // 两个币同时出信号：顺势优先，其次 R:R 高的（同一时刻全账户只持一笔）
        const key = (a: Action) => a.type === "OPEN" ? (a.decision.plan.mode === "TREND" ? 100 : 0) + a.decision.plan.rr : 0;
        cands.sort((a, b) => key(b) - key(a));
        actions.push(cands[0]!);
        for (const o of cands.slice(1)) {
          if (o.type === "OPEN") this.logVetoed(o.decision, o.barTime, now, "同时有更优候选，同一时刻只持一笔");
          else if (o.type === "OPEN_DAILY") this.logDailyVetoed(o.plan, o.barTime, now, "BTC/ETH 同时出信号，按顺序只做第一个（同一时刻全账户只持一笔）");
        }
      }
    }
  }

  private bars(sym: string): Bars { return this.data[sym]?.bars ?? {}; }

  private decide(sym: string, barTime: number, now: number, q: Quote | undefined, contract: Contract | undefined, health: { ok: boolean; notes: string[] }, bk: BreakerState, balance: number): Action | null {
    const bars = this.bars(sym), dv = this.derivView(sym, now);
    const mid = q ? (q.bestBid + q.bestAsk) / 2 : (bars["15m"]?.[bars["15m"]!.length - 1]?.close ?? 0);
    const snap: Snap = { symbol: sym, now, bid: q?.bestBid ?? mid, ask: q?.bestAsk ?? mid, funding: dv.funding, fundingChg: dv.fundingChg, basis: dv.basis, oiChg: dv.oiChg };
    const packs = buildPacks(bars), view = smcView(bars, this.cfg);
    const bias = computeBias(snap, packs, bars, this.cfg); // 只记录 / 显示
    const reasonData = health.ok ? "" : health.notes.join("；");
    const dataOk = health.ok && !!contract && !!q && q.fresh;
    const ctx = { atr1h: packs["1h"]?.atr ?? null, atr15: packs["15m"]?.atr ?? null, inEvent: this.eventWindow(now), dataOk, dataNote: reasonData || (!contract ? "合约规格未就绪" : "行情不新鲜") };
    let dec: SmcDecision = evaluateSmcEntry(sym, snap.bid, snap.ask, bars, view, ctx, this.cfg);
    let blockedPlan = false;
    if (dec.action === "ENTER" && !bk.allowEntry) { blockedPlan = true; dec = { action: "NO_TRADE", side: dec.side, reason: `当日停开：${bk.reason}`, vetoes: dec.vetoes }; }
    this.s.lastEval[sym] = { at: now, barTime, action: dec.action, side: dec.side,
      reason: dec.action === "ENTER" ? `计划 ${dec.side} ${dec.plan.zone.tf}订单块 R:R ${dec.plan.rr}` : dec.reason, core: bias.core, score: bias.score,
      plan: dec.action === "ENTER" ? dec.plan : null, vetoes: dec.vetoes.length,
      structure: { h4: view.h4.trend, highs: view.h4.highs, lows: view.h4.lows, d1: view.d1.trend },
      zones: nearObs(view, mid, 4).map(z => ({ lo: r(z.lo, 2)!, hi: r(z.hi, 2)!, score: z.priorVisits, kind: `${z.kind === "DEMAND" ? "需求区" : "供给区"}${z.fvg ? "·FVG" : ""}`, tfs: [z.tf] })) };
    const snapshot = this.snapshotFor(sym, snap, packs, bias, view, dv, bk, balance);
    if (dec.action === "ENTER") return { type: "OPEN", sym, decision: dec, barTime, snapshot };
    // 否决记录：只有"信号已出现、计划成形后被否决"（R:R 不够 / 区太宽 / 当日停开）才逐根记录（每 symbol 每 4H 至多 4 条）；
    // 其它（不在区内 / 区内还没有反转信号 / 逆势 1H 区 / 区已作废）只按 4H 抽样一条，避免日志与写入膨胀。
    const quiet = /^价格不在|还没有 15m 反转|不做逆势|穿透订单块|已在止损外侧/;
    let noteworthy = blockedPlan || dec.vetoes.some(v => !quiet.test(v.reason));
    const slot = Math.floor(now / (this.cfg.log.noTradeSampleMs));
    const sampled = this.s.noTradeSlot[sym] !== slot; // 日志：4H 心跳一条；"最近决策"面板每根都刷新（只在内存/状态里）
    if (noteworthy) {
      const vs = this.vetoSlot[sym];
      if (!vs || vs.slot !== slot) this.vetoSlot[sym] = { slot, n: 1 };
      else if (vs.n >= 4) noteworthy = false;
      else vs.n++;
    }
    if (noteworthy || sampled) {
      if (sampled) this.s.noTradeSlot[sym] = slot;
      this.safeAppend({ id: noteworthy ? `veto:${sym}:${barTime}` : `nt:${sym}:${slot}`, k: "NO_TRADE", t: now, sym,
        d: { barTime, reason: dec.reason, side: dec.side, vetoes: dec.vetoes, kind: noteworthy ? "否决" : "抽样", ...snapshot } }, now);
    }
    this.briefNoTrade(now, sym, dec.reason);
    return null;
  }
  /** 每日短线：每天一根决策 15m（UTC 00:00 收盘），按 24h 收益方向进场。决策依据整条写进日志；RSI/MACD/偏向分只记录。 */
  private decideDaily(sym: string, barTime: number, now: number, q: Quote | undefined, contract: Contract | undefined, health: { ok: boolean; notes: string[] }, bk: BreakerState, balance: number): Action | null {
    const bars = this.bars(sym), dv = this.derivView(sym, now), b15 = bars["15m"] ?? [];
    const mid = q ? (q.bestBid + q.bestAsk) / 2 : (b15[b15.length - 1]?.close ?? 0);
    const snap: Snap = { symbol: sym, now, bid: q?.bestBid ?? mid, ask: q?.bestAsk ?? mid, funding: dv.funding, fundingChg: dv.fundingChg, basis: dv.basis, oiChg: dv.oiChg };
    const packs = buildPacks(bars), view = smcView(bars, this.cfg), bias = computeBias(snap, packs, bars, this.cfg);
    let dec = evaluateDailyEntry(sym, snap.bid, snap.ask, b15, barTime, this.cfg.daily, this.cfg.firstMarginPct, now);
    const dataOk = health.ok && !!contract && !!q && q.fresh;
    if (dec.action === "ENTER" && !dataOk) dec = { action: "NO_TRADE", side: dec.side, reason: `数据未就绪：${health.notes.join("；") || (!contract ? "合约规格未就绪" : "行情不新鲜")}` };
    if (dec.action === "ENTER" && !bk.allowEntry) dec = { action: "NO_TRADE", side: dec.side, reason: `当日停开：${bk.reason}` };
    this.s.lastEval[sym] = { at: now, barTime, action: dec.action, side: dec.side, reason: dec.action === "ENTER" ? `每日短线 ${dec.plan.basis}` : dec.reason,
      core: bias.core, score: bias.score, plan: null, vetoes: 0, structure: { h4: view.h4.trend, highs: view.h4.highs, lows: view.h4.lows, d1: view.d1.trend }, zones: [] };
    const snapshot = this.snapshotFor(sym, snap, packs, bias, view, dv, bk, balance);
    if (dec.action === "ENTER") return { type: "OPEN_DAILY", sym, plan: dec.plan, barTime, snapshot };
    this.safeAppend({ id: `nt:${sym}:${barTime}`, k: "NO_TRADE", t: now, sym, d: { barTime, strategy: "DAILY", reason: dec.reason, side: dec.side, kind: "每日决策", ...snapshot } }, now);
    this.brief(now, sym, "不做", dec.reason);
    return null;
  }
  private logDailyVetoed(plan: DailyPlan, barTime: number, now: number, why: string) {
    this.safeAppend({ id: `veto:${plan.symbol}:${barTime}`, k: "NO_TRADE", t: now, sym: plan.symbol, d: { barTime, strategy: "DAILY", reason: why, kind: "否决", plan } }, now);
  }
  private eventWindow(now: number) {
    for (const w of this.cfg.eventWindows) if (now >= w.start && now <= w.end) return w.label;
    return null;
  }
  /** All indicators for one decision point, computed once, compact. */
  private snapshotFor(sym: string, snap: Snap, packs: Packs, bias: BiasResult, view: SmcView, dv: ReturnType<NtsEngine["derivView"]>, bk: BreakerState, balance: number) {
    const mid = (snap.bid + snap.ask) / 2; void sym;
    return {
      bias: { core: bias.core, score: bias.score, side: bias.side, conf: bias.confidence, comps: bias.comps, aux: bias.aux, unconnected: bias.unconnected, use: "只记录/显示，不参与订单块放行/否决" },
      zones: nearObs(view, mid, 6).map(z => ({ tf: z.tf, kind: z.kind, lo: r(z.lo, 2), hi: r(z.hi, 2), t: z.t, visits: z.priorVisits, inside: z.inside, fvg: z.fvg })),
      structure: { h4: { trend: view.h4.trend, bosT: view.h4.bosT, bosLevel: r(view.h4.bosLevel, 2), highs: view.h4.highs, lows: view.h4.lows },
        d1: { trend: view.d1.trend, highs: view.d1.highs, lows: view.d1.lows } },
      fvg: view.fvgs.filter(g => Math.abs((g.lo + g.hi) / 2 / mid - 1) < 0.03).slice(-6).map(g => ({ tf: g.tf, kind: g.kind, lo: r(g.lo, 2), hi: r(g.hi, 2) })),
      ind: { "15m": packs["15m"], "1h": packs["1h"], "4h": packs["4h"], "1d": packs["1d"] },
      deriv: { funding: dv.funding, fundingChg: r(dv.fundingChg, 7), basis: r(dv.basis, 6), oiChg1h: r(dv.oiChg.h1, 5), oiChg4h: r(dv.oiChg.h4, 5), longShortRatio: "未接入" },
      px: { bid: snap.bid, ask: snap.ask }, breaker: { state: bk.state, monthPct: r(bk.monthPct, 4), dayR: r(bk.dayR, 2) }, equity: r(balance, 2),
    };
  }
  private logAddSkip(o: NtsOpen, reason: string, bt: number, now: number) {
    this.safeAppend({ id: `addskip:${o.tid}:${bt}`, k: "ADD_SKIP", t: now, sym: o.sym, tid: o.tid, d: { barTime: bt, reason, plannedAdd: o.plannedAdd, zone: o.zone, h4: o.h4 } }, now);
  }
  private logVetoed(dec: Extract<SmcDecision, { action: "ENTER" }>, barTime: number, now: number, why: string) {
    this.safeAppend({ id: `veto:${dec.plan.symbol}:${barTime}`, k: "NO_TRADE", t: now, sym: dec.plan.symbol, d: { barTime, reason: why, kind: "否决", plan: dec.plan } }, now);
  }
  private safeAppend(rec: NtsRec, now: number) { try { this.log.append(rec, now); } catch { /* 日志失败不影响交易 */ } }

  // ---------------------------------------------------------------------------------------------------------------
  // execute：在账户副本上执行
  // ---------------------------------------------------------------------------------------------------------------
  execute(draft: ForwardState, actions: Action[], c: { now: number; quotes: Record<string, Quote>; contracts: Record<string, Contract> }): boolean {
    let changed = false;
    // 只补显示字段：已经移过保本、但持仓上还没有 breakeven 的（本功能上线前移的），写上原止损（一次）
    for (const o of this.s.fvg?.opens ?? []) {
      if (!o.be) continue;
      const t = draft.positions.find(x => x.id === o.tid && x.status === "OPEN");
      if (t && !t.breakeven) { t.breakeven = { origStop: stop0Of(o), stop: o.be.stop, at: o.be.at }; changed = true; }
    }
    for (const a of actions) {
      try {
        if (a.type === "FVG") {
          if (a.a.type === "OPEN_FVG") changed = this.desk.open(draft, a.a, c) || changed;
          else if (a.a.type === "MOVE_STOP_FVG") changed = this.desk.moveStop(draft, a.a, c) || changed;
          else if (this.desk.close(draft, a.a, c)) { changed = true; this.reconcileFvg(draft, c.now, { tid: a.a.tid, code: a.a.code, reason: a.a.reason }); }
        }
        else if (a.type === "OPEN") changed = this.doOpen(draft, a, c) || changed;
        else if (a.type === "OPEN_DAILY") changed = this.doOpenDaily(draft, a, c) || changed;
        else if (a.type === "ADD") changed = this.doAdd(draft, a, c) || changed;
        else changed = this.doClose(draft, a, c) || changed;
      } catch (error) { this.lastDecisionError = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160); }
    }
    return changed;
  }
  private doOpen(draft: ForwardState, a: Extract<Action, { type: "OPEN" }>, c: { now: number; quotes: Record<string, Quote>; contracts: Record<string, Contract> }) {
    const { plan } = a.decision, now = c.now, q = c.quotes[a.sym], balance = draft.balance, cfg = this.cfg;
    const tid = ntsTradeId(a.sym, a.barTime);
    if (!q) { this.logVetoed(a.decision, a.barTime, now, "下单时没有行情"); return false; }
    const marginTarget = balance * plan.marginFirstPct;
    const res = openPaperTrade(draft, { id: tid, symbol: a.sym, side: plan.side, quote: q, contract: c.contracts[a.sym], marginTarget, leverage: cfg.leverage,
      stopPrice: plan.stop, targetPrice: plan.target, maintenanceRate: cfg.maintenanceRate, slippageRate: cfg.slippagePct, now, reason: `NTS ${plan.side} ${plan.zone.tf}订单块 ${r(plan.zone.lo, 1)}~${r(plan.zone.hi, 1)}` });
    if (!res.ok) { this.logVetoed(a.decision, a.barTime, now, `下单失败：${res.reason}`); this.brief(now, a.sym, "放弃", res.reason); return false; }
    const t = res.trade, oneR = cfg.maxLossPct * balance;
    const geo = { ...plan.geo, entry: t.entryPrice, avg: t.entryPrice, breakeven: t.entryPrice * (1 + dirOf(plan.side) * cfg.breakevenPct), tolerance: t.entryPrice * (1 + dirOf(plan.side) * cfg.breakevenPct), firstStop: plan.stop, hardStop: plan.stop };
    const b4 = this.bars(a.sym)["4h"];
    this.s.open = { tid, sym: a.sym, side: plan.side, openedAt: now, entry1: t.entryPrice, addedAt: null, addPrice: null, avg: t.entryPrice, geo, target: plan.target, stop: plan.stop,
      scale: 1, zoneScore: plan.zone.score, zoneKey: `${plan.zone.tf}:${r(plan.zone.lo, 2)}`, equityAtOpen: balance, oneR, mfePct: 0, maePct: 0, mfeR: 0, maeR: 0, lastTraceAt: now,
      lastBarEval: a.barTime, stage: "未补仓", margin1: t.margin,
      zone: { lo: plan.zone.lo, hi: plan.zone.hi, tf: plan.zone.tf, kind: plan.zone.kind }, mode: plan.mode, plannedAdd: plan.addPrice,
      h4: plan.structure.h4, h4Bar: b4?.[b4.length - 1]?.time ?? 0 };
    this.safeAppend({ id: `entry:${tid}`, k: "ENTRY", t: now, sym: a.sym, tid, d: {
      side: plan.side, barTime: a.barTime, plan: { ...plan, geo: undefined }, planGeometry: plan.geo, vetoes: a.decision.vetoes,
      fill: { price: t.entryPrice, contracts: t.contracts, qty: t.quantity, notional: r(t.notional, 2), margin: r(t.margin, 2), fee: r(t.entryFee, 4), liq: t.liquidationPrice, leverage: t.leverage },
      sizing: { balance: r(balance, 2), firstPct: r(plan.marginFirstPct, 4), addPct: r(plan.marginAddPct, 4), oneR: r(oneR, 2), worstFirstPct: r(plan.worstFirstPct, 4), worstLossPct: r(plan.worstLossPct, 4), scale: 1 },
      ...a.snapshot, version: NTS_VERSION } }, now);
    this.brief(now, a.sym, "进场", `${plan.side === "LONG" ? "多" : "空"}${plan.mode === "COUNTER" ? "（逆势）" : ""} ${plan.zone.tf}订单块 @${r(t.entryPrice, 2)} 止损 ${r(plan.stop, 2)} TP1 ${r(plan.target, 2)} R:R ${plan.rr}`);
    return true;
  }
  private doOpenDaily(draft: ForwardState, a: Extract<Action, { type: "OPEN_DAILY" }>, c: { now: number; quotes: Record<string, Quote>; contracts: Record<string, Contract> }) {
    const { plan } = a, now = c.now, q = c.quotes[a.sym], balance = draft.balance, cfg = this.cfg, tid = ntsTradeId(a.sym, a.barTime);
    if (!q) { this.logDailyVetoed(plan, a.barTime, now, "下单时没有行情"); return false; }
    const res = openPaperTrade(draft, { id: tid, symbol: a.sym, side: plan.side, quote: q, contract: c.contracts[a.sym], marginTarget: balance * cfg.firstMarginPct, leverage: cfg.leverage,
      stopPrice: plan.stop, targetPrice: null, maintenanceRate: cfg.maintenanceRate, slippageRate: cfg.slippagePct, now, reason: `NTS 每日短线 ${plan.side} 24h ${(plan.ret24 * 100).toFixed(2)}%` });
    if (!res.ok) { this.logDailyVetoed(plan, a.barTime, now, `下单失败：${res.reason}`); this.brief(now, a.sym, "放弃", res.reason); return false; }
    const t = res.trade, oneR = cfg.maxLossPct * balance, d = dirOf(plan.side);
    const geo = { entry: t.entryPrice, add: t.entryPrice, avg: t.entryPrice, breakeven: t.entryPrice * (1 + d * cfg.breakevenPct), tolerance: t.entryPrice * (1 + d * cfg.breakevenPct), firstStop: plan.stop, hardStop: plan.stop };
    this.s.open = { tid, sym: a.sym, side: plan.side, openedAt: now, entry1: t.entryPrice, addedAt: null, addPrice: null, avg: t.entryPrice, geo, target: 0, stop: plan.stop,
      scale: 1, zoneScore: 0, zoneKey: "daily", equityAtOpen: balance, oneR, mfePct: 0, maePct: 0, mfeR: 0, maeR: 0, lastTraceAt: now, lastBarEval: a.barTime, stage: "初始止损", margin1: t.margin,
      zone: { lo: Math.min(plan.stop, t.entryPrice), hi: Math.max(plan.stop, t.entryPrice), tf: "15m", kind: "DAILY" }, mode: "TREND", plannedAdd: null, h4: "NONE", h4Bar: 0,
      daily: { best: t.entryPrice, trailDist: plan.trailDist, exitAt: plan.exitAt, trail: null, ret24: plan.ret24 } };
    this.safeAppend({ id: `entry:${tid}`, k: "ENTRY", t: now, sym: a.sym, tid, d: {
      strategy: "DAILY", side: plan.side, barTime: a.barTime, plan, basis: plan.basis,
      fill: { price: t.entryPrice, contracts: t.contracts, qty: t.quantity, notional: r(t.notional, 2), margin: r(t.margin, 2), fee: r(t.entryFee, 4), liq: t.liquidationPrice, leverage: t.leverage },
      sizing: { balance: r(balance, 2), firstPct: r(cfg.firstMarginPct, 4), addPct: 0, oneR: r(oneR, 2), stopPct: plan.stopPct, scale: 1 },
      ...a.snapshot, version: NTS_VERSION } }, now);
    this.brief(now, a.sym, "进场", `每日短线 ${plan.side === "LONG" ? "多" : "空"} @${r(t.entryPrice, 2)} 止损 ${r(plan.stop, 2)}（24h ${(plan.ret24 * 100).toFixed(2)}%，到期 ${new Date(plan.exitAt + 7 * HOUR).toISOString().slice(11, 16)} 老挝）`);
    return true;
  }
  private doAdd(draft: ForwardState, a: Extract<Action, { type: "ADD" }>, c: { now: number; quotes: Record<string, Quote>; contracts: Record<string, Contract> }) {
    const o = this.s.open!, t = draft.positions.find(x => x.id === o.tid && x.status === "OPEN"), q = c.quotes[o.sym], cfg = this.cfg, now = c.now;
    if (!t || !q) return false;
    // 补仓 +3% 本金保证金；硬止损不动，仍在订单块外（开仓时已校验补仓后最坏亏损 ≤ 1R）
    const res = addToPaperTrade(draft, t, { quote: q, contract: c.contracts[o.sym], marginTarget: o.equityAtOpen * cfg.addMarginPct, stopPrice: o.stop, slippageRate: cfg.slippagePct, now });
    if (!res.ok) { this.safeAppend({ id: `addskip:${o.tid}:${a.barTime}`, k: "ADD_SKIP", t: now, sym: o.sym, tid: o.tid, d: { barTime: a.barTime, reason: `下单失败：${res.reason}` } }, now); o.plannedAdd = null; return false; }
    const d = dirOf(o.side), avg = t.entryPrice;
    o.geo = { entry: o.entry1, add: res.fillPrice, avg, breakeven: avg * (1 + d * cfg.breakevenPct), tolerance: avg * (1 + d * cfg.breakevenPct), hardStop: o.stop, firstStop: o.stop };
    o.avg = avg; o.addedAt = now; o.addPrice = res.fillPrice; o.stage = "已补仓";
    this.safeAppend({ id: `add:${o.tid}`, k: "ADD", t: now, sym: o.sym, tid: o.tid, d: {
      barTime: a.barTime, price: res.fillPrice, qty: r(res.addQuantity, 6), fee: r(res.addFee, 4), avg, geo: o.geo, reason: a.check.reason, planned: o.plannedAdd,
      zone: { tf: o.zone.tf, kind: o.zone.kind, lo: r(o.zone.lo, 2), hi: r(o.zone.hi, 2) }, h4: o.h4,
      liq: t.liquidationPrice, margin: r(t.margin, 2), version: NTS_VERSION } }, now);
    this.brief(now, o.sym, "补仓", `@${r(res.fillPrice, 2)} 均价 ${r(avg, 2)} 保本价 ${r(o.geo.breakeven, 2)} 止损 ${r(o.stop, 2)}`);
    return true;
  }
  private doClose(draft: ForwardState, a: Extract<Action, { type: "CLOSE" }>, c: { now: number; quotes: Record<string, Quote>; contracts: Record<string, Contract> }) {
    const o = this.s.open!, t = draft.positions.find(x => x.id === o.tid && x.status === "OPEN"), q = c.quotes[o.sym];
    if (!t || !q) return false;
    const px = closePaperTrade(draft, t, q, c.now, `NTS_${a.code}`, { nts: a.code, stage: a.stage }, this.cfg.slippagePct);
    if (px == null) return false;
    this.s.open = o; // 保持到 reconcile 统一收尾（同一套出场记录路径）
    this.reconcile(draft, c.quotes, c.now, { code: a.code, reason: a.reason });
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // reconcile：账户已把 NTS 单平掉（止损/强平/我们自己平的），补记出场并更新统计
  // ---------------------------------------------------------------------------------------------------------------
  reconcile(forward: ForwardState, quotes: Record<string, Quote>, now: number, own?: { code: string; reason: string }): boolean {
    const f = this.reconcileFvg(forward, now);
    return this.reconcileLegacy(forward, quotes, now, own) || f;
  }
  /** FVG 持仓：账户已平（止损/保本止损/强平/我们自己的止盈）→ 补记出场、更新统计。 */
  reconcileFvg(forward: ForwardState, now: number, own?: { tid: string; code: string; reason: string }): boolean {
    const opens = this.fvgOpens; if (!opens.length) return false;
    let changed = false;
    for (const o of [...opens]) {
      if (forward.positions.some(x => x.id === o.tid && x.status === "OPEN")) continue;
      const mine = own && own.tid === o.tid ? own : undefined;
      const t = forward.history.find(x => x.id === o.tid) as Trade | undefined;
      if (!t && !mine && now - o.openedAt < 60_000) continue;
      const exitAt = t?.closedAt ?? now, exitPx = t?.exitPrice ?? o.fill;
      const net = t?.netPnl ?? 0, rr = o.oneR > 0 ? net / o.oneR : 0;
      const raw = t?.exitReason ?? "";
      const stopCode = o.be ? "BE_STOP" : "HARD_STOP";
      const code = mine?.code ?? (raw.includes("NTS_TARGET") ? "TARGET" : raw.includes("STOP") ? stopCode : raw.toUpperCase().includes("LIQ") ? "LIQUIDATION" : raw || "UNKNOWN");
      const reason = mine?.reason ?? (code === "TARGET" ? `到 ${o.tpR ?? this.cfg.fvg.rr}R 止盈` : code === "BE_STOP" ? "保本止损（+1R 后止损已移到入场价）" : code === "HARD_STOP" ? "触及止损（扫点外）" : code === "LIQUIDATION" ? "触发强平" : `账户引擎平仓：${raw || "未知"}`);
      const rule = exitRuleOf(o), x = this.extremes(o), rPrice = r(priceR(o, exitPx), 3), feeR = r(rr, 3);
      if (!this.s.handled.includes(o.tid)) {
        this.s.handled.push(o.tid); if (this.s.handled.length > 40) this.s.handled.shift();
        if (t) for (const p of [this.s.day, this.s.month]) { p.pnl += net; p.trades++; if (net > 0) p.wins++; p.r += rr; }
        const sum: ExitSummary = { tid: o.tid, sym: o.sym, side: o.side, at: exitAt, reason, code, netPnl: r(net, 4)!, r: r(rr, 2)!, holdMin: Math.round((exitAt - o.openedAt) / MIN), mfePct: r(o.mfePct, 4)!, maePct: r(o.maePct, 4)!,
          rPrice, mfeR: r(o.mfeR, 2)!, maeR: r(o.maeR, 2)!, mfeR_price: r(x.mfeRp, 2), maeR_price: r(x.maeRp, 2), exitRule: rule };
        this.s.lastExit = sum;
        const sh = o.shadow ? { ...o.shadow } : null;
        const shadow3R = rule === "3R" ? { res: "SAME_AS_ACTUAL", note: "本单就是老 3R 规则，实际结果即 3R 结果" }
          : sh ? { ...this.shadowView(sh, o, t?.quantity ?? null, t?.entryFee ?? null), pending: sh.res == null, note: sh.res == null ? "出场时 3R/原止损都还没到：出场后继续按路径判断（最多 48 小时），结论记 SHADOW_3R" : "按持仓期间路径判断" } : null;
        this.safeAppend({ id: `exit:${o.tid}`, k: "EXIT", t: now, sym: o.sym, tid: o.tid, d: {
          ...sum, strategy: "FVG", case: o.case, setup: o.setupId, fillMode: o.fillMode, exitPx, entry: o.fill, stop: o.stop, stop0: stop0Of(o), tp: o.tp, tpR: o.tpR ?? this.cfg.fvg.rr, zones: o.zoneKeys, fvg15: o.fvg,
          gross: t?.grossPnl ?? null, fees: r((t?.entryFee ?? 0) + (t?.exitFee ?? 0), 4), mfeR: r(o.mfeR, 2), maeR: r(o.maeR, 2), oneR: r(o.oneR, 2), balanceAfter: r(forward.balance, 2),
          r_fee: feeR, r_price: rPrice, mfeR_fee: r(o.mfeR, 3), maeR_fee: r(o.maeR, 3), mfeR_price: r(x.mfeRp, 3), maeR_price: r(x.maeRp, 3), mfePx: x.favPx, maePx: x.advPx,
          rNote: "r/r_fee/mfeR/maeR = 扣手续费的 R（净盈亏 ÷ 1R 风险金额，含开平手续费）；*_price = 只看价格的 R（价格移动 ÷ |成交价 − 原止损|）",
          beMove: o.be ?? null, shadow3R, version: NTS_VERSION } }, now);
        this.brief(now, o.sym, "出场", `情形${o.case} ${reason}，净 ${net >= 0 ? "+" : ""}${net.toFixed(2)}U（价格 ${rPrice != null && rPrice >= 0 ? "+" : ""}${rPrice?.toFixed(2)}R / 扣费 ${rr.toFixed(2)}R）`);
        this.s.post.push({ tid: o.tid, sym: o.sym, side: o.side, exitAt, exitPx, done: [], best: 0, worst: 0, best120: 0, worst120: 0, barT: 0,
          exitRule: rule, fill: o.fill, stop0: stop0Of(o), qty: t?.quantity, entryFee: t?.entryFee, oneR: o.oneR, shadow: isBeRule(rule) && sh && sh.res == null ? sh : null,
          actual: { code, rPrice, rFee: feeR } });
        if (this.s.post.length > 60) this.s.post.splice(0, this.s.post.length - 60);
        this.extremesDirty = true;
      }
      opens.splice(opens.indexOf(o), 1);
      changed = true;
    }
    return changed;
  }
  private reconcileLegacy(forward: ForwardState, quotes: Record<string, Quote>, now: number, own?: { code: string; reason: string }): boolean {
    const o = this.s.open; if (!o) return false;
    if (forward.positions.some(x => x.id === o.tid && x.status === "OPEN")) return false;
    const t = forward.history.find(x => x.id === o.tid) as Trade | undefined;
    if (!t && !own) { if (now - o.openedAt < 60_000) return false; } // 刚开仓的这一刻历史里还没有，别误判
    const exitAt = t?.closedAt ?? now, exitPx = t?.exitPrice ?? o.avg, d = dirOf(o.side);
    const net = t?.netPnl ?? 0, rr = o.oneR > 0 ? net / o.oneR : 0;
    const code = own?.code ?? (t?.exitReason?.includes("STOP") ? "HARD_STOP" : t?.exitReason?.toUpperCase().includes("LIQ") ? "LIQUIDATION" : t?.exitReason ?? "UNKNOWN");
    const reason = own?.reason ?? (code === "HARD_STOP" ? "触及硬止损" : code === "LIQUIDATION" ? "触发强平" : `账户引擎平仓：${t?.exitReason ?? "未知"}`);
    if (!this.s.handled.includes(o.tid)) {
      this.s.handled.push(o.tid); if (this.s.handled.length > 40) this.s.handled.shift();
      if (t) for (const p of [this.s.day, this.s.month]) { p.pnl += net; p.trades++; if (net > 0) p.wins++; p.r += rr; }
      const sum: ExitSummary = { tid: o.tid, sym: o.sym, side: o.side, at: exitAt, reason, code, netPnl: r(net, 4)!, r: r(rr, 2)!, holdMin: Math.round((exitAt - o.openedAt) / MIN), mfePct: r(o.mfePct, 4)!, maePct: r(o.maePct, 4)! };
      this.s.lastExit = sum;
      this.safeAppend({ id: `exit:${o.tid}`, k: "EXIT", t: now, sym: o.sym, tid: o.tid, d: {
        ...sum, exitPx, entry1: o.entry1, add: o.addPrice, avg: o.avg, geo: o.geo, stage: o.stage, added: o.addedAt != null, gross: t?.grossPnl ?? null, fees: r((t?.entryFee ?? 0) + (t?.exitFee ?? 0), 4),
        mfeR: r(o.mfeR, 2), maeR: r(o.maeR, 2), oneR: r(o.oneR, 2), balanceAfter: r(forward.balance, 2),
        version: NTS_VERSION } }, now);
      this.brief(now, o.sym, "出场", `${reason}，净 ${net >= 0 ? "+" : ""}${net.toFixed(2)}U（${rr.toFixed(2)}R）`);
      this.s.post.push({ tid: o.tid, sym: o.sym, side: o.side, exitAt, exitPx, done: [], best: 0, worst: 0, best120: 0, worst120: 0, barT: 0 });
      if (this.s.post.length > 60) this.s.post.splice(0, this.s.post.length - 60);
    }
    void d; void quotes;
    this.s.open = null;
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 进场后的走势采样 / 出场后 30·60·120 分钟
  // ---------------------------------------------------------------------------------------------------------------
  private floating(o: NtsOpen, q: Quote, t: Trade) {
    const px = o.side === "LONG" ? q.bestBid : q.bestAsk, d = dirOf(o.side);
    const gross = d * (px - t.entryPrice) * t.quantity, net = gross - t.entryFee - px * t.quantity * 0.0007;
    return { px, pct: d * (px / o.avg - 1), r: o.oneR > 0 ? net / o.oneR : 0, net };
  }
  private sampleOpen(c: { now: number; forward: ForwardState; quotes: Record<string, Quote> }) {
    const o = this.s.open; if (!o) return;
    const t = c.forward.positions.find(x => x.id === o.tid && x.status === "OPEN"), q = c.quotes[o.sym];
    if (!t || !q || !q.fresh) return;
    const f = this.floating(o, q, t), d = dirOf(o.side);
    if (f.pct > o.mfePct) o.mfePct = f.pct; if (f.pct < o.maePct) o.maePct = f.pct;
    if (f.r > o.mfeR) o.mfeR = f.r; if (f.r < o.maeR) o.maeR = f.r;
    if (c.now - o.lastTraceAt >= this.cfg.log.traceEveryMs) {
      o.lastTraceAt = c.now;
      const slot = Math.floor(c.now / this.cfg.log.traceEveryMs);
      const stopDist = d * (f.px - o.stop) / f.px, beDist = d * (o.geo.breakeven - f.px) / f.px;
      this.safeAppend({ id: `tr:${o.tid}:${slot}`, k: "TRACE", t: c.now, sym: o.sym, tid: o.tid, d: {
        px: f.px, pct: r(f.pct, 5), r: r(f.r, 3), mfePct: r(o.mfePct, 5), maePct: r(o.maePct, 5), mfeR: r(o.mfeR, 3), maeR: r(o.maeR, 3),
        toStopPct: r(stopDist, 5), toBePct: o.addedAt ? r(beDist, 5) : null, toTargetPct: o.addedAt ? null : r(d * (o.target - f.px) / f.px, 5), stage: o.stage, ageMin: Math.round((c.now - o.openedAt) / MIN) } }, c.now);
    }
  }
  /** 出场后还在跟踪的币：hot = 出场后 125 分钟内（常驻实时行情 + 每根 15m 刷新）；cold = 影子 3R 还没结论（冷币节奏取 15m）。 */
  private syncWatch(now: number) {
    const hot: string[] = [], cold: string[] = [], last = Math.max(...this.cfg.log.postExitMarksMin, 0) * MIN;
    for (const p of this.s.post) {
      if (now - p.exitAt <= last + 5 * MIN && p.done.length < this.cfg.log.postExitMarksMin.length) hot.push(p.sym);
      else if (p.shadow && !p.shadow.res) cold.push(p.sym);
    }
    for (const k of this.s.fvg?.skips ?? []) if (!k.res) cold.push(k.sym); // 跳过影子：已有 15m 取数（冷币节奏），不新增请求类型
    this.desk.setWatch(hot, cold);
  }
  /** FVG 持仓的价格极值 → 价格 R（不含手续费）。 */
  private extremes(o: FvgOpen) {
    const long = o.side === "LONG", hi = Math.max(o.hiPx ?? o.fill, o.fill), lo = Math.min(o.loPx ?? o.fill, o.fill);
    const favPx = long ? hi : lo, advPx = long ? lo : hi;
    // 旧单没有价格极值时，用已记录的 mfePct/maePct 还原
    const fromPct = (pct: number) => o.fill * (1 + (long ? 1 : -1) * pct);
    const fav = long ? Math.max(favPx, fromPct(o.mfePct)) : Math.min(favPx, fromPct(o.mfePct)), adv = long ? Math.min(advPx, fromPct(o.maePct)) : Math.max(advPx, fromPct(o.maePct));
    return { favPx: fav, advPx: adv, mfeRp: Math.max(0, priceR(o, fav)), maeRp: Math.min(0, priceR(o, adv)) };
  }
  /** 影子 3R 结果的 R：价格 R（3 / −1）和估算的扣费 R（按实际数量、开仓手续费、平仓费率 0.07%）。 */
  private shadowView(sh: Shadow3R, o: { side: Side; fill: number; oneR: number }, qty: number | null, entryFee: number | null) {
    const px = sh.res === "TP3" ? sh.tp3 : sh.res === "STOP" ? sh.stop0 : null, d = dirOf(o.side);
    const rPrice = sh.res === "TP3" ? 3 : sh.res === "STOP" ? -1 : null;
    const rFee = px != null && qty != null && entryFee != null && o.oneR > 0 ? r((d * (px - o.fill) * qty - entryFee - px * qty * 0.0007) / o.oneR, 3) : null;
    return { res: sh.res, at: sh.at, px: sh.px, src: sh.src, tp3: sh.tp3, stop0: sh.stop0, rPrice, rFeeEst: rFee };
  }
  /** FVG 持仓：最有利/最不利（实时报价 + 开仓后已收盘 15m 的高低点，只增不减，重启后也不会回退）、影子 3R、每 traceEveryMs 一条 TRACE。 */
  private sampleFvg(c: { now: number; forward: ForwardState; quotes: Record<string, Quote> }) {
    for (const o of this.fvgOpens) {
      const t = c.forward.positions.find(x => x.id === o.tid && x.status === "OPEN"), q = c.quotes[o.sym];
      if (!t) continue;
      const d = dirOf(o.side), before = [o.hiPx, o.loPx, o.mfePct, o.maePct, o.mfeR, o.maeR, o.shadow?.res ?? null].join("|");
      o.hiPx = Math.max(o.hiPx ?? o.fill, o.fill); o.loPx = Math.min(o.loPx ?? o.fill, o.fill); o.barT ??= 0;
      const sh = isBeRule(exitRuleOf(o)) ? o.shadow : undefined;
      for (const b of this.data[o.sym]?.bars["15m"] ?? []) {
        const st = b.time * 1000;
        if (st < o.openedAt || st + 15 * MIN > c.now || st <= o.barT) continue;
        if (b.high > o.hiPx) o.hiPx = b.high; if (b.low < o.loPx) o.loPx = b.low;
        o.barT = st;
        if (sh && st > sh.barT) { sh.barT = st; if (stepShadow(sh, o.side, b.high, b.low, st, "15m")) this.logShadow(o.tid, o.sym, sh, o, t.quantity, t.entryFee, null, c.now); }
      }
      const fresh = !!(q && q.fresh), px = fresh ? (o.side === "LONG" ? q!.bestBid : q!.bestAsk) : null;
      if (px != null) {
        if (px > o.hiPx) o.hiPx = px; if (px < o.loPx) o.loPx = px;
        o.segHi = Math.max(o.segHi ?? px, px); o.segLo = Math.min(o.segLo ?? px, px);
        if (sh && stepShadow(sh, o.side, px, px, c.now, "quote")) this.logShadow(o.tid, o.sym, sh, o, t.quantity, t.entryFee, null, c.now);
      }
      // 极值 → 百分比 / 扣费 R（只增不减）
      const netR = (p: number) => o.oneR > 0 ? (d * (p - t.entryPrice) * t.quantity - t.entryFee - p * t.quantity * 0.0007) / o.oneR : 0;
      const favPx = o.side === "LONG" ? o.hiPx : o.loPx, advPx = o.side === "LONG" ? o.loPx : o.hiPx;
      o.mfePct = Math.max(o.mfePct, d * (favPx / o.fill - 1)); o.maePct = Math.min(o.maePct, d * (advPx / o.fill - 1));
      o.mfeR = Math.max(o.mfeR, netR(favPx)); o.maeR = Math.min(o.maeR, netR(advPx));
      if ([o.hiPx, o.loPx, o.mfePct, o.maePct, o.mfeR, o.maeR, o.shadow?.res ?? null].join("|") !== before) this.extremesDirty = true;
      if (!fresh || !q) continue;
      const f = this.floatingFvg(o, q, t);
      if (c.now - o.lastTraceAt >= this.cfg.log.traceEveryMs) {
        o.lastTraceAt = c.now;
        const slot = Math.floor(c.now / this.cfg.log.traceEveryMs), x = this.extremes(o);
        this.safeAppend({ id: `tr:${o.tid}:${slot}`, k: "TRACE", t: c.now, sym: o.sym, tid: o.tid, d: {
          px: f.px, pct: r(f.pct, 5), r: r(f.r, 3), mfePct: r(o.mfePct, 5), maePct: r(o.maePct, 5), mfeR: r(o.mfeR, 3), maeR: r(o.maeR, 3), case: o.case,
          toStopPct: r(d * (f.px - o.stop) / f.px, 5), toTargetPct: r(d * (o.tp - f.px) / f.px, 5), ageMin: Math.round((c.now - o.openedAt) / MIN),
          exitRule: exitRuleOf(o), stop: o.stop, be: o.be ? true : false, rPrice: r(priceR(o, f.px), 3), mfeR_price: r(x.mfeRp, 3), maeR_price: r(x.maeRp, 3),
          segHi: o.segHi ?? null, segLo: o.segLo ?? null, hiPx: o.hiPx, loPx: o.loPx, shadow3R: sh ? sh.res : undefined,
          rNote: "r/mfeR/maeR 扣费；*_price 只看价格；segHi/segLo = 上一条 TRACE 以来实时报价高低" } }, c.now);
        o.segHi = null; o.segLo = null;
      }
    }
  }
  private logShadow(tid: string, sym: string, sh: Shadow3R, o: { side: Side; fill: number; oneR: number }, qty: number | null, entryFee: number | null, actual: PostExit["actual"] | null, now: number) {
    this.safeAppend({ id: `shadow:${tid}`, k: "SHADOW_3R", t: now, sym, tid, d: { ...this.shadowView(sh, o, qty, entryFee), actual,
      kind: sh.kind ?? "3R", note: sh.res === "AMBIG" ? "同一根 15m 里影子止盈和原止损都碰到，先后分不清" : sh.kind === "2R_UNCAPPED" ? "封顶前的 2R 止盈 / 原止损先到哪个；只记录，不影响交易" : "老规则（3R 止盈 / 原止损）先到哪个；只记录，不影响交易" } }, now);
    this.extremesDirty = true;
  }
  private floatingFvg(o: FvgOpen, q: Quote, t: Trade) {
    const px = o.side === "LONG" ? q.bestBid : q.bestAsk, d = dirOf(o.side);
    const gross = d * (px - t.entryPrice) * t.quantity, net = gross - t.entryFee - px * t.quantity * 0.0007;
    return { px, pct: d * (px / o.fill - 1), r: o.oneR > 0 ? net / o.oneR : 0, net };
  }
  /** 出场后 +30/+60/+120 分钟的价格、120 分钟内最有利/最不利（每笔出场都记，止盈出场也记）。
   *  只用已有数据：实时报价（出场后 125 分钟内该币常驻）+ 已取的 15m K 线（报价缺失时用包含该时刻那根 15m 的收盘价，标 src=15m）。 */
  private samplePost(c: { now: number; quotes: Record<string, Quote> }) {
    if (!this.s.post.length) return;
    const marks = this.cfg.log.postExitMarksMin, win = Math.max(...marks, 0) * MIN, keep: PostExit[] = [];
    for (const p of this.s.post) {
      const q = c.quotes[p.sym], d = dirOf(p.side), bars = this.data[p.sym]?.bars["15m"] ?? [];
      p.best120 ??= 0; p.worst120 ??= 0; p.barT ??= 0;
      const mv = (px: number) => d * (px / p.exitPx - 1);
      const before = [p.best, p.worst, p.best120, p.worst120, p.done.length, p.shadow?.res ?? null].join("|");
      const mid = q && q.fresh ? (q.bestBid + q.bestAsk) / 2 : null;
      if (mid != null) {
        const m = mv(mid); if (m > p.best) p.best = m; if (m < p.worst) p.worst = m;
        if (c.now - p.exitAt <= win) { if (m > p.best120) p.best120 = m; if (m < p.worst120) p.worst120 = m; }
        if (p.shadow && !p.shadow.res) { const ex = p.side === "LONG" ? q!.bestBid : q!.bestAsk; if (stepShadow(p.shadow, p.side, ex, ex, c.now, "quote_after_exit")) this.postShadowDone(p, c.now); }
      }
      for (const b of bars) {
        const st = b.time * 1000;
        if (st + 15 * MIN > c.now) continue;
        if (st >= p.exitAt && st > p.barT && st + 15 * MIN <= p.exitAt + win) {
          const fav = mv(d > 0 ? b.high : b.low), adv = mv(d > 0 ? b.low : b.high);
          if (fav > p.best120) p.best120 = fav; if (adv < p.worst120) p.worst120 = adv; if (fav > p.best) p.best = fav; if (adv < p.worst) p.worst = adv;
          p.barT = st;
        }
        if (p.shadow && !p.shadow.res && st > p.shadow.barT) {
          p.shadow.barT = st;
          if (stepShadow(p.shadow, p.side, b.high, b.low, st, "15m")) this.postShadowDone(p, c.now);
        }
      }
      for (const m of marks) {
        const at = p.exitAt + m * MIN;
        if (p.done.includes(m) || c.now < at) continue;
        let px: number | null = null, src = "";
        if (mid != null && c.now - at <= 2 * MIN) { px = mid; src = "quote"; }
        else {
          const b = bars.find(x => x.time * 1000 <= at && at < x.time * 1000 + 15 * MIN && x.time * 1000 + 15 * MIN <= c.now);
          if (b) { px = b.close; src = "15m_close(含该时刻那根 15m 的收盘价，近似)"; }
          else if (c.now - at < 3 * HOUR) continue; // 等 K 线
          else src = "无数据";
        }
        p.done.push(m);
        this.safeAppend({ id: `post:${p.tid}:${m}`, k: "POST_EXIT", t: c.now, sym: p.sym, tid: p.tid, d: { afterMin: m, px, src, movePct: px == null ? null : r(mv(px), 5),
          bestPct: r(p.best, 5), worstPct: r(p.worst, 5), best120Pct: r(p.best120, 5), worst120Pct: r(p.worst120, 5), exitPx: p.exitPx, exitAt: p.exitAt, exitRule: p.exitRule ?? null,
          best120R_price: p.fill && p.stop0 && p.fill !== p.stop0 ? r(p.best120 * p.exitPx / Math.abs(p.fill - p.stop0), 3) : null, actual: p.actual ?? null,
          note: "movePct/bestPct > 0 = 出场后价格继续朝原持仓有利方向走（相对出场价）；best120 = 出场后 120 分钟内最有利" } }, c.now);
      }
      if ([p.best, p.worst, p.best120, p.worst120, p.done.length, p.shadow?.res ?? null].join("|") !== before) this.extremesDirty = true;
      const marksOpen = p.done.length < marks.length && c.now - p.exitAt < 6 * HOUR;
      let shadowOpen = !!(p.shadow && !p.shadow.res);
      if (shadowOpen && c.now - p.exitAt >= 48 * HOUR) {
        this.safeAppend({ id: `shadow:${p.tid}`, k: "SHADOW_3R", t: c.now, sym: p.sym, tid: p.tid, d: { res: "UNRESOLVED_48H", tp3: p.shadow!.tp3, stop0: p.shadow!.stop0, actual: p.actual ?? null,
          note: "出场后 48 小时内 3R 和原止损都没碰到" } }, c.now);
        shadowOpen = false; this.extremesDirty = true;
      }
      if (marksOpen || shadowOpen) keep.push(p);
    }
    this.s.post = keep;
  }
  private postShadowDone(p: PostExit, now: number) {
    if (!p.shadow || p.fill == null) return;
    this.logShadow(p.tid, p.sym, p.shadow, { side: p.side, fill: p.fill, oneR: p.oneR ?? 0 }, p.qty ?? null, p.entryFee ?? null, p.actual ?? null, now);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 面板数据
  // ---------------------------------------------------------------------------------------------------------------
  fvgStatus(now: number, forward: ForwardState | null, quotes: Record<string, Quote>) {
    const f = this.cfg.fvg, coins = this.desk.coinView(now);
    const positions = this.fvgOpens.map(o => {
      const t = forward?.positions.find(x => x.id === o.tid && x.status === "OPEN"), q = quotes[o.sym], fl = t && q && q.fresh ? this.floatingFvg(o, q, t) : null;
      const x = this.extremes(o);
      return { tid: o.tid, sym: o.sym, side: o.side, case: o.case, openedAt: o.openedAt, entry: o.fill, plannedEntry: o.plannedEntry, fillMode: o.fillMode, stop: o.stop, tp: o.tp,
        price: fl?.px ?? null, floatingR: fl ? r(fl.r, 2) : null, floatingNet: fl ? r(fl.net, 2) : null, oneR: r(o.oneR, 2), margin: t ? r(t.margin, 2) : null, liq: t?.liquidationPrice ?? null,
        leverage: t?.leverage ?? null, marginMode: t?.marginModel === "fvg-isolated-v1" ? "逐仓" : "全仓(旧单)", notional: t ? r(t.notional, 2) : null,
        exitRule: exitRuleOf(o), tpR: o.tpR ?? f.rr, stop0: stop0Of(o), be: o.be ?? null, floatingRp: fl ? r(priceR(o, fl.px), 2) : null,
        mfeR: r(o.mfeR, 2), maeR: r(o.maeR, 2), mfeRp: r(x.mfeRp, 2), maeRp: r(x.maeRp, 2) };
    });
    const ready = coins.filter(c => this.desk.dataHealth(c.sym, now).ok).length;
    const count = (st: string) => coins.filter(c => c.stage === st).length;
    // 账户保证金：已用 = 所有持仓的保证金（逐仓单按逐仓保证金），可用 = 余额 − 已用（与开仓检查同一口径）
    const open = forward?.positions.filter(x => x.status === "OPEN") ?? [], used = open.reduce((n, x) => n + (Number(x.margin) || 0), 0);
    const account = forward ? { balance: r(forward.balance, 2), marginUsed: r(used, 2), available: r(Math.max(0, forward.balance - used), 2) } : null;
    return { name: "FVG扫流动性系统", universe: this.desk.universeList, universeAt: this.desk.universeAt || null, ready, coins, positions, account,
      stages: { 等价格进入4H缺口: count("等价格进入4H缺口"), 等15m扫流动性: count("等15m扫流动性"), 等回踩15m缺口: count("等回踩15m缺口"), 持仓中: count("持仓中"), 数据预热: count("数据预热") },
      resident: this.residentSymbols(), plan: this.desk.fetchPlan(),
      rules: { universeMax: f.universeMax, rr: f.rr, tpR: f.tpR, beAtR: f.beAtR, exitRule: "2R_BE1R", expiryBars: f.expiryBars, stop: "扫点外 1 tick", firstMarginPct: this.cfg.firstMarginPct, leverage: this.cfg.leverage, reentryTolPct: f.reentryTolPct },
      legacyOpen: this.s.open ? { tid: this.s.open.tid, sym: this.s.open.sym, side: this.s.open.side, stage: this.s.open.stage, note: "切换前的旧 SMC 单，按原规则管到平仓" } : null };
  }
  status(now: number, forward: ForwardState | null, quotes: Record<string, Quote>, extra: { enabled: boolean; logError: string | null; lastFlushAt: number }) {
    const bk = forward ? this.breaker(now, forward.balance) : null;
    const o = this.s.open, t = o && forward ? forward.positions.find(x => x.id === o.tid && x.status === "OPEN") : undefined, q = o ? quotes[o.sym] : undefined;
    const fl = o && t && q && q.fresh ? this.floating(o, q, t) : null;
    const health: Record<string, ReturnType<NtsEngine["dataHealth"]>> = {};
    for (const sym of this.symbols) health[sym] = this.dataHealth(sym, now);
    const fvg = this.isFvg ? this.fvgStatus(now, forward, quotes) : null;
    const allOk = this.isFvg ? (fvg!.ready > 0) : this.symbols.every(s => health[s]!.ok);
    const quoteOk = this.isFvg ? this.fvgOpens.every(x => quotes[x.sym]?.fresh) : this.symbols.every(s => quotes[s]?.fresh);
    const held = !!o || this.fvgOpens.length > 0;
    const state = !extra.enabled && !held ? "已关闭" : !this.isFvg && bk && !bk.allowEntry ? "今日停开（当日亏损达 1R）" : !allOk ? "数据预热/异常" : !quoteOk ? "行情不新鲜"
      : held ? (this.isFvg ? `持仓中（${this.fvgOpens.length + (o ? 1 : 0)} 笔）` : "持仓中") : "空仓待命";
    const per = (x: Period) => ({ trades: x.trades, wins: x.wins, pnl: r(x.pnl, 2), r: r(x.r, 2), startEquity: r(x.startEquity, 2), pct: x.startEquity > 0 ? r(x.pnl / x.startEquity, 4) : null });
    return {
      version: NTS_VERSION, strategy: this.cfg.strategy, engineName: this.isFvg ? "FVG扫流动性系统" : this.cfg.strategy === "DAILY" ? "每日短线" : "SMC订单块", enabled: extra.enabled, state, now, paperOnly: true, liveTouched: false,
      symbols: this.symbols, evals: this.isFvg ? {} : this.s.lastEval, fvg,
      prices: Object.fromEntries(this.symbols.map(sym => { const x = quotes[sym]; return [sym, x && x.fresh ? r((x.bestBid + x.bestAsk) / 2, 4) : null]; })),
      position: o ? { tid: o.tid, sym: o.sym, side: o.side, openedAt: o.openedAt, entry: o.entry1, price: q && q.fresh ? (o.side === "LONG" ? q.bestBid : q.bestAsk) : null, avg: o.avg, added: o.addedAt != null, stage: o.stage, target: o.target, stop: o.stop,
        breakeven: o.addedAt ? o.geo.breakeven : null, tolerance: null, plannedAdd: o.plannedAdd, zone: o.zone, mode: o.mode, floatingR: fl ? r(fl.r, 2) : null, floatingPct: fl ? r(fl.pct, 4) : null, floatingNet: fl ? r(fl.net, 2) : null,
        mfeR: r(o.mfeR, 2), maeR: r(o.maeR, 2), oneR: r(o.oneR, 2), daily: o.daily ? { trail: o.daily.trail, exitAt: o.daily.exitAt, ret24: o.daily.ret24 } : null } : null,
      today: per(this.s.day), month: per(this.s.month), recent: this.s.recent, lastExit: this.s.lastExit,
      breaker: this.isFvg ? null : bk, data: { health, quoteOk, rest: { perHour: this.restWindow.length, total: this.restRequests, fails: this.restFails, lastError: this.lastFetchError, lastAt: this.lastFetchAt || null,
        capPerSec: this.cfg.data.restPerSec } },
      log: { appended: this.log.appended, pending: this.log.pending, lastFlushAt: extra.lastFlushAt || null, error: extra.logError }, decisionError: this.lastDecisionError,
    };
  }
}
/** 现价附近（±6%）仍有效、已离开过的订单块，按距离排序。 */
export type FvgStatus = ReturnType<NtsEngine["fvgStatus"]>;
function nearObs(view: SmcView, px: number, n: number) {
  return view.obs.filter(z => z.leftT != null && Math.abs((z.lo + z.hi) / 2 / px - 1) < 0.06)
    .sort((a, b) => Math.abs((a.lo + a.hi) / 2 - px) - Math.abs((b.lo + b.hi) / 2 - px)).slice(0, n);
}
export { DEFAULT_NTS_CONFIG };
