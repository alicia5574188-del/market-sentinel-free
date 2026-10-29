"use client";
import { useState } from "react";

/** 首页「交易系统运行情况」：只读展示 + 一个自动开仓开关 + 日志下载。数据来自 /api/home 的 nts 字段（纸面账户，不碰实盘）。 */
type Zone = { lo: number; hi: number; score: number; kind: string; tfs: string[] };
type Plan = { side: string; entry: number; stop: number; target: number; rr: number; stopPct: number; targetPct: number; trigger?: string; targetMode?: string; neutral?: boolean } | null;
type Ev = { at: number; action: string; side: string | null; reason: string; core: number | null; score: number | null; plan: Plan; zones: Zone[]; vetoes: number };
type Per = { trades: number; wins: number; pnl: number; r: number; pct: number | null };
export type NtsView = {
  ready?: boolean; enabled?: boolean; state?: string; error?: string | null; now?: number; notes?: string[];
  symbols?: string[]; evals?: Record<string, Ev>;
  position?: { sym: string; side: string; openedAt: number; avg: number; added: boolean; stage: string; target: number; stop: number; breakeven: number | null; floatingR: number | null; floatingPct: number | null; floatingNet: number | null; mfeR: number; maeR: number } | null;
  today?: Per; month?: Per; recent?: { at: number; sym: string; kind: string; text: string }[];
  lastExit?: { sym: string; side: string; at: number; reason: string; netPnl: number; r: number; holdMin: number } | null;
  breaker?: { state: string; allowEntry: boolean; reason: string; monthPct: number; dayR: number } | null;
  data?: { quoteOk?: boolean; health?: Record<string, { ok: boolean; notes: string[] }> };
  log?: { appended: number; pending: number; lastFlushAt: number | null; error: string | null };
  resetState?: { phase: string; doneAt: number | null; error: string | null };
};

