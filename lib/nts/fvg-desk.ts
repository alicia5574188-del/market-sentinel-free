/**
 * FVG 扫流动性系统的「桌面」：多币池、取数调度、逐币形态状态、开仓/止盈判断。纯逻辑 + 内存状态（不碰网络/存储）。
 * 由 NtsEngine 持有并调用；持久化的只有 NtsState.fvg（持仓、已成交形态、已用缺口），都是进场/出场时本来就要写的那一次。
 *
 * 币池：宿主每分钟把 Gate 合约目录（已有的 10 分钟刷新、按 24h 成交额排序）传进来，取前 universeMax 个；BTC/ETH 固定在内。
 * 调度（与 0.4/s 全局 Gate 令牌桶共用，引擎自己再限 restPerSec）：
 *   4H：每根 4H 收盘后每币 1 次；15m：热币（在/近 4H 缺口 ≤ nearPct、有形态、有持仓）每根 15m 收盘 1 次，冷币每 cold15mEveryMs 1 次。
 * 形态 → 情形：a = 新形态（扫完+位移+15m 缺口，16 根内回踩限价成交）；b = 老形态没成交（过期/错过），价格回到原 15m 缺口附近、
 *   扫点没破、原 3R 止盈没到过、按现价剩余空间仍 ≥ 3R → 市价进（进场条件不变）。
 * 出场（2026-11-04 起的新单，exitRule="2R_BE1R"）：止盈 = 成交价起 2R；价格先到 +1R 时止损移到保本（入场价往盈利方向 1 tick），记 BE_MOVE。
 *   R 只看价格 = |成交价 − 原止损|。之前开的单 exitRule 缺省 = "3R"：保持原来的 3R 止盈 + 原止损，不动。
 *   每笔新单同时按路径记「影子 3R」：如果还是老规则（3R 止盈 / 原止损），先到哪个（复盘对比用，不影响交易）。
 */
import type { Contract, ForwardState, Quote } from "../forward-relations.ts";
import { closePaperTrade, openPaperTrade } from "../forward-relations.ts";
import type { NtsConfig } from "./config.ts";
import { activeZonesAt, fallbackTick, find4hZones, reentryCheck, scanSetups, zoneDistance, type FvgParams, type Setup, type Zone4h } from "./fvg.ts";
import { buildPacks } from "./decision.ts";
import { r } from "./indicators.ts";
import type { NtsRec } from "./log.ts";
import { TF_SEC, type Bar, type Side, type Tf } from "./types.ts";

const MIN = 60_000, HOUR = 3_600_000;
export type FvgCase = "a" | "b";
export type FvgStage = "等价格进入4H缺口" | "等15m扫流动性" | "等回踩15m缺口" | "持仓中" | "数据预热";
/** FVG 持仓（持久化）。 */
export type FvgOpen = {
  tid: string; sym: string; side: Side; openedAt: number; fill: number; stop: number; tp: number; oneR: number; equityAtOpen: number;
  setupId: string; case: FvgCase; zoneKeys: string[]; sweepPx: number; fvg: { lo: number; hi: number }; plannedEntry: number; fillMode: "LIMIT" | "GAP" | "MARKET_B";
  mfePct: number; maePct: number; mfeR: number; maeR: number; lastTraceAt: number;
  /** 出场规则版本：缺省 = "3R"（2026-11-04 之前开的单，原计划不动）；"2R_BE1R" = 2R 止盈 + 1R 保本。 */
  exitRule?: ExitRule;
  /** 原止损（价格 R 的分母；保本移动后 stop 会变，stop0 不变）。旧单缺省 = stop。 */
  stop0?: number; tpR?: number;
  /** 保本移动：时间、触发价、移到哪、当时 MFE（价格 R）。 */
  be?: { at: number; px: number; stop: number; mfeRp: number } | null;
  /** 价格极值（持仓以来最有利/最不利价，含 15m 高低点）；用来算价格 R，并保证重启后 MFE/MAE 不回退。 */
  hiPx?: number; loPx?: number; barT?: number;
  /** 两次 TRACE 之间行情的最高/最低（只看实时报价）。 */
  segHi?: number | null; segLo?: number | null;
  /** 影子 3R：老规则（3R 止盈 / 原止损）先到哪个。 */
  shadow?: Shadow3R;
};
export type ExitRule = "3R" | "2R_BE1R";
export type Shadow3R = { tp3: number; stop0: number; res: "TP3" | "STOP" | "AMBIG" | null; at: number | null; px: number | null; src: string | null; barT: number };
export const exitRuleOf = (o: { exitRule?: ExitRule }): ExitRule => o.exitRule ?? "3R";
export const stop0Of = (o: { stop0?: number; stop: number }) => (typeof o.stop0 === "number" && o.stop0 > 0 ? o.stop0 : o.stop);
/** 价格 R（不含手续费）：有利方向价格移动 ÷ |成交价 − 原止损|。 */
export const priceR = (o: { side: Side; fill: number; stop0?: number; stop: number }, px: number) => {
  const risk = Math.abs(o.fill - stop0Of(o)); return risk > 0 ? (o.side === "LONG" ? 1 : -1) * (px - o.fill) / risk : 0;
};
/** 影子 3R 在一段价格区间（hi/lo）上推进：两边都碰到 = AMBIG（同一根 15m 里分不清先后）。返回 true = 本次有结论。 */
export function stepShadow(sh: Shadow3R, side: Side, hi: number, lo: number, at: number, src: string): boolean {
  if (sh.res) return false;
  const long = side === "LONG", hitTp = long ? hi >= sh.tp3 : lo <= sh.tp3, hitSl = long ? lo <= sh.stop0 : hi >= sh.stop0;
  if (!hitTp && !hitSl) return false;
  sh.res = hitTp && hitSl ? "AMBIG" : hitTp ? "TP3" : "STOP"; sh.at = at; sh.px = hitTp && !hitSl ? sh.tp3 : hitSl && !hitTp ? sh.stop0 : null; sh.src = src;
  return true;
}
export type FvgState = { opens: FvgOpen[]; filled: string[]; usedZones: string[]; universe: string[] };
export const freshFvgState = (): FvgState => ({ opens: [], filled: [], usedZones: [], universe: [] });
export function normalizeFvgState(x: unknown): FvgState {
  const v = (x && typeof x === "object" ? x : {}) as Partial<FvgState>;
  return { opens: Array.isArray(v.opens) ? v.opens : [], filled: Array.isArray(v.filled) ? v.filled.slice(-300) : [],
    usedZones: Array.isArray(v.usedZones) ? v.usedZones.slice(-300) : [], universe: Array.isArray(v.universe) ? v.universe.slice(0, 40) : [] };
}
export type FvgAction =
  | { type: "OPEN_FVG"; sym: string; setup: Setup; case: FvgCase; mode: "LIMIT" | "GAP" | "MARKET_B"; why: string }
  | { type: "CLOSE_FVG"; tid: string; code: string; reason: string }
  | { type: "MOVE_STOP_FVG"; tid: string; stop: number; px: number; reason: string };
