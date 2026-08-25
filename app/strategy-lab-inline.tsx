"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

type TradeRecord = {
  id: string;
  simulationModel: string;
  symbol: string;
  status: "holding" | "closed";
  side: "LONG" | "SHORT";
  confidence: number;
  regime: string;
  entryAt: number;
  entryPrice: number;
  currentStopPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  leverage: number;
  marginUsdt: number;
  contractNotionalUsdt: number;
  unrealizedNetPct: number;
  unrealizedNetUsdt: number;
  progressR: number;
  exitAt: number | null;
  exitPrice: number | null;
  exitCode: string | null;
  exitReason: string | null;
  netMovePct: number | null;
  netPnlUsdt: number | null;
};

type HistoryPayload = { observedAt: number; trades: TradeRecord[] };
type BackgroundStatus = {
  active: boolean;
  scanCadenceSeconds: number | null;
  deepBatchSize: number | null;
  scanner: {
    state: "starting" | "live" | "paused" | "degraded" | "error";
    lastRunAt: number | null;
    lastSuccessAt: number | null;
    lastError: string | null;
    analyzed?: number;
    symbols?: string[];
  } | null;
  error?: string;
};

function pct(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function pf(value: number | null | undefined) {
  if (value == null) return "∞/未形成亏损样本";
  return Number.isFinite(value) ? value.toFixed(2) : "--";
}

function price(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "--";
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 5 });
  return value.toPrecision(6);
}

