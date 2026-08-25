"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type LiveOrder = {
  id: string;
  tradeCaseId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  state: "submitting" | "open" | "protected" | "closing" | "closed" | "cancelled" | "rejected" | "error";
  requestedContracts: string;
  filledContracts: string | null;
  referencePrice: number;
  fillPrice: number | null;
  stopLossPrice: number;
  takeProfitPrice: number;
  leverage: number;
  expectedNetTp2Usdt: number;
  realizedPnlUsdt: number | null;
  failureReason: string | null;
  submittedAt: number | null;
  protectedAt: number | null;
  closedAt: number | null;
  createdAt?: number;
  updatedAt: number;
};

type Snapshot = {
  observedAt: number;
  control: {
    entryEnabled: boolean;
    state: "disabled" | "armed" | "risk_locked" | "emergency_stopped";
    accountEquityLastUsdt: number | null;
    dailyRealizedPnlUsdt: number | null;
  };
  orders: LiveOrder[];
};

type Filter = "all" | "active" | "closed" | "problem";

const ACTIVE = new Set<LiveOrder["state"]>(["submitting", "open", "protected", "closing"]);
const PROBLEM = new Set<LiveOrder["state"]>(["cancelled", "rejected", "error"]);

const STATE_LABEL: Record<LiveOrder["state"], string> = {
  submitting: "提交中",
  open: "已成交",
  protected: "保护中",
  closing: "平仓中",
  closed: "已平仓",
  cancelled: "已取消",
  rejected: "已拒绝",
  error: "异常",
};

