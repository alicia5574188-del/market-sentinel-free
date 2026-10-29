/**
 * 新交易系统引擎（纸面账户）。纯逻辑 + 内存状态，不直接碰 Cloudflare、Gate、D1。
 * 宿主（Durable Object）负责：取数（fetchJob）、把引擎给出的动作应用到纸面账户（execute）、持久化 `serialize()` 和日志块。
 *
 * 每个 2 秒 tick：
 *   tick()   → 只读判断，返回要做的动作（开仓/补仓/平仓）。没有新 15m K 线、没有持仓时几乎零开销。
 *   execute()→ 在账户副本上套用动作，记录进场/补仓/出场日志。
 *   reconcile() → 发现被止损/强平的 NTS 单（由账户引擎平掉），补记出场日志与统计。
 * 实盘：本文件不引用任何实盘模块，下的单只进纸面账户（liveEligible=false）。
 */
import { addToPaperTrade, closePaperTrade, openPaperTrade, type Contract, type ForwardState, type Quote, type Trade } from "../forward-relations.ts";
import { DEFAULT_NTS_CONFIG, NTS_VERSION, normalizeNtsConfig, type NtsConfig } from "./config.ts";
import { breakerState, buildPacks, buildZones, computeBias, evaluateAdd, evaluateEntry, exitAction, sizingPct, stateInvalidated, volScale,
  type BiasResult, type BreakerState, type EntryDecision, type Geometry, type Packs, type Plan, type Snap, type Zone, type Bars, type AddCheck } from "./decision.ts";
import type { NtsLog, NtsRec } from "./log.ts";
import { dirOf, TF_SEC, type Bar, type Side, type Tf } from "./types.ts";
import { r } from "./indicators.ts";

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
  mfePct: number; maePct: number; mfeR: number; maeR: number; lastTraceAt: number; lastBarEval: number; stage: string; margin1: number;
};
type PostExit = { tid: string; sym: string; side: Side; exitAt: number; exitPx: number; done: number[]; best: number; worst: number };
type Period = { key: string; startEquity: number; pnl: number; trades: number; wins: number; r: number };
type LastEval = { at: number; barTime: number; action: string; side: Side | null; reason: string; core: number | null; score: number | null; plan: Plan | null;
  zones: { lo: number; hi: number; score: number; kind: string; tfs: Tf[] }[]; vetoes: number };
export type ExitSummary = { tid: string; sym: string; side: Side; at: number; reason: string; code: string; netPnl: number; r: number; holdMin: number; mfePct: number; maePct: number };
export type NtsState = {
  v: 1; version: string; open: NtsOpen | null; day: Period; month: Period; recent: Brief[]; lastExit: ExitSummary | null; post: PostExit[];
  decided: Record<string, number>; noTradeSlot: Record<string, number>; handled: string[];
  deriv: Record<string, DerivSample[]>; lastEval: Record<string, LastEval>; startedAt: number;
};
export type FetchJob = { sym: string; kind: Tf | "ticker" };
export type Action =
  | { type: "OPEN"; sym: string; decision: Extract<EntryDecision, { action: "ENTER" }>; barTime: number; snapshot: Record<string, unknown> }
  | { type: "ADD"; check: AddCheck; barTime: number }
  | { type: "CLOSE"; code: string; reason: string; stage: string };
type SymData = { bars: Partial<Record<Tf, Bar[]>>; fetchedAt: Partial<Record<Tf, number>>; failedAt: Partial<Record<Tf, number>>; fails: number; tickerAt: number; tickerFailedAt: number };

const emptyPeriod = (key: string, eq: number): Period => ({ key, startEquity: eq, pnl: 0, trades: 0, wins: 0, r: 0 });
export const freshNtsState = (now: number): NtsState => ({ v: 1, version: NTS_VERSION, open: null, day: emptyPeriod("", 0), month: emptyPeriod("", 0), recent: [], lastExit: null, post: [],
  decided: {}, noTradeSlot: {}, handled: [], deriv: {}, lastEval: {}, startedAt: now });

