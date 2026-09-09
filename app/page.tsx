"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { directionalReturnRate, marginReturnRate, unrealizedPnl } from "../lib/position-metrics.ts";
import { runtimeReady } from "../lib/runtime-health.ts";

type Side = "LONG" | "SHORT";
type MarketState = "BREAKOUT" | "REVERSAL" | "RANGE";
type Zone = { price: number; score: number; source: "BOOK" | "STOP_POOL" | "LIQUIDATION" };
type RouteStage = "LOCAL_TO_NODE" | "AT_NODE" | "NODE_TO_NEXT";
type RouteKind = "LOCAL_BREAKOUT" | "INTERNAL_ROTATION" | "BREAKOUT_RETEST" | "FAILED_BREAKOUT_REVERSAL" | "EDGE_REJECTION" | "NODE_CONTINUATION";
type Decision = { marketState: MarketState; side: Side; entryTrigger: number; invalidation: number; target: number; economicTarget?: number; targetIdentity?: string; score: number; reason: string[]; routeId?: string; routeStage?: RouteStage; routeKind?: RouteKind; targetTimeframe?: "15m" | "1h" | "4h"; nextTarget?: number | null; confirmationScore?: number; fakeoutRisk?: number; activationDistanceRate?: number; rangeBoundary?: number; rangeBuffer?: number; sweepExtreme?: number; reclaimSource?: "COMPLETED_MINUTE" | "FAST_BOOK"; reclaimStrength?: number };
type Plan = Decision & { state: "PREPARED" | "TRIGGERED" | "CANCELLED"; plannedRisk: number; notional: number; expiresAt: number; leverage?: number; margin?: number; economicTarget?: number; breakoutSignalCount?: number; realtimeSignalCount?: number; latestConfirmationScore?: number; latestFakeoutRisk?: number; cancelReason?: string; cancelledAt?: number; invalidationSignalCount?: number; invalidationSignalReason?: "TARGET_GONE_CANCEL" | "ACTIVATION_LOST_CANCEL" | "ROUTE_WEAK_CANCEL" };
type LiquidityRoute = { id: string; side: Side; kind: RouteKind; stage: RouteStage; entryTrigger: number; invalidation: number; target: number; targetTimeframe: "15m" | "1h" | "4h"; nextTarget: number | null; confirmationScore: number; fakeoutRisk: number; score: number; executableNow: boolean; blockReason?: string; reason: string[]; rangeBoundary?: number; sweepExtreme?: number; reclaimStrength?: number };
type RangeBand = { lower: number; upper: number; widthRate: number; quality: number; observedAt?: number; id?: string; role?: "PARENT" | "CHILD"; breakState?: "INSIDE" | "BROKEN_UP" | "BROKEN_DOWN" };
type RangeStructure = RangeBand & { child?: RangeBand | null };
type Position = { side: Side; scenario: MarketState; status: "OPEN" | "CLOSED"; entryAt?: number; entryPrice: number; initialStop: number; currentStop: number; currentTarget: number; targetIdentity?: string; plannedRisk: number; notional: number; routeId?: string; routeKind?: RouteKind; rangeBoundary?: number; rangeBuffer?: number; sweepExtreme?: number; reclaimStrength?: number; rangeAcceptanceCount?: number; exitAt?: number; exitPrice?: number; realizedPnl?: number; exitReason?: string; exitSignalCount?: number; exitSignalReason?: string };
type LiveEntry = { planId: string; symbol: string; side: Side; scenario: MarketState; kind: "PRICE_TRIGGER" | "LIMIT" | "MARKET"; status: string; trigger: number; invalidation: number; target: number; plannedRisk: number; notional: number; leverage: number; margin: number; lastError: string | null };
type LivePosition = Position & { id: string; symbol: string; exchangeSize: number; leverage: number; margin: number; stopPrice: number | null; exitRequestedAt: number | null };
type LiveEntrySkip = { planId: string; symbol: string; code: "MIN_CONTRACT" | "MARGIN" | "RISK_CAP" | "ECONOMICS"; reason: string; observedAt: number };
type LiveRuntime = { requestedEnabled: boolean; operational: boolean; changedAt: number | null; lastSyncAt: number | null; lastError: string | null; equity: number | null; available: number | null; credentialConfigured: boolean; entries: Record<string, LiveEntry | null>; positions: Record<string, LivePosition | null>; entrySkips: Record<string, LiveEntrySkip | null> };
type RadarCandidate = { id: string; symbol: string; side: Side; strength: number; moveRate: number; movementMultiple: number; volume24hUsd: number; confirmations: number; firstSeenAt: number; observedAt: number; kind: "NEW_MONEY" | "SQUEEZE" | "LIQUIDATION" | "PRICE_SHOCK" };
type EntryAssessment = { accepted: boolean; blocker: string | null; alignedFlow: number; spreadBps: number; extensionRate: number; costShare: number; conservativeWinRate: number; expectedReturnRate: number; qualityScore: number; qualityRequired: number; qualityEvidence: string[] };
type StrategyFamily = "TREND" | "RANGE" | "COMPRESSION" | "EVENT";
type StrategyLane = "SHADOW" | "TRIAL" | "VERIFIED";
type TradeLane = StrategyLane | "PORTFOLIO";
type CandidateChannel = "TREND" | "RANGE" | "COMPRESSION" | "ANOMALY";
type RegimeKind = "TREND" | "RANGE" | "COMPRESSION" | "EXPANSION" | "UNCERTAIN";
type EntryStyle = "CONFIRM" | "RETEST";
type ExitProfile = "FAST" | "STRUCTURE";
type ArenaTradeContext = { channel: CandidateChannel; regime: RegimeKind; anomalyKind: RadarCandidate["kind"] | null;
  entryStyle: EntryStyle; exitProfile: ExitProfile; candidateScore: number; trendRate: number; trendEfficiency: number;
  volatilityRatio: number; rangePosition: number; openInterestChangeRate: number; volume24hUsd: number; fundingRate: number;
  alignedFlow: number; confirmation: number;
  fakeoutRisk: number; rangeId: string | null; modeledCostRate: number };
