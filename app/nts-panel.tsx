"use client";
import { useState } from "react";

/** 首页「交易系统运行情况」：只读展示 + 一个自动开仓开关 + 日志下载。数据来自 /api/home 的 nts 字段（模拟盘，不碰实盘）。
 *  所有百分比都是「价格波动 %」，不是保证金收益率（ROE）。 */
type Zone = { lo: number; hi: number; score: number; kind: string; tfs: string[] };
type Plan = { side: string; entry: number; stop: number; target: number; rr: number; stopPct: number; targetPct: number; trigger?: string; mode?: string; zone?: { tf: string; kind: string; lo: number; hi: number }; addPrice?: number | null; addAllowed?: boolean } | null;
type Ev = { at: number; action: string; side: string | null; reason: string; core: number | null; score: number | null; plan: Plan; zones: Zone[]; vetoes: number; structure?: { h4: string; highs: string; lows: string; d1: string } };
type Per = { trades: number; wins: number; pnl: number; r: number; pct: number | null };
export type NtsView = {
  version?: string;
  ready?: boolean; enabled?: boolean; strategy?: string; state?: string; error?: string | null; now?: number; notes?: string[];
  symbols?: string[]; evals?: Record<string, Ev>; prices?: Record<string, number | null>;
  position?: { sym: string; side: string; openedAt: number; entry?: number; avg: number; price?: number | null; added: boolean; stage: string; target: number; stop: number; breakeven: number | null; floatingR: number | null; floatingPct: number | null; floatingNet: number | null; mfeR: number; maeR: number; daily?: { trail: number | null; exitAt: number; ret24: number } | null } | null;
  today?: Per; month?: Per; recent?: { at: number; sym: string; kind: string; text: string }[];
  lastExit?: { sym: string; side: string; at: number; reason: string; netPnl: number; r: number; holdMin: number } | null;
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
      setLocal(!enabled); setMsg(!enabled ? "已打开：下一根 15 分钟线起生效" : "已关闭：不再新开仓，已有持仓照常管理");
    } catch (e) { setMsg("切换失败：" + (e instanceof Error ? e.message : String(e))); } finally { setBusy(false); }
  };
  const p = nts.position, evs = Object.entries(nts.evals ?? {});
  const syms = nts.symbols?.length ? nts.symbols : evs.map(([s]) => s);
  const daily = nts.strategy === "DAILY";
  const healthy = nts.ready !== false && (nts.state === "持仓中" || nts.state === "空仓待命");
  const pill = nts.ready === false ? (nts.error ?? "启动中") : !enabled && !p ? "待命 · 自动开仓已关" : healthy ? (p ? "运行中 · 持仓" : "运行中 · 等待信号") : (nts.state ?? "—");
  const pillTone = nts.ready === false ? "warn" : !enabled && !p ? "idle" : healthy ? "ok" : "warn";
  const plan = evs.find(([, e]) => e.action === "ENTER")?.[1];
  const dataOk = nts.data ? Object.values(nts.data.health ?? {}).every(h => h.ok) && !!nts.data.quoteOk : null;

  // 持仓卡：全部按价格波动 % 计（不是 ROE）
  const d = p ? (p.side === "LONG" ? 1 : -1) : 1, cur = p?.price ?? (p ? nts.prices?.[p.sym] ?? null : null);
  const move = p && cur ? d * (cur / p.avg - 1) : null;
  const toStop = p && cur ? Math.abs(p.stop / cur - 1) : null, toTp = p && cur && p.target ? Math.abs(p.target / cur - 1) : null;

  return <section className="pg-card nts-panel" data-testid="nts-panel" aria-label="交易系统运行情况">
    <header className="nts-head">
      <div><h2>交易系统运行情况</h2>
        <p className="nts-sub">{daily ? "每日短线系统" : "订单块系统"} · BTC / ETH 永续 · 模拟盘{daily ? "" : " · 不补仓"}</p></div>
      <span className={`nts-pill ${pillTone}`}><i aria-hidden="true" />{pill}</span>
    </header>

    <div className="nts-switch"><div><small>系统开关</small><b>{enabled ? "自动开仓：开" : "自动开仓：关"}</b></div>
      <button type="button" className="nts-btn" disabled={busy || nts.ready === false} onClick={toggle}>{busy ? "…" : enabled ? "关闭" : "打开"}</button></div>
    {msg && <p className="nts-note">{msg}</p>}

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

    <h3 className="nts-h3">战绩</h3>
    <div className="nts-stats"><Stat label="今日（老挝时间）" x={nts.today} /><Stat label="本月" x={nts.month} /></div>

    <dl className="nts-rows">
      <div><dt>最近一次出场</dt><dd>{nts.lastExit ? <>{clock(nts.lastExit.at)} {name(nts.lastExit.sym)} {sideZh(nts.lastExit.side)} {nts.lastExit.reason} · <span className={tone(nts.lastExit.netPnl)}>{sgn(nts.lastExit.netPnl)}U</span> · 持 {nts.lastExit.holdMin} 分</> : "还没有"}</dd></div>
      <div><dt>当日停开</dt><dd className={nts.breaker && !nts.breaker.allowEntry ? "warn" : ""}>{nts.breaker ? `${nts.breaker.allowEntry ? "正常" : "今日暂停开仓"} · ${nts.breaker.reason}` : "—"}</dd></div>
      <div><dt>数据 / 行情</dt><dd className={dataOk === false ? "warn" : ""}>{dataOk == null ? "—" : dataOk ? "正常" : (nts.notes?.slice(0, 2).join("；") || "预热/异常")}{nts.log?.error ? ` · 日志：${nts.log.error}` : ""}</dd></div>
      <div><dt>更新</dt><dd>{clock(nts.now)}</dd></div>
    </dl>
    {nts.resetState && nts.resetState.phase !== "done" && <p className="nts-note warn">旧日志备份/清除：{nts.resetState.phase}{nts.resetState.error ? `（${nts.resetState.error}）` : ""}，完成前暂不开新仓。</p>}

    <h3 className="nts-h3">最近决策</h3>
    {nts.recent?.length ? <ol className="nts-recent">{nts.recent.slice(0, 5).map((r, i) => <li key={i}>
      <time>{hm(r.at)}</time><span className={`nts-kind ${r.kind === "进场" ? "up" : r.kind === "出场" ? "info" : ""}`}>{r.kind}</span>
      <p><b>{name(r.sym)}</b> {r.text}</p></li>)}</ol> : <p className="nts-note">暂无</p>}

    <p className="nts-links"><a href="/api/nts/log" download>下载运行日志（复盘）</a><a href="/api/nts/log-backup" download>下载旧日志备份</a></p>
  </section>;
}