type SymBars = { bars: Partial<Record<Tf, Bar[]>>; fetchedAt: Partial<Record<Tf, number>>; failedAt: Partial<Record<Tf, number>>; fails: number };
type CoinRt = {
  zones: Zone4h[]; z4T: number; setups: Setup[]; b15T: number; zonesSig: string; init: boolean;
  logged: Set<string>; seenAbove: Set<string>; dead: Set<string>; skipped: Set<string>;
  px: number | null; dist: number; hot: boolean; stage: FvgStage; caseTag: FvgCase | null; last: string; lastAt: number;
};
export interface DeskHost {
  cfg: NtsConfig;
  data: Record<string, SymBars>;
  state(): FvgState;
  append(rec: NtsRec, now: number): void;
  brief(now: number, sym: string, kind: string, text: string): void;
  version: string;
}

export const fvgParams = (cfg: NtsConfig): FvgParams => ({ ...cfg.fvg });
const sideCn = (s: Side) => (s === "LONG" ? "多" : "空");
const lao = (sec: number) => new Date(sec * 1000 + 7 * HOUR).toISOString().slice(5, 16).replace("T", " ");

export class FvgDesk {
  rt: Record<string, CoinRt> = {};
  private universe: string[] = [];
  universeAt = 0;
  /** 掉出币池、但还有挂单/情形 b 候选的币：继续盯到形态结束。 */
  private sticky = new Set<string>();
  /** 出场后跟踪的币（只取数/报价，不参与开仓）：hot = 出场 125 分钟内（常驻实时行情 + 每根 15m 刷新）；cold = 影子 3R 还没结论（按冷币节奏取 15m）。 */
  private watchHot = new Set<string>(); private watchCold = new Set<string>();
  /** 合约价格最小变动单位（Gate order_price_round，来自已有合约目录，不新增请求）。止损 = 扫点外 1 tick。 */
  private ticks: Record<string, number> = {};
  private h: DeskHost;
  constructor(h: DeskHost) {
    this.h = h;
    const st = h.state();
    this.universe = st.universe.length ? st.universe.slice(0, h.cfg.fvg.universeMax) : [...h.cfg.symbols];
    for (const s of this.tradeSymbols()) this.ensure(s);
  }
  /** 持久化状态总是从引擎当前状态读（事务失败回滚时引擎会换掉整个状态对象）。 */
  get st(): FvgState { return this.h.state(); }
  private get cfg() { return this.h.cfg; }
  private ensure(sym: string) {
    this.h.data[sym] ??= { bars: {}, fetchedAt: {}, failedAt: {}, fails: 0, tickerAt: 0, tickerFailedAt: 0 } as SymBars;
    return (this.rt[sym] ??= { zones: [], z4T: 0, setups: [], b15T: 0, zonesSig: "", init: false, logged: new Set(), seenAbove: new Set(), dead: new Set(), skipped: new Set(),
      px: null, dist: Infinity, hot: false, stage: "数据预热", caseTag: null, last: "等数据", lastAt: 0 });
  }
  /** 币池 + 有持仓的币（币池外的持仓币也要继续取数/管理）。 */
  tradeSymbols(): string[] { return [...new Set([...this.universe, ...this.st.opens.map(o => o.sym), ...this.sticky])]; }
  /** 要取数的币 = 交易币 + 出场后跟踪的币。 */
  allSymbols(): string[] { return [...new Set([...this.tradeSymbols(), ...this.watchHot, ...this.watchCold])]; }
  /** 引擎每 tick 传入出场后还在跟踪的币（不新增请求类型：同样的 15m K 线 + 已有实时盘口）。 */
  setWatch(hot: readonly string[], cold: readonly string[]) {
    const same = (a: Set<string>, b: readonly string[]) => a.size === new Set(b).size && b.every(x => a.has(x));
    if (same(this.watchHot, hot) && same(this.watchCold, cold)) return;
    this.watchHot = new Set(hot); this.watchCold = new Set(cold.filter(x => !this.watchHot.has(x)));
    for (const s of this.allSymbols()) this.h.data[s] ??= { bars: {}, fetchedAt: {}, failedAt: {}, fails: 0, tickerAt: 0, tickerFailedAt: 0 } as SymBars;
    this.prune();
  }
  get universeList() { return this.universe; }

