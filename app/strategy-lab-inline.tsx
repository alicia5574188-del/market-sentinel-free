"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

type Stats = {
  sampleCount: number;
  activeDayCount: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  averageNetPct: number | null;
  cumulativeNetPct: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  maxLossStreak: number;
  recentSampleCount: number;
  recentAverageNetPct: number | null;
  recentProfitFactor: number | null;
  profitableRegimeCount: number;
};

type Dashboard = {
  observedAt: number;
  note: string;
  baseline: { id: "baseline_v1"; label: string; mode: "baseline"; openCount: number; stats: Stats };
  strategies: {
    id: string;
    label: string;
    mode: "shadow";
    openCount: number;
    stats: Stats;
    promotion: { status: "collecting" | "watch" | "candidate"; label: string; eligible: boolean; requiredSamples: number; requiredActiveDays: number; reasons: string[] };
  }[];
};

function pct(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function pf(value: number | null | undefined) {
  if (value == null) return "∞/未形成亏损样本";
  return Number.isFinite(value) ? value.toFixed(2) : "--";
}

function LabCard({ label, openCount, stats, status, note }: { label: string; openCount: number; stats: Stats; status: string; note: string }) {
  return <article style={{ border: "1px solid #1b2b39", borderRadius: 14, padding: 11, background: "rgba(11,23,34,.72)" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
      <div><strong style={{ fontSize: 13 }}>{label}</strong><span style={{ display: "block", marginTop: 3, color: "#8295a6", fontSize: 9 }}>{note}</span></div>
      <span style={{ border: "1px solid rgba(67,199,239,.24)", borderRadius: 999, padding: "3px 7px", color: "#43c7ef", fontSize: 9, whiteSpace: "nowrap" }}>{status}</span>
    </div>
    <div className="live-status-grid" style={{ marginTop: 9 }}>
      <div><span>完整样本</span><strong>{stats.sampleCount}</strong></div>
      <div><span>有效交易日</span><strong>{stats.activeDayCount}</strong></div>
      <div><span>影子持仓</span><strong>{openCount}</strong></div>
      <div><span>胜率</span><strong>{stats.winRate == null ? "--" : `${(stats.winRate * 100).toFixed(1)}%`}</strong></div>
      <div><span>平均净结果</span><strong className={(stats.averageNetPct ?? 0) >= 0 ? "good" : "danger"}>{pct(stats.averageNetPct, 2)}</strong></div>
      <div><span>Profit Factor</span><strong>{pf(stats.profitFactor)}</strong></div>
      <div><span>最大回撤</span><strong className={stats.maxDrawdownPct > 8 ? "danger" : ""}>{stats.maxDrawdownPct.toFixed(2)}%</strong></div>
      <div><span>最大连亏</span><strong>{stats.maxLossStreak}</strong></div>
      <div><span>最近20笔均值</span><strong className={(stats.recentAverageNetPct ?? 0) >= 0 ? "good" : "danger"}>{pct(stats.recentAverageNetPct, 2)}</strong></div>
    </div>
  </article>;
}

export function StrategyLabInline() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    const sync = () => {
      const ledger = document.querySelector<HTMLElement>(".order-ledger");
      if (!ledger) {
        if (current && !current.isConnected) { current = null; setHost(null); }
        return;
      }
      let target = ledger.querySelector<HTMLElement>('[data-strategy-lab-inline="true"]');
      if (!target) {
        target = document.createElement("div");
        target.dataset.strategyLabInline = "true";
        const metrics = ledger.querySelector<HTMLElement>(".metric-strip");
        if (metrics) metrics.insertAdjacentElement("afterend", target);
        else ledger.append(target);
      }
      current = target;
      setHost((previous) => previous === target ? previous : target);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, childList: true });
    return () => { observer.disconnect(); current?.remove(); };
  }, []);

  const load = useCallback(async () => {
    if (!host) return;
    try {
      const response = await fetch("/api/strategy-lab", { cache: "no-store", credentials: "same-origin" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error ?? `策略实验室读取失败 (${response.status})`);
      setDashboard(payload as Dashboard);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "策略实验室读取失败");
    }
  }, [host]);

  useEffect(() => {
    if (!host) return;
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [host, load]);

  if (!host) return null;
  return createPortal(<section aria-label="多策略影子实验室" style={{ margin: "15px 0 18px", borderTop: "1px solid rgba(151,174,193,.12)", borderBottom: "1px solid rgba(151,174,193,.12)", padding: "14px 0" }}>
    <div className="section-title"><span>策略实验室 V3</span><small>多策略 · 分市场状态 · 只做影子模拟</small></div>
    <div className="invalid-box muted" style={{ marginBottom: 10 }}><div><span>实盘隔离</span><strong>四个新策略不会触发 Gate 下单。达到候选线也只会标记“候选”，必须后续人工批准才能接入实盘。</strong></div></div>
    {error && <div className="live-error"><span>{error}</span></div>}
    {dashboard ? <>
      <div style={{ display: "grid", gap: 9 }}>
        <LabCard label={dashboard.baseline.label} openCount={dashboard.baseline.openCount} stats={dashboard.baseline.stats} status="原件基线" note="当前 contract_v2，继续作为实盘唯一信号来源" />
        {dashboard.strategies.map((strategy) => <LabCard key={strategy.id} label={strategy.label} openCount={strategy.openCount} stats={strategy.stats} status={strategy.promotion.label} note={`${strategy.stats.sampleCount}/${strategy.promotion.requiredSamples} 样本 · ${strategy.stats.activeDayCount}/${strategy.promotion.requiredActiveDays} 交易日 · ${strategy.promotion.reasons[0] ?? "统计门槛已通过，仍不自动实盘"}`} />)}
      </div>
      <p className="risk-note" style={{ marginTop: 10 }}>评价不只看胜率：同时看平均净收益、Profit Factor、最大回撤、最大连亏、最近 20 笔、有效交易日和实际交易的市场状态。趋势/突破/震荡策略至少 50 个完整样本且跨 7 个交易日；相对强弱策略要求 80 个样本且跨 10 个交易日。</p>
    </> : <p className="empty-note">策略实验室正在积累第一批影子样本…</p>}
  </section>, host);
}
