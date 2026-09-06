"use client";

import { useEffect, useMemo, useState } from "react";
import { runtimeReady } from "../lib/runtime-health.ts";

type Side = "LONG" | "SHORT";
type MarketState = "BREAKOUT" | "REVERSAL" | "RANGE";
type Zone = { price: number; score: number; source: "BOOK" | "STOP_POOL" | "LIQUIDATION" };
type Decision = { marketState: MarketState; side: Side; entryTrigger: number; invalidation: number; target: number; score: number; reason: string[] };
type Plan = Decision & { state: "PREPARED" | "TRIGGERED" | "CANCELLED"; plannedRisk: number; notional: number };
type Position = { side: Side; scenario: MarketState; status: "OPEN" | "CLOSED"; entryAt?: number; entryPrice: number; currentStop: number; currentTarget: number; plannedRisk: number; notional: number; realizedPnl?: number; exitReason?: string };
type Runtime = {
  version: string; mode: "PAPER"; state: string; stale: boolean; generatedAt: number; lastSuccessAt: number | null; lastError: string | null; symbols: string[]; equity: number;
  decisions: Record<string, Decision | null>; plans: Record<string, Plan | null>; positions: Record<string, Position | null>; authorityReady: boolean;
  evidence: Record<string, { midpoint: number; observedAt: number; warmup: number; fresh: boolean; ancillaryFresh: boolean; topLong: Zone | null; topShort: Zone | null; absorption: number }>;
  limits: { maxOpenPositions: number };
};
type HistoryItem = { id: string; symbol: string; marketState: MarketState; side: Side; status: "OPEN" | "CLOSED"; entryAt: number; entryPrice: number; currentStop: number; currentTarget: number; plannedRisk: number; notional: number; exitAt: number | null; exitPrice: number | null; exitReason: string | null; realizedPnl: number | null };
type Tab = "brain" | "orders" | "history" | "settings";
type Timeframe = "1m" | "15m" | "1h";
type Candle = { time: number; volume: number; close: number; high: number; low: number; open: number };

const INITIAL_EQUITY = 1_000;
const RUNTIME_REQUEST_TIMEOUT_MS = 30_000;
const RUNTIME_DISPLAY_TTL_MS = 90_000;
const stateText: Record<string, string> = { BREAKOUT: "突破", REVERSAL: "反转", RANGE: "震荡", LIVE: "运行中", WARMING: "预热中", DEGRADED: "部分数据恢复中", RECONNECTING: "重新连接中", RECOVERY_REQUIRED: "需要恢复", STARTING: "启动中" };
const sourceText: Record<string, string> = { BOOK: "真实挂单区", STOP_POOL: "止损集中区", LIQUIDATION: "估计清算区" };
const exitText: Record<string, string> = { STRUCTURAL_STOP: "结构失效止损", TARGET_ABSORBED: "目标流动性已被吸收", TARGET_VANISHED: "目标消失", OPPOSITE_TARGET_DOMINANT: "反向目标占优" };
const num = (value: number | null | undefined, digits = 3) => Number.isFinite(value) ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "—";
const signed = (value: number, digits = 2) => `${value >= 0 ? "+" : ""}${num(value, digits)}`;
const time = (value: number | null | undefined) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
const sideText = (side: Side) => side === "LONG" ? "做多" : "做空";
const distancePct = (from: number, to: number) => Math.abs(to - from) / Math.max(from, 1e-9) * 100;
const rr = (entry: number, stop: number, target: number) => Math.abs(target - entry) / Math.max(Math.abs(entry - stop), 1e-9);
const displayLeverage = (notional: number, equity: number) => [1, 2, 3, 5, 10, 20, 50].find((value) => notional / value <= equity * .6) ?? 50;

function waitReason(runtime: Runtime | null, marketReady: boolean, symbol: string) {
  if (!runtime) return "正在连接后台行情";
  const evidence = runtime.evidence[symbol];
  if (!marketReady || !evidence?.fresh || !evidence?.ancillaryFresh) return "该币行情证据暂时不完整，禁止使用旧价格进场";
  if (evidence.warmup < 30) return `正在积累真实快照，还差 ${30 - evidence.warmup} 次`;
  const position = runtime.positions[symbol];
  if (position?.status === "OPEN") return "已经持仓，系统正动态保护并跟踪目标";
  const plan = runtime.plans[symbol];
  if (plan?.state === "PREPARED") return `方向已判断，距离触发价约 ${num(distancePct(evidence.midpoint, plan.entryTrigger), 2)}%`;
  if (runtime.decisions[symbol]) return "方向已经出现，但进场条件或风险空间暂不合适";
  return "上下流动性优势不足，突破、反转和震荡条件都未成立";
}