  /** 宿主传入按 24h 成交额排好序的合约（已有目录，不新增请求）。BTC/ETH 固定在内。 */
  setTicks(ticks: Record<string, number> | undefined) {
    if (!ticks) return;
    for (const [sym, v] of Object.entries(ticks)) {
      if (!(typeof v === "number" && v > 0 && Number.isFinite(v)) || this.ticks[sym] === v) continue;
      this.ticks[sym] = v;
      const rt = this.rt[sym]; if (rt) rt.b15T = 0; // tick 变了：下次 tick 重算形态的止损
    }
  }
  tickOf(sym: string): number | undefined { return this.ticks[sym]; }
  setUniverse(ranked: readonly string[], now: number) {
    const cap = this.cfg.fvg.universeMax;
    const clean = ranked.filter(s => typeof s === "string" && /^[A-Z0-9]+_USDT$/.test(s));
    if (!clean.length) return false;
    const next = [...new Set(["BTC_USDT", "ETH_USDT", ...clean])].slice(0, cap);
    const same = next.length === this.universe.length && next.every((s, i) => s === this.universe[i]);
    this.universeAt = now;
    if (same) return false;
    const added = next.filter(s => !this.universe.includes(s)), removed = this.universe.filter(s => !next.includes(s));
    for (const s of removed) if (this.rt[s]?.stage === "等回踩15m缺口") this.sticky.add(s);
    for (const s of next) this.sticky.delete(s);
    this.universe = next; this.st.universe = next;
    for (const s of next) this.ensure(s);
    this.prune();
    if (added.length || removed.length)
      this.h.append({ id: `uni:${now}`, k: "SYSTEM", t: now, d: { text: "币池更新（按 Gate 24h 成交额）", size: next.length, added, removed, kept: [...this.sticky], universe: next } }, now);
    return true;
  }
  private prune() {
    const keep = new Set(this.tradeSymbols()), keepData = new Set(this.allSymbols());
    for (const s of Object.keys(this.rt)) if (!keep.has(s)) delete this.rt[s];
    for (const s of Object.keys(this.h.data)) if (!keepData.has(s) && !keep.has(s) && !this.h.cfg.symbols.includes(s)) delete this.h.data[s];
  }

  // ----------------------------------------------------------------------------------------------------------------
  // 取数调度（引擎的令牌桶已经批准一个名额时才调用）
  // ----------------------------------------------------------------------------------------------------------------
  pickJob(now: number, backoff: (d: SymBars) => number): { sym: string; kind: Tf } | null {
    let best: { sym: string; kind: Tf; pri: number } | null = null;
    const list = this.allSymbols();
    list.forEach((sym, rank) => {
      const d = this.h.data[sym]; if (!d) return;
      const rt = this.rt[sym];
      const consider = (tf: Tf, pri: number) => { const p = pri + rank * 1e-4; if (!best || p < best.pri) best = { sym, kind: tf, pri: p }; };
      const ok = (tf: Tf) => now - (d.failedAt[tf] ?? 0) >= backoff(d) && now - (d.fetchedAt[tf] ?? 0) >= 20_000;
      const b4 = d.bars["4h"], l4 = b4?.[b4.length - 1];
      if ((!l4 || now >= (l4.time + 2 * TF_SEC["4h"]) * 1000 + 4_000) && ok("4h")) consider("4h", l4 ? 1.5 : 0.5);
      if (!l4) return; // 先有 4H 才知道冷热
      const b15 = d.bars["15m"], l15 = b15?.[b15.length - 1];
      const hot = !!rt?.hot || this.st.opens.some(o => o.sym === sym) || this.watchHot.has(sym);
      const closed = !l15 || now >= (l15.time + 2 * TF_SEC["15m"]) * 1000 + 4_000;
      const due = !l15 || (closed && (hot || now - (d.fetchedAt["15m"] ?? 0) >= this.cfg.fvg.cold15mEveryMs));
      if (due && ok("15m")) consider("15m", !l15 ? (hot ? 0.6 : 0.7) : hot ? 1 : 2);
    });
    return best ? { sym: (best as { sym: string }).sym, kind: (best as { kind: Tf }).kind } : null;
  }

