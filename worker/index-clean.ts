import { LiveHistoryReader } from "../lib/live-history-reader.ts";
/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import handler from "vinext/server/app-router-entry";
import { GatePublicError, fetchActiveContracts, fetchContractStats, fetchGateRadarTickers, fetchLiquidations, fetchRecentTrades,
  fetchStructureCandles, fetchTickerBbo, fetchUrgentFuturesBook } from "../lib/gate-market.ts";
import { MarketDataHub } from "../lib/market-data-hub.ts";
import { GateStreamingFeed } from "../lib/gate-stream.ts";
import { closePaperPosition, CORRELATED_DIRECTION_RISK_CAP, PORTFOLIO_RISK_CAP, remainingStressRisk, STALE_AFTER_MS, SYSTEM_VERSION, type Decision, type LiquidityRoute, type LiquidityZone, type MarketState, type PaperPlan, type PaperPosition, type RangeStructure, type Side } from "../lib/liquidity-core.ts";
import { aggregateFourHourCandles, analyzeSnapshot, ancillarySchedule, deriveMinuteNoiseRate, deriveRangeStructure, deriveStructureZones, emptySymbolMemory, structureDirection, updateOpenInterestCohorts, type SymbolMemory } from "../lib/liquidity-runtime.ts";
import { arenaProtectionStop, arenaTradePlan, liveMirrorExitRequired } from "../lib/arena-live.ts";
import { drainPositionOutbox, enqueuePositionTransition, type PositionOutboxItem } from "../lib/paper-outbox.ts";
import { buildBankruptcyReport, diagnoseClosedPosition, paperCycleSummary, recordCycleTrade, startPaperCycle,
  PAPER_INITIAL_EQUITY, type BankruptcyReport, type PaperCycle } from "../lib/paper-cycle.ts";
import { runtimeReady, type RuntimeHealthShape } from "../lib/runtime-health.ts";
import { buildLiveEntryIntent, buildLiveStopIntent, GateEntryCancelledError, GateLiveClient, gateMarkedEquity, gatePositionValuation, gateUnknownSubmissionCanResolve, isGateReadTimeoutError, LiveEntrySizingError, liveEntryDisposition, liveExitTag, liveOrderId, liveOrderTag, loadGateLiveClient, type GateLiveOrder, type GateLiveOrderSnapshot, type GateLiveSnapshot, type LiveEntrySizingCode } from "../lib/gate-live.ts";
import { LIVE_SESSION_VERSION, establishLiveScale, reconcileLiveScale, startLiveSession, sourceAfterEnable, sameLiveSession, type LiveSession } from "../lib/live-session.ts";
import type { GateSizeRules, SizeDiagnostic } from "../lib/gate-quantity.ts";
import { encryptGateCredentials, gateKeyHint, normalizeGateCredentials, type GateCredentials } from "../lib/credential-vault.ts";
import { credentialMetadata } from "../lib/gate-readonly.ts";
import { MEMBERS_VERSION, digestMember, clearMemberCookie } from "../lib/member-auth.ts";
import { MemberDirectory, type MemberFeed } from "./member-directory.ts";
import { memberExecutionClass } from "./member-executor.ts";
import { memberRoutes } from "./member-routes.ts";
import { clearOwnerSessionCookie, createOwnerSession, ownerAuthConfigured, ownerPasswordMatches, ownerSessionCookie, sameOriginMutation, verifyOwnerSession } from "../lib/owner-auth.ts";
import { type EventEntryAssessment, type RadarCandidate } from "../lib/market-radar.ts";
import { initialMarketRegimes, marketRegimeSummary, normalizeMarketRegimes, residentCandleCandidate,
  type MarketRegimeCandidate, type MarketRegimeState, type ResidentCandleStructure } from "../lib/market-regime.ts";
import { advanceStrategyArena, initialStrategyArena, normalizeStrategyArena, observeStrategyArena,
  ARENA_FRICTION_RATE, MAX_PORTFOLIO_POSITIONS, resetStrategyArenaAccount,
  type StrategyArenaState } from "../lib/strategy-arena.ts";
import { ALL_REGIME_ENGINE_VERSION, allRegimePaperApproved } from "../lib/all-regime-engine.ts";
import { allRegimePaperApproved as previousAllRegimePaperApproved } from "../lib/previous-all-regime-engine.ts";
import { CANONICAL_PAPER_REFERENCE_EQUITY, canonicalPaperOpen, canonicalPaperSummary,
  initialCanonicalPaperState, normalizeCanonicalPaperState, reconcileCanonicalPaper,
  type CanonicalPaperState } from "../lib/dual-paper.ts";
import { evaluateRegimePortfolio, initialRegimePortfolio, normalizeRegimePortfolio,
  REGIME_EXECUTION_UNIVERSE, REGIME_HOURLY_REQUIRED_CANDLES, REGIME_PORTFOLIO_VERSION, REGIME_STRATEGIES, REGIME_SYSTEMS, REGIME_UNIVERSE, resetRegimePortfolio,
  type RegimePortfolioState } from "../lib/regime-portfolio.ts";
import type { PreviousMarketRegimeCandidate } from "../lib/previous-market-regime.ts";
import { ADAPTIVE_ENGINE_VERSION, FORWARD_EXECUTION_BBO_CAP, FORWARD_MINUTE_CONFIRMATION_CAP, advanceForward, closeForwardForReset,
  forwardSummary, forwardEquity, freshQuote, forwardUrgentMinuteSymbols, forwardUrgentQuoteSymbols, forwardWatchSymbols,
  resetForwardAccountPreservingLearning, BAR_MS, FORWARD_VERSION, type ForwardState } from "../lib/forward-relations.ts";
import { FORWARD_EXECUTION_VOLUME_FLOOR_USD, forwardExecutionUniverseEligible, selectAnchorOpportunityUniverse } from "../lib/multi-turn-universe.ts";
import { readForwardStore, prepareForwardWrite, prepareForwardProtectionWrite, prepareForwardReset,
  FORWARD_STORAGE, FORWARD_PROTECTION_STORAGE } from "../lib/forward-store.ts";
import { nextProtectionWriteBudget, readProtectionWriteBudget, protectionWriteBudgetView,
  PRIMARY_PLANNED_DO_ROWS, TWO_MEMBER_PLANNED_DO_ROWS, type ProtectionWriteBudget } from "../lib/forward-write-budget.ts";
import { EquityReader } from "../lib/equity-reader.ts";
import { EQUITY_CURVE_VERSION } from "../lib/equity-curve.ts";
import { resourceDay, rollResourceDay, RESOURCE_DAY_POLICY, type ResourceCounters } from "../lib/resource-day.ts";
import {isTransientLiveReadErrorText,liveReadTimeoutDecision} from "../lib/live-read-resilience.ts";
import { LIVE_TURNOVER_PREFIX, LIVE_TURNOVER_VERSION, initialTurnover, validateTurnover, nextFillWindow,
  prepareTurnoverPage, turnoverView, type TurnoverState, type GateConfirmedFill } from "../lib/live-turnover.ts";
import { LIVE_PARITY_VERSION, LIVE_PARITY_PREFIX, buildProportionalMirror, forwardMirrorSources, mirrorPositionRisk,
  sourceLifecycle, mirrorSourceFresh, mirrorCoverage, liveEntryDriftGuard,
  type MirrorSourceTrade, type MirrorReceipt, type MirrorBinding } from "../lib/live-parity.ts";
declare const __FORWARD_BUILD_SHA__: string;
const FORWARD_BUILD_SHA = typeof __FORWARD_BUILD_SHA__ === "string" ? __FORWARD_BUILD_SHA__ : "local-verification";
import { advanceStrategyArena as advancePreviousStrategyArena,
  initialStrategyArena as initialPreviousStrategyArena,
  normalizeStrategyArena as normalizePreviousStrategyArena,
  observeStrategyArena as observePreviousStrategyArena,
  resetStrategyArenaAccount as resetPreviousStrategyArenaAccount,
  type StrategyArenaState as PreviousStrategyArenaState } from "../lib/previous-strategy-arena.ts";

const LOOP_MS = 2_000;
const LIVE_FAST_SNAPSHOT_MAX_AGE_MS = 5_000;
const LIVE_RECONCILE_ACTIVE_MS = 5_000;
const LIVE_RECONCILE_IDLE_MS = 10_000;
const LIVE_ORDER_AUDIT_MAX_AGE_MS = 120_000;
const LIVE_ORDER_AUDIT_ADMISSION_MAX_AGE_MS = 300_000;
// Whole-system display/health tolerance only. Executable quotes remain guarded
// by the stricter per-symbol STALE_AFTER_MS/freshQuote checks; this must never
// authorize an order from an old price. A few missed 2s polls should not make
// the entire service flap into RECONNECTING.
const SYSTEM_HEALTH_STALE_AFTER_MS = 30_000;
const FEED_HARD_FAILURE_COUNT = 4;
const FEED_HARD_FAILURE_MS = 15_000;
const FEED_RECOVERY_CONFIRMATIONS = 1;
const FEED_QUALITY_WINDOW_MS = 60 * 60_000;
const BACKGROUND_BOOK_INTERVALS = 5;
const HEARTBEAT_MS = 30_000;
const UNIVERSE_MS = 10 * 60_000;
const RADAR_MS = 60_000;
const RADAR_ENTRY_STALE_MS = 150_000;
const STRATEGY_CANDLE_GRACE_MS = 8_000;
const STRATEGY_CANDLE_STALE_MS = 11 * 60_000;
const STRATEGY_LOG_MS = 5 * 60_000;
const STRATEGY_LOG_RETENTION_MS = 14 * 24 * 60 * 60_000;
const WARMUP_SNAPSHOTS = 4;
const MAX_ANCILLARY_CONCURRENCY = 2;
const SCAN_UNIVERSE_SIZE = 30;
const NON_ALARM_WRITE_CAP = 8_000;
const WATCHDOG_WRITE_RESERVE = 2_880;
const AUTHORITY_SCHEMA_VERSION = 1;
const DEFAULT_SYMBOLS = ["BTC_USDT", "ETH_USDT", "SOL_USDT"];
const adaptiveSymbolAllowed=(symbol:string)=>/^[A-Z0-9]{2,24}_USDT$/.test(symbol);
const REGIME_HOURLY_STORAGE_PREFIX = "regime-hourly:";
const REGIME_HOURLY_RETRY_MS = 10_000;
const TURN_DAILY_STORAGE_PREFIX = "multi-turn-daily:v1:";
const TURN_DAILY_REQUIRED_CANDLES = 90;

function broadMarketContext(candidates: Record<string, { symbol: string; observedAt: number; broadMoveRate?: number;
  trendRate: number; move4hRate?: number; move24hRate?: number }>, now: number) {
  const fresh = Object.values(candidates).filter((row) => now - row.observedAt <= 11 * 60_000);
  const moves = fresh
    .map((row) => row.broadMoveRate ?? row.trendRate).filter(Number.isFinite).sort((left, right) => left - right);
  const moves4h = fresh.map((row) => row.move4hRate).filter((value): value is number => Number.isFinite(value)).sort((a, b) => a - b);
  const moves24h = fresh.map((row) => row.move24hRate).filter((value): value is number => Number.isFinite(value)).sort((a, b) => a - b);
  const middle = (values: number[]) => values.length % 2 ? values[Math.floor(values.length / 2)]
    : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
  return {
    breadth: moves.length ? moves.filter((value) => value > 0).length / moves.length : 0.5,
    medianMove: moves.length ? moves[Math.floor(moves.length / 2)] : 0,
    markets: moves.length,
    breadth4h: moves4h.length ? moves4h.filter((value) => value > 0).length / moves4h.length : 0.5,
    medianMove4h: moves4h.length ? middle(moves4h) : 0,
    breadth24h: moves24h.length ? moves24h.filter((value) => value > 0).length / moves24h.length : 0.5,
    medianMove24h: moves24h.length ? middle(moves24h) : 0,
    btcMove24h: fresh.find((row) => row.symbol === "BTC_USDT")?.move24hRate ?? 0,
    regimeMarkets: Math.min(moves4h.length, moves24h.length),
  };
}

function approvedRouteScore(candidate: MarketRegimeCandidate) {
  return Math.max(-1, ...(candidate.allRegimeRoutes ?? [])
    .filter((route) => allRegimePaperApproved(route.strategyId))
    .map((route) => route.score));
}

function previousApprovedRouteScore(candidate: PreviousMarketRegimeCandidate) {
  return Math.max(-1, ...(candidate.allRegimeRoutes ?? [])
    .filter((route) => previousAllRegimePaperApproved(route.strategyId))
    .map((route) => route.score));
}

export interface CloudflareEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  MARKET_STREAM: DurableObjectNamespace<MarketStream>;
  MEMBERS?: DurableObjectNamespace<MemberDirectory>;
  MEMBER_EXECUTION?: DurableObjectNamespace;
  OWNER_ACCESS_TOKEN?: string;
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
}

type LiveEntry = {
  planId: string;
  symbol: string;
  side: Side;
  scenario: MarketState;
  kind: "PRICE_TRIGGER" | "LIMIT" | "MARKET";
  status: "SUBMITTING" | "OPEN" | "FILLED" | "CANCELLED" | "ERROR";
  tag: string;
  exchangeOrderId: string | null;
  createdAt: number;
  marketSubmittedAt?: number;
  submissionResolved?: boolean;
  expiresAt: number;
  trigger: number;
  invalidation: number;
  target: number;
  targetIdentity?: string;
  targetScore?: number;
  routeId?: string;
  routeKind?: PaperPlan["routeKind"];
  targetTimeframe?: PaperPlan["targetTimeframe"];
  rangeBoundary?: number;
  rangeBuffer?: number;
  sweepExtreme?: number;
  reclaimSource?: PaperPlan["reclaimSource"];
  reclaimStrength?: number;
  size: number;
  contracts: number;
  notional: number;
  plannedRisk: number;
  leverage: number;
  margin: number;
  stopOrderId: string | null;
  stopTag: string | null;
  stopPrice: number | null;
  stopSubmittingAt: number | null;
  protectionExitRequestedAt: number | null;
  missingSince: number | null;
  lastError: string | null;
  parity?: MirrorReceipt;
  mirrorSourceId?: string;
};

export type LivePosition = PaperPosition & Partial<ReturnType<typeof gatePositionValuation>> & {
  exchangeSize: number;
  leverage: number;
  margin: number;
  stopOrderId: string | null;
  stopTag: string | null;
  stopPrice: number | null;
  stopSubmittingAt: number | null;
  exitRequestedAt: number | null;
  exchangeUpdatedAt: number;
  parity?: MirrorReceipt;
  exitOrderId?: string | null;
  actualExitPriceVerified?: boolean;
  mirrorSourceId?: string;
};

type LiveEntrySkipCode = LiveEntrySizingCode | "LEVERAGE_REJECTED" | "ENTRY_REJECTED" | "SUBMISSION_UNCONFIRMED";
type LiveAuditEvent = {
  id: string;
  observedAt: number;
  symbol: string | null;
  planId: string | null;
  stage: "LEVERAGE" | "ENTRY_SUBMIT" | "ENTRY_FILLED" | "STOP_CREATE" | "STOP_UPDATE" | "EXIT_REQUEST" | "POSITION_CLOSED" | "LIVE_CONTROL";
  level: "INFO" | "SKIPPED" | "RECOVERING" | "FORCED_EXIT" | "LIVE_STOPPED";
  reason: string;
  gateLabel: string | null;
};

type LiveRuntime = {
  turnoverAccountKey?: string;
  recordEpochVersion?: string | null;
  recordEpochAt: number | null;
  requestedEnabled: boolean;
  operational: boolean;
  changedAt: number | null;
  activation?: LiveSession | null;
  lastSyncAt: number | null;
  lastError: string | null;
  equity: number | null;
  available: number | null;
  credentialConfigured: boolean;
  entries: Record<string, LiveEntry | null>;
  positions: Record<string, LivePosition | null>;
  entrySkips: Record<string, { planId: string; symbol: string; code: LiveEntrySkipCode; reason: string; observedAt: number; sizing?: SizeDiagnostic } | null>;
  auditEvents: LiveAuditEvent[];
};

function initialLiveState(): LiveRuntime {
  return { recordEpochVersion:null,recordEpochAt:null,requestedEnabled: false, operational: false, changedAt: null, lastSyncAt: null, lastError: null,
    equity: null, available: null, credentialConfigured: false, entries: {}, positions: {}, entrySkips: {}, auditEvents: [] };
}

function gateLabelFromError(error: unknown) {
  const match = safeError(error).match(/Gate\s+\d{3}(?:\s+([A-Z][A-Z0-9_]+))?/);
  return match?.[1] ?? null;
}

function definitiveGateRejection(error: unknown) {
  const status = Number(safeError(error).match(/Gate\s+(\d{3})/)?.[1] ?? 0);
  return status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

function liveFailureRequiresOff(error: unknown) {
  return /未纳管|与模拟账户订单不一致|方向与系统记录冲突|撤单未确认|系统挂单未撤销/.test(safeError(error));
}

type RuntimeState = {
  version: string;
  authoritySchemaVersion: number;
  mode: "PAPER";
  state: "STARTING" | "WARMING" | "LIVE" | "DEGRADED" | "RECONNECTING" | "RECOVERY_REQUIRED";
  symbols: string[];
  lastAlarmAt: number | null;
  lastSuccessAt: number | null;
  lastHeartbeatAt: number | null;
  lastStopCheckpointAt: number | null;
  nextAlarmAt: number | null;
  lastUniverseAt: number;
  lastRadarAt: number;
  lastStrategyCandleAt: number;
  lastStrategyLogAt: number;
  utcDay: string;
  resourceDayPolicy?: string;
  resourceRollovers?: ResourceCounters["resourceRollovers"];
  dailyStartEquity: number;
  alarmCount: number;
  d1Writes: number;
  nonAlarmWrites: number;
  d1RetryAt: number;
  d1FailureCount: number;
  equityVersion: number;
  ancillaryCursor: number;
  subrequestCount: number;
  maxSubrequestsInAlarm: number;
  sequenceRebuilds: number;
  lastProcessedSlot: number;
  feedFailures: Record<string, { count: number; retryAt: number; suspendedSince?: number | null; lastFreshAt?: number;
    recoveryFreshCount?: number; totalFailures?: number; recoveries?: number; lastFailureAt?: number | null;
    lastError?: string | null; maxObservedLagMs?: number }>;
  feedQuality: { windowStartedAt: number; attempts: number; failures: number; recoveries: number;
    lastFailureAt: number | null; lastFailureSymbol: string | null; lastError: string | null };
  lastError: string | null;
  d1MirrorError: string | null;
  riskBreach: boolean;
  tickSize: Record<string, number>;
  contractMeta: Record<string, { quantoMultiplier: number; maintenanceRate: number; leverageMax: number; fundingRate: number } & GateSizeRules>;
  decisions: Record<string, Decision | null>;
  routes: Record<string, LiquidityRoute[]>;
  plans: Record<string, PaperPlan | null>;
  positions: Record<string, PaperPosition | null>;
  evidence: Record<string, { midpoint: number; bestBid?: number; bestAsk?: number; observedAt: number; warmup: number; fresh: boolean; ancillaryFresh: boolean;
    entryReady?: boolean; optionalFresh?: boolean; recoveryFreshCount?: number; suspensionReason?: string | null;
    topLong: LiquidityZone | null; topShort: LiquidityZone | null; absorption: number; range15m: RangeStructure | null }>;
  entryAssessments: Record<string, EventEntryAssessment | null>;
  strategyArena: StrategyArenaState;
  previousStrategyArena: PreviousStrategyArenaState;
  regimePortfolio: RegimePortfolioState;
  canonicalPaper: CanonicalPaperState;
  marketRegimes: MarketRegimeState;
  liquidUniverse: string[];
  stableCandidates: Record<string, MarketRegimeCandidate>;
  previousStableCandidates: Record<string, PreviousMarketRegimeCandidate>;
  stableStructures: Record<string, ResidentCandleStructure>;
  previousStableStructures: Record<string, ResidentCandleStructure>;
  strategyCandleCursor: number;
  strategyCandleError: string | null;
  strategyCandleFailures: Record<string, { count: number; lastFailureAt: number; retryAt: number; lastError: string }>;
  regimeHourlyFailures: Record<string, { count: number; lastFailureAt: number; retryAt: number;
    stage: "FETCH" | "STORAGE"; lastError: string }>;
  strategyLogError: string | null;
  radar: { scanned: number; lastScanAt: number | null; lastAttemptAt: number | null; consecutiveFailures: number;
    retryAt: number | null; lastError: string | null; candidates: RadarCandidate[] };
  analysisMs: number[];
  equity: number;
  outbox: PositionOutboxItem[];
  paperCycle: PaperCycle;
  bankruptcyOutbox: Array<{ report: BankruptcyReport; equity: number; equityVersion: number }>;
  live: LiveRuntime;
};

type Checkpoint = Omit<RuntimeState, "analysisMs">;
type RegimeHourlyPath = Awaited<ReturnType<typeof fetchStructureCandles>>;

const day = resourceDay;
const safeError = (error: unknown) => error instanceof Error ? error.message.slice(0, 240) : "unknown error";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

type RadarRuntime = RuntimeState["radar"];

function emptyRadarRuntime(): RadarRuntime {
  return { scanned: 0, lastScanAt: null, lastAttemptAt: null, consecutiveFailures: 0, retryAt: null, lastError: null, candidates: [] };
}

export function radarRetryDelay() {
  return RADAR_MS;
}

export function radarCandidateExecutionAllowed(lastScanAt: number | null, now: number) {
  return lastScanAt != null && now - lastScanAt <= RADAR_ENTRY_STALE_MS;
}

export function radarAttemptDue(radar: RadarRuntime, now: number) {
  if (radar.retryAt != null && now < radar.retryAt) return false;
  return radar.lastScanAt == null || now - radar.lastScanAt >= RADAR_MS;
}

export function failedRadarRuntime(radar: RadarRuntime, failedAt: number, error: unknown): RadarRuntime {
  const consecutiveFailures = radar.consecutiveFailures + 1;
  return { ...radar, lastAttemptAt: failedAt, consecutiveFailures,
    retryAt: failedAt + radarRetryDelay(), lastError: safeError(error) };
}

export function successfulRadarRuntime(radar: RadarRuntime, now: number, scanned: number, candidates: RadarCandidate[]): RadarRuntime {
  return { ...radar, scanned, lastScanAt: now, lastAttemptAt: now, consecutiveFailures: 0, retryAt: null, lastError: null, candidates };
}

export function latestCompletedStrategyCandleAt(now: number) {
  return Math.floor(Math.max(0, now - STRATEGY_CANDLE_GRACE_MS) / 300_000) * 300_000;
}

export function mergeStrategyCandlePath(
  prior: Awaited<ReturnType<typeof fetchStructureCandles>>,
  incoming: Awaited<ReturnType<typeof fetchStructureCandles>>,
) {
  const rows = [...new Map([...prior, ...incoming].map((row) => [row.time, row])).values()]
    .sort((left, right) => left.time - right.time).slice(-1_000);
  let start = rows.length ? rows.length - 1 : 0;
  while (start > 0 && rows[start].time - rows[start - 1].time === 300) start -= 1;
  return rows.slice(start);
}

export function regimeHourlyFetchLimit(priorLength: number) {
  // Gate includes the still-forming hourly candle in the requested limit. Ask
  // for one extra row so filtering it still leaves 721 completed observations
  // for a causal 720-hour return on the very first pass.
  return priorLength >= REGIME_HOURLY_REQUIRED_CANDLES ? 4 : REGIME_HOURLY_REQUIRED_CANDLES + 1;
}

export function regimeHourlyNeedsRefresh(rows: RegimeHourlyPath | undefined, targetCompletedTime: number) {
  return (rows?.length ?? 0) < REGIME_HOURLY_REQUIRED_CANDLES
    || (rows?.at(-1)?.time ?? 0) < targetCompletedTime;
}

export function mergeRegimeHourlyPath(prior: RegimeHourlyPath, incoming: RegimeHourlyPath) {
  const rows = [...new Map([...prior, ...incoming]
    .filter((row) => row && [row.time, row.volume, row.close, row.high, row.low, row.open].every(Number.isFinite)
      && row.time >= 0 && row.close > 0 && row.high >= row.low && row.volume >= 0)
    .map((row) => [row.time, row])).values()]
    .sort((left, right) => left.time - right.time).slice(-REGIME_HOURLY_REQUIRED_CANDLES);
  let start = rows.length ? rows.length - 1 : 0;
  while (start > 0 && rows[start].time - rows[start - 1].time === 3_600) start -= 1;
  return rows.slice(start);
}

export function mergeTurnDailyPath(
  prior: Awaited<ReturnType<typeof fetchStructureCandles>>,
  incoming: Awaited<ReturnType<typeof fetchStructureCandles>>,
) {
  const rows=[...new Map([...prior,...incoming].filter(row=>row
    &&[row.time,row.volume,row.close,row.high,row.low,row.open].every(Number.isFinite)
    &&row.time>0&&row.close>0&&row.high>=row.low&&row.volume>=0).map(row=>[row.time,row])).values()]
    .sort((a,b)=>a.time-b.time).slice(-120);
  let start=rows.length?rows.length-1:0;
  while(start>0&&rows[start].time-rows[start-1].time===86_400)start-=1;
  return rows.slice(start);
}
function turnDailyStorageKey(symbol:string){return `${TURN_DAILY_STORAGE_PREFIX}${symbol}`;}

function regimeHourlyStorageKey(symbol: string) {
  return `${REGIME_HOURLY_STORAGE_PREFIX}${symbol}`;
}

function initialState(): RuntimeState {
  return {
    version: SYSTEM_VERSION, authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION, mode: "PAPER", state: "STARTING", symbols: DEFAULT_SYMBOLS,
    lastAlarmAt: null, lastSuccessAt: null, lastHeartbeatAt: null, lastStopCheckpointAt: null, nextAlarmAt: null, lastUniverseAt: 0, lastRadarAt: 0,
    lastStrategyCandleAt: 0, lastStrategyLogAt: 0,
    utcDay: day(), dailyStartEquity: PAPER_INITIAL_EQUITY, alarmCount: 0, d1Writes: 0, nonAlarmWrites: 0, d1RetryAt: 0, d1FailureCount: 0, equityVersion: 0, ancillaryCursor: 0, subrequestCount: 0, maxSubrequestsInAlarm: 0, sequenceRebuilds: 0, lastProcessedSlot: -1, feedFailures: {},
    feedQuality: { windowStartedAt: Date.now(), attempts: 0, failures: 0, recoveries: 0,
      lastFailureAt: null, lastFailureSymbol: null, lastError: null },
    lastError: null, d1MirrorError: null, riskBreach: false, tickSize: Object.fromEntries(DEFAULT_SYMBOLS.map((symbol) => [symbol, 0.0001])), contractMeta: {},
    decisions: {}, routes: {}, plans: {}, positions: {}, evidence: {}, entryAssessments: {},
    strategyArena: initialStrategyArena(), previousStrategyArena: initialPreviousStrategyArena(), regimePortfolio: initialRegimePortfolio(),
    canonicalPaper: initialCanonicalPaperState(),
    marketRegimes: initialMarketRegimes(), liquidUniverse: [], stableCandidates: {}, previousStableCandidates: {},
    stableStructures: {}, previousStableStructures: {},
    strategyCandleCursor: 0, strategyCandleError: null, strategyCandleFailures: {}, regimeHourlyFailures: {},
    strategyLogError: null, analysisMs: [], equity: PAPER_INITIAL_EQUITY, outbox: [],
    radar: emptyRadarRuntime(), paperCycle: startPaperCycle(Date.now()), bankruptcyOutbox: [], live: initialLiveState(),
  };
}

function retiredCurrentArena(value: StrategyArenaState | null | undefined) {
  const state = normalizeStrategyArena(value);
  state.open = {}; state.recentObservations = []; state.currentRouteChecks = {}; state.blockedCandidates = [];
  return state;
}

function retiredPreviousArena(value: PreviousStrategyArenaState | null | undefined) {
  const state = normalizePreviousStrategyArena(value);
  state.open = {}; state.recentObservations = []; state.currentRouteChecks = {}; state.blockedCandidates = [];
  return state;
}

async function batches<T>(tasks: Array<() => Promise<T>>, width = MAX_ANCILLARY_CONCURRENCY) {
  const output: PromiseSettledResult<T>[] = [];
  for (let index = 0; index < tasks.length; index += width) {
    output.push(...await Promise.allSettled(tasks.slice(index, index + width).map((task) => task())));
  }
  return output;
}

function percentile99(values: number[]) {
  if (!values.length) return 0;
  return [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * 0.99) - 1)];
}

function openStressRisk(runtime: RuntimeState) {
  return Object.values(runtime.positions).reduce((sum, position) => sum + (position?.status === "OPEN"
    ? remainingStressRisk(position, runtime.evidence[position.symbol]?.midpoint ?? position.entryPrice) : 0), 0);
}

function directionalStressRisk(runtime: RuntimeState, side: Side | undefined) {
  if (!side) return 0;
  return Object.values(runtime.positions).reduce((sum, position) => sum + (position?.status === "OPEN" && position.side === side
    ? remainingStressRisk(position, runtime.evidence[position.symbol]?.midpoint ?? position.entryPrice) : 0), 0);
}

function markToMarketEquity(runtime: RuntimeState) {
  const unrealized = Object.values(runtime.positions).reduce((sum, position) => {
    if (position?.status !== "OPEN") return sum;
    const evidence = runtime.evidence[position.symbol];
    if (!evidence) return sum;
    const direction = position.side === "LONG" ? 1 : -1;
    return sum + position.notional * (evidence.midpoint - position.entryPrice) / Math.max(position.entryPrice, 1e-9) * direction;
  }, 0);
  return Math.max(0.01, runtime.equity + unrealized);
}