export default function Home() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [receivedAt, setReceivedAt] = useState(0);
  const [clock, setClock] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("brain");
  const [showLiveLock, setShowLiveLock] = useState(false);

  useEffect(() => {
    let active = true, inFlight = false;
    let controller: AbortController | null = null;
    const read = async () => {
      if (!active || document.hidden || inFlight) return;
      setClock(Date.now()); inFlight = true; controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), RUNTIME_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch("/api/runtime", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const value = await response.json() as Runtime;
        if (active) { setRuntime(value); setReceivedAt(Date.now()); setError(null); }
      } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : "读取失败"); }
      finally { clearTimeout(timeout); inFlight = false; controller = null; }
    };
    const readHistory = async () => {
      try {
        const response = await fetch("/api/history", { cache: "no-store" });
        if (response.ok && active) setHistory(((await response.json()) as { items: HistoryItem[] }).items ?? []);
      } catch { /* History is optional; the live runtime remains authoritative. */ }
    };
    const visibility = () => { if (!document.hidden) void read(); else controller?.abort(); };
    void read(); void readHistory();
    const timer = setInterval(read, 15_000);
    document.addEventListener("visibilitychange", visibility);
    return () => { active = false; controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, []);

  const responseFresh = runtime != null && clock - receivedAt < RUNTIME_DISPLAY_TTL_MS && clock - runtime.generatedAt < RUNTIME_DISPLAY_TTL_MS;
  const healthy = runtimeReady(runtime, responseFresh);
  const authorityOperational = runtime != null && runtime.authorityReady && !runtime.stale;
  const openPositions = useMemo(() => runtime?.symbols.flatMap((symbol) => runtime.positions[symbol]?.status === "OPEN" ? [{ symbol, position: runtime.positions[symbol]! }] : []) ?? [], [runtime]);
  const preparedPlans = useMemo(() => runtime?.symbols.flatMap((symbol) => runtime.plans[symbol]?.state === "PREPARED" ? [{ symbol, plan: runtime.plans[symbol]! }] : []) ?? [], [runtime]);
  const bestDecision = useMemo(() => runtime?.symbols.map((symbol) => ({ symbol, decision: runtime.decisions[symbol] })).filter((row): row is { symbol: string; decision: Decision } => row.decision != null).sort((a, b) => b.decision.score - a.decision.score)[0] ?? null, [runtime]);
  const floatingPnl = openPositions.reduce((sum, row) => { const mark = runtime?.evidence[row.symbol]?.midpoint ?? row.position.entryPrice; return sum + row.position.notional * (mark - row.position.entryPrice) / Math.max(row.position.entryPrice, 1e-9) * (row.position.side === "LONG" ? 1 : -1); }, 0);
  const riskUsed = openPositions.reduce((sum, row) => sum + row.position.plannedRisk, 0);
  const riskLimit = (runtime?.equity ?? INITIAL_EQUITY) * .05;
  const primary = openPositions[0] ? { symbol: openPositions[0].symbol, side: openPositions[0].position.side, state: openPositions[0].position.scenario, kind: "position" }
    : preparedPlans[0] ? { symbol: preparedPlans[0].symbol, side: preparedPlans[0].plan.side, state: preparedPlans[0].plan.marketState, kind: "plan" }
      : bestDecision ? { symbol: bestDecision.symbol, side: bestDecision.decision.side, state: bestDecision.decision.marketState, kind: "decision" } : null;
  const primaryReady = primary ? Boolean(authorityOperational && runtime?.evidence[primary.symbol]?.fresh && runtime.evidence[primary.symbol]?.ancillaryFresh) : false;
  const headline = !authorityOperational ? "行情正在恢复，暂不进场" : primary?.kind === "position" ? `正在持有 ${primary.symbol.replace("_", "/")} ${primary.side === "LONG" ? "多单" : "空单"}` : primary ? `准备${sideText(primary.side)} ${primary.symbol.replace("_", "/")}` : "继续观察，暂不开仓";
  const headlineDetail = primary ? `${stateText[primary.state]}判断 · ${waitReason(runtime, primaryReady, primary.symbol)}` : runtime?.symbols[0] ? waitReason(runtime, Boolean(authorityOperational && runtime.evidence[runtime.symbols[0]]?.fresh && runtime.evidence[runtime.symbols[0]]?.ancillaryFresh), runtime.symbols[0]) : "正在等待第一批行情";

  return <main>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">三</span><div><p>流动性三态</p><small>预测型量化交易系统</small></div></div>
      <div className="top-actions"><div role="status" className={`health ${healthy ? "" : "bad"}`}><span />{healthy ? "后台运行中" : error ? "页面连接中断" : runtime?.stale ? "行情重连中" : runtime ? stateText[runtime.state] ?? runtime.state : "正在连接"}</div><div className="mode-switch"><button className="active" type="button">模拟</button><button type="button" onClick={() => setShowLiveLock(true)}>实盘 <em>锁定</em></button></div></div>
    </header>

    <section className="brain-hero"><div><p className="eyebrow">系统现在的决定</p><h1>{headline}</h1><p className="hero-detail">{headlineDetail}</p></div><div className="decision-badge"><small>当前市场状态</small><strong>{primary ? stateText[primary.state] : "等待"}</strong><span>{primary ? sideText(primary.side) : "没有勉强开仓"}</span></div></section>

    <section className="summary four">
      <article><small>模拟账户权益</small><strong>{runtime ? `${num(runtime.equity, 2)} U` : "—"}</strong><p>初始资金 {num(INITIAL_EQUITY, 0)} U</p></article>
      <article><small>累计模拟盈亏</small><strong className={(runtime?.equity ?? INITIAL_EQUITY) >= INITIAL_EQUITY ? "positive" : "negative"}>{runtime ? `${signed(runtime.equity - INITIAL_EQUITY)} U` : "—"}</strong><p>{runtime ? `${signed((runtime.equity / INITIAL_EQUITY - 1) * 100)}%` : "等待数据"}</p></article>
      <article><small>当前持仓浮盈亏</small><strong className={floatingPnl >= 0 ? "positive" : "negative"}>{runtime ? `${signed(floatingPnl)} U` : "—"}</strong><p>{openPositions.length} 笔模拟持仓</p></article>
      <article><small>组合风险预算</small><strong>{num(riskUsed, 2)} / {num(riskLimit, 2)} U</strong><div className="risk-bar"><i style={{ width: `${Math.min(100, riskLimit ? riskUsed / riskLimit * 100 : 0)}%` }} /></div><p>剩余 {num(Math.max(0, riskLimit - riskUsed), 2)} U</p></article>
    </section>
    {(!responseFresh || error) && runtime && <p className="notice">手机页面更新延迟，下面保留最近一次后台状态；服务器仍独立运行，不会因此停止判断或开模拟单。</p>}{runtime?.lastError && <p className="notice">系统正在自动恢复：{runtime.lastError}</p>}

    <nav className="tabs">{([['brain', '大脑'], ['orders', `订单 ${openPositions.length + preparedPlans.length || ''}`], ['history', '历史'], ['settings', '设置']] as const).map(([key, label]) => <button key={key} type="button" className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>)}</nav>

    {tab === "brain" && <section className="markets">{runtime?.symbols.map((symbol) => {
      const evidence = runtime.evidence[symbol], marketFresh = Boolean(authorityOperational && evidence?.fresh && evidence?.ancillaryFresh);
      const decision = marketFresh ? runtime.decisions[symbol] : null, plan = marketFresh ? runtime.plans[symbol] : null, position = runtime.positions[symbol];
      const status = position?.status === "OPEN" ? "持仓中" : plan?.state === "PREPARED" ? "等待进场" : decision ? "发现机会" : evidence?.warmup < 30 ? `预热 ${evidence?.warmup ?? 0}/30` : "继续观察";
      return <article className="market" key={symbol}><div className="market-title"><div><small>{symbol.replace("_", "/")}</small><h2>{marketFresh ? status : "数据恢复中"}</h2></div><strong>{marketFresh ? num(evidence?.midpoint, 5) : "—"}</strong></div>
        <div className="plain-answer"><small>系统判断</small><b>{decision ? `${sideText(decision.side)} · ${stateText[decision.marketState]}` : "暂时没有值得执行的方向"}</b><p>{waitReason(runtime, marketFresh, symbol)}</p></div>
        {decision && <div className="trade-levels"><div><small>准备进场</small><b>{num(decision.entryTrigger, 5)}</b></div><div><small>判断错误就退出</small><b>{num(decision.invalidation, 5)}</b></div><div><small>当前目标</small><b>{num(decision.target, 5)}</b></div><div><small>预计盈亏比</small><b>{num(rr(decision.entryTrigger, decision.invalidation, decision.target), 2)} : 1</b></div></div>}
        <div className="execution"><small>执行方式</small><b>{position?.status === "OPEN" ? "已按实时价格触发，正在持仓" : plan?.state === "PREPARED" ? `不预挂单，等待实时价格到达 ${num(plan.entryTrigger, 5)}` : decision ? "方向已形成，等待系统建立进场计划" : "不挂单，继续等待完整机会"}</b></div>
        <CandleChart symbol={symbol} evidence={evidence} decision={plan?.state === "PREPARED" ? plan : decision} position={position?.status === "OPEN" ? position : null} />
        <details><summary>查看判断依据</summary><p>{decision?.reason.join("；") || "尚未形成完整判断"}</p><div className="targets"><span>上方吸引区：{num(evidence?.topLong?.price, 5)} · {sourceText[evidence?.topLong?.source ?? ""] ?? "识别中"}</span><span>下方吸引区：{num(evidence?.topShort?.price, 5)} · {sourceText[evidence?.topShort?.source ?? ""] ?? "识别中"}</span></div></details>
      </article>;
    }) ?? <div className="empty">正在读取市场数据…</div>}</section>}

    {tab === "orders" && <section className="panel-list">{!openPositions.length && !preparedPlans.length && <div className="empty"><b>当前没有订单</b><p>出现合适位置后会先显示准备计划，再自动建立模拟持仓。</p></div>}
      {openPositions.map(({ symbol, position }) => <OrderCard key={symbol} symbol={symbol} side={position.side} label="持仓中" state={position.scenario} notional={position.notional} equity={runtime?.equity ?? INITIAL_EQUITY} values={[["进场", position.entryPrice], ["保护价", position.currentStop], ["动态目标", position.currentTarget], ["计划风险", position.plannedRisk]]} />)}
      {preparedPlans.map(({ symbol, plan }) => <OrderCard key={symbol} symbol={symbol} side={plan.side} label="等待触发" state={plan.marketState} notional={plan.notional} equity={runtime?.equity ?? INITIAL_EQUITY} values={[["触发进场", plan.entryTrigger], ["结构止损", plan.invalidation], ["目标", plan.target], ["计划风险", plan.plannedRisk]]} />)}
    </section>}

    {tab === "history" && <section className="history-panel"><div className="section-heading"><div><h2>最近模拟交易</h2><p>只展示真实产生过的记录，不填充示例数据。</p></div><span>{history.filter((item) => item.status === "CLOSED").length} 笔已结束</span></div>
      {!history.length ? <div className="empty"><b>还没有历史交易</b><p>产生第一笔模拟交易后会自动出现在这里。</p></div> : <div className="history-table">{history.map((item) => <article key={item.id}><div><span className={`side ${item.side.toLowerCase()}`}>{item.side === "LONG" ? "多" : "空"}</span><div><b>{item.symbol.replace("_", "/")}</b><small>{time(item.entryAt)} · {stateText[item.marketState]}</small></div></div><div><small>进场 / 出场</small><b>{num(item.entryPrice, 5)} / {num(item.exitPrice, 5)}</b></div><div><small>结果</small><b className={(item.realizedPnl ?? 0) >= 0 ? "positive" : "negative"}>{item.status === "OPEN" ? "持仓中" : `${signed(item.realizedPnl ?? 0)} U`}</b></div><div><small>结束原因</small><b>{item.status === "OPEN" ? "尚未结束" : exitText[item.exitReason ?? ""] ?? item.exitReason ?? "已结束"}</b></div></article>)}</div>}
    </section>}

    {tab === "settings" && <section className="settings-panel"><Setting title="交易模式" detail="当前所有信号、订单和盈亏均为模拟。" value="模拟运行" tone="online"/><button className="setting-row" type="button" onClick={() => setShowLiveLock(true)}><div><b>实盘交易</b><p>需要所有者验证和独立实盘执行版本，防止公开页面被他人操作。</p></div><span className="setting-value locked">安全锁定 ›</span></button><Setting title="最大组合风险" detail="包含手续费和压力滑点，止损只允许收紧。" value="5%"/><Setting title="持仓时间与止盈" detail="不固定时间，不固定止盈；目标变化时动态退出。" value="动态"/><Setting title="系统状态" detail="页面关闭后服务器仍然持续运行。" value={healthy ? "正常" : "恢复中"} tone={healthy ? "online" : "locked"}/><p className="last-update">最近后台成功：{time(runtime?.lastSuccessAt)}</p></section>}

    {showLiveLock && <div className="modal-backdrop" onClick={() => setShowLiveLock(false)}><section className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><span className="lock-icon">锁</span><h2>实盘目前安全锁定</h2><p>当前公网页面没有所有者身份验证。为避免任何人打开网址就能操作真实资金，实盘下单必须在独立版本中接入验证后才能开放。</p><p>模拟系统会继续 24 小时运行，不会因为页面关闭而停止。</p><button type="button" onClick={() => setShowLiveLock(false)}>我知道了</button></section></div>}
  </main>;
}

