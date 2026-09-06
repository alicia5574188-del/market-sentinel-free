"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { runtimeReady } from "../lib/runtime-health.ts";

type Side = "LONG" | "SHORT";
type MarketState = "BREAKOUT" | "REVERSAL" | "RANGE";
type Zone = { price: number; score: number; source: "BOOK" | "STOP_POOL" | "LIQUIDATION" };
type Decision = { marketState: MarketState; side: Side; entryTrigger: number; invalidation: number; target: number; score: number; reason: string[] };
type Plan = Decision & { state: "PREPARED" | "TRIGGERED" | "CANCELLED"; plannedRisk: number; notional: number };
type Position = { side: Side; scenario: MarketState; status: "OPEN" | "CLOSED"; entryAt?: number; entryPrice: number; currentStop: number; currentTarget: number; plannedRisk: number; notional: number; realizedPnl?: number; exitReason?: string };
type LiveEntry = { planId: string; symbol: string; side: Side; scenario: MarketState; kind: "PRICE_TRIGGER" | "LIMIT"; status: string; trigger: number; invalidation: number; target: number; plannedRisk: number; notional: number; leverage: number; margin: number; lastError: string | null };
type LivePosition = Position & { id: string; symbol: string; exchangeSize: number; leverage: number; margin: number; stopPrice: number | null; exitRequestedAt: number | null };
type LiveRuntime = { requestedEnabled: boolean; operational: boolean; changedAt: number | null; lastSyncAt: number | null; lastError: string | null; equity: number | null; available: number | null; credentialConfigured: boolean; entries: Record<string, LiveEntry | null>; positions: Record<string, LivePosition | null> };
type Runtime = {
  version: string; mode: "PAPER"; state: string; stale: boolean; generatedAt: number; lastSuccessAt: number | null; lastError: string | null; symbols: string[]; equity: number;
  decisions: Record<string, Decision | null>; plans: Record<string, Plan | null>; positions: Record<string, Position | null>; authorityReady: boolean;
  evidence: Record<string, { midpoint: number; observedAt: number; warmup: number; fresh: boolean; ancillaryFresh: boolean; topLong: Zone | null; topShort: Zone | null; absorption: number }>;
  limits: { maxOpenPositions: number };
  liveMode: { requestedEnabled: boolean; operational: boolean };
  live?: LiveRuntime;
};
type AuthSession = { configured: boolean; authenticated: boolean; username: string };
type CredentialStatus = { configured: boolean; environment: string | null; keyHint: string | null; gateUserId: string | null; status: string; lastVerifiedAt: number | null; lastError: string | null; updatedAt: number | null };
type CredentialVerification = { equity: number; available: number; positions: number; orders: number; conditionalOrders: number; checkedAt: number };
type HistoryItem = { id: string; symbol: string; marketState: MarketState; side: Side; status: "OPEN" | "CLOSED"; entryAt: number; entryPrice: number; currentStop: number; currentTarget: number; plannedRisk: number; notional: number; exitAt: number | null; exitPrice: number | null; exitReason: string | null; realizedPnl: number | null };
type Tab = "brain" | "orders" | "live" | "history" | "settings";
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
  const [auth, setAuth] = useState<AuthSession>({ configured: true, authenticated: false, username: "owner" });
  const [showLogin, setShowLogin] = useState(false);
  const [showLiveConfirm, setShowLiveConfirm] = useState(false);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveActionError, setLiveActionError] = useState<string | null>(null);
  const selectTab = (next: Tab) => { setTab(next); window.scrollTo(0, 0); };

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

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/session", { cache: "no-store" }).then(async (response) => {
      if (response.ok && active) setAuth(await response.json() as AuthSession);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const setLiveMode = async (enabled: boolean) => {
    setLiveBusy(true); setLiveActionError(null);
    try {
      const response = await fetch("/api/live/mode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
      const payload = await response.json() as { error?: string; live?: LiveRuntime };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      if (payload.live && runtime) setRuntime({ ...runtime, live: payload.live, liveMode: { requestedEnabled: payload.live.requestedEnabled, operational: payload.live.operational } });
      setShowLiveConfirm(false);
    } catch (failure) { setLiveActionError(failure instanceof Error ? failure.message : "操作失败"); }
    finally { setLiveBusy(false); }
  };

  const live = runtime?.live;
  const liveEnabled = Boolean(live?.requestedEnabled ?? runtime?.liveMode?.requestedEnabled);
  const openLivePositions = Object.values(live?.positions ?? {}).filter((position): position is LivePosition => position?.status === "OPEN");
  const openLiveEntries = Object.values(live?.entries ?? {}).filter((entry): entry is LiveEntry => Boolean(entry && !["FILLED", "CANCELLED"].includes(entry.status)));
  const liveControl = () => {
    if (!auth.authenticated) setShowLogin(true);
    else if (liveEnabled) void setLiveMode(false);
    else setShowLiveConfirm(true);
  };

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
      <div className="top-actions"><div role="status" className={`health ${healthy ? "" : "bad"}`}><span />{healthy ? "后台运行中" : error ? "页面连接中断" : runtime?.stale ? "行情重连中" : runtime ? stateText[runtime.state] ?? runtime.state : "正在连接"}</div><div className="mode-switch"><button className={!liveEnabled ? "active" : ""} type="button" onClick={() => liveEnabled && liveControl()}>模拟</button><button className={liveEnabled ? "active live-on" : ""} type="button" onClick={liveControl}>实盘 <em>{!auth.authenticated ? "登录" : liveEnabled ? live?.operational ? "已开" : "待恢复" : "已关"}</em></button></div></div>
    </header>

    <section className="brain-hero"><div><p className="eyebrow">系统现在的决定</p><h1>{headline}</h1><p className="hero-detail">{headlineDetail}</p></div><div className="decision-badge"><small>当前市场状态</small><strong>{primary ? stateText[primary.state] : "等待"}</strong><span>{primary ? sideText(primary.side) : "没有勉强开仓"}</span></div></section>

    <section className="summary four">
      <article><small>模拟账户权益</small><strong>{runtime ? `${num(runtime.equity, 2)} U` : "—"}</strong><p>初始资金 {num(INITIAL_EQUITY, 0)} U</p></article>
      <article><small>累计模拟盈亏</small><strong className={(runtime?.equity ?? INITIAL_EQUITY) >= INITIAL_EQUITY ? "positive" : "negative"}>{runtime ? `${signed(runtime.equity - INITIAL_EQUITY)} U` : "—"}</strong><p>{runtime ? `${signed((runtime.equity / INITIAL_EQUITY - 1) * 100)}%` : "等待数据"}</p></article>
      <article><small>当前持仓浮盈亏</small><strong className={floatingPnl >= 0 ? "positive" : "negative"}>{runtime ? `${signed(floatingPnl)} U` : "—"}</strong><p>{openPositions.length} 笔模拟持仓</p></article>
      <article><small>组合风险预算</small><strong>{num(riskUsed, 2)} / {num(riskLimit, 2)} U</strong><div className="risk-bar"><i style={{ width: `${Math.min(100, riskLimit ? riskUsed / riskLimit * 100 : 0)}%` }} /></div><p>剩余 {num(Math.max(0, riskLimit - riskUsed), 2)} U</p></article>
    </section>
    {(!responseFresh || error) && runtime && <p className="notice">手机页面更新延迟，下面保留最近一次后台状态；服务器仍独立运行，不会因此停止判断或开模拟单。</p>}{runtime?.lastError && <p className="notice">系统正在自动恢复：{runtime.lastError}</p>}

    <nav className="tabs">{([['brain', '大脑'], ['orders', `订单 ${openPositions.length + preparedPlans.length || ''}`], ['live', `实盘 ${openLivePositions.length + openLiveEntries.length || ''}`], ['history', '历史'], ['settings', '设置']] as const).map(([key, label]) => <button key={key} type="button" className={tab === key ? "active" : ""} onClick={() => selectTab(key)}>{label}</button>)}</nav>

    {tab === "brain" && <section className="markets">{runtime?.symbols.map((symbol) => {
      const evidence = runtime.evidence[symbol], marketFresh = Boolean(authorityOperational && evidence?.fresh && evidence?.ancillaryFresh);
      const decision = marketFresh ? runtime.decisions[symbol] : null, plan = marketFresh ? runtime.plans[symbol] : null, position = runtime.positions[symbol];
      const intent = plan?.state === "PREPARED" ? plan : decision;
      const status = position?.status === "OPEN" ? "持仓中" : plan?.state === "PREPARED" ? "等待进场" : intent ? "发现机会" : evidence?.warmup < 30 ? `预热 ${evidence?.warmup ?? 0}/30` : "继续观察";
      return <article className="market" key={symbol}><div className="market-title"><div><small>{symbol.replace("_", "/")}</small><h2>{marketFresh ? status : "数据恢复中"}</h2></div><strong>{marketFresh ? num(evidence?.midpoint, 5) : "—"}</strong></div>
        <div className="plain-answer"><small>系统判断</small><b>{intent ? `${sideText(intent.side)} · ${stateText[intent.marketState]}` : "暂时没有值得执行的方向"}</b><p>{waitReason(runtime, marketFresh, symbol)}</p></div>
        {intent && <div className="trade-levels"><div><small>准备进场</small><b>{num(intent.entryTrigger, 5)}</b></div><div><small>判断错误就退出</small><b>{num(intent.invalidation, 5)}</b></div><div><small>当前目标</small><b>{num(intent.target, 5)}</b></div><div><small>预计盈亏比</small><b>{num(rr(intent.entryTrigger, intent.invalidation, intent.target), 2)} : 1</b></div></div>}
        <div className="execution"><small>执行方式</small><b>{position?.status === "OPEN" ? "已按实时价格触发，正在持仓" : plan?.state === "PREPARED" ? liveEnabled ? `${plan.marketState === "BREAKOUT" ? "Gate 价格触发" : "Gate 限价"}挂单等待 ${num(plan.entryTrigger, 5)}` : `模拟等待实时价格到达 ${num(plan.entryTrigger, 5)}` : intent ? "方向已形成，等待系统建立进场计划" : "继续等待完整机会"}</b></div>
        <CandleChart symbol={symbol} evidence={evidence} decision={intent} position={position?.status === "OPEN" ? position : null} />
        <details><summary>查看判断依据</summary><p>{intent?.reason.join("；") || "尚未形成完整判断"}</p><div className="targets"><span>上方吸引区：{num(evidence?.topLong?.price, 5)} · {sourceText[evidence?.topLong?.source ?? ""] ?? "识别中"}</span><span>下方吸引区：{num(evidence?.topShort?.price, 5)} · {sourceText[evidence?.topShort?.source ?? ""] ?? "识别中"}</span></div></details>
      </article>;
    }) ?? <div className="empty">正在读取市场数据…</div>}</section>}

    {tab === "orders" && <section className="panel-list">{!openPositions.length && !preparedPlans.length && <div className="empty"><b>当前没有模拟订单</b><p>出现合适位置后会先显示准备计划；真实订单请进入底部「实盘」。</p></div>}
      {openPositions.map(({ symbol, position }) => <OrderCard key={symbol} symbol={symbol} side={position.side} label="持仓中" state={position.scenario} notional={position.notional} equity={runtime?.equity ?? INITIAL_EQUITY} values={[["进场", position.entryPrice], ["保护价", position.currentStop], ["动态目标", position.currentTarget], ["计划风险", position.plannedRisk]]} />)}
      {preparedPlans.map(({ symbol, plan }) => <OrderCard key={symbol} symbol={symbol} side={plan.side} label="等待触发" state={plan.marketState} notional={plan.notional} equity={runtime?.equity ?? INITIAL_EQUITY} values={[["触发进场", plan.entryTrigger], ["结构止损", plan.invalidation], ["目标", plan.target], ["计划风险", plan.plannedRisk]]} />)}
    </section>}

    {tab === "live" && <LiveCenter auth={auth} runtime={runtime} live={live} liveEnabled={liveEnabled} liveBusy={liveBusy} liveActionError={liveActionError} positions={openLivePositions} entries={openLiveEntries} onLogin={() => setShowLogin(true)} onToggle={liveControl} onCleanup={() => void setLiveMode(false)} />}

    {tab === "history" && <section className="history-panel"><div className="section-heading"><div><h2>最近模拟交易</h2><p>只展示真实产生过的记录，不填充示例数据。</p></div><span>{history.filter((item) => item.status === "CLOSED").length} 笔已结束</span></div>
      {!history.length ? <div className="empty"><b>还没有历史交易</b><p>产生第一笔模拟交易后会自动出现在这里。</p></div> : <div className="history-table">{history.map((item) => <article key={item.id}><div><span className={`side ${item.side.toLowerCase()}`}>{item.side === "LONG" ? "多" : "空"}</span><div><b>{item.symbol.replace("_", "/")}</b><small>{time(item.entryAt)} · {stateText[item.marketState]}</small></div></div><div><small>进场 / 出场</small><b>{num(item.entryPrice, 5)} / {num(item.exitPrice, 5)}</b></div><div><small>结果</small><b className={(item.realizedPnl ?? 0) >= 0 ? "positive" : "negative"}>{item.status === "OPEN" ? "持仓中" : `${signed(item.realizedPnl ?? 0)} U`}</b></div><div><small>结束原因</small><b>{item.status === "OPEN" ? "尚未结束" : exitText[item.exitReason ?? ""] ?? item.exitReason ?? "已结束"}</b></div></article>)}</div>}
    </section>}

    {tab === "settings" && <section className="settings-panel"><button className="setting-row" type="button" onClick={() => auth.authenticated ? void fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(() => { setAuth({ ...auth, authenticated: false }); setRuntime(runtime ? { ...runtime, live: undefined } : runtime); }) : setShowLogin(true)}><div><b>所有者账户</b><p>{auth.authenticated ? "已通过安全会话验证；退出登录不会改变实盘开关。" : "登录后才可以查看真实账户并操作实盘开关。"}</p></div><span className={`setting-value ${auth.authenticated ? "online" : "locked"}`}>{auth.authenticated ? "owner · 退出 ›" : "登录 ›"}</span></button><button className="setting-row" type="button" disabled={liveBusy} onClick={liveControl}><div><b>实盘交易开关</b><p>{liveEnabled ? "关闭后撤销未成交入场挂单；已有仓位继续保护并按策略退出。" : "开启后，实盘完全复用当前 BTC/ETH/SOL 策略和 5% 总风险限制。"}</p></div><span className={`setting-value ${liveEnabled && live?.operational ? "online" : "locked"}`}>{liveBusy ? "处理中…" : !auth.authenticated ? "需登录 ›" : liveEnabled ? live?.operational ? "已开启 ›" : "已开启·待恢复 ›" : "已关闭 ›"}</span></button>{auth.authenticated && <><Setting title="Gate 实盘账户" detail={`可用 ${num(live?.available, 2)} U · ${openLivePositions.length} 个真实持仓`} value={live?.equity != null ? `${num(live.equity, 2)} U` : "连接中"} tone={live?.credentialConfigured ? "online" : "locked"}/><Setting title="实盘执行状态" detail={live?.lastError || "突破预挂触发单；反转/震荡预挂限价单。"} value={live?.operational ? "可开仓" : liveEnabled ? "暂停新单" : "已关闭"} tone={live?.operational ? "online" : "locked"}/></>}<Setting title="最大组合风险" detail="模拟与实盘均包含手续费和压力滑点，结构止损只允许收紧。" value="5%"/><Setting title="持仓时间与止盈" detail="不固定时间，不固定止盈；目标变化时动态退出。" value="动态"/><Setting title="系统状态" detail="页面关闭后服务器仍然持续运行。" value={healthy ? "正常" : "恢复中"} tone={healthy ? "online" : "locked"}/><p className="last-update">最近后台成功：{time(runtime?.lastSuccessAt)}{live?.lastSyncAt ? ` · 实盘核对：${time(live.lastSyncAt)}` : ""}</p></section>}

    {showLogin && <LoginModal configured={auth.configured} onClose={() => setShowLogin(false)} onSuccess={(session) => { setAuth(session); setShowLogin(false); location.reload(); }} />}
    {showLiveConfirm && <div className="modal-backdrop" onClick={() => !liveBusy && setShowLiveConfirm(false)}><section className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><span className="lock-icon">实</span><h2>确认开启实盘</h2><p>开启后，当前系统形成的 BTC、ETH、SOL 计划会自动提交 Gate 合约挂单，成交后使用真实资金，并立即建立结构止损。</p><p>实盘仍遵守账户总风险不超过 5%；只有你登录后可以改变这个开关。</p>{liveActionError && <p className="form-error">{liveActionError}</p>}<div className="modal-actions"><button className="secondary" type="button" disabled={liveBusy} onClick={() => setShowLiveConfirm(false)}>取消</button><button type="button" disabled={liveBusy} onClick={() => void setLiveMode(true)}>{liveBusy ? "正在核对 Gate…" : "确认开启实盘"}</button></div></section></div>}
  </main>;
}