type ArenaTrade = { id: string; strategyId: string; strategyName: string; family: StrategyFamily; lane: TradeLane; eventId: string;
  symbol: string; side: Side; status: "OPEN" | "CLOSED"; openedAt: number; closedAt: number | null; entryPrice: number;
  stopPrice: number; targetPrice: number; exitPrice: number | null; outcome: "TARGET" | "STOP" | "TIMEOUT" | null;
  grossReturnRate: number | null; netReturnRate: number | null; netPnl: number | null; notional: number;
  maxFavorableRate: number; maxAdverseRate: number; lastPrice: number; selectedForPortfolio: boolean; reason: string; context: ArenaTradeContext };
type StrategyScore = { id: string; name: string; family: StrategyFamily; channel: CandidateChannel; description: string;
  entryStyle: EntryStyle; exitProfile: ExitProfile; lane: StrategyLane;
  shadowResolved: number; shadowWins: number; shadowNetReturnRate: number; paperResolved: number; paperWins: number;
  paperNetReturnRate: number; paperEquity: number; consecutivePaperLosses: number; stageResults: number[];
  stageEvents: string[]; stageSymbols: string[];
  transitions: number; lastTransitionAt: number | null };
type StrategyTransition = { id: string; strategyId: string; strategyName: string; from: StrategyLane; to: StrategyLane; at: number; reason: string };
type StrategyArena = { version: 2; startedAt: number; catalogSize: number; playbookCount: number; shadowCount: number;
  trialCount: number; verifiedCount: number; paperCount: number; openShadow: ArenaTrade[]; openPaper: ArenaTrade[];
  portfolioOpen: ArenaTrade[]; portfolioEquity: number; portfolioResolved: number; portfolioWins: number;
  portfolioGrossPnl: number; portfolioCosts: number; strategies: StrategyScore[]; recentShadow: ArenaTrade[];
  recentPaper: ArenaTrade[]; recentPortfolio: ArenaTrade[]; transitions: StrategyTransition[];
  rules: { trialPromotionWins: number; verifiedEvents: number; verifiedSymbols: number; verifiedProfitFactor: number;
    demotionLosses: number; frictionFloorRate: number; maxHoldMs: number } };
type RegimeCandidate = { id: string; symbol: string; channel: CandidateChannel; regime: RegimeKind; side: Side; score: number;
  referencePrice: number; moveRate: number; trendRate: number; trendEfficiency: number; volatilityRatio: number;
  rangePosition: number; volume24hUsd: number; openInterestChangeRate: number; confirmations: number; firstSeenAt: number;
  observedAt: number; anomalyKind: RadarCandidate["kind"] | null };
type MarketRegimes = { version: 1; lastUpdatedAt: number | null; tracked: number; warmed: number;
  counts: Record<RegimeKind, number>; candidates: RegimeCandidate[] };
type Runtime = {
  version: string; mode: "PAPER"; state: string; stale: boolean; generatedAt: number; lastSuccessAt: number | null; lastError: string | null; symbols: string[]; equity: number; dailyStartEquity?: number;
  decisions: Record<string, Decision | null>; routes: Record<string, LiquidityRoute[]>; plans: Record<string, Plan | null>; positions: Record<string, Position | null>; authorityReady: boolean;
  evidence: Record<string, { midpoint: number; observedAt: number; warmup: number; fresh: boolean; ancillaryFresh: boolean; entryReady?: boolean; optionalFresh?: boolean; recoveryFreshCount?: number; suspensionReason?: string | null; topLong: Zone | null; topShort: Zone | null; absorption: number; range15m: RangeStructure | null }>;
  entryAssessments?: Record<string, EntryAssessment | null>;
  feedFailures?: Record<string, { count: number; retryAt: number; suspendedSince?: number | null; totalFailures?: number; recoveries?: number; lastFailureAt?: number | null; lastError?: string | null; maxObservedLagMs?: number }>;
  limits: { maxOpenPositions: number; warmupSnapshots?: number; loopMs?: number; radarMs?: number; scannedMarkets?: number; maxAncillaryConcurrency?: number };
  liveMode: { requestedEnabled: boolean; operational: boolean };
  radar?: { scanned: number; lastScanAt: number | null; candidates: RadarCandidate[] };
  marketRegimes?: MarketRegimes;
  strategyArena?: StrategyArena;
  live?: LiveRuntime;
};
type AuthSession = { configured: boolean; authenticated: boolean; username: string };
type CredentialStatus = { configured: boolean; environment: string | null; keyHint: string | null; gateUserId: string | null; status: string; lastVerifiedAt: number | null; lastError: string | null; updatedAt: number | null };
type CredentialVerification = { equity: number; available: number; positions: number; orders: number; conditionalOrders: number; checkedAt: number };
type Tab = "brain" | "orders" | "live" | "history" | "settings";
type LiveView = "account" | "orders" | "api";
type PositionView = { entryAt?: number; entryPrice: number; stopPrice: number; targetPrice: number; markPrice?: number; markAt?: number; fresh: boolean };

const INITIAL_EQUITY = 1_000;
const RUNTIME_REQUEST_TIMEOUT_MS = 30_000;
const RUNTIME_DISPLAY_TTL_MS = 90_000;
const stateText: Record<string, string> = { BREAKOUT: "突破", REVERSAL: "反转", RANGE: "震荡", LIVE: "运行中", WARMING: "预热中", DEGRADED: "部分数据恢复中", RECONNECTING: "重新连接中", RECOVERY_REQUIRED: "需要恢复", STARTING: "启动中" };
const num = (value: number | null | undefined, digits = 3) => Number.isFinite(value) ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "—";
const signed = (value: number, digits = 2) => `${value >= 0 ? "+" : ""}${num(value, digits)}`;
const time = (value: number | null | undefined) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
const regimeLabel = (kind: RegimeKind) => ({ TREND: "趋势", RANGE: "震荡", COMPRESSION: "压缩", EXPANSION: "扩张/异动", UNCERTAIN: "不明确" })[kind];
const channelLabel = (channel: CandidateChannel) => ({ TREND: "平稳趋势", RANGE: "区间边缘", COMPRESSION: "波动压缩", ANOMALY: "异动事件" })[channel];
const laneLabel = (lane: StrategyLane | "PORTFOLIO") => ({ SHADOW: "影子候选", TRIAL: "试用筛选", VERIFIED: "稳定筛选", PORTFOLIO: "1000 U模拟账户" })[lane];
const displayLeverage = (notional: number, equity: number) => [1, 2, 3, 5, 10, 20, 30, 40, 50].find((value) => notional / value <= equity * .12) ?? 50;
const friendlyLiveError = (value: string | null | undefined) => !value ? null
  : value.includes("AUTO_INVALID_PARAM_TRIGGER_EXPIRATION")
    ? "Gate 拒绝了旧版触发单的有效期格式；系统已修复并会重新核对。"
    : value;

