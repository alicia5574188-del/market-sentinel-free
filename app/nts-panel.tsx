"use client";
import { useState } from "react";

/** 首页「交易系统运行情况」：只读展示 + 一个自动开仓开关 + 日志下载。数据来自 /api/home 的 nts 字段（模拟盘，不碰实盘）。
 *  所有百分比都是「价格波动 %」，不是保证金收益率（ROE）。 */
type Zone = { lo: number; hi: number; score: number; kind: string; tfs: string[] };
type Plan = { side: string; entry: number; stop: number; target: number; rr: number; stopPct: number; targetPct: number; trigger?: string; mode?: string; zone?: { tf: string; kind: string; lo: number; hi: number }; addPrice?: number | null; addAllowed?: boolean } | null;
type Ev = { at: number; action: string; side: string | null; reason: string; core: number | null; score: number | null; plan: Plan; zones: Zone[]; vetoes: number; structure?: { h4: string; highs: string; lows: string; d1: string } };
type Per = { trades: number; wins: number; pnl: number; r: number; pct: number | null };
type FvgZone = { key: string; side: string; lo: number; hi: number; formedAt: number; used: boolean; case: "a" | "b" | null };
type FvgCoin = { sym: string; rank: number; stage: string; case: "a" | "b" | null; hot: boolean; px: number | null; dist: number | null; zones: FvgZone[];
  setup: { id: string; side: string; status: string; entry: number | null; stop: number | null; tp: number | null; fvg: { lo: number; hi: number } | null; expiresT: number | null } | null; last: string };
type FvgPos = { tid: string; sym: string; side: string; case: "a" | "b"; openedAt: number; entry: number; plannedEntry: number; fillMode: string; stop: number; tp: number; price: number | null; floatingR: number | null; floatingNet: number | null; oneR: number; margin: number | null; liq?: number | null; leverage?: number | null; marginMode?: string; notional?: number | null;
  exitRule?: "3R" | "2R_BE1R" | "2R_BE1R_CAP5"; tpR?: number; stop0?: number; be?: { at: number; px: number; stop: number; mfeRp: number } | null; floatingRp?: number | null; mfeR?: number | null; maeR?: number | null; mfeRp?: number | null; maeRp?: number | null };
export type FvgView = { name: string; universe: string[]; ready: number; coins: FvgCoin[]; positions: FvgPos[]; account?: { balance: number; marginUsed: number; available: number } | null; stages: Record<string, number>; resident: string[];
  plan: { universe: number; hot: number; cold: number; estPerHour: number };
  rules: { universeMax: number; rr: number; tpR?: number; beAtR?: number; exitRule?: string; expiryBars: number; stop: string; firstMarginPct: number; leverage: number; reentryTolPct: number };
  legacyOpen: { sym: string; side: string; stage: string; note: string } | null };
export type NtsView = {
  version?: string; engineName?: string; fvg?: FvgView | null;
  ready?: boolean; enabled?: boolean; strategy?: string; state?: string; error?: string | null; now?: number; notes?: string[];
  symbols?: string[]; evals?: Record<string, Ev>; prices?: Record<string, number | null>;
  position?: { sym: string; side: string; openedAt: number; entry?: number; avg: number; price?: number | null; added: boolean; stage: string; target: number; stop: number; breakeven: number | null; floatingR: number | null; floatingPct: number | null; floatingNet: number | null; mfeR: number; maeR: number; daily?: { trail: number | null; exitAt: number; ret24: number } | null } | null;
  today?: Per; month?: Per; recent?: { at: number; sym: string; kind: string; text: string }[];
  lastExit?: { sym: string; side: string; at: number; reason: string; netPnl: number; r: number; holdMin: number; rPrice?: number | null; mfeR?: number; mfeR_price?: number | null; exitRule?: string } | null;
  breaker?: { state: string; allowEntry: boolean; reason: string; monthPct: number; dayR: number } | null;
  data?: { quoteOk?: boolean; health?: Record<string, { ok: boolean; notes: string[] }> };
  log?: { appended: number; pending: number; lastFlushAt: number | null; error: string | null };
  resetState?: { phase: string; doneAt: number | null; error: string | null };
};