  // ----------------------------------------------------------------------------------------------------------------
  // 逐币刷新：4H 缺口 → 15m 形态 → 日志/阶段。只在 K 线变化时重算（每 2 秒 tick 几乎零开销）。
  // ----------------------------------------------------------------------------------------------------------------
  refresh(sym: string, now: number, q: Quote | undefined) {
    const rt = this.ensure(sym), d = this.h.data[sym]!, b4 = d.bars["4h"] ?? [], b15 = d.bars["15m"] ?? [], f = this.cfg.fvg;
    const t4 = b4[b4.length - 1]?.time ?? 0, t15 = b15[b15.length - 1]?.time ?? 0;
    let changed = false;
    if (t4 !== rt.z4T && b4.length >= f.min4h) {
      rt.zones = find4hZones(b4, f.zoneLookback4h); rt.z4T = t4; changed = true;
      const nowSec = now / 1000;
      for (const z of rt.zones) {
        const live = z.invalidAt == null || z.invalidAt > nowSec;
        const key = `z:${sym}:${z.key}`;
        if (live && !rt.logged.has(key)) {
          rt.logged.add(key);
          this.h.append({ id: key, k: "SETUP", t: now, sym, d: { ev: "ZONE_4H", side: z.side, lo: z.lo, hi: z.hi, c1: z.c1, formedAt: z.formedAt,
            historical: z.formedAt * 1000 < now - 4 * HOUR, text: `4H ${z.side === "LONG" ? "多头" : "空头"}缺口 ${r(z.lo, 6)}~${r(z.hi, 6)}（${lao(z.formedAt)} 老挝形成）`, version: this.h.version } }, now);
        } else if (!live && rt.logged.has(key) && !rt.logged.has(key + ":x")) {
          rt.logged.add(key + ":x");
          this.h.append({ id: key + ":x", k: "SETUP", t: now, sym, d: { ev: "ZONE_4H_INVALID", side: z.side, lo: z.lo, hi: z.hi, invalidAt: z.invalidAt, text: "4H 收盘越过缺口远端，缺口作废" } }, now);
        }
      }
    }
    if ((t15 !== rt.b15T || changed) && b15.length >= f.min15m && rt.z4T) {
      rt.setups = scanSetups(b15, rt.zones, fvgParams(this.cfg), this.ticks[sym]); rt.b15T = t15;
      this.logSetups(sym, rt, now, b4, b15);
      rt.init = true;
    }
    const px = q && q.fresh ? (q.bestBid + q.bestAsk) / 2 : b15[b15.length - 1]?.close ?? b4[b4.length - 1]?.close ?? null;
    rt.px = px;
    const act = activeZonesAt(rt.zones, now / 1000);
    rt.dist = px == null ? Infinity : zoneDistance(act, px);
    this.stage(sym, rt, now);
  }
  /** 情形 b 的静态条件（K 线层面）：老形态没成交、扫点没破、原 TP 没到过、所属 4H 缺口仍有效。同一个形态只成交一次（不限笔数）。 */
  bEligible(sym: string, st: Setup, now: number) {
    const rt = this.rt[sym]; if (!rt) return false;
    if (st.status !== "EXPIRED" && st.status !== "TOUCHED") return false;
    if (st.brokeT != null || st.tpHitT != null || rt.dead.has(st.id)) return false;
    return this.setupOpenable(sym, st, now);
  }
  private setupOpenable(sym: string, st: Setup, now: number) {
    const rt = this.rt[sym]!; if (this.st.filled.includes(`${sym}:${st.id}`)) return false;
    const act = new Set(activeZonesAt(rt.zones, now / 1000).map(z => z.key));
    return st.zoneKeys.some(k => act.has(k));
  }
  aEligible(sym: string, st: Setup, now: number) {
    const rt = this.rt[sym]; if (!rt || st.status !== "ARMED" || rt.dead.has(st.id)) return false;
    if (st.expiresT != null && now / 1000 >= st.expiresT) return false;
    return this.setupOpenable(sym, st, now);
  }
  private stage(sym: string, rt: CoinRt, now: number) {
    this.stageOf(sym, rt, now);
    // 热币 = 持仓/有待成交形态/已扫未定/价格在缺口里或附近：15m 每根收盘都取；其余每小时取一次
    rt.hot = rt.stage === "持仓中" || rt.stage === "等回踩15m缺口" || rt.stage === "等15m扫流动性"
      || rt.dist <= this.cfg.fvg.nearPct || rt.setups.some(s => s.status === "SWEPT");
  }
  private stageOf(sym: string, rt: CoinRt, now: number) {
    const open = this.st.opens.find(o => o.sym === sym);
    if (open) { rt.stage = "持仓中"; rt.caseTag = open.case; return; }
    if (!rt.init) { rt.stage = "数据预热"; rt.caseTag = null; return; }
    if (rt.setups.some(s => this.aEligible(sym, s, now))) { rt.stage = "等回踩15m缺口"; rt.caseTag = "a"; return; }
    if (rt.setups.some(s => this.bEligible(sym, s, now))) { rt.stage = "等回踩15m缺口"; rt.caseTag = "b"; return; }
    rt.caseTag = null;
    rt.stage = rt.dist === 0 ? "等15m扫流动性" : "等价格进入4H缺口";
  }
  private logSetups(sym: string, rt: CoinRt, now: number, b4: Bar[], b15: Bar[]) {
    const first = !rt.init;
    let packs: ReturnType<typeof buildPacks> | null = null;
    const ind = () => (packs ??= buildPacks({ "15m": b15, "4h": b4 }), { "15m": packs["15m"], "4h": packs["4h"], use: "RSI/MACD 只记录，不参与决策" });
    for (const st of rt.setups) {
      const key = `st:${sym}:${st.id}:${st.status}`;
      if (rt.logged.has(key)) continue;
      rt.logged.add(key);
      // 重启/首次扫描：历史上已结束的形态不重写日志，只写还能做的（挂单中 / 情形 b 候选 / 正在等位移）
      const live = st.status === "ARMED" || st.status === "SWEPT" || this.bEligible(sym, st, now);
      if (first && !live) continue;
      const caseTag: FvgCase | null = st.status === "ARMED" ? "a" : this.bEligible(sym, st, now) ? "b" : null;
      const text = this.setupText(st, caseTag);
      this.h.append({ id: key, k: "SETUP", t: now, sym, d: {
        ev: `SETUP_${st.status}`, case: caseTag, historical: first, side: st.side, sweep: { t: st.sweepT, px: st.sweepPx, swing: st.swingPx, swingT: st.swingT },
        displacement: st.dispBars ? { bars: st.dispBars, move: r(st.dispMove, 8), atr: r(st.atr, 8), xAtr: st.atr ? r((st.dispMove ?? 0) / st.atr, 2) : null } : null,
        fvg15: st.fvg, entry: st.entry, stop: st.stop, tp3R: st.tpOrig, armedT: st.armedT, expiresT: st.expiresT, touchedT: st.touchedT, brokeT: st.brokeT, tpHitT: st.tpHitT,
        zones: st.zoneKeys, ind: st.status === "ARMED" ? ind() : undefined, text, version: this.h.version } }, now);
      if (!first && (st.status === "ARMED" || st.status === "SWEPT")) this.h.brief(now, sym, st.status === "ARMED" ? "挂单" : "扫流动性", text);
      else if (first && caseTag) this.h.brief(now, sym, caseTag === "a" ? "挂单" : "情形b", `${caseTag === "b" ? "历史形态 · " : ""}${text}`); // 启动扫历史：面板“最近决策”立刻有内容（重启时同文去重）
    }
  }
  private setupText(st: Setup, c: FvgCase | null) {
    const sd = sideCn(st.side);
    switch (st.status) {
      case "SWEPT": return `${sd} 15m 扫了 ${r(st.swingPx, 6)}（影线 ${r(st.sweepPx, 6)}），等位移`;
      case "NO_DISP": return `${sd} 扫了 ${r(st.swingPx, 6)} 但扫后 2–3 根没有朝交易方向走出新的 15m 缺口（没有位移）`;
      case "ARMED": return `${sd} 情形a 挂限价 ${r(st.entry, 6)}（15m 缺口 ${r(st.fvg!.lo, 6)}~${r(st.fvg!.hi, 6)}），止损 ${r(st.stop, 6)}，3R ${r(st.tpOrig, 6)}，${lao(st.expiresT!)} 前有效`;
      case "TOUCHED": return `${sd} 回踩到了 ${r(st.entry, 6)} 但没成交（当时没盯盘/没有实时行情）${c === "b" ? "，等回到缺口再进（情形b）" : ""}`;
      case "EXPIRED": return `${sd} ${this.cfg.fvg.expiryBars} 根没回踩，撤单${c === "b" ? "；之后回到缺口可再进（情形b）" : ""}`;
      case "INVALID": return `${sd} 先破了扫点 ${r(st.sweepPx, 6)}，撤单`;
    }
  }

