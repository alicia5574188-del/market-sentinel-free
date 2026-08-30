"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

type LiveOrderState = "submitting" | "open" | "protected" | "closing" | "closed" | "cancelled" | "rejected" | "error";

type LiveOrder = {
  id: string;
  tradeCaseId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  state: LiveOrderState;
  requestedContracts: string;
  filledContracts: string | null;
  referencePrice: number;
  fillPrice: number | null;
  stopLossPrice: number;
  takeProfitPrice: number;
  leverage: number;
  entryEquityUsdt?: number | null;
  expectedNetTp2Usdt: number;
  realizedPnlUsdt: number | null;
  failureReason: string | null;
  submittedAt: number | null;
  protectedAt: number | null;
  closedAt: number | null;
  createdAt?: number;
  updatedAt: number;
  strategyLabel?: string | null;
  strategyTrigger?: string | null;
  strategyThesis?: string | null;
  strategyExitReason?: string | null;
  strategyExitEvidence?: string[];
};

type LiveSnapshot = {
  control: {
    accountEquityLastUsdt: number | null;
    entryEnabled: boolean;
    state: "disabled" | "armed" | "risk_locked" | "emergency_stopped";
  };
  orders: LiveOrder[];
};

const ACTIVE = new Set<LiveOrderState>(["submitting", "open", "protected", "closing"]);
const PROBLEM = new Set<LiveOrderState>(["cancelled", "rejected", "error"]);
const STATE_LABEL: Record<LiveOrderState, string> = {
  submitting: "提交中",
  open: "已成交",
  protected: "交易所保护中",
  closing: "平仓中",
  closed: "已平仓",
  cancelled: "已取消",
  rejected: "未提交 / 已拒绝",
  error: "异常",
};