export class MarketStream extends DurableObject<CloudflareEnv> {
  protected runtime = initialState();
  private memory: Record<string, SymbolMemory> = {};
  private structureCandles: Record<string, Partial<Record<"1m" | "15m" | "1h" | "4h", Awaited<ReturnType<typeof fetchStructureCandles>>>>> = {};
  private strategyCandles: Record<string, Awaited<ReturnType<typeof fetchStructureCandles>>> = {};
  private forwardMinuteCandles: Record<string, Awaited<ReturnType<typeof fetchStructureCandles>>> = {};
  private forwardMinuteRetryAt = new Map<string,number>();
  private gateStream = new GateStreamingFeed();
  private marketHub = new MarketDataHub();
  private forwardMinuteQuoteBars: Record<string,{minute:number;open:number;high:number;low:number;close:number;samples:number;
    firstAt:number;lastAt:number;completed:Array<{time:number;open:number;high:number;low:number;close:number;volume:number}>}> = {};
  private turnDailyCandles: Record<string, Awaited<ReturnType<typeof fetchStructureCandles>>> = {};
  private turnDailyLoaded = new Set<string>();
  private turnDailyCursor = 0;
  private turnDailyFailures = new Map<string,{retryAt:number;lastError:string}>();
  private regimeHourly: Record<string, RegimeHourlyPath> = {};
  private sessionWarmup: Record<string, number> = {};
  private contractCatalog = new Map<string, Awaited<ReturnType<typeof fetchActiveContracts>>[number]>();
  private gateRadarCache: Awaited<ReturnType<typeof fetchGateRadarTickers>> = [];
  private gateRadarAt=0;
  private forwardLearningUniverse:string[]=[];
  private authorityReady = true;
  private authorityView = { positions: {} as RuntimeState["positions"], equity: CANONICAL_PAPER_REFERENCE_EQUITY, equityVersion: 0 };
  protected liveClient: GateLiveClient | null = null;
  private optionalWork: Promise<void> | null = null;
  protected forwardState: ForwardState | null = null;
  protected forwardError: string | null = null;
  private forwardBusy = false;
  private forwardLastAttemptAt = 0;
  private forwardProtectionBudget: ProtectionWriteBudget | null = null;
  private forwardCompression: Awaited<ReturnType<typeof prepareForwardWrite>>["compression"] | null = null;
  private equityReader = new EquityReader();
  protected turnoverState: TurnoverState | null = null;
  protected turnoverError: string | null = null;
  protected turnoverAccountKey: string | null = null;
  protected turnoverAccountUser: string | null = null;
  protected turnoverWork: Promise<void> | null = null;
  protected turnoverAttemptAt = 0;
  private turnoverPersisted: {accountKey:string;at:number} | null = null;
  protected nonAlarmPendingWrites = 0;
  protected liveSyncWork: Promise<void> | null = null;
  private liveBackgroundWork: Promise<void> | null = null;
  private liveSourcePending=false;
  private liveFastSourcePending=false;
  private livePreferCachedNext=false;
  private liveSnapshotCache:GateLiveSnapshot|null=null;
  private liveOrderSnapshotCache:GateLiveOrderSnapshot|null=null;
  private liveOrderAuditAt=0;
  private liveNextReconcileAt=0;
  private liveSyncUsedCached=false;
  private liveExecution={version:"event-driven-live-v2",cycles:0,sourceWakeups:0,
    startedAt:null as number|null,finishedAt:null as number|null,lastDurationMs:null as number|null};
  private liveReadTimeoutStreak=0;
  protected liveJournal = new Map<string, unknown>();
  protected liveHistory: LivePosition[] = [];
  private historyReader=new LiveHistoryReader<LivePosition>();
  private liveRecordEpochDirty=false;
  private liveRecordEpochAt(){const at=this.runtime.live.recordEpochAt;return typeof at==="number"&&Number.isFinite(at)&&at>0?at:0;}
  private liveRecordVisible(position:LivePosition){return position.status==="OPEN"||(position.exitAt??0)>=this.liveRecordEpochAt();}
  private alignLiveRecordEpoch(now=Date.now()){
    const version=this.forwardState?.executionVersion??ADAPTIVE_ENGINE_VERSION;
    if(this.runtime.live.recordEpochVersion===version)return false;
    this.runtime.live.recordEpochVersion=version;
    if(!(this.runtime.live.recordEpochAt&&this.runtime.live.recordEpochAt>0))
      this.runtime.live.recordEpochAt=this.forwardState?.startedAt??now;
    // Strategy revisions never erase LIVE history or entry audit records.
    return false;
  }

  private clearRetiredLiveTransportError(){
    const retired=(value:string|null|undefined)=>typeof value==="string"
      &&value.includes("Invalid redirect value")&&value.includes("redirect");
    if(retired(this.runtime.live.lastError))this.runtime.live.lastError=null;
    for(const entry of Object.values(this.runtime.live.entries)){
      if(entry&&retired(entry.lastError))entry.lastError=null;
    }
  }
  private async ensureLiveRecordEpoch(now=Date.now()){
    this.alignLiveRecordEpoch(now);
    if(!this.liveRecordEpochDirty)return false;
    await this.saveCheckpoint(now,true);this.liveRecordEpochDirty=false;return true;
  }
  protected liveSettlementCurrent() {
    return [...this.liveHistory,...Object.values(this.runtime.live.positions).filter((p):p is LivePosition=>p?.status==="CLOSED")]
      .filter(position=>(position.exitAt??0)>=this.liveRecordEpochAt());
  }
  protected liveSettlementNeedsRefresh(now=Date.now()) {
    const current=this.liveSettlementCurrent();
    // Background reconciliation is bounded to fresh closes. Older exceptional
    // records remain available to the explicit history reader without keeping
    // an otherwise-idle member executor awake forever.
    return this.runtime.live.credentialConfigured
      &&current.some(p=>p.status==="CLOSED"&&p.exitAt!=null&&now-p.exitAt<=30*60_000)
      &&this.historyReader.needsRefresh(current,this.liveRecordEpochAt());
  }
  protected async privateLiveHistory() {
    if(!this.liveClient&&this.runtime.live.credentialConfigured)await this.gateLive().catch(()=>undefined);
    const client=this.liveClient,current=this.liveSettlementCurrent();
    const sinceAt=this.liveRecordEpochAt();
    this.historyReader.launch({storage:this.ctx.storage,client,current,now:Date.now(),sinceAt,
      valid:()=>this.liveClient===client,
      reserve:()=>this.runtime.nonAlarmWrites+(this.nonAlarmPendingWrites??0)+256<NON_ALARM_WRITE_CAP,
      persist:async entries=>{
        const reservation=this.reserveNonAlarmWrites(Object.keys(entries).length,256);
        if(!reservation)throw new Error("No optional write reserve");
        try {await this.ctx.storage.transaction(async tx=>{await tx.put(entries);});reservation.finish(true);}
        finally {reservation.finish(false);}
      },waitUntil:p=>this.ctx.waitUntil(p)});
    return this.historyReader.view(current,sinceAt);
  }
  protected launchLiveSettlementBackground() {
    if(!this.liveSettlementNeedsRefresh())return;
    this.ctx.waitUntil(this.privateLiveHistory().then(()=>undefined).catch(()=>undefined));
  }
  protected liveBindingError: string | null = null;
  protected mirrorClosures = new Map<string,ForwardState["history"][number]>();

