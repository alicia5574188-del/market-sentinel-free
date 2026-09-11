"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { directionalReturnRate, marginReturnRate, unrealizedPnl } from "../lib/position-metrics.ts";
import { runtimeBackendOperational, runtimeNotice, runtimeStatusLabel } from "../lib/runtime-health.ts";

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
type StrategyFamily = "FAST" | "TREND" | "RANGE" | "REVERSAL" | "POLAR";
type StrategyLane = "SHADOW" | "ACTIVE" | "SLEEPING";
type TradeLane = "EFFECTIVE_SHADOW" | "PORTFOLIO";
type StrategyOrientation = "NORMAL" | "REVERSE";
type CandidateChannel = "TREND" | "RANGE" | "COMPRESSION" | "ANOMALY";
type RegimeKind = "TREND" | "RANGE" | "COMPRESSION" | "EXPANSION" | "UNCERTAIN";
type AllRegimeEnvironment = "TREND" | "RANGE" | "COMPRESSION" | "EXHAUSTION";
type AllRegimeRoute = { version: number; strategyId: string; strategyName: string; environment: AllRegimeEnvironment;
  side: Side; score: number; triggerPrice: number; invalidationPrice: number; profitArmPrice: number;
  maxHoldMinutes: number; noProgressMinutes: number; structureId: string; reason: string };
type AdaptiveMechanism = "RANGE_ROTATION" | "COMPRESSION_EXPANSION" | "FAILED_AUCTION"
  | "PULLBACK_RECOVERY" | "MOMENTUM_CONTINUATION" | "BREAKOUT_ACCEPTANCE";
type AdaptiveRecommendation = { mechanism: AdaptiveMechanism; side: Side; horizonMinutes: number; samples: number;
  wins: number; netExpectationRate: number; conservativeNetReturnRate: number; profitFactor: number;
  targetReachRate: number; opportunityRatePerDay: number; objectiveScore: number; stopRate: number; targetRate: number;
  approved: boolean; reason: string };
type AdaptivePolicy = { version: number; generatedAt: number; candleCount: number; objectiveDailyReturnRate: number;
  currentState: number[]; recommendations: AdaptiveRecommendation[] };
type EntryStyle = "CONFIRM" | "RETEST";
type ExitProfile = "FAST" | "STRUCTURE";
type ArenaTradeContext = { channel: CandidateChannel; regime: RegimeKind; anomalyKind: RadarCandidate["kind"] | null;
  entryStyle: EntryStyle; exitProfile: ExitProfile; candidateScore: number; trendRate: number; trendEfficiency: number;
  volatilityRatio: number; rangePosition: number; openInterestChangeRate: number; volume24hUsd: number; fundingRate: number;
  alignedFlow: number; confirmation: number;
  fakeoutRisk: number; rangeId: string | null; modeledCostRate: number; spreadRate: number; bidDepthUsd: number; askDepthUsd: number;
  structureSource: "ROUTE" | "RANGE" | "CANDLE_5M" | "IMPULSE"; grossRewardRate: number; structuralStopRate: number;
  netRewardRisk: number; costShare: number; empiricalExpectedReturnRate: number; empiricalProfitFactor: number; empiricalEvents: number;
  entryTrigger?: number; feeSlippageRate?: number; fundingCostRate?: number; maxHoldMs?: number; noProgressMs?: number;
  originalTargetPrice?: number; targetAdapted?: boolean; targetEvidenceEvents?: number;
  adaptivePolicyVersion?: number; adaptiveMechanism?: string; adaptiveApproved?: boolean; adaptiveReason?: string;
  adaptiveHorizonMinutes?: number; adaptiveSamples?: number; adaptiveExpectationRate?: number;
  adaptiveConservativeRate?: number; adaptiveObjectiveScore?: number; adaptiveTargetReachRate?: number;
  extremeSequenceVersion?: number; extremeSequenceBranch?: "FISSION" | "SNAPBACK";
  allRegimeVersion?: number; allRegimeEnvironment?: "TREND" | "RANGE" | "COMPRESSION" | "EXHAUSTION";
  polarityAtEntry?: StrategyOrientation; polarityEvidence?: number[]; profitArmIsNotExit?: boolean };
type ArenaTrade = { id: string; strategyId: string; strategyName: string; family: StrategyFamily; lane: TradeLane; eventId: string;
  symbol: string; side: Side; status: "OPEN" | "CLOSED"; openedAt: number; closedAt: number | null; entryPrice: number;
  stopPrice: number; targetPrice: number; exitPrice: number | null;
  outcome: "TARGET" | "RUNNER_EXIT" | "STOP" | "TIMEOUT" | "THESIS_INVALID" | "EDGE_DECAY" | "RESET" | null;
  grossReturnRate: number | null; netReturnRate: number | null; netPnl: number | null; notional: number;
  maxFavorableRate: number; maxAdverseRate: number; lastPrice: number; selectedForPortfolio: boolean; reason: string;
  context: ArenaTradeContext; admissionTier: "NORMAL" | null; plannedRisk: number; contracts: number;
  quantoMultiplier: number; leverage: number; margin: number; accountEquityAtOpen: number; attributedStrategyIds?: string[];
  orientation?: StrategyOrientation; activeStopPrice?: number; profitArmedAt?: number | null };
type StrategyScore = { id: string; name: string; family: StrategyFamily; channel: CandidateChannel; description: string;
  entryStyle: EntryStyle; exitProfile: ExitProfile; lane: StrategyLane; enabled: boolean;
  shadowResolved: number; shadowWins: number; shadowNetReturnRate: number; paperResolved: number; paperWins: number;
  paperNetReturnRate: number; paperEquity: number; consecutivePaperLosses: number; stageResults: number[];
  stageEvents: string[]; stageSymbols: string[];
  transitions: number; lastTransitionAt: number | null; lastTransitionReason: string;
  recentResults?: Array<{ netReturnRate: number; resolvedAt: number }>; paperResults?: Array<{ netReturnRate: number; resolvedAt: number }>;
  reverseEnabled?: boolean; reverseRecentResults?: Array<{ netReturnRate: number; resolvedAt: number }>;
  reverseQualificationResults?: Array<{ netReturnRate: number; resolvedAt: number }>;
  reversePaperResults?: Array<{ netReturnRate: number; resolvedAt: number }>; reverseShadowResolved?: number;
  reverseShadowWins?: number; reverseLastTransitionReason?: string };
type StrategyTransition = { id: string; strategyId: string; strategyName: string; from: StrategyLane; to: StrategyLane; at: number; reason: string };
type PerformanceEvidence = { events: number; wins: number; netReturnRate: number; meanReturnRate: number;
  conservativeReturnRate: number; profitFactor: number; regimeEvents: number };
type PlaybookEvidence = { id: string; name: string; family: StrategyFamily; channel: CandidateChannel; description: string; evidence: PerformanceEvidence };
type PortfolioCycleArchive = { number: number; ruleVersion: string; startedAt: number; endedAt: number; startingEquity: number;
  endingEquity: number; resolved: number; wins: number; grossPnl: number; costs: number; reason: string };