function LiveCenter({ auth, runtime, live, liveEnabled, liveBusy, liveActionError, positions, entries, onLogin, onToggle, onCleanup }: {
  auth: AuthSession;
  runtime: Runtime | null;
  live: LiveRuntime | undefined;
  liveEnabled: boolean;
  liveBusy: boolean;
  liveActionError: string | null;
  positions: LivePosition[];
  entries: LiveEntry[];
  onLogin: () => void;
  onToggle: () => void;
  onCleanup: () => void;
}) {
  const [view, setView] = useState<"account" | "orders" | "api">("account");
  const [credential, setCredential] = useState<CredentialStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [credentialNotice, setCredentialNotice] = useState<string | null>(null);
  const [verification, setVerification] = useState<CredentialVerification | null>(null);

  useEffect(() => {
    let active = true;
    if (!auth.authenticated) return () => { active = false; };
    void fetch("/api/live/credentials", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json() as { credential?: CredentialStatus; error?: string };
      if (!response.ok) throw new Error(payload.error || "读取 API 状态失败");
      if (active) setCredential(payload.credential ?? null);
    }).catch((failure) => { if (active) setCredentialError(failure instanceof Error ? failure.message : "读取失败"); });
    return () => { active = false; };
  }, [auth.authenticated]);

  const saveCredential = async (event: FormEvent) => {
    event.preventDefault(); setCredentialBusy(true); setCredentialError(null); setCredentialNotice(null); setVerification(null);
    try {
      if (liveEnabled) throw new Error("请先关闭实盘开关，再更换 API");
      const response = await fetch("/api/live/credentials", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey, apiSecret }) });
      const payload = await response.json() as { credential?: CredentialStatus; verification?: CredentialVerification; error?: string };
      if (!response.ok || !payload.credential) throw new Error(payload.error || "API 保存失败");
      setCredential(payload.credential); setVerification(payload.verification ?? null); setApiKey(""); setApiSecret("");
      setCredentialNotice("Gate 验证通过并已加密保存；实盘开关保持关闭。下一次开启会使用这组新 API。");
    } catch (failure) { setCredentialError(failure instanceof Error ? failure.message : "API 保存失败"); }
    finally { setCredentialBusy(false); }
  };

  const deleteCredential = async () => {
    if (!window.confirm("确认删除已保存的 Gate API？删除后系统不能读取账户或管理实盘订单。")) return;
    setCredentialBusy(true); setCredentialError(null); setCredentialNotice(null); setVerification(null);
    try {
      const response = await fetch("/api/live/credentials", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
      const payload = await response.json() as { credential?: CredentialStatus; error?: string };
      if (!response.ok || !payload.credential) throw new Error(payload.error || "API 删除失败");
      setCredential(payload.credential); setCredentialNotice("已删除加密 API，实盘保持关闭。");
    } catch (failure) { setCredentialError(failure instanceof Error ? failure.message : "API 删除失败"); }
    finally { setCredentialBusy(false); }
  };

  if (!auth.authenticated) return <section className="live-center"><div className="empty live-lock"><b>登录后查看实盘</b><p>实盘账户、真实订单和 Gate API 管理只对所有者开放。</p><button className="primary-action" type="button" onClick={onLogin}>所有者登录</button></div></section>;

  const occupiedMargin = [...positions, ...entries].reduce((sum, item) => sum + item.margin, 0);
  const liveRisk = [...positions, ...entries].reduce((sum, item) => sum + item.plannedRisk, 0);
  const liveFloating = positions.reduce((sum, position) => {
    const mark = runtime?.evidence[position.symbol]?.midpoint ?? position.entryPrice;
    return sum + position.notional * (mark - position.entryPrice) / Math.max(position.entryPrice, 1e-9) * (position.side === "LONG" ? 1 : -1);
  }, 0);
  const connectionText = !credential?.configured ? "未保存 API" : live?.lastError ? "连接异常" : live?.lastSyncAt ? "已连接 Gate" : "等待首次核对";

  return <section className="live-center">
    <div className="live-subnav">{([['account', '实盘账户'], ['orders', `实盘订单 ${positions.length + entries.length || ''}`], ['api', 'API 管理']] as const).map(([key, label]) => <button type="button" key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>{label}</button>)}</div>
    {view === "account" && <>
      <section className="live-status-card"><div><small>Gate 实盘状态</small><h2>{liveEnabled ? live?.operational ? "实盘已开启" : "实盘已开启 · 等待恢复" : "实盘已关闭"}</h2><p>{live?.lastError || connectionText}</p></div><div className="live-actions"><button type="button" disabled={liveBusy || !credential?.configured || liveEnabled} className="danger-outline" onClick={onCleanup}>撤销系统遗留挂单</button><button type="button" disabled={liveBusy || !credential?.configured} className={liveEnabled ? "danger-action" : "primary-action"} onClick={onToggle}>{liveBusy ? "正在与 Gate 核对…" : liveEnabled ? "关闭实盘并撤单" : "开启实盘"}</button></div></section>
      {liveActionError && <p className="form-error">{liveActionError}</p>}
      {!liveEnabled && <p className="cleanup-help">如果 Gate 仍显示以前由本系统创建的挂单，点“撤销系统遗留挂单”。只撤销带本系统标签的入场单，不会撤销你的手工订单。</p>}
      <section className="summary four live-summary"><article><small>真实账户权益</small><strong>{num(live?.equity, 2)} U</strong><p>{connectionText}</p></article><article><small>可用保证金</small><strong>{num(live?.available, 2)} U</strong><p>Gate 返回的可用余额</p></article><article><small>持仓浮盈亏</small><strong className={liveFloating >= 0 ? "positive" : "negative"}>{signed(liveFloating)} U</strong><p>{positions.length} 个真实持仓</p></article><article><small>已计划风险</small><strong>{num(liveRisk, 2)} U</strong><p>保证金约 {num(occupiedMargin, 2)} U · 上限 5%</p></article></section>
      <div className="live-facts"><Setting title="API 状态" detail={credential?.configured ? `密钥 ${credential.keyHint ?? "已加密"} · ${time(credential.lastVerifiedAt)}` : "进入 API 管理保存或更换"} value={credential?.configured ? "已验证" : "未配置"} tone={credential?.configured ? "online" : "locked"}/><Setting title="最近账户核对" detail="页面关闭后后台仍按策略运行。" value={time(live?.lastSyncAt)} tone={live?.lastSyncAt ? "online" : "locked"}/></div>
    </>}
    {view === "orders" && <section className="panel-list live-orders">{!positions.length && !entries.length && <div className="empty"><b>当前没有实盘订单</b><p>开启实盘后，系统会在 Gate 预挂当前策略形成的真实合约订单。</p></div>}{positions.map((position) => <OrderCard key={`live:${position.symbol}`} symbol={position.symbol} side={position.side} label="实盘持仓" state={position.scenario} notional={position.notional} equity={live?.equity ?? INITIAL_EQUITY} mode="LIVE" leverage={position.leverage} margin={position.margin} values={[["真实进场", position.entryPrice], ["交易所止损", position.stopPrice ?? position.currentStop], ["动态目标", position.currentTarget], ["实际计划风险", position.plannedRisk]]} />)}{entries.map((entry) => <OrderCard key={`live:${entry.symbol}:entry`} symbol={entry.symbol} side={entry.side} label={entry.status === "ERROR" ? "异常待核对" : entry.kind === "PRICE_TRIGGER" ? "实盘触发挂单" : "实盘限价挂单"} state={entry.scenario} notional={entry.notional} equity={live?.equity ?? INITIAL_EQUITY} mode="LIVE" leverage={entry.leverage} margin={entry.margin} note={entry.lastError ?? undefined} values={[["挂单进场", entry.trigger], ["结构止损", entry.invalidation], ["动态目标", entry.target], ["实际计划风险", entry.plannedRisk]]} />)}</section>}
    {view === "api" && <section className="credential-panel"><div className="section-heading"><div><h2>Gate 实盘 API</h2><p>新 API 验证成功后会加密覆盖旧 API，页面永远不回显 Secret。</p></div><span className={credential?.configured ? "positive" : "negative"}>{credential?.configured ? "已保存" : "未保存"}</span></div><div className="credential-current"><div><small>当前 API</small><b>{credential?.keyHint ?? "尚未配置"}</b><p>{credential?.configured ? `最后验证 ${time(credential.lastVerifiedAt)} · Gate 实盘` : "填写下方两项后保存"}</p></div>{credential?.configured && <button className="danger-outline" type="button" disabled={credentialBusy || liveEnabled || positions.length > 0 || entries.length > 0} onClick={() => void deleteCredential()}>删除 API</button>}</div><form className="credential-form" onSubmit={saveCredential}><label><span>API Key</span><input value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} placeholder="填写新的 Gate API Key" /></label><label><span>API Secret</span><input type="password" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} autoComplete="new-password" spellCheck={false} placeholder="填写新的 Gate API Secret" /></label><p className="credential-help">只使用 Gate USDT 永续合约读取与交易权限；不要开启提现权限。保存 API 不会开启实盘。API 过期时直接验证并覆盖；只有 Gate 已无持仓和挂单时才允许删除。</p>{liveEnabled && <p className="form-error">请先关闭实盘开关，才可以更换或删除 API。</p>}{credentialError && <p className="form-error">{credentialError}</p>}{credentialNotice && <p className="form-success">{credentialNotice}</p>}{verification && <p className="credential-check">已核对：权益 {num(verification.equity, 2)} U · 持仓 {verification.positions} · 普通挂单 {verification.orders} · 条件单 {verification.conditionalOrders}</p>}<button className="primary-action" type="submit" disabled={credentialBusy || liveEnabled || apiKey.trim().length < 8 || apiSecret.trim().length < 8}>{credentialBusy ? "正在验证 Gate…" : credential?.configured ? "验证并更换 API" : "验证并保存 API"}</button></form></section>}
  </section>;
}

