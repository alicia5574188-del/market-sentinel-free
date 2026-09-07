"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
type PaperCycleSummary = { number: number; startedAt: number; startingEquity: number; currentEquity: number; bankruptcyLine: number; peakEquity: number; trades: number; drawdownRate: number };
type CycleTradeDiagnostic = { id: string; symbol: string; scenario: MarketState; side: Side; entryAt: number; exitAt: number; holdingSeconds: number; entryPrice: number; exitPrice: number; initialStop: number; target: number; notional: number; plannedRisk: number; plannedNetRewardRisk: number; grossPnl: number; costs: number; netPnl: number; mfeRate: number; maeRate: number; targetProgress: number; stopUse: number; directionCorrectAtExit: boolean; feeCoveringMove: boolean; targetReached: boolean; stopReached: boolean; exitReason: string };
type RadarCandidate = { id: string; symbol: string; side: Side; strength: number; moveRate: number; movementMultiple: number; volume24hUsd: number; confirmations: number; firstSeenAt: number; observedAt: number; kind: "NEW_MONEY" | "SQUEEZE" | "LIQUIDATION" | "PRICE_SHOCK" };
type Runtime = {
  version: string; mode: "PAPER"; state: string; stale: boolean; generatedAt: number; lastSuccessAt: number | null; lastError: string | null; symbols: string[]; equity: number; dailyStartEquity?: number;
  decisions: Record<string, Decision | null>; routes: Record<string, LiquidityRoute[]>; plans: Record<string, Plan | null>; positions: Record<string, Position | null>; authorityReady: boolean;
  evidence: Record<string, { midpoint: number; observedAt: number; warmup: number; fresh: boolean; ancillaryFresh: boolean; entryReady?: boolean; optionalFresh?: boolean; recoveryFreshCount?: number; suspensionReason?: string | null; topLong: Zone | null; topShort: Zone | null; absorption: number; range15m: RangeStructure | null }>;
  feedFailures?: Record<string, { count: number; retryAt: number; suspendedSince?: number | null; totalFailures?: number; recoveries?: number; lastFailureAt?: number | null; lastError?: string | null; maxObservedLagMs?: number }>;
  limits: { maxOpenPositions: number; warmupSnapshots?: number; loopMs?: number; radarMs?: number; scannedMarkets?: number; maxAncillaryConcurrency?: number };
  liveMode: { requestedEnabled: boolean; operational: boolean };
  paperCycle: PaperCycleSummary;
  radar?: { scanned: number; lastScanAt: number | null; candidates: RadarCandidate[] };
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
  rootCauses: string[]; trades: CycleTradeDiagnostic[] };
type AccountLogItem = { id: string; observedAt: number; report: BankruptcyReport };
type Tab = "brain" | "orders" | "live" | "history" | "settings";
type LiveView = "account" | "orders" | "api";
type HistoryView = "trades" | "account_logs";
type PaperAction = "RESET" | "CLEAR_HISTORY";
type PositionView = { entryAt?: number; entryPrice: number; stopPrice: number; targetPrice: number; markPrice?: number; markAt?: number; fresh: boolean };

const INITIAL_EQUITY = 1_000;
const DAILY_PROFIT_TARGET = 150;
const RUNTIME_REQUEST_TIMEOUT_MS = 30_000;
const RUNTIME_DISPLAY_TTL_MS = 90_000;
const stateText: Record<string, string> = { BREAKOUT: "突破", REVERSAL: "反转", RANGE: "震荡", LIVE: "运行中", WARMING: "预热中", DEGRADED: "部分数据恢复中", RECONNECTING: "重新连接中", RECOVERY_REQUIRED: "需要恢复", STARTING: "启动中" };
const sourceText: Record<string, string> = { BOOK: "真实挂单区", STOP_POOL: "止损集中区", LIQUIDATION: "估计清算区" };
const routeText: Record<RouteKind, string> = { LOCAL_BREAKOUT: "父区间强势突破观察", INTERNAL_ROTATION: "子区间强势迁移观察", BREAKOUT_RETEST: "突破回踩后再加速", FAILED_BREAKOUT_REVERSAL: "强假突破反向反抽", EDGE_REJECTION: "扫流动性收回后回踩", NODE_CONTINUATION: "高周期节点续破" };
const cancelText: Record<string, string> = { STALE_CANCEL: "行情失鲜", SEQUENCE_REBUILD_CANCEL: "盘口序列重建", PRE_ENTRY_INVALIDATION_CANCEL: "冻结结构已失效", GAP_ECONOMICS_CANCEL: "跳空后盈亏空间不足", STRUCTURE_REPLACED_CANCEL: "相关边界已被新结构替代", NONLOCAL_FALLBACK_CANCEL: "旧版非局部方案失效", TARGET_GONE_CANCEL: "目标连续消失", ROUTE_WEAK_CANCEL: "路线连续转弱", ACTIVATION_LOST_CANCEL: "价格连续离开激活范围", BREAKOUT_MISSED_CANCEL: "突破已超过追价上限", BREAKOUT_FIRST_CROSS_FAILED_CANCEL: "首次穿越立即失败", BREAKOUT_ACCEPTED_WAIT_RETEST: "普通突破转入回踩分支", PLAN_EXPIRED: "计划到期", GAP_RISK_CANCEL: "实际成交风险超限", FEED_HARD_FAILURE_CANCEL: "关键行情持续中断", PROCESS_RESTART_CANCEL: "后台版本切换", PAPER_CYCLE_BANKRUPTCY: "模拟轮次结束" };
const stageText: Record<RouteStage, string> = { LOCAL_TO_NODE: "当前段", AT_NODE: "节点决策", NODE_TO_NEXT: "后续段" };
const exitText: Record<string, string> = { STRUCTURAL_STOP: "价格到达扫盘与结构之外的硬止损", RANGE_OUTSIDE_ACCEPTANCE: "连续两根完整1分钟收在区间外，震荡结构失效", DYNAMIC_PROTECTION_STOP: "目标进度风险收缩止损", BREAKOUT_PROFIT_REJECTION: "突破浮盈大幅回吐，确认失败退出", TARGET_ABSORBED: "目标流动性已被吸收", TARGET_NODE_EXIT: "到达短线目标", EVENT_STALLED_EXIT: "资金异动十分钟没有形成有效推进", EVENT_MAX_HOLD_EXIT: "资金异动达到最长持仓时间", TARGET_DISAPPEARED: "目标流动性连续消失", TARGET_VANISHED: "目标消失", OPPOSITE_TARGET_DOMINANT: "反向目标占优", OPPOSITE_UTILITY_DOMINANT: "反向流动性连续占优", RISK_CAP_REBALANCE: "组合风险重新平衡", PORTFOLIO_RISK_REBALANCE: "组合风险重新平衡", MANUAL_PAPER_RESET: "手动重置模拟账户" };
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
const friendlyLiveError = (value: string | null | undefined) => !value ? null
  : value.includes("AUTO_INVALID_PARAM_TRIGGER_EXPIRATION")
    ? "Gate 拒绝了旧版触发单的有效期格式；系统已修复并会重新核对。"
    : value;