function usdt(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}U`;
}

function price(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "--";
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 5 });
  return value.toPrecision(6);
}

function time(value: number | null | undefined) {
  if (!value) return "--";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export default function LiveOrdersPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/live/status", { cache: "no-store", credentials: "same-origin" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error ?? `实盘订单读取失败 (${response.status})`);
      setSnapshot(payload as Snapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "实盘订单读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const orders = snapshot?.orders ?? [];
  const filtered = useMemo(() => orders.filter((order) => {
    if (filter === "active") return ACTIVE.has(order.state);
    if (filter === "closed") return order.state === "closed";
    if (filter === "problem") return PROBLEM.has(order.state);
    return true;
  }), [orders, filter]);

  const activeCount = orders.filter((order) => ACTIVE.has(order.state)).length;
  const closed = orders.filter((order) => order.state === "closed" && order.realizedPnlUsdt != null);
  const realized = closed.reduce((sum, order) => sum + (order.realizedPnlUsdt ?? 0), 0);
  const wins = closed.filter((order) => (order.realizedPnlUsdt ?? 0) > 0).length;
  const winRate = closed.length ? wins / closed.length * 100 : null;

  return <main style={{ minHeight: "100vh", maxWidth: 520, margin: "0 auto", padding: "calc(18px + env(safe-area-inset-top)) 14px calc(28px + env(safe-area-inset-bottom))", color: "#edf4f8" }}>
    <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
      <div>
        <div style={{ color: "#8295a6", fontSize: 11, letterSpacing: ".14em" }}>GATE USDT 永续</div>
        <h1 style={{ margin: "4px 0 2px", fontSize: 24 }}>实盘订单</h1>
        <p style={{ margin: 0, color: "#8295a6", fontSize: 12 }}>只显示 Gate 真实执行，不包含模拟订单 · 10 秒自动刷新</p>
      </div>
      <a href="/" style={{ color: "#43c7ef", textDecoration: "none", border: "1px solid #1b2b39", borderRadius: 12, padding: "9px 11px", background: "#0b1722", whiteSpace: "nowrap" }}>返回哨兵</a>
    </header>

    <section style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 9, marginBottom: 12 }}>
      <Summary label="活动实盘" value={`${activeCount}`} />
      <Summary label="已结算" value={`${closed.length}`} />
      <Summary label="真实累计盈亏" value={usdt(realized)} tone={realized > 0 ? "good" : realized < 0 ? "bad" : undefined} />
      <Summary label="实盘胜率" value={winRate == null ? "--" : `${winRate.toFixed(1)}%`} />
    </section>

    <section style={{ border: "1px solid #1b2b39", background: "linear-gradient(155deg,#0e1c29,#08131c)", borderRadius: 16, padding: 12, marginBottom: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6 }}>
        {([['all','全部'],['active','活动'],['closed','已平仓'],['problem','异常']] as [Filter,string][]).map(([key,label]) => <button key={key} onClick={() => setFilter(key)} style={{ border: `1px solid ${filter === key ? "rgba(67,199,239,.55)" : "#1b2b39"}`, background: filter === key ? "rgba(67,199,239,.12)" : "#0b1722", color: filter === key ? "#43c7ef" : "#8295a6", borderRadius: 10, padding: "8px 4px", fontWeight: 700 }}>{label}</button>)}
      </div>
    </section>

    {error && <div style={{ border: "1px solid rgba(255,110,120,.45)", background: "rgba(255,110,120,.09)", color: "#ff8b93", borderRadius: 13, padding: 12, marginBottom: 12 }}>{error}</div>}
    {loading && !snapshot ? <p style={{ color: "#8295a6", padding: 20, textAlign: "center" }}>正在读取 Gate 实盘订单…</p> : null}

    <section style={{ display: "grid", gap: 10 }}>
      {filtered.length ? filtered.map((order) => <article key={order.id} style={{ border: "1px solid #1b2b39", background: "linear-gradient(155deg,#0e1c29,#08131c)", borderRadius: 16, padding: 13 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start", marginBottom: 11 }}>
          <div><strong style={{ fontSize: 17 }}>{order.symbol.replace("_", "")} · <span style={{ color: order.side === "LONG" ? "#3ee59a" : "#ffbd4a" }}>{order.side}</span></strong><div style={{ color: "#8295a6", fontSize: 11, marginTop: 3 }}>{order.leverage}x · {order.filledContracts ?? order.requestedContracts} 张</div></div>
          <span style={{ color: order.state === "protected" || order.state === "closed" ? "#3ee59a" : PROBLEM.has(order.state) ? "#ff6e78" : "#ffbd4a", border: "1px solid #1b2b39", borderRadius: 999, padding: "4px 8px", fontSize: 11 }}>{STATE_LABEL[order.state]}</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 8 }}>
          <Metric label="成交价" value={price(order.fillPrice ?? order.referencePrice)} />
          <Metric label="真实盈亏" value={order.state === "closed" ? usdt(order.realizedPnlUsdt) : "持仓中"} tone={(order.realizedPnlUsdt ?? 0) > 0 ? "good" : (order.realizedPnlUsdt ?? 0) < 0 ? "bad" : undefined} />
          <Metric label="止损" value={price(order.stopLossPrice)} />
          <Metric label="TP2" value={price(order.takeProfitPrice)} />
          <Metric label="TP2预计净" value={usdt(order.expectedNetTp2Usdt)} />
          <Metric label="时间" value={time(order.closedAt ?? order.protectedAt ?? order.submittedAt ?? order.updatedAt)} small />
        </div>
        {order.failureReason && <p style={{ margin: "10px 0 0", color: PROBLEM.has(order.state) ? "#ff8b93" : "#8295a6", fontSize: 11, lineHeight: 1.55 }}>{order.failureReason}</p>}
      </article>) : !loading && <div style={{ color: "#8295a6", textAlign: "center", border: "1px dashed #1b2b39", borderRadius: 14, padding: 28 }}>这个分类还没有 Gate 实盘订单。</div>}
    </section>

    <button onClick={() => void load()} style={{ width: "100%", marginTop: 14, border: "1px solid rgba(67,199,239,.35)", borderRadius: 12, padding: 11, background: "rgba(67,199,239,.09)", color: "#43c7ef", fontWeight: 800 }}>立即刷新实盘订单</button>
  </main>;
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return <div style={{ border: "1px solid #1b2b39", background: "#0b1722", borderRadius: 13, padding: 11 }}><span style={{ color: "#8295a6", fontSize: 10 }}>{label}</span><strong style={{ display: "block", marginTop: 4, fontSize: 18, color: tone === "good" ? "#3ee59a" : tone === "bad" ? "#ff6e78" : "#edf4f8" }}>{value}</strong></div>;
}

function Metric({ label, value, tone, small }: { label: string; value: string; tone?: "good" | "bad"; small?: boolean }) {
  return <div style={{ borderTop: "1px solid rgba(151,174,193,.12)", paddingTop: 7, minWidth: 0 }}><span style={{ display: "block", color: "#8295a6", fontSize: 9 }}>{label}</span><strong style={{ display: "block", marginTop: 3, fontSize: small ? 10 : 13, overflow: "hidden", textOverflow: "ellipsis", color: tone === "good" ? "#3ee59a" : tone === "bad" ? "#ff6e78" : "#edf4f8" }}>{value}</strong></div>;
}