function OrderCard({ symbol, side, label, state, notional, equity, values, mode = "PAPER", leverage: actualLeverage, margin: actualMargin, note }: { symbol: string; side: Side; label: string; state: MarketState; notional: number; equity: number; values: [string, number][]; mode?: "PAPER" | "LIVE"; leverage?: number; margin?: number; note?: string }) {
  const leverage = actualLeverage ?? displayLeverage(notional, equity), margin = actualMargin ?? notional / leverage;
  return <article className={`order-card ${mode === "LIVE" ? "live-card" : ""}`}><div><span className={`side ${side.toLowerCase()}`}>{side === "LONG" ? "多" : "空"}</span><div><h3>{symbol.replace("_", "/")} · {label}</h3><p>{stateText[state]} · {mode === "LIVE" ? "Gate 真实合约" : "PAPER 模拟合约"}</p></div></div><strong style={{ textAlign: "right" }}><small style={{ display: "block", color: "var(--muted)", fontSize: 10 }}>合约名义价值</small>{num(notional, 2)} U</strong><dl>{values.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{num(value, name.includes("风险") ? 2 : 5)}{name.includes("风险") ? " U" : ""}</dd></div>)}<div><dt>{mode === "LIVE" ? "真实杠杆" : "模拟杠杆"}</dt><dd>{leverage}×</dd></div><div><dt>{mode === "LIVE" ? "实际保证金" : "预计保证金"}</dt><dd>{num(margin, 2)} U</dd></div></dl><p style={{ gridColumn: "1 / -1", margin: 0, color: note ? "var(--red)" : "var(--muted)", fontSize: 11 }}>{note ?? (mode === "LIVE" ? "真实订单由 Gate 托管；结构止损为 reduce-only，不能反向开仓。" : "触发时按最新价格、权益和组合风险重新计算。")}</p></article>;
}

