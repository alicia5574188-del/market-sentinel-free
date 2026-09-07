"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { aggregateClosePoints, directionalReturnRate, marginReturnRate, unrealizedPnl, type PositionPricePoint } from "../lib/position-metrics.ts";
import { runtimeReady } from "../lib/runtime-health.ts";

type Side = "LONG" | "SHORT";
type MarketState = "BREAKOUT" | "REVERSAL" | "RANGE";
type Zone = { price: number; score: number; source: "BOOK" | "STOP_POOL" | "LIQUIDATION" };
type RouteStage = "LOCAL_TO_NODE" | "AT_NODE" | "NODE_TO_NEXT";
type RouteKind = "LOCAL_BREAKOUT" | "INTERNAL_ROTATION" | "BREAKOUT_RETEST" | "FAILED_BREAKOUT_REVERSAL" | "EDGE_REJECTION" | "NODE_CONTINUATION";
type Decision = { marketState: MarketState; side: Side; entryTrigger: number; invalidation: number; target: number; economicTarget?: number; score: number; reason: string[]; routeId?: string; routeStage?: RouteStage; routeKind?: RouteKind; targetTimeframe?: "15m" | "1h" | "4h"; nextTarget?: number | null; confirmationScore?: number; fakeoutRisk?: number; activationDistanceRate?: number; rangeBoundary?: number; rangeBuffer?: number; sweepExtreme?: number; reclaimSource?: "COMPLETED_MINUTE" | "FAST_BOOK"; reclaimStrength?: number };
type Plan = Decision & { state: "PREPARED" | "TRIGGERED" | "CANCELLED"; plannedRisk: number; notional: number; expiresAt: number; leverage?: number; margin?: number; economicTarget?: number; breakoutSignalCount?: number; latestConfirmationScore?: number; latestFakeoutRisk?: number; cancelReason?: string; cancelledAt?: number; invalidationSignalCount?: number; invalidationSignalReason?: "TARGET_GONE_CANCEL" | "ACTIVATION_LOST_CANCEL" | "ROUTE_WEAK_CANCEL" };
type LiquidityRoute = { id: string; side: Side; kind: RouteKind; stage: RouteStage; entryTrigger: number; invalidation: number; target: number; targetTimeframe: "15m" | "1h" | "4h"; nextTarget: number | null; confirmationScore: number; fakeoutRisk: number; score: number; executableNow: boolean; reason: string[]; rangeBoundary?: number; sweepExtreme?: number; reclaimStrength?: number };
type RangeBand = { lower: number; upper: number; widthRate: number; quality: number; observedAt?: number; id?: string; role?: "PARENT" | "CHILD"; breakState?: "INSIDE" | "BROKEN_UP" | "BROKEN_DOWN" };
type RangeStructure = RangeBand & { child?: RangeBand | null };
type Position = { side: Side; scenario: MarketState; status: "OPEN" | "CLOSED"; entryAt?: number; entryPrice: number; initialStop: number; currentStop: number; currentTarget: number; plannedRisk: number; notional: number; routeId?: string; routeKind?: RouteKind; rangeBoundary?: number; rangeBuffer?: number; sweepExtreme?: number; reclaimStrength?: number; rangeAcceptanceCount?: number; exitAt?: number; exitPrice?: number; realizedPnl?: number; exitReason?: string; exitSignalCount?: number; exitSignalReason?: string };
type LiveEntry = { planId: string; symbol: string; side: Side; scenario: MarketState; kind: "PRICE_TRIGGER" | "LIMIT" | "MARKET"; status: string; trigger: number; invalidation: number; target: number; plannedRisk: number; notional: number; leverage: number; margin: number; lastError: string | null };
type LivePosition = Position & { id: string; symbol: string; exchangeSize: number; leverage: number; margin: number; stopPrice: number | null; exitRequestedAt: number | null };
type LiveEntrySkip = { planId: string; symbol: string; code: "MIN_CONTRACT" | "MARGIN" | "RISK_CAP" | "ECONOMICS"; reason: string; observedAt: number };
type LiveRuntime = { requestedEnabled: boolean; operational: boolean; changedAt: number | null; lastSyncAt: number | null; lastError: string | null; equity: number | null; available: number | null; credentialConfigured: boolean; entries: Record<string, LiveEntry | null>; positions: Record<string, LivePosition | null>; entrySkips: Record<string, LiveEntrySkip | null> };
type PaperCycleSummary = { number: number; startedAt: number; startingEquity: number; currentEquity: number; bankruptcyLine: number; peakEquity: number; trades: number; drawdownRate: number };
type Runtime = {
  version: string; mode: "PAPER"; state: string; stale: boolean; generatedAt: number; lastSuccessAt: number | null; lastError: string | null; symbols: string[]; equity: number;
  decisions: Record<string, Decision | null>; routes: Record<string, LiquidityRoute[]>; plans: Record<string, Plan | null>; positions: Record<string, Position | null>; authorityReady: boolean;
  evidence: Record<string, { midpoint: number; observedAt: number; warmup: number; fresh: boolean; ancillaryFresh: boolean; entryReady?: boolean; optionalFresh?: boolean; recoveryFreshCount?: number; suspensionReason?: string | null; topLong: Zone | null; topShort: Zone | null; absorption: number; range15m: RangeStructure | null }>;
  feedFailures?: Record<string, { count: number; retryAt: number; suspendedSince?: number | null; totalFailures?: number; recoveries?: number; lastFailureAt?: number | null; lastError?: string | null; maxObservedLagMs?: number }>;
  limits: { maxOpenPositions: number };
  liveMode: { requestedEnabled: boolean; operational: boolean };
  paperCycle: PaperCycleSummary;
  live?: LiveRuntime;
};
type AuthSession = { configured: boolean; authenticated: boolean; username: string };
type CredentialStatus = { configured: boolean; environment: string | null; keyHint: string | null; gateUserId: string | null; status: string; lastVerifiedAt: number | null; lastError: string | null; updatedAt: number | null };
type CredentialVerification = { equity: number; available: number; positions: number; orders: number; conditionalOrders: number; checkedAt: number };
type HistoryItem = { id: string; symbol: string; marketState: MarketState; side: Side; status: "OPEN" | "CLOSED"; entryAt: number; entryPrice: number; initialStop: number; currentStop: number; currentTarget: number; plannedRisk: number; notional: number; exitAt: number | null; exitPrice: number | null; exitReason: string | null; realizedPnl: number | null; feesAndSlippage: number | null };
type BreakdownRow = { trades: number; wins: number; netPnl: number };
type BankruptcyReport = { id: string; cycleNumber: number; startedAt: number; endedAt: number; startingEquity: number; endingEquity: number; bankruptcyLine: number; loss: number; maxDrawdownRate: number;
  performance: { trades: number; wins: number; losses: number; breakeven: number; grossPnl: number; costs: number; netPnl: number; profitFactor: number | null; expectancy: number };
  direction: { correctAtExit: number; correctAtExitRate: number; feeCoveringMoves: number; feeCoveringMoveRate: number };
  entries: { averagePlannedNetRewardRisk: number; belowMinimumCount: number };
  stops: { reached: number; structuralStopExits: number; averageMaximumAdverseVsStop: number; stoppedAfterFavorableMove: number };
  targets: { reached: number; reachedRate: number; averageProgress: number };
  exits: { averageHoldingSeconds: number; underOneMinute: number; reasons: Record<string, number> };
  breakdown: { symbols: Record<string, BreakdownRow>; scenarios: Record<string, BreakdownRow>; sides: Record<string, BreakdownRow> };
  rootCauses: string[]; trades: unknown[] };
type AccountLogItem = { id: string; observedAt: number; report: BankruptcyReport };
type Tab = "brain" | "orders" | "live" | "history" | "settings";
type LiveView = "account" | "orders" | "api";
type HistoryView = "trades" | "account_logs";
type Timeframe = "1m" | "15m" | "1h" | "4h";
type Candle = { time: number; volume: number; close: number; high: number; low: number; open: number };
type PositionView = { entryAt?: number; entryPrice: number; stopPrice: number; targetPrice: number; markPrice?: number; markAt?: number; fresh: boolean };