const LAOS = "Asia/Vientiane";
const fmt = (t: number, o: Intl.DateTimeFormatOptions) => new Date(t).toLocaleString("zh-CN", { timeZone: LAOS, hour12: false, ...o });
const clock = (t?: number | null) => t ? fmt(t, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) + "（老挝）" : "—";
const hm = (t: number) => fmt(t, { hour: "2-digit", minute: "2-digit" });
const px = (n: number | null | undefined) => n == null ? "—" : n >= 1000 ? n.toFixed(1) : n.toFixed(2);
const sgn = (n: number | null | undefined, d = 2) => n == null ? "—" : (n > 0 ? "+" : "") + n.toFixed(d);
const pct = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(2)}%`;
const sideZh = (s?: string | null) => s === "LONG" ? "做多" : s === "SHORT" ? "做空" : "—";
const name = (s: string) => s.replace("_USDT", "");
const trendZh = (t?: string) => t === "UP" ? "上升" : t === "DOWN" ? "下降" : "无趋势";
const tone = (n: number | null | undefined) => n == null || n === 0 ? "" : n > 0 ? "up" : "down";
const zoneTone = (k: string) => /需求|支撑|DEMAND|support/i.test(k) ? "up" : /供给|压力|SUPPLY|resist/i.test(k) ? "down" : "";
const zoneZh = (k: string) => k === "support" || k === "SUPPORT" ? "支撑" : k === "resistance" || k === "RESISTANCE" ? "压力" : k === "DEMAND" ? "需求区" : k === "SUPPLY" ? "供给区" : k;
const winRate = (x?: Per) => x && x.trades ? `${Math.round(x.wins / x.trades * 100)}%` : "—";

function Stat({ label, x }: { label: string; x?: Per }) {
  return <div className="nts-stat"><small>{label}</small>
    <strong className={tone(x?.pnl)}>{x ? `${sgn(x.pnl)} U` : "—"}</strong>
    <span>{x ? `${x.trades} 笔 · 胜率 ${winRate(x)}` : "—"}</span></div>;
}

const STAGE_ORDER = ["持仓中", "等回踩15m缺口", "等15m扫流动性", "等价格进入4H缺口", "数据预热"];
const stageTone = (s: string) => s === "持仓中" ? "up" : s === "等回踩15m缺口" ? "info" : s === "等15m扫流动性" ? "warm" : "";
const caseZh = (c: "a" | "b" | null | undefined) => c === "a" ? "情形a 新形态" : c === "b" ? "情形b 回到原入场点" : null;
const dp = (n: number | null | undefined) => n == null ? "—" : n >= 1000 ? n.toFixed(1) : n >= 10 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toPrecision(4);

/** FVG 扫流动性系统：持仓、每个币的 4H 缺口、阶段、情形 a/b、最近决策。 */
function FvgBody({ nts, f }: { nts: NtsView; f: FvgView }) {
  const [all, setAll] = useState(false);
  const coins = [...f.coins].sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || (a.dist ?? 9) - (b.dist ?? 9) || a.rank - b.rank);
  const shown = all ? coins : coins.slice(0, 6);
  const ru = f.rules;
  return <>
    <h3 className="nts-h3">持仓（{f.positions.length} 笔 · 不限笔数 · 同币一笔）</h3>
    {f.account && <p className="nts-note" data-testid="fvg-margin">逐仓保证金 · 余额 {f.account.balance.toFixed(2)}U · 已用 {f.account.marginUsed.toFixed(2)}U · 可用 {f.account.available.toFixed(2)}U</p>}
    {f.positions.length ? f.positions.map(p => {
      const d = p.side === "LONG" ? 1 : -1, move = p.price ? d * (p.price / p.entry - 1) : null;
      return <div key={p.tid} className={`nts-pos ${p.side === "LONG" ? "long" : "short"}`} data-testid="fvg-pos">
        <div className="nts-pos-top"><span className="nts-side">{sideZh(p.side)}</span><b>{name(p.sym)}</b><span className="nts-tag info">{caseZh(p.case)}</span>
          <strong className={tone(p.floatingNet)}>{sgn(p.floatingNet)} U</strong></div>
        <dl className="nts-kv">
          <div><dt>进场（{p.fillMode === "LIMIT" ? "限价" : p.fillMode === "GAP" ? "跳空市价" : "回到缺口市价"}）</dt><dd>{dp(p.entry)}</dd></div>
          <div><dt>现价</dt><dd>{dp(p.price)} <em className={tone(move)}>{move == null ? "" : `${move > 0 ? "+" : ""}${(move * 100).toFixed(2)}%`}</em></dd></div>
          <div><dt>止损（扫点外）</dt><dd>{dp(p.stop)} <em>距 {pct(p.price ? Math.abs(p.stop / p.price - 1) : null)}</em></dd></div>
          <div><dt>止盈 {p.exitRule === "2R_BE1R_CAP5" ? "≤5%封顶" : `${p.tpR ?? ru.rr}R`}{p.exitRule === "2R_BE1R" || p.exitRule === "2R_BE1R_CAP5" ? (p.be ? " · 已保本" : ` · +${ru.beAtR ?? 1}R 保本`) : " · 旧单原计划"}</dt><dd>{dp(p.tp)} <em>距 {pct(p.price ? Math.abs(p.tp / p.price - 1) : null)}</em></dd></div>
        </dl>
        <p className="nts-note">{p.marginMode ?? "全仓(旧单)"} {p.leverage ?? "—"}× · 保证金 {p.margin == null ? "—" : `${p.margin.toFixed(2)}U`}{p.notional == null ? "" : ` · 名义 ${p.notional.toFixed(2)}U`} · 强平 {dp(p.liq)}</p>
        <p className="nts-note">开仓 {clock(p.openedAt)} · 1R ≈ {p.oneR.toFixed(2)}U · 浮动 价格R {p.floatingRp == null ? "—" : sgn(p.floatingRp)} / 扣费R {p.floatingR == null ? "—" : sgn(p.floatingR)} · 最有利 价格R {p.mfeRp == null ? "—" : sgn(p.mfeRp)} / 扣费R {p.mfeR == null ? "—" : sgn(p.mfeR)}{p.be ? ` · ${clock(p.be.at)} 止损移到保本 ${dp(p.be.stop)}` : ""}</p>
      </div>;
    }) : <div className="nts-empty"><b>空仓 · 等形态</b><p><span>开仓条件</span>价格在 4H 缺口里 → 15m 扫掉前低/前高 → 2–3 根强位移留下 15m 缺口 → 回踩缺口限价成交</p></div>}
    {f.legacyOpen && <p className="nts-note warn">旧订单块单 {name(f.legacyOpen.sym)} {sideZh(f.legacyOpen.side)}：{f.legacyOpen.note}（{f.legacyOpen.stage}）</p>}

    <h3 className="nts-h3">币池 {f.universe.length} 个 · 4H 缺口与阶段</h3>
    <div className="nts-stagebar" data-testid="fvg-stages">{STAGE_ORDER.filter(s => s !== "数据预热" || f.stages[s]).map(s => <span key={s} className={`nts-tag ${stageTone(s)}`}>{s} {f.stages[s] ?? 0}</span>)}</div>
    <div className="nts-mkts">{shown.map(c => <article className="nts-mkt" key={c.sym} data-testid="fvg-coin">
      <div className="nts-mkt-top"><b>{name(c.sym)}</b><span>{dp(c.px)}</span></div>
      <div className="nts-tags"><span className={`nts-tag ${stageTone(c.stage)}`}>{c.stage}</span>{caseZh(c.case) && <span className="nts-tag info">{caseZh(c.case)}</span>}
        {c.dist != null && c.dist > 0 && <span className="nts-tag">距缺口 {pct(c.dist)}</span>}</div>
      {c.zones.length ? <ul className="nts-zones">{c.zones.map(z => <li key={z.key} className={z.side === "LONG" ? "up" : "down"}>
        <span>4H {z.side === "LONG" ? "多头缺口" : "空头缺口"}</span><b>{dp(z.lo)} – {dp(z.hi)}</b>
        <small>{clock(z.formedAt * 1000)} 形成{z.used ? " · 已做过" : z.case === "b" ? " · 有过形态" : ""}</small></li>)}</ul>
        : <p className="nts-note">{c.stage === "数据预热" ? "等数据" : "暂无有效 4H 缺口"}</p>}
      <p className="nts-note"><b>最近：</b>{c.last}</p>
    </article>)}</div>
    {coins.length > 6 && <button type="button" className="nts-more" onClick={() => setAll(!all)}>{all ? "收起" : `显示全部 ${coins.length} 个币`}</button>}
    <p className="nts-note">止损 = {ru.stop}（不限止损宽度） · 止盈 = 成交价起 {ru.tpR ?? 2}R，价格到 +{ru.beAtR ?? 1}R 止损移到保本（入场价往盈利方向 1 tick；之前开的单仍按原 {ru.rr}R 计划）· 价格R = 价格移动 ÷ |成交价−止损|，扣费R = 净盈亏 ÷ 1R 金额 · 挂单 {ru.expiryBars} 根 15m 内有效 · RSI/MACD 只记录，不参与开仓。情形a = 新形态回踩成交；情形b = 老形态没成交、价格回到原入场点且剩余空间仍 ≥ {ru.rr}R。</p>
    <dl className="nts-rows">
      <div><dt>仓位与风控</dt><dd>每笔首仓 {(ru.firstMarginPct * 100).toFixed(0)}% · {ru.leverage}x 全仓 · 不补仓 · 不限笔数（同一形态只开一次）· 保证金不够记“跳过”</dd></div>
      <div><dt>取数</dt><dd>就绪 {f.ready}/{f.plan.universe} · 热币 {f.plan.hot} · 约 {Math.round(f.plan.estPerHour)} 次/小时</dd></div>
    </dl>
    {void nts}
  </>;
}

export default function NtsPanel({ nts }: { nts: NtsView | null | undefined }) {
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState<string | null>(null);
  const [local, setLocal] = useState<boolean | null>(null);
  if (!nts) return null;
  const enabled = local ?? nts.enabled ?? false;
  const toggle = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/nts/toggle", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !enabled }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
      setLocal(!enabled); setMsg(!enabled ? (nts.strategy === "FVG" ? "已打开：挂单/回到缺口时自动开仓" : "已打开：下一根 15 分钟线起生效") : "已关闭：不再新开仓，已有持仓照常管理");
    } catch (e) { setMsg("切换失败：" + (e instanceof Error ? e.message : String(e))); } finally { setBusy(false); }
  };
  const p = nts.position, evs = Object.entries(nts.evals ?? {});
  const syms = nts.symbols?.length ? nts.symbols : evs.map(([s]) => s);
  const daily = nts.strategy === "DAILY", f = nts.strategy === "FVG" && nts.fvg ? nts.fvg : null;
  const held = !!p || !!f?.positions.length;
  const healthy = nts.ready !== false && (nts.state?.startsWith("持仓中") || nts.state === "空仓待命");
  const pill = nts.ready === false ? (nts.error ?? "启动中") : !enabled && !held ? "待命 · 自动开仓已关" : healthy ? (held ? "运行中 · 持仓" : "运行中 · 等待信号") : (nts.state ?? "—");
  const pillTone = nts.ready === false ? "warn" : !enabled && !held ? "idle" : healthy ? "ok" : "warn";
  const plan = evs.find(([, e]) => e.action === "ENTER")?.[1];
  const dataOk = f ? !(nts.notes ?? []).some(n => /数据|行情|取数/.test(n)) : nts.data ? Object.values(nts.data.health ?? {}).every(h => h.ok) && !!nts.data.quoteOk : null;

  // 持仓卡：全部按价格波动 % 计（不是 ROE）
  const d = p ? (p.side === "LONG" ? 1 : -1) : 1, cur = p?.price ?? (p ? nts.prices?.[p.sym] ?? null : null);
  const move = p && cur ? d * (cur / p.avg - 1) : null;
  const toStop = p && cur ? Math.abs(p.stop / cur - 1) : null, toTp = p && cur && p.target ? Math.abs(p.target / cur - 1) : null;

  return <section className="pg-card nts-panel" data-testid="nts-panel" aria-label="交易系统运行情况">
    <header className="nts-head">
      <div><h2>交易系统运行情况</h2>
        <p className="nts-sub">{f ? `${f.name} · 动态币池 ${f.universe.length} 个永续 · 模拟盘 · 不补仓` : <>{daily ? "每日短线系统" : "订单块系统"} · BTC / ETH 永续 · 模拟盘{daily ? "" : " · 不补仓"}</>}</p></div>
      <span className={`nts-pill ${pillTone}`}><i aria-hidden="true" />{pill}</span>
    </header>

    <div className="nts-switch"><div><small>系统开关</small><b>{enabled ? "自动开仓：开" : "自动开仓：关"}</b></div>
      <button type="button" className="nts-btn" disabled={busy || nts.ready === false} onClick={toggle}>{busy ? "…" : enabled ? "关闭" : "打开"}</button></div>
    {msg && <p className="nts-note">{msg}</p>}

    {f ? <FvgBody nts={nts} f={f} /> : <>
    <h3 className="nts-h3">持仓</h3>
    {p ? <div className={`nts-pos ${p.side === "LONG" ? "long" : "short"}`}>
      <div className="nts-pos-top"><span className="nts-side">{sideZh(p.side)}</span><b>{name(p.sym)}</b>
        <strong className={tone(p.floatingNet)}>{sgn(p.floatingNet)} U</strong></div>
      <dl className="nts-kv">
        <div><dt>进场</dt><dd>{px(p.avg)}</dd></div>
        <div><dt>现价</dt><dd>{px(cur)} <em className={tone(move)}>{move == null ? "" : `${move > 0 ? "+" : ""}${(move * 100).toFixed(2)}%`}</em></dd></div>
        <div><dt>止损</dt><dd>{px(p.stop)} <em>距 {pct(toStop)}</em></dd></div>
        {daily ? <div><dt>追踪 / 到期</dt><dd>{px(p.daily?.trail)} · {p.daily ? clock(p.daily.exitAt) : "—"}</dd></div>
          : <div><dt>目标 TP1</dt><dd>{px(p.target)} <em>距 {pct(toTp)}</em></dd></div>}
      </dl>
      <p className="nts-note">开仓 {clock(p.openedAt)} · {p.stage} · 百分比为价格波动，不是保证金收益率</p>
    </div>
      : <div className="nts-empty"><b>空仓 · {daily ? "等待每日 07:00（老挝）决策" : "等待订单块回踩"}</b>
        <p><span>当前计划 / 不做原因</span>{plan?.plan
          ? `${sideZh(plan.plan.side)} 入 ${px(plan.plan.entry)} · 损 ${px(plan.plan.stop)} · TP1 ${px(plan.plan.target)} · R:R ${plan.plan.rr}（${plan.plan.mode === "COUNTER" ? "逆势" : "顺势"}${plan.plan.zone ? ` ${plan.plan.zone.tf}${plan.plan.zone.kind === "SUPPLY" ? "供给区" : "需求区"}` : ""}，${plan.plan.trigger === "DOUBLE" ? "15m 双底/双顶" : "15m 吞没"}）`
          : evs.length ? evs.map(([s, e]) => `${name(s)}：${e.reason}`).join("；") : "等待第一次评估"}</p></div>}

    <h3 className="nts-h3">市场结构与订单块</h3>
    <div className="nts-mkts">{syms.map(s => {
      const e = nts.evals?.[s], price = nts.prices?.[s] ?? null;
      return <article className="nts-mkt" key={s}>
        <div className="nts-mkt-top"><b>{name(s)}</b><span>{px(price)}</span></div>
        <div className="nts-tags">
          <span className={`nts-tag ${e?.structure?.h4 === "UP" ? "up" : e?.structure?.h4 === "DOWN" ? "down" : ""}`}>4H {trendZh(e?.structure?.h4)}{e?.structure ? ` ${e.structure.highs}/${e.structure.lows}` : ""}</span>
          <span className={`nts-tag ${tone(e?.score)}`}>市场偏向分 {e?.score == null ? "—" : sgn(e.score)}</span>
        </div>
        {e?.zones?.length ? <ul className="nts-zones">{e.zones.slice(0, 4).map((z, i) => <li key={i} className={zoneTone(z.kind)}>
          <span>{zoneZh(z.kind)}</span><b>{px(z.lo)} – {px(z.hi)}</b>
          <small>{z.tfs.join("/")}{price ? ` · 距 ${pct(Math.abs(((z.lo + z.hi) / 2) / price - 1))}` : ""}</small></li>)}</ul>
          : <p className="nts-note">{e ? "附近暂无有效订单块" : "等待数据"}</p>}
      </article>;
    })}</div>
    <p className="nts-note">市场偏向分（−1…+1）与 RSI/MACD 只记录，不参与开仓；开仓只看订单块回踩 + 15m 确认。</p>
    </>}

    <h3 className="nts-h3">战绩</h3>
    <div className="nts-stats"><Stat label="今日（老挝时间）" x={nts.today} /><Stat label="本月" x={nts.month} /></div>

    <dl className="nts-rows">
      <div><dt>最近一次出场</dt><dd>{nts.lastExit ? <>{clock(nts.lastExit.at)} {name(nts.lastExit.sym)} {sideZh(nts.lastExit.side)} {nts.lastExit.reason} · <span className={tone(nts.lastExit.netPnl)}>{sgn(nts.lastExit.netPnl)}U</span> · 持 {nts.lastExit.holdMin} 分{nts.lastExit.rPrice != null ? ` · 价格R ${sgn(nts.lastExit.rPrice)} / 扣费R ${sgn(nts.lastExit.r)}` : ""}{nts.lastExit.mfeR_price != null ? ` · 最有利 价格R ${sgn(nts.lastExit.mfeR_price)} / 扣费R ${sgn(nts.lastExit.mfeR ?? null)}` : ""}</> : "还没有"}</dd></div>
      {!f && <div><dt>当日停开</dt><dd className={nts.breaker && !nts.breaker.allowEntry ? "warn" : ""}>{nts.breaker ? `${nts.breaker.allowEntry ? "正常" : "今日暂停开仓"} · ${nts.breaker.reason}` : "—"}</dd></div>}
      <div><dt>数据 / 行情</dt><dd className={dataOk === false ? "warn" : ""}>{dataOk == null ? "—" : dataOk ? "正常" : (nts.notes?.slice(0, 2).join("；") || "预热/异常")}{nts.log?.error ? ` · 日志：${nts.log.error}` : ""}</dd></div>
      <div><dt>更新</dt><dd>{clock(nts.now)}</dd></div>
    </dl>
    {nts.resetState && nts.resetState.phase !== "done" && <p className="nts-note warn">旧日志备份/清除：{nts.resetState.phase}{nts.resetState.error ? `（${nts.resetState.error}）` : ""}，完成前暂不开新仓。</p>}

    <h3 className="nts-h3">最近决策</h3>
    {nts.recent?.length ? <ol className="nts-recent">{nts.recent.slice(0, 5).map((r, i) => <li key={i}>
      <time>{hm(r.at)}</time><span className={`nts-kind ${r.kind === "进场" ? "up" : r.kind === "出场" || r.kind === "挂单" || r.kind === "情形b" ? "info" : ""}`}>{r.kind}</span>
      <p><b>{name(r.sym)}</b> {r.text}</p></li>)}</ol> : <p className="nts-note">暂无</p>}

    <p className="nts-links"><a href="/api/nts/log" download>下载运行日志（复盘）</a><a href="/api/nts/log-backup" download>下载旧日志备份</a></p>
  </section>;
}