type RouteCheck = { id: string; eventId: string; strategyId: string; strategyName: string; symbol: string; observedAt: number;
  status: "FORMING" | "CHECKING" | "BLOCKED" | "OPEN"; blocker: string | null; side: Side | null;
  environment: AllRegimeEnvironment | null; score: number; reason: string | null };
type StrategyArena = { version: 11; startedAt: number; catalogSize: number; playbookCount: number; shadowCount: number;
  reverseActiveCount?: number;
  activeCount: number; sleepingCount: number; trialCount: number; verifiedCount: number; paperCount: number; openShadow: ArenaTrade[]; openPaper: ArenaTrade[];
  portfolioOpen: ArenaTrade[]; portfolioEquity: number; portfolioResolved: number; portfolioWins: number;
  portfolioGrossPnl: number; portfolioCosts: number; strategies: StrategyScore[]; recentShadow: ArenaTrade[];
  recentPaper: ArenaTrade[]; recentPortfolio: ArenaTrade[]; archivedPortfolioTrades: ArenaTrade[]; transitions: StrategyTransition[]; playbooks: PlaybookEvidence[];
  portfolioCycle: number; portfolioCycleStartedAt: number; archivedPortfolioCycles: PortfolioCycleArchive[];
  admissionRejects: Record<string, number>; observationShadow: Array<{ id: string; strategyName: string; symbol: string; observedAt: number; blocker: string }>;
  currentRouteChecks: RouteCheck[];
  offlineValidation: Record<string, { branchName: string; trainEvents: number; trainProfitFactor: number;
    validationEvents: number; validationProfitFactor: number; validationWinRate: number; paperApproved: boolean }>;
  rules: { frictionFloorRate: number; minNetRewardRisk: number;
    maxCostShare: number; singleTradeRiskMin: number; singleTradeRiskMax: number; portfolioRiskCap: number;
    correlatedRiskCap: number; marginCap: number; maxNotionalMultiple: number; realtimeCapacity: number;
    minimumPortfolioRiskUsdt: number; empiricalCostFloorRate: number; reverseTriggerWindow?: number; reverseLossStreak?: number;
    reverseMaxBreakEvenRate?: number; authorityWindowPriority?: "LATEST_SIX_THEN_THREE" | "STATE_CONDITIONED_EXPECTANCY" | "CURRENT_STATE_WALK_FORWARD" | "EXTREME_STREAK_POLARITY"; paperEvaluation?: boolean;
    mutuallyExclusiveOrientation?: boolean; exactShadowClone?: boolean; normalShadowAlwaysOn?: boolean;
    reverseShadowAlwaysOn?: boolean; fastTargetNetRewardRisk?: number; structureTargetNetRewardRisk?: number;
    independentDirections?: boolean; generatedRouteAuthority?: boolean; legacyStrategyAuthority?: boolean;
    paperCycleResetOnCutover?: boolean; adaptivePolicyVersion?: number; adaptiveMinimumAnalogSamples?: number;
    extremeSequenceAuthority?: boolean; strategyName?: string; extremeSequenceVersion?: number; streakLength?: number;
    streakMaxSpanMs?: number; sameBranchSymbolCooldownMs?: number; maxPortfolioPositions?: number; profitArmIsExit?: boolean;
    dailyObjectiveRate?: number; dailyObjectiveIsQuota?: boolean; reverseSameEventWinsRequired?: number } };
type RegimeCandidate = { id: string; symbol: string; channel: CandidateChannel; regime: RegimeKind; side: Side; score: number;
  referencePrice: number; moveRate: number; trendRate: number; trendEfficiency: number; volatilityRatio: number;
  rangePosition: number; volume24hUsd: number; openInterestChangeRate: number; confirmations: number; firstSeenAt: number;
  observedAt: number; anomalyKind: RadarCandidate["kind"] | null; adaptivePolicy?: AdaptivePolicy | null;
  extremeSequence?: { version: number; branch: "FISSION" | "SNAPBACK"; baseSide: Side; score: number;
    triggerPrice: number; invalidationPrice: number; profitArmPrice: number; maxHoldMinutes: number;
    noProgressMinutes: number; structureId: string; reason: string } | null;
  dominantEnvironment?: AllRegimeEnvironment | null;
  allRegimeRoutes?: AllRegimeRoute[] };
type MarketRegimes = { version: 2; lastUpdatedAt: number | null; tracked: number; warmed: number;
  counts: Record<RegimeKind, number>; candidates: RegimeCandidate[] };
type Runtime = {
  version: string; mode: "PAPER"; state: string; stale: boolean; generatedAt: number; lastSuccessAt: number | null;
  lastHeartbeatAt?: number | null; lastAlarmAt?: number | null; nextAlarmAt?: number | null;
  lastError: string | null; symbols: string[]; equity: number; dailyStartEquity?: number;
  decisions: Record<string, Decision | null>; routes: Record<string, LiquidityRoute[]>; plans: Record<string, Plan | null>; positions: Record<string, Position | null>; authorityReady: boolean;
  evidence: Record<string, { midpoint: number; bestBid?: number; bestAsk?: number; observedAt: number; warmup: number; fresh: boolean; ancillaryFresh: boolean; entryReady?: boolean; optionalFresh?: boolean; recoveryFreshCount?: number; suspensionReason?: string | null; topLong: Zone | null; topShort: Zone | null; absorption: number; range15m: RangeStructure | null }>;
  entryAssessments?: Record<string, EntryAssessment | null>;
  feedFailures?: Record<string, { count: number; retryAt: number; suspendedSince?: number | null; totalFailures?: number; recoveries?: number; lastFailureAt?: number | null; lastError?: string | null; maxObservedLagMs?: number }>;
  feedQuality?: { windowStartedAt: number; attempts: number; failures: number; recoveries: number;
    lastFailureAt: number | null; lastFailureSymbol: string | null; lastError: string | null };
  limits: { maxOpenPositions: number | null; realtimeCapacity?: number; scanUniverse?: number; warmupSnapshots?: number; loopMs?: number; radarMs?: number; scannedMarkets?: number; maxAncillaryConcurrency?: number };
  liveMode: { requestedEnabled: boolean; operational: boolean };
  radar?: { scanned: number; lastScanAt: number | null; lastAttemptAt?: number | null; consecutiveFailures?: number;
    retryAt?: number | null; lastError?: string | null; candidates: RadarCandidate[] };
  marketRegimes?: MarketRegimes;
  strategyArena?: StrategyArena;
  strategyData?: { liquidMarkets: number; stableMarkets: number; adaptivePolicyMarkets?: number; approvedPolicyRoutes?: number;
    extremeSequenceMarkets?: number; routedMarkets?: number; polarityReady?: boolean;
    marketBreadth?: number; marketMedianMove?: number; marketContextMarkets?: number;
    degradedMarkets?: number; blockingMarkets?: number;
    lastCompletedCandleAt: number; lastRuntimeLogAt: number;
    candleError: string | null; logError: string | null };
  live?: LiveRuntime;
};
type AuthSession = { configured: boolean; authenticated: boolean; username: string };
type CredentialStatus = { configured: boolean; environment: string | null; keyHint: string | null; gateUserId: string | null; status: string; lastVerifiedAt: number | null; lastError: string | null; updatedAt: number | null };
type CredentialVerification = { equity: number; available: number; positions: number; orders: number; conditionalOrders: number; checkedAt: number };
type Tab = "brain" | "orders" | "live" | "history" | "settings";
type LiveView = "account" | "orders" | "api";
type PositionView = { entryAt?: number; entryPrice: number; stopPrice: number; targetPrice: number; markPrice?: number; markAt?: number; fresh: boolean };