const INITIAL_EQUITY = 1_000;
const RUNTIME_REQUEST_TIMEOUT_MS = 30_000;
const RUNTIME_DISPLAY_TTL_MS = 90_000;
const stateText: Record<string, string> = { BREAKOUT: "突破", REVERSAL: "反转", RANGE: "震荡", LIVE: "运行中", WARMING: "预热中", DEGRADED: "部分数据恢复中", RECONNECTING: "重新连接中", RECOVERY_REQUIRED: "需要恢复", STARTING: "启动中" };
const sourceText: Record<string, string> = { BOOK: "真实挂单区", STOP_POOL: "止损集中区", LIQUIDATION: "估计清算区" };
const routeText: Record<RouteKind, string> = { LOCAL_BREAKOUT: "父区间强势突破观察", INTERNAL_ROTATION: "子区间强势迁移观察", BREAKOUT_RETEST: "突破回踩后再加速", FAILED_BREAKOUT_REVERSAL: "强假突破反向反抽", EDGE_REJECTION: "扫流动性收回后回踩", NODE_CONTINUATION: "高周期节点续破" };
const cancelText: Record<string, string> = { STALE_CANCEL: "行情失鲜", SEQUENCE_REBUILD_CANCEL: "盘口序列重建", PRE_ENTRY_INVALIDATION_CANCEL: "冻结结构已失效", GAP_ECONOMICS_CANCEL: "跳空后盈亏空间不足", STRUCTURE_REPLACED_CANCEL: "相关边界已被新结构替代", NONLOCAL_FALLBACK_CANCEL: "旧版非局部方案失效", TARGET_GONE_CANCEL: "目标连续消失", ROUTE_WEAK_CANCEL: "路线连续转弱", ACTIVATION_LOST_CANCEL: "价格连续离开激活范围", BREAKOUT_MISSED_CANCEL: "突破已超过追价上限", BREAKOUT_FIRST_CROSS_FAILED_CANCEL: "首次穿越立即失败", BREAKOUT_ACCEPTED_WAIT_RETEST: "普通突破转入回踩分支", PLAN_EXPIRED: "计划到期", GAP_RISK_CANCEL: "实际成交风险超限", FEED_HARD_FAILURE_CANCEL: "关键行情持续中断", PROCESS_RESTART_CANCEL: "后台版本切换", PAPER_CYCLE_BANKRUPTCY: "模拟轮次结束" };
const stageText: Record<RouteStage, string> = { LOCAL_TO_NODE: "当前段", AT_NODE: "节点决策", NODE_TO_NEXT: "后续段" };
const exitText: Record<string, string> = { STRUCTURAL_STOP: "价格到达扫盘与结构之外的硬止损", RANGE_OUTSIDE_ACCEPTANCE: "连续两根完整1分钟收在区间外，震荡结构失效", DYNAMIC_PROTECTION_STOP: "目标进度风险收缩止损", BREAKOUT_PROFIT_REJECTION: "突破浮盈大幅回吐，确认失败退出", TARGET_ABSORBED: "目标流动性已被吸收", TARGET_NODE_EXIT: "到达流动性节点，续破未确认", TARGET_DISAPPEARED: "目标流动性连续消失", TARGET_VANISHED: "目标消失", OPPOSITE_TARGET_DOMINANT: "反向目标占优", OPPOSITE_UTILITY_DOMINANT: "反向流动性连续占优", RISK_CAP_REBALANCE: "组合风险重新平衡", PORTFOLIO_RISK_REBALANCE: "组合风险重新平衡" };
const resolvedExitText = (reason: string | null | undefined, initialStop: number, currentStop: number) => {
  if (reason === "STRUCTURAL_STOP" && Math.abs(currentStop - initialStop) > Math.max(Math.abs(initialStop) * 1e-8, 1e-8)) return "旧版即时保本止损";
  return exitText[reason ?? ""] ?? reason ?? "订单已经结束";
};
const num = (value: number | null | undefined, digits = 3) => Number.isFinite(value) ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "—";
const signed = (value: number, digits = 2) => `${value >= 0 ? "+" : ""}${num(value, digits)}`;
const time = (value: number | null | undefined) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
const sideText = (side: Side) => side === "LONG" ? "做多" : "做空";
const distancePct = (from: number, to: number) => Math.abs(to - from) / Math.max(from, 1e-9) * 100;
const netRr = (entry: number, stop: number, target: number) => Math.max(0, Math.abs(target - entry) / Math.max(entry, 1e-9) - .0018)
  / Math.max(Math.abs(entry - stop) / Math.max(entry, 1e-9) + .0018, 1e-9);
const displayLeverage = (notional: number, equity: number) => [1, 2, 3, 5, 10, 20, 30, 40, 50].find((value) => notional / value <= equity * .12) ?? 50;
const mergePricePoints = (current: PositionPricePoint[], incoming: PositionPricePoint[]) => {
  const merged = new Map<number, PositionPricePoint>();
  [...current, ...incoming].forEach((point) => { if (Number.isFinite(point.time) && Number.isFinite(point.price) && point.price > 0) merged.set(point.time, point); });
  return [...merged.values()].sort((a, b) => a.time - b.time).slice(-72);
};
const friendlyLiveError = (value: string | null | undefined) => !value ? null
  : value.includes("AUTO_INVALID_PARAM_TRIGGER_EXPIRATION")
    ? "Gate 拒绝了旧版触发单的有效期格式；系统已修复并会重新核对。"
    : value;

function waitReason(runtime: Runtime | null, marketReady: boolean, symbol: string) {
  if (!runtime) return "正在连接后台行情";
  const evidence = runtime.evidence[symbol];
  const plan = runtime.plans[symbol];
  if (!runtime.authorityReady || runtime.stale) return "后台循环暂时延迟，禁止使用旧价格成交；原计划保持冻结";
  if (!evidence?.fresh) return plan?.state === "PREPARED"
    ? "实时盘口短暂延迟：保留原计划与边界，但禁止成交；恢复后重新确认"
    : "实时盘口短暂延迟，仅暂停该币的新成交";
  if (!evidence.ancillaryFresh) return plan?.state === "PREPARED"
    ? "关键周期结构正在刷新：原计划保留，刷新完成前禁止成交"
    : "关键周期结构正在刷新，暂不建立新计划";
  if (!marketReady || evidence.entryReady === false) return `行情已恢复，正在确认 ${evidence.recoveryFreshCount ?? 0}/2；确认前不成交`;
  if (evidence.warmup < 30) return `正在积累真实快照，还差 ${30 - evidence.warmup} 次`;
  const position = runtime.positions[symbol];
  if (position?.status === "OPEN") {
    if (position.routeKind === "EDGE_REJECTION") return (position.rangeAcceptanceCount ?? 0) > 0
      ? `区间外接受观察 ${position.rangeAcceptanceCount}/2；重新收回区间会清零，硬止损仍即时保护`
      : "扫流动性后已回到区间；普通回调继续持有，目标前保护位不会越过进场价";
    const age = runtime.generatedAt - (position.entryAt ?? runtime.generatedAt);
    if (age < 2 * 60_000) return "持仓保护期：原始止损和目标仍实时执行，短周期软信号暂不平仓";
    if ((position.exitSignalCount ?? 0) > 0) return `软失效观察 ${position.exitSignalCount}/3；仅在完整1分钟收盘逆向达到0.75R后退出`;
    return "完整1分钟管理；达到1.5R且完成70%目标路程后只把剩余风险缩到0.5R，目标前不锁微利";
  }
  const decision = runtime.decisions[symbol];
  const rebuildAt = position?.exitAt ? Math.floor(position.exitAt / 60_000) * 60_000 + 120_000 : Infinity;
  const reclaimedNow = decision ? (decision.side === "LONG" ? evidence.midpoint > decision.entryTrigger : evidence.midpoint < decision.entryTrigger) : false;
  if (position?.status === "CLOSED" && position.exitReason === "STRUCTURAL_STOP" && decision
    && position.side === decision.side && position.scenario === decision.marketState
    && (!position.routeId || !decision.routeId || position.routeId === decision.routeId)
    && (runtime.generatedAt < rebuildAt || !reclaimedNow)) {
    return "原结构已经止损；同方向方案等待两根完整1分钟K线重建并收复触发位";
  }
  if (plan?.state === "PREPARED") return (plan.invalidationSignalCount ?? 0) > 0
    ? `计划仍锁定，软失效观察 ${plan.invalidationSignalCount}/2；不会因一次短周期变化撤单`
    : plan.routeKind === "BREAKOUT_RETEST"
      ? "完整1分钟回踩已经守住原边界；等待重新越过回踩K线极值后IOC进场"
    : plan.routeKind === "FAILED_BREAKOUT_REVERSAL"
      ? "假突破已收回区间；等待从区间内部反抽原边界，失败后反向进场"
    : plan.routeKind === "EDGE_REJECTION"
      ? "边界扫盘已经收回；不追反弹，只等待区间内侧回踩成交"
    : plan.marketState === "BREAKOUT"
      ? (plan.breakoutSignalCount ?? 0) > 0
        ? `A级强势突破实时确认 ${plan.breakoutSignalCount}/4；连续通过后实时 IOC 进场`
        : "仅A级强势突破允许直入；普通突破等待完整回踩，假突破等待反向反抽"
      : `方向已判断，距离触发价约 ${num(distancePct(evidence.midpoint, plan.entryTrigger), 2)}%`;
  if (runtime.decisions[symbol]) return "方向已经出现，但进场条件或风险空间暂不合适";
  if (evidence.range15m?.breakState === "BROKEN_DOWN") return "15分钟父区间已向下突破；保留原下边界，正在区分强延续、回踩续跌和失败收回，不在0.5R外追价";
  if (evidence.range15m?.breakState === "BROKEN_UP") return "15分钟父区间已向上突破；保留原上边界，正在区分强延续、回踩续涨和失败收回，不在0.5R外追价";
  return "上下流动性优势不足，突破、反转和震荡条件都未成立";
}