  constructor(ctx: DurableObjectState, env: CloudflareEnv, executionOnly = false) {
    super(ctx, env);
    // A separate member namespace reuses the verified executor, never the market loop.
    if (executionOnly) return;
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Checkpoint>("checkpoint");
      if (saved?.authoritySchemaVersion === AUTHORITY_SCHEMA_VERSION) {
        const strategyCutover = saved.version !== SYSTEM_VERSION
          && saved.version !== "adaptive-target-countertrend-v4.4";
        this.runtime = { ...initialState(), ...saved, version: SYSTEM_VERSION, symbols: saved.symbols?.length ? saved.symbols : [...DEFAULT_SYMBOLS],
          lastUniverseAt: 0, lastRadarAt: 0,
          radar: { ...emptyRadarRuntime(), ...(saved.radar ?? {}), candidates: saved.radar?.candidates ?? [] },
          strategyArena: retiredCurrentArena(saved.strategyArena),
          previousStrategyArena: retiredPreviousArena(saved.previousStrategyArena),
          regimePortfolio: normalizeRegimePortfolio(saved.regimePortfolio),
          canonicalPaper: strategyCutover ? initialCanonicalPaperState(Date.now())
            : normalizeCanonicalPaperState(saved.canonicalPaper, Date.now()),
          previousStableCandidates: saved.previousStableCandidates ?? {},
          previousStableStructures: saved.previousStableStructures ?? {},
          marketRegimes: strategyCutover ? initialMarketRegimes() : normalizeMarketRegimes(saved.marketRegimes),
          equity: strategyCutover ? PAPER_INITIAL_EQUITY : saved.equity,
          dailyStartEquity: strategyCutover ? PAPER_INITIAL_EQUITY : saved.dailyStartEquity,
          equityVersion: strategyCutover ? saved.equityVersion + 1 : saved.equityVersion,
          decisions: strategyCutover ? {} : saved.decisions,
          routes: strategyCutover ? {} : saved.routes,
          plans: strategyCutover ? {} : saved.plans,
          positions: strategyCutover ? {} : saved.positions,
          outbox: strategyCutover ? [] : saved.outbox ?? [],
          paperCycle: strategyCutover ? startPaperCycle(Date.now()) : saved.paperCycle ?? startPaperCycle(Date.now(), saved.equity, 1),
          bankruptcyOutbox: strategyCutover ? [] : saved.bankruptcyOutbox ?? [],
          live: { ...initialLiveState(), ...(saved.live ?? {}), entries: saved.live?.entries ?? {},
            positions: saved.live?.positions ?? {}, entrySkips: saved.live?.entrySkips ?? {},
            auditEvents: saved.live?.auditEvents ?? [], requestedEnabled: Boolean(saved.live?.requestedEnabled),
            operational: false }, analysisMs: [], state: "WARMING" };
        const canonical = reconcileCanonicalPaper({ state: this.runtime.canonicalPaper,
          accounts: { current: this.runtime.strategyArena, previous: this.runtime.previousStrategyArena,
            regime: this.runtime.regimePortfolio }, now: Date.now() });
        this.runtime.canonicalPaper = canonical.state;
        this.runtime.equity = canonical.state.equity;
        delete (this.runtime as unknown as Record<string, unknown>).rejectionAudit;
        delete (this.runtime as unknown as Record<string, unknown>).reactionLab;
        delete (this.runtime as unknown as Record<string, unknown>).outcomeResearch;
        for (const symbol of new Set([...Object.keys(this.runtime.decisions), ...Object.keys(this.runtime.routes), ...Object.keys(this.runtime.plans),
          ...Object.keys(this.runtime.positions), ...Object.keys(this.runtime.evidence), ...Object.keys(this.runtime.entryAssessments), ...Object.keys(this.runtime.feedFailures),
          ...Object.keys(this.runtime.tickSize), ...Object.keys(this.runtime.contractMeta)])) {
          if (this.runtime.symbols.includes(symbol)) continue;
          delete this.runtime.decisions[symbol]; delete this.runtime.routes[symbol]; delete this.runtime.plans[symbol]; delete this.runtime.positions[symbol];
          delete this.runtime.evidence[symbol]; delete this.runtime.entryAssessments[symbol]; delete this.runtime.feedFailures[symbol]; delete this.runtime.tickSize[symbol];
          delete this.runtime.contractMeta[symbol];
        }
        for (const symbol of this.runtime.symbols) {
          this.memory[symbol] = emptySymbolMemory();
          this.memory[symbol].quantoMultiplier = this.runtime.contractMeta[symbol]?.quantoMultiplier ?? 1;
          this.memory[symbol].maintenanceRate = this.runtime.contractMeta[symbol]?.maintenanceRate ?? 0.005;
          this.memory[symbol].flow.funding = this.runtime.contractMeta[symbol]?.fundingRate ?? 0;
          this.sessionWarmup[symbol] = 0;
          if (this.runtime.plans[symbol]?.state === "PREPARED") this.runtime.plans[symbol] = { ...this.runtime.plans[symbol]!, state: "CANCELLED", cancelReason: "PROCESS_RESTART_CANCEL", cancelledAt: Date.now() };
        }
      } else if (saved) {
        this.authorityReady = false;
        this.runtime.state = "RECOVERY_REQUIRED";
        this.runtime.lastError = "authority checkpoint version mismatch; manual migration required";
      }
      if (this.authorityReady) {
        try{
          const cachedCatalog=await ctx.storage.get<Awaited<ReturnType<typeof fetchActiveContracts>>>("gate-contract-catalog:v1");
          if(cachedCatalog?.length){this.contractCatalog=new Map(cachedCatalog.map(row=>[row.symbol,row]));
            this.forwardLearningUniverse=cachedCatalog.filter(row=>adaptiveSymbolAllowed(row.symbol)&&row.volume24hUsd>=FORWARD_EXECUTION_VOLUME_FLOOR_USD).map(row=>row.symbol);}
        }catch{/* cached Gate universe is optional; live refresh will retry */}
        const loaded = await Promise.all(REGIME_EXECUTION_UNIVERSE.map(async (symbol) => {
          try {
            return [symbol, await ctx.storage.get<RegimeHourlyPath>(regimeHourlyStorageKey(symbol))] as const;
          } catch (error) {
            const prior = this.runtime.regimeHourlyFailures[symbol];
            this.runtime.regimeHourlyFailures[symbol] = { count: (prior?.count ?? 0) + 1,
              lastFailureAt: Date.now(), retryAt: Date.now() + REGIME_HOURLY_RETRY_MS,
              stage: "STORAGE", lastError: `读取720小时路径失败：${safeError(error)}` };
            return [symbol, undefined] as const;
          }
        }));
        for (const [symbol, rows] of loaded) {
          const path = mergeRegimeHourlyPath([], rows ?? []);
          if (path.length) this.regimeHourly[symbol] = path;
        }
        this.runtime.regimePortfolio.warmMarkets = REGIME_UNIVERSE
          .filter((symbol) => (this.regimeHourly[symbol]?.length ?? 0) >= REGIME_HOURLY_REQUIRED_CANDLES).length;
      }
      this.resetDailyCounters(Date.now());
      try {
        this.forwardState = await readForwardStore(ctx.storage, Date.now());
        const overlay=await ctx.storage.get<{writeBudget?:unknown}>(FORWARD_PROTECTION_STORAGE);
        this.forwardProtectionBudget=readProtectionWriteBudget(overlay?.writeBudget);
      }
      catch (error) { this.forwardError = safeError(error); }
      // Owner intent has its own durable record. Background checkpoints and
      // deployments cannot replace a later OFF with an earlier in-flight ON.
      const intent=await ctx.storage.get<{enabled:boolean;changedAt:number;activation?:LiveSession|null}>(`${LIVE_PARITY_PREFIX}owner-intent`);
      if(intent){this.runtime.live.requestedEnabled=intent.enabled;this.runtime.live.changedAt=intent.changedAt;
        this.runtime.live.activation=intent.activation??null;}
      if(this.runtime.live.requestedEnabled&&!this.runtime.live.activation){
        // One-time rule migration: protect already-bound real positions, but do
        // not catch up any as-yet-unsubmitted position present at deployment.
        const activation=startLiveSession(Date.now(),this.forwardState,true);
        const reservation=this.reserveNonAlarmWrites(1);
        if(!reservation)throw new Error("实盘会话迁移写入预算不足");
        try {await ctx.storage.put(`${LIVE_PARITY_PREFIX}owner-intent`,{enabled:true,changedAt:this.runtime.live.changedAt,activation});reservation.finish(true);}
        finally {reservation.finish(false);}
        this.runtime.live.activation=activation;
      }
      if(this.runtime.live.activation&&this.runtime.live.activation.version!==LIVE_SESSION_VERSION)
        this.liveBindingError="实盘开启会话版本不兼容，停止新增复制，不改写所有者开关";
      // Retire the old Cloudflare redirect-option exception from durable UI
      // state after the transport code has been upgraded to redirect:"manual".
      this.clearRetiredLiveTransportError();
      // A major strategy execution-version change starts a fresh LIVE record
      // epoch. Gate history and immutable parity bindings remain untouched, but
      // the operator-facing record/archive cycle starts from this strategy epoch.
      this.alignLiveRecordEpoch(Date.now());
      // Populate size metadata with the existing universe job immediately;
      // do not wait ten minutes or add per-symbol/private network requests.
      if(Object.values(this.runtime.contractMeta).some(m=>typeof m.enableDecimal!=="boolean"||!m.orderSizeMin))this.runtime.lastUniverseAt=0;
      try {
        const ids=new Set([...Object.values(this.runtime.live.entries).flatMap(e=>e?.mirrorSourceId?[e.mirrorSourceId]:[]),
          ...Object.values(this.runtime.live.positions).flatMap(p=>p?.mirrorSourceId?[p.mirrorSourceId]:[])]);
        for(const id of ids){
          const binding=await ctx.storage.get<MirrorBinding>(`${LIVE_PARITY_PREFIX}binding:${id}`);
          if(!binding||binding.version!==LIVE_PARITY_VERSION||binding.receipt.sourceId!==id)
            throw new Error(`复制映射 ${id} 缺失，禁止重复下单或重新分配比例`);
          const entry=Object.values(this.runtime.live.entries).find(e=>e?.planId===id);
          const pos=Object.values(this.runtime.live.positions).find(p=>p?.id===id);
          if(entry)entry.parity=structuredClone(binding.receipt);
          if(pos)pos.parity=structuredClone(binding.receipt);
          const sourceClosed=await ctx.storage.get<ForwardState["history"][number]>(`${LIVE_PARITY_PREFIX}source-close:${id}`);
          if(sourceClosed?.status==="CLOSED"&&sourceClosed.id===id)this.mirrorClosures.set(id,sourceClosed);
        }
        const rows=await ctx.storage.list<{position:LivePosition}>({prefix:`${LIVE_PARITY_PREFIX}closed:`,reverse:true,limit:40});
        this.liveHistory=[...rows.values()].map(row=>row.position).filter(position=>this.liveRecordVisible(position));
      } catch(error){this.liveBindingError=safeError(error);}
      // Cached cumulative amounts survive OFF and restart without a private
      // API request. Only owner-authenticated responses can view the amounts.
      try {
        const key=this.runtime.live.turnoverAccountKey;
        if(key&&/^[a-f0-9]{64}$/.test(key)){
          const saved=await ctx.storage.get<TurnoverState>(`${LIVE_TURNOVER_PREFIX}${key}:summary`);
          if(saved){this.turnoverState=validateTurnover(saved);this.turnoverAccountKey=key;}
        }
      } catch(error){this.turnoverError=safeError(error);}
      this.publishAuthority();
    });
  }

  private captureAuthority() {
    return structuredClone({ positions: this.runtime.positions, plans: this.runtime.plans, decisions: this.runtime.decisions, routes: this.runtime.routes,
      evidence: this.runtime.evidence, entryAssessments: this.runtime.entryAssessments,
      equity: this.runtime.equity, equityVersion: this.runtime.equityVersion,
      outbox: this.runtime.outbox, paperCycle: this.runtime.paperCycle, bankruptcyOutbox: this.runtime.bankruptcyOutbox,
      strategyArena: this.runtime.strategyArena, previousStrategyArena: this.runtime.previousStrategyArena,
      regimePortfolio: this.runtime.regimePortfolio, canonicalPaper: this.runtime.canonicalPaper,
      previousStableCandidates: this.runtime.previousStableCandidates,
      previousStableStructures: this.runtime.previousStableStructures, marketRegimes: this.runtime.marketRegimes,
      lastStopCheckpointAt: this.runtime.lastStopCheckpointAt, riskBreach: this.runtime.riskBreach });
  }

  private restoreAuthority(authority: ReturnType<MarketStream["captureAuthority"]>) {
    this.runtime.positions = authority.positions;
    this.runtime.plans = authority.plans;
    this.runtime.decisions = authority.decisions;
    this.runtime.routes = authority.routes;
    this.runtime.evidence = authority.evidence;
    this.runtime.entryAssessments = authority.entryAssessments;
    this.runtime.equity = authority.equity;
    this.runtime.equityVersion = authority.equityVersion;
    this.runtime.outbox = authority.outbox;
    this.runtime.paperCycle = authority.paperCycle;
    this.runtime.bankruptcyOutbox = authority.bankruptcyOutbox;
    this.runtime.strategyArena = authority.strategyArena;
    this.runtime.previousStrategyArena = authority.previousStrategyArena;
    this.runtime.regimePortfolio = authority.regimePortfolio;
    this.runtime.canonicalPaper = authority.canonicalPaper;
    this.runtime.previousStableCandidates = authority.previousStableCandidates;
    this.runtime.previousStableStructures = authority.previousStableStructures;
    this.runtime.marketRegimes = authority.marketRegimes;
    this.runtime.lastStopCheckpointAt = authority.lastStopCheckpointAt;
    this.runtime.riskBreach = authority.riskBreach;
  }

  private publishAuthority() {
    this.authorityView = structuredClone({ positions: this.runtime.positions, equity: this.runtime.equity,
      equityVersion: this.runtime.equityVersion });
  }

  private async ensureAlarm(delay = 50) {
    if (await this.ctx.storage.getAlarm() == null) {
      const next = Date.now() + delay;
      await this.ctx.storage.setAlarm(next);
      this.runtime.nextAlarmAt = next;
    }
  }

  protected resetDailyCounters(now: number) {
    if (rollResourceDay(this.runtime,now)) {
      this.runtime.dailyStartEquity = markToMarketEquity(this.runtime);
    }
  }

  /** Synchronous admission before any storage await. Outstanding reservations
   * survive UTC rollover in memory, so an old-day write cannot become free
   * capacity while it is still pending. Completion is conservatively charged
   * to the completion day. This is not a durable platform-quota ledger. */
  protected reserveNonAlarmWrites(writes:number,headroom=0) {
    if(!Number.isSafeInteger(writes)||writes<1||!Number.isSafeInteger(headroom)||headroom<0)
      throw new Error("Invalid non-alarm write reservation");
    const roll=()=>{
      if(this.runtime.utcDay)this.resetDailyCounters(Date.now());
      else this.runtime.utcDay=resourceDay(Date.now()); // isolated legacy/test state: retain its existing count
    };
    roll();this.nonAlarmPendingWrites??=0;
    if(!Number.isFinite(this.runtime.nonAlarmWrites)||this.runtime.nonAlarmWrites<0
      ||this.runtime.nonAlarmWrites+this.nonAlarmPendingWrites+writes+headroom>NON_ALARM_WRITE_CAP)return null;
    this.nonAlarmPendingWrites+=writes;
    let finished=false;
    return {finish:(committed:boolean)=>{
      if(finished)return;
      roll();
      if(committed)this.runtime.nonAlarmWrites+=writes;
      this.nonAlarmPendingWrites-=writes;finished=true;
    }};
  }

  private refreshUniverse(now: number, ranked: Awaited<ReturnType<typeof fetchActiveContracts>>) {
    if (ranked.length === 0) throw new Error("contract catalog unavailable: empty active-contract response");
    this.contractCatalog = new Map(ranked.map((row) => [row.symbol, row]));
    this.forwardLearningUniverse=ranked.filter(row=>adaptiveSymbolAllowed(row.symbol)&&row.volume24hUsd>=FORWARD_EXECUTION_VOLUME_FLOOR_USD).map(row=>row.symbol);
    this.runtime.lastUniverseAt = now;
    for (const symbol of new Set([...this.runtime.symbols,...this.runtime.liquidUniverse])) this.applyContractMetadata(symbol);
    this.ctx.waitUntil(this.ctx.storage.put("gate-contract-catalog:v1",ranked).catch(()=>undefined));
  }

  private applyContractMetadata(symbol: string) {
    const row = this.contractCatalog.get(symbol);
    if (!row) return;
    this.runtime.tickSize[symbol] = row.tickSize;
    this.runtime.contractMeta[symbol] = { quantoMultiplier: row.quantoMultiplier, maintenanceRate: row.maintenanceRate,
      leverageMax: row.leverageMax, fundingRate: row.fundingRate,
      enableDecimal:row.enableDecimal,orderSizeMin:row.orderSizeMin,orderSizeMax:row.orderSizeMax,marketOrderSizeMax:row.marketOrderSizeMax };
    if (this.memory[symbol]) this.memory[symbol].flow.funding = row.fundingRate;
  }

  private strategyPathSymbols() {
    return [...new Set([
      ...this.runtime.liquidUniverse,
      ...(this.forwardState?.positions.map(position=>position.symbol)??[]),
    ])];
  }

  private applyRealtimeSymbols(next: string[]) {
    const prior = new Set(this.runtime.symbols);
    this.runtime.symbols = next;
    for (const symbol of next) {
      this.applyContractMetadata(symbol);
      const after = this.runtime.contractMeta[symbol];
      if (!prior.has(symbol)) {
        this.memory[symbol] = emptySymbolMemory();
        this.memory[symbol].quantoMultiplier = after?.quantoMultiplier ?? 1;
        this.memory[symbol].maintenanceRate = after?.maintenanceRate ?? 0.005;
        this.memory[symbol].flow.funding = after?.fundingRate ?? 0;
        this.sessionWarmup[symbol] = 0;
        this.runtime.decisions[symbol] = null;
        this.runtime.routes[symbol] = [];
      }
      if (this.memory[symbol]) this.memory[symbol].flow.funding = after?.fundingRate ?? 0;
    }
    for (const symbol of new Set([...Object.keys(this.memory), ...Object.keys(this.sessionWarmup), ...Object.keys(this.runtime.decisions), ...Object.keys(this.runtime.routes),
      ...Object.keys(this.runtime.plans), ...Object.keys(this.runtime.positions), ...Object.keys(this.runtime.evidence), ...Object.keys(this.runtime.entryAssessments),
      ...Object.keys(this.runtime.feedFailures), ...Object.keys(this.runtime.strategyCandleFailures), ...Object.keys(this.strategyCandles),
      ...Object.keys(this.runtime.tickSize), ...Object.keys(this.runtime.contractMeta)])) {
      if (next.includes(symbol)) continue;
      delete this.memory[symbol]; delete this.sessionWarmup[symbol]; delete this.runtime.decisions[symbol]; delete this.runtime.routes[symbol]; delete this.runtime.plans[symbol];
      delete this.runtime.positions[symbol]; delete this.runtime.evidence[symbol]; delete this.runtime.entryAssessments[symbol]; delete this.runtime.feedFailures[symbol];
      // Five-minute Multi-Turn paths are independent of the small realtime book pool.
      // Keep current scan paths AND every open source holding until it closes,
      // otherwise the owning timeframe could stop seeing its own reversal.
      if (!this.strategyPathSymbols().includes(symbol)) {
        delete this.runtime.strategyCandleFailures[symbol]; delete this.strategyCandles[symbol];
      }
      if(!this.runtime.liquidUniverse.includes(symbol)&&!this.forwardUrgentSymbols().includes(symbol)){
        delete this.forwardMinuteCandles[symbol];delete this.forwardMinuteQuoteBars[symbol];this.forwardMinuteRetryAt.delete(symbol);
      }
      if(!this.runtime.liquidUniverse.includes(symbol)){
        delete this.runtime.tickSize[symbol]; delete this.runtime.contractMeta[symbol];
      }
    }
  }

  private refreshRadar(now:number) {
    const cached=this.gateRadarAt>0&&now-this.gateRadarAt<=2*RADAR_MS?new Map(this.gateRadarCache.map(row=>[row.symbol,row])):null;
    const known=this.contractCatalog.size
      ?[...this.contractCatalog.values()].filter(row=>adaptiveSymbolAllowed(row.symbol)).map(row=>{
        const fresh=cached?.get(row.symbol);return fresh?{...fresh,fundingRate:row.fundingRate}:{symbol:row.symbol,last:row.last,
          volume24hUsd:row.volume24hUsd,fundingRate:row.fundingRate};
      })
      :[...new Set([...this.runtime.liquidUniverse,...DEFAULT_SYMBOLS])].flatMap(symbol=>{
        const q=this.marketHub.quote(symbol,now);return q?[{symbol,last:q.mid,volume24hUsd:q.volume24hUsd,fundingRate:0}]:[];
      });
    const eligibleRows=this.marketHub.radarRows(known,now);
    if(!eligibleRows.length)throw new Error("no Gate-tradable Forward Relation markets");
    const executionEligible=eligibleRows.filter(forwardExecutionUniverseEligible);
    if(this.contractCatalog.size&&executionEligible.length)this.forwardLearningUniverse=executionEligible.map(row=>row.symbol);
    const locked=this.forwardState?.positions.map(p=>p.symbol)??[];
    const universeRows=selectAnchorOpportunityUniverse({rows:eligibleRows,limit:SCAN_UNIVERSE_SIZE,
      lockedSymbols:locked,currentSymbols:this.runtime.liquidUniverse,coreSymbols:DEFAULT_SYMBOLS,
      rotationSeed:Math.floor(now/BAR_MS),explorationSlots:2,liquiditySlots:0});
    if(!universeRows.length)throw new Error("no liquid Forward Relation markets");
    this.runtime.liquidUniverse=universeRows.map(row=>row.symbol);
    this.runtime.radar=successfulRadarRuntime(this.runtime.radar,now,universeRows.length,[]);
    this.runtime.lastRadarAt=now;
    // Gate realtime capacity is execution-only: open exposure and candidates
    // that are actually eligible. Analysis-only markets stay on Bybit/OKX/KuCoin.
    const protectedSymbols=[...this.currentAuthorityProtectionSymbols()];
    const watched=this.forwardState?forwardWatchSymbols(this.forwardState,now,this.runtime.liquidUniverse):[];
    const next=[...new Set([...protectedSymbols,...watched])].slice(0,FORWARD_EXECUTION_BBO_CAP);
    if(next.length||this.runtime.symbols.length)this.applyRealtimeSymbols(next);
  }

  protected regimeQuotes(now: number) {
    return Object.fromEntries(Object.entries(this.runtime.evidence).flatMap(([symbol, row]) => row?.fresh
      && now - row.observedAt <= STALE_AFTER_MS && row.bestBid != null && row.bestAsk != null
      ? [[symbol, { midpoint: row.midpoint, bestBid: row.bestBid, bestAsk: row.bestAsk,
        observedAt: row.observedAt, fresh: true,
        entryReady: row.entryReady === true,
        completedMinuteAt: this.strategyCandles[symbol]?.at(-1)
          ? (this.strategyCandles[symbol].at(-1)!.time + 300) * 1_000 : undefined }]] : []));
  }

  private regimeContracts() {
    return Object.fromEntries(Object.entries(this.runtime.contractMeta).map(([symbol, row]) => [symbol, {
      ...row, volume24hUsd: this.contractCatalog.get(symbol)?.volume24hUsd ?? 0,
    }]));
  }

  protected reconcileCanonicalMirror(now: number) {
    // Retired arena/regime accounts no longer participate in trading authority.
    // Keep the compatibility checkpoint fields inert until the next storage cleanup.
    void now;
    if(this.forwardState)this.runtime.equity=forwardEquity(this.forwardState,this.regimeQuotes(Date.now()),Date.now()).equity;
    return false;
  }

  private evaluateRegimeNow(now: number) {
    this.runtime.regimePortfolio = evaluateRegimePortfolio({ state: this.runtime.regimePortfolio,
      hourly: this.regimeHourly, quotes: this.regimeQuotes(now), contracts: this.regimeContracts(), now, allowNewEntries: false });
  }

  private forwardView(now = Date.now()) {
    return this.forwardState ? { ...forwardSummary(this.forwardState, this.regimeQuotes(now), now),
      liveMirror: this.liveMirrorView(),
      storage: { ...this.forwardState.storage, error: this.forwardError } }
      : { version: FORWARD_VERSION, mode: "RECOVERY_REQUIRED", liveEligible: false, storage: { error: this.forwardError } };
  }

  private forwardHealth() {
    const s=this.forwardState,now=Date.now(),opportunities=s?.opportunities??[];
    const eligible=opportunities.filter(row=>row.eligible&&row.expiresAt>now);
    const blocked=opportunities.filter(row=>!row.eligible&&row.expiresAt>now).slice(0,8).map(row=>({
      symbol:row.symbol,side:row.side,mode:row.mode,reserve:row.reserve===true,score:Math.round(row.score),
      netRate:row.netRemainingSpaceRate,edgeRatio:row.edgeRatio,relationStatus:row.relationStatus??null,
      relationHealth:row.relationHealth??null,reason:row.reason,
    }));
    const frames=Object.values(s?.relationEngine?.frames??{});
    const ruleDiagnostics=(s?.relationEngine?.rules??[]).slice(0,12).map(row=>({
      id:row.id,scope:row.scope,horizon:row.horizon,side:row.side,status:row.status,health:row.health,
      currentMatches:frames.filter(frame=>row.symbols.includes(frame.symbol)&&row.conditions.every(c=>
        Number.isFinite(frame.x[c.feature])&&(c.op==="GE"?frame.x[c.feature]!>=c.threshold:frame.x[c.feature]!<=c.threshold))).length,
      longNet:row.longNet,recentNet:row.recentNet,standardError:row.standardError,samples:row.samples,
      longGroups:row.longGroups,recentGroups:row.recentGroups,livePathScore:row.livePathScore,
      environmentFit:row.environmentFit,lastQualifiedAt:row.lastQualifiedAt,
      bestHoldMinutes:row.exitProfile.bestHoldMinutes,feedbackDeadlineMinutes:row.exitProfile.feedbackDeadlineMinutes,
      maxHoldMinutes:row.exitProfile.maxHoldMinutes,normalAdverseRate:row.exitProfile.normalAdverseRate,
      targetRate:row.exitProfile.targetRate,retentionRate:row.exitProfile.retentionRate,winRate:row.exitProfile.winRate??null,
      medianWinNetRate:row.exitProfile.medianWinNetRate??null,medianLossNetRate:row.exitProfile.medianLossNetRate??null,
      adverseP80Rate:row.exitProfile.adverseP80Rate??null,adverseP95Rate:row.exitProfile.adverseP95Rate??null,reason:row.reason,
    }));
    return {version:FORWARD_VERSION,engineVersion:ADAPTIVE_ENGINE_VERSION,policyVersion:s?.policyVersion??null,
      strategyAuthorityVersion:s?.strategyAuthorityVersion??null,executionVersion:s?.executionVersion??null,
      regionVersion:s?.regionVersion??null,regionLaunchVersion:s?.regionLaunchVersion??null,liveEligible:false,
      startedAt:s?.startedAt??null,initialEquity:s?.initialEquity??null,balance:s?.balance??null,lastCycleAt:s?.lastCycleAt??null,
      resolved:s?.resolved??0,openCount:s?.positions.length??0,targetPositionCount:null,positionLimit:null,
      executionBboCapacity:FORWARD_EXECUTION_BBO_CAP,minuteConfirmationCapacity:FORWARD_MINUTE_CONFIRMATION_CAP,
      executionVolumeFloorUsd:FORWARD_EXECUTION_VOLUME_FLOOR_USD,learningEligibleMarkets:this.forwardLearningUniverse.length,
      participationCandidateCount:opportunities.length,participationEligibleCount:eligible.length,
      premiumOpportunityCount:eligible.filter(row=>row.premium).length,regionCount:Object.keys(s?.regions??{}).length,
      relationSampleCount:s?.relationEngine?.samples.length??0,relationRuleCount:s?.relationEngine?.rules.length??0,
      relationPendingCount:Object.keys(s?.relationEngine?.pending??{}).length,
      relationFrameCount:Object.keys(s?.relationEngine?.frames??{}).length,
      relationDiagnostics:s?.relationEngine?.diagnostics??null,entryDiagnostics:s?.entryDiagnostics??null,
      ruleDiagnostics,candidateDiagnostics:blocked,storage:{persistedAt:s?.storage.persistedAt??0,error:this.forwardError}};
  }

  protected liveMirrorView() {
    return mirrorCoverage(this.forwardState,this.runtime.live,this.forwardError??this.liveBindingError);
  }

  protected liveDesiredPortfolio(now:number):Record<string,MirrorSourceTrade> {
    if(!this.forwardState)throw new Error("当前模拟账户尚未恢复");
    return forwardMirrorSources(this.forwardState,forwardEquity(this.forwardState,this.regimeQuotes(now),now).equity);
  }

  private currentMirrorSource(id:string) {
    const current=sourceLifecycle(this.forwardState,id),closed=this.mirrorClosures.get(id);
    return current.status==="UNKNOWN"&&closed?{status:"CLOSED" as const,trade:closed}:current;
  }

  private mirrorQuoteReady(symbol:string,now=Date.now()) {
    const q=this.runtime.evidence[symbol];
    return !!q && q.entryReady===true && freshQuote({bestBid:q.bestBid??0,bestAsk:q.bestAsk??0,
      observedAt:q.observedAt,fresh:q.fresh},now);
  }

  private async queueLiveBinding(entry:LiveEntry) {
    if(!entry.parity)return;
    const key=`${LIVE_PARITY_PREFIX}binding:${entry.planId}`;
    const existing=(this.liveJournal.get(key) as MirrorBinding|undefined)??await this.ctx.storage.get<MirrorBinding>(key);
    if(!existing)throw new Error("完整模拟源单映射缺失，拒绝提交交易");
    this.liveJournal.set(key,{...existing,receipt:structuredClone(entry.parity)});
  }

  private async ensureAdaptiveAccount(now:number){
    if(!this.forwardState)this.forwardState=await readForwardStore(this.ctx.storage,now);
    if(!this.forwardState)throw new Error("PAPER权威账户缺失");
    // normalizeForward already upgrades old records in place. Strategy revisions
    // must never close positions, replace startedAt or create a fresh 1000U ledger.
    return false;
  }

  private async advanceForwardNow(now: number, allowDataCycle = true) {
    if (this.forwardBusy) return;
    this.forwardBusy = true;
    try {
      await this.ensureAdaptiveAccount(now);
      const state=this.forwardState!;
      const dataCycleDue=allowDataCycle&&(!state.lastCycleAt
        ||Math.floor((now-90_000)/BAR_MS)>Math.floor((state.lastCycleAt-90_000)/BAR_MS));
      const urgent=this.forwardUrgentSymbols(now).length>0||state.positions.length>0;
      const quoteCadence=urgent?LOOP_MS:5_000;
      if(!dataCycleDue&&now-state.lastQuoteCycleAt<quoteCadence){
        this.forwardLastAttemptAt=state.lastQuoteCycleAt;return;
      }
      this.forwardLastAttemptAt=now;
      const previous = state;
      const next = advanceForward({ state: previous, now, paths: this.strategyCandles,minutePaths:this.forwardMinutePaths(),
        quotes: this.forwardQuotes(now), contracts: this.regimeContracts(),
        entrySymbols: this.runtime.liquidUniverse,learningSymbols:this.forwardLearningUniverse.length?this.forwardLearningUniverse:undefined,
        allowDataCycle:dataCycleDue });
      if (next.changed || !previous.storage.persistedAt) {
        next.state.storage = { persistedAt: now, error: null };
        const prepared = await prepareForwardWrite(previous.storage.persistedAt ? previous : null, next.state, now, {compact:true});
        // Retain authoritative parent exits even when the hot PAPER history
        // rotates while Gate is unreachable. This is one write per bound exit,
        // in the same atomic commit, not a new strategy/account or per-tick log.
        const bound=new Set([...Object.values(this.runtime.live.entries).flatMap(e=>e?.mirrorSourceId?[e.mirrorSourceId]:[]),
          ...Object.values(this.runtime.live.positions).flatMap(p=>p?.mirrorSourceId?[p.mirrorSourceId]:[])]);
        const closures=next.state.history.filter(t=>bound.has(t.id)&&!this.mirrorClosures.has(t.id));
        for(const t of closures)prepared.entries[`${LIVE_PARITY_PREFIX}source-close:${t.id}`]=structuredClone(t);
        prepared.writes+=closures.length;
        // All extra persistence consumes the existing non-alarm write reserve.
        const reservation=this.reserveNonAlarmWrites(prepared.writes,64);
        if(!reservation)throw new Error("前向写入预算不足；保留原账户，不提交未持久化订单");
        try {await this.ctx.storage.transaction(async transaction => { await transaction.put(prepared.entries); });reservation.finish(true);}
        finally {reservation.finish(false);}
        this.forwardCompression=prepared.compression;
        for(const t of closures)this.mirrorClosures.set(t.id,structuredClone(t));
      } else if (next.protectionChanged) {
        // Only a new decision-relevant peak/confirmation requests this compact
        // write. Ordinary quote/audit changes do not write or create archives.
        // Keep the same base persistedAt: it fences this overlay to the last
        // full financial commit, which remains the sole account authority.
        const prepared=prepareForwardProtectionWrite(next.state);
        // Resource counters survive a new financial generation and process
        // restart. They share the checkpoint key/atomic commit, NOT the exit
        // budget. A peak can no longer steal the final financial commit rows.
        const usage=await this.ctx.storage.transaction(async transaction => {
          const saved=await transaction.get<{writeBudget?:unknown}>(FORWARD_PROTECTION_STORAGE);
          const writeBudget=nextProtectionWriteBudget(saved?.writeBudget,now);
          await transaction.put({[FORWARD_PROTECTION_STORAGE]:{
            ...prepared.entries[FORWARD_PROTECTION_STORAGE],writeBudget}});
          return writeBudget;
        });
        this.forwardProtectionBudget=usage;
      }
      // A PAPER fill/rule update or critical protection update becomes visible
      // only after its atomic commit. A failed write retains the old authority.
      this.forwardState = next.state;
      this.forwardError = null;
      // Publish only committed lifecycle events. A source born in the candle
      // lane must not wait for the next alarm; a source closed while Gate is
      // awaiting I/O must wake the serialized reconciler as well.
      if(previous.positions.length!==next.state.positions.length
        ||previous.positions.some(p=>!next.state.positions.some(n=>n.id===p.id)))this.launchLiveWork(true);
    } catch (error) { this.forwardError = safeError(error); }
    finally { this.forwardBusy = false; }
  }

  private async refreshRegimeHourly(now: number) {
    const target = Math.floor(now / 3_600_000) * 3_600 - 3_600;
    const storageRetry = REGIME_EXECUTION_UNIVERSE.find((item) => {
      const failure = this.runtime.regimeHourlyFailures[item];
      return failure?.stage === "STORAGE" && failure.retryAt <= now
        && (this.regimeHourly[item]?.length ?? 0) >= REGIME_HOURLY_REQUIRED_CANDLES;
    });
    if (storageRetry) {
      try {
        await this.ctx.storage.put(regimeHourlyStorageKey(storageRetry), this.regimeHourly[storageRetry]);
        delete this.runtime.regimeHourlyFailures[storageRetry];
      } catch (error) {
        const prior = this.runtime.regimeHourlyFailures[storageRetry];
        this.runtime.regimeHourlyFailures[storageRetry] = { count: (prior?.count ?? 0) + 1,
          lastFailureAt: now, retryAt: now + REGIME_HOURLY_RETRY_MS,
          stage: "STORAGE", lastError: `保存720小时路径失败：${safeError(error)}` };
      }
      this.evaluateRegimeNow(now);
      return 0;
    }
    const symbol = REGIME_EXECUTION_UNIVERSE.find((item) => {
      if (!this.contractCatalog.has(item)) return false;
      const rows = this.regimeHourly[item] ?? [];
      const failure = this.runtime.regimeHourlyFailures[item];
      const fetchReady = failure?.stage !== "FETCH" || failure.retryAt <= now;
      return fetchReady && regimeHourlyNeedsRefresh(rows, target);
    });
    if (!symbol) { this.evaluateRegimeNow(now); return 0; }
    const prior = this.regimeHourly[symbol] ?? [];
    try {
      const fetchLimit = regimeHourlyFetchLimit(prior.length);
      const incoming = await fetchStructureCandles(symbol, "1h", fetchLimit);
      const rows = mergeRegimeHourlyPath(prior, incoming);
      this.regimeHourly[symbol] = rows;
      if (rows.length < REGIME_HOURLY_REQUIRED_CANDLES) {
        const failure = this.runtime.regimeHourlyFailures[symbol];
        this.runtime.regimeHourlyFailures[symbol] = { count: (failure?.count ?? 0) + 1,
          lastFailureAt: now, retryAt: now + REGIME_HOURLY_RETRY_MS, stage: "FETCH",
          lastError: `720小时连续路径不足：仅收到${rows.length}/${REGIME_HOURLY_REQUIRED_CANDLES}根完整K线` };
        this.evaluateRegimeNow(now);
        return 1;
      }
      try {
        await this.ctx.storage.put(regimeHourlyStorageKey(symbol), rows);
        delete this.runtime.regimeHourlyFailures[symbol];
      } catch (error) {
        const failure = this.runtime.regimeHourlyFailures[symbol];
        this.runtime.regimeHourlyFailures[symbol] = { count: (failure?.count ?? 0) + 1,
          lastFailureAt: now, retryAt: now + REGIME_HOURLY_RETRY_MS,
          stage: "STORAGE", lastError: `保存720小时路径失败：${safeError(error)}` };
      }
    } catch (error) {
      const failure = this.runtime.regimeHourlyFailures[symbol];
      const retryAt = error instanceof GatePublicError && error.retryAt
        ? Math.max(now + 2_000, error.retryAt) : now + REGIME_HOURLY_RETRY_MS;
      this.runtime.regimeHourlyFailures[symbol] = { count: (failure?.count ?? 0) + 1,
        lastFailureAt: now, retryAt, stage: "FETCH", lastError: `补齐720小时路径失败：${safeError(error)}` };
    }
    this.evaluateRegimeNow(now);
    return 1;
  }

  private async refreshTurnDaily(now:number) {
    const universe=this.strategyPathSymbols();if(!universe.length)return 0;
    const target=Math.floor(now/86_400_000)*86_400-86_400;
    let selected:string|null=null;
    for(let offset=0;offset<universe.length;offset++){
      const index=(this.turnDailyCursor+offset)%universe.length,symbol=universe[index];
      if(!this.turnDailyLoaded.has(symbol)){
        const saved=await this.ctx.storage.get<Awaited<ReturnType<typeof fetchStructureCandles>>>(turnDailyStorageKey(symbol));
        if(saved?.length)this.turnDailyCandles[symbol]=mergeTurnDailyPath([],saved);
        this.turnDailyLoaded.add(symbol);
      }
      const rows=this.turnDailyCandles[symbol]??[],retryAt=this.turnDailyFailures.get(symbol)?.retryAt??0;
      if((rows.length<TURN_DAILY_REQUIRED_CANDLES||(rows.at(-1)?.time??0)<target)&&retryAt<=now){
        selected=symbol;this.turnDailyCursor=(index+1)%universe.length;break;
      }
    }
    if(!selected)return 0;
    try{
      const prior=this.turnDailyCandles[selected]??[];
      const incoming=await fetchStructureCandles(selected,"1d",prior.length>=TURN_DAILY_REQUIRED_CANDLES?4:120);
      const rows=mergeTurnDailyPath(prior,incoming);this.turnDailyCandles[selected]=rows;
      if(rows.length<TURN_DAILY_REQUIRED_CANDLES)throw new Error(`日线历史不足：${rows.length}/${TURN_DAILY_REQUIRED_CANDLES}`);
      const reservation=this.reserveNonAlarmWrites(1,64);
      if(reservation){
        try{await this.ctx.storage.put(turnDailyStorageKey(selected),rows);reservation.finish(true);}
        finally{reservation.finish(false);}
      }
      this.turnDailyFailures.delete(selected);
    }catch(error){
      this.turnDailyFailures.set(selected,{retryAt:now+60_000,lastError:safeError(error)});
    }
    return 1;
  }

  private async maybeWriteStrategyRuntimeLog(now: number) {
    if (now - this.runtime.lastStrategyLogAt < STRATEGY_LOG_MS || this.runtime.d1Writes + 2 > 4_800) return;
    this.runtime.lastStrategyLogAt = now;
    const summary = canonicalPaperSummary({ current: this.runtime.strategyArena, previous: this.runtime.previousStrategyArena,
      regime: this.runtime.regimePortfolio }, this.runtime.canonicalPaper);
    const counts = marketRegimeSummary(this.runtime.marketRegimes).counts;
    const mechanismMetrics = REGIME_STRATEGIES.map((item) => ({ kind: "FROZEN_REGIME_STRATEGY",
      engineId: item.system, id: item.id, tactic: item.tactic, authority: "CURRENT_REGIME_DIRECT",
      paperAuthority: "FROZEN_44_MONTH_RESEARCH", shadowEvents: 0 }));
    const metrics = [...this.runtime.regimePortfolio.routeChecks.slice(0, 60), ...mechanismMetrics];
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(`INSERT OR REPLACE INTO strategy_runtime_log
          (id,observed_at,version,scanned_markets,stable_markets,realtime_markets,regime_counts_json,strategy_metrics_json,
           shadow_open,shadow_resolved,active_strategies,portfolio_open,portfolio_equity,portfolio_resolved,portfolio_net_pnl,
           strategy_candle_error,authority_state,live_requested,live_operational)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          `strategy-runtime:${Math.floor(now / STRATEGY_LOG_MS)}`, now, this.runtime.version, this.runtime.radar.scanned,
          Object.keys(this.runtime.stableCandidates).length, this.runtime.symbols.length, JSON.stringify(counts), JSON.stringify(metrics),
          0, 0, summary.activeCount,
          canonicalPaperOpen({ current: this.runtime.strategyArena, previous: this.runtime.previousStrategyArena,
            regime: this.runtime.regimePortfolio }, this.runtime.canonicalPaper).length,
          summary.portfolioEquity, summary.portfolioResolved, summary.portfolioEquity - summary.initialEquity,
          this.runtime.strategyCandleError, this.runtime.state, Number(this.runtime.live.requestedEnabled), Number(this.runtime.live.operational)),
        this.env.DB.prepare("DELETE FROM strategy_runtime_log WHERE observed_at<?").bind(now - STRATEGY_LOG_RETENTION_MS),
      ]);
      this.runtime.d1Writes += 2;
      this.runtime.strategyLogError = null;
    } catch (error) {
      this.runtime.strategyLogError = safeError(error);
    }
  }

  private observeArena(symbol: string, midpoint: number, analyzed: ReturnType<typeof analyzeSnapshot>, now: number,
    spreadRate: number, bestBid: number, bestAsk: number, bidDepthUsd: number, askDepthUsd: number) {
    this.runtime.strategyArena = advanceStrategyArena({ state: this.runtime.strategyArena,
      quotes: { [symbol]: { midpoint, bestBid, bestAsk } }, now });
    this.runtime.previousStrategyArena = advancePreviousStrategyArena({ state: this.runtime.previousStrategyArena,
      quotes: { [symbol]: { midpoint, bestBid, bestAsk } }, now });
    // V4/V5 are retired: existing positions keep their original protection,
    // but no legacy candidate can create a new order after this cutover.
    if (this.runtime.regimePortfolio.version === REGIME_PORTFOLIO_VERSION) return;
    const memory = this.memory[symbol];
    const contract = this.contractCatalog.get(symbol);
    if (!memory || !contract) return;
    const candle = residentCandleCandidate({ symbol, candles: memory.recentCompletedMinuteCandles,
      volume24hUsd: contract.volume24hUsd, fundingRate: contract.fundingRate, now });
    const stable = this.runtime.stableCandidates[symbol];
    const candidates = stable && now - stable.observedAt <= STRATEGY_CANDLE_STALE_MS ? [stable] : candle ? [candle.candidate] : [];
    const marketContext = broadMarketContext(this.runtime.stableCandidates, now);
    const rankedRoutes = [...new Map([...Object.values(this.runtime.stableCandidates), ...candidates]
      .map((row) => [row.symbol, row])).values()]
      .filter((row) => approvedRouteScore(row) >= 0 && now - row.observedAt <= STRATEGY_CANDLE_STALE_MS)
      .sort((left, right) => approvedRouteScore(right) - approvedRouteScore(left)
        || right.observedAt - left.observedAt || left.symbol.localeCompare(right.symbol));
    for (const candidate of candidates) {
      this.runtime.strategyArena = observeStrategyArena({ state: this.runtime.strategyArena, observation: {
        candidate, midpoint, bestBid, bestAsk, alignedFlow: 0, minuteNoiseRate: memory.minuteNoiseRate,
        spreadRate, range15m: analyzed.range15m, confirmationBySide: analyzed.confirmationBySide,
        fakeoutBySide: analyzed.fakeoutBySide, routes: analyzed.routes, bidDepthUsd, askDepthUsd,
        candleStructure: this.runtime.stableStructures[symbol] ?? candle?.structure ?? null,
        quantoMultiplier: this.runtime.contractMeta[symbol]?.quantoMultiplier,
        maintenanceRate: this.runtime.contractMeta[symbol]?.maintenanceRate, completedMinuteAt: memory.timeframeUpdatedAt.m1,
        leverageMax: this.runtime.contractMeta[symbol]?.leverageMax, now, dataFresh: true,
        globalBreadth: marketContext.breadth, globalMedianMove: marketContext.medianMove, globalMarkets: marketContext.markets,
        marketBreadth4h: marketContext.breadth4h, marketMedianMove4h: marketContext.medianMove4h,
        marketBreadth24h: marketContext.breadth24h, marketMedianMove24h: marketContext.medianMove24h,
        btcMove24h: marketContext.btcMove24h, regimeMarkets: marketContext.regimeMarkets,
        contractReady: this.runtime.contractMeta[symbol] != null,
        globalOpportunityRank: Math.max(1, rankedRoutes.findIndex((row) => row.symbol === candidate.symbol) + 1),
        globalOpportunityCount: rankedRoutes.length,
        managementCapacity: Object.keys(this.runtime.strategyArena.portfolioOpen)
          .every((openSymbol) => this.runtime.symbols.includes(openSymbol) && this.runtime.evidence[openSymbol]?.fresh !== false),
      } });
    }
    const previousStable = this.runtime.previousStableCandidates[symbol];
    const previousCandidates = previousStable && now - previousStable.observedAt <= STRATEGY_CANDLE_STALE_MS
      ? [previousStable] : [];
    const previousMarketContext = broadMarketContext(this.runtime.previousStableCandidates, now);
    const previousRankedRoutes = Object.values(this.runtime.previousStableCandidates)
      .filter((row) => previousApprovedRouteScore(row) >= 0 && now - row.observedAt <= STRATEGY_CANDLE_STALE_MS)
      .sort((left, right) => previousApprovedRouteScore(right) - previousApprovedRouteScore(left)
        || right.observedAt - left.observedAt || left.symbol.localeCompare(right.symbol));
    for (const candidate of previousCandidates) {
      this.runtime.previousStrategyArena = observePreviousStrategyArena({ state: this.runtime.previousStrategyArena, observation: {
        candidate, midpoint, bestBid, bestAsk, alignedFlow: 0, minuteNoiseRate: memory.minuteNoiseRate,
        spreadRate, range15m: analyzed.range15m, confirmationBySide: analyzed.confirmationBySide,
        fakeoutBySide: analyzed.fakeoutBySide, routes: analyzed.routes, bidDepthUsd, askDepthUsd,
        candleStructure: this.runtime.previousStableStructures[symbol] ?? null,
        quantoMultiplier: this.runtime.contractMeta[symbol]?.quantoMultiplier,
        maintenanceRate: this.runtime.contractMeta[symbol]?.maintenanceRate, completedMinuteAt: memory.timeframeUpdatedAt.m1,
        leverageMax: this.runtime.contractMeta[symbol]?.leverageMax, now, dataFresh: true,
        globalBreadth: previousMarketContext.breadth, globalMedianMove: previousMarketContext.medianMove,
        globalMarkets: previousMarketContext.markets, contractReady: this.runtime.contractMeta[symbol] != null,
        globalOpportunityRank: Math.max(1, previousRankedRoutes.findIndex((row) => row.symbol === candidate.symbol) + 1),
        globalOpportunityCount: previousRankedRoutes.length,
        managementCapacity: Object.keys(this.runtime.previousStrategyArena.portfolioOpen)
          .every((openSymbol) => this.runtime.symbols.includes(openSymbol) && this.runtime.evidence[openSymbol]?.fresh !== false),
      } });
    }
    if (this.runtime.strategyArena.cutoverPending) {
      const positions = Object.values(this.runtime.strategyArena.portfolioOpen);
      if (positions.every((position) => {
        const evidence = this.runtime.evidence[position.symbol];
        return evidence?.fresh && now - evidence.observedAt <= STALE_AFTER_MS && evidence.bestBid != null && evidence.bestAsk != null;
        })) this.runtime.strategyArena = resetStrategyArenaAccount({ state: this.runtime.strategyArena,
        quotes: Object.fromEntries(positions.map((position) => [position.symbol, {
          midpoint: this.runtime.evidence[position.symbol]!.midpoint, bestBid: this.runtime.evidence[position.symbol]!.bestBid,
          bestAsk: this.runtime.evidence[position.symbol]!.bestAsk, observedAt: this.runtime.evidence[position.symbol]!.observedAt, fresh: true,
        }])), now, reason: "全境·复利引擎切换：以新鲜可成交价格结算并归档上一模拟周期" });
    }
    if (this.runtime.previousStrategyArena.cutoverPending) {
      const positions = Object.values(this.runtime.previousStrategyArena.portfolioOpen);
      if (positions.every((position) => {
        const evidence = this.runtime.evidence[position.symbol];
        return evidence?.fresh && now - evidence.observedAt <= STALE_AFTER_MS && evidence.bestBid != null && evidence.bestAsk != null;
      })) this.runtime.previousStrategyArena = resetPreviousStrategyArenaAccount({ state: this.runtime.previousStrategyArena,
        quotes: Object.fromEntries(positions.map((position) => [position.symbol, {
          midpoint: this.runtime.evidence[position.symbol]!.midpoint, bestBid: this.runtime.evidence[position.symbol]!.bestBid,
          bestAsk: this.runtime.evidence[position.symbol]!.bestAsk, observedAt: this.runtime.evidence[position.symbol]!.observedAt, fresh: true,
        }])), now, reason: "上一版独立引擎迁移：以新鲜可成交价格结算并归档旧周期" });
    }
  }

  private priorityMinuteSymbols(now: number) {
    const completedMinute = Math.floor(now / 60_000) * 60_000;
    return this.runtime.symbols.filter((symbol) => (this.memory[symbol]?.timeframeUpdatedAt.m1 ?? 0) < completedMinute);
  }

  private criticalEvidenceFresh(symbol: string, now: number) {
    const memory = this.memory[symbol] ?? emptySymbolMemory();
    return now - memory.timeframeUpdatedAt.m1 <= 3 * 60_000;
  }

  private async updateAncillary(now: number) {
    const scheduled = ancillarySchedule(this.runtime.ancillaryCursor++, this.runtime.symbols, this.priorityMinuteSymbols(now));
    if (!scheduled) return 0;
    const symbol = scheduled.symbol;
    let featureTask: () => Promise<{ kind: string; symbol: string; value: unknown; timeframe?: "1m" | "15m" | "1h" }>;
    if (scheduled.feature === "trades") featureTask = async () => ({ kind: "trades", symbol, value: await fetchRecentTrades(symbol) });
    else if (scheduled.feature === "liquidations") featureTask = async () => ({ kind: "liquidations", symbol, value: await fetchLiquidations(symbol) });
    else {
      const timeframe = scheduled.feature;
      featureTask = async () => ({ kind: "structure", symbol, timeframe, value: await fetchStructureCandles(symbol, timeframe) });
    }
    const tasks: Array<() => Promise<{ kind: string; symbol: string; value: unknown; timeframe?: "1m" | "15m" | "1h" }>> = [
      async () => ({ kind: "stats", symbol, value: await fetchContractStats(symbol) }),
      featureTask,
    ];
    const results = await batches(tasks);
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const memory = this.memory[result.value.symbol] ??= emptySymbolMemory();
      if (result.value.kind === "stats") {
        const stat = result.value.value as Awaited<ReturnType<typeof fetchContractStats>>;
        const statTime = Number(stat?.time ?? 0);
        if (stat && statTime > memory.lastOiStatTime) {
          updateOpenInterestCohorts(memory, Number(stat.open_interest ?? 0));
          memory.lastOiStatTime = statTime;
          memory.oiUpdatedAt = now;
        }
      } else if (result.value.kind === "trades") {
        const rows = result.value.value as Awaited<ReturnType<typeof fetchRecentTrades>>;
        const fresh = rows.filter((trade) => Number(trade.id ?? 0) > memory.lastTradeId);
        const signed = fresh.reduce((sum, trade) => sum + Number(trade.size ?? 0), 0);
        const gross = fresh.reduce((sum, trade) => sum + Math.abs(Number(trade.size ?? 0)), 0);
        memory.flow.takerDelta = gross > 0 ? Math.max(-1, Math.min(1, signed / gross)) : memory.flow.takerDelta * 0.7;
        memory.lastTradeId = Math.max(memory.lastTradeId, ...rows.map((trade) => Number(trade.id ?? 0)));
        memory.tradesUpdatedAt = now;
      } else if (result.value.kind === "liquidations") {
        const rows = result.value.value as Awaited<ReturnType<typeof fetchLiquidations>>;
        const fresh = rows.filter((row) => Number(row.time ?? 0) > memory.lastLiquidationTime);
        const gross = fresh.reduce((sum, row) => sum + Math.abs(Number(row.order_size ?? 0)), 0);
        memory.actualLiquidationNotional = memory.actualLiquidationNotional * 0.75 + fresh.reduce((sum, row) => sum + Math.abs(Number(row.order_size ?? 0)) * Number(row.fill_price ?? row.order_price ?? memory.lastMid) * Math.max(memory.quantoMultiplier, 1e-12), 0);
        memory.flow.actualLiquidations = Math.max(-1, Math.min(1, fresh.reduce((sum, row) => sum + Number(row.order_size ?? 0), 0) / Math.max(1, gross)));
        memory.lastLiquidationTime = Math.max(memory.lastLiquidationTime, ...rows.map((row) => Number(row.time ?? 0)));
        const incoming = fresh.map((row) => {
          const signed = Number(row.order_size ?? 0);
          const price = Number(row.fill_price ?? row.order_price ?? memory.lastMid);
          const observedAt = Number(row.time ?? 0) < 1e12 ? Number(row.time ?? 0) * 1_000 : Number(row.time ?? 0);
          return { side: signed > 0 ? "LONG" as const : "SHORT" as const, price, notional: Math.abs(signed) * price * Math.max(memory.quantoMultiplier, 1e-12), observedAt };
        }).filter((row) => row.price > 0 && now - row.observedAt <= 120_000);
        const retained = [...memory.recentLiquidations.filter((row) => now - row.observedAt <= 120_000), ...incoming];
        memory.recentLiquidations = [...new Map(retained.map((row) => [`${row.side}:${row.price}:${row.observedAt}`, row])).values()].slice(-100);
        memory.liquidationsUpdatedAt = now;
      } else {
        const rows = result.value.value as Awaited<ReturnType<typeof fetchStructureCandles>>;
        const timeframe = result.value.timeframe!;
        (this.structureCandles[result.value.symbol] ??= {})[timeframe] = rows;
        const key = timeframe === "1m" ? "m1" : timeframe === "15m" ? "m15" : "h1";
        memory.structureByTimeframe[key] = deriveStructureZones(rows, timeframe, memory.lastMid);
        if (timeframe === "15m") memory.range15m = deriveRangeStructure(rows);
        if (timeframe === "1h") {
          const h4 = aggregateFourHourCandles(rows);
          this.structureCandles[result.value.symbol]!["4h"] = h4;
          memory.structureByTimeframe.h4 = deriveStructureZones(h4, "4h", memory.lastMid);
          if (h4.length >= 20) {
            memory.timeframeBias.h4 = structureDirection(memory.structureByTimeframe.h4);
            memory.timeframeUpdatedAt.h4 = (h4.at(-1)!.time + 14_400) * 1_000;
          }
        }
        memory.structureZones = [...memory.structureByTimeframe.m1, ...memory.structureByTimeframe.m15,
          ...memory.structureByTimeframe.h1, ...memory.structureByTimeframe.h4];
        if (rows.length >= 20) {
          memory.timeframeBias[key] = structureDirection(memory.structureByTimeframe[key]);
          const seconds = timeframe === "1m" ? 60 : timeframe === "15m" ? 900 : 3_600;
          memory.timeframeUpdatedAt[key] = (rows.at(-1)!.time + seconds) * 1_000;
          if (timeframe === "1m") {
            memory.lastCompletedMinuteClose = rows.at(-1)!.close;
            memory.lastCompletedMinuteCandle = rows.at(-1)!;
            memory.recentCompletedMinuteCandles = rows.slice(-90).map(({ time, open, high, low, close }) => ({
              time, open, high, low, close,
            }));
            memory.minuteNoiseRate = deriveMinuteNoiseRate(rows);
          }
        }
      }
    }
    return tasks.length;
  }

  private queueTransition(position: PaperPosition | null, priorPosition: PaperPosition | null) {
    const changed = position != null && !(priorPosition?.id === position.id && priorPosition.status === position.status && priorPosition.currentStop === position.currentStop);
    if (!changed) return;
    if (priorPosition?.status === "OPEN" && position.status === "CLOSED") {
      this.runtime.equity = Math.max(0.01, this.runtime.equity + (position.realizedPnl ?? 0));
      this.runtime.paperCycle = recordCycleTrade(this.runtime.paperCycle, position, this.runtime.equity);
    }
    this.runtime.equityVersion += 1;
    this.runtime.outbox = enqueuePositionTransition(this.runtime.outbox, priorPosition, position, this.runtime.equity, this.runtime.equityVersion);
  }

  private async writePosition(item: PositionOutboxItem) {
    const { position } = item;
    const statements = [
      this.env.DB.prepare(`INSERT INTO paper_positions
        (id,symbol,market_state,side,status,entry_at,entry_price,initial_stop,current_stop,current_target,target_identity,planned_risk,notional,exit_at,exit_price,exit_reason,realized_pnl,fees_and_slippage,mirror_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,current_stop=excluded.current_stop,current_target=excluded.current_target,target_identity=excluded.target_identity,exit_at=excluded.exit_at,exit_price=excluded.exit_price,exit_reason=excluded.exit_reason,realized_pnl=excluded.realized_pnl,fees_and_slippage=excluded.fees_and_slippage,mirror_version=excluded.mirror_version WHERE excluded.mirror_version > paper_positions.mirror_version`).bind(
        position.id, position.symbol, position.scenario, position.side, position.status, position.entryAt, position.entryPrice,
        position.initialStop, position.currentStop, position.currentTarget, position.targetIdentity ?? "legacy:none", position.plannedRisk, position.notional,
        position.exitAt ?? null, position.exitPrice ?? null, position.exitReason ?? null, position.realizedPnl ?? null, position.feesAndSlippage ?? null, item.equityVersion,
      ),
      this.env.DB.prepare("UPDATE system_settings SET paper_equity=?,equity_version=?,updated_at=? WHERE id=1 AND equity_version<?")
        .bind(item.equity, item.equityVersion, Date.now(), item.equityVersion),
    ];
    if (position.status === "CLOSED") statements.push(this.env.DB.prepare(`INSERT OR IGNORE INTO paper_events
      (id,symbol,event_type,observed_at,payload_json) VALUES (?,?,?,?,?)`).bind(
      `diagnostic:${position.id}`, position.symbol, "ORDER_CLOSE_DIAGNOSTIC", position.exitAt ?? position.entryAt,
      JSON.stringify(diagnoseClosedPosition(position)),
    ));
    const billedWrites = statements.length;
    if (this.runtime.d1Writes + billedWrites > 4_800) throw new Error("daily D1 write budget reached");
    await this.env.DB.batch(statements);
    this.runtime.d1Writes += billedWrites;
  }

  private async drainOutbox(now: number) {
    if (now < this.runtime.d1RetryAt) return;
    if (this.runtime.d1Writes >= 4_800) {
      this.runtime.d1RetryAt = Date.parse(`${day(now + 86_400_000)}T00:00:02Z`);
      this.runtime.d1MirrorError = "D1 daily mirror redline reached; authority continues in Durable Object";
      return;
    }
    const before = this.runtime.outbox;
    this.runtime.outbox = await drainPositionOutbox(before, (item) => this.writePosition(item));
    if (this.runtime.outbox.length) {
      this.runtime.d1FailureCount = Math.min(5, this.runtime.d1FailureCount + 1);
      this.runtime.d1RetryAt = now + [2_000, 10_000, 30_000, 120_000, 300_000][this.runtime.d1FailureCount - 1];
      this.runtime.d1MirrorError = `D1 mirror pending ${this.runtime.outbox.length} transition(s)`;
    } else {
      this.runtime.d1FailureCount = 0;
      this.runtime.d1RetryAt = 0;
      this.runtime.d1MirrorError = null;
    }
    if (!this.runtime.outbox.length && this.runtime.bankruptcyOutbox.length) {
      while (this.runtime.bankruptcyOutbox.length) {
        const item = this.runtime.bankruptcyOutbox[0];
        if (this.runtime.d1Writes + 2 > 4_800) break;
        try {
          // The checkpoint keeps only a bounded diagnostic tail. Once every
          // position transition has reached D1, rebuild the permanent report
          // from the complete cycle so high-frequency cycles are never cut at
          // MAX_CYCLE_TRADES in Account Logs.
          const diagnostics = await this.env.DB.prepare(`SELECT payload_json AS payload
            FROM paper_events WHERE event_type='ORDER_CLOSE_DIAGNOSTIC'
              AND observed_at>=? AND observed_at<=? ORDER BY observed_at,id`)
            .bind(item.report.startedAt, item.report.endedAt).all<{ payload: string }>();
          const completeTrades = [...new Map((diagnostics.results ?? []).flatMap((row) => {
            try {
              const trade = JSON.parse(row.payload) as ReturnType<typeof diagnoseClosedPosition>;
              return trade?.id ? [[trade.id, trade] as const] : [];
            } catch { return []; }
          })).values()];
          const report = completeTrades.length > item.report.trades.length
            ? buildBankruptcyReport({
              number: item.report.cycleNumber,
              startedAt: item.report.startedAt,
              startingEquity: item.report.startingEquity,
              peakEquity: item.report.endingEquity / Math.max(1 - item.report.maxDrawdownRate, 1e-9),
              trades: completeTrades,
            }, item.report.endedAt, item.report.endingEquity)
            : item.report;
          await this.env.DB.batch([
            this.env.DB.prepare(`INSERT OR IGNORE INTO paper_events
              (id,symbol,event_type,observed_at,payload_json) VALUES (?,?,?,?,?)`).bind(
              report.id, "ACCOUNT", "PAPER_BANKRUPTCY", report.endedAt, JSON.stringify(report),
            ),
            this.env.DB.prepare("UPDATE system_settings SET paper_equity=?,equity_version=?,updated_at=? WHERE id=1 AND equity_version<?")
              .bind(item.equity, item.equityVersion, Date.now(), item.equityVersion),
          ]);
          this.runtime.d1Writes += 2;
          this.runtime.bankruptcyOutbox.shift();
        } catch {
          this.runtime.d1FailureCount = Math.min(5, this.runtime.d1FailureCount + 1);
          this.runtime.d1RetryAt = now + [2_000, 10_000, 30_000, 120_000, 300_000][this.runtime.d1FailureCount - 1];
          this.runtime.d1MirrorError = `D1 bankruptcy log pending ${this.runtime.bankruptcyOutbox.length} record(s)`;
          break;
        }
      }
    }
  }

  protected turnoverStartsAt() { return this.forwardState!.startedAt; }
  protected async turnoverRows(rows:GateConfirmedFill[]) { return rows; }

  protected async gateLive() {
    if (!this.env.OWNER_ACCESS_TOKEN) throw new Error("所有者访问码尚未配置");
    this.liveClient ??= await loadGateLiveClient(this.env.DB, this.env.OWNER_ACCESS_TOKEN);
    this.runtime.live.credentialConfigured = true;
    return this.liveClient;
  }

  protected turnoverStatus() {
    return {version:LIVE_TURNOVER_VERSION,available:!!this.turnoverState?.lastScanAt,
      confirmedFillCount:this.turnoverState?.fills??0,lastScanAt:this.turnoverState?.lastScanAt??null,
      checkedThrough:this.turnoverState?this.turnoverState.through*1000:null,
      catchingUp:turnoverView(this.turnoverState,this.turnoverError,Date.now()).catchingUp,
      hasError:!!this.turnoverError}; // no private quantities or amounts in public status
  }

  protected launchTurnoverWork(now:number) {
    if(this.turnoverWork||now-this.turnoverAttemptAt<60_000||!this.liveClient||!this.forwardState)return;
    this.turnoverAttemptAt=now;
    const work=this.syncTurnover(now).catch(error=>{this.turnoverError=safeError(error);});
    this.turnoverWork=work;
    this.ctx.waitUntil(work.finally(()=>{if(this.turnoverWork===work)this.turnoverWork=null;}));
  }

  private async syncTurnover(now:number) {
    // Independent low-frequency read-only analytics. Its failure MUST NOT
    // block entry, protection, source close, or change requestedEnabled.
    const client=this.liveClient;if(!client||!this.forwardState)return;
    const accountUser=this.turnoverAccountUser;
    const identity=`${client.credentials.environment}:${accountUser??client.credentials.apiKey}`;
    const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(identity));
    const key=[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");
    if(this.liveClient!==client||this.turnoverAccountUser!==accountUser)return;
    if(this.turnoverAccountKey!==key){
      this.turnoverState=null;this.turnoverError=null;
      const saved=await this.ctx.storage.get<TurnoverState>(`${LIVE_TURNOVER_PREFIX}${key}:summary`);
      if(this.liveClient!==client||this.turnoverAccountUser!==accountUser)return;
      this.turnoverState=saved?validateTurnover(saved):initialTurnover(this.turnoverStartsAt(),now);
      this.turnoverAccountKey=key;
      this.turnoverPersisted={accountKey:key,at:saved?.lastScanAt??0};
    }
    // Constructor/member recovery already restored this account's durable
    // summary. The wall clock belongs to that account, never another tenant.
    if(this.turnoverPersisted?.accountKey!==key)
      this.turnoverPersisted={accountKey:key,at:this.turnoverState?.lastScanAt??0};
    const previous=this.turnoverState!;const window=nextFillWindow(previous,now);if(!window)return;
    this.runtime.subrequestCount++;
    const rows=await this.turnoverRows(await client.confirmedFills(window.from,window.to,window.offset));
    if(this.liveClient!==client||this.turnoverAccountUser!==accountUser||this.turnoverAccountKey!==key)return;
    const multipliers=Object.fromEntries([...this.contractCatalog].map(([symbol,m])=>[symbol,m.quantoMultiplier]));
    for(const [symbol,m]of Object.entries(this.runtime.contractMeta))multipliers[symbol]=m.quantoMultiplier;
    const prepared=await prepareTurnoverPage({state:previous,window,rows,accountKey:key,storage:this.ctx.storage,multipliers,now});
    if(this.liveClient!==client||this.turnoverAccountUser!==accountUser||this.turnoverAccountKey!==key||this.turnoverState!==previous)return;
    // Only an unchanged-money, non-paginated scan may advance in memory. Every
    // new fill/dedupe bucket and every pending-page transition remains atomic
    // and immediate. A restart merely rescans the last <=5min of read attempts;
    // already-persisted fill IDs still dedupe, with no invented/lost turnover.
    const persist=prepared.newFills>0||prepared.writes>1||previous.pending!==null||prepared.state.pending!==null
      ||!this.turnoverPersisted.at||now-this.turnoverPersisted.at>=300_000;
    if(persist){
      const reservation=this.reserveNonAlarmWrites(prepared.writes,256);
      if(!reservation)throw new Error("成交额保存等待资源预算，已核对金额保留；交易保护优先");
      try {await this.ctx.storage.transaction(async tx=>{await tx.put(prepared.entries);});reservation.finish(true);}
      finally {reservation.finish(false);}
    }
    if(this.liveClient===client&&this.turnoverAccountUser===accountUser&&this.turnoverAccountKey===key){
      if(persist)this.turnoverPersisted={accountKey:key,at:now};
      this.turnoverState=prepared.state;this.turnoverError=null;this.runtime.live.turnoverAccountKey=key;
    }
  }

  protected activeLivePositions() {
    return Object.values(this.runtime.live.positions).filter((position): position is LivePosition => position?.status === "OPEN");
  }

  protected activeLiveEntries() {
    return Object.values(this.runtime.live.entries).filter((entry): entry is LiveEntry => Boolean(entry && !["FILLED", "CANCELLED"].includes(entry.status)));
  }

  private async replaceLiveCredentials(raw: GateCredentials) {
    if (this.runtime.live.requestedEnabled) throw new Error("请先关闭实盘开关，再更换 API");
    const credentials = normalizeGateCredentials(raw);
    if (credentials.environment !== "live") throw new Error("这里只接受 Gate 实盘 API");
    const candidate = new GateLiveClient(credentials);
    const snapshot = await candidate.snapshot();
    const equity = gateMarkedEquity(snapshot);
    const available = Number(snapshot.account.available);
    if (snapshot.account.total == null || snapshot.account.available == null || !Number.isFinite(equity) || equity < 0 || !Number.isFinite(available) || available < 0) {
      throw new Error("Gate 合约账户权益不可用");
    }
    if (snapshot.account.in_dual_mode === true || ["dual", "dual_plus"].includes(String(snapshot.account.position_mode ?? "").toLowerCase())) {
      throw new Error("Gate 当前不是单向持仓模式");
    }

    const positions = this.activeLivePositions();
    const entries = this.activeLiveEntries();
    const existing = await this.env.DB.prepare("SELECT gate_user_id FROM live_exchange_credentials WHERE id=1 LIMIT 1").first<{ gate_user_id: string | null }>();
    const gateUserId = snapshot.account.user == null ? null : String(snapshot.account.user);
    if ((positions.length || entries.length) && existing?.gate_user_id && gateUserId && existing.gate_user_id !== gateUserId) {
      throw new Error("新 API 不属于当前持仓账户，已拒绝替换");
    }
    for (const position of positions) {
      const actual = snapshot.positions.find((row) => row.contract === position.symbol && Number(row.size ?? 0) !== 0);
      const side = Number(actual?.size ?? 0) > 0 ? "LONG" : "SHORT";
      if (!actual || side !== position.side) throw new Error(`${position.symbol} 未在新 API 账户中找到，已拒绝替换`);
    }
    const exchangeOrders = [...snapshot.orders, ...snapshot.priceOrders];
    for (const entry of entries) {
      if (exchangeOrders.some((order) => liveOrderTag(order) === entry.tag)) continue;
      if (entry.status === "ERROR") { entry.status = "CANCELLED"; continue; }
      throw new Error(`${entry.symbol} 未决挂单无法由新 API 接管`);
    }

    const encrypted = await encryptGateCredentials(credentials, this.env.OWNER_ACCESS_TOKEN ?? "");
    const now = Date.now();
    const resolvedGateUserId = gateUserId ?? existing?.gate_user_id ?? null;
    const permissions = JSON.stringify({ futuresRead: true, futuresTrade: "requiredOnEnable", positionMode: "single", verifiedAt: now });
    await this.env.DB.prepare(`INSERT INTO live_exchange_credentials
      (id,exchange,environment,ciphertext,iv,crypto_version,key_hint,gate_user_id,owner_account_id,permission_summary_json,status,last_verified_at,last_error,created_at,updated_at)
      VALUES (1,'gate','live',?,?,?,?,?,?,NULL,?,'verified',?,NULL,?,?)
      ON CONFLICT(id) DO UPDATE SET exchange=excluded.exchange,environment=excluded.environment,ciphertext=excluded.ciphertext,iv=excluded.iv,
      crypto_version=excluded.crypto_version,key_hint=excluded.key_hint,gate_user_id=excluded.gate_user_id,owner_account_id=NULL,
      permission_summary_json=excluded.permission_summary_json,status='verified',last_verified_at=excluded.last_verified_at,last_error=NULL,updated_at=excluded.updated_at`)
      .bind(encrypted.ciphertext, encrypted.iv, encrypted.cryptoVersion, gateKeyHint(credentials.apiKey), resolvedGateUserId, permissions, now, now, now).run();
    this.liveClient = candidate;
    this.turnoverAccountUser=resolvedGateUserId;this.turnoverState=null;this.turnoverAccountKey=null;this.turnoverError=null;
    delete this.runtime.live.turnoverAccountKey;
    this.runtime.live.credentialConfigured = true;
    this.runtime.live.equity = equity;
    this.runtime.live.available = available;
    this.runtime.live.lastSyncAt = now;
    this.runtime.live.lastError = null;
    if (positions.length || entries.length) await this.syncLive(now);
    await this.saveCheckpoint(now, true);
    return { ok: true, credential: await credentialMetadata(this.env.DB), verification: {
      equity, available, positions: snapshot.positions.filter((position) => Number(position.size ?? 0) !== 0).length,
      orders: snapshot.orders.length, conditionalOrders: snapshot.priceOrders.length, checkedAt: now,
    } };
  }

  private async deleteLiveCredentials() {
    if (this.runtime.live.requestedEnabled) throw new Error("请先关闭实盘开关，再删除 API");
    if (this.activeLivePositions().length) throw new Error("仍有实盘持仓，不能删除管理它的 API");
    if (this.activeLiveEntries().length) throw new Error("仍有未决实盘挂单，不能删除 API");
    const snapshot = await (await this.gateLive()).snapshot();
    if (snapshot.positions.some((position) => Number(position.size ?? 0) !== 0)
      || snapshot.orders.length > 0 || snapshot.priceOrders.length > 0) {
      throw new Error("Gate 仍有持仓或挂单；请先清空后再删除 API");
    }
    await this.env.DB.prepare("DELETE FROM live_exchange_credentials WHERE id=1").run();
    this.liveClient = null;
    this.turnoverAccountUser=null;this.turnoverState=null;this.turnoverAccountKey=null;this.turnoverError=null;
    delete this.runtime.live.turnoverAccountKey;
    this.runtime.live.credentialConfigured = false;
    this.runtime.live.equity = null;
    this.runtime.live.available = null;
    this.runtime.live.lastSyncAt = null;
    this.runtime.live.lastError = null;
    await this.saveCheckpoint(Date.now(), true);
    return { ok: true, credential: await credentialMetadata(this.env.DB) };
  }

  private async resetPaperAccount() {
    const now=Date.now();let stage="检查实盘状态";
    try{
      if(this.runtime.live.requestedEnabled||this.runtime.live.operational
        ||Object.values(this.runtime.live.positions).some(position=>position?.status==="OPEN")
        ||Object.values(this.runtime.live.entries).some(entry=>entry&& !["FILLED","CANCELLED"].includes(entry.status)))
        throw new Error("请先关闭实盘并确认 Gate 没有本系统持仓或待成交订单");

      stage="读取当前模拟账户";
      if(!this.forwardState)this.forwardState=await readForwardStore(this.ctx.storage,now);
      const previous=this.forwardState;if(!previous)throw new Error("模拟账户尚未恢复");

      stage="封存旧账户";
      // Manual reset abandons the old PAPER ledger. Fresh executable prices are
      // preferred, but a missing quote must never make account maintenance
      // impossible; closeForwardForReset safely falls back to the last saved mark.
      const closed=closeForwardForReset(previous,this.regimeQuotes(now),now);
      const next=resetForwardAccountPreservingLearning(previous,now);

      stage="准备新账户";
      const prepared=await prepareForwardReset(previous,closed,next,now);
      const saved=await this.ctx.storage.get<{writeBudget?:unknown}>(FORWARD_PROTECTION_STORAGE);
      const protection=prepared.accountEntries[FORWARD_PROTECTION_STORAGE] as Record<string,unknown>|undefined;
      if(protection&&saved?.writeBudget!==undefined)
        prepared.accountEntries[FORWARD_PROTECTION_STORAGE]={...protection,writeBudget:saved.writeBudget};

      const reservation=this.reserveNonAlarmWrites(prepared.writes,64);
      if(!reservation)throw new Error("模拟账户重置等待写入预算；当前账户保持完整");
      stage="原子写入重置账户";
      try{
        await this.ctx.storage.transaction(async transaction=>{
          for(const[key,value]of Object.entries(prepared.archiveEntries))await transaction.put(key,value);
          await transaction.put(prepared.accountEntries);
        });
        reservation.finish(true);
      }finally{reservation.finish(false);}

      this.forwardCompression=prepared.compression;this.forwardState=prepared.state;this.forwardError=null;
      this.forwardProtectionBudget=readProtectionWriteBudget(saved?.writeBudget);this.mirrorClosures.clear();
      return{ok:true,equity:1000,forward:forwardSummary(this.forwardState,this.regimeQuotes(now),now)};
    }catch(error){
      const raw=safeError(error),friendly=/The string did not match the expected pattern/i.test(raw)
        ?"底层存储参数校验失败；原账户保持不变":raw;
      throw new Error(`模拟账户重置失败（${stage}）：${friendly}`);
    }
  }

  private async clearPaperHistory() {
    const now = Date.now();
    const authorityBefore = this.captureAuthority();
    try {
      this.runtime.positions = Object.fromEntries(Object.entries(this.runtime.positions)
        .map(([symbol, position]) => [symbol, position?.status === "OPEN" ? position : null]));
      this.runtime.outbox = this.runtime.outbox.filter((item) => item.position.status === "OPEN");
      this.runtime.bankruptcyOutbox = [];
      this.runtime.paperCycle = startPaperCycle(now, this.runtime.equity, this.runtime.paperCycle.number + 1);
      await this.saveCheckpoint(now, true);
      this.publishAuthority();
    } catch (error) {
      this.restoreAuthority(authorityBefore);
      this.publishAuthority();
      throw error;
    }
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM paper_events").bind(),
      this.env.DB.prepare("DELETE FROM paper_positions WHERE status='CLOSED'").bind(),
    ]);
    this.runtime.d1Writes += 2;
    return { ok: true, paperCycle: paperCycleSummary(this.runtime.paperCycle, this.runtime.equity) };
  }

  private recordLiveAudit(input: Omit<LiveAuditEvent, "id" | "gateLabel"> & { error?: unknown; gateLabel?: string | null }) {
    const event: LiveAuditEvent = {
      id: `live:${input.observedAt}:${input.stage}:${input.symbol ?? "ACCOUNT"}:${input.planId ?? "none"}`,
      observedAt: input.observedAt,
      symbol: input.symbol,
      planId: input.planId,
      stage: input.stage,
      level: input.level,
      reason: input.reason.slice(0, 240),
      gateLabel: input.gateLabel ?? gateLabelFromError(input.error),
    };
    const existing = this.runtime.live.auditEvents.findIndex((row) => row.id === event.id);
    if (existing >= 0) this.runtime.live.auditEvents[existing] = event;
    else this.runtime.live.auditEvents.push(event);
    this.runtime.live.auditEvents = this.runtime.live.auditEvents.slice(-100);
  }

  private liveSessionSeedRatio() {
    const activation=this.runtime.live.activation;
    if(!activation)return null;
    const receipts=[
      ...Object.values(this.runtime.live.positions).flatMap(p=>p?.parity?[p.parity]:[]),
      ...Object.values(this.runtime.live.entries).flatMap(e=>e?.parity?[e.parity]:[]),
      ...this.liveHistory.flatMap(p=>p.parity?[p.parity]:[]),
    ].filter(r=>r.activationAt===activation.enabledAt&&Number.isFinite(r.ratio)&&r.ratio>0)
      .sort((a,b)=>a.copiedAt-b.copiedAt);
    return receipts[0]?.ratio??null;
  }

  private async ensureLiveSessionScale(sourceEquity:number,liveEquity:number,now:number) {
    const activation=this.runtime.live.activation;
    if(!activation)return activation;
    const scaled=activation.scaleRatio
      ?reconcileLiveScale(activation,sourceEquity,liveEquity,now)
      :establishLiveScale(activation,sourceEquity,liveEquity,now,this.liveSessionSeedRatio()??undefined);
    if(scaled===activation)return activation;
    const prior=activation.scaleRatio??null;
    const reservation=this.reserveNonAlarmWrites(1);
    if(!reservation)throw new Error("实盘比例保存预算不足，保留原比例");
    this.runtime.live.activation=scaled;
    try {
      await this.ctx.storage.put(`${LIVE_PARITY_PREFIX}owner-intent`,{
        enabled:this.runtime.live.requestedEnabled,changedAt:this.runtime.live.changedAt,activation:scaled,
      });
      reservation.finish(true);
    } finally {reservation.finish(false);}
    if(prior&&scaled.scaleRatio!==prior)this.recordLiveAudit({observedAt:now,symbol:null,planId:null,stage:"LIVE_CONTROL",level:"INFO",
      reason:`检测到旧复制比例与当前实盘资本基准明显不一致；仅将以后新源单比例从 ${prior.toFixed(6)} 重建为 ${scaled.scaleRatio!.toFixed(6)}，已有实盘仓位不补仓不改仓`});
    await this.saveCheckpoint(now,true);
    return scaled;
  }

  private liveEntryAwaitingReconcile(entry: LiveEntry | null | undefined) {
    if(!entry?.parity || entry.marketSubmittedAt == null) return false;
    if(this.runtime.live.positions[entry.symbol]?.id === entry.planId) return false;
    return entry.status === "FILLED" || (entry.status === "CANCELLED" && !entry.submissionResolved);
  }

  protected liveNeedsSync() {
    return this.runtime.live.requestedEnabled
      || Object.values(this.runtime.live.entries).some(entry => entry &&
        (!["FILLED","CANCELLED"].includes(entry.status) || this.liveEntryAwaitingReconcile(entry)))
      || Object.values(this.runtime.live.positions).some(position => position?.status === "OPEN");
  }

  private liveOpenRisk() {
    const now=Date.now();
    const positionRisk = Object.values(this.runtime.live.positions).reduce((sum, position) => {
      if(position?.status!=="OPEN")return sum;
      if(!position.parity)return sum+remainingStressRisk(position,this.runtime.evidence[position.symbol]?.midpoint??position.entryPrice);
      const q=this.runtime.evidence[position.symbol],at=position.exchangePnlAt;
      // Gate's current position mark survives loss of the source's public-book
      // slot. A stale public midpoint must never override that actual mark.
      const mark=position.exchangeMarkPrice!=null&&Number.isFinite(position.exchangeMarkPrice)&&position.exchangeMarkPrice>0
        &&at!=null&&at<=now+1000&&now-at<=30_000 ? position.exchangeMarkPrice
        :q&&freshQuote({bestBid:q.bestBid??0,bestAsk:q.bestAsk??0,observedAt:q.observedAt,fresh:q.fresh},now)
          ?((q.bestBid??0)+(q.bestAsk??0))/2:NaN;
      return sum+mirrorPositionRisk(position,mark);
    }, 0);
    const pendingRisk = Object.values(this.runtime.live.entries).reduce((sum, entry) => sum + (entry && ["SUBMITTING", "OPEN", "ERROR"].includes(entry.status)
      ? entry.plannedRisk : 0), 0);
    return positionRisk + pendingRisk;
  }

  private liveDirectionalRisk(side: Side) {
    const now=Date.now();
    const positionRisk = Object.values(this.runtime.live.positions).reduce((sum, position) => {
      if(position?.status!=="OPEN"||position.side!==side)return sum;
      if(!position.parity)return sum+remainingStressRisk(position,this.runtime.evidence[position.symbol]?.midpoint??position.entryPrice);
      const q=this.runtime.evidence[position.symbol],at=position.exchangePnlAt;
      const mark=position.exchangeMarkPrice!=null&&Number.isFinite(position.exchangeMarkPrice)&&position.exchangeMarkPrice>0
        &&at!=null&&at<=now+1000&&now-at<=30_000 ? position.exchangeMarkPrice
        :q&&freshQuote({bestBid:q.bestBid??0,bestAsk:q.bestAsk??0,observedAt:q.observedAt,fresh:q.fresh},now)
          ?((q.bestBid??0)+(q.bestAsk??0))/2:NaN;
      return sum+mirrorPositionRisk(position,mark);
    }, 0);
    const pendingRisk = Object.values(this.runtime.live.entries).reduce((sum, entry) => sum + (entry && entry.side === side
      && ["SUBMITTING", "OPEN", "ERROR"].includes(entry.status) ? entry.plannedRisk : 0), 0);
    return positionRisk + pendingRisk;
  }

  private async cancelLiveEntry(client: GateLiveClient, entry: LiveEntry) {
    if (entry.status === "FILLED" || entry.status === "CANCELLED") return;
    if (entry.exchangeOrderId) await client.cancelOrder(entry.kind, entry.exchangeOrderId);
    if (entry.stopOrderId) await client.cancelOrder("PRICE_TRIGGER", entry.stopOrderId);
    entry.status = "CANCELLED";
    entry.stopOrderId = null;
    entry.stopTag = null;
    entry.stopPrice = null;
    entry.stopSubmittingAt = null;
    entry.lastError = null;
  }

  private liveEntryStopIntent(entry: LiveEntry) {
    const tick = this.runtime.tickSize[entry.symbol] ?? entry.invalidation * 1e-8;
    return buildLiveStopIntent({ id: entry.planId, symbol: entry.symbol, side: entry.side,
      currentStop: entry.invalidation }, tick);
  }

  private async createImmediateLiveStop(client: GateLiveClient, entry: LiveEntry) {
    const stop = this.liveEntryStopIntent(entry);
    entry.stopTag = stop.tag;
    entry.stopPrice = stop.price;
    entry.stopSubmittingAt = Date.now();
    try {
      entry.stopOrderId = await client.createStop(stop);
      entry.stopSubmittingAt = null;
      this.recordLiveAudit({ observedAt: Date.now(), symbol: entry.symbol, planId: entry.planId,
        stage: "STOP_CREATE", level: "INFO",
        reason: `Gate 确认入场后已在同一次执行中提交原生减仓止损 ${stop.price}` });
    } catch (error) {
      if (!definitiveGateRejection(error)) {
        entry.lastError = `原生止损提交结果暂不明确，正在按标签核对：${safeError(error)}`;
        this.recordLiveAudit({ observedAt: Date.now(), symbol: entry.symbol, planId: entry.planId,
          stage: "STOP_CREATE", level: "RECOVERING",
          reason: `${entry.lastError}；不重复挂单，6秒内不能确认则退出`, error });
        return;
      }
      const failedAt = Date.now();
      entry.protectionExitRequestedAt = failedAt;
      entry.stopSubmittingAt = null;
      entry.status = "ERROR";
      entry.lastError = `原生止损挂单失败，系统已请求市价退出：${safeError(error)}`;
      this.recordLiveAudit({ observedAt: failedAt, symbol: entry.symbol, planId: entry.planId,
        stage: "STOP_CREATE", level: "FORCED_EXIT", reason: entry.lastError, error });
      await client.closePosition(entry.symbol, liveExitTag(entry.planId));
    }
  }

  private async ensureLiveStop(client: GateLiveClient, position: LivePosition, openPriceOrders: Awaited<ReturnType<GateLiveClient["snapshot"]>>["priceOrders"]) {
    const existing = position.stopTag ? openPriceOrders.find((order) => liveOrderTag(order) === position.stopTag) : null;
    if (existing) {
      position.stopOrderId = liveOrderId(existing) ?? position.stopOrderId;
      position.stopSubmittingAt = null;
    } else if (position.stopOrderId) {
      position.stopOrderId = null;
      position.stopTag = null;
      position.stopPrice = null;
      position.stopSubmittingAt = null;
    }
    const tick = this.runtime.tickSize[position.symbol] ?? position.currentStop * 1e-8;
    const stop = buildLiveStopIntent(position, tick);
    if (position.stopOrderId && position.stopPrice != null && Math.abs(position.stopPrice - stop.price) < tick * 0.5) return;
    if (position.stopOrderId) {
      try {
        await client.amendStop(position.stopOrderId, stop.price);
        position.stopPrice = stop.price;
        return;
      } catch (error) {
        if (!definitiveGateRejection(error)) {
          this.recordLiveAudit({ observedAt: Date.now(), symbol: position.symbol, planId: position.id,
            stage: "STOP_UPDATE", level: "RECOVERING",
            reason: `结构止损更新结果暂不明确，原保护单保持有效并等待下一轮核对：${safeError(error)}`, error });
          throw new Error(`结构止损更新结果暂不明确，保留原保护并核对：${safeError(error)}`);
        }
        const failedAt = Date.now();
        this.recordLiveAudit({ observedAt: failedAt, symbol: position.symbol, planId: position.id,
          stage: "STOP_UPDATE", level: "FORCED_EXIT",
          reason: `结构止损更新失败，系统已请求市价退出：${safeError(error)}`, error });
        if (!position.exitRequestedAt) {
          position.exitRequestedAt = failedAt;
          position.exitReason = "PROTECTIVE_STOP_UPDATE_FAILED";
          await client.closePosition(position.symbol, liveExitTag(position.id));
        }
        throw new Error(`结构止损更新失败，已请求市价退出：${safeError(error)}`);
      }
    }
    if (position.stopTag && position.stopSubmittingAt) {
      if (Date.now() - position.stopSubmittingAt < 6_000) return;
      const failedAt = Date.now();
      this.recordLiveAudit({ observedAt: failedAt, symbol: position.symbol, planId: position.id,
        stage: "STOP_CREATE", level: "FORCED_EXIT",
        reason: `Gate 在止损提交后6秒内仍未返回带标签 ${position.stopTag} 的保护单，已请求市价退出` });
      if (!position.exitRequestedAt) {
        position.exitRequestedAt = failedAt;
        position.exitReason = "PROTECTIVE_STOP_CREATE_UNCONFIRMED";
        await client.closePosition(position.symbol, liveExitTag(position.id));
      }
      throw new Error("结构止损提交6秒后仍未确认，已请求市价退出");
    }
    position.stopTag = stop.tag;
    position.stopPrice = stop.price;
    position.stopSubmittingAt = Date.now();
    await this.saveCheckpoint(Date.now(), true);
    try {
      const nextStopId = await client.createStop(stop);
      position.stopOrderId = nextStopId;
      position.stopSubmittingAt = null;
    } catch (error) {
      if (!definitiveGateRejection(error)) {
        this.recordLiveAudit({ observedAt: Date.now(), symbol: position.symbol, planId: position.id,
          stage: "STOP_CREATE", level: "RECOVERING",
          reason: `结构止损提交结果暂不明确；保留标签并核对6秒，不重复挂单也不立即误平仓：${safeError(error)}`, error });
        throw new Error(`结构止损提交结果暂不明确，正在按标签核对：${safeError(error)}`);
      }
      const failedAt = Date.now();
      this.recordLiveAudit({ observedAt: failedAt, symbol: position.symbol, planId: position.id,
        stage: "STOP_CREATE", level: "FORCED_EXIT",
        reason: `结构止损挂单失败，系统已请求市价退出：${safeError(error)}`, error });
      if (!position.exitRequestedAt) {
        position.exitRequestedAt = failedAt;
        position.exitReason = "PROTECTIVE_STOP_CREATE_FAILED";
        await client.closePosition(position.symbol, liveExitTag(position.id));
      }
      throw new Error(`结构止损挂单失败，已请求市价退出：${safeError(error)}`);
    }
  }

  private systemEntryOrders(snapshot: GateLiveSnapshot, trackedIds: Set<string>) {
    const systemEntry = (order: GateLiveOrder) => {
      const tag = liveOrderTag(order) ?? "";
      const id = liveOrderId(order);
      return tag.startsWith("t-ms-e-") || Boolean(id && trackedIds.has(id));
    };
    return [
      ...snapshot.orders.filter(systemEntry).map((order) => ({ kind: "LIMIT" as const, order })),
      ...snapshot.priceOrders.filter(systemEntry).map((order) => ({ kind: "PRICE_TRIGGER" as const, order })),
    ];
  }

  private async cancelAndConfirmSystemEntries(client: GateLiveClient, snapshot: GateLiveSnapshot, trackedIds: Set<string>, knownTags?: Set<string>) {
    let current = snapshot;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const candidates = this.systemEntryOrders(current, trackedIds).filter(({ order }) => {
        if (!knownTags) return true;
        const tag = liveOrderTag(order) ?? "";
        return tag.startsWith("t-ms-e-") && !knownTags.has(tag);
      });
      if (!candidates.length) return current;
      const unresolvedId = candidates.find(({ order }) => !liveOrderId(order));
      if (unresolvedId) throw new Error("Gate 返回了无法识别编号的系统挂单，撤单未确认");
      await Promise.all(candidates.map(({ kind, order }) => client.cancelOrder(kind, liveOrderId(order)!)));
      current = await client.snapshot();
    }
    const remaining = this.systemEntryOrders(current, trackedIds).filter(({ order }) => {
      if (!knownTags) return true;
      const tag = liveOrderTag(order) ?? "";
      return tag.startsWith("t-ms-e-") && !knownTags.has(tag);
    });
    if (remaining.length) throw new Error(`Gate 仍有 ${remaining.length} 张系统挂单未撤销，实盘保持关闭`);
    return current;
  }

  private launchLiveWork(sourceChanged=false) {
    if(!this.liveNeedsSync())return;
    const requestedAt=Date.now();
    if(sourceChanged){
      this.liveSourcePending=true;this.liveFastSourcePending=true;this.liveExecution.sourceWakeups++;
    }else if(requestedAt<this.liveNextReconcileAt)return;
    if(this.liveBackgroundWork)return;
    const task=(async()=>{
      do{
        const preferCached=this.liveFastSourcePending;
        this.liveFastSourcePending=false;this.liveSourcePending=false;this.liveSyncUsedCached=false;
        const started=Date.now(),requestsBefore=this.liveClient?.requestCount??0;
        this.liveExecution.startedAt=started;this.liveExecution.cycles++;
        try{
          this.livePreferCachedNext=preferCached;
          await this.syncLive(started);
          // If a committed PAPER source was handled from a very recent verified
          // Gate snapshot, immediately follow with one network reconciliation.
          // This removes the pre-submit private-read delay without pretending the
          // cache is exchange confirmation.
          if(preferCached&&this.liveSyncUsedCached)this.liveSourcePending=true;
        }
        catch(error){
          const message=safeError(error),blocked=liveFailureRequiresOff(error);
          const shouldRecord=this.runtime.live.lastError!==message||this.runtime.live.operational;
          this.runtime.live.operational=false;this.runtime.live.lastError=message;
          if(shouldRecord)this.recordLiveAudit({observedAt:Date.now(),symbol:null,planId:null,
            stage:"LIVE_CONTROL",level:"RECOVERING",reason:blocked
              ?`账户纳管冲突，执行暂停但不改写所有者开关：${message}`
              :`实盘核对暂时失败，所有者开关选择保持不变：${message}`,error});
        }finally{
          this.liveExecution.finishedAt=Date.now();
          this.liveExecution.lastDurationMs=Date.now()-started;
          this.runtime.subrequestCount+=Math.max(0,(this.liveClient?.requestCount??requestsBefore)-requestsBefore);
        }
      }while(this.liveSourcePending&&this.liveNeedsSync());
      const active=Object.values(this.runtime.live.positions).some(p=>p?.status==="OPEN")
        ||Object.values(this.runtime.live.entries).some(e=>e&&!["FILLED","CANCELLED"].includes(e.status));
      this.liveNextReconcileAt=Date.now()+(active?LIVE_RECONCILE_ACTIVE_MS:LIVE_RECONCILE_IDLE_MS);
    })();
    this.liveBackgroundWork=task;
    this.ctx.waitUntil(task.finally(()=>{if(this.liveBackgroundWork===task)this.liveBackgroundWork=null;}));
  }

  protected async syncLive(now:number,initialEnable=false,forceEntryCleanup=false) {
    while(this.liveSyncWork){
      if(!initialEnable&&!forceEntryCleanup)return this.liveSyncWork;
      await this.liveSyncWork.catch(()=>undefined);
    }
    const work=this.syncLiveOnce(Date.now(),initialEnable,forceEntryCleanup);
    this.liveSyncWork=work;
    try {
      await work;
      this.liveReadTimeoutStreak=0;
    } catch(error) {
      // Background read-only Gate latency is retryable because no exchange
      // mutation crossed the network boundary. Owner actions and forced OFF
      // cleanup stay strict and receive the error immediately.
      if(!initialEnable&&!forceEntryCleanup&&isGateReadTimeoutError(error)){
        const decision=liveReadTimeoutDecision(this.liveReadTimeoutStreak);
        this.liveReadTimeoutStreak=decision.streak;
        if(!decision.escalated){
          if(isTransientLiveReadErrorText(this.runtime.live.lastError))this.runtime.live.lastError=null;
          return;
        }
        throw new Error(decision.message!);
      }
      this.liveReadTimeoutStreak=0;
      throw error;
    } finally { if(this.liveSyncWork===work)this.liveSyncWork=null; }
  }

  private async syncLiveOnce(now: number, initialEnable = false, forceEntryCleanup = false) {
    const preferCached=this.livePreferCachedNext&&!initialEnable&&!forceEntryCleanup;
    this.livePreferCachedNext=false;
    // Owner actions and optional hourly evaluation can arrive between two book
    // loops. Reconcile first so LIVE can never observe an unregistered source leg.
    this.reconcileCanonicalMirror(now);
    const activePositions = Object.values(this.runtime.live.positions).some((position) => position?.status === "OPEN");
    const activeEntries = Object.values(this.runtime.live.entries).some((entry) => entry &&
      (!["FILLED", "CANCELLED"].includes(entry.status) || this.liveEntryAwaitingReconcile(entry)));
    if (!this.runtime.live.requestedEnabled && !activePositions && !activeEntries && !initialEnable && !forceEntryCleanup) return;
    // A missing source blocks additions, not the owner's OFF cleanup or native
    // protection of an already-mapped position.
    const client = await this.gateLive();
    const unresolvedEntry=Object.values(this.runtime.live.entries).some(entry=>entry
      &&(!["FILLED","CANCELLED"].includes(entry.status)||this.liveEntryAwaitingReconcile(entry)));
    const needsProtectionOrderLane=activePositions||Object.values(this.runtime.live.entries).some(entry=>entry
      &&entry.stopSubmittingAt&& !entry.stopOrderId && !["FILLED","CANCELLED"].includes(entry.status));
    const cached=preferCached&&this.runtime.live.operational&&!unresolvedEntry&&this.liveSnapshotCache
      &&now-this.liveSnapshotCache.checkedAt<=LIVE_FAST_SNAPSHOT_MAX_AGE_MS
      ?structuredClone(this.liveSnapshotCache):null;
    let snapshot:GateLiveSnapshot;
    let orderAuditUsable=true;
    const splitPrivateReads=typeof client.snapshotCore==="function"&&typeof client.snapshotOrders==="function";
    if(cached){
      snapshot=cached;this.liveSyncUsedCached=true;
    }else if(!splitPrivateReads||initialEnable||forceEntryCleanup||needsProtectionOrderLane){
      // Test doubles and legacy/member executors may still expose only the
      // reviewed full-snapshot contract. Keep that compatibility path exact;
      // production GateLiveClient uses the split lanes below.
      snapshot=await client.snapshot();this.liveSyncUsedCached=false;
      this.liveOrderSnapshotCache={orders:structuredClone(snapshot.orders),priceOrders:structuredClone(snapshot.priceOrders),checkedAt:snapshot.checkedAt};
      this.liveOrderAuditAt=snapshot.checkedAt;
      this.liveSnapshotCache=structuredClone(snapshot);
    }else{
      // Routine short-horizon LIVE reconciliation only needs fresh account and
      // position truth. Open-order list latency is a separate audit lane: one
      // slow optional endpoint must never make fresh account/positions appear
      // offline or create an escalating "account timeout" loop.
      const core=await client.snapshotCore();this.liveSyncUsedCached=false;
      if(!this.liveOrderAuditAt&&this.runtime.live.lastSyncAt)this.liveOrderAuditAt=this.runtime.live.lastSyncAt;
      let orders=this.liveOrderSnapshotCache;
      if(!orders||now-orders.checkedAt>LIVE_ORDER_AUDIT_MAX_AGE_MS){
        try{
          orders=await client.snapshotOrders();
          this.liveOrderSnapshotCache=structuredClone(orders);this.liveOrderAuditAt=orders.checkedAt;
        }catch(error){
          if(!isGateReadTimeoutError(error))throw error;
          orderAuditUsable=false;
        }
      }
      const inheritedAuditAt=orders?.checkedAt??this.liveOrderAuditAt;
      orderAuditUsable=inheritedAuditAt>0&&now-inheritedAuditAt<=LIVE_ORDER_AUDIT_ADMISSION_MAX_AGE_MS;
      snapshot={account:core.account,positions:core.positions,orders:orders?.orders??[],priceOrders:orders?.priceOrders??[],checkedAt:core.checkedAt};
      this.liveSnapshotCache=structuredClone(snapshot);
    }
    // The committed PAPER account can advance while private reads are in flight.
    // Select sources after the read, never from a pre-await portfolio snapshot.
    now=Date.now();this.reconcileCanonicalMirror(now);
    let sourceError=this.liveBindingError??this.forwardError;
    let desiredPortfolio:Record<string,MirrorSourceTrade>={};
    try{desiredPortfolio=this.liveDesiredPortfolio(now);}
    catch(error){sourceError=safeError(error);}
    this.turnoverAccountUser=snapshot.account.user==null?null:String(snapshot.account.user);
    const knownTags = new Set([
      ...Object.values(this.runtime.live.entries).flatMap((entry) => entry && !["FILLED", "CANCELLED"].includes(entry.status)
        ? [entry.tag, entry.stopTag ?? this.liveEntryStopIntent(entry).tag] : []),
      ...Object.values(this.runtime.live.positions).flatMap((position) => position?.status === "OPEN" && position.stopTag ? [position.stopTag] : []),
    ]);
    const trackedEntryIds = new Set(Object.values(this.runtime.live.entries)
      .flatMap((entry) => entry?.exchangeOrderId ? [entry.exchangeOrderId] : []));
    snapshot = forceEntryCleanup
      ? await this.cancelAndConfirmSystemEntries(client, snapshot, trackedEntryIds)
      : orderAuditUsable?await this.cancelAndConfirmSystemEntries(client, snapshot, trackedEntryIds, knownTags):snapshot;
    if(!cached||snapshot.checkedAt!==cached.checkedAt)this.liveSnapshotCache=structuredClone(snapshot);
    if (forceEntryCleanup) {
      for (const entry of Object.values(this.runtime.live.entries)) {
        if (!entry || ["FILLED", "CANCELLED"].includes(entry.status)) continue;
        const actual=snapshot.positions.find(p=>p.contract===entry.symbol&&Number(p.size??0)!==0
          &&Math.sign(Number(p.size))===(entry.side==="LONG"?1:-1));
        entry.status = actual?"FILLED":"CANCELLED";
        entry.missingSince = null;
        entry.lastError = null;
      }
    }
    let accountError:string|null=null,equity=0;
    try { equity=gateMarkedEquity(snapshot); }catch(error){accountError=safeError(error);}
    const available = Number(snapshot.account.available ?? 0);
    if (!(equity > 0) || !(available >= 0)||!Number.isFinite(available))accountError??="Gate 合约账户权益不可用";
    if (snapshot.account.in_dual_mode === true || ["dual", "dual_plus"].includes(String(snapshot.account.position_mode ?? "").toLowerCase())) {
      throw new Error("Gate 当前不是单向持仓模式");
    }
    this.runtime.live.equity = accountError?null:equity;
    this.runtime.live.available = available;
    this.runtime.live.lastSyncAt = snapshot.checkedAt;

    const exchangeOrders = orderAuditUsable?[...snapshot.orders, ...snapshot.priceOrders]:[];
    const unknownOrders = orderAuditUsable?exchangeOrders.filter((order) => !knownTags.has(liveOrderTag(order) ?? "")):[];
    const actualPositions = snapshot.positions.filter((position) => Number(position.size ?? 0) !== 0);
    const unmanagedPositions = actualPositions.filter((actual) => {
      const symbol = actual.contract ?? "";
      const side: Side = Number(actual.size ?? 0) > 0 ? "LONG" : "SHORT";
      const position = this.runtime.live.positions[symbol];
      const entry = this.runtime.live.entries[symbol];
      return !(position?.status === "OPEN" && position.side === side)
        && !(entry?.side === side && (["SUBMITTING", "OPEN", "FILLED", "ERROR"].includes(entry.status)
          || (entry.status === "CANCELLED" && (now - entry.createdAt < 60_000 || this.liveEntryAwaitingReconcile(entry)))));
    });
    if (initialEnable && (unknownOrders.length || unmanagedPositions.length)) {
      throw new Error("Gate 已有未纳管仓位或挂单；执行暂停，所有者的开启选择保留");
    }

    for (const [symbol, entry] of Object.entries(this.runtime.live.entries)) {
      if (!entry || entry.status === "FILLED" || (entry.status === "CANCELLED" && !this.liveEntryAwaitingReconcile(entry))) continue;
      const openOrder = exchangeOrders.find((order) => liveOrderTag(order) === entry.tag);
      if (openOrder) {
        entry.status = "OPEN";
        entry.exchangeOrderId = liveOrderId(openOrder) ?? entry.exchangeOrderId;
        entry.missingSince = null;
      } else {
        entry.missingSince ??= now;
        const inspected = await client.inspectEntry(entry.kind, symbol, entry.tag, entry.exchangeOrderId);
        if (inspected) {
          entry.exchangeOrderId = liveOrderId(inspected) ?? entry.exchangeOrderId;
          entry.status = liveEntryDisposition(inspected, entry.kind);
          if(entry.parity && ["FILLED","CANCELLED"].includes(entry.status)) entry.submissionResolved=true;
          if (entry.status === "ERROR") {
            const reason = `Gate 挂单执行失败：${inspected.finish_as ?? inspected.status ?? "unknown"}`;
            entry.status = "CANCELLED";
            entry.lastError = reason;
            this.runtime.live.entrySkips[symbol] = { planId: entry.planId, symbol, code: "ENTRY_REJECTED", reason, observedAt: now };
            this.recordLiveAudit({ observedAt: now, symbol, planId: entry.planId, stage: "ENTRY_SUBMIT",
              level: "SKIPPED", reason });
          } else entry.lastError = null;
        } else if (entry.marketSubmittedAt!=null && gateUnknownSubmissionCanResolve(entry.marketSubmittedAt,now)) {
          // Gate documents that a custom text ID for a zero-fill cancelled
          // futures order may disappear after 60s, while any fully/partially
          // filled order remains queryable by that text indefinitely. Reaching
          // this branch means the fresh account snapshot has no position and a
          // direct text lookup also returned not-found beyond that window.
          entry.status = "CANCELLED";
          entry.submissionResolved = true;
          const reason = `Gate 在60秒订单身份核对窗口后仍无订单、持仓或成交 ${entry.tag}；确认本次未形成实盘暴露，原源单不重放，其他新机会恢复执行`;
          entry.lastError = reason;
          this.runtime.live.entrySkips[symbol] = { planId: entry.planId, symbol, code: "ENTRY_REJECTED", reason, observedAt: now };
          this.recordLiveAudit({ observedAt: now, symbol, planId: entry.planId, stage: "ENTRY_SUBMIT",
            level: "INFO", reason });
        } else if (now - entry.missingSince >= 6_000) {
          const reason = `Gate 暂未返回订单 ${entry.tag}；保留唯一订单身份继续核对至60秒，不自动重复提交`;
          entry.status = "ERROR";
          if(entry.lastError!==reason)this.recordLiveAudit({ observedAt: now, symbol, planId: entry.planId, stage: "ENTRY_SUBMIT",
            level: "RECOVERING", reason });
          entry.lastError = reason;
          this.runtime.live.entrySkips[symbol] = { planId: entry.planId, symbol, code: "SUBMISSION_UNCONFIRMED", reason, observedAt: now };
        }
      }
      const selectedTrade = desiredPortfolio[symbol] ?? null;
      const shouldCancel = !this.runtime.live.requestedEnabled || !selectedTrade || selectedTrade.id !== entry.planId
        || (entry.parity&&selectedTrade.forwardSource&&!sourceAfterEnable(selectedTrade.forwardSource,this.runtime.live.activation,this.forwardState?.startedAt??0))
        || now >= entry.expiresAt || !(entry.parity?this.mirrorQuoteReady(symbol):this.symbolEntryReady(symbol));
      if (shouldCancel && openOrder && entry.exchangeOrderId) await this.cancelLiveEntry(client, entry);
      else if (shouldCancel && !openOrder && entry.status !== "FILLED" && entry.missingSince != null && now - entry.missingSince >= 6_000) entry.status = "CANCELLED";
    }

    for (const actual of actualPositions) {
      const symbol = actual.contract ?? "";
      const exchangeSize = Number(actual.size ?? 0);
      const side: Side = exchangeSize > 0 ? "LONG" : "SHORT";
      let position = this.runtime.live.positions[symbol] ?? null;
      if (!position || position.status !== "OPEN") {
        const entry = this.runtime.live.entries[symbol];
        const selectedTrade = desiredPortfolio[symbol] ?? null;
        if (!entry || entry.side !== side || (!["SUBMITTING", "OPEN", "FILLED", "ERROR"].includes(entry.status)
          && !(entry.status === "CANCELLED" && now - entry.createdAt < 60_000))) throw new Error(`发现未纳管实盘仓位 ${symbol}`);
        // A completed source can be replaced before an in-flight market order
        // returns. Reconcile the reserved OLD parent first, then close it; never
        // relabel that fill as the replacement or abandon its protection.
        if (!entry.parity && selectedTrade && selectedTrade.id !== entry.planId) throw new Error(`发现与模拟账户订单不一致的实盘仓位 ${symbol}`);
        const entryPrice = Number(actual.entry_price ?? entry.trigger) || entry.trigger;
        const multiplier = this.runtime.contractMeta[symbol]?.quantoMultiplier ?? 1;
        const notional = Math.abs(exchangeSize) * entryPrice * multiplier;
        const leverage = Math.max(1, Number(actual.leverage ?? entry.leverage) || entry.leverage);
        const expectedStop = this.liveEntryStopIntent(entry);
        const recoveredStop = snapshot.priceOrders.find((order) => liveOrderTag(order) === (entry.stopTag ?? expectedStop.tag));
        position = {
          id: entry.planId, symbol, side, scenario: entry.scenario, entryAt: now, entryPrice,
          initialStop: entry.invalidation, currentStop: entry.invalidation, currentTarget: entry.target,
          plannedRisk: notional * (Math.abs(entryPrice - entry.invalidation) / Math.max(entryPrice, 1e-9) + (selectedTrade?.context.modeledCostRate ?? 0.0018)),
          notional, targetScore: entry.targetScore ?? selectedTrade?.context.candidateScore ?? 0,
          targetIdentity: entry.targetIdentity ?? `arena:${entry.planId}`,
          routeId: entry.routeId, routeKind: entry.routeKind, targetTimeframe: entry.targetTimeframe,
          rangeBoundary: entry.rangeBoundary, rangeBuffer: entry.rangeBuffer, sweepExtreme: entry.sweepExtreme,
          reclaimSource: entry.reclaimSource, reclaimStrength: entry.reclaimStrength,
          status: "OPEN", exchangeSize: Math.abs(exchangeSize), leverage, margin: notional / leverage,
          stopOrderId: entry.stopOrderId ?? (recoveredStop ? liveOrderId(recoveredStop) : null),
          stopTag: entry.stopTag ?? expectedStop.tag, stopPrice: entry.stopPrice ?? expectedStop.price,
          stopSubmittingAt: entry.stopSubmittingAt ?? null, exitRequestedAt: entry.protectionExitRequestedAt ?? null,
          exchangeUpdatedAt: now,
          ...(entry.parity?{parity:structuredClone(entry.parity),mirrorSourceId:entry.planId}:{}),
        };
        this.runtime.live.positions[symbol] = position;
        entry.status = "FILLED";
        entry.submissionResolved=true;
        entry.missingSince = null;
        this.recordLiveAudit({ observedAt: now, symbol, planId: entry.planId, stage: "ENTRY_FILLED", level: "INFO",
          reason: `Gate 已确认实盘持仓，成交名义价值 ${notional.toFixed(4)} USDT，杠杆 ${leverage}×${entry.parity?.submitDelayMs!=null?`，源单到提交 ${entry.parity.submitDelayMs}ms`:""}` });
      } else if (position.side !== side) {
        throw new Error(`${symbol} 实盘方向与系统记录冲突`);
      }
      position.exchangeUpdatedAt = now;
      Object.assign(position,gatePositionValuation(actual,snapshot.checkedAt));
      // Track partial IOC executions and exchange-side reductions explicitly.
      if(position.parity){
        const receipt=position.parity;
        receipt.filledContracts=Math.abs(exchangeSize);
        receipt.discrepancy=Math.abs(exchangeSize)!==receipt.roundedContracts
          ?`交易所实际${Math.abs(exchangeSize)}张，源单比例目标${receipt.roundedContracts}张；未声称完整复制`:null;
        const px=Number(actual.entry_price);
        if(Number.isFinite(px)&&px>0){
          position.entryPrice=px;
          const source=receipt.sourceEntryPrice>0?this.currentMirrorSource(position.id).trade:null;
          if(source){
            const actualDrift=liveEntryDriftGuard(source,px);
            receipt.exchangeEntryPrice=px;receipt.exchangeEntryAt=snapshot.checkedAt;
            receipt.exchangeEntryDriftRate=actualDrift.adverse;
          }
        }
        position.exchangeSize=Math.abs(exchangeSize);
        position.notional=position.exchangeSize*position.entryPrice*(this.runtime.contractMeta[symbol]?.quantoMultiplier??0);
        position.leverage=Math.max(1,Number(actual.leverage)||receipt.sourceLeverage);
        const reportedMargin=position.exchangeMargin??position.exchangeInitialMargin;
        position.margin=reportedMargin!=null&&reportedMargin>0?reportedMargin:position.notional/position.leverage;
        if(position.leverage!==receipt.sourceLeverage)receipt.discrepancy=`交易所杠杆${position.leverage}×与源单${receipt.sourceLeverage}×不同`;
      }
      const selectedTrade = desiredPortfolio[symbol] ?? null;
      const lifecycle=position.parity?this.currentMirrorSource(position.id):null;
      const sourceClosed=lifecycle?.status==="CLOSED";
      if(position.parity&&sourceClosed){
        position.parity.sourceClosedAt=lifecycle.trade.closedAt;
        position.parity.sourceExitReason=lifecycle.trade.exitReason;
      }
      if (!position.exitRequestedAt && (position.parity?sourceClosed:liveMirrorExitRequired(position.id, selectedTrade))) {
        position.exitRequestedAt = now;
        position.exitReason = sourceClosed?lifecycle!.trade!.exitReason??"PAPER_SOURCE_EXIT":"PAPER_PORTFOLIO_EXIT";
        this.recordLiveAudit({ observedAt: now, symbol, planId: position.id, stage: "EXIT_REQUEST", level: "INFO",
          reason: `模拟源单 ${position.id} 已退出，实盘跟随同一决定：${position.exitReason}` });
        await this.saveCheckpoint(Date.now(),true);
        position.exitOrderId=await client.closePosition(symbol, liveExitTag(position.id));
      } else if (!position.exitRequestedAt && (position.parity?lifecycle?.status==="OPEN":selectedTrade)) {
        position.currentStop = position.parity?lifecycle!.trade!.stopPrice:arenaProtectionStop(selectedTrade!);
        position.currentTarget = position.parity?lifecycle!.trade!.armPrice:selectedTrade!.targetPrice;
        position.targetScore = selectedTrade?.context.candidateScore??0;
        position.targetIdentity = position.parity?`forward:${position.id}`:`arena:${selectedTrade!.id}`;
        this.runtime.live.positions[symbol] = position;
      }
      if (!position.exitRequestedAt) {
        await this.ensureLiveStop(client, position, snapshot.priceOrders);
        if (!position.parity && !accountError && (this.liveOpenRisk() > equity * PORTFOLIO_RISK_CAP + 1e-8
          || this.liveDirectionalRisk(position.side) > equity * CORRELATED_DIRECTION_RISK_CAP + 1e-8)) {
          position.exitRequestedAt = now;
          position.exitReason = "RISK_CAP_AFTER_FILL";
          this.recordLiveAudit({ observedAt: now, symbol, planId: position.id, stage: "EXIT_REQUEST", level: "FORCED_EXIT",
            reason: "实盘成交后的实际结构风险超过账户或同方向风险上限，已请求市价退出" });
          position.exitOrderId=await client.closePosition(symbol, liveExitTag(position.id));
        }
      } else if (now - position.exitRequestedAt >= 6_000) {
        position.exitRequestedAt = now;
        position.exitOrderId=await client.closePosition(symbol, liveExitTag(position.id));
      }
    }

    for (const [symbol, position] of Object.entries(this.runtime.live.positions)) {
      if (!position || position.status !== "OPEN") continue;
      const actual = actualPositions.find((row) => row.contract === symbol && Number(row.size ?? 0) !== 0);
      if (actual) continue;
      // Actual exit price must come from a verified exchange execution. Never
      // substitute a PAPER price, fresh midpoint or fabricated realized PnL.
      let verifiedExit:GateLiveOrder|null=null;
      if(position.parity){
        try {
          verifiedExit=await client.inspectEntry("MARKET",symbol,liveExitTag(position.id),position.exitOrderId??null);
          if(!verifiedExit&&position.stopOrderId){
            const stop=await client.inspectEntry("PRICE_TRIGGER",symbol,position.stopTag??"",position.stopOrderId);
            if(stop?.trade_id&&String(stop.trade_id)!=="0")
              verifiedExit=await client.inspectEntry("MARKET",symbol,"",String(stop.trade_id));
          }
        } catch(error){
          this.recordLiveAudit({observedAt:now,symbol,planId:position.id,stage:"POSITION_CLOSED",level:"RECOVERING",
            reason:`交易所仓位已归零，成交价尚待核对，不以模拟价代替：${safeError(error)}`});
        }
      }
      const stopId = position.stopOrderId ?? (position.stopTag
        ? liveOrderId(snapshot.priceOrders.find((order) => liveOrderTag(order) === position.stopTag) ?? {})
        : null);
      if (stopId) await client.cancelOrder("PRICE_TRIGGER", stopId);
      const verifiedPrice=Number(verifiedExit?.fill_price),verified=Number.isFinite(verifiedPrice)&&verifiedPrice>0;
      const closed:LivePosition = { ...position, status: "CLOSED", exitAt: now,
        exitPrice: position.parity?(verified?verifiedPrice:undefined):this.runtime.evidence[symbol]?.midpoint??position.entryPrice,
        actualExitPriceVerified:position.parity?verified:undefined,
        exitReason: position.exitReason ?? "EXCHANGE_FLAT", stopOrderId: null, stopTag: null, stopPrice: null, stopSubmittingAt: null };
      if(closed.parity){
        closed.parity={...closed.parity,actualExitPriceVerified:verified,actualExitOrderId:verifiedExit?liveOrderId(verifiedExit):position.exitOrderId??null};
        const lifecycle=this.currentMirrorSource(position.id);
        const key=`${LIVE_PARITY_PREFIX}binding:${position.id}`;
        const binding=(this.liveJournal.get(key) as MirrorBinding|undefined)??await this.ctx.storage.get<MirrorBinding>(key);
        if(binding)this.liveJournal.set(key,{...binding,receipt:closed.parity,
          ...(lifecycle.status==="CLOSED"?{sourceAtClose:structuredClone(lifecycle.trade)}:{}),actual:closed});
        this.liveJournal.set(`${LIVE_PARITY_PREFIX}closed:${String(now).padStart(16,"0")}:${position.id}`,
          {version:LIVE_PARITY_VERSION,position:closed});
      }
      this.runtime.live.positions[symbol]=closed;
      this.recordLiveAudit({ observedAt: now, symbol, planId: position.id, stage: "POSITION_CLOSED", level: "INFO",
        reason: `Gate 已确认仓位归零；退出原因 ${position.exitReason ?? "EXCHANGE_FLAT"}` });
      await this.saveCheckpoint(Date.now(),true);
      this.liveHistory=[closed,...this.liveHistory.filter(p=>p.id!==closed.id)].slice(0,40);
    }

    if (!this.runtime.live.requestedEnabled) {
      this.runtime.live.operational = false;
      this.runtime.live.lastError = null;
      this.runtime.live.entrySkips = {};
      return;
    }
    if (unknownOrders.length) throw new Error("Gate 存在未纳管挂单；已停止新开仓");
    if(unmanagedPositions.length)throw new Error("Gate 存在未纳管仓位；停止新增复制，保留已纳管保护");
    if(sourceError)throw new Error(`当前模拟复制源尚待恢复：${sourceError}`);
    if(accountError)throw new Error(accountError);
    if(this.forwardError)throw new Error(`模拟状态尚未成功保存：${this.forwardError}；不复制未持久化决定`);

    let recoveringSubmission = Object.values(this.runtime.live.entries)
      .find((entry) => entry && (["SUBMITTING", "ERROR"].includes(entry.status) || this.liveEntryAwaitingReconcile(entry))) ?? null;
    const recoveringStop = Object.values(this.runtime.live.positions)
      .find((position) => position?.status === "OPEN" && position.stopSubmittingAt && !position.stopOrderId) ?? null;
    let recoveringEntryStop = Object.values(this.runtime.live.entries)
      .find((entry) => entry && !["FILLED", "CANCELLED"].includes(entry.status)
        && entry.stopSubmittingAt && !entry.stopOrderId) ?? null;
    this.runtime.live.operational = !recoveringSubmission && !recoveringStop && !recoveringEntryStop;
    this.runtime.live.lastError = recoveringSubmission
      ? recoveringSubmission.lastError ?? `${recoveringSubmission.symbol} 的实盘提交正在与 Gate 核对`
      : recoveringStop ? `${recoveringStop.symbol} 的结构止损正在按订单标签核对`
        : recoveringEntryStop ? `${recoveringEntryStop.symbol} 的初始止损正在按订单标签核对` : null;
    if(recoveringSubmission || recoveringStop || recoveringEntryStop) return;
    let availableForNewEntries = available;
    let riskForNewEntries = this.liveOpenRisk();
    const directionRiskForNewEntries: Record<Side, number> = {
      LONG: this.liveDirectionalRisk("LONG"),
      SHORT: this.liveDirectionalRisk("SHORT"),
    };
    let marginForNewEntries = [
      ...Object.values(this.runtime.live.positions).filter((position) => position?.status === "OPEN"),
      ...Object.values(this.runtime.live.entries).filter((entry) => entry && ["SUBMITTING", "OPEN", "ERROR"].includes(entry.status)),
    ].reduce((sum, item) => sum + (item?.margin ?? 0), 0);
    let notionalForNewEntries=[...Object.values(this.runtime.live.positions).filter(p=>p?.status==="OPEN"),
      ...Object.values(this.runtime.live.entries).filter(e=>e&&["SUBMITTING","OPEN","ERROR"].includes(e.status))]
      .reduce((n,p)=>n+(p?.notional??0),0);
    const paperMark=forwardEquity(this.forwardState!,this.regimeQuotes(Date.now()),Date.now());
    let mirrorRatio=this.runtime.live.activation?.scaleRatio??null;
    const staged: Array<{ symbol: string; plan: PaperPlan; intent: ReturnType<typeof buildLiveEntryIntent>;binding?:MirrorBinding;activation:LiveSession|null }> = [];
    for (const [symbol, skip] of Object.entries(this.runtime.live.entrySkips)) {
      const trade = desiredPortfolio[symbol] ?? null;
      if (!skip || !trade || trade.id !== skip.planId || now >= trade.openedAt + 45 * 60_000) delete this.runtime.live.entrySkips[symbol];
    }
    for (const trade of Object.values(desiredPortfolio)) {
      const symbol = trade.symbol;
      if(!trade.forwardSource)continue; // Legacy sources only drain existing exposure.
      if(!orderAuditUsable){
        this.runtime.live.entrySkips[symbol]={planId:trade.id,symbol,code:"ECONOMICS",
          reason:"Gate账户与持仓核对正常，但挂单审计通道暂未恢复；只暂停新增复制，已有原生保护和持仓管理不受影响",observedAt:now};
        continue;
      }
      const plan = { ...arenaTradePlan(trade), expiresAt:trade.openedAt+trade.forwardSource.rule.horizon*60_000 };
      const prior = this.runtime.live.entries[symbol];
      // Identity fencing comes before quote/admission diagnostics. Once a market
      // request crossed the network boundary, this exact PAPER parent can never
      // be submitted again. If the post-60s reconciliation proved no exposure,
      // preserve that final result instead of overwriting it with a stale-quote
      // ECONOMICS message on the next pass.
      if(prior?.planId===plan.id&&prior.marketSubmittedAt!=null){
        if(this.liveEntryAwaitingReconcile(prior)){
          this.runtime.live.entrySkips[symbol]={planId:plan.id,symbol,code:"SUBMISSION_UNCONFIRMED",
            reason:prior.lastError??"此前源单的提交尚待交易所确认，保留原身份和保护，不覆盖为新源单",observedAt:now};
        }else if(prior.status==="CANCELLED"&&prior.submissionResolved){
          this.runtime.live.entrySkips[symbol]={planId:plan.id,symbol,code:"ENTRY_REJECTED",
            reason:prior.lastError??"该源单已确认未形成实盘暴露；不重放同一源单",observedAt:now};
        }
        continue;
      }
      const justTriggeredEntry = sourceAfterEnable(trade.forwardSource,this.runtime.live.activation,this.forwardState!.startedAt);
      if (!justTriggeredEntry
        || this.runtime.live.positions[symbol]?.status === "OPEN" || !this.mirrorQuoteReady(symbol)) {
        if(this.runtime.live.positions[symbol]?.id!==trade.id)
          this.runtime.live.entrySkips[symbol]={planId:trade.id,symbol,code:"ECONOMICS",
            reason:!justTriggeredEntry?"此单在本次开启前已存在，不补开；仅跟随开启后新模拟单":"等待源单对应的空闲持仓槽和新鲜可执行盘口",observedAt:now};
        continue;
      }
      const midpoint = this.runtime.evidence[symbol]?.midpoint ?? 0;
      if (!(midpoint > 0)) continue;
      const retainedSkip = this.runtime.live.entrySkips[symbol];
      if (retainedSkip?.planId === plan.id && ["LEVERAGE_REJECTED","ENTRY_REJECTED","SUBMISSION_UNCONFIRMED"].includes(retainedSkip.code)
        && now-retainedSkip.observedAt<60_000) continue;
      if(this.liveEntryAwaitingReconcile(prior)) {
        this.runtime.live.entrySkips[symbol]={planId:plan.id,symbol,code:"SUBMISSION_UNCONFIRMED",
          reason:"此前源单的提交尚待交易所确认，保留原身份和保护，不覆盖为新源单",observedAt:now};
        continue;
      }
      // A non-market or pre-submit prior can still be cancelled/replaced below.
      if (prior && prior.planId === plan.id && prior.status !== "CANCELLED") continue;
      if (prior && !["FILLED", "CANCELLED"].includes(prior.status)) await this.cancelLiveEntry(client, prior);
      let intent: ReturnType<typeof buildLiveEntryIntent>;
      let binding:MirrorBinding|undefined;
      try {
        if(paperMark.stalePositions)throw new LiveEntrySizingError("ECONOMICS",symbol,"模拟账户当前估值不完整，不能确定复制比例");
        const scaled=await this.ensureLiveSessionScale(paperMark.equity,equity,Date.now());
        mirrorRatio=scaled?.scaleRatio??equity/paperMark.equity;
        const expectedLiveEquity=paperMark.equity*mirrorRatio;
        const liveEquityDrift=expectedLiveEquity>0?equity/expectedLiveEquity:0;
        if(liveEquityDrift<.85)throw new LiveEntrySizingError("ECONOMICS",symbol,
          `实盘权益已低于固定模拟比例预期的${(liveEquityDrift*100).toFixed(1)}%，暂停新增复制并保留已有保护`);
        const quote=this.runtime.evidence[symbol];
        const result=buildProportionalMirror({source:trade.forwardSource,sourceEquity:paperMark.equity,equity,
          available:availableForNewEntries,openRisk:riskForNewEntries,sameDirectionRisk:directionRiskForNewEntries[plan.side],
          entryPrice:plan.side==="LONG"?quote?.bestAsk??0:quote?.bestBid??0,
          quantoMultiplier:this.runtime.contractMeta[symbol]?.quantoMultiplier??0,
          leverageMax:this.runtime.contractMeta[symbol]?.leverageMax??0,maintenanceRate:this.runtime.contractMeta[symbol]?.maintenanceRate??0.005,
          openMargin:marginForNewEntries,openNotional:notionalForNewEntries,now:Date.now(),policy:this.forwardState!.policyVersion??this.forwardState!.version,
          sizeRules:this.runtime.contractMeta[symbol],activationAt:this.runtime.live.activation?.enabledAt,
          mirrorRatio,sourceRiskAuthority:true,quoteObservedAt:quote?.observedAt});
        intent=result.intent;binding=result.binding;
      } catch (error) {
        if (!(error instanceof LiveEntrySizingError)) throw error;
        this.runtime.live.entrySkips[symbol] = { planId: plan.id, symbol, code: error.code, reason: error.message, observedAt: now,sizing:error.sizing };
        continue;
      }
      delete this.runtime.live.entrySkips[symbol];
      availableForNewEntries = Math.max(0, availableForNewEntries - intent.margin);
      riskForNewEntries += intent.plannedRisk;
      directionRiskForNewEntries[plan.side] += intent.plannedRisk;
      marginForNewEntries += intent.margin;
      notionalForNewEntries += intent.notional;
      staged.push({ symbol, plan, intent, binding,activation:structuredClone(this.runtime.live.activation??null) });
      if(staged.length>=2)break; // Bound private requests per pass, not total holdings.
    }
    for (const { symbol, plan, intent, binding,activation } of staged) {
      if(!this.runtime.live.requestedEnabled||!this.mirrorQuoteReady(symbol)
        ||!sameLiveSession(activation,this.runtime.live.activation)
        ||!sourceAfterEnable(binding!.sourceAtCopy,this.runtime.live.activation,this.forwardState!.startedAt)
        ||!mirrorSourceFresh(this.currentMirrorSource(plan.id).trade??undefined,plan.id,Date.now()))continue;
      const entry: LiveEntry = {
        planId: plan.id, symbol, side: plan.side, scenario: plan.marketState, kind: intent.kind, status: "SUBMITTING",
        tag: intent.tag, exchangeOrderId: null, createdAt: now, expiresAt: plan.expiresAt, trigger: plan.entryTrigger,
        invalidation: plan.invalidation, target: plan.target, targetIdentity: plan.targetIdentity, targetScore: plan.score,
        routeId: plan.routeId, routeKind: plan.routeKind, targetTimeframe: plan.targetTimeframe,
        rangeBoundary: plan.rangeBoundary, rangeBuffer: plan.rangeBuffer, sweepExtreme: plan.sweepExtreme,
        reclaimSource: plan.reclaimSource, reclaimStrength: plan.reclaimStrength,
        size: intent.size, contracts: intent.contracts,
        notional: intent.notional, plannedRisk: intent.plannedRisk, leverage: intent.leverage, margin: intent.margin,
        stopOrderId: null, stopTag: null, stopPrice: null, stopSubmittingAt: null, protectionExitRequestedAt: null,
        missingSince: null, lastError: null,
        ...(binding?{parity:structuredClone(binding.receipt),mirrorSourceId:plan.id}:{}),
      };
      this.runtime.live.entries[symbol] = entry;
      if(binding)this.liveJournal.set(`${LIVE_PARITY_PREFIX}binding:${plan.id}`,binding);
      await this.saveCheckpoint(now, true);
      try {
        if(!this.runtime.live.requestedEnabled||!sameLiveSession(activation,this.runtime.live.activation)){entry.status="CANCELLED";continue;}
        try {
          await client.setLeverage(symbol, intent.leverage);
        } catch (error) {
          const reason = `Gate 未接受 ${symbol} 的 ${intent.leverage}× 杠杆，本计划已跳过：${safeError(error)}`;
          entry.status = "CANCELLED";
          entry.lastError = reason;
          this.runtime.live.entrySkips[symbol] = { planId: plan.id, symbol, code: "LEVERAGE_REJECTED", reason, observedAt: now };
          this.recordLiveAudit({ observedAt: now, symbol, planId: plan.id, stage: "LEVERAGE", level: "SKIPPED", reason, error });
          continue;
        }
        try {
          // Owner OFF or source CLOSE during leverage/network await takes
          // precedence over the stale staged entry.
          if(!this.runtime.live.requestedEnabled||!this.mirrorQuoteReady(symbol)
            ||!sameLiveSession(activation,this.runtime.live.activation)
            ||!sourceAfterEnable(binding!.sourceAtCopy,this.runtime.live.activation,this.forwardState!.startedAt)
            ||!mirrorSourceFresh(this.currentMirrorSource(plan.id).trade??undefined,plan.id,Date.now())){
            entry.status="CANCELLED";await this.saveCheckpoint(Date.now(),true);continue;
          }
          const q=this.runtime.evidence[symbol],price=entry.side==="LONG"?q?.bestAsk:q?.bestBid;
          if(!price||(entry.side==="LONG"?price<=entry.invalidation:price>=entry.invalidation)){
            entry.status="CANCELLED";entry.lastError="等待杠杆确认期间价格已越过源单止损，未追补旧成交";
            this.runtime.live.entrySkips[symbol]={planId:entry.planId,symbol,code:"ECONOMICS",reason:entry.lastError,observedAt:Date.now()};
            await this.saveCheckpoint(Date.now(),true);continue;
          }
          const source=binding!.sourceAtCopy,drift=liveEntryDriftGuard(source,price);
          if(drift.adverse>drift.allowed+1e-9){
            entry.status="CANCELLED";
            entry.lastError=`提交前盘口相对模拟入场不利偏差${(drift.adverse*100).toFixed(3)}%，超过动态上限${(drift.allowed*100).toFixed(3)}%，不追价`;
            this.runtime.live.entrySkips[symbol]={planId:entry.planId,symbol,code:"ECONOMICS",reason:entry.lastError,observedAt:Date.now()};
            await this.saveCheckpoint(Date.now(),true);continue;
          }
          const submittedAt=Date.now();
          if(entry.parity)Object.assign(entry.parity,{submitQuoteAt:q?.observedAt,submitQuotePrice:price,submittedAt,
            submitDelayMs:Math.max(0,submittedAt-source.openedAt),allowedAdverseEntryDriftRate:drift.allowed,
            adverseEntryDriftRate:drift.adverse});
          entry.marketSubmittedAt=submittedAt;
          await this.saveCheckpoint(submittedAt,true);
          const submissionStillAllowed=()=>{
            if(!this.runtime.live.requestedEnabled||!this.mirrorQuoteReady(symbol)
              ||!sameLiveSession(activation,this.runtime.live.activation)
              ||!sourceAfterEnable(binding!.sourceAtCopy,this.runtime.live.activation,this.forwardState?.startedAt??0)
              ||!mirrorSourceFresh(this.currentMirrorSource(plan.id).trade??undefined,plan.id,Date.now()))return false;
            const latest=this.runtime.evidence[symbol],latestPrice=entry.side==="LONG"?latest?.bestAsk:latest?.bestBid;
            if(!latestPrice||(entry.side==="LONG"?latestPrice<=entry.invalidation:latestPrice>=entry.invalidation))return false;
            const latestDrift=liveEntryDriftGuard(source,latestPrice);
            return latestDrift.adverse<=latestDrift.allowed+1e-9;
          };
          if(!submissionStillAllowed())throw new GateEntryCancelledError();
          entry.exchangeOrderId = await client.createEntry(intent,submissionStillAllowed);
          entry.status = "OPEN";
          const filled=await client.inspectEntry("MARKET",symbol,entry.tag,entry.exchangeOrderId);
          const fillPrice=Number(filled?.fill_price);
          if(entry.parity&&Number.isFinite(fillPrice)&&fillPrice>0){
            const actualDrift=liveEntryDriftGuard(source,fillPrice);
            Object.assign(entry.parity,{exchangeEntryPrice:fillPrice,exchangeEntryAt:Date.now(),
              exchangeEntryDriftRate:actualDrift.adverse});
          }
          if(filled&&liveEntryDisposition(filled,"MARKET")==="CANCELLED"){
            entry.status="CANCELLED";entry.submissionResolved=true;entry.lastError="Gate IOC零成交；未完成复制，不冒充成功";
            this.runtime.live.entrySkips[symbol]={planId:entry.planId,symbol,code:"ENTRY_REJECTED",reason:entry.lastError,observedAt:Date.now()};
            await this.saveCheckpoint(Date.now(),true);continue;
          }
          await this.saveCheckpoint(Date.now(),true);
          await this.createImmediateLiveStop(client, entry);
          if (!entry.stopOrderId) {
            if (entry.protectionExitRequestedAt) recoveringSubmission = entry;
            else recoveringEntryStop = entry;
            break;
          }
          await this.queueLiveBinding(entry);
          await this.saveCheckpoint(Date.now(),true);
        } catch (error) {
          if(error instanceof GateEntryCancelledError){
            entry.status="CANCELLED";entry.submissionResolved=true;entry.lastError=error.message;
            delete entry.marketSubmittedAt;
            if(entry.parity){delete entry.parity.submittedAt;delete entry.parity.submitDelayMs;}
            await this.queueLiveBinding(entry);
            await this.saveCheckpoint(Date.now(),true);
            continue;
          }
          const reason = `Gate 实盘入场提交失败：${safeError(error)}`;
          entry.lastError = reason;
          if (definitiveGateRejection(error)) {
            entry.status = "CANCELLED";
            this.runtime.live.entrySkips[symbol] = { planId: plan.id, symbol, code: "ENTRY_REJECTED", reason, observedAt: now };
            this.recordLiveAudit({ observedAt: now, symbol, planId: plan.id, stage: "ENTRY_SUBMIT", level: "SKIPPED", reason, error });
          } else {
            entry.status = "ERROR";
            entry.missingSince = now;
            recoveringSubmission = entry;
            this.recordLiveAudit({ observedAt: now, symbol, planId: plan.id, stage: "ENTRY_SUBMIT", level: "RECOVERING",
              reason: `${reason}；结果不明确，保留风险额度并按订单标签核对，不自动重复提交`, error });
          }
        }
      } catch (error) {
        entry.status = "ERROR";
        entry.lastError = safeError(error);
        throw error;
      }
      if(entry.status==="ERROR")break; // Do not compound an unconfirmed exposure.
    }
    if (recoveringSubmission || recoveringEntryStop) {
      this.runtime.live.operational = false;
      this.runtime.live.lastError = recoveringSubmission
        ? recoveringSubmission.lastError ?? `${recoveringSubmission.symbol} 的实盘提交正在与 Gate 核对`
        : `${recoveringEntryStop!.symbol} 的初始止损正在按订单标签核对`;
    }
    // A cached source-trigger pass is provisional by construction; the caller
    // schedules the immediate full Gate reconciliation. Network-backed passes
    // become the next fast-event cache.
    if(!cached)this.liveSnapshotCache=structuredClone(snapshot);
  }

  protected async setLiveMode(enabled: boolean) {
    const wasEnabled=this.runtime.live.requestedEnabled;
    const changedAt=Date.now();
    if(enabled&&!wasEnabled)this.runtime.live.activation=startLiveSession(changedAt,this.forwardState);
    this.runtime.live.requestedEnabled = enabled;
    if (!enabled) this.runtime.live.operational = false;
    if(wasEnabled!==enabled||this.runtime.live.changedAt==null)this.runtime.live.changedAt = changedAt;
    this.runtime.live.lastError = null;
    try {
      await this.ctx.storage.put(`${LIVE_PARITY_PREFIX}owner-intent`,{enabled,changedAt:this.runtime.live.changedAt,activation:this.runtime.live.activation??null});
      await this.saveCheckpoint(Date.now(),true);
      await this.syncLive(Date.now(), enabled, !enabled);
      this.recordLiveAudit({ observedAt: Date.now(), symbol: null, planId: null, stage: "LIVE_CONTROL", level: "INFO",
        reason: enabled ? "所有者已开启，仅复制本次开启后新产生的模拟单；开启前已有单不补开，重复开启不重置起点" : "所有者已关闭实盘复制并请求撤销系统入场挂单" });
      await this.saveCheckpoint(Date.now(), true);
      return { ok: true, live: this.runtime.live };
    } catch (error) {
      this.runtime.live.operational = false;
      this.runtime.live.lastError = safeError(error);
      this.recordLiveAudit({ observedAt: Date.now(), symbol: null, planId: null, stage: "LIVE_CONTROL",
        level: "RECOVERING",
        reason: `实盘选择保持${this.runtime.live.requestedEnabled ? "开启" : "关闭"}，执行已暂停等待核对：${this.runtime.live.lastError}`, error });
      await this.saveCheckpoint(Date.now(), true).catch(() => undefined);
      return { ok: false, error: this.runtime.live.lastError, live: this.runtime.live };
    }
  }

  private suspendSymbol(symbol: string, now: number, error: string, retryAt: number, increment = true) {
    const evidence = this.runtime.evidence[symbol];
    const prior = this.runtime.feedFailures[symbol] ?? { count: 0, retryAt: 0 };
    const count = increment ? Math.min(5, prior.count + 1) : prior.count;
    const suspendedSince = prior.suspendedSince ?? now;
    const lastFreshAt = prior.lastFreshAt ?? evidence?.observedAt ?? now;
    const hardFailure = count >= FEED_HARD_FAILURE_COUNT || now - lastFreshAt >= FEED_HARD_FAILURE_MS;
    this.runtime.feedFailures[symbol] = {
      ...prior,
      count,
      retryAt,
      suspendedSince,
      lastFreshAt,
      recoveryFreshCount: 0,
      totalFailures: (prior.totalFailures ?? 0) + (increment ? 1 : 0),
      lastFailureAt: increment ? now : prior.lastFailureAt ?? now,
      lastError: error,
    };
    this.runtime.decisions[symbol] = null;
    if (evidence) {
      evidence.fresh = false;
      evidence.entryReady = false;
      evidence.recoveryFreshCount = 0;
      evidence.suspensionReason = hardFailure ? "关键行情持续中断，计划已撤销" : "关键行情短暂延迟，计划冻结且禁止成交";
    }
    const plan = this.runtime.plans[symbol];
    if (hardFailure) this.runtime.routes[symbol] = [];
    if (!hardFailure || plan?.state !== "PREPARED") return false;
    this.runtime.plans[symbol] = { ...plan, state: "CANCELLED", cancelReason: "FEED_HARD_FAILURE_CANCEL", cancelledAt: now };
    return true;
  }

  private acceptFreshSymbol(symbol: string, now: number, observedAt: number, progressed: boolean) {
    const prior = this.runtime.feedFailures[symbol] ?? { count: 0, retryAt: 0 };
    const wasSuspended = prior.suspendedSince != null;
    const recoveryFreshCount = wasSuspended && progressed
      ? Math.min(FEED_RECOVERY_CONFIRMATIONS, (prior.recoveryFreshCount ?? 0) + 1)
      : wasSuspended ? prior.recoveryFreshCount ?? 0 : FEED_RECOVERY_CONFIRMATIONS;
    const recovered = wasSuspended && recoveryFreshCount >= FEED_RECOVERY_CONFIRMATIONS;
    const entryReady = !wasSuspended || recovered;
    this.runtime.feedFailures[symbol] = {
      ...prior,
      count: 0,
      retryAt: 0,
      suspendedSince: entryReady ? null : prior.suspendedSince,
      lastFreshAt: now,
      recoveryFreshCount,
      recoveries: (prior.recoveries ?? 0) + (recovered ? 1 : 0),
      lastError: entryReady ? null : "等待第二次新鲜盘口确认",
      maxObservedLagMs: Math.max(prior.maxObservedLagMs ?? 0, Math.max(0, now - observedAt)),
    };
    return { entryReady, recoveryFreshCount, recovered };
  }

  private symbolEntryReady(symbol:string,now=Date.now()) {
    const evidence=this.runtime.evidence[symbol],failure=this.runtime.feedFailures[symbol];
    return Boolean(evidence?.fresh&&evidence.entryReady!==false&&this.runtime.contractMeta[symbol]!=null
      &&(this.sessionWarmup[symbol]??0)>=1&&now-evidence.observedAt<=STALE_AFTER_MS
      &&failure?.suspendedSince==null);
  }

  private currentAuthorityProtectionSymbols() {
    // The displayed/current PAPER authority is forwardState. Retired/sidecar
    // PAPER research may continue to drain internally, but it must not consume
    // critical realtime slots or freeze the current account. Any real legacy
    // Gate exposure remains protected because it is present in live.positions
    // (or a still-active live entry) regardless of its original source.
    return new Set([
      ...Object.values(this.runtime.live.positions).flatMap((position) => position?.status === "OPEN" ? [position.symbol] : []),
      ...Object.values(this.runtime.live.entries).flatMap((entry) => entry && !["FILLED", "CANCELLED"].includes(entry.status) ? [entry.symbol] : []),
      ...(this.forwardState?.positions.map((position) => position.symbol) ?? []),
    ]);
  }

  private symbolManagementReady(symbol: string, now = Date.now()) {
    const evidence = this.runtime.evidence[symbol];
    if (!evidence || this.runtime.contractMeta[symbol] == null) return false;
    return freshQuote({ bestBid: evidence.bestBid ?? evidence.midpoint, bestAsk: evidence.bestAsk ?? evidence.midpoint,
      observedAt: evidence.observedAt, fresh: evidence.fresh }, now);
  }

  private realtimeReadiness(now=Date.now()) {
    const protectedSymbols=this.currentAuthorityProtectionSymbols();
    const actionableMarkets=this.runtime.symbols.filter(symbol=>this.symbolEntryReady(symbol,now)).length;
    const missingProtectedMarkets=[...protectedSymbols].filter(symbol=>!this.runtime.symbols.includes(symbol)
      ||!this.symbolManagementReady(symbol,now));
    return{capacity:FORWARD_EXECUTION_BBO_CAP,actionableMarkets,
      warmingMarkets:Math.max(0,this.runtime.symbols.length-actionableMarkets),
      protectedMarkets:protectedSymbols.size,protectedMarketsReady:missingProtectedMarkets.length===0,missingProtectedMarkets};
  }

  private ensureProtectionSymbolsResident() {
    const protectedSymbols=[...this.currentAuthorityProtectionSymbols()];
    const urgentSymbols=this.forwardUrgentSymbols();
    // Realtime Gate data is a scarce execution resource, never a scanner.
    // Keep only actual exposure and currently executable candidates resident.
    const next=[...new Set([...protectedSymbols,...urgentSymbols])].slice(0,FORWARD_EXECUTION_BBO_CAP);
    if(next.length!==this.runtime.symbols.length||next.some((symbol,index)=>symbol!==this.runtime.symbols[index]))
      this.applyRealtimeSymbols(next);
  }

  private forwardUrgentSymbols(now=Date.now()){
    if(!this.forwardState)return[];
    return forwardUrgentQuoteSymbols(this.forwardState,now,this.runtime.liquidUniverse??[]);
  }

  private forwardQuotes(now=Date.now()){
    if(!this.forwardState||!this.runtime.evidence)return this.regimeQuotes(now);
    return Object.fromEntries(Object.entries(this.runtime.evidence).flatMap(([symbol,row])=>{
      if(!row?.fresh||row.bestBid==null||row.bestAsk==null||now-row.observedAt>STALE_AFTER_MS)return[];
      return[[symbol,{bestBid:row.bestBid,bestAsk:row.bestAsk,observedAt:row.observedAt,fresh:true,
        entryReady:this.symbolEntryReady(symbol,now)}]];
    }));
  }

  private launchExternalMarketRefresh(now=Date.now()){
    const task=this.marketHub.launchRefresh(now);if(!task)return;
    this.ctx.waitUntil(task.then(()=>{
      const at=Date.now(),status=this.marketHub.status(at);
      if(status.healthySources>0)this.runtime.lastSuccessAt=at;
      for(const symbol of this.forwardUrgentSymbols(at)){
        const q=this.marketHub.quote(symbol,at);if(q)this.recordForwardMinuteQuote(symbol,q.mid,q.observedAt);
      }
    }).catch(error=>{this.runtime.strategyLogError=`external-market: ${safeError(error)}`;}));
  }

  private recordForwardMinuteQuote(symbol:string,mid:number,observedAt:number){
    if(!this.forwardUrgentSymbols(observedAt).includes(symbol)||!Number.isFinite(mid)||mid<=0)return;
    this.forwardMinuteQuoteBars??={};
    const minute=Math.floor(observedAt/60_000)*60_000;
    let row=this.forwardMinuteQuoteBars[symbol];
    if(!row||row.minute!==minute){
      if(row){
        const covered=row.lastAt-row.firstAt;
        const fullMinute=row.samples>=12&&covered>=45_000&&row.firstAt<=row.minute+10_000&&row.lastAt>=row.minute+50_000;
        if(fullMinute)row.completed=[...row.completed,{time:row.minute/1000,open:row.open,high:row.high,low:row.low,close:row.close,volume:0}].slice(-90);
      }
      row={minute,open:mid,high:mid,low:mid,close:mid,samples:1,firstAt:observedAt,lastAt:observedAt,completed:row?.completed??[]};
      this.forwardMinuteQuoteBars[symbol]=row;return;
    }
    row.high=Math.max(row.high,mid);row.low=Math.min(row.low,mid);row.close=mid;row.samples++;row.lastAt=observedAt;
  }

  private forwardMinutePaths(){
    const officialCache=this.forwardMinuteCandles??{};
    return Object.fromEntries(Object.entries(officialCache).flatMap(([symbol,official])=>{
      // 1m confirmation must come from the same official analysis venue as 5m.
      // Synthetic cross-venue quote bars are never allowed to certify a breakout.
      const rows=(official??[]).slice(-90);
      return rows.length>=3?[[symbol,rows]]:[];
    }));
  }

  private async refreshForwardUrgentMinutes(now=Date.now()){
    this.forwardMinuteCandles??={};this.forwardMinuteQuoteBars??={};this.forwardMinuteRetryAt??=new Map();
    const targetCompletedAt=Math.floor(now/60_000)*60_000;
    const urgent=this.forwardState?forwardUrgentMinuteSymbols(this.forwardState,this.runtime.liquidUniverse??[])
      .slice(0,FORWARD_MINUTE_CONFIRMATION_CAP):[];
    const due=urgent.filter(symbol=>{
      if((this.forwardMinuteRetryAt.get(symbol)??0)>now)return false;
      const last=Math.max(this.forwardMinuteCandles[symbol]?.at(-1)?.time??0,this.gateStream.path(symbol,"1m").at(-1)?.time??0);
      return!last||(last+60)*1000<targetCompletedAt;
    }).slice(0,4);
    const results=await Promise.allSettled(due.map(async symbol=>{
      const coverage=this.marketHub.coverage(symbol,Date.now());
      if(coverage.sourceCount>=2&&coverage.disagreementRate>.015)
        throw new Error(`${symbol} external venue disagreement`);
      const external=await this.marketHub.candles(symbol,"1m",90);
      if(external)return{symbol,rows:external.rows,source:external.source};
      if(this.marketHub.supports(symbol))throw new Error(`${symbol} external 1m temporarily unavailable`);
      return{symbol,rows:await fetchStructureCandles(symbol,"1m",90),source:"GATE" as const};
    }));
    results.forEach((result,index)=>{
      const symbol=due[index]!;
      if(result.status!=="fulfilled"){this.forwardMinuteRetryAt.set(symbol,now+5000);return;}
      if(result.value.rows.length){this.forwardMinuteCandles[symbol]=result.value.rows.slice(-90);this.forwardMinuteRetryAt.delete(symbol);}
      else this.forwardMinuteRetryAt.set(symbol,now+5000);
    });
    return due.length;
  }

  private cycleBookSymbols(_now:number,symbols:string[]) {
    // Every resident Gate symbol is already execution-relevant.
    return symbols;
  }

  private async processAdaptiveBooks(now:number,cycleSymbols=[...this.runtime.symbols]) {
    if(this.forwardState){
      // Gate public websocket is execution-only. Bybit/OKX/KuCoin own continuous
      // analysis candles; Gate does not carry the 30-market scan anymore.
      this.ctx.waitUntil(this.gateStream.ensure(this.runtime.symbols,[],[],now));
    }
    const urgent=new Set([...this.currentAuthorityProtectionSymbols(),...this.forwardUrgentSymbols(now)]);
    const streamBook=(symbol:string)=>this.gateStream.book(symbol,this.runtime.tickSize[symbol]??.0001,
      this.runtime.contractMeta[symbol]?.quantoMultiplier??1,Math.max(now,Date.now()));
    const due=cycleSymbols.filter(symbol=>streamBook(symbol)||(this.runtime.feedFailures[symbol]?.retryAt??0)<=now);
    this.runtime.feedQuality.attempts+=due.length;
    const rows=await Promise.allSettled(due.map(async symbol=>{
      const pushed=streamBook(symbol);if(pushed){this.gateStream.used("websocket");return{symbol,snapshot:pushed};}
      const tick=this.runtime.tickSize[symbol]??.0001,mult=this.runtime.contractMeta[symbol]?.quantoMultiplier??1;
      try{
        const snapshot=await fetchTickerBbo(symbol,tick,mult);this.gateStream.used("rest");return{symbol,snapshot};
      }catch(error){
        // Existing exposure and active candidates get one final depth fallback;
        // ordinary warming markets yield to the next 2s cycle instead.
        if(!urgent.has(symbol))throw error;
        const snapshot=await fetchUrgentFuturesBook(symbol,tick,mult);this.gateStream.used("rest");return{symbol,snapshot};
      }
    }));
    let successes=0;
    for(let i=0;i<rows.length;i++){
      const symbol=due[i]!,result=rows[i]!;
      if(result.status!=="fulfilled"){
        const prior=this.runtime.feedFailures[symbol]?.count??0,count=Math.min(5,prior+1);
        const delay=urgent.has(symbol)?LOOP_MS:[2000,4000,8000,16000,30000][count-1]!;
        const gateRetry=result.reason instanceof GatePublicError?result.reason.retryAt:null,error=safeError(result.reason);
        this.runtime.feedQuality.failures++;this.runtime.feedQuality.lastFailureAt=now;
        this.runtime.feedQuality.lastFailureSymbol=symbol;this.runtime.feedQuality.lastError=error;
        this.suspendSymbol(symbol,now,error,Math.max(now+delay,gateRetry??0));continue;
      }
      const {snapshot}=result.value,bid=snapshot.bids[0]?.price??0,ask=snapshot.asks[0]?.price??0,at=snapshot.observedAt;
      const fresh=bid>0&&ask>=bid&&at>0&&Math.max(now,Date.now())-at<=STALE_AFTER_MS;
      if(!fresh){this.suspendSymbol(symbol,now,"Gate盘口失鲜",now+LOOP_MS);continue;}
      const recovery=this.acceptFreshSymbol(symbol,now,at,true);
      if(recovery.recovered)this.runtime.feedQuality.recoveries++;
      this.sessionWarmup[symbol]=Math.min(1,(this.sessionWarmup[symbol]??0)+1);
      const ready=recovery.entryReady&&(this.sessionWarmup[symbol]??0)>=1&&this.runtime.contractMeta[symbol]!=null;
      const mid=(bid+ask)/2;
      this.runtime.evidence[symbol]={midpoint:mid,bestBid:bid,bestAsk:ask,observedAt:at,
        warmup:this.sessionWarmup[symbol]??0,fresh:true,ancillaryFresh:true,optionalFresh:true,entryReady:ready,
        recoveryFreshCount:recovery.recoveryFreshCount,suspensionReason:ready?null:"等待第二份新鲜盘口确认",
        topLong:null,topShort:null,absorption:0,range15m:null};
      this.recordForwardMinuteQuote(symbol,mid,at);successes++;
    }
    if(successes>0)this.runtime.lastSuccessAt=Date.now();
    return{successes,requests:due.length,criticalChanged:false};
  }

  protected async saveCheckpoint(now: number, force = false) {
    this.resetDailyCounters(now);
    if (!force && this.runtime.lastHeartbeatAt != null && now - this.runtime.lastHeartbeatAt < HEARTBEAT_MS) return;
    const openCount = Object.values(this.runtime.positions).filter((position) => position?.status === "OPEN").length;
    const journal=new Map(this.liveJournal);
    const writes=1+journal.size;
    const reservation=this.reserveNonAlarmWrites(writes,openCount);
    if (!reservation) {
      if (force) throw new Error("Durable Object non-alarm write reserve reached");
      return;
    }
    try {
      // Full immutable source snapshots live outside the bounded hot checkpoint.
      // A binding and its entry reservation commit atomically BEFORE a Gate call.
      const compact=<T extends {parity?:MirrorReceipt}>(value:T|null)=>{
        if(!value)return value;
        const {parity,...rest}=value;void parity;return rest;
      };
      const checkpoint = { ...this.runtime, live:{...this.runtime.live,
        entries:Object.fromEntries(Object.entries(this.runtime.live.entries).map(([k,e])=>[k,compact(e)])),
        positions:Object.fromEntries(Object.entries(this.runtime.live.positions).map(([k,p])=>[k,compact(p)]))},
        analysisMs: [], nonAlarmWrites: this.runtime.nonAlarmWrites + this.nonAlarmPendingWrites, lastHeartbeatAt: now };
      await this.ctx.storage.transaction(async transaction=>{
        await transaction.put({checkpoint,...Object.fromEntries(journal)});
      });
      for(const[key,value]of journal)if(this.liveJournal.get(key)===value)this.liveJournal.delete(key);
      reservation.finish(true);
      this.runtime.lastHeartbeatAt = now;
    } finally {reservation.finish(false);}
  }

  private async refreshAdaptiveCandles(now=Date.now()){
    const symbols=this.strategyPathSymbols();if(!symbols.length)return 0;
    const targetCompletedAt=latestCompletedStrategyCandleAt(now);
    const due=symbols.filter(symbol=>{
      const last=this.strategyCandles[symbol]?.at(-1);
      return !last||(last.time+300)*1000<targetCompletedAt;
    }).slice(0,5);
    const results=await Promise.allSettled(due.map(async symbol=>{
      const coverage=this.marketHub.coverage(symbol,Date.now());
      if(coverage.sourceCount>=2&&coverage.disagreementRate>.015)
        throw new Error(`${symbol} external venue disagreement ${(coverage.disagreementRate*100).toFixed(2)}%`);
      const external=await this.marketHub.candles(symbol,"5m",120);
      if(external)return{symbol,rows:external.rows,replace:true,source:external.source};
      if(this.marketHub.supports(symbol))throw new Error(`${symbol} external 5m temporarily unavailable`);
      // True Gate-only contracts retain a low-frequency fallback. A temporary
      // Bybit/OKX/KuCoin outage never redirects common-market analysis onto Gate.
      const rows=await fetchStructureCandles(symbol,"5m",(this.strategyCandles[symbol]?.length??0)>=120?6:120);
      return{symbol,rows,replace:false,source:"GATE" as const};
    }));
    results.forEach((result,index)=>{
      const symbol=due[index]!;
      if(result.status!=="fulfilled"){
        const prior=this.runtime.strategyCandleFailures[symbol];
        this.runtime.strategyCandleFailures[symbol]={count:(prior?.count??0)+1,lastFailureAt:now,retryAt:now+5000,
          lastError:`5m多源刷新失败：${safeError(result.reason)}`};return;
      }
      const rows=result.value.replace?result.value.rows:mergeStrategyCandlePath(this.strategyCandles[symbol]??[],result.value.rows);
      if(rows.length>=30){this.strategyCandles[symbol]=rows.slice(-120);delete this.runtime.strategyCandleFailures[symbol];}
    });
    return due.length;
  }

  private publishCriticalHealth(observedAt:number,books:{successes:number;requests:number}) {
    this.runtime.lastAlarmAt=observedAt;
    const hub=this.marketHub.status(observedAt);
    if(books.successes>0||hub.healthySources>0)this.runtime.lastSuccessAt=observedAt;
    const readiness=this.realtimeReadiness(observedAt);
    const authorityStale=this.runtime.lastSuccessAt==null||observedAt-this.runtime.lastSuccessAt>SYSTEM_HEALTH_STALE_AFTER_MS;
    this.runtime.state=!this.authorityReady?"RECOVERY_REQUIRED":authorityStale?"RECONNECTING"
      :!readiness.protectedMarketsReady?"DEGRADED":hub.healthySources>0||readiness.actionableMarkets>0?"LIVE":"WARMING";
    const feedError=authorityStale?"Bybit/OKX/KuCoin分析源与Gate执行源同时不可用"
      :!readiness.protectedMarketsReady?"已有持仓缺少Gate保护报价":null;
    this.runtime.lastError=feedError??this.runtime.d1MirrorError;
  }

  private launchOptionalWork(now:number,universeDue:boolean) {
    if(this.optionalWork)return;
    const task=(async()=>{
      let subrequests=0;
      this.launchLiveSettlementBackground();
      const hub=this.marketHub.status(Date.now());
      if(hub.healthySources===0){
        const refresh=this.marketHub.launchRefresh(Date.now());
        if(refresh)await refresh.catch(()=>undefined);
      }
      if(universeDue){
        subrequests+=2;
        try{this.refreshUniverse(Date.now(),await fetchActiveContracts());}
        catch(error){this.runtime.lastError=`universe: ${safeError(error)}`;}
      }
      const radarDue=radarAttemptDue(this.runtime.radar,Date.now());
      if(radarDue){
        // Gate bulk discovery is optional and explicitly yields to private LIVE
        // work. Bybit/OKX/KuCoin remain the normal scan surface.
        if(!this.liveBackgroundWork&&!this.liveSyncWork){
          try{this.gateRadarCache=await fetchGateRadarTickers();this.gateRadarAt=Date.now();subrequests++;}
          catch{/* stale Gate-only discovery must never block external analysis */}
        }
        try{this.refreshRadar(Date.now());}
        catch(error){this.runtime.radar=failedRadarRuntime(this.runtime.radar,Date.now(),error);}
      }
      subrequests+=await this.refreshAdaptiveCandles(Date.now());
      subrequests+=await this.refreshForwardUrgentMinutes(Date.now());
      await this.advanceForwardNow(Date.now(),true);
      this.runtime.subrequestCount+=subrequests;
      this.runtime.maxSubrequestsInAlarm=Math.max(this.runtime.maxSubrequestsInAlarm,subrequests);
    })().catch(error=>{this.runtime.strategyLogError=`adaptive: ${safeError(error)}`;});
    this.optionalWork=task;
    const tracked=task.finally(()=>{if(this.optionalWork===task)this.optionalWork=null;});
    this.ctx.waitUntil(tracked);
  }

  async alarm(info?: { isRetry?: boolean; retryCount?: number }) {
    const now = Date.now();
    if (info?.isRetry) {
      const persistedAlarm = await this.ctx.storage.getAlarm();
      if (persistedAlarm != null && persistedAlarm > now) {
        this.runtime.nextAlarmAt = persistedAlarm;
        return;
      }
      const recoveryAlarm = now + LOOP_MS;
      await this.ctx.storage.setAlarm(recoveryAlarm);
      this.runtime.nextAlarmAt = recoveryAlarm;
      return;
    }
    const slot = Math.floor(now / LOOP_MS);
    if (slot <= this.runtime.lastProcessedSlot && (this.runtime.nextAlarmAt ?? 0) > now) return;
    this.runtime.nextAlarmAt = null;
    const prearmed = now + LOOP_MS;
    await this.ctx.storage.setAlarm(prearmed);
    this.runtime.nextAlarmAt = prearmed;
    if (!this.authorityReady) return;
    if (slot <= this.runtime.lastProcessedSlot) return;
    this.runtime.lastProcessedSlot = slot;
    this.resetDailyCounters(now);
    if (now - this.runtime.feedQuality.windowStartedAt >= FEED_QUALITY_WINDOW_MS) {
      this.runtime.feedQuality = { windowStartedAt: now, attempts: 0, failures: 0, recoveries: 0,
        lastFailureAt: this.runtime.feedQuality.lastFailureAt, lastFailureSymbol: this.runtime.feedQuality.lastFailureSymbol,
        lastError: this.runtime.feedQuality.lastError };
    }
    this.runtime.lastAlarmAt = now;
    this.runtime.alarmCount += 1;
    let subrequests = 0;
    try {
      const universeDue = now - this.runtime.lastUniverseAt >= UNIVERSE_MS;
      this.launchExternalMarketRefresh(now);
      this.ensureProtectionSymbolsResident();
      const cycleSymbols = this.cycleBookSymbols(now, [...this.runtime.symbols]);
      // The fresh executable book is the critical clock. Completed-candle,
      // universe, radar and research logging run under one non-overlapping
      // background task and can no longer delay the next protection/entry pass.
      const books = await this.processAdaptiveBooks(now, cycleSymbols);
      subrequests += books.requests;
      this.publishCriticalHealth(Date.now(), books);
      // Forward/PAPER is financial authority, not optional analysis. Keep its
      // exits and 5-minute account archive on the same critical protection clock.
      await this.advanceForwardNow(Date.now(),false);
      // Private network latency must not hold the 2s executable-book/PAPER clock.
      this.launchLiveWork();
      this.launchOptionalWork(now, universeDue);
      this.launchTurnoverWork(Date.now());
    } catch (error) {
      this.runtime.state = "RECONNECTING";
      this.runtime.lastError = safeError(error);
    } finally {
      const finishedAt = Date.now();
      this.runtime.lastAlarmAt = finishedAt;
      this.runtime.subrequestCount += subrequests;
      this.runtime.maxSubrequestsInAlarm = Math.max(this.runtime.maxSubrequestsInAlarm, subrequests);
      try { await this.saveCheckpoint(finishedAt); } catch (error) { this.runtime.lastError = `checkpoint: ${safeError(error)}`; }
    }
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname;
    // Binding-only projections. No public route reaches these methods. They do
    // not mutate primary state, re-arm alarms, start market work or touch Gate.
    if(path === "/member-feed" && request.method === "GET") {
      const s=this.forwardState,now=Date.now();
      const sourceState=s?{version:s.version,startedAt:s.startedAt,initialEquity:s.initialEquity,balance:s.balance,
        positions:s.positions,history:s.history,policyVersion:s.policyVersion,storage:s.storage} as ForwardState:null;
      const view=s?forwardSummary(s,this.regimeQuotes(now),now):null;
      const feed:MemberFeed={version:MEMBERS_VERSION,at:now,healthy:!this.forwardError&&this.authorityReady
        &&this.runtime.lastSuccessAt!=null&&now-this.runtime.lastSuccessAt<=SYSTEM_HEALTH_STALE_AFTER_MS,
        error:this.forwardError,state:sourceState,view,metadata:this.runtime.contractMeta,ticks:this.runtime.tickSize,
        evidence:this.runtime.evidence,ownerAccountHash:this.turnoverAccountUser?await digestMember(`gate-user:${this.turnoverAccountUser}`):null,
        sourceStatus:{state:this.runtime.state,lastSuccessAt:this.runtime.lastSuccessAt,
          stale:this.runtime.lastSuccessAt==null||now-this.runtime.lastSuccessAt>SYSTEM_HEALTH_STALE_AFTER_MS}};
      return json(feed);
    }
    if(path === "/member-closed" && request.method === "GET") {
      const id=url.searchParams.get("id")??"",openedAt=Number(url.searchParams.get("openedAt"));
      if(!/^ft-[a-zA-Z0-9_-]{1,100}$/.test(id)||!Number.isSafeInteger(openedAt)||openedAt<=0)return json({error:"invalid source"},400);
      const current=sourceLifecycle(this.forwardState,id);if(current.status!=="UNKNOWN")return json({trade:current.status==="CLOSED"?current.trade:null,nextCursor:null});
      const prefix=`${FORWARD_STORAGE}archive:`,cursor=url.searchParams.get("cursor");
      if(cursor&&(!cursor.startsWith(prefix)||cursor.length>150))return json({error:"invalid cursor"},400);
      const rows=await this.ctx.storage.list<{trades?:ForwardState["history"]}>({prefix,limit:32,
        startAfter:cursor??`${prefix}${String(openedAt).padStart(16,"0")}`});
      for(const value of rows.values()) {const trade=value.trades?.find(t=>t.id===id&&t.status==="CLOSED");if(trade)return json({trade,nextCursor:null});}
      return json({trade:null,nextCursor:rows.size===32?[...rows.keys()].at(-1):null});
    }
    if(path==="/owner-live-source"&&request.method==="GET"){
      const id=url.searchParams.get("id");
      if(!id||id.length>200||/[\u0000-\u001f]/.test(id))return json({error:"invalid source id"},400);
      const binding=await this.ctx.storage.get<MirrorBinding>(`${LIVE_PARITY_PREFIX}binding:${id}`);
      if(!binding)return json({error:"尚无已提交的复制映射",source:this.currentMirrorSource(id)},404);
      const actual=Object.values(this.runtime.live.positions).find(p=>p?.id===id)??binding.actual;
      return json({...binding,currentSource:this.currentMirrorSource(id),actual});
    }
    if (path === "/forward-export" && request.method === "GET") {
      await this.ensureAlarm();
      const state=this.forwardState,exportedAt=Date.now();
      const researchTrades=state?[...state.positions,...state.history].map(trade=>({
        id:trade.id,symbol:trade.symbol,side:trade.side,status:trade.status,openedAt:trade.openedAt,closedAt:trade.closedAt,
        durationMs:Math.max(0,(trade.closedAt??exportedAt)-trade.openedAt),
        leverage:trade.leverage,margin:trade.margin,notional:trade.notional,plannedRisk:trade.plannedRisk,
        entry:trade.entryContext?{provenance:"RECORDED_AT_ENTRY",...trade.entryContext}:{
          provenance:"LEGACY_POSITION_WITHOUT_ENTRY_CONTEXT",
          note:"该持仓早于入场上下文持久化上线；只保留当时已存在的turn/forecast/rule字段，不用当前状态伪造入场原因。",
          timeframe:trade.turn?.timeframe??null,side:trade.side,signalAt:trade.turn?.signalAt??null,
          turnProbability:trade.turn?.entryTurnProbability??null,continuationScore:trade.turn?.entryContinuation??null,
          directionConfidence:trade.turn?.entryDirectionConfidence??null,forecast:trade.forecast??null,ruleReason:trade.rule.reason,
        },
        holdAssessment:trade.holdValue??null,
        path:{maxFavorableRate:trade.favorable,maxAdverseRate:trade.adverse,lastPrice:trade.lastPrice,lastQuoteAt:trade.lastQuoteAt},
        exit:trade.status==="CLOSED"?{reason:trade.exitReason,closedAt:trade.closedAt,exitPrice:trade.exitPrice,
          netPnl:trade.netPnl,grossPnl:trade.grossPnl,audit:trade.exitAudit??null}:null,
      })): [];
      return json({ exportedAt, forward: this.forwardView(exportedAt),
        marketData:{transport:this.gateStream.status(exportedAt),feedQuality:this.runtime.feedQuality,
          symbols:this.runtime.symbols.map(symbol=>({symbol,quoteAt:this.runtime.evidence[symbol]?.observedAt??null,
            entryReady:this.forwardQuotes(exportedAt)[symbol]?.entryReady===true,
            completedMinuteAt:this.forwardMinutePaths()[symbol]?.at(-1)
              ?(this.forwardMinutePaths()[symbol]!.at(-1)!.time+60)*1_000:null,
            failure:this.runtime.feedFailures[symbol]??null}))},
        measurements: state?.relationEngine?.samples ?? [],
        relationResearch:{version:"forward-path-relation-v3",rules:state?.relationEngine?.rules??[],diagnostics:state?.relationEngine?.diagnostics??null},
        research:{version:"forward-path-relation-v3-trade-review-v1",purpose:"逐单复盘成熟关系、关系生命周期、MFE/MAE、持仓反馈、利润保护与退出结果",trades:researchTrades},
        archiveEndpoint: "/api/forward/archive", completeness: "当前快照与滚动样本；完整不可变记录按archive接口分页读取" });
    }
    if (path === "/forward-equity" && request.method === "GET") {
      const s=this.forwardState;
      if(!s)return json({error:"净值源尚未恢复"},503);
      try {
        const page=await this.equityReader.read(this.ctx.storage,{startedAt:s.startedAt,initialEquity:s.initialEquity,
          policy:s.policyVersion,exitPolicy:ADAPTIVE_ENGINE_VERSION,
          comparableSince:s.startedAt,
          persistedAt:s.storage.persistedAt},url.searchParams.get("cursor"),Date.now(),url.searchParams.get("after"));
        return json(page);
      }catch(error){const message=error instanceof Error?error.message:"";
        return json({error:message==="INVALID_CURSOR"?"净值游标无效":"净值记录暂不可用；图表不控制交易"},
          message==="INVALID_CURSOR"?400:message==="CURVE_BUSY"?429:503);}
    }
    if (path === "/forward-archive" && request.method === "GET") {
      const prefix = `${FORWARD_STORAGE}archive:`;
      const cursor = url.searchParams.get("cursor");
      if (cursor && (!cursor.startsWith(prefix) || cursor.length > 150)) return json({ error: "invalid cursor" }, 400);
      const rows = await this.ctx.storage.list({ prefix, limit: 26, ...(cursor ? { startAfter: cursor } : {}) });
      const entries = [...rows.entries()]; const hasMore = entries.length > 25;
      const page = entries.slice(0, 25);
      return json({ items: page.map(([key, value]) => ({ key, value })), nextCursor: hasMore ? page.at(-1)?.[0] ?? null : null,
        immutable: true, generatedAt: Date.now() });
    }
    if (path === "/watchdog") {
      const stale = this.runtime.lastSuccessAt == null || Date.now() - this.runtime.lastSuccessAt > SYSTEM_HEALTH_STALE_AFTER_MS;
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm == null || alarm < Date.now() - 6_000) {
        this.runtime.state = this.authorityReady ? "RECONNECTING" : "RECOVERY_REQUIRED";
        if (alarm != null) await this.ctx.storage.deleteAlarm();
        await this.ensureAlarm();
      }
      return json({ ok: true, stale, nextAlarmAt: await this.ctx.storage.getAlarm() });
    }
    if (path === "/health-status") {
      await this.ensureAlarm();
      const stale = !this.authorityReady || this.runtime.lastSuccessAt == null || Date.now() - this.runtime.lastSuccessAt > SYSTEM_HEALTH_STALE_AFTER_MS;
      const effectiveState = !this.authorityReady ? "RECOVERY_REQUIRED" : stale ? "RECONNECTING" : this.runtime.state;
      const strategies = REGIME_STRATEGIES;
      const canonical = canonicalPaperSummary({ current: this.runtime.strategyArena, previous: this.runtime.previousStrategyArena,
        regime: this.runtime.regimePortfolio }, this.runtime.canonicalPaper);
      const regimes = marketRegimeSummary(this.runtime.marketRegimes);
      return json({
        version: this.runtime.version,
        buildSha: FORWARD_BUILD_SHA,
        liveMirror: {...this.liveMirrorView(),rows:undefined},
        liveTurnover:this.turnoverStatus(),
        resourceAccounting:{policy:RESOURCE_DAY_POLICY,day:this.runtime.utcDay,nonAlarmWrites:this.runtime.nonAlarmWrites,
          cap:NON_ALARM_WRITE_CAP,pendingWrites:this.nonAlarmPendingWrites??0,
          criticalProtection:protectionWriteBudgetView(this.forwardProtectionBudget,Date.now()),
          previous:this.runtime.resourceRollovers?.at(-1)??null,forwardCompression:this.forwardCompression},
        forward: this.forwardHealth(),
        legacyRetired: true,
        mode: this.runtime.mode,
        state: effectiveState,
        stale,
        lastError: this.runtime.lastError,
        lastSuccessAt: this.runtime.lastSuccessAt,
        lastHeartbeatAt: this.runtime.lastHeartbeatAt,
        authorityReady: this.authorityReady,
        symbols: this.runtime.symbols,
        realtimeReadiness: this.realtimeReadiness(),
        liveMode: { requestedEnabled: this.runtime.live.requestedEnabled, operational: this.runtime.live.operational },
        liveExecution:{...this.liveExecution,inFlight:!!this.liveBackgroundWork,queued:this.liveSourcePending,
          timeoutStreak:this.liveReadTimeoutStreak,lastAccountAt:this.runtime.live.lastSyncAt,
          lastOrderAuditAt:(this.liveOrderSnapshotCache?.checkedAt??this.liveOrderAuditAt)||null,
          readTransport:this.liveClient?.readTransport??null},
        strategyArena: {
          version: canonical.version,
          playbookCount: canonical.playbookCount,
          catalogSize: strategies.length,
          shadowCount: 0,
          activeCount: 0,
          reverseActiveCount: 0,
          sleepingCount: 0,
          portfolioEquity: canonical.portfolioEquity,
          portfolioOpen: canonical.portfolioOpen.length,
          observationShadow: 0,
          routeCheckCount: this.runtime.regimePortfolio.routeChecks.length,
          formingRouteCount: this.runtime.regimePortfolio.routeChecks.filter((row) => row.status === "FORMING").length,
          blockedRouteCount: this.runtime.regimePortfolio.routeChecks.filter((row) => row.status === "BLOCKED").length,
          openRouteCount: this.runtime.regimePortfolio.routeChecks.filter((row) => row.status === "OPEN").length,
          effectiveShadowOpen: 0,
          cutoverPending: this.runtime.strategyArena.cutoverPending || this.runtime.previousStrategyArena.cutoverPending,
          engines: canonical.engines.map((engine) => ({ id: engine.id, name: engine.name,
            portfolioEquity: engine.portfolioEquity, portfolioOpen: engine.portfolioOpen.length })),
          rules: {
            singleTradeRiskMin: 0.015,
            singleTradeRiskMax: 0.015,
            minimumPortfolioRiskUsdt: 0,
            targetPortfolioRiskUsdt: 15,
            minimumNotionalMultiple: 0.05,
            empiricalCostFloorRate: ARENA_FRICTION_RATE,
            portfolioRiskCap: PORTFOLIO_RISK_CAP,
            correlatedRiskCap: CORRELATED_DIRECTION_RISK_CAP,
            marginCap: null,
            maxNotionalMultiple: 0.5,
            authorityWindowPriority: "CURRENT_REGIME_DIRECT",
            paperEvaluation: true,
            exactShadowClone: false,
            normalShadowAlwaysOn: false,
            outcomeBasedPromotion: false,
            shadowExecution: false,
            independentDirections: true,
            extremeSequenceAuthority: false,
            strategyName: "五行情独立账户组合",
            generatedRouteAuthority: false,
            legacyStrategyAuthority: false,
            paperCycleResetOnCutover: false,
            allRegimeVersion: ALL_REGIME_ENGINE_VERSION,
            sameBranchSymbolCooldownMs: 24 * 60 * 60_000,
            maxPortfolioPositions: MAX_PORTFOLIO_POSITIONS,
            profitArmIsExit: true,
            dailyObjectiveRate: 0.10,
            dailyObjectiveIsQuota: false,
            dualIndependentEngines: false,
            independentSystemCount: REGIME_SYSTEMS.length,
            engineInitialEquity: 1_000,
            canonicalReferenceEquity: CANONICAL_PAPER_REFERENCE_EQUITY,
            canonicalCopySizing: "SOURCE_EQUITY_FRACTION",
            canonicalEntryScaleFrozen: true,
            canonicalAdmissionGate: false,
            canonicalCapitalAgnostic: false,
            sameSymbolCrossEngineAllowed: true,
            liveSource: "CANONICAL_PAPER_NORMALIZED_NET",
          },
        },
        radar: {
          scanned: this.runtime.radar.scanned,
          lastScanAt: this.runtime.radar.lastScanAt,
          lastAttemptAt: this.runtime.radar.lastAttemptAt,
          consecutiveFailures: this.runtime.radar.consecutiveFailures,
          retryAt: this.runtime.radar.retryAt,
          entryFresh: radarCandidateExecutionAllowed(this.runtime.radar.lastScanAt, Date.now()),
        },
        strategyData: {
          liquidMarkets: REGIME_UNIVERSE.length,
          stableMarkets: this.runtime.regimePortfolio.warmMarkets,
          hourlyRequiredCandles: REGIME_HOURLY_REQUIRED_CANDLES,
          hourlyPathFailures: Object.keys(this.runtime.regimeHourlyFailures).length,
          hourlyPathError: Object.values(this.runtime.regimeHourlyFailures)
            .sort((left, right) => right.lastFailureAt - left.lastFailureAt)[0]?.lastError ?? null,
          routedMarkets: new Set(this.runtime.regimePortfolio.routeChecks.map((row) => row.symbol)).size,
          marketBreadth: this.runtime.regimePortfolio.currentContext?.breadth24 ?? 0,
          marketMedianMove: this.runtime.regimePortfolio.currentContext?.median24 ?? 0,
          marketContextMarkets: this.runtime.regimePortfolio.currentContext?.markets ?? 0,
          polarityReady: this.runtime.regimePortfolio.warmMarkets >= 8,
          lastCompletedCandleAt: this.runtime.regimePortfolio.lastEvaluatedHour ?? 0,
          lastRuntimeLogAt: this.runtime.lastStrategyLogAt,
          degradedMarkets: Object.values(this.runtime.strategyCandleFailures).filter((failure) => failure.count > 0).length,
          blockingMarkets: Object.entries(this.runtime.strategyCandleFailures).filter(([symbol, failure]) => failure.count >= 2
            && Date.now() - (this.runtime.stableStructures[symbol]?.observedAt ?? 0) > STRATEGY_CANDLE_STALE_MS).length,
          candleError: this.runtime.strategyCandleError,
          logError: this.runtime.strategyLogError,
        },
        feedQuality: this.runtime.feedQuality,
        multiSourceMarket: this.marketHub.status(),
        marketDataTransport: this.gateStream.status(),
        marketRegimes: { tracked: regimes.tracked, warmed: regimes.warmed, counts: regimes.counts },
        limits: {
          markets: this.runtime.symbols.length,
          scannedMarkets: this.runtime.radar.scanned,
          scanUniverse: SCAN_UNIVERSE_SIZE,
          realtimeCapacity: FORWARD_EXECUTION_BBO_CAP, minuteConfirmationCapacity: FORWARD_MINUTE_CONFIRMATION_CAP,
          plannedDoWritesPerDay: PRIMARY_PLANNED_DO_ROWS,
          twoMemberReservedDoRowsPerDay: TWO_MEMBER_PLANNED_DO_ROWS,
          resourceModelScope:"reserved rows; retries, controls, other workloads, request traffic and duration not certified",
          capacityCertified: false,
          plannedTotalDoRequestsPerDay: 53_280,
          plannedMaxD1BilledWritesPerDay: 4_800,
        },
      });
    }
    if (path === "/status" || path === "/owner-runtime") {
      await this.ensureAlarm();
      if(path==="/owner-runtime")this.launchTurnoverWork(Date.now());
      const { outbox, live, paperCycle, bankruptcyOutbox, strategyArena, previousStrategyArena, regimePortfolio, canonicalPaper, marketRegimes,
        stableCandidates: _stableCandidates, previousStableCandidates: _previousStableCandidates, stableStructures,
        previousStableStructures: _previousStableStructures, liquidUniverse: _liquidUniverse,
        strategyCandleFailures, ...publicRuntime } = this.runtime;
      void _stableCandidates; void _previousStableCandidates; void _previousStableStructures; void _liquidUniverse;
      const stale = !this.authorityReady || this.runtime.lastSuccessAt == null || Date.now() - this.runtime.lastSuccessAt > SYSTEM_HEALTH_STALE_AFTER_MS;
      const effectiveState = !this.authorityReady ? "RECOVERY_REQUIRED" : stale ? "RECONNECTING" : this.runtime.state;
      return json({ ...publicRuntime, ...this.authorityView, paperCycle: paperCycleSummary(paperCycle, this.authorityView.equity),
        buildSha: FORWARD_BUILD_SHA,
        forward: this.forwardView(), legacyRetired: true,
        strategyArena: canonicalPaperSummary({ current: strategyArena, previous: previousStrategyArena, regime: regimePortfolio }, canonicalPaper),
        marketRegimes: marketRegimeSummary(marketRegimes),
        strategyData: { liquidMarkets: REGIME_UNIVERSE.length, stableMarkets: regimePortfolio.warmMarkets,
          hourlyRequiredCandles: REGIME_HOURLY_REQUIRED_CANDLES,
          hourlyPathFailures: Object.keys(publicRuntime.regimeHourlyFailures).length,
          hourlyPathError: Object.values(publicRuntime.regimeHourlyFailures)
            .sort((left, right) => right.lastFailureAt - left.lastFailureAt)[0]?.lastError ?? null,
          routedMarkets: new Set(regimePortfolio.routeChecks.map((row) => row.symbol)).size,
          marketBreadth: regimePortfolio.currentContext?.breadth24 ?? 0,
          marketMedianMove: regimePortfolio.currentContext?.median24 ?? 0,
          marketContextMarkets: regimePortfolio.currentContext?.markets ?? 0,
          polarityReady: regimePortfolio.warmMarkets >= 8,
          lastCompletedCandleAt: regimePortfolio.lastEvaluatedHour ?? 0,
          lastRuntimeLogAt: publicRuntime.lastStrategyLogAt,
          degradedMarkets: Object.values(strategyCandleFailures).filter((failure) => failure.count > 0).length,
          blockingMarkets: Object.entries(strategyCandleFailures).filter(([symbol, failure]) => failure.count >= 2
            && Date.now() - (stableStructures[symbol]?.observedAt ?? 0) > STRATEGY_CANDLE_STALE_MS).length,
          candleError: publicRuntime.strategyCandleError, logError: publicRuntime.strategyLogError },
        liveMirror: this.liveMirrorView(),
        liveTurnover:this.turnoverStatus(),
        ...(path === "/owner-runtime" ? { live:{...live,history:this.liveHistory,mirror:this.liveMirrorView(),
          turnover:turnoverView(this.turnoverState,this.turnoverError,Date.now())} } : {}), liveMode: { requestedEnabled: live.requestedEnabled, operational: live.operational }, outboxLength: outbox.length + bankruptcyOutbox.length,
        oldestOutboxAgeMs: outbox.length ? Math.max(0, Date.now() - (outbox[0].position.exitAt ?? outbox[0].position.entryAt)) : 0,
        authorityReady: this.authorityReady, realtimeReadiness: this.realtimeReadiness(), multiSourceMarket:this.marketHub.status(),
        generatedAt: Date.now(), state: effectiveState, stale,
        analysisP99Ms: percentile99(this.runtime.analysisMs), limits: { loopMs: LOOP_MS, markets: this.runtime.symbols.length, scannedMarkets: this.runtime.radar.scanned, scanUniverse: SCAN_UNIVERSE_SIZE, radarMs: RADAR_MS, warmupSnapshots: WARMUP_SNAPSHOTS,
          maxAncillaryConcurrency: MAX_ANCILLARY_CONCURRENCY, maxSubrequestsPerAlarm: 32, plannedAlarmRequestsPerDay: 43_200,
          plannedAlarmWritesPerDay: 43_200, watchdogWriteReservePerDay: WATCHDOG_WRITE_RESERVE,
          nonAlarmWriteCapPerDay: NON_ALARM_WRITE_CAP, nonAlarmWritesToday: this.runtime.nonAlarmWrites,
          criticalProtection:protectionWriteBudgetView(this.forwardProtectionBudget,Date.now()),
          plannedDoWritesPerDay: PRIMARY_PLANNED_DO_ROWS,
          twoMemberReservedDoRowsPerDay: TWO_MEMBER_PLANNED_DO_ROWS,
          resourceModelScope:"reserved rows; retries, controls, other workloads, request traffic and duration not certified",
          capacityCertified: false,
          internalAnalysisP99RedlineMs: 25, topLevelCpuP99RedlineMs: 8, assumedRuntimePollSeconds: 10,
          plannedForegroundDoRequestsPerDay: 8_640, plannedCronWatchdogsPerDay: 1_440, plannedTotalDoRequestsPerDay: 53_280,
          maxOpenPositions: null, realtimeCapacity: FORWARD_EXECUTION_BBO_CAP, minuteConfirmationCapacity: FORWARD_MINUTE_CONFIRMATION_CAP, plannedMaxD1BilledWritesPerDay: 4_800 } });
    }
    if (path === "/live-history" && request.method === "GET") return json(await this.privateLiveHistory());
    if (path === "/owner-status" && request.method === "GET") {
      await this.ensureAlarm();
      this.launchTurnoverWork(Date.now());
      return json({ live:{...this.runtime.live,history:this.liveHistory,mirror:this.liveMirrorView(),
        turnover:turnoverView(this.turnoverState,this.turnoverError,Date.now())}, generatedAt: Date.now() });
    }
    if (path === "/credential-status" && request.method === "GET") {
      return json({ credential: await credentialMetadata(this.env.DB) });
    }
    if (path === "/credentials" && request.method === "PUT") {
      const body = await request.json<{ apiKey?: unknown; apiSecret?: unknown; environment?: unknown }>().catch(() => ({} as { apiKey?: unknown; apiSecret?: unknown; environment?: unknown }));
      if (typeof body.apiKey !== "string" || typeof body.apiSecret !== "string" || body.environment !== "live") {
        return json({ error: "Gate 实盘 API 参数不完整" }, 400);
      }
      try {
        const result = await this.ctx.blockConcurrencyWhile(() => this.replaceLiveCredentials({ apiKey: body.apiKey as string, apiSecret: body.apiSecret as string, environment: "live" }));
        return json(result);
      } catch (error) { return json({ error: safeError(error) }, 409); }
    }
    if (path === "/credentials" && request.method === "DELETE") {
      try {
        const result = await this.ctx.blockConcurrencyWhile(() => this.deleteLiveCredentials());
        return json(result);
      } catch (error) { return json({ error: safeError(error) }, 409); }
    }
    if (path === "/live-mode" && request.method === "POST") {
      const body = await request.json<{ enabled?: unknown }>().catch(() => ({} as { enabled?: unknown }));
      if (typeof body.enabled !== "boolean") return json({ error: "invalid live mode" }, 400);
      const result = await this.setLiveMode(body.enabled);
      return json(result, result.ok ? 200 : 409);
    }
    if (path === "/paper-reset" && request.method === "POST") {
      try { return json(await this.ctx.blockConcurrencyWhile(() => this.resetPaperAccount())); }
      catch (error) { return json({ error: safeError(error) }, 409); }
    }
    if (path === "/paper-history-clear" && request.method === "POST") {
      try { return json(await this.ctx.blockConcurrencyWhile(() => this.clearPaperHistory())); }
      catch (error) { return json({ error: safeError(error) }, 409); }
    }
    return json({ error: "not found" }, 404);
  }
}

export { MemberDirectory };
export class MemberExecutor extends memberExecutionClass(MarketStream) {}

const isAsset = (pathname: string) => pathname.startsWith("/_next/") || pathname.startsWith("/assets/") || /\.[a-z0-9]{2,8}$/i.test(pathname);
let runtimeCache: { response: string; expiresAt: number } | null = null;
const historyCache = new Map<string, { response: string; expiresAt: number }>();
let accountLogCache: { response: string; expiresAt: number } | null = null;
let strategyLogCache: { response: string; expiresAt: number } | null = null;
const failedLogins = new Map<string, { count: number; resetAt: number }>();
async function runtimeStatus(env: CloudflareEnv, useCache = true, owner = false) {
  if (!owner && useCache && runtimeCache && runtimeCache.expiresAt > Date.now()) return new Response(runtimeCache.response, { headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=10" } });
  const response = await env.MARKET_STREAM.getByName("primary").fetch(owner ? "https://market-stream/owner-runtime" : "https://market-stream/status");
  const body = await response.text();
  if (!owner && response.ok) runtimeCache = { response: body, expiresAt: Date.now() + 10_000 };
  return new Response(body, { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=10" } });
}

async function paperHistory(url: URL, env: CloudflareEnv) {
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 100) || 100));
  const cursor = url.searchParams.get("cursor") ?? "";
  const separator = cursor.indexOf("|");
  const beforeAt = separator > 0 ? Number(cursor.slice(0, separator)) : null;
  const beforeId = separator > 0 ? cursor.slice(separator + 1) : null;
  if (cursor && (!(beforeAt! > 0) || !beforeId || beforeId.length > 96)) return json({ error: "invalid history cursor" }, 400);
  const cacheKey = `${limit}:${cursor}`;
  const cached = historyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return new Response(cached.response, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=10" } });
  }
  const result = await env.DB.prepare(`SELECT
    id, symbol, market_state AS marketState, side, status,
    entry_at AS entryAt, entry_price AS entryPrice, initial_stop AS initialStop,
    current_stop AS currentStop, current_target AS currentTarget,
    planned_risk AS plannedRisk, notional,
    exit_at AS exitAt, exit_price AS exitPrice,
    exit_reason AS exitReason, realized_pnl AS realizedPnl, fees_and_slippage AS feesAndSlippage
    FROM paper_positions
    WHERE (? IS NULL OR COALESCE(exit_at,entry_at) < ? OR (COALESCE(exit_at,entry_at)=? AND id<?))
    ORDER BY COALESCE(exit_at,entry_at) DESC,id DESC
    LIMIT ?`).bind(beforeAt, beforeAt, beforeAt, beforeId, limit + 1).all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const items = rows.slice(0, limit);
  const tail = items.at(-1);
  const sortAt = tail ? Number(tail.exitAt ?? tail.entryAt) : null;
  const nextCursor = rows.length > limit && tail && sortAt ? `${sortAt}|${String(tail.id)}` : null;
  const body = JSON.stringify({ items, nextCursor, generatedAt: Date.now() });
  historyCache.set(cacheKey, { response: body, expiresAt: Date.now() + 10_000 });
  if (historyCache.size > 30) historyCache.delete(historyCache.keys().next().value!);
  return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=10" } });
}

async function accountLogs(env: CloudflareEnv) {
  if (accountLogCache && accountLogCache.expiresAt > Date.now()) {
    return new Response(accountLogCache.response, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } });
  }
  const result = await env.DB.prepare(`SELECT id,observed_at AS observedAt,payload_json AS payload
    FROM paper_events WHERE event_type='PAPER_BANKRUPTCY'
    ORDER BY observed_at DESC LIMIT 30`).all<{ id: string; observedAt: number; payload: string }>();
  const items = (result.results ?? []).flatMap((row) => {
    try { return [{ id: row.id, observedAt: row.observedAt, report: JSON.parse(row.payload) as BankruptcyReport }]; }
    catch { return []; }
  });
  const body = JSON.stringify({ items, generatedAt: Date.now() });
  accountLogCache = { response: body, expiresAt: Date.now() + 30_000 };
  return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } });
}

async function strategyRuntimeLogs(url: URL, env: CloudflareEnv) {
  const limit = Math.max(1, Math.min(576, Number(url.searchParams.get("limit") ?? 288) || 288));
  if (strategyLogCache && strategyLogCache.expiresAt > Date.now() && limit === 288) {
    return new Response(strategyLogCache.response, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } });
  }
  const result = await env.DB.prepare(`SELECT id,observed_at AS observedAt,version,scanned_markets AS scannedMarkets,
    stable_markets AS stableMarkets,realtime_markets AS realtimeMarkets,regime_counts_json AS regimeCounts,
    strategy_metrics_json AS strategyMetrics,shadow_open AS shadowOpen,shadow_resolved AS shadowResolved,
    active_strategies AS activeStrategies,portfolio_open AS portfolioOpen,portfolio_equity AS portfolioEquity,
    portfolio_resolved AS portfolioResolved,portfolio_net_pnl AS portfolioNetPnl,strategy_candle_error AS strategyCandleError,
    authority_state AS authorityState,live_requested AS liveRequested,live_operational AS liveOperational
    FROM strategy_runtime_log ORDER BY observed_at DESC LIMIT ?`).bind(limit).all<Record<string, unknown>>();
  const items = (result.results ?? []).flatMap((row) => {
    try {
      return [{ ...row, regimeCounts: JSON.parse(String(row.regimeCounts ?? "{}")),
        strategyMetrics: JSON.parse(String(row.strategyMetrics ?? "[]")),
        liveRequested: Boolean(row.liveRequested), liveOperational: Boolean(row.liveOperational) }];
    } catch { return []; }
  });
  const body = JSON.stringify({ items, generatedAt: Date.now(), intervalMinutes: 5, retentionDays: 14 });
  if (limit === 288) strategyLogCache = { response: body, expiresAt: Date.now() + 30_000 };
  return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } });
}

async function ownerAuthenticated(request: Request, env: CloudflareEnv) {
  return env.OWNER_ACCESS_TOKEN ? verifyOwnerSession(request, env.OWNER_ACCESS_TOKEN) : false;
}

async function authSession(request: Request, env: CloudflareEnv) {
  const configured = ownerAuthConfigured(env.OWNER_ACCESS_TOKEN);
  const authenticated = await ownerAuthenticated(request, env);
  if (!authenticated) return json({ configured, authenticated: false, username: "owner" });
  // A valid owner visit renews the signed HttpOnly session. This keeps the
  // phone control surface usable without weakening same-origin LIVE mutation.
  const session = await createOwnerSession(env.OWNER_ACCESS_TOKEN!);
  return new Response(JSON.stringify({ configured, authenticated: true, username: "owner" }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": ownerSessionCookie(session) },
  });
}

async function ownerLogin(request: Request, env: CloudflareEnv) {
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败" }, 403);
  if (!ownerAuthConfigured(env.OWNER_ACCESS_TOKEN)) return json({ error: "后台所有者访问码尚未配置" }, 503);
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 2_048) return json({ error: "登录请求过大" }, 413);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const attempt = failedLogins.get(ip);
  if (attempt && attempt.resetAt > Date.now() && attempt.count >= 5) return json({ error: "登录尝试过多，请稍后再试" }, 429);
  if (attempt && attempt.resetAt <= Date.now()) failedLogins.delete(ip);
  const body = await request.json<{ username?: unknown; password?: unknown }>().catch(() => ({} as { username?: unknown; password?: unknown }));
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const valid = username === "owner" && await ownerPasswordMatches(password, env.OWNER_ACCESS_TOKEN!);
  if (!valid) {
    const current = failedLogins.get(ip);
    failedLogins.set(ip, { count: (current?.count ?? 0) + 1, resetAt: current?.resetAt ?? Date.now() + 15 * 60_000 });
    return json({ error: "账户或密码不正确" }, 401);
  }
  failedLogins.delete(ip);
  const session = await createOwnerSession(env.OWNER_ACCESS_TOKEN!);
  return new Response(JSON.stringify({ ok: true, authenticated: true, username: "owner" }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": ownerSessionCookie(session) },
  });
}

async function ownerLogout(request: Request) {
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败" }, 403);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": clearOwnerSessionCookie() },
  });
}

async function ownerLiveStatus(request: Request, env: CloudflareEnv) {
  if (!await ownerAuthenticated(request, env)) return json({ error: "请先登录" }, 401);
  return env.MARKET_STREAM.getByName("primary").fetch("https://market-stream/owner-status");
}

async function ownerLiveSource(request: Request, env: CloudflareEnv) {
  if (!await ownerAuthenticated(request, env)) return json({ error: "请先登录" }, 401);
  return env.MARKET_STREAM.getByName("primary").fetch(`https://market-stream/owner-live-source${new URL(request.url).search}`);
}

async function ownerLiveMode(request: Request, env: CloudflareEnv) {
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败" }, 403);
  if (!await ownerAuthenticated(request, env)) return json({ error: "请先登录" }, 401);
  const body = await request.json<{ enabled?: unknown }>().catch(() => ({} as { enabled?: unknown }));
  if (typeof body.enabled !== "boolean") return json({ error: "实盘开关参数无效" }, 400);
  return env.MARKET_STREAM.getByName("primary").fetch("https://market-stream/live-mode", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: body.enabled }),
  });
}