const INITIAL_EQUITY = 1_000;
const RUNTIME_REQUEST_TIMEOUT_MS = 12_000;
const RUNTIME_REFRESH_MS = 10_000;
const RUNTIME_RETRY_MS = 3_000;
const stateText: Record<string, string> = { BREAKOUT: "突破", REVERSAL: "反转", RANGE: "震荡" };
const num = (value: number | null | undefined, digits = 3) => Number.isFinite(value) ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "—";
const signed = (value: number | null | undefined, digits = 2) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${num(value, digits === 2 && Math.abs(value) > 0 && Math.abs(value) < .01 ? 4 : digits)}`;
};
const time = (value: number | null | undefined) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
const environmentLabel = (kind: "TREND" | "RANGE" | "COMPRESSION" | "EXHAUSTION" | undefined) => (Object.assign({} as Record<string, string>, {
  TREND: "方向延续", RANGE: "平衡震荡", COMPRESSION: "波动压缩", EXHAUSTION: "方向衰竭",
}))[kind ?? ""] ?? "等待完整环境";
const environmentOwner: Record<AllRegimeEnvironment, string> = {
  TREND: "势承", RANGE: "衡返", COMPRESSION: "压跃", EXHAUSTION: "竭转",
};
const runtimeDurationText = (milliseconds: number | null | undefined) => {
  if (milliseconds == null || milliseconds < 0 || !Number.isFinite(milliseconds)) return "—";
  const minutes = Math.floor(milliseconds / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor(minutes % 1_440 / 60);
  const rest = minutes % 60;
  return days ? `${days}天${hours}小时` : hours ? `${hours}小时${rest}分` : `${Math.max(0, rest)}分钟`;
};
const ageText = (timestamp: number | null | undefined, now: number) => {
  if (!timestamp || !now) return "—";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}秒前`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}分钟前`;
  return `${Math.floor(seconds / 3_600)}小时前`;
};
const waitText = (milliseconds: number) => milliseconds < 60_000
  ? `约${Math.max(10, Math.ceil(milliseconds / 10_000) * 10)}秒`
  : `约${Math.ceil(milliseconds / 60_000)}分钟`;
const candidateEnvironment = (candidate: RegimeCandidate): AllRegimeEnvironment => candidate.dominantEnvironment
  ?? candidate.allRegimeRoutes?.[0]?.environment
  ?? (candidate.channel === "ANOMALY" ? "EXHAUSTION" : candidate.channel);
const displayLeverage = (notional: number, equity: number) => [1, 2, 3, 5, 10, 20, 30, 40, 50].find((value) => notional / value <= equity * .12) ?? 50;
const friendlyLiveError = (value: string | null | undefined) => !value ? null
  : value.includes("AUTO_INVALID_PARAM_TRIGGER_EXPIRATION")
    ? "Gate 拒绝了旧版触发单的有效期格式；系统已修复并会重新核对。"
    : value;

export default function Home() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [clock, setClock] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("brain");
  const [auth, setAuth] = useState<AuthSession>({ configured: true, authenticated: false, username: "owner" });
  const [showLogin, setShowLogin] = useState(false);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveActionError, setLiveActionError] = useState<string | null>(null);
  const [paperResetBusy, setPaperResetBusy] = useState(false);
  const [paperResetNotice, setPaperResetNotice] = useState<string | null>(null);
  const [paperResetError, setPaperResetError] = useState<string | null>(null);
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
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      if (!active || document.hidden || inFlight) return true;
      setClock(Date.now()); inFlight = true; controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), RUNTIME_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch("/api/runtime", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const value = await response.json() as Runtime;
        if (active) { setRuntime(value); setError(null); }
        return true;
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : "读取失败");
        return false;
      }
      finally { clearTimeout(timeout); inFlight = false; controller = null; }
    };
    const cycle = async () => {
      const succeeded = await read();
      if (active && !document.hidden) timer = setTimeout(cycle, succeeded ? RUNTIME_REFRESH_MS : RUNTIME_RETRY_MS);
    };
    const resume = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (document.hidden) { controller?.abort(); return; }
      if (!inFlight) void cycle();
    };
    void cycle();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      active = false; controller?.abort(); if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("pageshow", resume);
    };
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
  const showLiveCenter = auth.authenticated || liveEnabled;
  const activeTab: Tab = tab === "live" && !showLiveCenter ? "settings" : tab;
  const openLivePositions = Object.values(live?.positions ?? {}).filter((position): position is LivePosition => position?.status === "OPEN");
  const openLiveEntries = Object.values(live?.entries ?? {}).filter((entry): entry is LiveEntry => Boolean(entry && !["FILLED", "CANCELLED"].includes(entry.status)));
  const liveEntrySkips = Object.values(live?.entrySkips ?? {}).filter((skip): skip is LiveEntrySkip => Boolean(skip));
  const liveControl = () => {
    if (!auth.authenticated) setShowLogin(true);
    else if (liveEnabled) void setLiveMode(false);
    else if (window.confirm("确认开启实盘？开启后只复制此刻以后由1000 U模拟账户新开的订单，不会追单复制当前已有模拟持仓。")) void setLiveMode(true);
  };
  const resetPaperAccount = async () => {
    if (!auth.authenticated) { setShowLogin(true); return; }
    if (liveEnabled) { setPaperResetError("请先关闭实盘复制，再重置模拟资金。"); return; }
    if (!window.confirm("确认结束当前1000 U模拟账户周期并重置为1000 U？当前模拟持仓会按最新可成交价格结算，策略研究样本会保留。")) return;
    setPaperResetBusy(true); setPaperResetNotice(null); setPaperResetError(null);
    try {
      const response = await fetch("/api/paper/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "RESET_PAPER" }) });
      const payload = await response.json() as { error?: string; strategyArena?: StrategyArena };
      if (!response.ok || !payload.strategyArena) throw new Error(payload.error || "重置失败");
      setRuntime((current) => current ? { ...current, strategyArena: payload.strategyArena } : current);
      setPaperResetNotice("当前账户已归档并重置为1000 U；影子策略样本已保留，实盘仍关闭。");
    } catch (failure) { setPaperResetError(failure instanceof Error ? failure.message : "重置失败"); }
    finally { setPaperResetBusy(false); }
  };

  const backendOperational = runtimeBackendOperational(runtime);
  const healthLabel = runtimeStatusLabel(runtime, true, runtime == null && Boolean(error));
  const healthNotice = runtimeNotice(runtime);
  const arena = runtime?.strategyArena;
  const portfolioOpen = arena?.portfolioOpen ?? [];
  const currentPortfolioHistory = [...(arena?.recentPortfolio ?? [])]
    .sort((left, right) => (right.closedAt ?? right.openedAt) - (left.closedAt ?? left.openedAt));
  const archivedPortfolioHistory = [...(arena?.archivedPortfolioTrades ?? [])]
    .sort((left, right) => (right.closedAt ?? right.openedAt) - (left.closedAt ?? left.openedAt));
  const portfolioFloating = portfolioOpen.reduce((sum, trade) => {
    const market = runtime?.evidence[trade.symbol];
    const mark = (trade.side === "LONG" ? market?.bestBid : market?.bestAsk) ?? trade.lastPrice;
    const direction = trade.side === "LONG" ? 1 : -1;
    const fundingCostRate = Math.max(0, direction * trade.context.fundingRate)
      * Math.max(0, clock - trade.openedAt) / (8 * 60 * 60_000);
    return sum + trade.notional * (direction * (mark - trade.entryPrice) / Math.max(trade.entryPrice, 1e-9)
      - trade.context.modeledCostRate - fundingCostRate);
  }, 0);
  const hasRuntimeSnapshot = Boolean(runtime && arena);
  const portfolioAccountEquity = arena ? arena.portfolioEquity + portfolioFloating : null;
  const portfolioPnl = portfolioAccountEquity == null ? null : portfolioAccountEquity - INITIAL_EQUITY;
  const regimes = runtime?.marketRegimes;
  const routeChecks = (arena?.currentRouteChecks ?? []).filter((row) => clock - row.observedAt <= 11 * 60_000);
  const routeCheckRank = (status: RouteCheck["status"]) => status === "OPEN" ? 4 : status === "CHECKING" ? 3 : status === "BLOCKED" ? 2 : 1;
  const routeCheckFor = (candidate: RegimeCandidate) => routeChecks.filter((row) => row.eventId === candidate.id || row.symbol === candidate.symbol)
    .sort((left, right) => routeCheckRank(right.status) - routeCheckRank(left.status) || right.observedAt - left.observedAt)[0];
  const currentRoutes = routeChecks.filter((row) => row.status === "OPEN" || row.status === "CHECKING")
    .sort((left, right) => right.score - left.score || right.observedAt - left.observedAt);
  const leadRoute = currentRoutes[0];
  const analysisCandidates = [...(regimes?.candidates ?? [])].sort((left, right) => {
    const leftActive = routeCheckFor(left)?.side ? 1 : 0;
    const rightActive = routeCheckFor(right)?.side ? 1 : 0;
    return rightActive - leftActive || right.score - left.score || right.observedAt - left.observedAt;
  }).slice(0, 6);
  const leadCandidate = analysisCandidates[0];
  const leadEnvironment = leadRoute?.environment ?? (leadCandidate ? candidateEnvironment(leadCandidate) : undefined);
  const leadOwner = leadRoute?.strategyName ?? (leadEnvironment ? environmentOwner[leadEnvironment] : null);
  const now = clock || runtime?.generatedAt || 0;
  const stableMarkets = runtime?.strategyData?.stableMarkets ?? 0;
  const latestCandleAt = runtime?.strategyData?.lastCompletedCandleAt ?? 0;
  const nextFiveMinuteAt = (Math.floor(now / 300_000) + 1) * 300_000;
  const degradedPathMarkets = runtime?.strategyData?.degradedMarkets ?? 0;
  const blockingPathMarkets = runtime?.strategyData?.blockingMarkets ?? 0;
  const radarBlocking = Boolean(runtime?.radar?.consecutiveFailures && stableMarkets < 12);
  const latestFeedFailure = runtime?.feedQuality?.lastError;
  const currentIssues = [
    !backendOperational ? runtime?.lastError ?? latestFeedFailure ?? "行情权威未达到可交易状态" : null,
    radarBlocking ? `全市场扫描未达到最低覆盖：${runtime?.radar?.lastError ?? "等待重试"}` : null,
    blockingPathMarkets ? `有 ${blockingPathMarkets} 个市场的保留路径也已过期：${runtime?.strategyData?.candleError ?? "等待恢复"}` : null,
    error ? `当前页面连接重试中：${error}` : null,
  ].filter((value): value is string => Boolean(value));
  const totalFeedFailures = Object.values(runtime?.feedFailures ?? {}).reduce((sum, fault) => sum + (fault.totalFailures ?? 0), 0);
  const totalRecoveries = Object.values(runtime?.feedFailures ?? {}).reduce((sum, fault) => sum + (fault.recoveries ?? 0), 0);
  const feedAttempts = runtime?.feedQuality?.attempts ?? 0;
  const feedFailuresInWindow = runtime?.feedQuality?.failures ?? 0;
  const feedSuccessRate = feedAttempts ? (feedAttempts - feedFailuresInWindow) / feedAttempts * 100 : null;
  const activePipelineStep = stableMarkets < 12 || !latestCandleAt ? 2
    : portfolioOpen.length ? 5 : currentRoutes.length ? 4 : 3;
  const pipeline = [
    { title: "接收行情", detail: `最近成功 ${ageText(runtime?.lastSuccessAt, now)}` },
    { title: "更新路径", detail: `${stableMarkets}/${runtime?.strategyData?.liquidMarkets ?? 30} 币完成5分钟路径` },
    { title: "匹配环境", detail: `${analysisCandidates.length} 个重点候选正在解释` },
    { title: "执行检查", detail: `${currentRoutes.length} 条路线由后台确认通过或正在核对` },
    { title: "持仓管理", detail: `${portfolioOpen.length} 笔持仓实时保护` },
  ];
  const nextAction = !backendOperational
    ? currentRoutes.length ? `已保留 ${currentRoutes.length} 条路线；新鲜盘口恢复后从第4步重新核对，符合原进场区才成交`
      : `5分钟路径与环境候选未清空；新鲜盘口恢复后从第${activePipelineStep}步继续`
    : activePipelineStep === 2 ? "补齐连续5分钟数据并建立全市场背景"
      : activePipelineStep === 3 ? "下一根5分钟K线完成后重算环境与策略"
        : activePipelineStep === 4 ? "每2秒核对盘口、成本、合约数量与仓位后决定是否成交"
          : "每2秒检查止损、盈利臂和移动保护";
  const nextEta = !backendOperational ? "自动重试（约每2秒）"
    : activePipelineStep >= 4 ? "实时循环（约每2秒）" : waitText(Math.max(0, nextFiveMinuteAt - now));
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(clock || runtime?.generatedAt || 0);
  const todayRealized = currentPortfolioHistory.filter((trade) => trade.closedAt
    && new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(trade.closedAt) === todayKey)
    .reduce((sum, trade) => sum + (trade.netPnl ?? 0), 0);
  const todayPnl = arena ? todayRealized + portfolioFloating : null;
  const todayStartEquity = arena ? Math.max(0.01, arena.portfolioEquity - todayRealized) : null;
  const todayPnlRate = todayPnl == null || todayStartEquity == null ? null : todayPnl / todayStartEquity * 100;
  const headline = !backendOperational ? `行情恢复中；决策保留在第${activePipelineStep}步` : portfolioOpen.length
      ? `当前持有 ${portfolioOpen.length} 笔模拟订单` : leadRoute ? `${leadRoute.strategyName}正在接管${leadRoute.symbol.replace("_", "/")}`
        : leadCandidate && leadOwner ? `${leadOwner}正在分析${leadCandidate.symbol.replace("_", "/")}，尚未形成下单路线`
          : "正在建立全市场环境，暂未形成下单路线";
  const navigationTabs: [Tab, string][] = [["brain", "决策台"], ["orders", `持仓 ${hasRuntimeSnapshot && portfolioOpen.length ? portfolioOpen.length : ""}`]];
  if (showLiveCenter) navigationTabs.push(["live", `实盘 ${openLivePositions.length + openLiveEntries.length || ""}`]);
  navigationTabs.push(["history", "记录"], ["settings", "设置"]);

  return <main>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">V11</span><div><p>全境·复利引擎</p><small>Gate USDT 永续 · 后台真值决策</small></div></div>
      <div role="status" className={`health ${backendOperational ? "" : "bad"}`}><span />{healthLabel}</div>
    </header>

    {activeTab === "brain" && !hasRuntimeSnapshot && <section className="empty snapshot-wait"><b>{error ? "正在重新连接交易后台" : "正在读取交易后台"}</b><p>收到真实运行快照后再显示账户、持仓、路线和市场数量；连接前不会用 1000 U、0 笔或 30 币占位冒充当前状态。</p></section>}

    {activeTab === "brain" && hasRuntimeSnapshot && <>
      <section className="brain-hero v6-console"><div className="hero-copy"><div className="hero-meta"><span>唯一模拟合约账户</span><span>第{num(arena?.portfolioCycle, 0)}轮</span>{liveEnabled && <span style={{ borderColor: "#3c876f", color: "var(--green)" }}>LIVE ON</span>}</div><p className="eyebrow">V11 · VERIFIED ROUTE AUTHORITY</p><h1>{headline}</h1><p className="hero-detail">账户当前执行最近三段成本后持续为正的势承·逆竭与竭转·孤返；衡返、普通追势和压缩路线保留双向影子，只有新结果确认“连胜正做”或“连败且镜像盈利反做”才获得权限。盈利启动后只抬保护，不封顶。</p></div><div className="decision-badge"><small>账户权益</small><strong>{num(portfolioAccountEquity, 2)}</strong><span>USDT</span><em className={portfolioPnl == null ? "" : portfolioPnl >= 0 ? "positive" : "negative"}>{signed(portfolioPnl)} U</em></div></section>

      <section className="summary four">
        <article><small>今日净收益</small><strong className={todayPnl == null ? "" : todayPnl >= 0 ? "positive" : "negative"}>{signed(todayPnl)} U</strong><p>{signed(todayPnlRate)}% · 已含持仓成本</p></article>
        <article><small>当前主环境</small><strong>{environmentLabel(leadEnvironment)}</strong><p>{leadRoute?.symbol.replace("_", "/") ?? leadCandidate?.symbol.replace("_", "/") ?? "等待连续路径"}</p></article>
        <article><small>接管策略</small><strong>{leadOwner ?? "等待环境"}</strong><p>{leadRoute ? `${leadRoute.side === "LONG" ? "偏多" : "偏空"} · 强度 ${num(leadRoute.score, 0)}` : "正在分析，尚未准备下单"}</p></article>
        <article><small>当前持仓</small><strong>{portfolioOpen.length}</strong><p>已完成 {arena?.portfolioResolved ?? "—"} 笔</p></article>
      </section>
      {healthNotice && <p className="notice">{healthNotice}</p>}

      <section className={`operator-runtime ${currentIssues.length ? "has-issue" : ""}`}>
        <div className="operator-runtime-head"><div><small>实时运行状态</small><h2>{backendOperational ? "数据持续推进，系统运行正常" : "系统正在恢复关键数据"}</h2><p>这张卡只反映后台真实快照，不用“等待触发”掩盖数据问题。</p></div><span>{runtime?.lastSuccessAt ? `更新于 ${ageText(runtime.lastSuccessAt, now)}` : "尚无成功快照"}</span></div>
        <div className="runtime-facts">
          <article><small>策略账户已运行</small><strong>{runtimeDurationText(arena?.startedAt ? now - arena.startedAt : null)}</strong><p>第{num(arena?.portfolioCycle, 0)}轮账户运行 {runtimeDurationText(arena?.portfolioCycleStartedAt ? now - arena.portfolioCycleStartedAt : null)}</p></article>
          <article><small>{backendOperational ? "当前步骤" : "暂停位置"}</small><strong>{activePipelineStep}/5 · {pipeline[activePipelineStep - 1].title}</strong><p>{backendOperational ? pipeline[activePipelineStep - 1].detail : currentRoutes.length ? "执行路线保留，尚未创建订单" : "没有已进入执行检查的路线被取消"}</p></article>
          <article><small>下一步准备</small><strong>{nextEta}</strong><p>{nextAction}</p></article>
          <article><small>交易阻塞</small><strong className={currentIssues.length ? "negative" : "positive"}>{currentIssues.length ? `${currentIssues.length} 项` : "当前无阻塞"}</strong><p>{currentIssues[0] ?? (feedSuccessRate == null ? "正在建立一小时数据质量窗口" : `近一小时盘口成功率 ${num(feedSuccessRate, 2)}% · ${feedFailuresInWindow}/${feedAttempts} 次短错`)}</p></article>
        </div>
        <div className="runtime-pipeline">{pipeline.map((step, index) => { const number = index + 1; const state = !backendOperational && number === 1 ? "paused" : number < activePipelineStep ? "done" : number === activePipelineStep ? "active" : "waiting"; return <article className={state} key={step.title}><i>{state === "done" ? "✓" : number}</i><div><b>{step.title}</b><small>{step.detail}</small></div><span>{state === "done" ? "已完成" : state === "paused" ? "恢复中" : state === "active" ? backendOperational ? "进行中" : "暂停点" : "待进入"}</span></article>; })}</div>
        {currentIssues.length > 1 && <div className="runtime-issues"><b>当前问题明细</b>{currentIssues.map((issue) => <p key={issue}>{issue}</p>)}</div>}
        <footer>最近心跳 {ageText(runtime?.lastHeartbeatAt, now)} · 最近30币扫描 {ageText(runtime?.radar?.lastScanAt, now)} · 可用路径 {stableMarkets}/{runtime?.strategyData?.liquidMarkets ?? 30} · 路径短错 {degradedPathMarkets}（有效快照保留） · 累计恢复 {totalRecoveries}/{totalFeedFailures} · 快照时间 {time(runtime?.generatedAt)}</footer>
      </section>
    </>}

    <nav className="tabs" style={{ gridTemplateColumns: `repeat(${navigationTabs.length}, 1fr)` }}>{navigationTabs.map(([key, label]) => <button key={key} type="button" aria-current={activeTab === key ? "page" : undefined} className={activeTab === key ? "active" : ""} onClick={() => selectTab(key)}>{label}</button>)}</nav>

    {hasRuntimeSnapshot && <section className="analysis-board" hidden={activeTab !== "brain"}>
      <div className="section-heading"><div><h2>系统此刻在分析什么</h2><p>展示当前优先市场、选择原因、策略判断和真实阻塞，不展示内部调试流水。</p></div><span>{analysisCandidates.length}/{runtime?.strategyData?.liquidMarkets ?? 30} 个重点</span></div>
      {analysisCandidates.length ? <div className="analysis-grid">{analysisCandidates.map((candidate) => {
        const check = routeCheckFor(candidate);
        const primary = candidate.allRegimeRoutes?.find((route) => route.strategyId === check?.strategyId) ?? candidate.allRegimeRoutes?.[0];
        const environment = candidateEnvironment(candidate);
        const owner = check?.strategyName ?? environmentOwner[environment];
        const validation = check?.strategyId ? arena?.offlineValidation?.[check.strategyId] : null;
        const referenceWinRate = validation?.paperApproved ? validation.validationWinRate * 100 : null;
        const state = check?.status === "OPEN" ? "账户已成交" : check?.status === "CHECKING" ? "执行检查中"
          : check?.status === "BLOCKED" ? "本轮未通过" : primary ? "结构形成中" : "环境观察中";
        const action = check?.side ? (check.side === "LONG" ? "准备做多" : "准备做空") : "暂不下单";
        const rationale = check?.blocker ? `${check.reason ?? primary?.reason ?? "后台已完成本轮检查"} 当前卡点：${check.blocker}。`
          : check?.reason ?? primary?.reason ?? `已识别${environmentLabel(environment)}，进场、失效和盈利臂尚未同时完整。`;
        return <article className={check?.status === "OPEN" || check?.status === "CHECKING" ? "actionable" : "watching"} key={candidate.id}>
          <div className="analysis-title"><div><small>{candidate.symbol.replace("_", "/")} · {environmentLabel(environment)}</small><h3>{owner}</h3></div><span>{state}</span></div>
          <p className="analysis-why">为什么分析：位于高流动性合约池，24小时成交额约 {num(candidate.volume24hUsd / 1_000_000, 0)}M U，最新完整5分钟路径进入当前优先序列。</p>
          <p className="analysis-reason">{rationale}</p>
          <dl><div><dt>准备方向</dt><dd className={check?.side ? check.side === "LONG" ? "positive" : "negative" : ""}>{action}</dd></div><div><dt>结构强度</dt><dd>{num(check?.score ?? primary?.score ?? candidate.score, 0)}/100</dd></div><div><dt>同类留出胜率</dt><dd>{referenceWinRate == null ? "观察中" : `${referenceWinRate}%`}</dd></div><div><dt>最近分析</dt><dd>{ageText(check?.observedAt ?? candidate.observedAt, now)}</dd></div></dl>
          {referenceWinRate != null && <small className="probability-note">这是留出段同类路线胜率，不是本单保证；系统依靠盈亏幅度而非高胜率获利。</small>}
        </article>;
      })}</div> : <div className="empty"><b>正在建立连续5分钟路径</b><p>当前已有 {stableMarkets} 个市场具备路径；下一次环境重算 {waitText(Math.max(0, nextFiveMinuteAt - now))}。</p></div>}
    </section>}

    {hasRuntimeSnapshot && <section className="playbook-list route-console" hidden={activeTab !== "brain"}><div className="section-heading"><div><h2>后台确认的执行路线</h2><p>这里只展示后台已通过或正在进行最终核对的路线，不由页面推算。</p></div><span>{currentRoutes.length} 条</span></div>{currentRoutes.length ? <div className="strategy-grid">{currentRoutes.slice(0, 6).map((route) => <article className="strategy-card route-approved" key={route.id}><div className="strategy-title"><div><small>{route.symbol.replace("_", "/")} · {environmentLabel(route.environment ?? undefined)}</small><h3>{route.strategyName}</h3></div><span className={route.side === "LONG" ? "positive" : "negative"}>{route.side === "LONG" ? "做多" : "做空"}</span></div><small className="strategy-rule">{route.reason}{route.blocker ? `；${route.blocker}` : ""}</small></article>)}</div> : <div className="empty"><b>目前没有后台确认的执行路线</b><p>上方逐币显示本轮形成到哪一步，以及最后一个真实阻塞原因。</p></div>}</section>}

    <section className="panel-list" hidden={activeTab !== "orders"}>
      {hasRuntimeSnapshot ? <><h2 className="order-group-title">1000 U模拟账户 <span>{num(portfolioAccountEquity, 2)} U</span></h2>
      {portfolioOpen.map((trade) => { const market = runtime?.evidence[trade.symbol]; return <ArenaOpenCard key={trade.id} trade={trade}
        mark={(trade.side === "LONG" ? market?.bestBid : market?.bestAsk) ?? trade.lastPrice} />; })}
      {!portfolioOpen.length && <div className="empty"><b>当前没有模拟订单</b><p>对应环境的策略仍在接管；完成进场结构后才会成交。</p></div>}</> : <div className="empty"><b>正在读取模拟持仓</b><p>收到后台真实快照前不显示“0笔”。</p></div>}
    </section>

    {showLiveCenter && <div hidden={activeTab !== "live"}><LiveCenter auth={auth} runtime={runtime} live={live} liveEnabled={liveEnabled} liveBusy={liveBusy} liveActionError={liveActionError} positions={openLivePositions} entries={openLiveEntries} skips={liveEntrySkips} onLogin={() => setShowLogin(true)} onToggle={liveControl} onCleanup={() => void setLiveMode(false)} /></div>}

    <section className="history-panel" hidden={activeTab !== "history"}>{hasRuntimeSnapshot ? <><div className="section-heading"><div><h2>当前模拟周期</h2><p>只统计本轮真正计入1000 U账户的订单。</p></div><span>{arena?.portfolioResolved ?? "—"} 笔</span></div>{!currentPortfolioHistory.length ? <div className="empty"><b>本轮还没有已完成订单</b><p>当前持仓结算后会出现在这里。</p></div> : <div className="history-table">{currentPortfolioHistory.map((trade) => <ArenaTradeRecord key={trade.id} trade={trade} />)}</div>}</> : <div className="empty"><b>正在读取模拟交易记录</b><p>收到后台真实快照前不显示空记录。</p></div>}</section>
    {hasRuntimeSnapshot && <section className="history-panel" hidden={activeTab !== "history"}><div className="section-heading"><div><h2>历史归档</h2><p>旧版本和已重置周期只用于对照，不计入当前权益、胜率或策略授权。</p></div><span>{arena?.archivedPortfolioCycles.length ?? "—"} 个周期</span></div>{!archivedPortfolioHistory.length ? <div className="empty"><b>暂无历史归档订单</b></div> : <div className="history-table">{archivedPortfolioHistory.map((trade) => <ArenaTradeRecord key={`archive:${trade.id}`} trade={trade} />)}</div>}</section>}

    <section className="settings-panel" hidden={activeTab !== "settings"}>
      <button className="setting-row" type="button" onClick={() => auth.authenticated ? void fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(() => { setAuth({ ...auth, authenticated: false }); setRuntime(runtime ? { ...runtime, live: undefined } : runtime); setTab("settings"); }) : setShowLogin(true)}><div><b>所有者账户</b><p>{auth.authenticated ? "安全登录有效30天；每次打开页面自动续期。实盘配置只在所有者登录后的实盘页显示。" : "登录后才会显示实盘入口；公开页面只显示模拟系统。"}</p></div><span className={`setting-value ${auth.authenticated ? "online" : "locked"}`}>{auth.authenticated ? "owner · 退出 ›" : "登录 ›"}</span></button>
      {!hasRuntimeSnapshot && <div className="empty"><b>正在读取系统设置</b><p>真实运行快照返回后再显示策略、风险和数据覆盖。</p></div>}
      {hasRuntimeSnapshot && <>
      <Setting title="策略系统" detail="四类环境持续识别；账户执行最近三段仍为正的势承·逆竭和竭转·孤返。衡返最近段转负后已降为双向影子，只按连续3次同环境结果重新选择正向或镜像方向。" value="当前证据路由" tone="online"/>
      <Setting title="市场覆盖" detail={`持续扫描 ${runtime?.strategyData?.liquidMarkets ?? runtime?.limits.scanUniverse ?? 30} 个高流动性永续合约，${runtime?.strategyData?.stableMarkets ?? 0} 个已具备完整5分钟路径；“形成结构”与“后台准入”分开统计。`} value={`${runtime?.strategyData?.stableMarkets ?? 0}/30`} tone="online"/>
      <Setting title="系统状态" detail="只显示交易后台真实状态；普通手机网络波动会静默保留最近结果并自动重连，个别币缺数据只隔离该币。" value={healthLabel} tone={backendOperational ? "online" : "locked"}/>
      <button className="setting-row" type="button" disabled={paperResetBusy || liveEnabled} onClick={() => void resetPaperAccount()}><div><b>重置1000 U模拟资金</b><p>按最新可成交价结算当前模拟持仓，归档本轮账户后从1000 U重新开始；影子策略研究样本不会删除，实盘开启时禁止操作。</p></div><span className="setting-value locked">{paperResetBusy ? "处理中…" : "重置 ›"}</span></button>
      {paperResetError && <p className="form-error">{paperResetError}</p>}{paperResetNotice && <p className="form-success">{paperResetNotice}</p>}
      <p className="last-update">最近后台成功：{time(runtime?.lastSuccessAt)}{live?.lastSyncAt ? ` · 实盘核对：${time(live.lastSyncAt)}` : ""}</p>
      </>}
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
  const activeView: LiveView = !liveEnabled && view === "orders" ? "account" : view;
  const viewScroll = useRef<Record<LiveView, number>>({ account: 0, orders: 0, api: 0 });
  const [credential, setCredential] = useState<CredentialStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [credentialNotice, setCredentialNotice] = useState<string | null>(null);
  const [verification, setVerification] = useState<CredentialVerification | null>(null);
  const selectView = (next: LiveView) => {
    if (next === activeView) return;
    viewScroll.current[activeView] = window.scrollY;
    setView(next);
  };

  useLayoutEffect(() => {
    window.scrollTo({ top: viewScroll.current[activeView], left: 0, behavior: "auto" });
  }, [activeView]);

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
  const liveViews: [LiveView, string][] = liveEnabled
    ? [["account", "实盘账户"], ["orders", `实盘订单 ${positions.length + entries.length || ""}`], ["api", "API 管理"]]
    : [["account", "开启实盘"], ["api", "API 管理"]];

  return <section className="live-center">
    <div className="live-subnav">{liveViews.map(([key, label]) => <button type="button" key={key} className={activeView === key ? "active" : ""} onClick={() => selectView(key)}>{label}</button>)}</div>
    {activeView === "account" && <>
      <section className="live-status-card"><div><small>实盘交易开关</small><h2>{liveEnabled ? "实盘复制已开启" : "实盘数据保持隐藏"}</h2><p>{readableLiveError || (liveEnabled ? "只复制开启后由1000 U模拟账户新开的订单；方向、止损、目标和出场保持一致，仓位按真实权益安全缩放。" : "当前不会向 Gate 提交新订单。只有你在这里确认开启后，真实账户和订单页面才会显示。")}</p></div><div className="live-actions"><button type="button" disabled={liveBusy || !credential?.configured || liveEnabled} className="danger-outline" onClick={onCleanup}>撤销系统遗留挂单</button><button type="button" disabled={liveBusy || !credential?.configured} className={liveEnabled ? "danger-action" : "primary-action"} onClick={onToggle}>{liveBusy ? "正在与 Gate 核对…" : liveEnabled ? "关闭实盘并撤单" : "开启实盘复制"}</button></div></section>
      {liveActionError && <p className="form-error">{liveActionError}</p>}
      {!liveEnabled && <p className="cleanup-help">如果 Gate 仍显示以前由本系统创建的挂单，点“撤销系统遗留挂单”。只撤销带本系统标签的入场单，不会撤销你的手工订单。</p>}
      {liveEnabled && <>
      <section className="summary four live-summary"><article><small>真实账户权益</small><strong>{num(live?.equity, 2)} U</strong><p>{connectionText}</p></article><article><small>可用保证金</small><strong>{num(live?.available, 2)} U</strong><p>Gate 返回的可用余额</p></article><article><small>持仓浮盈亏</small><strong className={liveFloating >= 0 ? "positive" : "negative"}>{signed(liveFloating)} U</strong><p>{positions.length} 个真实持仓</p></article><article><small>已计划风险</small><strong>{num(liveRisk, 2)} U</strong><p>保证金约 {num(occupiedMargin, 2)} U · 总上限 10%</p></article></section>
      <div className="live-facts"><Setting title="API 状态" detail={credential?.configured ? `密钥 ${credential.keyHint ?? "已加密"} · ${time(credential.lastVerifiedAt)}` : "进入 API 管理保存或更换"} value={credential?.configured ? "已验证" : "未配置"} tone={credential?.configured ? "online" : "locked"}/><Setting title="最近账户核对" detail="页面关闭后后台仍按策略运行。" value={time(live?.lastSyncAt)} tone={live?.lastSyncAt ? "online" : "locked"}/></div>
      </>}
    </>}
    {liveEnabled && activeView === "orders" && <section className="panel-list live-orders">{!positions.length && !entries.length && !skips.length && <div className="empty"><b>当前没有实盘订单</b><p>等待1000 U模拟账户产生下一笔新订单。</p></div>}{skips.map((skip) => <article className="live-skip-card" key={`live-skip:${skip.symbol}:${skip.planId}`}><div><small>{skip.symbol.replace("_", "/")}</small><h3>模拟信号未能实盘成交</h3></div><p>{skip.reason}</p><span>安全条件不满足，本次实盘跳过，不影响模拟账户继续记录。</span></article>)}{positions.map((position) => { const evidence = runtime?.evidence[position.symbol]; const protection = position.stopPrice ?? position.currentStop; return <OrderCard key={`live:${position.symbol}`} symbol={position.symbol} side={position.side} label="实盘复制持仓" state={position.scenario} notional={position.notional} equity={live?.equity ?? INITIAL_EQUITY} mode="LIVE" leverage={position.leverage} margin={position.margin} positionView={{ entryAt: position.entryAt, entryPrice: position.entryPrice, stopPrice: protection, targetPrice: position.currentTarget, markPrice: evidence?.midpoint, markAt: evidence?.observedAt, fresh: Boolean(evidence?.fresh) }} values={[["真实进场", position.entryPrice], ["模拟止损", position.initialStop], ["交易所保护位", protection], ["模拟目标", position.currentTarget], ["实际计划风险", position.plannedRisk]]} />; })}{entries.map((entry) => <OrderCard key={`live:${entry.symbol}:entry`} symbol={entry.symbol} side={entry.side} label={entry.status === "ERROR" ? "异常待核对" : "模拟订单复制中"} state={entry.scenario} notional={entry.notional} equity={live?.equity ?? INITIAL_EQUITY} mode="LIVE" leverage={entry.leverage} margin={entry.margin} note={friendlyLiveError(entry.lastError) ?? undefined} values={[["模拟进场参考", entry.trigger], ["模拟止损", entry.invalidation], ["模拟目标", entry.target], ["实际计划风险", entry.plannedRisk]]} />)}</section>}
    {activeView === "api" && <section className="credential-panel"><div className="section-heading"><div><h2>Gate 实盘 API</h2><p>新 API 验证成功后会加密覆盖旧 API，页面永远不回显 Secret。</p></div><span className={credential?.configured ? "positive" : "negative"}>{credential?.configured ? "已保存" : "未保存"}</span></div><div className="credential-current"><div><small>当前 API</small><b>{credential?.keyHint ?? "尚未配置"}</b><p>{credential?.configured ? `最后验证 ${time(credential.lastVerifiedAt)} · Gate 实盘` : "填写下方两项后保存"}</p></div>{credential?.configured && <button className="danger-outline" type="button" disabled={credentialBusy || liveEnabled || positions.length > 0 || entries.length > 0} onClick={() => void deleteCredential()}>删除 API</button>}</div><form className="credential-form" onSubmit={saveCredential}><label><span>API Key</span><input value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} placeholder="填写新的 Gate API Key" /></label><label><span>API Secret</span><input type="password" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} autoComplete="new-password" spellCheck={false} placeholder="填写新的 Gate API Secret" /></label><p className="credential-help">只使用 Gate USDT 永续合约读取与交易权限；不要开启提现权限。保存 API 不会开启实盘。API 过期时直接验证并覆盖；只有 Gate 已无持仓和挂单时才允许删除。</p>{liveEnabled && <p className="form-error">请先关闭实盘开关，才可以更换或删除 API。</p>}{credentialError && <p className="form-error">{credentialError}</p>}{credentialNotice && <p className="form-success">{credentialNotice}</p>}{verification && <p className="credential-check">已核对：权益 {num(verification.equity, 2)} U · 持仓 {verification.positions} · 普通挂单 {verification.orders} · 条件单 {verification.conditionalOrders}</p>}<button className="primary-action" type="submit" disabled={credentialBusy || liveEnabled || apiKey.trim().length < 8 || apiSecret.trim().length < 8}>{credentialBusy ? "正在验证 Gate…" : credential?.configured ? "验证并更换 API" : "验证并保存 API"}</button></form></section>}
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

function ArenaTradeRecord({ trade }: { trade: ArenaTrade }) {
  const result = (trade.netPnl ?? 0) / Math.max(trade.accountEquityAtOpen, 1e-9);
  const orientation = trade.orientation === "REVERSE" ? "反向" : "正向";
  const exitLabel = trade.outcome === "TARGET" ? "目标" : trade.outcome === "STOP" ? "止损"
    : trade.outcome === "RUNNER_EXIT" ? "移动保护退出"
    : trade.outcome === "THESIS_INVALID" ? "逻辑失效" : trade.outcome === "EDGE_DECAY" ? "优势衰减"
      : trade.outcome === "RESET" ? "账户重置" : "旧版超时/无进展";
  return <article className="history-order"><div><span className={`side ${trade.side.toLowerCase()}`}>{trade.side === "LONG" ? "多" : "空"}</span><div><b>{trade.symbol.replace("_", "/")} · {trade.strategyName}</b><small>{time(trade.openedAt)} · {environmentLabel(trade.context.allRegimeEnvironment)} · {orientation}</small></div></div><div><small>进场 / 出场</small><b>{num(trade.entryPrice, 5)} / {num(trade.exitPrice, 5)}</b></div><div><small>账户净盈亏</small><b className={result > 0 ? "positive" : "negative"}>{signed(trade.netPnl ?? 0)} U · {signed(result * 100)}%</b></div><div><small>持仓 / 结束</small><b>{durationText(trade.openedAt, trade.closedAt)} · {exitLabel}</b></div></article>;
}

function ArenaOpenCard({ trade, mark }: { trade: ArenaTrade; mark: number | undefined }) {
  const direction = trade.side === "LONG" ? 1 : -1;
  const current = mark ?? trade.lastPrice;
  const gross = current ? direction * (current - trade.entryPrice) / Math.max(trade.entryPrice, 1e-9) : 0;
  const net = gross - trade.context.modeledCostRate;
  const orientation = trade.orientation === "REVERSE" ? "反向" : "正向";
  return <article className="order-card"><div><span className={`side ${trade.side.toLowerCase()}`}>{trade.side === "LONG" ? "多" : "空"}</span><div><h3>{trade.symbol.replace("_", "/")} · {trade.strategyName}</h3><p>{environmentLabel(trade.context.allRegimeEnvironment)} · {orientation} · {trade.reason}</p></div></div><strong className={net >= 0 ? "positive" : "negative"}>{current ? `${signed(trade.notional * net)} U · ${signed(net * 100)}%` : "等待行情"}</strong><dl><div><dt>进场</dt><dd>{num(trade.entryPrice, 5)}</dd></div><div><dt>当前价</dt><dd>{num(current, 5)}</dd></div><div><dt>{trade.profitArmedAt ? "移动保护" : "结构止损"}</dt><dd>{num(trade.activeStopPrice ?? trade.stopPrice, 5)}</dd></div><div><dt>盈利启动位</dt><dd>{num(trade.targetPrice, 5)} · 不封顶</dd></div></dl></article>;
}

function Setting({ title, detail, value, tone = "" }: { title: string; detail: string; value: string; tone?: string }) {
  return <div className="setting-row"><div><b>{title}</b><p>{detail}</p></div><span className={`setting-value ${tone}`}>{value}</span></div>;
}