export default function Home() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [accountLogs, setAccountLogs] = useState<AccountLogItem[]>([]);
  const [historyView, setHistoryView] = useState<HistoryView>("trades");
  const [receivedAt, setReceivedAt] = useState(0);
  const [clock, setClock] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("brain");
  const [auth, setAuth] = useState<AuthSession>({ configured: true, authenticated: false, username: "owner" });
  const [showLogin, setShowLogin] = useState(false);
  const [showLiveConfirm, setShowLiveConfirm] = useState(false);
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
    const readHistory = async () => {
      try {
        const [tradesResponse, logsResponse] = await Promise.all([
          fetch("/api/history", { cache: "no-store" }),
          fetch("/api/account-logs", { cache: "no-store" }),
        ]);
        if (tradesResponse.ok && active) setHistory(((await tradesResponse.json()) as { items: HistoryItem[] }).items ?? []);
        if (logsResponse.ok && active) setAccountLogs(((await logsResponse.json()) as { items: AccountLogItem[] }).items ?? []);
      } catch { /* History is optional; the live runtime remains authoritative. */ }
    };
    const visibility = () => { if (!document.hidden) void read(); else controller?.abort(); };
    void read(); void readHistory();
    const timer = setInterval(read, 15_000);
    const historyTimer = setInterval(readHistory, 15_000);
    document.addEventListener("visibilitychange", visibility);
    return () => { active = false; controller?.abort(); clearInterval(timer); clearInterval(historyTimer); document.removeEventListener("visibilitychange", visibility); };
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
      setShowLiveConfirm(false);
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
    else setShowLiveConfirm(true);
  };

  const responseFresh = runtime != null && clock - receivedAt < RUNTIME_DISPLAY_TTL_MS && clock - runtime.generatedAt < RUNTIME_DISPLAY_TTL_MS;
  const healthy = runtimeReady(runtime, responseFresh);
  const authorityOperational = runtime != null && runtime.authorityReady && !runtime.stale;
  const openPositions = useMemo(() => runtime?.symbols.flatMap((symbol) => runtime.positions[symbol]?.status === "OPEN" ? [{ symbol, position: runtime.positions[symbol]! }] : []) ?? [], [runtime]);
  const recentClosedPositions = useMemo(() => runtime?.symbols.flatMap((symbol) => {
    const position = runtime.positions[symbol];
    return position?.status === "CLOSED" && position.exitAt && clock - position.exitAt <= 15 * 60_000 ? [{ symbol, position }] : [];
  }) ?? [], [runtime, clock]);
  const preparedPlans = useMemo(() => runtime?.symbols.flatMap((symbol) => runtime.plans[symbol]?.state === "PREPARED" ? [{ symbol, plan: runtime.plans[symbol]! }] : []) ?? [], [runtime]);
  const bestDecision = useMemo(() => runtime?.symbols.map((symbol) => ({ symbol, decision: runtime.decisions[symbol] })).filter((row): row is { symbol: string; decision: Decision } => row.decision != null).sort((a, b) => b.decision.score - a.decision.score)[0] ?? null, [runtime]);
  const floatingPnl = openPositions.reduce((sum, row) => { const mark = runtime?.evidence[row.symbol]?.midpoint ?? row.position.entryPrice; return sum + unrealizedPnl(row.position.notional, row.position.side, row.position.entryPrice, mark); }, 0);
  const riskUsed = openPositions.reduce((sum, row) => sum + row.position.plannedRisk, 0);
  const riskLimit = (runtime?.equity ?? INITIAL_EQUITY) * .10;
  const feedDiagnostics = runtime?.symbols.map((symbol) => runtime.feedFailures?.[symbol]).filter(Boolean) ?? [];
  const activeFeedSuspensions = feedDiagnostics.filter((feed) => feed?.suspendedSince != null).length;
  const totalFeedFailures = feedDiagnostics.reduce((sum, feed) => sum + (feed?.totalFailures ?? 0), 0);
  const totalFeedRecoveries = feedDiagnostics.reduce((sum, feed) => sum + (feed?.recoveries ?? 0), 0);
  const maxFeedLag = feedDiagnostics.reduce((max, feed) => Math.max(max, feed?.maxObservedLagMs ?? 0), 0);
  const cycleStart = runtime?.paperCycle?.startingEquity ?? INITIAL_EQUITY;
  const primary = openPositions[0] ? { symbol: openPositions[0].symbol, side: openPositions[0].position.side, state: openPositions[0].position.scenario, kind: "position" }
    : preparedPlans[0] ? { symbol: preparedPlans[0].symbol, side: preparedPlans[0].plan.side, state: preparedPlans[0].plan.marketState, kind: "plan" }
      : bestDecision ? { symbol: bestDecision.symbol, side: bestDecision.decision.side, state: bestDecision.decision.marketState, kind: "decision" } : null;
  const primaryReady = primary ? Boolean(authorityOperational && runtime?.evidence[primary.symbol]?.fresh && runtime.evidence[primary.symbol]?.ancillaryFresh && runtime.evidence[primary.symbol]?.entryReady !== false) : false;
  const headline = !authorityOperational ? "行情正在恢复，暂不进场" : primary?.kind === "position" ? `正在持有 ${primary.symbol.replace("_", "/")} ${primary.side === "LONG" ? "多单" : "空单"}` : primary && !primaryReady ? "计划已冻结，等待行情确认" : primary ? `准备${sideText(primary.side)} ${primary.symbol.replace("_", "/")}` : "继续观察，暂不开仓";
  const headlineDetail = primary ? `${stateText[primary.state]}判断 · ${waitReason(runtime, primaryReady, primary.symbol)}` : runtime?.symbols[0] ? waitReason(runtime, Boolean(authorityOperational && runtime.evidence[runtime.symbols[0]]?.fresh && runtime.evidence[runtime.symbols[0]]?.ancillaryFresh && runtime.evidence[runtime.symbols[0]]?.entryReady !== false), runtime.symbols[0]) : "正在等待第一批行情";

  return <main>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">三</span><div><p>流动性三态</p><small>预测型量化交易系统</small></div></div>
      <div role="status" className={`health ${healthy ? "" : "bad"}`}><span />{healthy ? "后台运行中" : error ? "页面连接中断" : runtime?.stale ? "行情重连中" : runtime ? stateText[runtime.state] ?? runtime.state : "正在连接"}</div>
    </header>

    {tab === "brain" && <>
      <section className="brain-hero"><div><p className="eyebrow">系统现在的决定</p><h1>{headline}</h1><p className="hero-detail">{headlineDetail}</p></div><div className="decision-badge"><small>当前市场状态</small><strong>{primary ? stateText[primary.state] : "等待"}</strong><span>{primary ? sideText(primary.side) : "没有勉强开仓"}</span></div></section>

      <section className="summary four">
        <article><small>模拟账户权益</small><strong>{runtime ? `${num(runtime.equity, 2)} U` : "—"}</strong><p>第 {runtime?.paperCycle?.number ?? 1} 轮 · 起始 {num(cycleStart, 0)} U</p></article>
        <article><small>本轮模拟盈亏</small><strong className={(runtime?.equity ?? cycleStart) >= cycleStart ? "positive" : "negative"}>{runtime ? `${signed(runtime.equity - cycleStart)} U` : "—"}</strong><p>{runtime ? `${signed((runtime.equity / Math.max(cycleStart, 1) - 1) * 100)}%` : "等待数据"}</p></article>
        <article><small>当前持仓浮盈亏</small><strong className={floatingPnl >= 0 ? "positive" : "negative"}>{runtime ? `${signed(floatingPnl)} U` : "—"}</strong><p>{openPositions.length} 笔模拟持仓</p></article>
        <article><small>组合风险预算</small><strong>{num(riskUsed, 2)} / {num(riskLimit, 2)} U</strong><div className="risk-bar"><i style={{ width: `${Math.min(100, riskLimit ? riskUsed / riskLimit * 100 : 0)}%` }} /></div><p>剩余 {num(Math.max(0, riskLimit - riskUsed), 2)} U</p></article>
      </section>
      {(!responseFresh || error) && runtime && <p className="notice">手机页面更新延迟，下面保留最近一次后台状态；服务器仍独立运行，不会因此停止判断或开模拟单。</p>}{runtime?.lastError && <p className="notice">系统正在自动恢复：{runtime.lastError}</p>}
    </>}

    <nav className="tabs">{([['brain', '大脑'], ['orders', `订单 ${openPositions.length + preparedPlans.length || ''}`], ['live', `实盘 ${openLivePositions.length + openLiveEntries.length || ''}`], ['history', '历史'], ['settings', '设置']] as const).map(([key, label]) => <button key={key} type="button" className={tab === key ? "active" : ""} onClick={() => selectTab(key)}>{label}</button>)}</nav>

    <section className="markets" hidden={tab !== "brain"}>{runtime?.symbols.map((symbol) => {
      const evidence = runtime.evidence[symbol], marketFresh = Boolean(authorityOperational && evidence?.fresh && evidence?.ancillaryFresh && evidence?.entryReady !== false);
      const decision = marketFresh ? runtime.decisions[symbol] : null, plan = runtime.plans[symbol], position = runtime.positions[symbol];
      const routes = runtime.routes[symbol] ?? [];
      const acceptedBreak = evidence?.range15m?.breakState === "BROKEN_UP" ? "向上" : evidence?.range15m?.breakState === "BROKEN_DOWN" ? "向下" : null;
      const positionIntent: Decision | null = position?.status === "OPEN" ? { marketState: position.scenario, side: position.side,
        entryTrigger: position.entryPrice, invalidation: position.currentStop, target: position.currentTarget, score: 0,
        reason: ["沿冻结路线持仓；短周期变化只预警，完整确认后才调整保护"] } : null;
      const intent = positionIntent ?? (plan?.state === "PREPARED" ? plan : decision);
      const status = !authorityOperational ? "后台循环恢复中" : !evidence?.fresh ? plan?.state === "PREPARED" ? "计划冻结 · 行情延迟" : "行情短暂延迟" : !evidence.ancillaryFresh ? "关键结构刷新中" : evidence.entryReady === false ? `恢复确认 ${evidence.recoveryFreshCount ?? 0}/2` : position?.status === "OPEN" ? "持仓中" : plan?.state === "PREPARED" ? "等待进场" : intent ? "发现机会" : acceptedBreak ? `父区间${acceptedBreak}突破 · 分支观察` : evidence?.warmup < 30 ? `预热 ${evidence?.warmup ?? 0}/30` : "继续观察";
      return <article className="market" key={symbol}><div className="market-title"><div><small>{symbol.replace("_", "/")}</small><h2>{status}</h2></div><strong>{evidence?.midpoint ? num(evidence.midpoint, 5) : "—"}</strong></div>
        <div className="plain-answer"><small>系统判断</small><b>{intent ? `${sideText(intent.side)} · ${intent.routeKind === "INTERNAL_ROTATION" ? "区间内部迁移" : intent.routeKind === "BREAKOUT_RETEST" ? "突破回踩延续" : intent.routeKind === "FAILED_BREAKOUT_REVERSAL" ? "强假突破反转" : intent.routeKind === "EDGE_REJECTION" ? "扫流动性后震荡回归" : stateText[intent.marketState]}` : acceptedBreak ? `15分钟父区间已${acceptedBreak}突破` : "暂时没有值得执行的方向"}</b><p>{waitReason(runtime, marketFresh, symbol)}</p></div>
        {plan?.state === "CANCELLED" && plan.cancelReason && <p className="notice">最近计划撤销：{cancelText[plan.cancelReason] ?? plan.cancelReason}{plan.cancelledAt ? ` · ${time(plan.cancelledAt)}` : ""}</p>}
        {evidence?.optionalFresh === false && <p className="notice">OI、主动成交或清算数据部分延迟；关键盘口与周期结构仍独立工作，该项只降低确认度，不会强制撤销计划。</p>}
        {!!routes.length && <section className="route-map"><div className="route-map-head"><div><small>分段流动性路线</small><b>多个方案观察，单一方案执行</b></div><span>软计划不占保证金</span></div><div className="route-list">{routes.map((route) => <article className={route.executableNow ? "active" : ""} key={route.id}><div><span>{stageText[route.stage]}</span><b>{sideText(route.side)} · {routeText[route.kind]}</b></div><p>{num(route.entryTrigger, 5)} → {num(route.target, 5)} <small>{route.targetTimeframe} 流动性 · 确认 {num(route.confirmationScore * 100, 0)}% · 假突破风险 {num(route.fakeoutRisk * 100, 0)}%</small></p><em>{route.executableNow ? "可进入执行仲裁" : route.stage === "NODE_TO_NEXT" ? "到节点后重判" : "继续观察确认"}</em></article>)}</div></section>}
        {position?.status === "OPEN" ? <div className="trade-levels"><div><small>实际进场</small><b>{num(position.entryPrice, 5)}</b></div><div><small>原始结构止损</small><b>{num(position.initialStop, 5)}</b></div><div><small>当前保护位</small><b>{num(position.currentStop, 5)}</b></div><div><small>当前目标</small><b>{num(position.currentTarget, 5)}</b></div></div> : intent && <div className="trade-levels"><div><small>准备进场</small><b>{num(intent.entryTrigger, 5)}</b></div><div><small>判断错误就退出</small><b>{num(intent.invalidation, 5)}</b></div><div><small>当前目标</small><b>{num(intent.target, 5)}</b></div><div><small>第一目标扣成本盈亏比</small><b>{num(netRr(intent.entryTrigger, intent.invalidation, intent.target), 2)} : 1</b></div></div>}
        <div className="execution"><small>执行方式</small><b>{!marketFresh && plan?.state === "PREPARED" ? `原计划与边界保持不变；当前禁止成交，连续2份新盘口恢复后再核对，仍有效至 ${time(plan.expiresAt)}` : position?.status === "OPEN" ? waitReason(runtime, marketFresh, symbol) : plan?.state === "PREPARED" ? plan.routeKind === "FAILED_BREAKOUT_REVERSAL" ? (liveEnabled ? `Gate 限价等待反抽 ${num(plan.entryTrigger, 5)} · 有效至 ${time(plan.expiresAt)}` : `模拟等待反抽原边界 ${num(plan.entryTrigger, 5)} · 到期自动撤销`) : plan.routeKind === "EDGE_REJECTION" ? `扫盘极值 ${num(plan.sweepExtreme, 5)} 已冻结；等待区间内侧回踩 ${num(plan.entryTrigger, 5)}` : plan.routeKind === "BREAKOUT_RETEST" ? `已确认回踩守住，内部等待重新加速至 ${num(plan.entryTrigger, 5)}，0.5R外不追` : plan.marketState === "BREAKOUT" ? `内部监测 ${num(plan.entryTrigger, 5)}；仅86%确认、18%以下假突破风险和连续4次盘口允许直入` : liveEnabled ? `Gate 限价挂单等待 ${num(plan.entryTrigger, 5)} · 有效至 ${time(plan.expiresAt)}` : `模拟等待实时价格到达 ${num(plan.entryTrigger, 5)} · 软变化先观察，到期自动撤销` : intent ? "方向已形成，等待系统建立进场计划" : "继续等待完整机会"}</b></div>
        <CandleChart symbol={symbol} evidence={evidence} decision={intent} position={position?.status === "OPEN" ? position : null} />
        <details><summary>查看判断依据</summary><p>{intent?.reason.join("；") || "尚未形成完整判断"}</p><div className="targets"><span>上方吸引区：{num(evidence?.topLong?.price, 5)} · {sourceText[evidence?.topLong?.source ?? ""] ?? "识别中"}</span><span>下方吸引区：{num(evidence?.topShort?.price, 5)} · {sourceText[evidence?.topShort?.source ?? ""] ?? "识别中"}</span></div></details>
      </article>;
    }) ?? <div className="empty">正在读取市场数据…</div>}</section>

    <section className="panel-list" hidden={tab !== "orders"}>{!openPositions.length && !preparedPlans.length && !recentClosedPositions.length && <div className="empty"><b>当前没有模拟订单</b><p>出现合适位置后会先显示准备计划；真实订单请进入底部「实盘」。</p></div>}
      {!!openPositions.length && <h2 className="order-group-title">当前持仓 <span>{openPositions.length}</span></h2>}
      {openPositions.map(({ symbol, position }) => { const evidence = runtime?.evidence[symbol]; return <OrderCard key={symbol} symbol={symbol} side={position.side} label="持仓中" state={position.scenario} notional={position.notional} equity={runtime?.equity ?? INITIAL_EQUITY} note={waitReason(runtime, true, symbol)} positionView={{ entryAt: position.entryAt, entryPrice: position.entryPrice, stopPrice: position.currentStop, targetPrice: position.currentTarget, markPrice: evidence?.midpoint, markAt: evidence?.observedAt, fresh: Boolean(evidence?.fresh) }} values={[["进场", position.entryPrice], ["原始止损", position.initialStop], ["当前保护位", position.currentStop], ["动态目标", position.currentTarget], ["计划风险", position.plannedRisk]]} />; })}
      {!!preparedPlans.length && <h2 className="order-group-title">等待进场 <span>{preparedPlans.length}</span></h2>}
      {preparedPlans.map(({ symbol, plan }) => <OrderCard key={symbol} symbol={symbol} side={plan.side} label={runtime?.evidence[symbol]?.entryReady === false ? "计划冻结" : plan.marketState === "BREAKOUT" ? "等待确认" : "等待触发"} state={plan.marketState} notional={plan.notional} equity={runtime?.equity ?? INITIAL_EQUITY} leverage={plan.leverage} margin={plan.margin} note={runtime?.evidence[symbol]?.entryReady === false ? `行情短暂延迟时不成交、不移动原边界；计划保留至 ${time(plan.expiresAt)}，连续2份新盘口后重新核对。` : (plan.invalidationSignalCount ?? 0) > 0 ? `软失效观察 ${plan.invalidationSignalCount}/2，计划仍锁定；连续确认后才撤销。有效至 ${time(plan.expiresAt)}。` : plan.routeKind === "BREAKOUT_RETEST" ? `完整1分钟回踩原边界并守住；等待重新越过回踩K线极值后IOC，不追0.5R外价格。有效至 ${time(plan.expiresAt)}。` : plan.routeKind === "FAILED_BREAKOUT_REVERSAL" ? `完整1分钟扫边并收回；等待区间内部反抽原边界后反向限价成交。有效至 ${time(plan.expiresAt)}。` : plan.routeKind === "EDGE_REJECTION" ? `扫盘已收回区间，极值 ${num(plan.sweepExtreme, 5)}；等待内侧回踩，不在下跌途中接单。有效至 ${time(plan.expiresAt)}。` : plan.marketState === "BREAKOUT" ? `${plan.routeKind === "INTERNAL_ROTATION" ? "子区间迁移" : "父区间突破"}内部观察；仅A级强势允许直入，连续盘口确认 ${(plan.breakoutSignalCount ?? 0)}/4。有效至 ${time(plan.expiresAt)}。` : `本挂单有效至 ${time(plan.expiresAt)}；短周期变化先观察，硬失效或到期才立即撤销。`} values={[[plan.marketState === "BREAKOUT" ? (plan.routeKind === "BREAKOUT_RETEST" ? "回踩再加速位" : plan.routeKind === "INTERNAL_ROTATION" ? "子区间观察位" : "父区间观察位") : plan.routeKind === "FAILED_BREAKOUT_REVERSAL" ? "反抽进场" : plan.routeKind === "EDGE_REJECTION" ? "收回后回踩进场" : "触发进场", plan.entryTrigger], ["扫盘外硬止损", plan.invalidation], ["实际第一目标", plan.target], ["计划风险", plan.plannedRisk]]} />)}
      {!!recentClosedPositions.length && <h2 className="order-group-title">刚刚结束 <span>{recentClosedPositions.length}</span></h2>}
      {recentClosedPositions.map(({ symbol, position }) => <OrderCard key={`recent:${position.entryAt ?? symbol}`} symbol={symbol} side={position.side} label="刚刚结束" state={position.scenario} notional={position.notional} equity={runtime?.equity ?? INITIAL_EQUITY} note={resolvedExitText(position.exitReason, position.initialStop, position.currentStop)} values={[["进场", position.entryPrice], ["出场", position.exitPrice ?? position.entryPrice], ["已实现盈亏", position.realizedPnl ?? 0], ["计划风险", position.plannedRisk]]} />)}
    </section>

    <div hidden={tab !== "live"}><LiveCenter auth={auth} runtime={runtime} live={live} liveEnabled={liveEnabled} liveBusy={liveBusy} liveActionError={liveActionError} positions={openLivePositions} entries={openLiveEntries} skips={liveEntrySkips} onLogin={() => setShowLogin(true)} onToggle={liveControl} onCleanup={() => void setLiveMode(false)} /></div>

    <section className="history-panel" hidden={tab !== "history"}>
      <div className="history-subnav">{([['trades', '交易记录'], ['account_logs', `账户日志 ${accountLogs.length || ''}`]] as const).map(([key, label]) => <button type="button" key={key} className={historyView === key ? "active" : ""} onClick={() => setHistoryView(key)}>{label}</button>)}</div>
      {historyView === "trades" && <><div className="section-heading"><div><h2>最近模拟交易</h2><p>只展示真实产生过的记录，不填充示例数据。</p></div><span>{history.filter((item) => item.status === "CLOSED").length} 笔已结束</span></div>
        {!history.length ? <div className="empty"><b>还没有历史交易</b><p>产生第一笔模拟交易后会自动出现在这里。</p></div> : <div className="history-table">{history.map((item) => <HistoryOrder key={item.id} item={item} />)}</div>}</>}
      {historyView === "account_logs" && <AccountLogs cycle={runtime?.paperCycle ?? null} items={accountLogs} />}
    </section>

    <section className="settings-panel" hidden={tab !== "settings"}><button className="setting-row" type="button" onClick={() => auth.authenticated ? void fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(() => { setAuth({ ...auth, authenticated: false }); setRuntime(runtime ? { ...runtime, live: undefined } : runtime); }) : setShowLogin(true)}><div><b>所有者账户</b><p>{auth.authenticated ? "安全登录有效30天；每次打开页面自动续期。" : "登录后才可以查看真实账户并操作实盘开关。"}</p></div><span className={`setting-value ${auth.authenticated ? "online" : "locked"}`}>{auth.authenticated ? "owner · 退出 ›" : "登录 ›"}</span></button><button className="setting-row" type="button" disabled={liveBusy} onClick={liveControl}><div><b>实盘交易开关</b><p>{liveEnabled ? "关闭后撤销未成交入场挂单；已有仓位继续保护并按策略退出。" : "开启后，实盘完全复用当前 BTC/ETH/SOL 策略、10%总风险和6.5%同向限制。"}</p></div><span className={`setting-value ${liveEnabled && live?.operational ? "online" : "locked"}`}>{liveBusy ? "处理中…" : !auth.authenticated ? "需登录 ›" : liveEnabled ? live?.operational ? "已开启 ›" : "已开启·待恢复 ›" : "已关闭 ›"}</span></button>{auth.authenticated && <><Setting title="Gate 实盘账户" detail={`可用 ${num(live?.available, 2)} U · ${openLivePositions.length} 个真实持仓`} value={live?.equity != null ? `${num(live.equity, 2)} U` : "连接中"} tone={live?.credentialConfigured ? "online" : "locked"}/><Setting title="实盘执行状态" detail={friendlyLiveError(live?.lastError) || "强突破约8秒确认后IOC；普通突破等回踩，震荡先扫边收回再等内侧回踩。"} value={live?.operational ? "可开仓" : liveEnabled ? "暂停新单" : "已关闭"} tone={live?.operational ? "online" : "locked"}/></>}<Setting title="最大组合风险" detail="10%是硬上限；BTC/ETH/SOL同向相关风险另限6.5%，均含手续费和压力滑点。" value="10%"/><Setting title="保证金与杠杆" detail="动态杠杆目标每个执行计划约占 10% 保证金；挂单与持仓合计不超过权益 30%，并保留强平缓冲。" value="动态"/><Setting title="持仓时间与止盈" detail="不固定时间，不固定止盈；到达流动性节点后重新判断下一段。" value="分段"/><Setting title="数据容错" detail={`累计短时失败 ${totalFeedFailures} 次 · 自动恢复 ${totalFeedRecoveries} 次 · 最大观测延迟 ${num(maxFeedLag / 1_000, 2)} 秒`} value={activeFeedSuspensions ? `${activeFeedSuspensions}币冻结` : "正常"} tone={activeFeedSuspensions ? "locked" : "online"}/><Setting title="系统状态" detail="页面关闭后后台仍然持续运行。" value={healthy ? "正常" : "恢复中"} tone={healthy ? "online" : "locked"}/><p className="last-update">最近后台成功：{time(runtime?.lastSuccessAt)}{live?.lastSyncAt ? ` · 实盘核对：${time(live.lastSyncAt)}` : ""}</p></section>

    {showLogin && <LoginModal configured={auth.configured} onClose={() => setShowLogin(false)} onSuccess={(session) => { setAuth(session); setShowLogin(false); location.reload(); }} />}
    {showLiveConfirm && <div className="modal-backdrop" onClick={() => !liveBusy && setShowLiveConfirm(false)}><section className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><span className="lock-icon">实</span><h2>确认开启实盘</h2><p>开启后，当前系统形成的 BTC、ETH、SOL 计划会自动提交 Gate 合约挂单，成交后使用真实资金，并立即建立结构止损。</p><p>实盘账户总风险硬上限为10%，同方向相关风险不超过6.5%；只有你登录后可以改变这个开关。</p>{liveActionError && <p className="form-error">{liveActionError}</p>}<div className="modal-actions"><button className="secondary" type="button" disabled={liveBusy} onClick={() => setShowLiveConfirm(false)}>取消</button><button type="button" disabled={liveBusy} onClick={() => void setLiveMode(true)}>{liveBusy ? "正在核对 Gate…" : "确认开启实盘"}</button></div></section></div>}
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
      <section className="live-status-card"><div><small>Gate 实盘状态</small><h2>{liveEnabled ? live?.operational ? "实盘已开启" : "实盘待恢复 · 暂停新单" : "实盘已关闭"}</h2><p>{readableLiveError || (skips.length ? `${skips.length} 个计划受当前账户规模限制，系统会继续等待其他可执行计划` : connectionText)}</p></div><div className="live-actions"><button type="button" disabled={liveBusy || !credential?.configured || liveEnabled} className="danger-outline" onClick={onCleanup}>撤销系统遗留挂单</button><button type="button" disabled={liveBusy || !credential?.configured} className={liveEnabled ? "danger-action" : "primary-action"} onClick={onToggle}>{liveBusy ? "正在与 Gate 核对…" : liveEnabled ? "关闭实盘并撤单" : "开启实盘"}</button></div></section>
      {liveActionError && <p className="form-error">{liveActionError}</p>}
      {!liveEnabled && <p className="cleanup-help">如果 Gate 仍显示以前由本系统创建的挂单，点“撤销系统遗留挂单”。只撤销带本系统标签的入场单，不会撤销你的手工订单。</p>}
      <section className="summary four live-summary"><article><small>真实账户权益</small><strong>{num(live?.equity, 2)} U</strong><p>{connectionText}</p></article><article><small>可用保证金</small><strong>{num(live?.available, 2)} U</strong><p>Gate 返回的可用余额</p></article><article><small>持仓浮盈亏</small><strong className={liveFloating >= 0 ? "positive" : "negative"}>{signed(liveFloating)} U</strong><p>{positions.length} 个真实持仓</p></article><article><small>已计划风险</small><strong>{num(liveRisk, 2)} U</strong><p>保证金约 {num(occupiedMargin, 2)} U · 总上限 10%</p></article></section>
      <div className="live-facts"><Setting title="API 状态" detail={credential?.configured ? `密钥 ${credential.keyHint ?? "已加密"} · ${time(credential.lastVerifiedAt)}` : "进入 API 管理保存或更换"} value={credential?.configured ? "已验证" : "未配置"} tone={credential?.configured ? "online" : "locked"}/><Setting title="最近账户核对" detail="页面关闭后后台仍按策略运行。" value={time(live?.lastSyncAt)} tone={live?.lastSyncAt ? "online" : "locked"}/></div>
    </>}
    {view === "orders" && <section className="panel-list live-orders">{!positions.length && !entries.length && !skips.length && <div className="empty"><b>当前没有实盘订单</b><p>震荡/反转会在 Gate 预挂限价；突破只在收盘确认后实时成交。</p></div>}{skips.map((skip) => <article className="live-skip-card" key={`live-skip:${skip.symbol}:${skip.planId}`}><div><small>{skip.symbol.replace("_", "/")}</small><h3>本轮未挂单</h3></div><p>{skip.reason}</p><span>实盘仍在运行；出现账户可承受的新计划时会自动挂单。</span></article>)}{positions.map((position) => { const evidence = runtime?.evidence[position.symbol]; const protection = position.stopPrice ?? position.currentStop; return <OrderCard key={`live:${position.symbol}`} symbol={position.symbol} side={position.side} label="实盘持仓" state={position.scenario} notional={position.notional} equity={live?.equity ?? INITIAL_EQUITY} mode="LIVE" leverage={position.leverage} margin={position.margin} positionView={{ entryAt: position.entryAt, entryPrice: position.entryPrice, stopPrice: protection, targetPrice: position.currentTarget, markPrice: evidence?.midpoint, markAt: evidence?.observedAt, fresh: Boolean(evidence?.fresh) }} values={[["真实进场", position.entryPrice], ["原始止损", position.initialStop], ["交易所保护位", protection], ["动态目标", position.currentTarget], ["实际计划风险", position.plannedRisk]]} />; })}{entries.map((entry) => <OrderCard key={`live:${entry.symbol}:entry`} symbol={entry.symbol} side={entry.side} label={entry.status === "ERROR" ? "异常待核对" : entry.kind === "MARKET" ? "突破确认后实时单" : entry.kind === "PRICE_TRIGGER" ? "旧版触发挂单" : "实盘限价挂单"} state={entry.scenario} notional={entry.notional} equity={live?.equity ?? INITIAL_EQUITY} mode="LIVE" leverage={entry.leverage} margin={entry.margin} note={friendlyLiveError(entry.lastError) ?? undefined} values={[[entry.kind === "MARKET" ? "确认进场参考" : "挂单进场", entry.trigger], ["结构止损", entry.invalidation], ["动态目标", entry.target], ["实际计划风险", entry.plannedRisk]]} />)}</section>}
    {view === "api" && <section className="credential-panel"><div className="section-heading"><div><h2>Gate 实盘 API</h2><p>新 API 验证成功后会加密覆盖旧 API，页面永远不回显 Secret。</p></div><span className={credential?.configured ? "positive" : "negative"}>{credential?.configured ? "已保存" : "未保存"}</span></div><div className="credential-current"><div><small>当前 API</small><b>{credential?.keyHint ?? "尚未配置"}</b><p>{credential?.configured ? `最后验证 ${time(credential.lastVerifiedAt)} · Gate 实盘` : "填写下方两项后保存"}</p></div>{credential?.configured && <button className="danger-outline" type="button" disabled={credentialBusy || liveEnabled || positions.length > 0 || entries.length > 0} onClick={() => void deleteCredential()}>删除 API</button>}</div><form className="credential-form" onSubmit={saveCredential}><label><span>API Key</span><input value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} placeholder="填写新的 Gate API Key" /></label><label><span>API Secret</span><input type="password" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} autoComplete="new-password" spellCheck={false} placeholder="填写新的 Gate API Secret" /></label><p className="credential-help">只使用 Gate USDT 永续合约读取与交易权限；不要开启提现权限。保存 API 不会开启实盘。API 过期时直接验证并覆盖；只有 Gate 已无持仓和挂单时才允许删除。</p>{liveEnabled && <p className="form-error">请先关闭实盘开关，才可以更换或删除 API。</p>}{credentialError && <p className="form-error">{credentialError}</p>}{credentialNotice && <p className="form-success">{credentialNotice}</p>}{verification && <p className="credential-check">已核对：权益 {num(verification.equity, 2)} U · 持仓 {verification.positions} · 普通挂单 {verification.orders} · 条件单 {verification.conditionalOrders}</p>}<button className="primary-action" type="submit" disabled={credentialBusy || liveEnabled || apiKey.trim().length < 8 || apiSecret.trim().length < 8}>{credentialBusy ? "正在验证 Gate…" : credential?.configured ? "验证并更换 API" : "验证并保存 API"}</button></form></section>}
  </section>;
}