export default function Home() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [clock, setClock] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("brain");
  const [auth, setAuth] = useState<AuthSession>({ configured: true, authenticated: false, username: "owner" });
  const [showLogin, setShowLogin] = useState(false);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveActionError, setLiveActionError] = useState<string | null>(null);
  const tabScroll = useRef<Record<Tab, number>>({ brain: 0, orders: 0, live: 0, history: 0, settings: 0 });
  const selectTab = (next: Tab) => {
    if (next === tab) return;
    tabScroll.current[tab] = window.scrollY;
    setTab(next);
  };

  useLayoutEffect(() => {
    window.scrollTo({ top: tabScroll.current[tab], left: 0, behavior: "auto" });
  }, [tab]);

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
    const visibility = () => { if (!document.hidden) void read(); else controller?.abort(); };
    void read();
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
      if (payload.live) setRuntime((current) => current ? { ...current, live: payload.live, liveMode: { requestedEnabled: payload.live!.requestedEnabled, operational: payload.live!.operational } } : current);
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    } catch (failure) { setLiveActionError(failure instanceof Error ? failure.message : "操作失败"); }
    finally { setLiveBusy(false); }
  };

  const live = runtime?.live;
  const liveEnabled = Boolean(live?.requestedEnabled ?? runtime?.liveMode?.requestedEnabled);
  const openLivePositions = Object.values(live?.positions ?? {}).filter((position): position is LivePosition => position?.status === "OPEN");
  const openLiveEntries = Object.values(live?.entries ?? {}).filter((entry): entry is LiveEntry => Boolean(entry && !["FILLED", "CANCELLED"].includes(entry.status)));
  const liveEntrySkips = Object.values(live?.entrySkips ?? {}).filter((skip): skip is LiveEntrySkip => Boolean(skip));
  const liveControl = () => {
    if (!auth.authenticated) setShowLogin(true);
    else if (liveEnabled) void setLiveMode(false);
    else if (window.confirm("确认开启实盘？开启后只复制此刻以后由1000 U模拟账户新开的订单，不会追单复制当前已有模拟持仓。")) void setLiveMode(true);
  };

  const responseFresh = runtime != null && clock - receivedAt < RUNTIME_DISPLAY_TTL_MS && clock - runtime.generatedAt < RUNTIME_DISPLAY_TTL_MS;
  const healthy = runtimeReady(runtime, responseFresh);
  const authorityOperational = runtime != null && runtime.authorityReady && !runtime.stale;
  const arena = runtime?.strategyArena;
  const openShadow = arena?.openShadow ?? [];
  const portfolioOpen = arena?.portfolioOpen ?? [];
  const portfolioHistory = arena?.recentPortfolio ?? [];
  const portfolioFloating = portfolioOpen.reduce((sum, trade) => {
    const mark = runtime?.evidence[trade.symbol]?.midpoint ?? trade.lastPrice;
    const direction = trade.side === "LONG" ? 1 : -1;
    return sum + trade.notional * (direction * (mark - trade.entryPrice) / Math.max(trade.entryPrice, 1e-9) - trade.context.modeledCostRate);
  }, 0);
  const portfolioAccountEquity = (arena?.portfolioEquity ?? INITIAL_EQUITY) + portfolioFloating;
  const portfolioPnl = portfolioAccountEquity - INITIAL_EQUITY;
  const regimes = runtime?.marketRegimes;
  const strategyGroups = Object.values((arena?.strategies ?? []).reduce<Record<string, StrategyScore[]>>((groups, strategy) => {
    const key = strategy.id.split(":")[0];
    (groups[key] ??= []).push(strategy);
    return groups;
  }, {}));
  const feedDiagnostics = runtime?.symbols.map((symbol) => runtime.feedFailures?.[symbol]).filter(Boolean) ?? [];
  const activeFeedSuspensions = feedDiagnostics.filter((feed) => feed?.suspendedSince != null).length;
  const totalFeedFailures = feedDiagnostics.reduce((sum, feed) => sum + (feed?.totalFailures ?? 0), 0);
  const totalFeedRecoveries = feedDiagnostics.reduce((sum, feed) => sum + (feed?.recoveries ?? 0), 0);
  const maxFeedLag = feedDiagnostics.reduce((max, feed) => Math.max(max, feed?.maxObservedLagMs ?? 0), 0);
  const headline = !authorityOperational ? "行情正在恢复，模拟账户暂停新开仓" : portfolioOpen.length
    ? `1000 U模拟账户持有 ${portfolioOpen.length} 笔订单` : openShadow.length ? "策略池正在筛选下一笔模拟订单" : "识别全市场状态，等待策略触发";

  return <main>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">态</span><div><p>市场状态竞技场</p><small>Gate 全市场短线系统</small></div></div>
      <div role="status" className={`health ${healthy ? "" : "bad"}`}><span />{healthy ? "后台运行中" : error ? "页面连接中断" : runtime?.stale ? "行情重连中" : runtime ? stateText[runtime.state] ?? runtime.state : "正在连接"}</div>
    </header>

    {tab === "brain" && <>
      <section className="brain-hero"><div><p className="eyebrow">唯一模拟账户</p><h1>{headline}</h1><p className="hero-detail">影子策略只负责筛选 · 选中的下一次机会直接进入同一个1000 U账户 · 实盘开启后只复制这个账户</p></div><div className="decision-badge"><small>当前权益</small><strong>{num(portfolioAccountEquity, 2)}</strong><span>USDT</span></div></section>

      <section className="summary four">
        <article><small>模拟账户盈亏</small><strong className={portfolioPnl >= 0 ? "positive" : "negative"}>{signed(portfolioPnl)} U</strong><p>{signed(portfolioPnl / INITIAL_EQUITY * 100)}% · 已含当前持仓完整成本</p></article>
        <article><small>已完成交易</small><strong>{arena?.portfolioResolved ?? 0}</strong><p>盈利 {arena?.portfolioWins ?? 0} 笔 · 胜率 {num((arena?.portfolioResolved ?? 0) ? (arena?.portfolioWins ?? 0) / (arena?.portfolioResolved ?? 1) * 100 : 0, 1)}%</p></article>
        <article><small>累计交易成本</small><strong>{num(arena?.portfolioCosts ?? 0, 2)} U</strong><p>毛盈亏 {signed(arena?.portfolioGrossPnl ?? 0)} U</p></article>
        <article><small>当前持仓</small><strong>{portfolioOpen.length} / 3</strong><p>同一币同一机会只执行一个策略</p></article>
      </section>
      {(!responseFresh || error) && runtime && <p className="notice">手机页面更新延迟，下面保留最近一次后台状态；服务器仍独立运行，不会因此停止判断或开模拟单。</p>}{runtime?.lastError && <p className="notice">{runtime.lastError.startsWith("D1") ? `历史镜像稍后重试，不影响行情判断和开仓：${runtime.lastError}` : `系统正在自动恢复：${runtime.lastError}`}</p>}
    </>}

    <nav className="tabs">{([['brain', '模拟账户'], ['orders', `持仓 ${portfolioOpen.length || ''}`], ['live', `实盘 ${openLivePositions.length + openLiveEntries.length || ''}`], ['history', '交易记录'], ['settings', '设置']] as const).map(([key, label]) => <button key={key} type="button" className={tab === key ? "active" : ""} onClick={() => selectTab(key)}>{label}</button>)}</nav>

    <section className="radar-board" hidden={tab !== "brain"}>
      <div className="radar-board-head"><div><small>全市场状态引擎</small><b>10秒轻扫描全市场，3个位置进行2秒盘口与结构验证</b></div><span>{time(regimes?.lastUpdatedAt)}</span></div>
      <div className="regime-strip">{(["TREND", "RANGE", "COMPRESSION", "EXPANSION", "UNCERTAIN"] as RegimeKind[]).map((kind) => <article key={kind}><small>{regimeLabel(kind)}</small><strong>{regimes?.counts[kind] ?? 0}</strong></article>)}</div>
      <div className="radar-candidates">{regimes?.candidates.slice(0, 9).map((item) => <article key={`${item.id}:${item.channel}`}>
        <div><b>{item.symbol.replace("_", "/")}</b><small>{channelLabel(item.channel)}</small></div>
        <strong className={item.side === "LONG" ? "positive" : "negative"}>{item.side === "LONG" ? "偏多" : "偏空"}</strong>
        <span>{regimeLabel(item.regime)} · 评分 {num(item.score, 0)} · {item.confirmations}轮</span>
      </article>)}{!regimes?.candidates.length && <p>正在积累全市场状态基线；预热完成后会同时产生趋势、震荡、压缩和异动候选。</p>}</div>
    </section>

    <section className="playbook-list" hidden={tab !== "brain"}><div className="section-heading"><div><h2>内部策略筛选</h2><p>下面只决定哪些策略有资格给1000 U账户提供下一笔订单，本身不是账户交易。</p></div><span>{arena?.trialCount ?? 0} 试用 · {arena?.verifiedCount ?? 0} 稳定</span></div>{strategyGroups.length ? strategyGroups.map((strategies) => <PlaybookGroup key={strategies[0].id.split(":")[0]} strategies={strategies} rules={arena!.rules} />) : <div className="empty">正在读取48个策略单元…</div>}</section>

    <section className="shadow-log" hidden={tab !== "brain"}><div className="section-heading"><div><h2>影子候选记录</h2><p>每笔都按真实后续价格结算并扣除完整成本；这是晋级判断的原始记录。</p></div><span>{arena?.recentShadow.length ?? 0} 笔</span></div>{!arena?.recentShadow.length ? <div className="empty"><b>等待首批影子结果</b><p>策略满足各自条件后会在这里留下记录。</p></div> : <div className="history-table">{arena.recentShadow.slice(0, 30).map((trade) => <ArenaTradeRecord key={trade.id} trade={trade} />)}</div>}</section>
    {!!arena?.transitions.length && <section className="shadow-log" hidden={tab !== "brain"}><div className="section-heading"><div><h2>策略升降级记录</h2><p>首次净盈利进入试用模拟，连续亏损2笔退回；稳定模拟另需跨事件和跨币验证。</p></div><span>{arena.transitions.length} 次</span></div><div className="transition-list">{arena.transitions.slice(0, 20).map((item) => <article key={item.id}><div><b>{item.strategyName}</b><small>{time(item.at)}</small></div><strong>{laneLabel(item.from)} → {laneLabel(item.to)}</strong><p>{item.reason}</p></article>)}</div></section>}

    <section className="panel-list" hidden={tab !== "orders"}>
      <h2 className="order-group-title">1000 U模拟账户 <span>{num(portfolioAccountEquity, 2)} U</span></h2>
      {portfolioOpen.map((trade) => <ArenaOpenCard key={trade.id} trade={trade} mark={runtime?.evidence[trade.symbol]?.midpoint} />)}
      {!portfolioOpen.length && <div className="empty"><b>当前没有模拟订单</b><p>策略通过影子筛选后，它的下一次合格机会会直接进入这个唯一账户。</p></div>}
    </section>

    <div hidden={tab !== "live"}><LiveCenter auth={auth} runtime={runtime} live={live} liveEnabled={liveEnabled} liveBusy={liveBusy} liveActionError={liveActionError} positions={openLivePositions} entries={openLiveEntries} skips={liveEntrySkips} onLogin={() => setShowLogin(true)} onToggle={liveControl} onCleanup={() => void setLiveMode(false)} /></div>

    <section className="history-panel" hidden={tab !== "history"}><div className="section-heading"><div><h2>1000 U模拟账户交易记录</h2><p>这里只记录真正计入账户余额的订单；内部策略筛选单不会混进来。</p></div><span>累计 {arena?.portfolioResolved ?? 0} 笔</span></div>{!portfolioHistory.length ? <div className="empty"><b>还没有已完成订单</b><p>当前持仓结算后会出现在这里。</p></div> : <div className="history-table">{portfolioHistory.map((trade) => <ArenaTradeRecord key={trade.id} trade={trade} />)}</div>}</section>

    <section className="settings-panel" hidden={tab !== "settings"}>
      <button className="setting-row" type="button" onClick={() => auth.authenticated ? void fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(() => { setAuth({ ...auth, authenticated: false }); setRuntime(runtime ? { ...runtime, live: undefined } : runtime); }) : setShowLogin(true)}><div><b>所有者账户</b><p>{auth.authenticated ? "安全登录有效30天；每次打开页面自动续期。" : "登录后才可以查看真实账户并操作实盘开关。"}</p></div><span className={`setting-value ${auth.authenticated ? "online" : "locked"}`}>{auth.authenticated ? "owner · 退出 ›" : "登录 ›"}</span></button>
      <button className="setting-row" type="button" disabled={liveBusy} onClick={liveControl}><div><b>实盘交易开关</b><p>{liveEnabled ? "正在按真实账户权益比例复制1000 U模拟账户的新订单；关闭会撤销待成交入场单并停止新开仓。" : "由你手动开启；只复制开启以后出现的新模拟订单，不追单复制当前持仓。"}</p></div><span className={`setting-value ${liveEnabled ? "online" : "locked"}`}>{liveBusy ? "处理中…" : liveEnabled ? "已开启 · 关闭 ›" : "已关闭 · 开启 ›"}</span></button>
      {auth.authenticated && <><Setting title="Gate 实盘账户" detail={`可用 ${num(live?.available, 2)} U · ${openLivePositions.length} 个真实持仓`} value={live?.equity != null ? `${num(live.equity, 2)} U` : "连接中"} tone={live?.credentialConfigured ? "online" : "locked"}/><Setting title="实盘执行状态" detail={friendlyLiveError(live?.lastError) || (liveEnabled ? "只复制唯一模拟账户开启后产生的订单，并按真实权益重新计算安全仓位。" : "当前不下新单；已有系统持仓仍保留止损和对账。" )} value={live?.operational ? "复制运行中" : "已关闭"} tone={live?.operational ? "online" : "locked"}/></>}
      <Setting title="策略轮换" detail={`首笔成本后盈利进入试用模拟；连续 ${arena?.rules.demotionLosses ?? 2} 亏退回影子。稳定模拟需要 ${arena?.rules.verifiedEvents ?? 12} 个独立事件和 ${arena?.rules.verifiedSymbols ?? 4} 个币。`} value="自动" tone="online"/>
      <Setting title="模拟账户口径" detail="影子和试用记录只用于选策略；唯一1000 U账户的余额、持仓和交易记录才代表可对标的真实效果。" value="单账户" tone="online"/>
      <Setting title="数据容错" detail={`累计短时失败 ${totalFeedFailures} 次 · 自动恢复 ${totalFeedRecoveries} 次 · 最大观测延迟 ${num(maxFeedLag / 1_000, 2)} 秒`} value={activeFeedSuspensions ? `${activeFeedSuspensions}币冻结` : "正常"} tone={activeFeedSuspensions ? "locked" : "online"}/>
      <Setting title="数据覆盖" detail={`约每10秒扫描 ${regimes?.tracked ?? runtime?.limits.scannedMarkets ?? 0} 个合约并识别行情状态；趋势、震荡/压缩、异动分散使用3个两秒深度位置。影子持仓不锁位置。`} value="现有预算内" tone="online"/>
      <Setting title="页面数据" detail="交易后台按2秒循环运行；手机页面每15秒读取一次摘要。策略记录随权威检查点保存，不增加行情请求。" value="轻量" tone="online"/>
      <Setting title="系统状态" detail="交易健康只由后台权威、行情新鲜度和各币恢复状态决定；历史镜像延迟不再误报故障。" value={healthy ? "正常" : "恢复中"} tone={healthy ? "online" : "locked"}/>
      <p className="last-update">最近后台成功：{time(runtime?.lastSuccessAt)}{live?.lastSyncAt ? ` · 实盘核对：${time(live.lastSyncAt)}` : ""}</p>
    </section>

    {showLogin && <LoginModal configured={auth.configured} onClose={() => setShowLogin(false)} onSuccess={(session) => { setAuth(session); setShowLogin(false); location.reload(); }} />}
  </main>;
}