function waitReason(runtime: Runtime | null, marketReady: boolean, symbol: string) {
  if (!runtime) return "正在连接后台行情";
  const evidence = runtime.evidence[symbol];
  const plan = runtime.plans[symbol];
  const position = runtime.positions[symbol];
  if (!runtime.authorityReady || runtime.stale) return "后台循环暂时延迟，禁止使用旧价格成交；原计划保持冻结";
  if (!evidence?.fresh) return position?.status === "OPEN"
    ? "实时盘口短暂延迟：禁止用旧价格主动平仓；原始硬止损仍由既有保护逻辑管理"
    : plan?.state === "PREPARED"
    ? "实时盘口短暂延迟：保留原计划与边界，但禁止成交；恢复后重新确认"
    : "实时盘口短暂延迟，仅暂停该币的新成交";
  if (position?.status === "OPEN") {
    if (position.targetIdentity?.startsWith("EVENT_TARGET:")) return "资金异动短线持仓：硬止损与目标实时有效；十分钟无推进才退出，最长持有二十分钟";
    if (position.routeKind === "EDGE_REJECTION") return (position.rangeAcceptanceCount ?? 0) > 0
      ? `区间外接受观察 ${position.rangeAcceptanceCount}/2；重新收回区间会清零，硬止损仍即时保护`
      : "扫流动性后已回到区间；普通回调继续持有，目标前保护位不会越过进场价";
    const age = runtime.generatedAt - (position.entryAt ?? runtime.generatedAt);
    if (age < 2 * 60_000) return "持仓保护期：原始止损和目标仍实时执行，短周期软信号暂不平仓";
    if ((position.exitSignalCount ?? 0) > 0) return `软失效观察 ${position.exitSignalCount}/3；仅在完整1分钟收盘逆向达到0.75R后退出`;
    return "完整1分钟管理；达到1.5R且完成70%目标路程后只把剩余风险缩到0.5R，目标前不锁微利";
  }
  if (!evidence.ancillaryFresh) return plan?.state === "PREPARED"
    ? "关键周期结构正在刷新：原计划保留，刷新完成前禁止成交"
    : "关键周期结构正在刷新，暂不建立新计划";
  if (!marketReady || evidence.entryReady === false) return `行情已恢复，正在确认 ${evidence.recoveryFreshCount ?? 0}/2；确认前不成交`;
  const warmupTarget = Math.max(1, runtime.limits.warmupSnapshots ?? 4);
  if (evidence.warmup < warmupTarget) return `正在积累真实快照，还差 ${warmupTarget - evidence.warmup} 次`;
  const decision = runtime.decisions[symbol];
  const rebuildAt = position?.exitAt ? Math.floor(position.exitAt / 60_000) * 60_000 + 120_000 : Infinity;
  const reclaimedNow = decision ? (decision.side === "LONG" ? evidence.midpoint > decision.entryTrigger : evidence.midpoint < decision.entryTrigger) : false;
  if (position?.status === "CLOSED" && position.exitReason === "STRUCTURAL_STOP" && decision
    && position.side === decision.side && position.scenario === decision.marketState
    && (!position.routeId || !decision.routeId || position.routeId === decision.routeId)
    && (runtime.generatedAt < rebuildAt || !reclaimedNow)) {
    return "原结构已经止损；同方向方案等待两根完整1分钟K线重建并收复触发位";
  }
  if (plan?.state === "PREPARED") return plan.targetIdentity?.startsWith("EVENT_TARGET:")
    ? "全市场异动已通过两轮扫描，正在用实时盘口、主动成交和持仓量确认；通过后立即IOC，不等待K线收盘"
    : (plan.invalidationSignalCount ?? 0) > 0
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
  const reclaimedEdge = runtime.routes[symbol]?.find((route) => route.kind === "EDGE_REJECTION");
  if (reclaimedEdge) return reclaimedEdge.executableNow
    ? `${reclaimedEdge.side === "LONG" ? "下" : "上"}边界扫盘已收回，反弹回踩路线可进入仲裁；反向再次突破仍独立观察`
    : `${reclaimedEdge.side === "LONG" ? "下" : "上"}边界扫盘已收回：反弹等待合适回踩与净空间，同时观察反向再次强势突破`;
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
  const [paperAction, setPaperAction] = useState<PaperAction | null>(null);
  const [paperBusy, setPaperBusy] = useState(false);
  const [paperActionError, setPaperActionError] = useState<string | null>(null);
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
    if (tab !== "history") return;
    let active = true, inFlight = false, loadedAll = false;
    const readHistory = async (complete: boolean) => {
      if (!active || document.hidden || inFlight) return;
      inFlight = true;
      try {
        const logsPromise = fetch("/api/account-logs", { cache: "no-store" });
        const all: HistoryItem[] = [];
        let cursor: string | null = null;
        const seenCursors = new Set<string>();
        for (let page = 0; page < (complete ? 100 : 1); page += 1) {
          const query = new URLSearchParams({ limit: "100" });
          if (cursor) query.set("cursor", cursor);
          const response = await fetch(`/api/history?${query}`, { cache: "no-store" });
          if (!response.ok) break;
          const payload = await response.json() as { items: HistoryItem[]; nextCursor: string | null };
          all.push(...(payload.items ?? []));
          cursor = payload.nextCursor;
          if (!cursor || seenCursors.has(cursor)) break;
          seenCursors.add(cursor);
        }
        if (active) setHistory((current) => {
          if (complete) return [...new Map(all.map((item) => [item.id, item])).values()];
          const merged = new Map(current.map((item) => [item.id, item]));
          for (const item of all) merged.set(item.id, item);
          return [...merged.values()].sort((a, b) => (b.exitAt ?? b.entryAt) - (a.exitAt ?? a.entryAt));
        });
        const logsResponse = await logsPromise;
        if (logsResponse.ok && active) setAccountLogs(((await logsResponse.json()) as { items: AccountLogItem[] }).items ?? []);
        loadedAll ||= complete;
      } catch { /* History is optional; the live runtime remains authoritative. */ }
      finally { inFlight = false; }
    };
    void readHistory(true);
    const timer = window.setInterval(() => void readHistory(!loadedAll), 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [tab]);

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

  const runPaperAction = async () => {
    if (!paperAction) return;
    setPaperBusy(true); setPaperActionError(null);
    try {
      const reset = paperAction === "RESET";
      const response = await fetch(reset ? "/api/paper/reset" : "/api/paper/history/clear", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: reset ? "RESET_PAPER" : "CLEAR_PAPER_HISTORY" }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      location.reload();
    } catch (failure) { setPaperActionError(failure instanceof Error ? failure.message : "操作失败"); }
    finally { setPaperBusy(false); }
  };

  const openPaperAction = (action: PaperAction) => {
    if (!auth.authenticated) { setShowLogin(true); return; }
    setPaperActionError(null); setPaperAction(action);
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
  const dailyPnl = runtime ? runtime.equity - (runtime.dailyStartEquity ?? cycleStart) : 0;
  const dailyProgress = Math.max(0, Math.min(100, dailyPnl / DAILY_PROFIT_TARGET * 100));
  const primary = openPositions[0] ? { symbol: openPositions[0].symbol, side: openPositions[0].position.side, state: openPositions[0].position.scenario, kind: "position" }
    : preparedPlans[0] ? { symbol: preparedPlans[0].symbol, side: preparedPlans[0].plan.side, state: preparedPlans[0].plan.marketState, kind: "plan" }
      : bestDecision ? { symbol: bestDecision.symbol, side: bestDecision.decision.side, state: bestDecision.decision.marketState, kind: "decision" } : null;
  const primaryReady = primary ? Boolean(authorityOperational && runtime?.evidence[primary.symbol]?.fresh && runtime.evidence[primary.symbol]?.ancillaryFresh && runtime.evidence[primary.symbol]?.entryReady !== false) : false;
  const headline = !authorityOperational ? "行情正在恢复，暂不进场" : primary?.kind === "position" ? `正在持有 ${primary.symbol.replace("_", "/")} ${primary.side === "LONG" ? "多单" : "空单"}` : primary && !primaryReady ? "计划已冻结，等待行情确认" : primary ? `准备${sideText(primary.side)} ${primary.symbol.replace("_", "/")}` : "继续观察，暂不开仓";

  return <main>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">异</span><div><p>资金异动雷达</p><small>Gate 全市场短线系统</small></div></div>
      <div role="status" className={`health ${healthy ? "" : "bad"}`}><span />{healthy ? "后台运行中" : error ? "页面连接中断" : runtime?.stale ? "行情重连中" : runtime ? stateText[runtime.state] ?? runtime.state : "正在连接"}</div>
    </header>

    {tab === "brain" && <>
      <section className="brain-hero"><div><p className="eyebrow">全市场资金雷达</p><h1>{headline}</h1><p className="hero-detail">已扫描 {runtime?.radar?.scanned ?? 0} 个可交易合约 · 当前 {runtime?.radar?.candidates.length ?? 0} 个异动候选 · 订单数量不设每日上限</p></div><div className="decision-badge"><small>今日目标进度</small><strong>{num(dailyProgress, 0)}%</strong><span>{signed(dailyPnl)} / +150 U</span></div></section>

      <section className="summary four">
        <article><small>模拟账户权益</small><strong>{runtime ? `${num(runtime.equity, 2)} U` : "—"}</strong><p>第 {runtime?.paperCycle?.number ?? 1} 轮 · 起始 {num(cycleStart, 0)} U</p></article>
        <article><small>今日模拟盈亏</small><strong className={dailyPnl >= 0 ? "positive" : "negative"}>{runtime ? `${signed(dailyPnl)} U` : "—"}</strong><div className="risk-bar"><i style={{ width: `${dailyProgress}%` }} /></div><p>目标 +150 U · 不强制凑单</p></article>
        <article><small>当前持仓浮盈亏</small><strong className={floatingPnl >= 0 ? "positive" : "negative"}>{runtime ? `${signed(floatingPnl)} U` : "—"}</strong><p>{openPositions.length} 笔模拟持仓</p></article>
        <article><small>组合风险预算</small><strong>{num(riskUsed, 2)} / {num(riskLimit, 2)} U</strong><div className="risk-bar"><i style={{ width: `${Math.min(100, riskLimit ? riskUsed / riskLimit * 100 : 0)}%` }} /></div><p>剩余 {num(Math.max(0, riskLimit - riskUsed), 2)} U</p></article>
      </section>
      {(!responseFresh || error) && runtime && <p className="notice">手机页面更新延迟，下面保留最近一次后台状态；服务器仍独立运行，不会因此停止判断或开模拟单。</p>}{runtime?.lastError && <p className="notice">{runtime.lastError.startsWith("D1") ? `历史镜像稍后重试，不影响行情判断和开仓：${runtime.lastError}` : `系统正在自动恢复：${runtime.lastError}`}</p>}
    </>}

    <nav className="tabs">{([['brain', '雷达'], ['orders', `订单 ${openPositions.length + preparedPlans.length || ''}`], ['live', `实盘 ${openLivePositions.length + openLiveEntries.length || ''}`], ['history', '复盘'], ['settings', '设置']] as const).map(([key, label]) => <button key={key} type="button" className={tab === key ? "active" : ""} onClick={() => selectTab(key)}>{label}</button>)}</nav>

    <section className="radar-board" hidden={tab !== "brain"}>
      <div className="radar-board-head"><div><small>实时异动</small><b>只把最强 3 个候选升级为 2 秒监控</b></div><span>{time(runtime?.radar?.lastScanAt)}</span></div>
      <div className="radar-candidates">{runtime?.radar?.candidates.slice(0, 6).map((item) => <article key={item.id}>
        <div><b>{item.symbol.replace("_", "/")}</b><small>{item.kind === "NEW_MONEY" ? "新增资金" : item.kind === "SQUEEZE" ? "空头挤压" : item.kind === "LIQUIDATION" ? "多头出清" : "价格异动"}</small></div>
        <strong className={item.side === "LONG" ? "positive" : "negative"}>{item.side === "LONG" ? "做多" : "做空"}</strong>
        <span>强度 {num(item.strength, 0)} · {item.confirmations}轮</span>
      </article>)}{!runtime?.radar?.candidates.length && <p>正在扫描所有 Gate USDT 永续合约，出现异常资金后自动进入实时确认。</p>}</div>
    </section>

    <section className="markets" hidden={tab !== "brain"}>{runtime?.symbols.map((symbol) => {
      const evidence = runtime.evidence[symbol], marketFresh = Boolean(authorityOperational && evidence?.fresh && evidence?.ancillaryFresh && evidence?.entryReady !== false);
      const decision = marketFresh ? runtime.decisions[symbol] : null, plan = runtime.plans[symbol], position = runtime.positions[symbol];
      const routes = runtime.routes[symbol] ?? [];
      const acceptedBreak = evidence?.range15m?.breakState === "BROKEN_UP" ? "向上" : evidence?.range15m?.breakState === "BROKEN_DOWN" ? "向下" : null;
      const reclaimedEdge = routes.find((route) => route.kind === "EDGE_REJECTION");
      const positionIntent: Decision | null = position?.status === "OPEN" ? { marketState: position.scenario, side: position.side,
        entryTrigger: position.entryPrice, invalidation: position.currentStop, target: position.currentTarget, score: 0,
        reason: ["沿冻结路线持仓；短周期变化只预警，完整确认后才调整保护"] } : null;
      const intent = positionIntent ?? (plan?.state === "PREPARED" ? plan : decision);
      const eventIntent = Boolean(intent?.targetIdentity?.startsWith("EVENT_TARGET:") || position?.targetIdentity?.startsWith("EVENT_TARGET:"));
      const warmupTarget = Math.max(1, runtime.limits.warmupSnapshots ?? 4);
      const status = !authorityOperational ? "后台循环恢复中" : !evidence?.fresh ? plan?.state === "PREPARED" ? "计划冻结 · 行情延迟" : "行情短暂延迟" : position?.status === "OPEN" ? "持仓中" : !evidence.ancillaryFresh ? "关键结构刷新中" : evidence.entryReady === false ? `恢复确认 ${evidence.recoveryFreshCount ?? 0}/2` : plan?.state === "PREPARED" ? "等待进场" : intent ? "发现机会" : reclaimedEdge ? "扫盘已收回 · 双向观察" : acceptedBreak ? `父区间${acceptedBreak}突破 · 分支观察` : evidence?.warmup < warmupTarget ? `预热 ${evidence?.warmup ?? 0}/${warmupTarget}` : "继续观察";
      return <article className="market" key={symbol}><div className="market-title"><div><small>{symbol.replace("_", "/")}</small><h2>{status}</h2></div><strong>{evidence?.midpoint ? num(evidence.midpoint, 5) : "—"}</strong></div>
        <div className="plain-answer"><small>系统判断</small><b>{intent ? `${sideText(intent.side)} · ${eventIntent ? "资金异动跟随" : intent.routeKind === "INTERNAL_ROTATION" ? "区间内部迁移" : intent.routeKind === "BREAKOUT_RETEST" ? "突破回踩延续" : intent.routeKind === "FAILED_BREAKOUT_REVERSAL" ? "强假突破反转" : intent.routeKind === "EDGE_REJECTION" ? "扫流动性后震荡回归" : stateText[intent.marketState]}` : reclaimedEdge ? "扫盘收回后双分支观察" : acceptedBreak ? `15分钟父区间已${acceptedBreak}突破` : "暂时没有值得执行的方向"}</b><p>{waitReason(runtime, marketFresh, symbol)}</p></div>
        {plan?.state === "CANCELLED" && plan.cancelReason && <p className="notice">最近计划撤销：{cancelText[plan.cancelReason] ?? plan.cancelReason}{plan.cancelledAt ? ` · ${time(plan.cancelledAt)}` : ""}</p>}
        {evidence?.optionalFresh === false && <p className="notice">OI、主动成交或清算数据部分延迟；关键盘口与周期结构仍独立工作，该项只降低确认度，不会强制撤销计划。</p>}
        {!!routes.length && <section className="route-map"><div className="route-map-head"><div><small>分段流动性路线</small><b>多个方案观察，单一方案执行</b></div><span>软计划不占保证金</span></div><div className="route-list">{routes.map((route) => <article className={route.executableNow ? "active" : ""} key={route.id}><div><span>{stageText[route.stage]}</span><b>{sideText(route.side)} · {routeText[route.kind]}</b></div><p>{num(route.entryTrigger, 5)} → {num(route.target, 5)} <small>{route.targetTimeframe} 流动性 · 确认 {num(route.confirmationScore * 100, 0)}% · 假突破风险 {num(route.fakeoutRisk * 100, 0)}%</small></p><em>{route.executableNow ? "可进入执行仲裁" : route.stage === "NODE_TO_NEXT" ? "到节点后重判" : route.blockReason ?? "继续观察确认"}</em></article>)}</div></section>}
        {position?.status === "OPEN" ? <div className="trade-levels"><div><small>实际进场</small><b>{num(position.entryPrice, 5)}</b></div><div><small>原始结构止损</small><b>{num(position.initialStop, 5)}</b></div><div><small>当前保护位</small><b>{num(position.currentStop, 5)}</b></div><div><small>当前目标</small><b>{num(position.currentTarget, 5)}</b></div></div> : intent && <div className="trade-levels"><div><small>准备进场</small><b>{num(intent.entryTrigger, 5)}</b></div><div><small>判断错误就退出</small><b>{num(intent.invalidation, 5)}</b></div><div><small>当前目标</small><b>{num(intent.target, 5)}</b></div><div><small>第一目标扣成本盈亏比</small><b>{num(netRr(intent.entryTrigger, intent.invalidation, intent.target), 2)} : 1</b></div></div>}
        <div className="execution"><small>执行方式</small><b>{!marketFresh && plan?.state === "PREPARED" ? `原计划与边界保持不变；当前禁止成交，连续2份新盘口恢复后再核对，仍有效至 ${time(plan.expiresAt)}` : position?.status === "OPEN" ? waitReason(runtime, marketFresh, symbol) : plan?.state === "PREPARED" ? eventIntent ? `资金异动已确认；按当前实时价IOC进场，盘口逆向或超过允许滑点立即放弃` : plan.marketState === "BREAKOUT" ? `内部实时确认 ${num(plan.entryTrigger, 5)}；强突破连续 ${(plan.breakoutSignalCount ?? 0)}/4，确认后IOC，0.5R外不追` : `价格到达 ${num(plan.entryTrigger, 5)} 后连续实时确认 ${(plan.realtimeSignalCount ?? 0)}/3；确认后IOC，不预挂交易所` : intent ? "方向已形成，等待系统建立实时进场计划" : reclaimedEdge ? "反弹和再次下破同时观察；只有实时证据确认的分支才IOC进场" : "继续等待完整机会"}</b></div>
        <details><summary>查看判断依据</summary><p>{intent?.reason.join("；") || "尚未形成完整判断"}</p><div className="targets"><span>上方吸引区：{num(evidence?.topLong?.price, 5)} · {sourceText[evidence?.topLong?.source ?? ""] ?? "识别中"}</span><span>下方吸引区：{num(evidence?.topShort?.price, 5)} · {sourceText[evidence?.topShort?.source ?? ""] ?? "识别中"}</span></div></details>
      </article>;
    }) ?? <div className="empty">正在读取市场数据…</div>}</section>

    <section className="panel-list" hidden={tab !== "orders"}>{!openPositions.length && !preparedPlans.length && !recentClosedPositions.length && <div className="empty"><b>当前没有模拟订单</b><p>出现合适位置后会先显示准备计划；真实订单请进入底部「实盘」。</p></div>}
      {!!openPositions.length && <h2 className="order-group-title">当前持仓 <span>{openPositions.length}</span></h2>}
      {openPositions.map(({ symbol, position }) => { const evidence = runtime?.evidence[symbol]; return <OrderCard key={symbol} symbol={symbol} side={position.side} label="持仓中" state={position.scenario} notional={position.notional} equity={runtime?.equity ?? INITIAL_EQUITY} note={waitReason(runtime, true, symbol)} positionView={{ entryAt: position.entryAt, entryPrice: position.entryPrice, stopPrice: position.currentStop, targetPrice: position.currentTarget, markPrice: evidence?.midpoint, markAt: evidence?.observedAt, fresh: Boolean(evidence?.fresh) }} values={[["进场", position.entryPrice], ["原始止损", position.initialStop], ["当前保护位", position.currentStop], ["动态目标", position.currentTarget], ["计划风险", position.plannedRisk]]} />; })}
      {!!preparedPlans.length && <h2 className="order-group-title">等待进场 <span>{preparedPlans.length}</span></h2>}
      {preparedPlans.map(({ symbol, plan }) => { const eventPlan = plan.targetIdentity?.startsWith("EVENT_TARGET:"); return <OrderCard key={symbol} symbol={symbol} side={plan.side} label={runtime?.evidence[symbol]?.entryReady === false ? "计划冻结" : eventPlan ? "资金异动实时进场" : "等待实时确认"} state={plan.marketState} notional={plan.notional} equity={runtime?.equity ?? INITIAL_EQUITY} leverage={plan.leverage} margin={plan.margin} note={runtime?.evidence[symbol]?.entryReady === false ? `行情短暂延迟时不成交、不移动原边界；计划保留至 ${time(plan.expiresAt)}，连续2份新盘口后重新核对。` : eventPlan ? `两轮全市场扫描与实时资金流已确认；当前价IOC，盘口逆向或滑点超限即放弃。有效至 ${time(plan.expiresAt)}。` : (plan.invalidationSignalCount ?? 0) > 0 ? `软失效观察 ${plan.invalidationSignalCount}/2，计划仍锁定；连续确认后才撤销。有效至 ${time(plan.expiresAt)}。` : plan.marketState === "BREAKOUT" ? `${plan.routeKind === "INTERNAL_ROTATION" ? "子区间迁移" : plan.routeKind === "BREAKOUT_RETEST" ? "回踩再加速" : "父区间突破"}实时确认 ${(plan.breakoutSignalCount ?? 0)}/4；确认后IOC，0.5R外不追。有效至 ${time(plan.expiresAt)}。` : `价格到达观察位后实时确认 ${(plan.realtimeSignalCount ?? 0)}/3；确认后IOC，不向Gate预挂接刀单。有效至 ${time(plan.expiresAt)}。`} values={[[eventPlan ? "实时进场参考" : plan.marketState === "BREAKOUT" ? (plan.routeKind === "BREAKOUT_RETEST" ? "回踩再加速位" : plan.routeKind === "INTERNAL_ROTATION" ? "子区间观察位" : "父区间观察位") : plan.routeKind === "FAILED_BREAKOUT_REVERSAL" ? "反抽观察位" : plan.routeKind === "EDGE_REJECTION" ? "收回后观察位" : "实时观察位", plan.entryTrigger], ["结构与噪声止损", plan.invalidation], ["短线目标", plan.target], ["计划风险", plan.plannedRisk]]} />; })}
      {!!recentClosedPositions.length && <h2 className="order-group-title">刚刚结束 <span>{recentClosedPositions.length}</span></h2>}
      {recentClosedPositions.map(({ symbol, position }) => <OrderCard key={`recent:${position.entryAt ?? symbol}`} symbol={symbol} side={position.side} label="刚刚结束" state={position.scenario} notional={position.notional} equity={runtime?.equity ?? INITIAL_EQUITY} note={resolvedExitText(position.exitReason, position.initialStop, position.currentStop)} values={[["进场", position.entryPrice], ["出场", position.exitPrice ?? position.entryPrice], ["已实现盈亏", position.realizedPnl ?? 0], ["计划风险", position.plannedRisk]]} />)}
    </section>

    <div hidden={tab !== "live"}><LiveCenter auth={auth} runtime={runtime} live={live} liveEnabled={liveEnabled} liveBusy={liveBusy} liveActionError={liveActionError} positions={openLivePositions} entries={openLiveEntries} skips={liveEntrySkips} onLogin={() => setShowLogin(true)} onToggle={liveControl} onCleanup={() => void setLiveMode(false)} /></div>

    <section className="history-panel" hidden={tab !== "history"}>
      <div className="history-subnav">{([['trades', '交易记录'], ['account_logs', `账户日志 ${accountLogs.length || ''}`]] as const).map(([key, label]) => <button type="button" key={key} className={historyView === key ? "active" : ""} onClick={() => setHistoryView(key)}>{label}</button>)}</div>
      {historyView === "trades" && <><div className="section-heading"><div><h2>全部模拟交易</h2><p>进入复盘页才读取完整记录；之后只刷新最新一页，不请求额外行情图。</p></div><span>{history.filter((item) => item.status === "CLOSED").length} 笔已结束</span></div>
        {!history.length ? <div className="empty"><b>还没有历史交易</b><p>产生第一笔模拟交易后会自动出现在这里。</p></div> : <div className="history-table">{history.map((item) => <HistoryOrder key={item.id} item={item} />)}</div>}</>}
      {historyView === "account_logs" && <AccountLogs cycle={runtime?.paperCycle ?? null} items={accountLogs} />}
    </section>

    <section className="settings-panel" hidden={tab !== "settings"}>
      <button className="setting-row" type="button" onClick={() => auth.authenticated ? void fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(() => { setAuth({ ...auth, authenticated: false }); setRuntime(runtime ? { ...runtime, live: undefined } : runtime); }) : setShowLogin(true)}><div><b>所有者账户</b><p>{auth.authenticated ? "安全登录有效30天；每次打开页面自动续期。" : "登录后才可以查看真实账户并操作实盘开关。"}</p></div><span className={`setting-value ${auth.authenticated ? "online" : "locked"}`}>{auth.authenticated ? "owner · 退出 ›" : "登录 ›"}</span></button>
      <button className="setting-row" type="button" disabled={liveBusy} onClick={liveControl}><div><b>实盘交易开关</b><p>{liveEnabled ? "关闭后停止新进场；已有仓位继续保护并按策略退出。" : "开启后，实盘完全复用全市场资金异动策略、IOC进场和10%组合风险硬上限。"}</p></div><span className={`setting-value ${liveEnabled && live?.operational ? "online" : "locked"}`}>{liveBusy ? "处理中…" : !auth.authenticated ? "需登录 ›" : liveEnabled ? live?.operational ? "已开启 ›" : "已开启·待恢复 ›" : "已关闭 ›"}</span></button>
      {auth.authenticated && <><Setting title="Gate 实盘账户" detail={`可用 ${num(live?.available, 2)} U · ${openLivePositions.length} 个真实持仓`} value={live?.equity != null ? `${num(live.equity, 2)} U` : "连接中"} tone={live?.credentialConfigured ? "online" : "locked"}/><Setting title="实盘执行状态" detail={friendlyLiveError(live?.lastError) || "全市场每10秒扫描资金异动；候选进入2秒实时资金流确认后按当前价IOC。"} value={live?.operational ? "可开仓" : liveEnabled ? "暂停新单" : "已关闭"} tone={live?.operational ? "online" : "locked"}/></>}
      <Setting title="最大组合风险" detail="10%是硬上限；全部高相关同向持仓风险另限6.5%，均含手续费和压力滑点。" value="10%"/>
      <Setting title="每日交易目标" detail="1000 U 本金以每日净盈利 150 U 为进取目标；不限制订单数量，也不会为了凑目标放宽信号。暂不设置每日亏损停机线。" value="+150 U"/>
      <Setting title="保证金与杠杆" detail="动态杠杆目标每个执行计划约占 10% 保证金；挂单与持仓合计不超过权益 30%，并保留强平缓冲。" value="动态"/>
      <Setting title="持仓时间与止盈" detail="不固定时间，不固定止盈；到达流动性节点后重新判断下一段。" value="分段"/>
      <Setting title="数据容错" detail={`累计短时失败 ${totalFeedFailures} 次 · 自动恢复 ${totalFeedRecoveries} 次 · 最大观测延迟 ${num(maxFeedLag / 1_000, 2)} 秒`} value={activeFeedSuspensions ? `${activeFeedSuspensions}币冻结` : "正常"} tone={activeFeedSuspensions ? "locked" : "online"}/>
      <Setting title="数据覆盖" detail={`约每10秒扫描 ${runtime?.radar?.scanned ?? runtime?.limits.scannedMarkets ?? 0} 个可交易合约；只让最强3个候选进入2秒盘口与分批结构/资金流确认。全市场不是逐笔全量订阅。`} value="分层实时" tone="online"/>
      <Setting title="页面数据" detail="交易后台独立按2秒循环运行；手机页面每15秒读取一次摘要。复盘仅在打开时读取，且已取消全部历史行情图请求。" value="轻量" tone="online"/>
      <Setting title="系统状态" detail="交易健康只由后台权威、行情新鲜度和各币恢复状态决定；历史镜像延迟不再误报故障。" value={healthy ? "正常" : "恢复中"} tone={healthy ? "online" : "locked"}/>
      <button className="setting-row" type="button" disabled={paperBusy} onClick={() => openPaperAction("RESET")}><div><b>重置模拟账户</b><p>以新一轮 1,000 U 开始；模拟持仓按新鲜价格结束，保留历史，绝不操作 Gate 实盘。</p></div><span className="setting-value danger">重置 ›</span></button>
      <button className="setting-row" type="button" disabled={paperBusy} onClick={() => openPaperAction("CLEAR_HISTORY")}><div><b>清除模拟历史</b><p>删除已结束交易和账户日志；保留当前权益、模拟持仓和实盘数据。</p></div><span className="setting-value danger">清除 ›</span></button>
      <p className="last-update">最近后台成功：{time(runtime?.lastSuccessAt)}{live?.lastSyncAt ? ` · 实盘核对：${time(live.lastSyncAt)}` : ""}</p>
    </section>

    {showLogin && <LoginModal configured={auth.configured} onClose={() => setShowLogin(false)} onSuccess={(session) => { setAuth(session); setShowLogin(false); location.reload(); }} />}
    {showLiveConfirm && <div className="modal-backdrop" onClick={() => !liveBusy && setShowLiveConfirm(false)}><section className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><span className="lock-icon">实</span><h2>确认开启实盘</h2><p>开启后，系统每10秒扫描 Gate 全部合格 USDT 永续合约，把最强候选升级到2秒实时确认；只有资金流同向时才提交当前价 IOC，成交后立即建立硬止损。</p><p>实盘账户总风险硬上限为10%，同方向相关风险不超过6.5%；只有你登录后可以改变这个开关。</p>{liveActionError && <p className="form-error">{liveActionError}</p>}<div className="modal-actions"><button className="secondary" type="button" disabled={liveBusy} onClick={() => setShowLiveConfirm(false)}>取消</button><button type="button" disabled={liveBusy} onClick={() => void setLiveMode(true)}>{liveBusy ? "正在核对 Gate…" : "确认开启实盘"}</button></div></section></div>}
    {paperAction && <div className="modal-backdrop" onClick={() => !paperBusy && setPaperAction(null)}><section className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><span className="lock-icon">模</span><h2>{paperAction === "RESET" ? "确认重置模拟账户" : "确认清除模拟历史"}</h2><p>{paperAction === "RESET" ? "模拟权益将重置为 1,000 U 并开始新一轮；当前模拟持仓只会在行情新鲜时按当前价结束，历史记录会保留。" : "已结束的模拟交易和账户日志将永久删除；当前模拟权益、持仓以及全部 Gate 实盘数据不会改变。"}</p><p>这项操作只影响 PAPER 模拟系统，不会下单、平仓或修改实盘开关。</p>{paperActionError && <p className="form-error">{paperActionError}</p>}<div className="modal-actions"><button className="secondary" type="button" disabled={paperBusy} onClick={() => setPaperAction(null)}>取消</button><button className="danger-action" type="button" disabled={paperBusy} onClick={() => void runPaperAction()}>{paperBusy ? "处理中…" : paperAction === "RESET" ? "确认重置" : "确认清除"}</button></div></section></div>}
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
    {view === "orders" && <section className="panel-list live-orders">{!positions.length && !entries.length && !skips.length && <div className="empty"><b>当前没有实盘订单</b><p>所有路线都在后台观察，只有实时证据确认后才提交IOC，不预挂接刀单。</p></div>}{skips.map((skip) => <article className="live-skip-card" key={`live-skip:${skip.symbol}:${skip.planId}`}><div><small>{skip.symbol.replace("_", "/")}</small><h3>本轮未成交</h3></div><p>{skip.reason}</p><span>实盘仍在运行；出现账户可承受的新计划时会继续实时确认。</span></article>)}{positions.map((position) => { const evidence = runtime?.evidence[position.symbol]; const protection = position.stopPrice ?? position.currentStop; return <OrderCard key={`live:${position.symbol}`} symbol={position.symbol} side={position.side} label="实盘持仓" state={position.scenario} notional={position.notional} equity={live?.equity ?? INITIAL_EQUITY} mode="LIVE" leverage={position.leverage} margin={position.margin} positionView={{ entryAt: position.entryAt, entryPrice: position.entryPrice, stopPrice: protection, targetPrice: position.currentTarget, markPrice: evidence?.midpoint, markAt: evidence?.observedAt, fresh: Boolean(evidence?.fresh) }} values={[["真实进场", position.entryPrice], ["原始止损", position.initialStop], ["交易所保护位", protection], ["动态目标", position.currentTarget], ["实际计划风险", position.plannedRisk]]} />; })}{entries.map((entry) => <OrderCard key={`live:${entry.symbol}:entry`} symbol={entry.symbol} side={entry.side} label={entry.status === "ERROR" ? "异常待核对" : "实时确认IOC"} state={entry.scenario} notional={entry.notional} equity={live?.equity ?? INITIAL_EQUITY} mode="LIVE" leverage={entry.leverage} margin={entry.margin} note={friendlyLiveError(entry.lastError) ?? undefined} values={[["确认进场参考", entry.trigger], ["结构止损", entry.invalidation], ["动态目标", entry.target], ["实际计划风险", entry.plannedRisk]]} />)}</section>}
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

function HistoryOrder({ item }: { item: HistoryItem }) {
  const cost = item.feesAndSlippage ?? 0;
  const gross = (item.realizedPnl ?? 0) + cost;
  const realizedR = item.status === "CLOSED" && item.plannedRisk > 0 ? (item.realizedPnl ?? 0) / item.plannedRisk : null;
  return <article className="history-order"><div><span className={`side ${item.side.toLowerCase()}`}>{item.side === "LONG" ? "多" : "空"}</span><div><b>{item.symbol.replace("_", "/")}</b><small>{time(item.entryAt)} · {stateText[item.marketState]}</small></div></div><div><small>进场 / 出场</small><b>{num(item.entryPrice, 5)} / {num(item.exitPrice, 5)}</b></div><div><small>净结果</small><b className={(item.realizedPnl ?? 0) >= 0 ? "positive" : "negative"}>{item.status === "OPEN" ? "持仓中" : `${signed(item.realizedPnl ?? 0)} U`}</b></div><div><small>持仓 / 结束原因</small><b>{durationText(item.entryAt, item.exitAt)} · {item.status === "OPEN" ? "尚未结束" : resolvedExitText(item.exitReason, item.initialStop, item.currentStop)}</b></div>
    <details className="history-diagnostic"><summary>查看订单数据</summary><div><span>毛盈亏<b className={gross >= 0 ? "positive" : "negative"}>{item.status === "OPEN" ? "—" : `${signed(gross)} U`}</b></span><span>交易成本<b className="negative">{item.status === "OPEN" ? "—" : `-${num(cost, 2)} U`}</b></span><span>实际 R 倍数<b>{realizedR == null ? "—" : num(realizedR, 2)}</b></span><span>原始止损 / 目标<b>{num(item.initialStop, 5)} / {num(item.currentTarget, 5)}</b></span></div></details>
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
        <details className="bankruptcy-details bankruptcy-orders"><summary>查看本轮完整订单记录（{report.trades.length} 笔）</summary><div className="bankruptcy-order-head"><span>订单</span><span>进场 / 出场</span><span>持仓</span><span>毛利 / 成本 / 净利</span><span>结束原因</span></div>{report.trades.map((trade) => <div className="bankruptcy-order-row" key={trade.id}><span><b>{trade.symbol.replace("_", "/")}</b><small>{trade.side === "LONG" ? "B 多" : "S 空"} · {time(trade.entryAt)}</small></span><span>{num(trade.entryPrice, 5)}<small>{num(trade.exitPrice, 5)}</small></span><span>{durationText(trade.entryAt, trade.exitAt)}<small>目标进度 {num(trade.targetProgress * 100, 0)}%</small></span><span><b className={trade.netPnl >= 0 ? "positive" : "negative"}>{signed(trade.grossPnl)} / -{num(trade.costs, 2)} / {signed(trade.netPnl)} U</b><small>计划 {num(trade.plannedNetRewardRisk, 2)}R</small></span><span>{resolvedExitText(trade.exitReason, trade.initialStop, trade.initialStop)}</span></div>)}</details>
      </article>;
    })}
  </div>;
}

function Breakdown({ title, rows }: { title: string; rows: Record<string, BreakdownRow> }) {
  return <div className="breakdown"><b>{title}</b>{Object.entries(rows).map(([name, row]) => <span key={name}>{stateText[name] ?? (name === "LONG" ? "做多" : name === "SHORT" ? "做空" : name.replace("_", "/"))}<small>{row.trades} 笔 · {row.wins} 胜 · <i className={row.netPnl >= 0 ? "positive" : "negative"}>{signed(row.netPnl)} U</i></small></span>)}</div>;
}

function Setting({ title, detail, value, tone = "" }: { title: string; detail: string; value: string; tone?: string }) {
  return <div className="setting-row"><div><b>{title}</b><p>{detail}</p></div><span className={`setting-value ${tone}`}>{value}</span></div>;
}