  // ----------------------------------------------------------------------------------------------------------------
  // tick：止盈、挂单成交/撤单、情形 b 再入场
  // ----------------------------------------------------------------------------------------------------------------
  tick(c: { now: number; forward: ForwardState; quotes: Record<string, Quote>; enabled: boolean }): FvgAction[] {
    const out: FvgAction[] = [], { now, forward } = c, f = this.cfg.fvg;
    this.lastNow = now;
    for (const o of this.st.opens) {
      const t = forward.positions.find(x => x.id === o.tid && x.status === "OPEN"), q = c.quotes[o.sym];
      if (!t || !q || !q.fresh) continue;
      const px = o.side === "LONG" ? q.bestBid : q.bestAsk, rule = exitRuleOf(o);
      if (o.side === "LONG" ? px >= o.tp : px <= o.tp) { out.push({ type: "CLOSE_FVG", tid: o.tid, code: "TARGET", reason: `到 ${o.tpR ?? f.rr}R 止盈 ${r(o.tp, 6)}` }); continue; }
      // 2R_BE1R：价格（出场方向报价）先到 +beAtR 倍价格 R → 止损移到保本（入场价往盈利方向 beTicks 个 tick）。旧 3R 单不动。
      if (rule === "2R_BE1R" && !o.be && priceR(o, px) >= f.beAtR) {
        const tick = this.ticks[o.sym] ?? fallbackTick(o.fill), d = o.side === "LONG" ? 1 : -1; // tick 与止损同源：Gate order_price_round，没有就按价格数量级×1e-4
        let be = r(o.fill + d * f.beTicks * tick, 12) ?? o.fill;
        if (o.side === "LONG" ? be >= px : be <= px) be = o.fill; // 极端：1 tick 已越过现价，就用入场价
        out.push({ type: "MOVE_STOP_FVG", tid: o.tid, stop: be, px, reason: `价格到 +${f.beAtR}R，止损移到保本 ${r(be, 8)}（入场价${tick && be !== o.fill ? ` ${o.side === "LONG" ? "+" : "−"}${f.beTicks} tick` : ""}）` });
      }
    }
    for (const sym of this.tradeSymbols()) this.refresh(sym, now, c.quotes[sym]);
    let pruned = false;
    for (const sym of [...this.sticky]) if (this.rt[sym]?.stage !== "等回踩15m缺口" && !this.st.opens.some(o => o.sym === sym)) { this.sticky.delete(sym); pruned = true; }
    if (pruned) this.prune();
    if (!c.enabled) return out;
    const cands: (FvgAction & { type: "OPEN_FVG"; rank: number })[] = [];
    this.tradeSymbols().forEach((sym, rank) => {
      const rt = this.rt[sym], q = c.quotes[sym];
      if (!rt || !rt.init || !q || !q.fresh) return;
      const bid = q.bestBid, ask = q.bestAsk;
      const lastT = (this.h.data[sym]?.bars["15m"]?.at(-1)?.time ?? 0) + TF_SEC["15m"];
      for (const st of rt.setups) {
        if (st.entry == null || st.stop == null) continue;
        const long = st.side === "LONG";
        if (this.aEligible(sym, st, now)) {
          if (long ? bid < st.sweepPx : ask > st.sweepPx) { this.kill(sym, rt, st, now); continue; }
          if (lastT > (st.armedT ?? Infinity) || (long ? bid > st.entry : ask < st.entry)) rt.seenAbove.add(st.id);
          if (long ? ask <= st.entry : bid >= st.entry)
            cands.push({ type: "OPEN_FVG", sym, setup: st, case: "a", mode: rt.seenAbove.has(st.id) ? "LIMIT" : "GAP", why: rt.seenAbove.has(st.id) ? "回踩到 15m 缺口，限价成交" : "跳空穿过入场价，按市价成交", rank });
        } else if (this.bEligible(sym, st, now)) {
          const chk = reentryCheck(st, long ? ask : bid, f);
          if (chk.ok) cands.push({ type: "OPEN_FVG", sym, setup: st, case: "b", mode: "MARKET_B", why: chk.reason, rank });
        }
      }
    });
    if (!cands.length) return out;
    cands.sort((a, b) => (a.case === b.case ? 0 : a.case === "a" ? -1 : 1) || a.rank - b.rank || (b.setup.sweepT - a.setup.sweepT));
    // 不限笔数、同一个币也可以多笔；只去重：同一个形态（币 + 形态 id）只开一次
    const seen = new Set<string>();
    for (const cd of cands) {
      const key = `${cd.sym}:${cd.setup.id}`, rt = this.rt[cd.sym]!;
      if (seen.has(key) || rt.skipped.has(cd.setup.id) || this.st.filled.includes(key)) continue;
      seen.add(key);
      const { rank: _r, ...a } = cd; void _r;
      out.push(a);
    }
    return out;
  }
  private kill(sym: string, rt: CoinRt, st: Setup, now: number) {
    rt.dead.add(st.id);
    const key = `st:${sym}:${st.id}:INVALID`;
    if (rt.logged.has(key)) return;
    rt.logged.add(key);
    this.h.append({ id: key, k: "SETUP", t: now, sym, d: { ev: "SETUP_INVALID", live: true, side: st.side, sweepPx: st.sweepPx, entry: st.entry, text: this.setupText({ ...st, status: "INVALID" }, null) } }, now);
    this.h.brief(now, sym, "撤单", `先破了扫点 ${r(st.sweepPx, 6)}，撤单`);
  }