function LiveCenter({ auth, runtime, live, liveEnabled, liveBusy, liveActionError, positions, entries, skips, onLogin, onToggle, onCleanup }: {
  auth: AuthSession;
  runtime: Runtime | null;
  live: LiveRuntime | undefined;
  liveEnabled: boolean;
  liveBusy: boolean;
  liveActionError: string | null;
  positions: LivePosition[];
  entries: LiveEntry[];
  skips: LiveEntrySkip[];
  onLogin: () => void;
  onToggle: () => void;
  onCleanup: () => void;
}) {
  const [view, setView] = useState<LiveView>("account");
  const viewScroll = useRef<Record<LiveView, number>>({ account: 0, orders: 0, api: 0 });
  const [credential, setCredential] = useState<CredentialStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [credentialNotice, setCredentialNotice] = useState<string | null>(null);
  const [verification, setVerification] = useState<CredentialVerification | null>(null);
  const selectView = (next: LiveView) => {
    if (next === view) return;
    viewScroll.current[view] = window.scrollY;
    setView(next);
  };

  useLayoutEffect(() => {
    window.scrollTo({ top: viewScroll.current[view], left: 0, behavior: "auto" });
  }, [view]);

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
    return sum + unrealizedPnl(position.notional, position.side, position.entryPrice, mark);
  }, 0);
  const readableLiveError = friendlyLiveError(live?.lastError);
  const connectionText = !credential?.configured ? "未保存 API" : readableLiveError ? "连接异常" : live?.lastSyncAt ? "已连接 Gate" : "等待首次核对";

  return <section className="live-center">
    <div className="live-subnav">{([['account', '实盘账户'], ['orders', `实盘订单 ${positions.length + entries.length || ''}`], ['api', 'API 管理']] as const).map(([key, label]) => <button type="button" key={key} className={view === key ? "active" : ""} onClick={() => selectView(key)}>{label}</button>)}</div>
    {view === "account" && <>
      <section className="live-status-card"><div><small>Gate 实盘状态</small><h2>{liveEnabled ? "实盘复制已开启" : "实盘已关闭"}</h2><p>{readableLiveError || (liveEnabled ? "只复制开启后由1000 U模拟账户新开的订单；方向、止损、目标和出场保持一致，仓位按真实权益安全缩放。" : "等待你手动开启；当前不会向 Gate 提交新订单。")}</p></div><div className="live-actions"><button type="button" disabled={liveBusy || !credential?.configured || liveEnabled} className="danger-outline" onClick={onCleanup}>撤销系统遗留挂单</button><button type="button" disabled={liveBusy || !credential?.configured} className={liveEnabled ? "danger-action" : "primary-action"} onClick={onToggle}>{liveBusy ? "正在与 Gate 核对…" : liveEnabled ? "关闭实盘并撤单" : "开启实盘复制"}</button></div></section>
      {liveActionError && <p className="form-error">{liveActionError}</p>}
      {!liveEnabled && <p className="cleanup-help">如果 Gate 仍显示以前由本系统创建的挂单，点“撤销系统遗留挂单”。只撤销带本系统标签的入场单，不会撤销你的手工订单。</p>}
      <section className="summary four live-summary"><article><small>真实账户权益</small><strong>{num(live?.equity, 2)} U</strong><p>{connectionText}</p></article><article><small>可用保证金</small><strong>{num(live?.available, 2)} U</strong><p>Gate 返回的可用余额</p></article><article><small>持仓浮盈亏</small><strong className={liveFloating >= 0 ? "positive" : "negative"}>{signed(liveFloating)} U</strong><p>{positions.length} 个真实持仓</p></article><article><small>已计划风险</small><strong>{num(liveRisk, 2)} U</strong><p>保证金约 {num(occupiedMargin, 2)} U · 总上限 10%</p></article></section>
      <div className="live-facts"><Setting title="API 状态" detail={credential?.configured ? `密钥 ${credential.keyHint ?? "已加密"} · ${time(credential.lastVerifiedAt)}` : "进入 API 管理保存或更换"} value={credential?.configured ? "已验证" : "未配置"} tone={credential?.configured ? "online" : "locked"}/><Setting title="最近账户核对" detail="页面关闭后后台仍按策略运行。" value={time(live?.lastSyncAt)} tone={live?.lastSyncAt ? "online" : "locked"}/></div>
    </>}
    {view === "orders" && <section className="panel-list live-orders">{!positions.length && !entries.length && !skips.length && <div className="empty"><b>当前没有实盘订单</b><p>{liveEnabled ? "等待1000 U模拟账户产生下一笔新订单。" : "实盘关闭；开启后只复制之后产生的新模拟订单。"}</p></div>}{skips.map((skip) => <article className="live-skip-card" key={`live-skip:${skip.symbol}:${skip.planId}`}><div><small>{skip.symbol.replace("_", "/")}</small><h3>模拟信号未能实盘成交</h3></div><p>{skip.reason}</p><span>安全条件不满足，本次实盘跳过，不影响模拟账户继续记录。</span></article>)}{positions.map((position) => { const evidence = runtime?.evidence[position.symbol]; const protection = position.stopPrice ?? position.currentStop; return <OrderCard key={`live:${position.symbol}`} symbol={position.symbol} side={position.side} label="实盘复制持仓" state={position.scenario} notional={position.notional} equity={live?.equity ?? INITIAL_EQUITY} mode="LIVE" leverage={position.leverage} margin={position.margin} positionView={{ entryAt: position.entryAt, entryPrice: position.entryPrice, stopPrice: protection, targetPrice: position.currentTarget, markPrice: evidence?.midpoint, markAt: evidence?.observedAt, fresh: Boolean(evidence?.fresh) }} values={[["真实进场", position.entryPrice], ["模拟止损", position.initialStop], ["交易所保护位", protection], ["模拟目标", position.currentTarget], ["实际计划风险", position.plannedRisk]]} />; })}{entries.map((entry) => <OrderCard key={`live:${entry.symbol}:entry`} symbol={entry.symbol} side={entry.side} label={entry.status === "ERROR" ? "异常待核对" : "模拟订单复制中"} state={entry.scenario} notional={entry.notional} equity={live?.equity ?? INITIAL_EQUITY} mode="LIVE" leverage={entry.leverage} margin={entry.margin} note={friendlyLiveError(entry.lastError) ?? undefined} values={[["模拟进场参考", entry.trigger], ["模拟止损", entry.invalidation], ["模拟目标", entry.target], ["实际计划风险", entry.plannedRisk]]} />)}</section>}
    {view === "api" && <section className="credential-panel"><div className="section-heading"><div><h2>Gate 实盘 API</h2><p>新 API 验证成功后会加密覆盖旧 API，页面永远不回显 Secret。</p></div><span className={credential?.configured ? "positive" : "negative"}>{credential?.configured ? "已保存" : "未保存"}</span></div><div className="credential-current"><div><small>当前 API</small><b>{credential?.keyHint ?? "尚未配置"}</b><p>{credential?.configured ? `最后验证 ${time(credential.lastVerifiedAt)} · Gate 实盘` : "填写下方两项后保存"}</p></div>{credential?.configured && <button className="danger-outline" type="button" disabled={credentialBusy || liveEnabled || positions.length > 0 || entries.length > 0} onClick={() => void deleteCredential()}>删除 API</button>}</div><form className="credential-form" onSubmit={saveCredential}><label><span>API Key</span><input value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} placeholder="填写新的 Gate API Key" /></label><label><span>API Secret</span><input type="password" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} autoComplete="new-password" spellCheck={false} placeholder="填写新的 Gate API Secret" /></label><p className="credential-help">只使用 Gate USDT 永续合约读取与交易权限；不要开启提现权限。保存 API 不会开启实盘。API 过期时直接验证并覆盖；只有 Gate 已无持仓和挂单时才允许删除。</p>{liveEnabled && <p className="form-error">请先关闭实盘开关，才可以更换或删除 API。</p>}{credentialError && <p className="form-error">{credentialError}</p>}{credentialNotice && <p className="form-success">{credentialNotice}</p>}{verification && <p className="credential-check">已核对：权益 {num(verification.equity, 2)} U · 持仓 {verification.positions} · 普通挂单 {verification.orders} · 条件单 {verification.conditionalOrders}</p>}<button className="primary-action" type="submit" disabled={credentialBusy || liveEnabled || apiKey.trim().length < 8 || apiSecret.trim().length < 8}>{credentialBusy ? "正在验证 Gate…" : credential?.configured ? "验证并更换 API" : "验证并保存 API"}</button></form></section>}
  </section>;
}