const LAOS = "Asia/Vientiane";
const clock = (t?: number | null) => t ? new Date(t).toLocaleString("zh-CN", { timeZone: LAOS, hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) + "（老挝）" : "—";
const px = (n: number | null | undefined) => n == null ? "—" : n >= 1000 ? n.toFixed(1) : n.toFixed(2);
const sgn = (n: number | null | undefined, d = 2) => n == null ? "—" : (n > 0 ? "+" : "") + n.toFixed(d);
const sideZh = (s?: string | null) => s === "LONG" ? "做多" : s === "SHORT" ? "做空" : "—";
const name = (s: string) => s.replace("_USDT", "");

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
  const p = nts.position, per = (x?: Per) => x ? `${x.trades} 笔 · 赢 ${x.wins} · ${sgn(x.pnl)}U · ${sgn(x.r)}R${x.pct != null ? ` · ${sgn(x.pct * 100)}%` : ""}` : "—";
  const evs = Object.entries(nts.evals ?? {});
  const bias = evs.length ? evs.map(([s, e]) => `${name(s)} ${e.score == null ? "—" : sgn(e.score)}`).join(" · ") : "等待数据";
  const plan = evs.find(([, e]) => e.action === "ENTER")?.[1];
  return <section className="pg-card nts-panel" data-testid="nts-panel" aria-label="交易系统运行情况">
    <div className="fr-section-head"><h2>交易系统运行情况</h2>
      <span className={`nts-state ${nts.state === "持仓中" || nts.state === "空仓待命" ? "ok" : "warn"}`}>{nts.ready === false ? (nts.error ?? "启动中") : nts.state}</span></div>
    <p className="nts-note">BTC / ETH 永续 · 纸面账户 · 不下实盘单。{nts.now ? `更新 ${clock(nts.now)}` : ""}</p>
    <div className="nts-row"><span>系统开关</span><b>{enabled ? "自动开仓：开" : "自动开仓：关"}</b>
      <button type="button" className="nts-btn" disabled={busy || nts.ready === false} onClick={toggle}>{enabled ? "关闭" : "打开"}</button></div>
    {msg && <p className="nts-note">{msg}</p>}
    <div className="nts-row"><span>当前市场偏向分（−1…+1）</span><b>{bias}</b></div>
    <div className="nts-zones">{evs.map(([s, e]) => <div key={s}><h3>{name(s)} 关键支撑 / 压力</h3>
      {e.zones.length ? e.zones.slice(0, 4).map((z, i) => <div className="nts-zone" key={i}><span>{z.kind === "support" || z.kind === "SUPPORT" ? "支撑" : z.kind === "resistance" || z.kind === "RESISTANCE" ? "压力" : z.kind}</span><b>{px(z.lo)} – {px(z.hi)}</b><small>分 {z.score} · {z.tfs.join("/")}</small></div>) : <small>暂无</small>}</div>)}</div>
    <div className="nts-row"><span>当前计划 / 不做原因</span><b>{plan?.plan ? `${sideZh(plan.plan.side)} 入 ${px(plan.plan.entry)} 损 ${px(plan.plan.stop)} 目标 ${px(plan.plan.target)} R:R ${plan.plan.rr}${plan.plan.trigger === "RETEST" ? "（回踩确认）" : plan.plan.trigger === "SWEEP" ? "（扫荡收回）" : ""}${plan.plan.targetMode === "ATR" ? "·ATR目标" : ""}${plan.plan.neutral ? "·中性带半仓" : ""}` : (evs.map(([s, e]) => `${name(s)}：${e.reason}`).join("；") || "等待第一次评估")}</b></div>
    <div className="nts-row"><span>持仓 / 浮盈亏</span><b>{p ? `${name(p.sym)} ${sideZh(p.side)}${p.added ? "（已加仓）" : ""} 均价 ${px(p.avg)} · ${sgn(p.floatingR)}R（${sgn(p.floatingNet)}U）· 止损 ${px(p.stop)}${p.breakeven ? ` · 保本 ${px(p.breakeven)}` : ""}` : "空仓"}</b></div>
    <div className="nts-row"><span>今日（老挝时间）</span><b>{per(nts.today)}</b></div>
    <div className="nts-row"><span>本月</span><b>{per(nts.month)}</b></div>
    <div className="nts-row"><span>最近一次出场</span><b>{nts.lastExit ? `${clock(nts.lastExit.at)} ${name(nts.lastExit.sym)} ${sideZh(nts.lastExit.side)} ${nts.lastExit.reason} · ${sgn(nts.lastExit.r)}R · ${sgn(nts.lastExit.netPnl)}U · 持 ${nts.lastExit.holdMin} 分` : "还没有"}</b></div>
    <div className="nts-row"><span>熔断</span><b className={nts.breaker && !nts.breaker.allowEntry ? "bad" : ""}>{nts.breaker ? `${nts.breaker.state === "OK" ? "正常" : nts.breaker.state === "HALF" ? "减半仓" : "暂停开仓"} · ${nts.breaker.reason}` : "—"}</b></div>
    <div className="nts-row"><span>数据 / 行情</span><b>{nts.data ? (Object.values(nts.data.health ?? {}).every(h => h.ok) && nts.data.quoteOk ? "正常" : (nts.notes?.slice(0, 2).join("；") || "预热/异常")) : "—"}{nts.log?.error ? ` · 日志：${nts.log.error}` : ""}</b></div>
    {nts.resetState && nts.resetState.phase !== "done" && <p className="nts-note">旧日志备份/清除：{nts.resetState.phase}{nts.resetState.error ? `（${nts.resetState.error}）` : ""}，完成前暂不开新仓。</p>}
    <div className="nts-recent"><h3>最近决策</h3>{nts.recent?.length ? nts.recent.slice(0, 5).map((r, i) => <div key={i}><small>{clock(r.at)}</small> {name(r.sym)} · {r.text}</div>) : <small>暂无</small>}</div>
    <p className="nts-note"><a href="/api/nts/log" download>下载运行日志（复盘）</a> · <a href="/api/nts/log-backup" download>下载旧日志备份</a></p>
  </section>;
}