  // ----------------------------------------------------------------------------------------------------------------
  // execute
  // ----------------------------------------------------------------------------------------------------------------
  open(draft: ForwardState, a: Extract<FvgAction, { type: "OPEN_FVG" }>, c: { now: number; quotes: Record<string, Quote>; contracts: Record<string, Contract> }) {
    const cfg = this.cfg, f = cfg.fvg, now = c.now, st = a.setup, q = c.quotes[a.sym], long = st.side === "LONG", dir = long ? 1 : -1, rt = this.ensure(a.sym);
    const skip = (reason: string) => {
      rt.skipped.add(st.id);
      this.h.append({ id: `skip:${a.sym}:${st.id}:${a.case}`, k: "NO_TRADE", t: now, sym: a.sym, d: { case: a.case, setup: st.id, reason, entry: st.entry, stop: st.stop, mode: a.mode } }, now);
      this.h.brief(now, a.sym, "放弃", reason);
      return false;
    };
    if (!q || st.entry == null || st.stop == null || !st.fvg) return skip("下单时没有行情/形态不完整");
    const contract = c.contracts[a.sym]; if (!contract) return skip("合约规格未就绪");
    const limit = a.mode === "LIMIT";
    const quote = limit ? { ...q, bestBid: st.entry, bestAsk: st.entry } : q;
    const slip = limit ? 0 : cfg.slippagePct;
    const estFill = limit ? st.entry : long ? q.bestAsk * (1 + slip) : q.bestBid * (1 - slip);
    if (long ? estFill <= st.stop : estFill >= st.stop) return skip("成交价已在止损外");
    const lev = Math.max(1, Math.min(cfg.leverage, contract.leverageMax > 0 ? contract.leverageMax : cfg.leverage));
    const balance = draft.balance, margin = balance * cfg.firstMarginPct, notional = margin * lev;
    // 不限止损宽度（视频没有这条），最坏亏损只记录
    const stopPct = Math.abs(estFill - st.stop) / estFill, worst = notional * (stopPct + cfg.stopSlipPct + 2 * cfg.feeRate);
    const tid = `nts-${a.sym}-${st.id}${a.case === "b" ? "b" : ""}`;
    if (this.st.filled.includes(`${a.sym}:${st.id}`) || draft.positions.some(x => x.id === tid && x.status === "OPEN")) return false; // 同一形态不重复开
    // 新单：2R 止盈 + 1R 保本（exitRule 2R_BE1R）；R = |成交价 − 止损|，只看价格
    const tp0 = estFill + dir * f.tpR * Math.abs(estFill - st.stop);
    const res = openPaperTrade(draft, { id: tid, symbol: a.sym, side: st.side, quote, contract, marginTarget: margin, leverage: lev, stopPrice: st.stop, targetPrice: tp0,
      maintenanceRate: contract.maintenanceRate > 0 ? contract.maintenanceRate : cfg.maintenanceRate, slippageRate: slip, now,
      reason: `NTS FVG ${st.side} 情形${a.case} 15m缺口 ${r(st.fvg.lo, 6)}~${r(st.fvg.hi, 6)}`, multi: true });
    if (!res.ok) return skip(res.reason.startsWith("模拟盘可用保证金不足") ? `跳过：${res.reason}（不缩小仓位）` : `下单失败：${res.reason}`);
    const t = res.trade, fill = t.entryPrice, risk = Math.abs(fill - st.stop), tp = fill + dir * f.tpR * risk, tp3 = fill + dir * 3 * risk;
    (t as { armPrice: number }).armPrice = tp;
    const oneR = t.quantity * Math.abs(fill - st.stop) + t.entryFee * 2;
    this.st.opens.push({ tid, sym: a.sym, side: st.side, openedAt: now, fill, stop: st.stop, tp, oneR, equityAtOpen: balance, setupId: st.id, case: a.case, zoneKeys: st.zoneKeys,
      sweepPx: st.sweepPx, fvg: st.fvg, plannedEntry: st.entry, fillMode: a.mode, mfePct: 0, maePct: 0, mfeR: 0, maeR: 0, lastTraceAt: now,
      exitRule: "2R_BE1R", stop0: st.stop, tpR: f.tpR, be: null, hiPx: fill, loPx: fill, barT: 0, segHi: null, segLo: null,
      shadow: { tp3, stop0: st.stop, res: null, at: null, px: null, src: null, barT: 0 } });
    this.st.filled.push(`${a.sym}:${st.id}`); if (this.st.filled.length > 300) this.st.filled.splice(0, this.st.filled.length - 300);
    for (const k of st.zoneKeys) this.st.usedZones.push(`${a.sym}:${k}`); if (this.st.usedZones.length > 300) this.st.usedZones.splice(0, this.st.usedZones.length - 300);
    const d = this.h.data[a.sym], b4 = d?.bars["4h"] ?? [], b15 = d?.bars["15m"] ?? [], packs = buildPacks({ "15m": b15, "4h": b4 });
    const z = this.rt[a.sym]?.zones.filter(x => st.zoneKeys.includes(x.key)).map(x => ({ key: x.key, side: x.side, lo: x.lo, hi: x.hi, formedAt: x.formedAt })) ?? [];
    this.h.append({ id: `entry:${tid}`, k: "ENTRY", t: now, sym: a.sym, tid, d: {
      strategy: "FVG", case: a.case, fillMode: a.mode, why: a.why, side: st.side, setup: st.id,
      zone4h: z, sweep: { t: st.sweepT, px: st.sweepPx, swing: st.swingPx }, displacement: { bars: st.dispBars, move: st.dispMove, atr: st.atr }, fvg15: st.fvg,
      plan: { entry: st.entry, stop: st.stop, tp3R_orig: st.tpOrig }, fill: { price: fill, contracts: t.contracts, qty: t.quantity, notional: r(t.notional, 2), margin: r(t.margin, 2), fee: r(t.entryFee, 4), liq: t.liquidationPrice, leverage: lev },
      stop: st.stop, tp, rr: f.tpR, exitRule: "2R_BE1R", exitPlan: { tpR: f.tpR, tp, beAtR: f.beAtR, beTrigger: fill + dir * f.beAtR * risk, beTicks: f.beTicks, note: "R = |成交价 − 止损|（价格）；到 +1R 止损移到入场价往盈利方向 1 tick" },
      shadow3R: { tp3, stop0: st.stop, note: "老规则（3R 止盈/原止损）只记录不执行" }, stopPct: r(Math.abs(fill - st.stop) / fill, 5), oneR: r(oneR, 2), sizing: { balance: r(balance, 2), firstPct: cfg.firstMarginPct, worstEst: r(worst, 2), worstPct: r(worst / balance, 4), stopWidthLimit: null },
      tick: { size: this.ticks[a.sym] ?? null, source: this.ticks[a.sym] ? "gate.order_price_round" : "fallback(价格数量级×1e-4)" },
      quote: { bid: q.bestBid, ask: q.bestAsk }, ind: { "15m": packs["15m"], "4h": packs["4h"], use: "RSI/MACD 只记录，不参与决策" }, version: this.h.version } }, now);
    this.h.brief(now, a.sym, "进场", `${sideCn(st.side)} 情形${a.case}${a.mode === "LIMIT" ? " 限价" : a.mode === "GAP" ? " 跳空市价" : " 回到缺口市价"} @${r(fill, 6)} 止损 ${r(st.stop, 6)} 止盈 ${r(tp, 6)}（${f.tpR}R，+${f.beAtR}R 保本）`);
    rt.stage = "持仓中"; rt.caseTag = a.case;
    return true;
  }
  /** 保本移动：改账户持仓的止损价（账户引擎每 2 秒按 stopPrice 管止损），记 BE_MOVE。 */
  moveStop(draft: ForwardState, a: Extract<FvgAction, { type: "MOVE_STOP_FVG" }>, c: { now: number }) {
    const o = this.st.opens.find(x => x.tid === a.tid), t = o ? draft.positions.find(x => x.id === o.tid && x.status === "OPEN") : undefined;
    if (!o || !t || o.be) return false;
    const before = t.stopPrice, mfeRp = r(Math.max(priceR(o, a.px), priceR(o, o.side === "LONG" ? (o.hiPx ?? o.fill) : (o.loPx ?? o.fill))), 3) ?? 0;
    o.stop0 ??= o.stop; t.stopPrice = a.stop; o.stop = a.stop;
    o.be = { at: c.now, px: a.px, stop: a.stop, mfeRp };
    const mfePct = r(Math.max(o.mfePct, (o.side === "LONG" ? 1 : -1) * (a.px / o.fill - 1)), 5);
    this.h.append({ id: `be:${o.tid}`, k: "BE_MOVE", t: c.now, sym: o.sym, tid: o.tid, d: { strategy: "FVG", exitRule: exitRuleOf(o), side: o.side, entry: o.fill, stop0: stop0Of(o), oldStop: before, newStop: a.stop,
      px: a.px, mfePct, mfeR_price: mfeRp, mfeR_fee: r(o.mfeR, 3), tp: o.tp, ageMin: Math.round((c.now - o.openedAt) / MIN), text: a.reason, version: this.h.version } }, c.now);
    this.h.brief(c.now, o.sym, "保本", a.reason);
    return true;
  }
  close(draft: ForwardState, a: Extract<FvgAction, { type: "CLOSE_FVG" }>, c: { now: number; quotes: Record<string, Quote> }) {
    const o = this.st.opens.find(x => x.tid === a.tid), t = o ? draft.positions.find(x => x.id === o.tid && x.status === "OPEN") : undefined, q = o ? c.quotes[o.sym] : undefined;
    if (!o || !t || !q) return false;
    return closePaperTrade(draft, t, q, c.now, `NTS_${a.code}`, { nts: a.code, stage: "FVG" }, this.cfg.slippagePct) != null;
  }