function OrderCard({ symbol, side, label, state, notional, equity, values, mode = "PAPER", leverage: actualLeverage, margin: actualMargin, note, positionView }: { symbol: string; side: Side; label: string; state: MarketState; notional: number; equity: number; values: [string, number][]; mode?: "PAPER" | "LIVE"; leverage?: number; margin?: number; note?: string; positionView?: PositionView }) {
  const leverage = actualLeverage ?? displayLeverage(notional, equity), margin = actualMargin ?? notional / leverage;
  const mark = positionView?.markPrice;
  const pnl = positionView && mark ? unrealizedPnl(notional, side, positionView.entryPrice, mark) : null;
  const priceReturn = positionView && mark ? directionalReturnRate(side, positionView.entryPrice, mark) : null;
  const marginReturn = pnl == null ? null : marginReturnRate(pnl, margin);
  return <article className={`order-card ${mode === "LIVE" ? "live-card" : ""}`}><div><span className={`side ${side.toLowerCase()}`}>{side === "LONG" ? "多" : "空"}</span><div><h3>{symbol.replace("_", "/")} · {label}</h3><p>{stateText[state]} · {mode === "LIVE" ? "Gate 真实合约" : "PAPER 模拟合约"}</p></div></div><strong style={{ textAlign: "right" }}><small style={{ display: "block", color: "var(--muted)", fontSize: 10 }}>合约名义价值</small>{num(notional, 2)} U</strong>{positionView && <section className="position-pnl"><div><small>浮动盈亏</small><strong className={pnl == null ? "" : pnl >= 0 ? "positive" : "negative"}>{pnl == null ? "等待行情" : `${signed(pnl)} U`}</strong><span>未扣平仓成本</span></div><div><small>保证金收益率</small><strong className={marginReturn == null ? "" : marginReturn >= 0 ? "positive" : "negative"}>{marginReturn == null ? "—" : `${signed(marginReturn * 100)}%`}</strong><span>方向价格变动 {priceReturn == null ? "—" : `${signed(priceReturn * 100)}%`}</span></div><div><small>当前价格</small><strong>{num(mark, 5)}</strong><span>{positionView.fresh ? `行情 ${time(positionView.markAt)}` : "最近后台价 · 行情恢复中"}</span></div></section>}<dl>{values.map(([name, value]) => { const money = /风险|盈亏/.test(name); return <div key={name}><dt>{name}</dt><dd className={name.includes("盈亏") ? value >= 0 ? "positive" : "negative" : ""}>{num(value, money ? 2 : 5)}{money ? " U" : ""}</dd></div>; })}<div><dt>{mode === "LIVE" ? "真实杠杆" : "模拟杠杆"}</dt><dd>{leverage}×</dd></div><div><dt>{mode === "LIVE" ? "实际保证金" : "预计保证金"}</dt><dd>{num(margin, 2)} U</dd></div></dl><p style={{ gridColumn: "1 / -1", margin: 0, color: note && mode === "LIVE" ? "var(--red)" : "var(--muted)", fontSize: 11 }}>{note ?? (mode === "LIVE" ? "真实订单由 Gate 托管；结构止损为 reduce-only，不能反向开仓。" : "触发时按最新价格、权益和组合风险重新计算。")}</p></article>;
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

function durationText(start: number, end: number | null) {
  if (!end) return "持仓中";
  const seconds = Math.max(0, Math.round((end - start) / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function PlaybookGroup({ strategies, rules }: { strategies: StrategyScore[]; rules: StrategyArena["rules"] }) {
  const sample = strategies[0];
  const trial = strategies.filter((strategy) => strategy.lane === "TRIAL").length;
  const verified = strategies.filter((strategy) => strategy.lane === "VERIFIED").length;
  const shadowResolved = strategies.reduce((total, strategy) => total + strategy.shadowResolved, 0);
  const paperResolved = strategies.reduce((total, strategy) => total + strategy.paperResolved, 0);
  const baseName = sample.name.split(" · ")[0];
  return <details className="playbook-group" open={trial + verified > 0}><summary><div><small>{channelLabel(sample.channel)} · 4个策略单元</small><h3>{baseName}</h3><p>{sample.description}</p></div><div className="playbook-counts"><span>{shadowResolved} 影子</span><b>{trial} 试用 · {verified} 稳定</b><em>{paperResolved} 模拟结果</em></div></summary><div className="strategy-grid">{strategies.map((strategy) => <StrategyCard key={strategy.id} strategy={strategy} rules={rules} />)}</div></details>;
}

function StrategyCard({ strategy, rules }: { strategy: StrategyScore; rules: StrategyArena["rules"] }) {
  const shadowRate = strategy.shadowResolved ? strategy.shadowWins / strategy.shadowResolved : 0;
  const paperRate = strategy.paperResolved ? strategy.paperWins / strategy.paperResolved : 0;
  const stageWins = strategy.stageResults.filter((value) => value > 0).length;
  const stageNet = strategy.stageResults.reduce((sum, value) => sum + value, 0);
  return <article className={`strategy-card ${strategy.lane.toLowerCase()}`}><div className="strategy-title"><div><small>{strategy.entryStyle === "CONFIRM" ? "确认进场" : "回踩进场"} · {strategy.exitProfile === "FAST" ? "快速出场" : "结构出场"}</small><h3>{strategy.name.split(" · ").slice(1).join(" · ")}</h3></div><span>{laneLabel(strategy.lane)}</span></div><dl><div><dt>当前阶段</dt><dd>{stageWins}/{strategy.stageResults.length} 胜</dd></div><div><dt>阶段净值</dt><dd className={stageNet >= 0 ? "positive" : "negative"}>{signed(stageNet * 100)}%</dd></div><div><dt>影子样本</dt><dd>{strategy.shadowResolved} · {num(shadowRate * 100, 1)}%</dd></div><div><dt>模拟样本</dt><dd>{strategy.paperResolved} · {num(paperRate * 100, 1)}%</dd></div></dl><small className="strategy-rule">{strategy.lane === "SHADOW" ? "首笔成本后盈利即可进入试用模拟" : strategy.lane === "TRIAL" ? `独立权益 ${num(strategy.paperEquity, 2)} U · ${strategy.stageEvents.length}/${rules.verifiedEvents} 独立事件 · ${strategy.stageSymbols.length}/${rules.verifiedSymbols} 币` : `稳定模拟 · 独立权益 ${num(strategy.paperEquity, 2)} U · 连亏 ${strategy.consecutivePaperLosses}/${rules.demotionLosses}`}</small></article>;
}

function ArenaTradeRecord({ trade }: { trade: ArenaTrade }) {
  const result = trade.netReturnRate ?? 0;
  return <article className="history-order"><div><span className={`side ${trade.side.toLowerCase()}`}>{trade.side === "LONG" ? "多" : "空"}</span><div><b>{trade.symbol.replace("_", "/")} · {trade.strategyName}</b><small>{time(trade.openedAt)} · {laneLabel(trade.lane)}</small></div></div><div><small>进场 / 出场</small><b>{num(trade.entryPrice, 5)} / {num(trade.exitPrice, 5)}</b></div><div><small>账户净盈亏</small><b className={result > 0 ? "positive" : "negative"}>{signed(trade.netPnl ?? 0)} U · {signed(result * 100)}%</b></div><div><small>持仓 / 结束</small><b>{durationText(trade.openedAt, trade.closedAt)} · {trade.outcome === "TARGET" ? "目标" : trade.outcome === "STOP" ? "止损" : "超时"}</b></div><details className="history-diagnostic"><summary>查看完整入场环境</summary><div><span>行情与来源<b>{regimeLabel(trade.context.regime)} · {channelLabel(trade.context.channel)}</b></span><span>判断依据<b>{trade.reason}</b></span><span>毛收益 / 完整成本<b>{signed((trade.grossReturnRate ?? 0) * 100)}% / -{num(trade.context.modeledCostRate * 100, 3)}%</b></span><span>订单仓位<b>{num(trade.notional, 2)} U</b></span><span>最大有利 / 不利<b>{signed(trade.maxFavorableRate * 100)}% / {signed(trade.maxAdverseRate * 100)}%</b></span><span>趋势效率 / 波动比<b>{num(trade.context.trendEfficiency * 100, 1)} / {num(trade.context.volatilityRatio, 2)}</b></span><span>OI变化 / 资金费率<b>{signed(trade.context.openInterestChangeRate * 100, 3)}% / {signed(trade.context.fundingRate * 100, 4)}%</b></span><span>24h成交额<b>{num(trade.context.volume24hUsd / 1_000_000, 1)} 百万 U</b></span><span>资金流 / 确认 / 假突破<b>{num(trade.context.alignedFlow, 2)} / {num(trade.context.confirmation, 2)} / {num(trade.context.fakeoutRisk, 2)}</b></span><span>止损 / 目标<b>{num(trade.stopPrice, 5)} / {num(trade.targetPrice, 5)}</b></span></div></details></article>;
}

function ArenaOpenCard({ trade, mark }: { trade: ArenaTrade; mark: number | undefined }) {
  const direction = trade.side === "LONG" ? 1 : -1;
  const current = mark ?? trade.lastPrice;
  const gross = current ? direction * (current - trade.entryPrice) / Math.max(trade.entryPrice, 1e-9) : 0;
  const net = gross - trade.context.modeledCostRate;
  return <article className="order-card"><div><span className={`side ${trade.side.toLowerCase()}`}>{trade.side === "LONG" ? "多" : "空"}</span><div><h3>{trade.symbol.replace("_", "/")} · {trade.strategyName}</h3><p>{laneLabel(trade.lane)} · {regimeLabel(trade.context.regime)} · {trade.reason}</p></div></div><strong className={net >= 0 ? "positive" : "negative"}>{current ? `${signed(trade.notional * net)} U · ${signed(net * 100)}%` : "等待行情"}</strong><dl><div><dt>进场</dt><dd>{num(trade.entryPrice, 5)}</dd></div><div><dt>当前价</dt><dd>{num(current, 5)}</dd></div><div><dt>止损</dt><dd>{num(trade.stopPrice, 5)}</dd></div><div><dt>目标</dt><dd>{num(trade.targetPrice, 5)}</dd></div><div><dt>账户仓位</dt><dd>{num(trade.notional, 2)} U</dd></div></dl></article>;
}

function Setting({ title, detail, value, tone = "" }: { title: string; detail: string; value: string; tone?: string }) {
  return <div className="setting-row"><div><b>{title}</b><p>{detail}</p></div><span className={`setting-value ${tone}`}>{value}</span></div>;
}