export class NtsEngine {
  cfg: NtsConfig;
  s: NtsState;
  data: Record<string, SymData> = {};
  private tokens: number; private tokenAt: number;
  restRequests = 0; restFails = 0; lastFetchError: string | null = null; lastFetchAt = 0;
  restWindow: number[] = [];
  lastDecisionError: string | null = null;
  log: NtsLog;
  constructor(cfg: Partial<NtsConfig> | NtsConfig | null | undefined, log: NtsLog, saved?: NtsState | null, now = Date.now()) {
    this.log = log;
    this.cfg = normalizeNtsConfig(cfg as never);
    this.s = saved && saved.v === 1 ? { ...freshNtsState(now), ...saved } : freshNtsState(now);
    this.tokens = 1; this.tokenAt = now;
    for (const sym of this.cfg.symbols) this.data[sym] = { bars: {}, fetchedAt: {}, failedAt: {}, fails: 0, tickerAt: 0, tickerFailedAt: 0 };
  }
  setConfig(cfg: Partial<NtsConfig> | NtsConfig) { this.cfg = normalizeNtsConfig(cfg as never); }
  serialize(): NtsState { return this.s; }
  get symbols() { return this.cfg.symbols as readonly string[]; }

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
    let best: { job: FetchJob; pri: number } | null = null;
    for (const sym of this.symbols) {
      const d = this.data[sym]!;
      for (const tf of ["1d", "4h", "1h", "15m"] as Tf[]) {
        const bars = d.bars[tf], last = bars?.[bars.length - 1];
        const nextClose = last ? (last.time + 2 * TF_SEC[tf]) * 1000 + 4_000 : 0;
        const due = !last || now >= nextClose;
        const retryOk = now - (d.failedAt[tf] ?? 0) >= this.backoff(d) && now - (d.fetchedAt[tf] ?? 0) >= 20_000;
        if (due && retryOk) { const pri = (!last ? 0 : 1) + (tf === "15m" ? 0 : 0.5); if (!best || pri < best.pri) best = { job: { sym, kind: tf }, pri }; }
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
  private brief(now: number, sym: string, kind: string, text: string) { this.s.recent.unshift({ at: now, sym, kind, text: text.slice(0, 200) }); if (this.s.recent.length > 14) this.s.recent.length = 14; }

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
      if (open) {
        const t = forward.positions.find(x => x.id === open.tid && x.status === "OPEN");
        const q = c.quotes[open.sym];
        if (t && q && q.fresh) {
          const px = open.side === "LONG" ? q.bestBid : q.bestAsk;
          const ex = exitAction({ side: open.side, entry: open.entry1, avg: open.avg, added: open.addedAt != null, openedAt: open.openedAt, addedAt: open.addedAt, target: open.target, geo: open.geo },
            px, now, this.stateInvalid(open), this.cfg);
          open.stage = ex.stage;
          if (ex.action === "CLOSE") { actions.push({ type: "CLOSE", code: ex.code, reason: ex.reason, stage: ex.stage }); return actions; }
          const d = this.data[open.sym], b15 = d?.bars["15m"], bt = b15?.[b15.length - 1]?.time ?? 0;
          if (!open.addedAt && bt && bt !== open.lastBarEval && this.dataHealth(open.sym, now).ok && now - (bt + 900) * 1000 < 10 * MIN) {
            const chk = this.checkAdd(open, now);
            open.lastBarEval = bt;
            if (chk?.ok) actions.push({ type: "ADD", check: chk, barTime: bt });
            else if (chk && chk.hard.H3.pass) this.logAddSkip(open, chk, bt, now);
          }
        }
        return actions;
      }
      if (!c.enabled) return actions;
      const bk = this.breaker(now, forward.balance);
      if (forward.positions.some(t => t.status === "OPEN")) return actions;
      const cands: Action[] = [];
      for (const sym of this.symbols) {
        const d = this.data[sym], b15 = d?.bars["15m"], bar = b15?.[b15.length - 1];
        if (!bar || this.s.decided[sym] === bar.time) continue;
        if (now - (bar.time + 900) * 1000 > 10 * MIN) { this.s.decided[sym] = bar.time; continue; } // 启动太晚/断线：这根错过了，不追
        const q = c.quotes[sym], health = this.dataHealth(sym, now);
        if (health.ok && !(q && q.fresh)) continue; // 等行情，最多等到上面的 10 分钟窗口
        this.s.decided[sym] = bar.time;
        const act = this.decide(sym, bar.time, now, q, c.contracts[sym], health, bk, forward.balance);
        if (act) cands.push(act);
      }
      if (cands.length) {
        cands.sort((a, b) => (b.type === "OPEN" ? b.decision.plan.rr : 0) - (a.type === "OPEN" ? a.decision.plan.rr : 0));
        actions.push(cands[0]!);
        for (const o of cands.slice(1)) if (o.type === "OPEN") this.logVetoed(o.decision, o.barTime, now, "同时有更优候选，同一时刻只持一笔");
      }
    } catch (error) { this.lastDecisionError = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160); }
    return actions;
  }

  private bars(sym: string): Bars { return this.data[sym]?.bars ?? {}; }
  private stateInvalid(o: NtsOpen) { const d1 = this.bars(o.sym)["1d"]; return !!d1 && stateInvalidated(o.side, d1); }

  private decide(sym: string, barTime: number, now: number, q: Quote | undefined, contract: Contract | undefined, health: { ok: boolean; notes: string[] }, bk: BreakerState, balance: number): Action | null {
    const bars = this.bars(sym), dv = this.derivView(sym, now);
    const mid = q ? (q.bestBid + q.bestAsk) / 2 : (bars["15m"]?.[bars["15m"]!.length - 1]?.close ?? 0);
    const snap: Snap = { symbol: sym, now, bid: q?.bestBid ?? mid, ask: q?.bestAsk ?? mid, funding: dv.funding, fundingChg: dv.fundingChg, basis: dv.basis, oiChg: dv.oiChg };
    const packs = buildPacks(bars), atr1h = packs["1h"]?.atr ?? null, nowSec = Math.floor(now / 1000);
    const zones = atr1h ? buildZones(bars, atr1h, nowSec, this.cfg) : [];
    const bias = computeBias(snap, packs, bars, this.cfg);
    const reasonData = health.ok ? "" : health.notes.join("；");
    const dataOk = health.ok && !!contract && !!q && q.fresh;
    const ctx = { zones, atr1hPct: packs["1h"]?.atrPct ?? null, sizeMult: bk.sizeMult, inEvent: this.eventWindow(now), dataOk, dataNote: reasonData || (!contract ? "合约规格未就绪" : "行情不新鲜") };
    let dec: EntryDecision = evaluateEntry(snap, bars, bias, ctx, this.cfg);
    let blockedPlan = false;
    if (dec.action === "ENTER" && !bk.allowEntry) blockedPlan = true;
    if (dec.action === "ENTER" && !bk.allowEntry) dec = { action: "NO_TRADE", side: dec.side, reason: `当日停开：${bk.reason}`, vetoes: dec.vetoes, bias };
    this.s.lastEval[sym] = { at: now, barTime, action: dec.action, side: dec.side, reason: dec.action === "ENTER" ? `计划 ${dec.side} R:R ${dec.plan.rr}` : dec.reason, core: bias.core, score: bias.score,
      plan: dec.action === "ENTER" ? dec.plan : null, vetoes: dec.vetoes.length,
      zones: zones.map(z => ({ lo: r(z.lo, 2)!, hi: r(z.hi, 2)!, score: z.score, kind: z.mid <= mid ? "支撑" : "压力", tfs: z.tfs })) };
    const snapshot = this.snapshotFor(sym, snap, packs, bias, zones, dv, bk, balance);
    if (dec.action === "ENTER") return { type: "OPEN", sym, decision: dec, barTime, snapshot };
    // 否决记录：只有"计划成形后被否决"或"收回K线已出现但量能不合格"才逐根记录（每 symbol 每 4H 至多 4 条）；
    // 其它（没有刺破 / 刺破未收回 / 收回已错过 / 破位）只按 4H 抽样一条，避免日志与写入膨胀。
    const quiet = /^最近|已错过|视为破位|尚未收回/;
    let noteworthy = blockedPlan || dec.vetoes.some(v => !quiet.test(v.reason));
    const slot = Math.floor(now / (this.cfg.log.noTradeSampleMs));
    const sampled = this.s.noTradeSlot[sym] !== slot;
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
      this.brief(now, sym, "不做", dec.reason);
    }
    return null;
  }
  private eventWindow(now: number) {
    for (const w of this.cfg.eventWindows) if (now >= w.start && now <= w.end) return w.label;
    return null;
  }
  /** All indicators for one decision point, computed once, compact. */
  private snapshotFor(sym: string, snap: Snap, packs: Packs, bias: BiasResult, zones: Zone[], dv: ReturnType<NtsEngine["derivView"]>, bk: BreakerState, balance: number) {
    return {
      bias: { core: bias.core, score: bias.score, side: bias.side, conf: bias.confidence, comps: bias.comps, aux: bias.aux, unconnected: bias.unconnected },
      zones: zones.slice(0, 6).map(z => ({ lo: r(z.lo, 2), hi: r(z.hi, 2), s: z.score, n: z.touches, tf: z.tfs, parts: z.parts })),
      ind: { "15m": packs["15m"], "1h": packs["1h"], "4h": packs["4h"], "1d": packs["1d"] },
      deriv: { funding: dv.funding, fundingChg: r(dv.fundingChg, 7), basis: r(dv.basis, 6), oiChg1h: r(dv.oiChg.h1, 5), oiChg4h: r(dv.oiChg.h4, 5), longShortRatio: "未接入" },
      px: { bid: snap.bid, ask: snap.ask }, breaker: { state: bk.state, monthPct: r(bk.monthPct, 4), dayR: r(bk.dayR, 2) }, equity: r(balance, 2),
    };
  }
  private checkAdd(o: NtsOpen, now: number): AddCheck | null {
    const sym = o.sym, bars = this.bars(sym), dv = this.derivView(sym, now), packs = buildPacks(bars), atr1h = packs["1h"]?.atr;
    if (!atr1h) return null;
    const zones = buildZones(bars, atr1h, Math.floor(now / 1000), this.cfg);
    const snap: Snap = { symbol: sym, now, bid: o.avg, ask: o.avg, funding: dv.funding, fundingChg: dv.fundingChg, basis: dv.basis, oiChg: dv.oiChg };
    const bias = computeBias(snap, packs, bars, this.cfg);
    return evaluateAdd({ side: o.side, entry: o.entry1, added: o.addedAt != null, scale: o.scale, firstZoneScore: o.zoneScore }, snap, bars, packs, bias, zones, this.eventWindow(now), this.cfg);
  }
  private logAddSkip(o: NtsOpen, chk: AddCheck, bt: number, now: number) {
    this.safeAppend({ id: `addskip:${o.tid}:${bt}`, k: "ADD_SKIP", t: now, sym: o.sym, tid: o.tid, d: { barTime: bt, reason: chk.reason, hard: chk.hard, soft: chk.soft, gPassed: chk.gPassed } }, now);
  }
  private logVetoed(dec: Extract<EntryDecision, { action: "ENTER" }>, barTime: number, now: number, why: string) {
    this.safeAppend({ id: `veto:${dec.plan.symbol}:${barTime}`, k: "NO_TRADE", t: now, sym: dec.plan.symbol, d: { barTime, reason: why, kind: "否决", plan: dec.plan } }, now);
  }
  private safeAppend(rec: NtsRec, now: number) { try { this.log.append(rec, now); } catch { /* 日志失败不影响交易 */ } }

  // ---------------------------------------------------------------------------------------------------------------
  // execute：在账户副本上执行
  // ---------------------------------------------------------------------------------------------------------------
  execute(draft: ForwardState, actions: Action[], c: { now: number; quotes: Record<string, Quote>; contracts: Record<string, Contract> }): boolean {
    let changed = false;
    for (const a of actions) {
      try {
        if (a.type === "OPEN") changed = this.doOpen(draft, a, c) || changed;
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
      stopPrice: plan.stop, targetPrice: plan.target, maintenanceRate: cfg.maintenanceRate, slippageRate: cfg.slippagePct, now, reason: `NTS ${plan.side} 区 ${r(plan.zone.lo, 1)}~${r(plan.zone.hi, 1)}` });
    if (!res.ok) { this.logVetoed(a.decision, a.barTime, now, `下单失败：${res.reason}`); this.brief(now, a.sym, "放弃", res.reason); return false; }
    const t = res.trade, oneR = cfg.maxLossPct * balance;
    const geo = { ...plan.geo, entry: t.entryPrice, avg: t.entryPrice, firstStop: plan.stop };
    this.s.open = { tid, sym: a.sym, side: plan.side, openedAt: now, entry1: t.entryPrice, addedAt: null, addPrice: null, avg: t.entryPrice, geo, target: plan.target, stop: plan.stop,
      scale: plan.scale, zoneScore: plan.zone.score, zoneKey: `${r(plan.zone.lo, 2)}`, equityAtOpen: balance, oneR, mfePct: 0, maePct: 0, mfeR: 0, maeR: 0, lastTraceAt: now,
      lastBarEval: a.barTime, stage: "未补仓", margin1: t.margin };
    this.safeAppend({ id: `entry:${tid}`, k: "ENTRY", t: now, sym: a.sym, tid, d: {
      side: plan.side, barTime: a.barTime, plan: { ...plan, geo: undefined }, planGeometry: plan.geo, vetoes: a.decision.vetoes,
      fill: { price: t.entryPrice, contracts: t.contracts, qty: t.quantity, notional: r(t.notional, 2), margin: r(t.margin, 2), fee: r(t.entryFee, 4), liq: t.liquidationPrice, leverage: t.leverage },
      sizing: { balance: r(balance, 2), firstPct: r(plan.marginFirstPct, 4), addPct: r(plan.marginAddPct, 4), oneR: r(oneR, 2), worstLossPct: r(plan.worstLossPct, 4), scale: plan.scale },
      ...a.snapshot, version: NTS_VERSION } }, now);
    this.brief(now, a.sym, "进场", `${plan.side === "LONG" ? "多" : "空"} @${r(t.entryPrice, 2)} 止损 ${r(plan.stop, 2)} 目标 ${r(plan.target, 2)} R:R ${plan.rr}`);
    return true;
  }
  private doAdd(draft: ForwardState, a: Extract<Action, { type: "ADD" }>, c: { now: number; quotes: Record<string, Quote>; contracts: Record<string, Contract> }) {
    const o = this.s.open!, t = draft.positions.find(x => x.id === o.tid && x.status === "OPEN"), q = c.quotes[o.sym], cfg = this.cfg, now = c.now;
    if (!t || !q) return false;
    const bk = this.breaker(now, draft.balance), sz = sizingPct(cfg, o.scale, bk.sizeMult);
    const d = dirOf(o.side), approxAvg = (o.entry1 * o.margin1 + (a.check.price ?? o.entry1) * draft.balance * sz.add) / (o.margin1 + draft.balance * sz.add);
    const stop = approxAvg * (1 - d * cfg.hardStopPct * o.scale);
    const res = addToPaperTrade(draft, t, { quote: q, contract: c.contracts[o.sym], marginTarget: draft.balance * sz.add, stopPrice: stop, slippageRate: cfg.slippagePct, now });
    if (!res.ok) { this.safeAppend({ id: `addskip:${o.tid}:${a.barTime}`, k: "ADD_SKIP", t: now, sym: o.sym, tid: o.tid, d: { barTime: a.barTime, reason: `下单失败：${res.reason}` } }, now); return false; }
    const avg = t.entryPrice, hardStop = avg * (1 - d * cfg.hardStopPct * o.scale);
    o.geo = { entry: o.entry1, add: res.fillPrice, avg, breakeven: avg * (1 + d * cfg.breakevenPct), tolerance: avg * (1 + d * cfg.tolerancePct), hardStop, firstStop: o.stop };
    o.avg = avg; o.addedAt = now; o.addPrice = res.fillPrice; o.stop = t.stopPrice; o.stage = "0-6h";
    this.safeAppend({ id: `add:${o.tid}`, k: "ADD", t: now, sym: o.sym, tid: o.tid, d: {
      barTime: a.barTime, price: res.fillPrice, qty: r(res.addQuantity, 6), fee: r(res.addFee, 4), avg, geo: o.geo, hard: a.check.hard, soft: a.check.soft, gPassed: a.check.gPassed,
      zone: a.check.zone ? { lo: r(a.check.zone.lo, 2), hi: r(a.check.zone.hi, 2), score: a.check.zone.score, touches: a.check.zone.touches } : null,
      liq: t.liquidationPrice, margin: r(t.margin, 2), version: NTS_VERSION } }, now);
    this.brief(now, o.sym, "补仓", `@${r(res.fillPrice, 2)} 均价 ${r(avg, 2)} 保本价 ${r(o.geo.breakeven, 2)}`);
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
      this.s.post.push({ tid: o.tid, sym: o.sym, side: o.side, exitAt, exitPx, done: [], best: 0, worst: 0 });
      if (this.s.post.length > 6) this.s.post.shift();
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
      const stopDist = d * (f.px - (o.addedAt ? o.geo.hardStop : o.stop)) / f.px, beDist = d * (o.geo.breakeven - f.px) / f.px;
      this.safeAppend({ id: `tr:${o.tid}:${slot}`, k: "TRACE", t: c.now, sym: o.sym, tid: o.tid, d: {
        px: f.px, pct: r(f.pct, 5), r: r(f.r, 3), mfePct: r(o.mfePct, 5), maePct: r(o.maePct, 5), mfeR: r(o.mfeR, 3), maeR: r(o.maeR, 3),
        toStopPct: r(stopDist, 5), toBePct: o.addedAt ? r(beDist, 5) : null, toTargetPct: o.addedAt ? null : r(d * (o.target - f.px) / f.px, 5), stage: o.stage, ageMin: Math.round((c.now - o.openedAt) / MIN) } }, c.now);
    }
  }
  private samplePost(c: { now: number; quotes: Record<string, Quote> }) {
    if (!this.s.post.length) return;
    const keep: PostExit[] = [];
    for (const p of this.s.post) {
      const q = c.quotes[p.sym]; const d = dirOf(p.side);
      if (q && q.fresh) {
        const mid = (q.bestBid + q.bestAsk) / 2, mv = d * (mid / p.exitPx - 1);
        if (mv > p.best) p.best = mv; if (mv < p.worst) p.worst = mv;
        for (const m of this.cfg.log.postExitMarksMin) {
          if (p.done.includes(m) || c.now - p.exitAt < m * MIN) continue;
          p.done.push(m);
          this.safeAppend({ id: `post:${p.tid}:${m}`, k: "POST_EXIT", t: c.now, sym: p.sym, tid: p.tid, d: { afterMin: m, px: mid, movePct: r(mv, 5), bestPct: r(p.best, 5), worstPct: r(p.worst, 5), exitPx: p.exitPx } }, c.now);
        }
      }
      if (p.done.length < this.cfg.log.postExitMarksMin.length && c.now - p.exitAt < 6 * HOUR) keep.push(p);
    }
    this.s.post = keep;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 面板数据
  // ---------------------------------------------------------------------------------------------------------------
  status(now: number, forward: ForwardState | null, quotes: Record<string, Quote>, extra: { enabled: boolean; logError: string | null; lastFlushAt: number }) {
    const bk = forward ? this.breaker(now, forward.balance) : null;
    const o = this.s.open, t = o && forward ? forward.positions.find(x => x.id === o.tid && x.status === "OPEN") : undefined, q = o ? quotes[o.sym] : undefined;
    const fl = o && t && q && q.fresh ? this.floating(o, q, t) : null;
    const health: Record<string, ReturnType<NtsEngine["dataHealth"]>> = {};
    for (const sym of this.symbols) health[sym] = this.dataHealth(sym, now);
    const allOk = this.symbols.every(s => health[s]!.ok), quoteOk = this.symbols.every(s => quotes[s]?.fresh);
    const state = !extra.enabled && !o ? "已关闭" : bk && !bk.allowEntry ? "今日停开（当日亏损达 1R）" : !allOk ? "数据预热/异常" : !quoteOk ? "行情不新鲜" : o ? "持仓中" : "空仓待命";
    const per = (x: Period) => ({ trades: x.trades, wins: x.wins, pnl: r(x.pnl, 2), r: r(x.r, 2), startEquity: r(x.startEquity, 2), pct: x.startEquity > 0 ? r(x.pnl / x.startEquity, 4) : null });
    return {
      version: NTS_VERSION, enabled: extra.enabled, state, now, paperOnly: true, liveTouched: false,
      symbols: this.symbols, evals: this.s.lastEval,
      position: o ? { tid: o.tid, sym: o.sym, side: o.side, openedAt: o.openedAt, entry: o.entry1, avg: o.avg, added: o.addedAt != null, stage: o.stage, target: o.target, stop: o.addedAt ? o.geo.hardStop : o.stop,
        breakeven: o.addedAt ? o.geo.breakeven : null, tolerance: o.addedAt ? o.geo.tolerance : null, floatingR: fl ? r(fl.r, 2) : null, floatingPct: fl ? r(fl.pct, 4) : null, floatingNet: fl ? r(fl.net, 2) : null,
        mfeR: r(o.mfeR, 2), maeR: r(o.maeR, 2), oneR: r(o.oneR, 2) } : null,
      today: per(this.s.day), month: per(this.s.month), recent: this.s.recent, lastExit: this.s.lastExit,
      breaker: bk, data: { health, quoteOk, rest: { perHour: this.restWindow.length, total: this.restRequests, fails: this.restFails, lastError: this.lastFetchError, lastAt: this.lastFetchAt || null,
        capPerSec: this.cfg.data.restPerSec } },
      log: { appended: this.log.appended, pending: this.log.pending, lastFlushAt: extra.lastFlushAt || null, error: extra.logError }, decisionError: this.lastDecisionError,
    };
  }
}
export { DEFAULT_NTS_CONFIG, volScale };