async function ownerLiveCredentials(request: Request, env: CloudflareEnv) {
  if (!await ownerAuthenticated(request, env)) return json({ error: "请先登录" }, 401);
  const stream = env.MARKET_STREAM.getByName("primary");
  if (request.method === "GET") return stream.fetch("https://market-stream/credential-status");
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败" }, 403);
  if (request.method === "DELETE") {
    return stream.fetch("https://market-stream/credentials", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
  }
  if (request.method !== "PUT") return json({ error: "不支持的 API 操作" }, 405);
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 2_048) return json({ error: "API 请求过大" }, 413);
  const raw = await request.text();
  if (raw.length > 2_048) return json({ error: "API 请求过大" }, 413);
  const body = (() => { try { return JSON.parse(raw) as { apiKey?: unknown; apiSecret?: unknown }; } catch { return {}; } })();
  if (typeof body.apiKey !== "string" || typeof body.apiSecret !== "string") return json({ error: "请完整填写 API Key 和 Secret" }, 400);
  return stream.fetch("https://market-stream/credentials", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: body.apiKey, apiSecret: body.apiSecret, environment: "live" }),
  });
}

async function ownerPaperAction(request: Request, env: CloudflareEnv, action: "RESET" | "CLEAR_HISTORY") {
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败" }, 403);
  if (!await ownerAuthenticated(request, env)) return json({ error: "请先登录" }, 401);
  const body = await request.json<{ confirm?: unknown }>().catch(() => ({} as { confirm?: unknown }));
  const expected = action === "RESET" ? "RESET_PAPER" : "CLEAR_PAPER_HISTORY";
  if (body.confirm !== expected) return json({ error: "确认参数无效" }, 400);
  const path = action === "RESET" ? "/paper-reset" : "/paper-history-clear";
  const response = await env.MARKET_STREAM.getByName("primary").fetch(`https://market-stream${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  if (response.ok) {
    runtimeCache = null;
    historyCache.clear();
    accountLogCache = null;
  }
  return response;
}

const worker = {
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (isAsset(url.pathname)) return env.ASSETS.fetch(request);
    const memberResponse=await memberRoutes(request,env);
    if(memberResponse)return memberResponse;
    if (url.pathname === "/__health") {
      const started = performance.now();
      const response = await env.MARKET_STREAM.getByName("primary").fetch("https://market-stream/health-status");
      const runtime = await response.json<Record<string, unknown>>();
      const live = runtimeReady(runtime as RuntimeHealthShape);
      return json({ ok: response.ok && live, ready: live, version: SYSTEM_VERSION, mode: "PAPER", runtime,
        equityCurve:{version:EQUITY_CURVE_VERSION,readOnly:true,automaticLive:false,defaultDays:7,source:"saved-cost-adjusted-equity"},
        records:{version:"compact-records-pnl-v1",recent:10,archive:50,settlement:"gate-close-settlement-v1"},
        members:{version:MEMBERS_VERSION,configured:!!env.MEMBERS&&!!env.MEMBER_EXECUTION,ownerOnlyIssuer:true,
          executionIsolation:true,guestProgramAccess:false},topLevelCpuMs: performance.now() - started }, live ? 200 : 503);
    }
    if (url.pathname === "/api/runtime" && request.method === "GET") return runtimeStatus(env, true, await ownerAuthenticated(request, env));
    if (url.pathname === "/api/forward/export" && request.method === "GET") return env.MARKET_STREAM.getByName("primary").fetch("https://market-stream/forward-export");
    if (url.pathname === "/api/forward/equity" && request.method === "GET") return env.MARKET_STREAM.getByName("primary").fetch(`https://market-stream/forward-equity${url.search}`);
    if (url.pathname === "/api/forward/archive" && request.method === "GET") return env.MARKET_STREAM.getByName("primary").fetch(`https://market-stream/forward-archive${url.search}`);
    if (url.pathname === "/api/history" && request.method === "GET") return paperHistory(url, env);
    if (url.pathname === "/api/account-logs" && request.method === "GET") return accountLogs(env);
    if (url.pathname === "/api/strategy-logs" && request.method === "GET") return strategyRuntimeLogs(url, env);
    if (url.pathname === "/api/auth/session" && request.method === "GET") return authSession(request, env);
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      const response=await ownerLogin(request, env);
      if(response.ok)response.headers.append("Set-Cookie",clearMemberCookie());
      return response;
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") return ownerLogout(request);
    if (url.pathname === "/api/live/history" && request.method === "GET") {
      if(!await ownerAuthenticated(request,env))return json({error:"请先登录"},401);
      return env.MARKET_STREAM.getByName("primary").fetch("https://market-stream/live-history");
    }
    if (url.pathname === "/api/live/status" && request.method === "GET") return ownerLiveStatus(request, env);
    if (url.pathname === "/api/live/source" && request.method === "GET") return ownerLiveSource(request, env);
    if (url.pathname === "/api/live/mode" && request.method === "POST") return ownerLiveMode(request, env);
    if (url.pathname === "/api/live/credentials" && ["GET", "PUT", "DELETE"].includes(request.method)) return ownerLiveCredentials(request, env);
    if (url.pathname === "/api/paper/reset" && request.method === "POST") return ownerPaperAction(request, env, "RESET");
    if (url.pathname === "/api/paper/history/clear" && request.method === "POST") return ownerPaperAction(request, env, "CLEAR_HISTORY");
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    const pageResponse=await handler.fetch(request, env, ctx);
    if(request.method!=="GET")return pageResponse;
    const contentType=pageResponse.headers.get("content-type")??"";
    if(!contentType.toLowerCase().includes("text/html"))return pageResponse;
    const headers=new Headers(pageResponse.headers);
    // Deployment replaces hashed client chunks. Never let Safari/iOS reuse an
    // older HTML shell that points at chunks which no longer exist.
    headers.set("Cache-Control","no-store, no-cache, must-revalidate, max-age=0");
    headers.set("Pragma","no-cache");
    headers.set("Expires","0");
    return new Response(pageResponse.body,{status:pageResponse.status,statusText:pageResponse.statusText,headers});
  },
  async scheduled(_controller: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
    ctx.waitUntil(env.MARKET_STREAM.getByName("primary").fetch("https://market-stream/watchdog"));
  },
};
export default worker;