function OrderCard({ symbol, side, label, state, notional, equity, values }: { symbol: string; side: Side; label: string; state: MarketState; notional: number; equity: number; values: [string, number][] }) {
  const leverage = displayLeverage(notional, equity), margin = notional / leverage;
  return <article className="order-card"><div><span className={`side ${side.toLowerCase()}`}>{side === "LONG" ? "多" : "空"}</span><div><h3>{symbol.replace("_", "/")} · {label}</h3><p>{stateText[state]} · PAPER 模拟合约</p></div></div><strong style={{ textAlign: "right" }}><small style={{ display: "block", color: "var(--muted)", fontSize: 10 }}>合约名义价值</small>{num(notional, 2)} U</strong><dl>{values.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{num(value, name.includes("风险") ? 2 : 5)}{name.includes("风险") ? " U" : ""}</dd></div>)}<div><dt>模拟杠杆</dt><dd>{leverage}×</dd></div><div><dt>预计保证金</dt><dd>{num(margin, 2)} U</dd></div></dl><p style={{ gridColumn: "1 / -1", margin: 0, color: "var(--muted)", fontSize: 11 }}>触发时按最新价格、权益和组合风险重新计算；当前不会向 Gate 提交真实订单。</p></article>;
}

function CandleChart({ symbol, evidence, decision, position }: {
  symbol: string;
  evidence: Runtime["evidence"][string] | undefined;
  decision: Decision | Plan | null;
  position: Position | null;
}) {
  const [interval, setIntervalValue] = useState<Timeframe>("15m");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loadedInterval, setLoadedInterval] = useState<Timeframe | null>(null);
  const [loading, setLoading] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState(0);

  useEffect(() => {
    let active = true, inFlight = false;
    let controller: AbortController | null = null;
    const read = async () => {
      if (!active || document.hidden || inFlight) return;
      inFlight = true; controller = new AbortController(); setLoading(true);
      const timeout = window.setTimeout(() => controller?.abort(), 8_000);
      try {
        const response = await fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as { source: string; candles: Candle[]; generatedAt: number };
        const valid = (payload.candles ?? []).filter((row) => [row.time, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite) && row.time > 0 && row.low > 0 && row.high >= row.low);
        if (!valid.length || payload.source !== "GATE_USDT_FUTURES") throw new Error("真实K线暂不可用");
        if (active) { setCandles(valid); setLoadedInterval(interval); setUpdatedAt(payload.generatedAt); setChartError(null); }
      } catch (failure) {
        if (active) setChartError(failure instanceof Error && failure.name !== "AbortError" ? failure.message : "更新超时");
      } finally {
        window.clearTimeout(timeout); inFlight = false; if (active) setLoading(false);
      }
    };
    void read();
    const timer = window.setInterval(read, 60_000);
    return () => { active = false; controller?.abort(); window.clearInterval(timer); };
  }, [symbol, interval]);

  const rows = loadedInterval === interval ? candles.slice(-72) : [];
  const width = 720, height = 286, left = 10, right = 10, top = 24, bottom = 34;
  const rawLevels = [
    evidence?.topLong && { value: evidence.topLong.price, label: "上方流动性", kind: "liquidity" },
    evidence?.topShort && { value: evidence.topShort.price, label: "下方流动性", kind: "liquidity" },
    position && { value: position.entryPrice, label: "持仓进场", kind: "entry" },
    position && { value: position.currentStop, label: "保护价", kind: "stop" },
    position && { value: position.currentTarget, label: "动态目标", kind: "target" },
    !position && decision && { value: decision.entryTrigger, label: "触发价", kind: "entry" },
    !position && decision && { value: decision.invalidation, label: "失效价", kind: "stop" },
    !position && decision && { value: decision.target, label: "目标价", kind: "target" },
  ].filter((level): level is { value: number; label: string; kind: string } => Boolean(level && Number.isFinite(level.value) && level.value > 0));
  const levels = rawLevels.filter((level, index) => rawLevels.findIndex((candidate) => Math.abs(candidate.value - level.value) <= Math.max(level.value, 1) * 1e-7) === index);
  const allPrices = [...rows.flatMap((row) => [row.high, row.low]), ...levels.map((level) => level.value)];
  const rawMin = allPrices.length ? Math.min(...allPrices) : 0;
  const rawMax = allPrices.length ? Math.max(...allPrices) : 1;
  const padding = Math.max((rawMax - rawMin) * .07, rawMax * .0005, 1e-9);
  const minPrice = rawMin - padding, maxPrice = rawMax + padding;
  const plotHeight = height - top - bottom;
  const y = (value: number) => top + (maxPrice - value) / Math.max(maxPrice - minPrice, 1e-9) * plotHeight;
  const step = (width - left - right) / Math.max(rows.length, 1);
  const bodyWidth = Math.max(2, Math.min(8, step * .58));
  const latest = rows.at(-1);

  return <section className="chart-shell" aria-label={`${symbol.replace("_", "/")} 真实期货K线`}>
    <div className="chart-head"><div><b>真实期货 K 线</b><small>Gate USDT 合约 · 已收盘数据</small></div><div className="timeframes" aria-label="切换策略结构周期">{([['1m', '1分钟'], ['15m', '15分钟'], ['1h', '1小时']] as const).map(([value, label]) => <button type="button" key={value} className={interval === value ? "active" : ""} onClick={() => setIntervalValue(value)}>{label}</button>)}</div></div>
    {!rows.length ? <div className="chart-loading">{loading ? "正在读取真实 K 线…" : `真实 K 线更新延迟${chartError ? `：${chartError}` : ""}`}</div> : <>
      <div className="chart-canvas"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${rows.length} 根 ${interval} 已收盘K线及策略区域`} preserveAspectRatio="none">
        {[.25, .5, .75].map((ratio) => <line className="chart-grid" key={ratio} x1={left} x2={width - right} y1={top + plotHeight * ratio} y2={top + plotHeight * ratio} />)}
        {levels.filter((level) => level.kind === "liquidity").map((level) => <rect className="zone-band" key={`${level.label}:${level.value}`} x={left} width={width - left - right} y={y(level.value) - 4} height="8" />)}
        {rows.map((row, index) => {
          const x = left + step * index + step / 2;
          const up = row.close >= row.open;
          const bodyTop = y(Math.max(row.open, row.close));
          const bodyHeight = Math.max(1.8, Math.abs(y(row.open) - y(row.close)));
          return <g className={`candle ${up ? "up" : "down"}`} key={row.time}><line x1={x} x2={x} y1={y(row.high)} y2={y(row.low)} /><rect x={x - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} /></g>;
        })}
        {levels.map((level, index) => { const levelY = y(level.value); return <g className={`chart-level ${level.kind}`} key={`${level.kind}:${level.value}`}><line x1={left} x2={width - right} y1={levelY} y2={levelY} /><text x={left + 5} y={Math.max(12, levelY - 5 - (index % 2) * 11)}>{level.label} {num(level.value, 5)}</text></g>; })}
        <text className="axis-label" x={left} y={height - 9}>{rows[0] ? time(rows[0].time * 1_000) : ""}</text><text className="axis-label end" x={width - right} y={height - 9}>{latest ? time(latest.time * 1_000) : ""}</text>
      </svg></div>
      <div className="ohlc"><span>开 <b>{num(latest?.open, 5)}</b></span><span>高 <b>{num(latest?.high, 5)}</b></span><span>低 <b>{num(latest?.low, 5)}</b></span><span>收 <b>{num(latest?.close, 5)}</b></span><small>{loading ? "更新中" : chartError ? "保留上次真实数据" : `${rows.length} 根 · ${time(updatedAt)}`}</small></div>
    </>}
  </section>;
}

function Setting({ title, detail, value, tone = "" }: { title: string; detail: string; value: string; tone?: string }) {
  return <div className="setting-row"><div><b>{title}</b><p>{detail}</p></div><span className={`setting-value ${tone}`}>{value}</span></div>;
}