function OrderCard({ symbol, side, label, state, notional, equity, values, mode = "PAPER", leverage: actualLeverage, margin: actualMargin, note, positionView }: { symbol: string; side: Side; label: string; state: MarketState; notional: number; equity: number; values: [string, number][]; mode?: "PAPER" | "LIVE"; leverage?: number; margin?: number; note?: string; positionView?: PositionView }) {
  const leverage = actualLeverage ?? displayLeverage(notional, equity), margin = actualMargin ?? notional / leverage;
  const mark = positionView?.markPrice;
  const pnl = positionView && mark ? unrealizedPnl(notional, side, positionView.entryPrice, mark) : null;
  const priceReturn = positionView && mark ? directionalReturnRate(side, positionView.entryPrice, mark) : null;
  const marginReturn = pnl == null ? null : marginReturnRate(pnl, margin);
  return <article className={`order-card ${mode === "LIVE" ? "live-card" : ""}`}><div><span className={`side ${side.toLowerCase()}`}>{side === "LONG" ? "多" : "空"}</span><div><h3>{symbol.replace("_", "/")} · {label}</h3><p>{stateText[state]} · {mode === "LIVE" ? "Gate 真实合约" : "PAPER 模拟合约"}</p></div></div><strong style={{ textAlign: "right" }}><small style={{ display: "block", color: "var(--muted)", fontSize: 10 }}>合约名义价值</small>{num(notional, 2)} U</strong>{positionView && <section className="position-pnl"><div><small>浮动盈亏</small><strong className={pnl == null ? "" : pnl >= 0 ? "positive" : "negative"}>{pnl == null ? "等待行情" : `${signed(pnl)} U`}</strong><span>未扣平仓成本</span></div><div><small>保证金收益率</small><strong className={marginReturn == null ? "" : marginReturn >= 0 ? "positive" : "negative"}>{marginReturn == null ? "—" : `${signed(marginReturn * 100)}%`}</strong><span>方向价格变动 {priceReturn == null ? "—" : `${signed(priceReturn * 100)}%`}</span></div><div><small>当前价格</small><strong>{num(mark, 5)}</strong><span>{positionView.fresh ? `行情 ${time(positionView.markAt)}` : "最近后台价 · 行情恢复中"}</span></div></section>}<dl>{values.map(([name, value]) => { const money = /风险|盈亏/.test(name); return <div key={name}><dt>{name}</dt><dd className={name.includes("盈亏") ? value >= 0 ? "positive" : "negative" : ""}>{num(value, money ? 2 : 5)}{money ? " U" : ""}</dd></div>; })}<div><dt>{mode === "LIVE" ? "真实杠杆" : "模拟杠杆"}</dt><dd>{leverage}×</dd></div><div><dt>{mode === "LIVE" ? "实际保证金" : "预计保证金"}</dt><dd>{num(margin, 2)} U</dd></div></dl>{positionView && <PositionLiveChart symbol={symbol} side={side} view={positionView} />}<p style={{ gridColumn: "1 / -1", margin: 0, color: note && mode === "LIVE" ? "var(--red)" : "var(--muted)", fontSize: 11 }}>{note ?? (mode === "LIVE" ? "真实订单由 Gate 托管；结构止损为 reduce-only，不能反向开仓。" : "触发时按最新价格、权益和组合风险重新计算。")}</p></article>;
}