function dateTime(value: number | null | undefined) {
  if (!value) return "--";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function strategyLabel(model: string) {
  if (model === "contract_v2") return "Sentinel Baseline V1";
  if (model === "shadow_v3:trend_pullback") return "趋势回踩";
  if (model === "shadow_v3:volatility_breakout") return "波动收缩突破";
  if (model === "shadow_v3:range_reversion") return "震荡均值回归";
  if (model === "shadow_v3:relative_strength") return "相对强弱（实验）";
  return model;
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
  const [history, setHistory] = useState<TradeRecord[]>([]);
  const [background, setBackground] = useState<BackgroundStatus | null>(null);
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
      const [dashboardResponse, historyResponse, backgroundResponse] = await Promise.all([
        fetch("/api/strategy-lab", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/strategy-lab/trades", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/background", { cache: "no-store", credentials: "same-origin" }),
      ]);
      const dashboardPayload = await dashboardResponse.json().catch(() => ({}));
      const historyPayload = await historyResponse.json().catch(() => ({}));
      const backgroundPayload = await backgroundResponse.json().catch(() => ({}));
      if (!dashboardResponse.ok) throw new Error(dashboardPayload?.error ?? `策略实验室读取失败 (${dashboardResponse.status})`);
      if (!historyResponse.ok) throw new Error(historyPayload?.error ?? `策略订单记录读取失败 (${historyResponse.status})`);
      if (!backgroundResponse.ok) throw new Error(backgroundPayload?.error ?? `后台状态读取失败 (${backgroundResponse.status})`);
      setDashboard(dashboardPayload as Dashboard);
      setHistory((historyPayload as HistoryPayload).trades ?? []);
      setBackground(backgroundPayload as BackgroundStatus);
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

  const baselineHistory = useMemo(() => history.filter((trade) => trade.simulationModel === "contract_v2"), [history]);
  const shadowHistory = useMemo(() => history.filter((trade) => trade.simulationModel.startsWith("shadow_v3:")), [history]);
  const scannerAge = background?.scanner?.lastSuccessAt ? Date.now() - background.scanner.lastSuccessAt : Number.POSITIVE_INFINITY;
  const scannerHealthy = Boolean(background?.active && background.scanner?.state === "live" && scannerAge < 150_000 && !background.scanner.lastError);

  if (!host) return null;
  return createPortal(<section aria-label="多策略影子实验室" style={{ margin: "15px 0 18px", borderTop: "1px solid rgba(151,174,193,.12)", borderBottom: "1px solid rgba(151,174,193,.12)", padding: "14px 0" }}>
    <div className="section-title"><span>策略实验室 V3</span><small>多策略 · 分市场状态 · 只做影子模拟</small></div>
    <div className={`invalid-box ${scannerHealthy ? "muted" : ""}`} style={{ marginBottom: 10 }}><div><span>{scannerHealthy ? "V3 后台扫描正常" : "V3 后台状态需要检查"}</span><strong>{background ? `${background.scanner?.state ?? "--"} · 最近成功 ${dateTime(background.scanner?.lastSuccessAt)} · 每 ${background.scanCadenceSeconds ?? "--"} 秒扫描 · 每批 ${background.deepBatchSize ?? "--"} 个深度标的` : "正在读取后台运行状态"}</strong>{background?.scanner?.lastError && <small className="danger">{background.scanner.lastError}</small>}{background?.error && <small className="danger">{background.error}</small>}</div></div>
    <div className="invalid-box muted" style={{ marginBottom: 10 }}><div><span>样本口径</span><strong>Baseline V1 的历史订单完整保留；四个 V3 新策略只统计升级上线后自己真实产生的影子单，不把旧订单伪装成新策略样本。</strong></div></div>
    <div className="invalid-box muted" style={{ marginBottom: 10 }}><div><span>实盘隔离</span><strong>四个新策略不会触发 Gate 下单。达到候选线也只会标记“候选”，必须后续人工批准才能接入实盘。</strong></div></div>
    {error && <div className="live-error"><span>{error}</span></div>}
    {dashboard ? <>
      <div style={{ display: "grid", gap: 9 }}>
        <LabCard label={`${dashboard.baseline.label}（历史样本保留）`} openCount={dashboard.baseline.openCount} stats={dashboard.baseline.stats} status="原件基线" note={`当前 contract_v2，继续作为实盘唯一信号来源 · 已读取 ${baselineHistory.length} 条近期订单记录`} />
        {dashboard.strategies.map((strategy) => <LabCard key={strategy.id} label={strategy.label} openCount={strategy.openCount} stats={strategy.stats} status={strategy.promotion.label} note={`${strategy.stats.sampleCount}/${strategy.promotion.requiredSamples} 样本 · ${strategy.stats.activeDayCount}/${strategy.promotion.requiredActiveDays} 交易日 · ${strategy.promotion.reasons[0] ?? "统计门槛已通过，仍不自动实盘"}`} />)}
      </div>

      <div className="section-title" style={{ marginTop: 14 }}><span>V3 影子交易记录</span><small>{shadowHistory.length ? `最近 ${shadowHistory.length} 笔` : "刚上线，等待第一笔真实影子信号"}</small></div>
      <div className="order-list closed-orders">{shadowHistory.length ? shadowHistory.slice(0, 40).map((trade) => <article key={trade.id} className="order-row" style={{ cursor: "default" }}>
        <span className={`signal-dot ${trade.status === "holding" ? "holding" : "closed"}`}/>
        <div>
          <strong>{strategyLabel(trade.simulationModel)} · {trade.symbol.replace("_", "")} · {trade.side} · {trade.leverage}x</strong>
          <span>入场 {price(trade.entryPrice)} · 止损 {price(trade.currentStopPrice)} · TP1 {price(trade.takeProfit1Price)} · TP2 {price(trade.takeProfit2Price)}</span>
          <span>{trade.status === "closed" ? (trade.exitReason ?? trade.exitCode ?? "规则退出") : `${trade.regime} · ${trade.progressR.toFixed(2)}R`}</span>
        </div>
        <div>
          <b className={(trade.status === "closed" ? (trade.netPnlUsdt ?? 0) : trade.unrealizedNetUsdt) >= 0 ? "good" : "danger"}>{trade.status === "closed" ? `${(trade.netPnlUsdt ?? 0) >= 0 ? "+" : ""}${(trade.netPnlUsdt ?? 0).toFixed(2)}U` : `${trade.unrealizedNetUsdt >= 0 ? "+" : ""}${trade.unrealizedNetUsdt.toFixed(2)}U`}</b>
          <small>{trade.status === "closed" ? `${pct(trade.netMovePct, 2)} · ${dateTime(trade.exitAt)}` : `${pct(trade.unrealizedNetPct, 2)} · ${dateTime(trade.entryAt)}`}</small>
        </div>
      </article>) : <p className="empty-note">V3 刚上线，目前还没有任何新策略满足完整入场条件。第一笔影子单出现后会自动记录在这里，不需要手动操作。</p>}</div>

      <p className="risk-note" style={{ marginTop: 10 }}>评价不只看胜率：同时看平均净收益、Profit Factor、最大回撤、最大连亏、最近 20 笔、有效交易日和实际交易的市场状态。趋势/突破/震荡策略至少 50 个完整样本且跨 7 个交易日；相对强弱策略要求 80 个样本且跨 10 个交易日。</p>
    </> : <p className="empty-note">策略实验室正在积累第一批影子样本…</p>}
  </section>, host);
}
