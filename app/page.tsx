"use client";

import { useEffect, useState } from "react";
import { runtimeReady } from "../lib/runtime-health.ts";

type Zone = { price: number; score: number; source: "BOOK" | "STOP_POOL" | "LIQUIDATION" };
type Decision = { marketState: "BREAKOUT" | "REVERSAL" | "RANGE"; side: "LONG" | "SHORT"; entryTrigger: number; invalidation: number; target: number; score: number; reason: string[] };
type Plan = Decision & { state: "PREPARED" | "TRIGGERED" | "CANCELLED"; plannedRisk: number; notional: number };
type Position = { side: "LONG" | "SHORT"; scenario: string; status: "OPEN" | "CLOSED"; entryPrice: number; currentStop: number; currentTarget: number; plannedRisk: number; notional: number; realizedPnl?: number; exitReason?: string };
type Runtime = {
  version: string; mode: "PAPER"; state: string; stale: boolean; generatedAt: number; lastSuccessAt: number | null; lastError: string | null; symbols: string[]; equity: number;
  decisions: Record<string, Decision | null>; plans: Record<string, Plan | null>; positions: Record<string, Position | null>;
  authorityReady: boolean;
  evidence: Record<string, { midpoint: number; observedAt: number; warmup: number; fresh: boolean; ancillaryFresh: boolean; topLong: Zone | null; topShort: Zone | null; absorption: number }>;
  limits: { plannedTotalDoRequestsPerDay: number; plannedDoWritesPerDay: number; plannedMaxD1BilledWritesPerDay: number; maxSubrequestsPerAlarm: number };
};

const stateText: Record<string, string> = { BREAKOUT: "突破", REVERSAL: "反转", RANGE: "震荡", LIVE: "运行中", WARMING: "预热中", DEGRADED: "局部降级", RECONNECTING: "重连中", RECOVERY_REQUIRED: "需人工恢复", STARTING: "启动中" };
const sourceText: Record<string, string> = { BOOK: "期货订单簿", STOP_POOL: "多尺度止损池", LIQUIDATION: "估计清算梯度" };
const num = (value: number | undefined, digits = 3) => Number.isFinite(value) ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "—";
const time = (value: number | null | undefined) => value ? new Date(value).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—";

export default function Home() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [clock, setClock] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let controller: AbortController | null = null;
    const read = async () => {
      if (!active || document.hidden || inFlight) return;
      setClock(Date.now());
      inFlight = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 5_000);
      try {
        const response = await fetch("/api/runtime", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const value = await response.json() as Runtime;
        if (active) { setRuntime(value); setReceivedAt(Date.now()); setError(null); }
      } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : "读取失败"); }
      finally { clearTimeout(timeout); inFlight = false; controller = null; }
    };
    const visibility = () => { if (!document.hidden) void read(); else controller?.abort(); };
    void read();
    const timer = setInterval(read, 15_000);
    document.addEventListener("visibilitychange", visibility);
    return () => { active = false; controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, []);

  const responseFresh = runtime != null && clock - receivedAt < 20_000 && clock - runtime.generatedAt < 20_000;
  const healthy = runtimeReady(runtime, responseFresh && !error);
  return <main>
    <header>
      <div><p className="eyebrow">全新系统 · 仅模拟</p><h1>流动性三态</h1><p className="subtitle">预测价格更愿意去哪里，再决定突破、反转或震荡。</p></div>
      <div role="status" className={`health ${healthy ? "" : "bad"}`}><span />{healthy ? "运行中" : error ? "页面数据中断" : runtime?.stale ? "重连中" : runtime ? stateText[runtime.state] ?? runtime.state : "连接中"}</div>
    </header>

    <section className="summary">
      <article><small>运行模式</small><strong>PAPER</strong><p>物理上没有实盘下单接口</p></article>
      <article><small>模拟权益</small><strong>{runtime ? `${num(runtime.equity, 2)} U` : "—"}</strong><p>正常成交与压力滑点预算内，组合结构风险 ≤ 5%</p></article>
      <article><small>最新后台成功</small><strong>{time(runtime?.lastSuccessAt)}</strong><p>页面关闭后仍由服务器运行</p></article>
    </section>

    {error && <p className="notice">页面读取延迟：{error}。后台不会因页面失败停止。</p>}
    {runtime?.lastError && <p className="notice">后台正在恢复：{runtime.lastError}</p>}

    <section className="markets">
      {runtime?.symbols.map((symbol) => {
        const evidence = runtime.evidence[symbol];
        const marketFresh = healthy && evidence?.fresh && evidence?.ancillaryFresh;
        const decision = marketFresh ? runtime.decisions[symbol] : null;
        const plan = marketFresh ? runtime.plans[symbol] : null;
        const position = runtime.positions[symbol];
        return <article className="market" key={symbol}>
          <div className="market-title"><div><small>{symbol}</small><h2>{!marketFresh ? "行情陈旧" : decision ? stateText[decision.marketState] : evidence?.warmup < 30 ? `预热 ${evidence?.warmup ?? 0}/30` : "等待目标"}</h2></div><strong>{marketFresh ? num(evidence?.midpoint, 5) : "—"}</strong></div>
          <div className="targets">
            <div><small>上方目标</small><b>{marketFresh ? num(evidence?.topLong?.price, 5) : "陈旧"}</b><span>{marketFresh ? `${sourceText[evidence?.topLong?.source ?? ""] ?? "等待识别"} · ${num(evidence?.topLong?.score, 2)}` : "等待新快照"}</span></div>
            <div><small>下方目标</small><b>{marketFresh ? num(evidence?.topShort?.price, 5) : "陈旧"}</b><span>{marketFresh ? `${sourceText[evidence?.topShort?.source ?? ""] ?? "等待识别"} · ${num(evidence?.topShort?.score, 2)}` : "等待新快照"}</span></div>
          </div>
          {decision && <div className="decision"><b>{decision.side === "LONG" ? "做多" : "做空"} · {stateText[decision.marketState]}</b><p>{decision.reason.join("；")}</p><p>预判触发 {num(decision.entryTrigger, 5)} · 结构失效 {num(decision.invalidation, 5)} · 当前目标 {num(decision.target, 5)}</p></div>}
          {plan?.state === "PREPARED" && <div className="plan"><b>已提前准备 PAPER 计划</b><p>计划风险 {num(plan.plannedRisk, 2)} U · 名义仓位 {num(plan.notional, 2)} U</p></div>}
          {position?.status === "OPEN" && <div className="position"><b>PAPER 持仓 · {position.side === "LONG" ? "多" : "空"}</b><p>进场 {num(position.entryPrice, 5)} · 当前保护 {num(position.currentStop, 5)} · 动态目标 {num(position.currentTarget, 5)}{!marketFresh ? " · 行情陈旧，显示最后持久状态" : ""}</p></div>}
        </article>;
      })}
    </section>

    <footer>
      <p>清算梯度是基于 ΔOI、主动方向、合约乘数、维持保证金率和公开清算记录的估计，不是交易所全部账户的真实清算价。</p>
      <p>5% 是含手续费与压力滑点的事前风险预算；极端跳空可能越过止损，不能保证实际亏损绝不超过 5%。</p>
      {runtime?.limits && <p>日预算：DO 请求约 {num(runtime.limits.plannedTotalDoRequestsPerDay, 0)} · DO 写约 {num(runtime.limits.plannedDoWritesPerDay, 0)} · D1 计费写最坏 {num(runtime.limits.plannedMaxD1BilledWritesPerDay, 0)}。</p>}
    </footer>
  </main>;
}