function PositionLiveChart({ symbol, side, view }: { symbol: string; side: Side; view: PositionView }) {
  const [points, setPoints] = useState<PositionPricePoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}&interval=1m`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { candles?: Candle[] };
      const start = (view.entryAt ?? 0) - 60_000;
      const seeded = (payload.candles ?? []).filter((row) => row.time * 1_000 >= start && Number.isFinite(row.close) && row.close > 0).map((row) => ({ time: row.time * 1_000, price: row.close }));
      if (active) setPoints((current) => mergePricePoints(seeded, current));
    }).catch(() => undefined).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [symbol, view.entryAt]);

  const fallbackTime = view.markAt ?? points.at(-1)?.time ?? view.entryAt ?? 0;
  const currentPoint = view.markPrice && fallbackTime > 0 ? [{ time: fallbackTime, price: view.markPrice }] : [];
  const observed = mergePricePoints(aggregateClosePoints(points, 5 * 60_000), currentPoint);
  const rows = observed.length > 1 ? observed : mergePricePoints([{ time: view.entryAt ?? Math.max(0, fallbackTime - 60_000), price: view.entryPrice }], observed);
  const width = 760, height = 250, left = 18, right = 18, top = 24, bottom = 28;
  const levels = [{ value: view.stopPrice, label: "止损", kind: "stop" }, { value: view.targetPrice, label: "止盈", kind: "target" }].filter((level) => Number.isFinite(level.value) && level.value > 0);
  const prices = [...rows.map((row) => row.price), view.entryPrice, ...levels.map((level) => level.value), ...(view.markPrice ? [view.markPrice] : [])];
  const rawMin = prices.length ? Math.min(...prices) : 0, rawMax = prices.length ? Math.max(...prices) : 1;
  const padding = Math.max((rawMax - rawMin) * .09, rawMax * .0005, 1e-9);
  const minPrice = rawMin - padding, maxPrice = rawMax + padding, plotHeight = height - top - bottom;
  const startTime = rows[0]?.time ?? fallbackTime - 60_000, endTime = Math.max(rows.at(-1)?.time ?? fallbackTime, startTime + 1_000);
  const x = (value: number) => left + (value - startTime) / Math.max(endTime - startTime, 1) * (width - left - right);
  const y = (value: number) => top + (maxPrice - value) / Math.max(maxPrice - minPrice, 1e-9) * plotHeight;
  const line = rows.map((point) => `${x(point.time)},${y(point.price)}`).join(" ");
  const current = rows.at(-1);

  return <section className="position-chart" aria-label={`${symbol.replace("_", "/")} 持仓实时价格走势`}><div className="position-chart-head"><div><b>持仓实时走势</b><small>5分钟收盘线 + 约15秒当前价</small></div><span className={view.fresh ? "positive" : "negative"}>{view.fresh ? "实时" : "保留最近价"}</span></div><div className="position-line-canvas">{!rows.length ? <div className="chart-loading">{loading ? "正在读取走势…" : "等待行情"}</div> : <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`从进场至今的5分钟价格线，含进场、止损和止盈`} preserveAspectRatio="none">
    {[.25, .5, .75].map((ratio) => <line className="chart-grid" key={ratio} x1={left} x2={width - right} y1={top + plotHeight * ratio} y2={top + plotHeight * ratio} />)}
    {levels.map((level, index) => <g className={`position-level ${level.kind}`} key={`${level.kind}:${level.value}`}><line x1={left} x2={width - right} y1={y(level.value)} y2={y(level.value)} /><text x={index === 0 ? width * .42 : width - right - 5} textAnchor={index === 1 ? "end" : "start"} y={Math.max(13, y(level.value) - 6)}>{level.label} {num(level.value, 5)}</text></g>)}
    {line && <polyline className={`position-price-line ${side.toLowerCase()}`} points={line} />}
    <g className="position-entry-marker"><circle cx={x(view.entryAt ?? startTime)} cy={y(view.entryPrice)} r="6" /><text x={Math.min(width - right - 90, x(view.entryAt ?? startTime) + 10)} y={Math.max(13, y(view.entryPrice) - 8)}>进场 {num(view.entryPrice, 5)}</text></g>
    {current && <g className="position-current"><line x1={left} x2={width - right} y1={y(current.price)} y2={y(current.price)} /><circle cx={x(current.time)} cy={y(current.price)} r="5" /><text x={width - right - 5} y={Math.max(13, y(current.price) - 7)} textAnchor="end">当前 {num(current.price, 5)}</text></g>}
    <text className="axis-label" x={left} y={height - 8}>{time(startTime)}</text><text className="axis-label end" x={width - right} y={height - 8}>{time(endTime)}</text>
  </svg>}</div><p>{loading ? "正在补齐进场后的缓存走势" : `${rows.length} 个5分钟节点 · 行情恢复时图线保留，不用旧价格触发交易`}</p></section>;
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

function HistoryOrder({ item }: { item: HistoryItem }) {
  const [open, setOpen] = useState(false);
  const cost = item.feesAndSlippage ?? 0;
  const gross = (item.realizedPnl ?? 0) + cost;
  return <article className="history-order"><div><span className={`side ${item.side.toLowerCase()}`}>{item.side === "LONG" ? "多" : "空"}</span><div><b>{item.symbol.replace("_", "/")}</b><small>{time(item.entryAt)} · {stateText[item.marketState]}</small></div></div><div><small>进场 / 出场</small><b>{num(item.entryPrice, 5)} / {num(item.exitPrice, 5)}</b></div><div><small>净结果</small><b className={(item.realizedPnl ?? 0) >= 0 ? "positive" : "negative"}>{item.status === "OPEN" ? "持仓中" : `${signed(item.realizedPnl ?? 0)} U`}</b></div><div><small>持仓 / 结束原因</small><b>{durationText(item.entryAt, item.exitAt)} · {item.status === "OPEN" ? "尚未结束" : resolvedExitText(item.exitReason, item.initialStop, item.currentStop)}</b></div>
    <details className="history-review" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>查看 5 分钟进出场走势</summary>{open && <OrderReviewChart item={item} gross={gross} cost={cost} />}</details>
  </article>;
}

function AccountLogs({ cycle, items }: { cycle: PaperCycleSummary | null; items: AccountLogItem[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copyReport = (item: AccountLogItem) => {
    void navigator.clipboard.writeText(JSON.stringify(item.report, null, 2)).then(() => {
      setCopied(item.id);
      window.setTimeout(() => setCopied((current) => current === item.id ? null : current), 2_000);
    }).catch(() => setCopied(null));
  };
  return <div className="account-log-list">
    <section className="cycle-card"><div><small>当前模拟账户周期</small><h2>第 {cycle?.number ?? 1} 轮运行中</h2><p>权益达到 300 U 时，系统会归档完整破产分析，并自动开启新的 1,000 U 模拟周期。</p></div><div className="cycle-metrics"><span>本轮起始<b>{num(cycle?.startingEquity, 2)} U</b></span><span>当前权益<b>{num(cycle?.currentEquity, 2)} U</b></span><span>破产线<b>300 U</b></span><span>已结束交易<b>{cycle?.trades ?? 0} 笔</b></span></div>{cycle && <div className="cycle-progress"><i style={{ width: `${Math.max(0, Math.min(100, (cycle.currentEquity - cycle.bankruptcyLine) / Math.max(cycle.startingEquity - cycle.bankruptcyLine, 1) * 100))}%` }} /></div>}</section>
    {!items.length ? <div className="empty"><b>还没有破产记录</b><p>当前周期结束后，这里会永久保留详细诊断，不会覆盖交易历史。</p></div> : items.map((item) => {
      const report = item.report;
      return <article className="bankruptcy-card" key={item.id}><div className="bankruptcy-head"><div><small>模拟账户破产记录</small><h2>第 {report.cycleNumber} 轮 · 已归档</h2><p>{time(report.startedAt)} 至 {time(report.endedAt)}</p></div><button type="button" onClick={() => copyReport(item)}>{copied === item.id ? "已复制" : "复制完整诊断"}</button></div>
        <div className="bankruptcy-metrics"><span>起始 / 结束<b>{num(report.startingEquity, 2)} / {num(report.endingEquity, 2)} U</b></span><span>本轮净结果<b className="negative">-{num(report.loss, 2)} U</b></span><span>最大回撤<b>{num(report.maxDrawdownRate * 100, 1)}%</b></span><span>交易 / 胜率<b>{report.performance.trades} 笔 / {num(report.performance.wins / Math.max(report.performance.trades, 1) * 100, 1)}%</b></span><span>方向正确率<b>{num(report.direction.correctAtExitRate * 100, 1)}%</b></span><span>覆盖成本波动<b>{num(report.direction.feeCoveringMoveRate * 100, 1)}%</b></span><span>目标到达率<b>{num(report.targets.reachedRate * 100, 1)}%</b></span><span>平均持仓<b>{durationText(0, report.exits.averageHoldingSeconds * 1_000)}</b></span><span>毛结果 / 成本<b>{signed(report.performance.grossPnl)} / {num(report.performance.costs, 2)} U</b></span><span>平均计划净盈亏比<b>{num(report.entries.averagePlannedNetRewardRisk, 2)} : 1</b></span><span>止损触发<b>{report.stops.reached} 笔</b></span><span>一分钟内结束<b>{report.exits.underOneMinute} 笔</b></span></div>
        <section className="root-causes"><h3>系统归纳的主要破产原因</h3><ol>{report.rootCauses.map((cause) => <li key={cause}>{cause}</li>)}</ol></section>
        <details className="bankruptcy-details"><summary>查看分类结果和指标定义</summary><p>“方向正确”表示扣除成本前，出场价格仍在计划方向；“覆盖成本波动”表示持仓期间最大顺向波动达到模型往返成本 0.18%。完整 JSON 还包含每一笔订单的最大顺向/逆向波动、止损使用比例和目标进度。</p><Breakdown title="按币种" rows={report.breakdown.symbols} /><Breakdown title="按三态" rows={report.breakdown.scenarios} /><Breakdown title="按方向" rows={report.breakdown.sides} /></details>
      </article>;
    })}
  </div>;
}

function Breakdown({ title, rows }: { title: string; rows: Record<string, BreakdownRow> }) {
  return <div className="breakdown"><b>{title}</b>{Object.entries(rows).map(([name, row]) => <span key={name}>{stateText[name] ?? (name === "LONG" ? "做多" : name === "SHORT" ? "做空" : name.replace("_", "/"))}<small>{row.trades} 笔 · {row.wins} 胜 · <i className={row.netPnl >= 0 ? "positive" : "negative"}>{signed(row.netPnl)} U</i></small></span>)}</div>;
}

function OrderReviewChart({ item, gross, cost }: { item: HistoryItem; gross: number; cost: number }) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const read = async () => {
      try {
        const response = await fetch(`/api/order-chart?id=${encodeURIComponent(item.id)}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as { source: string; ready: boolean; candles: Candle[] };
        const valid = (payload.candles ?? []).filter((row) => [row.time, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite) && row.time > 0 && row.low > 0 && row.high >= row.low);
        if (active) { setCandles(valid); setReady(Boolean(payload.ready)); setChartError(null); }
      } catch (failure) { if (active) setChartError(failure instanceof Error ? failure.message : "读取失败"); }
      finally { if (active) setLoading(false); }
    };
    void read();
    const timer = window.setInterval(read, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [item.id]);

  const points = aggregateClosePoints(candles.map((row) => ({ time: row.time * 1_000, price: row.close })), 5 * 60_000);
  const rows = points.length <= 72 ? points : [...points.slice(0, 24), ...points.slice(-48)];
  const width = 720, height = 270, left = 12, right = 12, top = 24, bottom = 34;
  const candleEnd = rows.at(-1)?.time ? rows.at(-1)!.time + 5 * 60_000 : null;
  const exitAt = item.exitAt ?? candleEnd ?? item.entryAt, exitPrice = item.exitPrice ?? item.entryPrice;
  const levels = [{ value: item.initialStop, label: "原始止损", kind: "stop" }, { value: item.currentTarget, label: "计划止盈", kind: "target" }].filter((level) => Number.isFinite(level.value) && level.value > 0);
  const allPrices = [...rows.map((row) => row.price), item.entryPrice, exitPrice, ...levels.map((level) => level.value)];
  const rawMin = allPrices.length ? Math.min(...allPrices) : 0, rawMax = allPrices.length ? Math.max(...allPrices) : 1;
  const padding = Math.max((rawMax - rawMin) * .09, rawMax * .0004, 1e-9);
  const minPrice = rawMin - padding, maxPrice = rawMax + padding, plotHeight = height - top - bottom;
  const y = (value: number) => top + (maxPrice - value) / Math.max(maxPrice - minPrice, 1e-9) * plotHeight;
  const startAt = Math.min(rows[0]?.time ?? item.entryAt, item.entryAt);
  const endAt = Math.max(rows.at(-1)?.time ? rows.at(-1)!.time + 5 * 60_000 : exitAt, exitAt, startAt + 5 * 60_000);
  const x = (value: number) => left + (Math.max(startAt, Math.min(endAt, value)) - startAt) / Math.max(endAt - startAt, 1) * (width - left - right);
  const line = rows.map((point) => `${x(point.time)},${y(point.price)}`).join(" ");
  return <div className="review-chart"><div className="review-metrics"><span>毛盈亏 <b className={gross >= 0 ? "positive" : "negative"}>{signed(gross)} U</b></span><span>成本 <b className="negative">-{num(cost, 2)} U</b></span><span>净盈亏 <b className={(item.realizedPnl ?? 0) >= 0 ? "positive" : "negative"}>{signed(item.realizedPnl ?? 0)} U</b></span><span>持仓 <b>{durationText(item.entryAt, item.exitAt)}</b></span></div>
    {!rows.length ? <div className="chart-loading">{loading ? "正在读取并整理这笔订单的 5 分钟走势…" : `复盘走势暂不可用${chartError ? `：${chartError}` : ""}`}</div> : <>
      <div className="chart-canvas review-canvas"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${item.symbol.replace("_", "/")} 订单5分钟进出场走势`} preserveAspectRatio="none">
        {[.25, .5, .75].map((ratio) => <line className="chart-grid" key={ratio} x1={left} x2={width - right} y1={top + plotHeight * ratio} y2={top + plotHeight * ratio} />)}
        {levels.map((level, index) => <g className={`position-level ${level.kind}`} key={`${level.kind}:${level.value}`}><line x1={left} x2={width - right} y1={y(level.value)} y2={y(level.value)} /><text x={index === 0 ? left + 5 : width - right - 5} textAnchor={index === 1 ? "end" : "start"} y={Math.max(13, y(level.value) - 6)}>{level.label} {num(level.value, 5)}</text></g>)}
        {line && <polyline className={`position-price-line ${item.side.toLowerCase()}`} points={line} />}
        <g className="review-marker entry"><circle cx={x(item.entryAt)} cy={y(item.entryPrice)} r="6" /><text x={Math.min(width - right - 90, x(item.entryAt) + 10)} y={Math.max(13, y(item.entryPrice) - 8)}>进场 {num(item.entryPrice, 5)}</text></g>
        <g className="review-marker exit"><circle cx={x(exitAt)} cy={y(exitPrice)} r="6" /><text x={Math.max(left + 90, x(exitAt) - 10)} textAnchor="end" y={Math.min(height - bottom - 4, y(exitPrice) + 16)}>出场 {num(exitPrice, 5)}</text></g>
        <text className="axis-label" x={left} y={height - 9}>{time(startAt)}</text><text className="axis-label end" x={width - right} y={height - 9}>{time(endAt)}</text>
      </svg></div>
      <div className="review-levels"><span>原始止损 <b>{num(item.initialStop, 5)}</b></span><span>最终保护位 <b>{num(item.currentStop, 5)}</b></span><span>计划目标 <b>{num(item.currentTarget, 5)}</b></span><span>{rows.length} 个 5 分钟收盘节点</span></div>
      {!ready && <p className="review-wait">出场附近的原始分钟数据收齐后会自动补全。</p>}
    </>}
  </div>;
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
  const chartStructureAligned = interval !== "15m" || !evidence?.range15m?.observedAt
    || ((rows.at(-1)?.time ?? 0) + 900) * 1_000 >= evidence.range15m.observedAt;
  const rawLevels = [
    interval === "15m" && chartStructureAligned && evidence?.range15m && { value: evidence.range15m.upper, label: "15m父区间上沿", kind: "range" },
    interval === "15m" && chartStructureAligned && evidence?.range15m && { value: evidence.range15m.lower, label: "15m父区间下沿", kind: "range" },
    interval === "15m" && chartStructureAligned && evidence?.range15m?.child && { value: evidence.range15m.child.upper, label: "15m子区间上沿", kind: "range" },
    interval === "15m" && chartStructureAligned && evidence?.range15m?.child && { value: evidence.range15m.child.lower, label: "15m子区间下沿", kind: "range" },
    position && { value: position.entryPrice, label: "持仓进场", kind: "entry" },
    position && { value: position.currentStop, label: "保护价", kind: "stop" },
    position && { value: position.currentTarget, label: "动态目标", kind: "target" },
    !position && decision && { value: decision.entryTrigger, label: "触发价", kind: "entry" },
    !position && decision && { value: decision.invalidation, label: "失效价", kind: "stop" },
    !position && decision && { value: decision.target, label: `${decision.targetTimeframe ?? "当前"}目标`, kind: "target" },
  ].filter((level): level is { value: number; label: string; kind: string } => Boolean(level && Number.isFinite(level.value) && level.value > 0));
  const uniqueLevels = rawLevels.filter((level, index) => rawLevels.findIndex((candidate) => Math.abs(candidate.value - level.value) <= Math.max(level.value, 1) * 1e-7) === index);
  const candlePrices = rows.flatMap((row) => [row.high, row.low]);
  const candleMin = candlePrices.length ? Math.min(...candlePrices) : 0;
  const candleMax = candlePrices.length ? Math.max(...candlePrices) : 1;
  const candleSpan = Math.max(candleMax - candleMin, candleMax * .001);
  const levels = uniqueLevels.filter((level) => level.value >= candleMin - candleSpan * .18 && level.value <= candleMax + candleSpan * .18);
  const offscreenLevels = uniqueLevels.filter((level) => !levels.includes(level));
  const allPrices = [...candlePrices, ...levels.map((level) => level.value)];
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
    <div className="chart-head"><div><b>真实期货 K 线</b><small>Gate USDT 合约 · 已收盘数据</small></div><div className="timeframes" aria-label="切换策略结构周期">{([['1m', '1分钟'], ['15m', '15分钟'], ['1h', '1小时'], ['4h', '4小时']] as const).map(([value, label]) => <button type="button" key={value} className={interval === value ? "active" : ""} onClick={() => setIntervalValue(value)}>{label}</button>)}</div></div>
    {!rows.length ? <div className="chart-loading">{loading ? "正在读取真实 K 线…" : `真实 K 线更新延迟${chartError ? `：${chartError}` : ""}`}</div> : <>
      <div className="chart-canvas"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${rows.length} 根 ${interval} 已收盘K线及策略区域`} preserveAspectRatio="none">
        {[.25, .5, .75].map((ratio) => <line className="chart-grid" key={ratio} x1={left} x2={width - right} y1={top + plotHeight * ratio} y2={top + plotHeight * ratio} />)}
        {levels.filter((level) => level.kind === "range").map((level) => <rect className="zone-band" key={`${level.label}:${level.value}`} x={left} width={width - left - right} y={y(level.value) - 4} height="8" />)}
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
      {!!offscreenLevels.length && <div className="offscreen-levels">{offscreenLevels.map((level) => <span key={`${level.kind}:${level.value}`}>{level.value > candleMax ? "↑" : "↓"} {level.label} <b>{num(level.value, 5)}</b></span>)}</div>}
      {!chartStructureAligned && <p className="review-wait">结构已使用更新的完整15分钟K线，图表同步前暂不叠加边界，避免新旧数据错位。</p>}
      <div className="ohlc"><span>开 <b>{num(latest?.open, 5)}</b></span><span>高 <b>{num(latest?.high, 5)}</b></span><span>低 <b>{num(latest?.low, 5)}</b></span><span>收 <b>{num(latest?.close, 5)}</b></span><small>{loading ? "更新中" : chartError ? "保留上次真实数据" : `${rows.length} 根 · ${time(updatedAt)}`}</small></div>
    </>}
  </section>;
}

function Setting({ title, detail, value, tone = "" }: { title: string; detail: string; value: string; tone?: string }) {
  return <div className="setting-row"><div><b>{title}</b><p>{detail}</p></div><span className={`setting-value ${tone}`}>{value}</span></div>;
}