function usdt(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}U`;
}

function price(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "--";
  if (value >= 1_000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 5 });
  return value.toPrecision(6);
}

function dateTime(value: number | null | undefined) {
  if (!value) return "--";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function stateTone(state: LiveOrderState) {
  if (state === "protected" || state === "closed") return "good";
  if (PROBLEM.has(state)) return "danger";
  return "warn";
}

export function LiveOrdersInline() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let currentHost: HTMLElement | null = null;
    const syncHost = () => {
      const card = document.querySelector<HTMLElement>(".live-trading-card");
      if (!card) {
        if (currentHost && !currentHost.isConnected) {
          currentHost = null;
          setHost(null);
        }
        return;
      }

      card.querySelector<HTMLElement>('[data-live-orders-shortcut="true"]')?.remove();
      const legacyList = card.querySelector<HTMLElement>(".live-order-list");
      if (legacyList) {
        legacyList.style.display = "none";
        const legacyTitle = legacyList.previousElementSibling as HTMLElement | null;
        if (legacyTitle?.textContent?.includes("实盘订单账本")) legacyTitle.style.display = "none";
      }

      let target = card.querySelector<HTMLElement>('[data-inline-live-orders="true"]');
      if (!target) {
        target = document.createElement("div");
        target.dataset.inlineLiveOrders = "true";
        const statusGrid = card.querySelector<HTMLElement>(".live-status-grid");
        if (statusGrid) statusGrid.insertAdjacentElement("afterend", target);
        else card.insertAdjacentElement("afterbegin", target);
      }
      currentHost = target;
      setHost((current) => current === target ? current : target);
    };

    syncHost();
    const observer = new MutationObserver(syncHost);
    observer.observe(document.body, { subtree: true, childList: true });
    return () => {
      observer.disconnect();
      currentHost?.remove();
    };
  }, []);

  const load = useCallback(async () => {
    if (!host) return;
    setLoading(true);
    try {
      const response = await fetch("/api/live/status", { cache: "no-store", credentials: "same-origin" });
      const payload = await response.json().catch(() => ({})) as Partial<LiveSnapshot> & { error?: string };
      if (!response.ok) throw new Error(payload?.error ?? `实盘订单读取失败 (${response.status})`);
      const next = payload as LiveSnapshot;
      setSnapshot(next);
      setError(null);
      setSelectedId((current) => {
        if (current && next.orders.some((order) => order.id === current)) return current;
        return next.orders.find((order) => ACTIVE.has(order.state))?.id ?? next.orders[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "实盘订单读取失败");
    } finally {
      setLoading(false);
    }
  }, [host]);

  useEffect(() => {
    if (!host) return;
    const initialTimer = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 10_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [host, load]);

  const orders = useMemo(() => snapshot?.orders ?? [], [snapshot]);
  const active = useMemo(() => orders.filter((order) => ACTIVE.has(order.state)), [orders]);
  const closed = useMemo(() => orders.filter((order) => order.state === "closed"), [orders]);
  const problems = useMemo(() => orders.filter((order) => PROBLEM.has(order.state)), [orders]);
  const settled = useMemo(() => closed.filter((order) => order.realizedPnlUsdt != null), [closed]);
  const realized = settled.reduce((sum, order) => sum + (order.realizedPnlUsdt ?? 0), 0);
  const wins = settled.filter((order) => (order.realizedPnlUsdt ?? 0) > 0).length;
  const selected = orders.find((order) => order.id === selectedId) ?? null;

  if (!host) return null;

  return createPortal(<section aria-label="Gate 实盘订单内嵌账本" style={{ margin: "12px 0 18px", padding: "12px 0 16px", borderBottom: "1px solid rgba(151,174,193,.12)" }}>
    <div className="section-title"><span>Gate 实盘订单</span><small>真实资金 · 订单与策略解释放在一起 · 10 秒刷新</small></div>

    <div className="account-summary">
      <div><span>Gate 当前权益</span><strong>{snapshot?.control.accountEquityLastUsdt == null ? "--" : `${snapshot.control.accountEquityLastUsdt.toFixed(2)}U`}</strong><small>{snapshot?.control.entryEnabled ? "自动实盘已开启" : "自动实盘已关闭"}</small></div>
      <div><span>活动实盘</span><strong>{active.length}</strong><small>持仓 / 保护 / 平仓中</small></div>
      <div><span>已结算</span><strong>{settled.length}</strong><small>真实 Gate 成交结果</small></div>
      <div><span>真实累计盈亏</span><strong className={realized >= 0 ? "good" : "danger"}>{usdt(realized)}</strong><small>胜率 {settled.length ? `${(wins / settled.length * 100).toFixed(1)}%` : "--"}</small></div>
    </div>

    {error && <div className="live-error"><span>{error}</span><button className="text-button" onClick={() => void load()}>重试</button></div>}
    {loading && !snapshot && <p className="empty-note">正在读取 Gate 实盘订单…</p>}

    <div className="section-title"><span>实盘持仓 / 活动订单</span><small>{active.length} 笔</small></div>
    <div className="order-list">{active.length ? active.map((order) => <LiveOrderRow key={order.id} order={order} selected={selectedId === order.id} onSelect={() => setSelectedId(order.id)} />) : <p className="empty-note">当前没有 Gate 实盘持仓或活动订单。</p>}</div>

    <div className="section-title"><span>实盘已平仓订单</span><small>每单保留真实成交、盈亏与策略解释</small></div>
    <div className="order-list closed-orders">{closed.length ? closed.map((order) => <LiveOrderRow key={order.id} order={order} selected={selectedId === order.id} onSelect={() => setSelectedId(order.id)} />) : <p className="empty-note">还没有已平仓的 Gate 实盘订单。</p>}</div>

    {problems.length > 0 && <><div className="section-title"><span>未成交 / 异常记录</span><small>{problems.length} 笔</small></div><div className="order-list">{problems.map((order) => <LiveOrderRow key={order.id} order={order} selected={selectedId === order.id} onSelect={() => setSelectedId(order.id)} />)}</div></>}

    {selected ? <>
      <div className="section-title selected-order-title"><span>实盘订单详情</span><small>ID {selected.id.slice(0, 8)}</small></div>
      <LiveOrderDetail order={selected} />
    </> : !loading && <p className="empty-note">尚无 Gate 实盘订单。产生真实订单后会直接显示在这里。</p>}
  </section>, host);
}

function LiveOrderRow({ order, selected, onSelect }: { order: LiveOrder; selected: boolean; onSelect: () => void }) {
  const value = order.state === "closed" ? usdt(order.realizedPnlUsdt) : `${order.filledContracts ?? order.requestedContracts} 张`;
  return <button className={`order-row ${selected ? "selected" : ""}`} onClick={onSelect}>
    <span className={`signal-dot ${order.state === "closed" ? "closed" : PROBLEM.has(order.state) ? "blocked" : "holding"}`}/>
    <div><strong>{order.symbol.replace("_", "")} · {order.side} · {order.leverage}x</strong><span>{order.strategyLabel ?? "综合确认"} · {STATE_LABEL[order.state]} · 成交 {price(order.fillPrice ?? order.referencePrice)}</span></div>
    <div><b className={order.state === "closed" && (order.realizedPnlUsdt ?? 0) < 0 ? "danger" : order.state === "closed" ? "good" : stateTone(order.state)}>{value}</b><small>{dateTime(order.closedAt ?? order.protectedAt ?? order.submittedAt ?? order.updatedAt)}</small></div>
  </button>;
}

function LiveOrderDetail({ order }: { order: LiveOrder }) {
  return <article style={{ border: "1px solid #1b2b39", borderRadius: 14, background: "rgba(11,23,34,.72)", padding: 12 }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
      <div><strong style={{ fontSize: 16 }}>{order.symbol.replace("_", "")} · {order.side}</strong><span style={{ display: "block", marginTop: 3, color: "#8295a6", fontSize: 10 }}>{order.strategyLabel ?? "综合确认"} · Gate 真实执行 · {order.leverage}x · {order.filledContracts ?? order.requestedContracts} 张</span></div>
      <strong className={stateTone(order.state)}>{STATE_LABEL[order.state]}</strong>
    </div>
    <div className="live-status-grid">
      <div><span>策略参考价</span><strong>{price(order.referencePrice)}</strong></div>
      <div><span>真实成交价</span><strong>{price(order.fillPrice)}</strong></div>
      <div><span>止损</span><strong className="danger">{price(order.stopLossPrice)}</strong></div>
      <div><span>TP2</span><strong className="good">{price(order.takeProfitPrice)}</strong></div>
      <div><span>TP2预计净利润</span><strong>{usdt(order.expectedNetTp2Usdt)}</strong></div>
      <div><span>真实已实现盈亏</span><strong className={(order.realizedPnlUsdt ?? 0) >= 0 ? "good" : "danger"}>{order.state === "closed" ? (order.realizedPnlUsdt == null ? "待归因" : usdt(order.realizedPnlUsdt)) : "未结算"}</strong></div>
      <div><span>开仓时 Gate 权益</span><strong>{order.entryEquityUsdt == null ? "--" : `${order.entryEquityUsdt.toFixed(2)}U`}</strong></div>
      <div><span>策略订单 ID</span><strong>{order.tradeCaseId.slice(0, 8)}</strong></div>
    </div>

    {(order.strategyTrigger || order.strategyThesis) && <div style={{ marginTop: 10, border: "1px solid rgba(67,199,239,.18)", borderRadius: 12, padding: 10, background: "rgba(67,199,239,.05)" }}>
      <div className="section-title" style={{ marginTop: 0 }}><span>为什么进场</span><small>{order.strategyLabel ?? "综合确认"}</small></div>
      {order.strategyTrigger && <p style={{ margin: "5px 0", fontSize: 11, lineHeight: 1.6 }}>{order.strategyTrigger}</p>}
      {order.strategyThesis && <p style={{ margin: "5px 0 0", color: "#8295a6", fontSize: 10, lineHeight: 1.6 }}>{order.strategyThesis}</p>}
    </div>}

    {(order.strategyExitReason || (order.strategyExitEvidence?.length ?? 0) > 0) && <div style={{ marginTop: 10, borderTop: "1px solid rgba(151,174,193,.12)", paddingTop: 9 }}>
      <strong style={{ fontSize: 11 }}>为什么退出</strong>
      {order.strategyExitReason && <p style={{ margin: "5px 0", fontSize: 11 }}>{order.strategyExitReason}</p>}
      {order.strategyExitEvidence?.slice(0, 4).map((item, index) => <p key={`${index}-${item}`} style={{ margin: "3px 0", color: "#8295a6", fontSize: 10 }}>· {item}</p>)}
    </div>}

    <div className="safety-list" style={{ marginTop: 10 }}>
      <div><span><strong>提交时间</strong> {dateTime(order.submittedAt ?? order.createdAt)}</span></div>
      <div><span><strong>保护确认</strong> {dateTime(order.protectedAt)}</span></div>
      <div><span><strong>平仓时间</strong> {dateTime(order.closedAt)}</span></div>
      {order.failureReason && <div><span><strong className="danger">异常 / 拒绝原因</strong> {order.failureReason}</span></div>}
    </div>
  </article>;
}