  // ----------------------------------------------------------------------------------------------------------------
  // 面板 / 健康
  // ----------------------------------------------------------------------------------------------------------------
  /** 情形 b 候选里，现价离原 15m 缺口 ≤ nearPct 的（快回到入场价了，必须有实时行情才能成交）。 */
  lastNow = 0;
  bNear(sym: string, now: number) {
    const rt = this.rt[sym]; if (!rt || rt.px == null) return false;
    const px = rt.px, tol = this.cfg.fvg.nearPct;
    return rt.setups.some(st => st.fvg != null && this.bEligible(sym, st, now) && px >= st.fvg.lo * (1 - tol) && px <= st.fvg.hi * (1 + tol));
  }
  /** 需要常驻实时行情的币（Gate 实时盘口订阅，不是新的请求类型）：
   *  必须常驻（不受 maxResident 限制）：有持仓的币、有情形 a 挂单的币、情形 b 候选且价格已接近原入场区的币——否则回踩时没有报价，碰到也成交不了；
   *  其余（远离入场区的情形 b 候选 > 正在等位移）再取前 maxResident 个。总数仍受 worker 的 30 个实时盘口上限约束。 */
  residentSymbols(now = this.lastNow || Date.now()): string[] {
    const pri = (sym: string) => { const rt = this.rt[sym]; if (this.st.opens.some(o => o.sym === sym)) return 0; if (!rt) return 9;
      if (rt.setups.some(st => this.aEligible(sym, st, now))) return 1; if (this.bNear(sym, now)) return 2;
      if (rt.stage === "等回踩15m缺口") return 3; if (rt.setups.some(s => s.status === "SWEPT")) return 4; return 9; };
    const ranked = this.tradeSymbols().map((s, i) => ({ s, p: pri(s), i })).filter(x => x.p < 9).sort((a, b) => a.p - b.p || a.i - b.i);
    // 出场后 125 分钟内的币也必须常驻（出场后 +30/+60/+120 分钟的价格要用实时报价记）
    const must = [...new Set([...ranked.filter(x => x.p <= 2).map(x => x.s), ...this.watchHot])];
    return [...must, ...ranked.filter(x => x.p > 2).slice(0, this.cfg.fvg.maxResident).map(x => x.s)];
  }
  dataHealth(sym: string, now: number) {
    const d = this.h.data[sym], rt = this.rt[sym], notes: string[] = [], bars: Record<string, { n: number; ageMin: number | null }> = {};
    if (!d) return { ok: false, notes: ["未订阅"], bars };
    for (const tf of ["4h", "15m"] as Tf[]) {
      const b = d.bars[tf], last = b?.[b.length - 1], n = b?.length ?? 0, age = last ? (now / 1000 - (last.time + TF_SEC[tf])) / 60 : null;
      bars[tf] = { n, ageMin: age == null ? null : Math.round(age) };
      const min = tf === "4h" ? this.cfg.fvg.min4h : this.cfg.fvg.min15m;
      const staleMin = tf === "4h" ? 3 * 240 : rt?.hot ? 3 * 15 : this.cfg.fvg.cold15mEveryMs / MIN + 45;
      if (n < min) notes.push(`${tf} K线 ${n}/${min}`); else if (age != null && age > staleMin) notes.push(`${tf} K线过期 ${Math.round(age)}分钟`);
    }
    return { ok: notes.length === 0, notes, bars };
  }
  coinView(now: number) {
    return this.tradeSymbols().map((sym, rank) => {
      const rt = this.rt[sym], nowSec = now / 1000;
      if (!rt) return { sym, rank, stage: "数据预热" as FvgStage, case: null, zones: [], dist: null, px: null, last: "等数据", setup: null, hot: false };
      const act = activeZonesAt(rt.zones, nowSec);
      const a = rt.setups.filter(s => this.aEligible(sym, s, now)).at(-1), b = rt.setups.filter(s => this.bEligible(sym, s, now)).at(-1), sw = rt.setups.filter(s => s.status === "SWEPT").at(-1);
      const s = a ?? b ?? sw ?? null;
      const last = this.st.opens.find(o => o.sym === sym) ? "持仓中" : s ? this.setupText(s, a ? "a" : b ? "b" : null) : rt.dist === 0 ? "在 4H 缺口里，等 15m 扫流动性" : act.length ? `离最近 4H 缺口 ${(rt.dist * 100).toFixed(2)}%` : "附近没有有效 4H 缺口";
      return { sym, rank, stage: rt.stage, case: rt.caseTag, hot: rt.hot, px: rt.px, dist: Number.isFinite(rt.dist) ? r(rt.dist, 5) : null,
        zones: [...act].sort((x, y) => (rt.px == null ? 0 : zoneDistance([x], rt.px) - zoneDistance([y], rt.px))).slice(0, 3).map(z => ({ key: z.key, side: z.side, lo: z.lo, hi: z.hi, formedAt: z.formedAt, used: this.st.usedZones.includes(`${sym}:${z.key}`),
          case: this.st.usedZones.includes(`${sym}:${z.key}`) ? null : rt.setups.some(x => x.zoneKeys.includes(z.key) && x.status !== "SWEPT" && x.status !== "NO_DISP") ? "b" : "a" })),
        setup: s ? { id: s.id, side: s.side, status: s.status, entry: s.entry, stop: s.stop, tp: s.tpOrig, fvg: s.fvg, expiresT: s.expiresT } : null, last };
    });
  }
  fetchPlan() {
    const all = this.allSymbols(), hot = all.filter(s => this.rt[s]?.hot || this.st.opens.some(o => o.sym === s) || this.watchHot.has(s)).length, cold = all.length - hot;
    const perHour = all.length * (1 / 4) + hot * 4 + cold * (HOUR / this.cfg.fvg.cold15mEveryMs);
    return { universe: this.tradeSymbols().length, hot, cold, watch: this.watchHot.size + this.watchCold.size, estPerHour: r(perHour, 1) };
  }
}