function LoginModal({ configured, onClose, onSuccess }: { configured: boolean; onClose: () => void; onSuccess: (session: AuthSession) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setLoginError(null);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner", password }) });
      const payload = await response.json() as { error?: string; authenticated?: boolean; username?: string };
      if (!response.ok || !payload.authenticated) throw new Error(payload.error || "登录失败");
      setPassword(""); onSuccess({ configured: true, authenticated: true, username: payload.username ?? "owner" });
    } catch (failure) { setLoginError(failure instanceof Error ? failure.message : "登录失败"); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onClick={() => !busy && onClose()}><form className="modal" role="dialog" aria-modal="true" onSubmit={submit} onClick={(event) => event.stopPropagation()}><span className="lock-icon">登</span><h2>所有者登录</h2><p>账户固定为 owner。密码只发送给后台验证，不保存到浏览器，也不会显示 Gate API 密钥。</p><label className="login-field"><span>账户</span><input value="owner" readOnly autoComplete="username" /></label><label className="login-field"><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus /></label>{!configured && <p className="form-error">后台访问码尚未配置。</p>}{loginError && <p className="form-error">{loginError}</p>}<div className="modal-actions"><button className="secondary" type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" disabled={busy || !configured || password.length < 16}>{busy ? "登录中…" : "登录"}</button></div></form></div>;
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
