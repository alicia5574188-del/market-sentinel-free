import {jsonStreamResponse} from "../lib/json-stream.ts";
import {reconcileSourceReduction,sourceReductionTarget,type SourceReduction} from "../lib/live-reduction.ts";
import {reconcileSourceClose,sourceExitFillPrice,SOURCE_EXIT_EXECUTION_POLICY,type SourceExit} from '../lib/live-exit.ts';
import {FIXED_ALLOCATION_EQUITY,FIXED_ALLOCATION_POLICY,fixedLiveBasis,type FixedLiveBasis} from '../lib/fixed-allocation.ts';
import { LiveHistoryReader } from "../lib/live-history-reader.ts";
import {noteWriteKinds,writeKeyBreakdown,writeKindsView,type WriteKindBook,type WriteTag} from "../lib/write-kinds.ts";
/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import handler from "vinext/server/app-router-entry";
import {GatePublicError,fetchActiveContracts,fetchStructureCandles,fetchTickerBbo,fetchUrgentFuturesBook} from "../lib/gate-market.ts";
import { MarketDataHub } from "../lib/market-data-hub.ts";
import { GateRestThrottle } from "../lib/gate-rest-throttle.ts";
import { GateStreamingFeed } from "../lib/gate-stream.ts";
import { CORRELATED_DIRECTION_RISK_CAP, PORTFOLIO_RISK_CAP, remainingStressRisk, STALE_AFTER_MS, SYSTEM_VERSION, type Decision, type LiquidityRoute, type LiquidityZone, type MarketState, type PaperPlan, type PaperPosition, type RangeStructure, type Side } from "../lib/liquidity-core.ts";
import {emptySymbolMemory,type SymbolMemory} from "../lib/liquidity-runtime.ts";
import { arenaProtectionStop, arenaTradePlan, liveMirrorExitRequired } from "../lib/arena-live.ts";
import {type PositionOutboxItem} from "../lib/paper-outbox.ts";
import {paperCycleSummary,startPaperCycle,PAPER_INITIAL_EQUITY,type BankruptcyReport,type PaperCycle} from "../lib/paper-cycle.ts";
import { runtimeReady, emptyAccountStandby, marketDataStale, protectedQuoteDelay, PROTECTED_QUOTE_GRACE_MS, type RuntimeHealthShape } from "../lib/runtime-health.ts";
import { buildLiveEntryIntent, buildLiveStopIntent, GateEntryCancelledError, GateLiveClient, gateMarkedEquity, gatePositionValuation, isGateReadTimeoutError, isGateTransportTimeoutError, LiveEntrySizingError, liveEntryDisposition, liveExitTag, liveOrderId, liveOrderTag, liveStopShouldChase, loadGateLiveClient, type GateLiveOrder, type GateLiveOrderSnapshot, type GateLiveSnapshot, type LiveEntrySizingCode } from "../lib/gate-live.ts";
import { LIVE_SESSION_VERSION, establishLiveScale, reconcileLiveScale, startLiveSession, sourceAfterEnable, sameLiveSession, fenceLiveSourcePolicy, type LiveSession } from "../lib/live-session.ts";
import {liveProtectionPrice,isInverseLiveReceipt,INVERSE_LIVE_EXIT_POLICY} from '../lib/live-source-policy.ts';
import {quantizeMirrorNotional,type GateSizeRules,type SizeDiagnostic} from "../lib/gate-quantity.ts";
import { encryptGateCredentials, gateKeyHint, normalizeGateCredentials, type GateCredentials } from "../lib/credential-vault.ts";
import { credentialMetadata } from "../lib/gate-readonly.ts";
import { MEMBERS_VERSION, digestMember, clearMemberCookie } from "../lib/member-auth.ts";
import { MemberDirectory, type MemberFeed } from "./member-directory.ts";
import { memberExecutionClass } from "./member-executor.ts";
import { memberRoutes } from "./member-routes.ts";
import { pageForwardView } from "../lib/page-runtime-view.ts";
import { repairDoubleCloses, type DoubleCloseRow } from "../lib/double-close-repair.ts";
const LEDGER_REPAIR_KEY = "ledger-repair:double-close-v1";
type LedgerRepairRecord = { version: "double-close-v1"; runs: { at: number; rows: DoubleCloseRow[]; balanceBefore: number; balanceAfter: number; resolvedAfter: number }[] };
import { isAsset, runtimeStatus, paperHistory, accountLogs, strategyRuntimeLogs, ownerAuthenticated, authSession, ownerLogin, ownerLogout, ownerLiveStatus, ownerLiveSource, ownerLiveMode, ownerLiveCredentials, ownerPaperAction } from "./http-handlers.ts";

import { type EventEntryAssessment, type RadarCandidate } from "../lib/market-radar.ts";
import {initialMarketRegimes,normalizeMarketRegimes,type MarketRegimeCandidate,type MarketRegimeState,type ResidentCandleStructure} from "../lib/market-regime.ts";
import {initialStrategyArena,normalizeStrategyArena,type StrategyArenaState} from "../lib/strategy-arena.ts";
import {CANONICAL_PAPER_REFERENCE_EQUITY,initialCanonicalPaperState,normalizeCanonicalPaperState,reconcileCanonicalPaper,type CanonicalPaperState} from "../lib/dual-paper.ts";
import {initialRegimePortfolio,normalizeRegimePortfolio,REGIME_HOURLY_REQUIRED_CANDLES,type RegimePortfolioState} from "../lib/regime-portfolio.ts";
import type { PreviousMarketRegimeCandidate } from "../lib/previous-market-regime.ts";
import {buildRunLogExport,accountLogBook,shadowSignalOf,withResearchColumns} from '../lib/run-log.ts';
import {RUN_LOG_EXPORT_KEY,runLogCapacity,type RunLogExportMark} from '../lib/run-log-capacity.ts';
import {RUNLOG_WIPE_KEY,normalizeWipeRecord,logSinceOf,type RunLogWipeRecord} from '../lib/runlog-wipe.ts';
import {RunLogArchiver} from '../lib/run-log-archiver.ts';
import {ARCHIVE_SEGMENT_SIZE,archiveFileName,buildArchiveFile,countArchive,mergeContinuousOrders,readEquityFor,readMeta,readSegment,readStagesFor,segmentCount,writeMeta,
  type ArchiveCursor,type ArchiveMode,type ArchiveStats,type D1Like} from '../lib/run-log-archive.ts';
import {STAGE_CHANGE_CAP} from '../lib/stage-chronicle.ts';
import {PATH_CAP,pathFlushDue,adoptLegacyPaths,bookFromStoredPaths,commitPathWrite,emptyTradePathBook,exportTradePaths,observeTradePaths,peekPathWrite,pendingPathWrites,pathColumns,TRADE_PATH_INDEX_KEY,TRADE_PATH_KEY,TRADE_PATH_PAGE_PREFIX,type TradePathBook,type TradePathIndex,type TradePathPage} from '../lib/trade-path.ts';
import {emptyOrderJournal,observeOrderJournal,ORDER_JOURNAL_CAP,ORDER_JOURNAL_KEY,restoreOrderJournal,type OrderJournal} from '../lib/order-journal.ts';
import { cancelFundsReset, requestFundsReset } from "../lib/account-reset.ts";
import {ADAPTIVE_ENGINE_VERSION,pageStartedAt,FORWARD_EXECUTION_BBO_CAP,FORWARD_MINUTE_CONFIRMATION_CAP,advanceForward,applyStripCoreReset,stripCoreResetDone,forwardSummary,forwardEquity,freshQuote,forwardUrgentMinuteSymbols,forwardUrgentQuoteSymbols,forwardRestCriticalSymbols,BAR_MS,FORWARD_VERSION,type ForwardState} from "../lib/forward-relations.ts";
import { readForwardStore, prepareForwardWrite, prepareForwardProtectionWrite,
  FORWARD_STORAGE, FORWARD_PROTECTION_STORAGE, FORWARD_PAGED_STATE_VERSION } from "../lib/forward-store.ts";
import { nextProtectionWriteBudget, readProtectionWriteBudget, protectionWriteBudgetView,
  OPTIONAL_WRITE_GUARD_PER_DAY, PAID_PLAN_PLANNED_MONTHLY_ROWS, PAID_DO_INCLUDED_ROWS_PER_MONTH, PAID_PLAN_ROW_SAFETY_LIMIT,
  PRIMARY_PLANNED_DO_ROWS, TWO_MEMBER_PLANNED_DO_ROWS, type ProtectionWriteBudget } from "../lib/forward-write-budget.ts";
import { EquityReader } from "../lib/equity-reader.ts";
import { EQUITY_CURVE_VERSION } from "../lib/equity-curve.ts";
import {LIVE_EQUITY_VERSION,LIVE_EQUITY_SAMPLE_MS,LiveEquityReader,prepareLiveEquity,type LiveEquityHead} from "../lib/live-equity.ts";
import {buildLiveReview,readLiveReviewPage} from '../lib/live-review.ts';
import {adjustInverseLeverage} from '../lib/live-leverage.ts';
import { resourceDay, rollResourceDay, RESOURCE_DAY_POLICY, type ResourceCounters } from "../lib/resource-day.ts";
import {isTransientLiveReadErrorText,liveReadTimeoutDecision} from "../lib/live-read-resilience.ts";
import { LIVE_TURNOVER_PREFIX, LIVE_TURNOVER_VERSION, initialTurnover, validateTurnover, nextFillWindow,
  prepareTurnoverPage, turnoverView, type TurnoverState, type GateConfirmedFill } from "../lib/live-turnover.ts";
import { LIVE_PARITY_VERSION, LIVE_PARITY_PREFIX, buildProportionalMirror, forwardMirrorSources, mirrorPositionRisk,
  sourceLifecycle, mirrorSourceFresh, mirrorCoverage, liveEntryDriftGuard,
  type MirrorSourceTrade, type MirrorReceipt, type MirrorBinding } from "../lib/live-parity.ts";
import { rememberLiveFill, normalizeLiveFills, applyConfirmedFillCosts, type LiveFillNote } from "../lib/live-fill-note.ts";
import { quoteSpreadBps } from "../lib/signal-repeat.ts";
import { summarizeEquity } from "../lib/equity-minutes.ts";
import { collectEquityMinutes, equityGaps, equityMinuteKey, equityMinuteStep, mergeEquityMinutes, sampleEquity, type EquityMinute } from "../lib/equity-minutes.ts";
import {emptyReviewLogCursor,prepareReviewLogWrite,readReviewLog,restoreReviewLog,reviewLogOffload,unopenedRowKey,type ReviewLogCursor} from "../lib/review-log-store.ts";
// Inverse closes that merely follow the shadow are not protective; they may rest 2s.
const MAKER_EXIT_REASONS=new Set(["SHADOW_SOURCE_EXIT"]);
import { makerFirstEntry, makerEntryTag, MakerStateUnknownError, LIVE_MAKER_ENTRY_POLICY, LIVE_MAKER_ENTRY_ENABLED, type MakerResult } from "../lib/live-maker-entry.ts";
import {buildReviewSnapshot, readReviewArchivePage} from "../lib/research-snapshot.ts";
import {withLivingEpoch} from "../lib/living/run-log-fields.ts";
import {readLivingLog,countLivingLog} from "../lib/living/runlog-d1.ts";
import {buildLivingRunLog} from "../lib/living/runlog-export.ts";
import type {Bucket as LivingBucket,FinalCase as LivingFinalCase} from "../lib/living/runlog.ts";
import {liveExitPriceLimit} from '../lib/live-entry-price.ts';
import {observeLiveAccount,type LiveAccountMark} from '../lib/live-account-view.ts';
import {REVIEW_JOURNAL_KEY,captureTradeReviews,initialReviewJournal,normalizeReviewJournal} from "../lib/review-trace.ts";
declare const __STRATEGY_FINGERPRINT__: string;
const STRATEGY_FINGERPRINT=typeof __STRATEGY_FINGERPRINT__ === "string"?__STRATEGY_FINGERPRINT__:"local-verification";
declare const __FORWARD_BUILD_SHA__: string;
const FORWARD_BUILD_SHA = typeof __FORWARD_BUILD_SHA__ === "string" ? __FORWARD_BUILD_SHA__ : "local-verification";
import {initialStrategyArena as initialPreviousStrategyArena,normalizeStrategyArena as normalizePreviousStrategyArena,type StrategyArenaState as PreviousStrategyArenaState} from "../lib/previous-strategy-arena.ts";

const LOOP_MS = 2_000;
const OWNER_HOME_CACHE_MS = 2_000;
// Whole-system display/health tolerance only. Executable quotes remain guarded
// by the stricter per-symbol STALE_AFTER_MS/freshQuote checks; this must never
// authorize an order from an old price. A few missed 2s polls should not make
// the entire service flap into RECONNECTING.
const SYSTEM_HEALTH_STALE_AFTER_MS = 30_000;
const FEED_HARD_FAILURE_COUNT = 4;
const FEED_HARD_FAILURE_MS = 15_000;
const FEED_RECOVERY_CONFIRMATIONS = 1;
const FEED_QUALITY_WINDOW_MS = 60 * 60_000;
const HEARTBEAT_MS = 30_000;
const UNIVERSE_MS = 10 * 60_000;
const RADAR_MS = 15_000;
const RADAR_ENTRY_STALE_MS = 150_000;
const STRATEGY_CANDLE_GRACE_MS = 8_000;
const WARMUP_SNAPSHOTS = 4;
const MAX_ANCILLARY_CONCURRENCY = 2;
const SCAN_UNIVERSE_SIZE = 30;
// Optional/background writes may yield at this self-imposed cap. Financial
// authority, owner intent and LIVE durability use a separate non-blocking lane
// and are never rejected merely because analytics/cache work used this budget.
const NON_ALARM_WRITE_CAP = OPTIONAL_WRITE_GUARD_PER_DAY;
const WATCHDOG_WRITE_RESERVE = 2_880;
const AUTHORITY_SCHEMA_VERSION = 1;
const DEFAULT_SYMBOLS = ["BTC_USDT", "ETH_USDT", "SOL_USDT"];




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

export type LivePosition = {sourceReduction?:SourceReduction;sourceExit?:SourceExit;
  makerExit?:{tag:string;startedAt:number;orderId?:string|null;filled?:number;price?:number|null;rejected?:boolean;waitedMs?:number;error?:string}} & PaperPosition & Partial<ReturnType<typeof gatePositionValuation>> & {
  exchangeSize: number;
  leverage: number;
  margin: number;
  stopOrderId: string | null;
  stopTag: string | null;
  stopPrice: number | null;
  stopSubmittingAt: number | null;
  replacementStopOrderId?: string | null;
  replacementStopTag?: string | null;
  replacementStopPrice?: number | null;
  replacementStopSubmittingAt?: number | null;
  exitRequestedAt: number | null;
  exchangeUpdatedAt: number;
  parity?: MirrorReceipt;
  exitOrderId?: string | null;
  actualExitPriceVerified?: boolean;
  mirrorSourceId?: string;
};

type LiveEntrySkipCode = LiveEntrySizingCode | "LEVERAGE_REJECTED" | "ENTRY_REJECTED" | "SUBMISSION_UNCONFIRMED"
  | "RETRYING" | "SOURCE_ENDED_EARLY";
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
  fixedBasis?:FixedLiveBasis;
  accountMark?:LiveAccountMark|null;
  equityCurve?:LiveEquityHead|null;
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
  fills?: LiveFillNote[];
};

function initialLiveState(): LiveRuntime {
  return { recordEpochVersion:null,recordEpochAt:null,requestedEnabled: false, operational: false, changedAt: null, lastSyncAt: null, lastError: null,
    equity: null, available: null, credentialConfigured: false, entries: {}, positions: {}, entrySkips: {}, auditEvents: [], fills: [] };
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
  state: "STARTING" | "WARMING" | "LIVE" | "DEGRADED" | "RECONNECTING" | "RECOVERY_REQUIRED" | "IDLE";
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
  criticalWrites: number;
  writeKinds?: WriteKindBook;
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

function initialState(): RuntimeState {
  return {
    version: SYSTEM_VERSION, authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION, mode: "PAPER", state: "STARTING", symbols: DEFAULT_SYMBOLS,
    lastAlarmAt: null, lastSuccessAt: null, lastHeartbeatAt: null, lastStopCheckpointAt: null, nextAlarmAt: null, lastUniverseAt: 0, lastRadarAt: 0,
    lastStrategyCandleAt: 0, lastStrategyLogAt: 0,
    utcDay: day(), dailyStartEquity: PAPER_INITIAL_EQUITY, alarmCount: 0, d1Writes: 0, nonAlarmWrites: 0, criticalWrites: 0, d1RetryAt: 0, d1FailureCount: 0, equityVersion: 0, ancillaryCursor: 0, subrequestCount: 0, maxSubrequestsInAlarm: 0, sequenceRebuilds: 0, lastProcessedSlot: -1, feedFailures: {},
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


function percentile99(values: number[]) {
  if (!values.length) return 0;
  return [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * 0.99) - 1)];
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
  private strategyCandles: Record<string, Awaited<ReturnType<typeof fetchStructureCandles>>> = {};
  private forwardMinuteCandles: Record<string, Awaited<ReturnType<typeof fetchStructureCandles>>> = {};
  private forwardMinuteRetryAt = new Map<string,number>();
  private gateStream = new GateStreamingFeed();
  private gateRestThrottle = new GateRestThrottle();
  private marketHub = new MarketDataHub();
  private forwardMinuteQuoteBars: Record<string,{minute:number;open:number;high:number;low:number;close:number;samples:number;
    firstAt:number;lastAt:number;completed:Array<{time:number;open:number;high:number;low:number;close:number;volume:number}>}> = {};
  private sessionWarmup: Record<string, number> = {};
  /** when a held coin's Gate quote went missing (null = all held coins quoted); see protectedQuoteDelay */
  private protectedMissingSince: number | null = null;
  private contractCatalog = new Map<string, Awaited<ReturnType<typeof fetchActiveContracts>>[number]>();
  /** D1 long-term run-log archive (review only). In-memory driver; never writes DO storage. */
  private runLogArchiver=new RunLogArchiver({
    db:()=>(this.env as {DB?:unknown}).DB?(this.env.DB as unknown as D1Like):null,
    readCold:async ids=>{
      const started=this.forwardState?.startedAt;if(started==null||!ids.length)return [];
      const found=await (this.ctx.storage.get as unknown as (keys:string[])=>Promise<Map<string,import("../lib/forward-relations.ts").Trade>>)(ids.slice(0,128).map(id=>unopenedRowKey(started,id)));
      return [...found.values()].filter(Boolean);
    },
    readEquityDay:async day=>{const rows=await this.ctx.storage.get<EquityMinute[]>(`log:eqmin:${day}`);return Array.isArray(rows)?rows:null;},
  });
  private archiveWork:Promise<void>|null=null;
  private archivePendingCache:{at:number;cursorKey:string;pending:number;records:number}|null=null;
  private authorityReady = true;
  private authorityView = { positions: {} as RuntimeState["positions"], equity: CANONICAL_PAPER_REFERENCE_EQUITY, equityVersion: 0 };
  protected liveClient: GateLiveClient | null = null;
  private optionalWork: Promise<void> | null = null;
  protected forwardState: ForwardState | null = null;
  /** Audit record of the one-time double-close ledger repair (durable key; null = never needed). */
  private ledgerRepair: LedgerRepairRecord | null = null;
  /** Undo trades that were closed twice (living exit + old exit stack). Only acts when duplicate history rows exist, so a
   * later reload finds nothing and changes nothing; every run that did change something is appended to the audit key.
   * The repaired state is written by the next regular forward save (full hot projection). */
  private async repairLedgerOnce(storage: DurableObjectStorage) {
    try {
      this.ledgerRepair = (await storage.get<LedgerRepairRecord>(LEDGER_REPAIR_KEY)) ?? null;
      const s = this.forwardState; if (!s) return;
      const now = Date.now(), out = repairDoubleCloses(s, now);
      if (!out.rows.length) return;
      const record: LedgerRepairRecord = { version: "double-close-v1", runs: [...(this.ledgerRepair?.runs ?? []),
        { at: now, rows: out.rows, balanceBefore: out.balanceBefore, balanceAfter: out.balanceAfter, resolvedAfter: s.resolved }].slice(-5) };
      await storage.put(LEDGER_REPAIR_KEY, record);
      this.ledgerRepair = record;
    } catch (error) {
      console.error("ledger repair skipped", safeError(error));
    }
  }
  /** One-shot run-log wipe (lib/runlog-wipe.ts). null until read; `runlogWipeChecked` caches the durable record. */
  private runlogWipe: RunLogWipeRecord | null = null;
  private runlogWipeChecked = false;
  private runlogWipeError: string | null = null;
  /** Export / status "since": the wipe time once a wipe has started. */
  private logSince(){return logSinceOf(this.runlogWipe);}
  protected forwardError: string | null = null;
  private reviewJournal=initialReviewJournal(0,Date.now());
  private reviewJournalLoaded=false;
  private tradePaths:TradePathBook=emptyTradePathBook(0);
  private tradePathsLoaded=false;
  private tradePathsPending=false;
  private orderJournal:OrderJournal=emptyOrderJournal(0);
  private orderJournalLoaded=false;
  /** False when the journal read threw and was replaced by an empty one, so its id set is not the whole account. */
  private orderJournalComplete=false;
  private orderJournalPending=false;
  private lastEqMinAt=0;
  private eqMinBuf:EquityMinute[]=[];
  /** Review-only logs kept outside the hot forward JSON. Null readyFor = not restored, so nothing is offloaded. */
  private reviewLogCursor:ReviewLogCursor=emptyReviewLogCursor();
  private reviewLogReadyFor:number|null=null;
  private reviewLogBooted=false;
  private reviewLogError:string|null=null;
  private reviewLogRetryAt=0;
  /** True only when every cold not-opened row listed in the index came back on restore. */
  private reviewLogComplete=false;
  private ghostPathsRemoved=0;
  private ghostPathsRemaining=0;
  private ghostPathError:string|null=null;
  private incompleteRowsRemoved=0;
  private incompleteRowsRemaining:number|null=null;
  private incompleteRowError:string|null=null;
  private orphanPathsRemoved=0;
  private orphanPathsRemaining=0;
  private reviewDiagnosticError:string|null=null;
  private forwardBusy = false;
  private forwardProtectionBudget: ProtectionWriteBudget | null = null;
  private forwardCompression: Awaited<ReturnType<typeof prepareForwardWrite>>["compression"] | null = null;
  private equityReader = new EquityReader();
  private liveEquityReader = new LiveEquityReader();
  private liveEquityWritePending=false;
  protected turnoverState: TurnoverState | null = null;
  protected turnoverError: string | null = null;
  protected turnoverAccountKey: string | null = null;
  protected turnoverAccountUser: string | null = null;
  protected turnoverWork: Promise<void> | null = null;
  protected turnoverAttemptAt = 0;
  private turnoverPersisted: {accountKey:string;at:number} | null = null;
  protected nonAlarmPendingWrites = 0;
  protected criticalPendingWrites = 0;
  protected liveSyncWork: Promise<void> | null = null;
  private liveSourceDispatch:Promise<void>|null=null;
  private liveSourceQueued=false;
  private liveLeverageConfirmed=new Map<string,string>();private liveLeverageClient:unknown=null;
  private liveSnapshotCache:GateLiveSnapshot|null=null;
  private liveOrderSnapshotCache:GateLiveOrderSnapshot|null=null;
  private liveOrderAuditAt=0;
  private liveExecution={version:"stable-loop-live-v1",cycles:0,sourceWakeups:0,leverageSkips:0,
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
    // Show already-settled records on the first response after a restart: storage reads only, no Gate call.
    try{await this.historyReader.hydrate({storage:this.ctx.storage,client,now:Date.now(),sinceAt,valid:()=>this.liveClient===client});}catch{/* keep old behaviour */}
    this.historyReader.launch({storage:this.ctx.storage,client,current,now:Date.now(),sinceAt,
      valid:()=>this.liveClient===client,
      reserve:()=>this.runtime.nonAlarmWrites+(this.nonAlarmPendingWrites??0)+256<NON_ALARM_WRITE_CAP,
      persist:async entries=>{
        const reservation=this.reserveNonAlarmWrites(Object.keys(entries).length,256,writeKeyBreakdown(Object.keys(entries)));
        if(!reservation)throw new Error("No optional write reserve");
        try {await this.ctx.storage.transaction(async tx=>{await tx.put(entries);});reservation.finish(true);}
        finally {reservation.finish(false);}
      },waitUntil:p=>this.ctx.waitUntil(p)});
    return this.historyReader.view(current,sinceAt);
  }
  /** Closed records with any settlement already known in memory attached; never fails the caller. */
  protected decoratedLiveHistory():LivePosition[] {
    try{return this.historyReader.decorate(this.liveHistory,this.liveClient??null);}catch{return this.liveHistory;}
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
            auditEvents: saved.live?.auditEvents ?? [], fills: normalizeLiveFills(saved.live?.fills), requestedEnabled: Boolean(saved.live?.requestedEnabled),
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
          if(cachedCatalog?.length)this.contractCatalog=new Map(cachedCatalog.map(row=>[row.symbol,row]));
        }catch{/* cached Gate universe is optional; live refresh will retry */}
      }
      this.resetDailyCounters(Date.now());
      try {
        this.forwardState = await readForwardStore(ctx.storage, Date.now());
        await this.repairLedgerOnce(ctx.storage);
        const overlay=await ctx.storage.get<{writeBudget?:unknown}>(FORWARD_PROTECTION_STORAGE);
        this.forwardProtectionBudget=readProtectionWriteBudget(overlay?.writeBudget);
      }
      catch (error) {
        this.forwardError = safeError(error);
      }
      // Owner intent has its own durable record. Background checkpoints and
      // deployments cannot replace a later OFF with an earlier in-flight ON.
      const intent=await ctx.storage.get<{enabled:boolean;changedAt:number;activation?:LiveSession|null}>(`${LIVE_PARITY_PREFIX}owner-intent`);
      if(intent){this.runtime.live.requestedEnabled=intent.enabled;this.runtime.live.changedAt=intent.changedAt;
        this.runtime.live.activation=intent.activation??null;}
      if(this.runtime.live.requestedEnabled&&!this.runtime.live.activation){
        // One-time rule migration: protect already-bound real positions, but do
        // not catch up any as-yet-unsubmitted position present at deployment.
        const activation=startLiveSession(Date.now(),this.forwardState,true);
        const reservation=this.reserveCriticalWrites(1,"live-session");
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
  protected reserveNonAlarmWrites(writes:number,headroom=0,tag:WriteTag="other") {
    if(!Number.isSafeInteger(writes)||writes<1||!Number.isSafeInteger(headroom)||headroom<0)
      throw new Error("Invalid non-alarm write reservation");
    const roll=()=>{
      if(this.runtime.utcDay)this.resetDailyCounters(Date.now());
      else this.runtime.utcDay=resourceDay(Date.now()); // isolated legacy/test state: retain its existing count
    };
    roll();this.nonAlarmPendingWrites??=0;
    if((this.criticalPendingWrites??0)>0)return null;
    if(!Number.isFinite(this.runtime.nonAlarmWrites)||this.runtime.nonAlarmWrites<0
      ||this.runtime.nonAlarmWrites+this.nonAlarmPendingWrites+writes+headroom>NON_ALARM_WRITE_CAP)return null;
    this.nonAlarmPendingWrites+=writes;
    let finished=false;
    return {finish:(committed:boolean)=>{
      if(finished)return;
      roll();
      if(committed){this.runtime.nonAlarmWrites+=writes;this.noteWriteKind(tag,writes);}
      this.nonAlarmPendingWrites-=writes;finished=true;
    }};
  }

  /** Measurement only (never admission): count committed rows by kind. It rides
   * the existing checkpoint inside runtime, so it adds no storage writes. */
  protected noteWriteKind(tag:WriteTag,writes:number){
    try{this.runtime.writeKinds=noteWriteKinds(this.runtime.writeKinds,Date.now(),tag,writes);}catch{/* measurement must never affect a write */}
  }

  /** Financial authority is not an optional workload. This reservation only
   * accounts rows; it deliberately has no self-imposed daily admission cap.
   * The storage transaction itself remains fail-closed authority. */
  protected reserveCriticalWrites(writes:number,tag:WriteTag="other") {
    if(!Number.isSafeInteger(writes)||writes<1)throw new Error("Invalid critical write reservation");
    const roll=()=>{
      if(this.runtime.utcDay)this.resetDailyCounters(Date.now());
      else this.runtime.utcDay=resourceDay(Date.now());
    };
    roll();this.criticalPendingWrites??=0;
    if(!Number.isFinite(this.runtime.criticalWrites)||this.runtime.criticalWrites<0)
      throw new Error("Critical write accounting invalid");
    this.criticalPendingWrites+=writes;
    let finished=false;
    return {finish:(committed:boolean)=>{
      if(finished)return;
      roll();
      if(committed){this.runtime.criticalWrites+=writes;this.noteWriteKind(tag,writes);}
      this.criticalPendingWrites-=writes;finished=true;
    }};
  }

  private refreshUniverse(now: number, ranked: Awaited<ReturnType<typeof fetchActiveContracts>>) {
    if (ranked.length === 0) throw new Error("contract catalog unavailable: empty active-contract response");
    this.contractCatalog = new Map(ranked.map((row) => [row.symbol, row]));
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
      if(!this.forwardUrgentSymbols().includes(symbol)){
        delete this.forwardMinuteCandles[symbol];delete this.forwardMinuteQuoteBars[symbol];this.forwardMinuteRetryAt.delete(symbol);
      }
      delete this.runtime.tickSize[symbol]; delete this.runtime.contractMeta[symbol];
    }
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

  private regimeContracts(extra: Iterable<string> = []) {
    const out = Object.fromEntries(Object.entries(this.runtime.contractMeta).map(([symbol, row]) => [symbol, {
      ...row, volume24hUsd: this.contractCatalog.get(symbol)?.volume24hUsd ?? 0,
    }]));
    // Living basket coins outside the Gate-resident set: same contract params from the in-memory catalog (no request).
    for (const symbol of extra) {
      if (out[symbol]) continue;
      const row = this.contractCatalog.get(symbol);
      if (row) out[symbol] = { quantoMultiplier: row.quantoMultiplier, maintenanceRate: row.maintenanceRate, leverageMax: row.leverageMax,
        fundingRate: row.fundingRate, enableDecimal: row.enableDecimal, orderSizeMin: row.orderSizeMin, orderSizeMax: row.orderSizeMax,
        marketOrderSizeMax: row.marketOrderSizeMax, volume24hUsd: row.volume24hUsd ?? 0 };
    }
    return out;
  }

  protected reconcileCanonicalMirror(now: number) {
    // Retired arena/regime accounts no longer participate in trading authority.
    // Keep the compatibility checkpoint fields inert until the next storage cleanup.
    void now;
    if(this.forwardState)this.runtime.equity=forwardEquity(this.forwardState,this.regimeQuotes(Date.now()),Date.now()).equity;
    return false;
  }





  /** Owner home: only what the owner page reads (status, paper account, live summary). The serialized body is
   * reused for OWNER_HOME_CACHE_MS so several tabs / quick re-opens do not rebuild the account summary each time.
   * Display only; no storage write, no Gate call. */
  private ownerHomeCache:{body:string;at:number;status:number}|null=null;
  private async ownerHome(){
    const now=Date.now(),c=this.ownerHomeCache;
    if(c&&now-c.at>=0&&now-c.at<OWNER_HOME_CACHE_MS)return new Response(c.body,{status:c.status,headers:{"content-type":"application/json","cache-control":"no-store","x-home-cache":"hit"}});
    await this.ensureAlarm();
    this.launchTurnoverWork(now);
    const live=this.runtime.live;
    const stale=this.marketStale(now);
    const state=this.effectiveHealthState(stale);
    const body=JSON.stringify({version:"owner-home-v1",buildSha:FORWARD_BUILD_SHA,generatedAt:now,state,stale,standby:this.standbyView(),authorityReady:this.authorityReady,
      lastError:this.runtime.lastError,lastSuccessAt:this.runtime.lastSuccessAt,
      realtimeReadiness:this.realtimeReadiness(),
      forward:pageForwardView(this.forwardView(now)),
      liveMirror:this.liveMirrorView(),
      liveMode:{requestedEnabled:live.requestedEnabled,operational:live.operational},
      live:{...live,history:this.decoratedLiveHistory(),mirror:this.liveMirrorView(),
        turnover:turnoverView(this.turnoverState,this.turnoverError,now,live.activation?.enabledAt??null)}});
    this.ownerHomeCache={body,at:now,status:200};
    return new Response(body,{headers:{"content-type":"application/json","cache-control":"no-store","x-home-cache":"miss"}});
  }

  private forwardView(now = Date.now()) {
    const cycleAt = this.forwardState?.lastCycleAt || null;
    const persistedAt = this.forwardState?.storage.persistedAt ?? 0;
    return this.forwardState ? { ...forwardSummary(this.forwardState, this.regimeQuotes(now), now),
      liveMirror: this.liveMirrorView(),
      lastCycleAt: cycleAt,
      storage: { ...this.forwardState.storage, persistedAt, error: this.forwardError } }
      : { version: FORWARD_VERSION, mode: "RECOVERY_REQUIRED", liveEligible: false, lastCycleAt: cycleAt, storage: { persistedAt, error: this.forwardError } };
  }

  private forwardHealth() {
    const s=this.forwardState;
    return {version:FORWARD_VERSION,engineVersion:ADAPTIVE_ENGINE_VERSION,policyVersion:s?.policyVersion??null,
      strategyRemoved:true,liveEligible:false,
      startedAt:s?.startedAt??null,initialEquity:s?.initialEquity??null,balance:s?.balance??null,
      lastCycleAt:s?.lastCycleAt||null,
      resolved:s?.resolved??0,openCount:s?.positions.length??0,
      ledgerRepair:this.ledgerRepair?{version:this.ledgerRepair.version,runs:this.ledgerRepair.runs.map(r=>({at:r.at,rows:r.rows.length,
        ids:r.rows.map(x=>x.id),balanceBefore:r.balanceBefore,balanceAfter:r.balanceAfter,resolvedAfter:r.resolvedAfter}))}:null,
      runlogWipe:this.runlogWipe?{version:this.runlogWipe.version,at:this.runlogWipe.at,phase:this.runlogWipe.phase,doneAt:this.runlogWipe.doneAt,
        passes:this.runlogWipe.passes,adjust:this.runlogWipe.adjust,balanceAtWipe:this.runlogWipe.balanceAtWipe,openAtWipe:this.runlogWipe.openAtWipe,
        cleared:this.runlogWipe.cleared,d1:this.runlogWipe.d1,lastError:this.runlogWipe.lastError}:{pending:false,error:this.runlogWipeError},
      executionBboCapacity:FORWARD_EXECUTION_BBO_CAP,minuteConfirmationCapacity:FORWARD_MINUTE_CONFIRMATION_CAP,
      storage:{persistedAt:s?.storage.persistedAt??0,layout:s?.storage.layout??null,error:this.forwardError}};
  }

  protected liveMirrorView() {
    return {...mirrorCoverage(this.forwardState,this.runtime.live,this.forwardError??this.liveBindingError),
      allocationPolicy:FIXED_ALLOCATION_POLICY,allocationEquity:FIXED_ALLOCATION_EQUITY,
      fixedBasisEstablished:!!this.runtime.live.fixedBasis};
  }

  protected liveDesiredPortfolio(now:number):Record<string,MirrorSourceTrade> {
    if(!this.forwardState)throw new Error("当前模拟账户尚未恢复");
    return forwardMirrorSources(this.forwardState,forwardEquity(this.forwardState,this.regimeQuotes(now),now).equity);
  }

  private currentMirrorSource(id:string) {
    const current=sourceLifecycle(this.forwardState,id),closed=this.mirrorClosures.get(id);
    return current.status==="UNKNOWN"&&closed?{status:"CLOSED" as const,trade:closed}:current;
  }

  private dispatchCommittedLiveSource() {
    if(!this.liveNeedsSync())return;
    this.liveSourceQueued=true;this.liveExecution.sourceWakeups++;
    if(this.liveSourceDispatch)return;
    const work=(async()=>{
      while(this.liveSourceQueued&&this.liveNeedsSync()){
        this.liveSourceQueued=false;
        // A lifecycle received during a private read must get its own pass
        // after that reader, rather than merely joining its old snapshot.
        if(this.liveSyncWork)await this.liveSyncWork.catch(()=>undefined);
        const started=Date.now();this.liveExecution.startedAt=started;this.liveExecution.cycles++;
        try{await this.syncLive(started);}
        catch(error){this.runtime.live.operational=false;this.runtime.live.lastError=safeError(error);
          this.recordLiveAudit({observedAt:Date.now(),symbol:null,planId:null,stage:'LIVE_CONTROL',level:'RECOVERING',
            reason:'源单事件同步暂待恢复，保留所有者开关与唯一订单身份：'+safeError(error),error});}
        finally{this.liveExecution.finishedAt=Date.now();this.liveExecution.lastDurationMs=Date.now()-started;}
      }
    })();
    this.liveSourceDispatch=work;
    this.ctx.waitUntil(work.finally(()=>{if(this.liveSourceDispatch===work)this.liveSourceDispatch=null;}));
  }

  private mirrorQuoteReady(symbol:string,now=Date.now()) {
    const q=this.runtime.evidence[symbol];
    // PAPER entryReady answers whether a NEW simulated order may be created.
    // Once PAPER has already persisted a source trade, LIVE copy must not wait
    // for that strategy-entry gate again. Require only an executable fresh BBO
    // plus contract metadata; all account/risk/drift/session fences remain later.
    return !!q && this.runtime.contractMeta[symbol]!=null
      && freshQuote({bestBid:q.bestBid??0,bestAsk:q.bestAsk??0,observedAt:q.observedAt,fresh:q.fresh},now);
  }

  private async refreshMirrorExecutableQuotes(symbols:string[],now=Date.now()) {
    const due=[...new Set(symbols)].filter(symbol=>!this.mirrorQuoteReady(symbol,now)).slice(0,FORWARD_EXECUTION_BBO_CAP);
    if(!due.length)return;
    for(const symbol of due)this.applyContractMetadata(symbol);
    const executable=due.filter(symbol=>this.runtime.contractMeta[symbol]!=null);
    if(!executable.length)return;
    // The primary alarm refreshes public books before PAPER, then LIVE performs
    // a private Gate account/order snapshot. A slow private read can age that
    // once-valid BBO past freshQuote() before the already-persisted PAPER source
    // reaches sizing. Refresh only the affected Gate books here; do not re-run
    // PAPER admission, strategy ranking or historical signal logic.
    await this.processAdaptiveBooks(Date.now(),executable);
  }

  private async ensureMirrorExecutableQuote(symbol:string,now=Date.now()) {
    if(this.mirrorQuoteReady(symbol,now))return true;
    await this.refreshMirrorExecutableQuotes([symbol],now);
    return this.mirrorQuoteReady(symbol,Date.now());
  }

  private async mirrorSubmitQuote(symbol:string) {
    const now=Date.now(),cached=this.runtime.evidence[symbol],meta=this.runtime.contractMeta[symbol];
    // The normal websocket book is sufficient when it was observed in the last
    // two seconds. A merely "under 10s" quote is good for monitoring but is too
    // close to the freshness edge for the final real-money submission fence.
    if(meta&&cached&&freshQuote({bestBid:cached.bestBid??0,bestAsk:cached.bestAsk??0,
      observedAt:cached.observedAt,fresh:cached.fresh},now,2_000))
      return{bestBid:cached.bestBid!,bestAsk:cached.bestAsk!,observedAt:cached.observedAt,source:"resident" as const};
    this.applyContractMetadata(symbol);
    const currentMeta=this.runtime.contractMeta[symbol];
    if(!currentMeta)throw new Error(`${symbol} Gate合约规格暂不可用`);
    // One lightweight public REST BBO is allowed only at the final LIVE submit
    // boundary. fetchTickerBbo timestamps the successful current Gate response
    // at receipt, so private account/checkpoint latency cannot silently age it.
    const book=await fetchTickerBbo(symbol,this.runtime.tickSize[symbol]??.0001,currentMeta.quantoMultiplier),
      bestBid=book.bids[0]?.price??0,bestAsk=book.asks[0]?.price??0;
    if(!(bestBid>0&&bestAsk>=bestBid))throw new Error(`${symbol} Gate最终可执行盘口不可用`);
    const prior=this.runtime.evidence[symbol];
    if(prior)this.runtime.evidence[symbol]={...prior,midpoint:(bestBid+bestAsk)/2,bestBid,bestAsk,
      observedAt:book.observedAt,fresh:true};
    return{bestBid,bestAsk,observedAt:book.observedAt,source:"rest" as const};
  }

  private async noteEquityMinute(now:number){
    const state=this.forwardState;
    // One point per clock minute: the first tick inside a new minute writes it. (A 60-second throttle from the last
    // write drifted later each time and skipped a whole minute every so often.)
    const minute=Math.floor(now/60_000)*60_000;
    if(!state||minute<=this.lastEqMinAt)return;
    const positions=state.positions.filter(row=>!row.inverseCopy);
    const sample=sampleEquity({now,balance:state.balance,initial:state.initialEquity,
      liveEquity:typeof this.runtime.live.equity==="number"?this.runtime.live.equity:null,
      symbols:positions.map(row=>row.symbol),
      positions:positions.map(row=>({side:row.side,entryPrice:row.entryPrice,quantity:row.quantity,notional:row.notional,margin:row.margin,lastPrice:row.lastPrice})),
      quotes:this.forwardQuotes(now)});
    // Minutes no tick reached in this process are filled from this mark and flagged; a fresh process starts clean.
    this.eqMinBuf.push(...equityMinuteStep(this.lastEqMinAt>0?this.lastEqMinAt:null,sample));
    this.lastEqMinAt=minute;
    if(this.eqMinBuf.length<5)return;
    const batch=this.eqMinBuf.splice(0,this.eqMinBuf.length);
    const byDay=new Map<string,EquityMinute[]>();
    for(const row of batch){const key=equityMinuteKey(row.ts);const list=byDay.get(key)??[];list.push(row);byDay.set(key,list);}
    const reservation=this.reserveNonAlarmWrites(byDay.size,256,"equity-minute");
    if(!reservation){this.eqMinBuf.unshift(...batch);if(this.eqMinBuf.length>30)this.eqMinBuf.splice(0,this.eqMinBuf.length-30);return;}
    try{
      const entries:Record<string,EquityMinute[]>={};
      for(const [key,rows] of byDay){
        const prev=await this.ctx.storage.get<EquityMinute[]>(key);
        entries[key]=mergeEquityMinutes(prev,rows);
      }
      await this.ctx.storage.put(entries);
      reservation.finish(true);
    }catch{
      reservation.finish(false);
      this.eqMinBuf.unshift(...batch);
      if(this.eqMinBuf.length>30)this.eqMinBuf.splice(0,this.eqMinBuf.length-30);
    }
  }
  /** Once per process: put the cold review logs back into memory. Failure leaves everything hot (old behaviour). */
  private async ensureReviewLog(){
    const state=this.forwardState;
    if(!state||this.reviewLogReadyFor===state.startedAt)return;
    if(this.reviewLogBooted){
      // Account reset/new slot: a new account starts its own cold index; the old account's keys are left untouched.
      this.reviewLogCursor={...emptyReviewLogCursor(),startedAt:state.startedAt};this.reviewLogReadyFor=state.startedAt;this.reviewLogComplete=true;return;
    }
    if(Date.now()<this.reviewLogRetryAt)return;
    try{
      const log=await readReviewLog(this.ctx.storage,state.startedAt);
      const latest=(t:Record<string,{at:number}>|null|undefined)=>Object.values(t??{}).reduce((n,row)=>Math.max(n,row?.at??0),0);
      // A tally rebuilt from history at load can never be newer than the cold copy written before each save.
      if(log.tally&&latest(log.tally)<latest(state.signalTally))log.tally=null;
      restoreReviewLog(state,log);
      this.reviewLogCursor=log.cursor;this.reviewLogReadyFor=state.startedAt;this.reviewLogBooted=true;this.reviewLogError=null;
      this.reviewLogComplete=log.unopenedComplete;
    }catch(error){this.reviewLogError=`REVIEW_LOG_RESTORE:${safeError(error)}`;this.reviewLogRetryAt=Date.now()+60_000;}
  }
  /** Log writes only. Separate from the financial transaction; a failure is recorded and never thrown. */
  private async persistReviewLog(state:ForwardState,now:number){
    try{
      await this.ensureReviewLog();
      if(this.reviewLogReadyFor!==state.startedAt)return;
      const plan=prepareReviewLogWrite(state,now,this.reviewLogCursor);
      if(!plan.writes)return;
      const reservation=this.reserveNonAlarmWrites(plan.writes,256,"review-log");
      if(!reservation)return;
      try{
        if(Object.keys(plan.entries).length)await this.ctx.storage.put(plan.entries);
        if(plan.deletes.length)await this.ctx.storage.delete(plan.deletes);
        reservation.finish(true);this.reviewLogCursor=plan.cursor;this.reviewLogError=null;
      }finally{reservation.finish(false);}
    }catch(error){this.reviewLogError=`REVIEW_LOG_WRITE:${safeError(error)}`;}
  }
  private hotReviewOffload(state:ForwardState){
    try{return this.reviewLogReadyFor===state.startedAt?reviewLogOffload(state,this.reviewLogCursor):undefined;}
    catch{return undefined;}
  }
  private async readEquityMinutes(now:number){
    const rows=await this.ctx.storage.list<EquityMinute[]>({prefix:"log:eqmin:",limit:8,reverse:true});
    const groups:EquityMinute[][]=[];
    for(const value of rows.values())if(Array.isArray(value))groups.push(value.filter(row=>row&&row.ts<=now));
    groups.push(this.eqMinBuf.filter(row=>row.ts<=now));
    return collectEquityMinutes(groups);
  }

  private noteLiveFill(sourceId:string,symbol:string,side:Side,parity:MirrorReceipt|undefined,extra?:{leg?:"ENTRY"|"EXIT";exchangePrice?:number;paperPrice?:number|null;at?:number}){
    try{
      const px=extra?.exchangePrice??parity?.exchangeEntryPrice;
      if(!(typeof px==="number"&&px>0))return;
      const bid=typeof parity?.submitBid==="number"&&parity.submitBid>0?parity.submitBid:null;
      const ask=typeof parity?.submitAsk==="number"&&parity.submitAsk>0?parity.submitAsk:null;
      const paper=extra?.paperPrice??(typeof parity?.sourceEntryPrice==="number"&&parity.sourceEntryPrice>0?parity.sourceEntryPrice:null);
      const leg=extra?.leg??"ENTRY";
      const at=extra?.at??(typeof parity?.exchangeEntryAt==="number"&&parity.exchangeEntryAt>0?parity.exchangeEntryAt:Date.now());
      const slip=paper&&paper>0?Number(((px/paper-1)*10_000*(side==="LONG"?1:-1)*(leg==="EXIT"?-1:1)).toFixed(2)):null;
      this.runtime.live.fills=rememberLiveFill(this.runtime.live.fills,{
        sourceId,symbol,side,leg,paperPrice:paper,exchangePrice:px,bid,ask,
        spreadBps:bid!=null&&ask!=null?quoteSpreadBps(bid,ask):null,slip_bps:slip,
        fee:null,fee_rate:null,role:null,submit_at:typeof parity?.submittedAt==="number"?parity.submittedAt:null,
        at,latency_ms:typeof parity?.submitDelayMs==="number"?parity.submitDelayMs:null,
        paper_at:typeof parity?.sourceOpenedAt==="number"?parity.sourceOpenedAt:null});
    }catch{/* 记下成交不能打断下单 */}
  }

  private async queueLiveBinding(entry:LiveEntry) {
    if(!entry.parity)return;
    const key=`${LIVE_PARITY_PREFIX}binding:${entry.planId}`;
    const existing=(this.liveJournal.get(key) as MirrorBinding|undefined)??await this.ctx.storage.get<MirrorBinding>(key);
    if(!existing)throw new Error("完整模拟源单映射缺失，拒绝提交交易");
    this.liveJournal.set(key,{...existing,receipt:structuredClone(entry.parity)});
  }

  private async ensureTradePaths(){
    const started=this.forwardState?.startedAt??0;
    if(this.tradePathsLoaded&&this.tradePaths.accountStartedAt===started)return;
    try{
      const index=await this.ctx.storage.get<TradePathIndex>(TRADE_PATH_INDEX_KEY);
      if(index?.version==='trade-path-v2'&&index.accountStartedAt===started&&Array.isArray(index.pages)){
        const pages:TradePathPage[]=[];
        for(let offset=0;offset<index.pages.length;offset+=80){
          const keys=index.pages.slice(offset,offset+80).map(page=>`${TRADE_PATH_PAGE_PREFIX}${page}`);
          const found=await (this.ctx.storage.get as unknown as (keys:string[])=>Promise<Map<string,TradePathPage>>)(keys);
          for(const value of found.values())if(value)pages.push(value);
        }
        const known=new Set(index.pages);
        let orphans:TradePathPage[]=[];
        try{orphans=await this.orphanTradePathPages(started,known);}catch{orphans=[];}
        const pageNumbers=[...new Set([...index.pages,...orphans.map(page=>page.page)])];
        this.tradePaths=bookFromStoredPaths(started,{...index,pages:pageNumbers},[...pages,...orphans]);
        if(orphans.length){this.tradePaths.indexDirty=true;this.tradePathsPending=true;}
      }else{
        const legacy=await this.ctx.storage.get<TradePathBook>(TRADE_PATH_KEY);
        this.tradePaths=adoptLegacyPaths(legacy,started);
        if(index?.version==='trade-path-v2'&&Array.isArray(index.pages)){
          const live=new Set(this.tradePaths.trades.map(row=>row.page??0));
          this.tradePaths.drop=index.pages.filter(page=>!live.has(page));
          this.tradePaths.indexDirty=true;
        }
        this.tradePathsPending=peekPathWrite(this.tradePaths)!=null;
      }
    }catch{this.tradePathsLoaded=false;return;}
    this.tradePathsLoaded=true;
  }

  private async orphanTradePathPages(started:number,known:Set<number>){
    const pages:TradePathPage[]=[];
    let cursor:string|undefined;
    for(let guard=0;guard<20;guard++){
      const rows=await this.ctx.storage.list<TradePathPage>({prefix:TRADE_PATH_PAGE_PREFIX,limit:40,...(cursor?{startAfter:cursor}:{})});
      if(!rows.size)break;
      for(const [key,value] of rows){
        cursor=key;
        const page=Number(key.slice(TRADE_PATH_PAGE_PREFIX.length));
        if(!Number.isInteger(page)||known.has(page))continue;
        if(value?.version==='trade-path-v2'&&value.accountStartedAt===started&&Array.isArray(value.trades)){
          pages.push(value);known.add(page);
        }
      }
      if(rows.size<40)break;
    }
    return pages;
  }

  /** Last successful run-log export: one tiny key, written only when an export is served. Display only. */
  private async noteRunLogExport(at:number,rows:number){
    const reservation=this.reserveNonAlarmWrites(1,512,"runlog-export");if(!reservation)return;
    try{await this.ctx.storage.put(RUN_LOG_EXPORT_KEY,{at,rows} satisfies RunLogExportMark);reservation.finish(true);}
    catch{reservation.finish(false);}
  }
  /** Run-log progress and the latest export time that keeps records continuous. Reads only; no writes, no Gate. */
  private async runLogStatus(now:number){
    let mark:RunLogExportMark|null=null;
    try{const saved=await this.ctx.storage.get<RunLogExportMark>(RUN_LOG_EXPORT_KEY);mark=saved&&typeof saved.at==="number"?saved:null;}catch{mark=null;}
    await this.ensureTradePaths();
    await this.ensureOrderJournal();
    const state=this.forwardState!,pathsReady=this.tradePathsLoaded&&this.tradePaths.accountStartedAt===state.startedAt;
    const report=runLogCapacity({now,lastExport:mark,
      counts:[
        ...(pathsReady?[{key:"records",label:"订单记录（含价格路径）",cap:PATH_CAP,times:this.tradePaths.trades.map(row=>row.openedAt)}]:[]),
        ...(this.orderJournalComplete?[{key:"journal",label:"已平订单档案",cap:ORDER_JOURNAL_CAP,times:this.orderJournal.rows.map(row=>row.closed_at??row.opened_at)}]:[]),
        {key:"stages",label:"行情阶段时间线",cap:STAGE_CHANGE_CAP,times:(state.stageChronicle?.changes??[]).map(row=>row.at)}],
      windows:[{key:"equity",label:"每分钟权益",days:8,since:Math.max(state.startedAt,this.logSince()?.at??0)}],
      hot:this.forwardCompression?{rawBytes:this.forwardCompression.rawBytes,budgetBytes:this.forwardCompression.accountBudgetBytes}:null});
    return {...report,pathsReady};
  }
  private async ensureOrderJournal(){
    const started=this.forwardState?.startedAt??0;
    if(this.orderJournalLoaded&&this.orderJournal.accountStartedAt===started)return;
    try{this.orderJournal=restoreOrderJournal(await this.ctx.storage.get<OrderJournal>(ORDER_JOURNAL_KEY),started);this.orderJournalComplete=true;}
    catch{this.orderJournal=emptyOrderJournal(started);this.orderJournalComplete=false;}
    this.orderJournalLoaded=true;
  }

  private async ensureAdaptiveAccount(now:number){
    if(!this.forwardState){this.forwardState=await readForwardStore(this.ctx.storage,now);await this.repairLedgerOnce(this.ctx.storage);}
    if(!this.forwardState)throw new Error("PAPER权威账户缺失");
    await this.ensureReviewLog();
    if(!this.reviewJournalLoaded||this.reviewJournal.accountStartedAt!==this.forwardState.startedAt){
      try{this.reviewJournal=normalizeReviewJournal(await this.ctx.storage.get(REVIEW_JOURNAL_KEY),this.forwardState.startedAt,now);}
      catch{this.reviewJournal=initialReviewJournal(this.forwardState.startedAt,now);this.reviewDiagnosticError="REVIEW_JOURNAL_RESTORE_UNAVAILABLE";}
      this.reviewJournalLoaded=true;
    }
    await this.ensureTradePaths();
    await this.ensureOrderJournal();
    // normalizeForward already upgrades old records in place. Strategy revisions
    // must never close positions, replace startedAt or create a fresh 1000U ledger.
    return false;
  }







  private async persistTradePaths(){
    if(!this.tradePathsLoaded||!this.tradePathsPending)return;
    if(!pathFlushDue(this.tradePaths,Date.now()))return;// batched: changed pages wait in memory until the next flush round
    const jobs=pendingPathWrites(this.tradePaths,8);
    if(!jobs.length){this.tradePathsPending=false;return;}
    const reservation=this.reserveCriticalWrites(jobs.length,"trade-path");
    try{
      await this.ctx.storage.transaction(async transaction=>{
        const entries:Record<string,unknown>={};
        const deletes:string[]=[];
        for(const job of jobs){
          if(job.op==='delete')deletes.push(`${TRADE_PATH_PAGE_PREFIX}${job.page}`);
          else if(job.op==='put')entries[`${TRADE_PATH_PAGE_PREFIX}${job.page}`]=job.value;
          else entries[TRADE_PATH_INDEX_KEY]=job.value;
        }
        if(Object.keys(entries).length)await transaction.put(entries);
        for(const key of deletes)await transaction.delete(key);
      });
      for(const job of jobs)commitPathWrite(this.tradePaths,job);
      reservation.finish(true);
      this.tradePathsPending=peekPathWrite(this.tradePaths)!=null;
    }catch{reservation.finish(false);}
  }


  private async advanceForwardNow(now: number, allowDataCycle = true) {
    void allowDataCycle;
    if (this.forwardBusy) return;
    this.forwardBusy = true;
    try {
      await this.ensureAdaptiveAccount(now);
      await this.loadRunlogWipeRecord();
      const state=this.forwardState!;
      // Open positions are watched every loop; an empty account only needs the slow clock (no strategy runs either way).
      const quoteCadence=state.positions.length>0?LOOP_MS:5_000;
      if(now-state.lastQuoteCycleAt<quoteCadence){
        await this.persistTradePaths();
        return;
      }
      const previous = state,executionQuotes=this.forwardQuotes(now);
      // One-time, owner-authorised paper reset after the strategy system was removed. Paper state only: it never calls Gate and
      // never touches the live channel. If anything live is on or open it waits (nothing is closed or ordered) until the operator
      // has switched live off and Gate is flat; the marker lives in the same persisted write as the reset, so it runs exactly once.
      let engineIn=previous,oneTimeReset=false;
      if(!stripCoreResetDone(previous)){
        const blocker=this.liveMirrorBlocker();
        if(blocker){
          if(this.stripResetBlockedNote!==blocker){this.stripResetBlockedNote=blocker;console.warn(`one-time paper reset waiting: ${blocker}`);}
        }else{
          const reset=applyStripCoreReset(previous,executionQuotes,now);
          if(reset.done){engineIn=reset.state;oneTimeReset=true;this.stripResetBlockedNote=null;}
        }
      }
      const next = advanceForward({ state: engineIn, now, quotes:executionQuotes,contracts:this.regimeContracts(),minutePaths:this.forwardMinutePaths() });
      try{captureTradeReviews(engineIn,next.state,now,FORWARD_BUILD_SHA,STRATEGY_FINGERPRINT,executionQuotes);}
      catch{this.reviewDiagnosticError="TRADE_REVIEW_CAPTURE_FAILED";}
      if(this.tradePathsLoaded){
        this.tradePathsPending=observeTradePaths(this.tradePaths,next.state,executionQuotes,{},now,{},undefined)||this.tradePathsPending;
      }
      this.orderJournalPending=observeOrderJournal(this.orderJournal,next.state.history,next.state.startedAt)||this.orderJournalPending;
      // Write only on a real change (open/close/stop move/funds reset) plus one slow heartbeat per 5 minutes so equity peak and daily rows survive a restart.
      if (oneTimeReset || next.changed || !previous.storage.persistedAt || now-previous.storage.persistedAt>=BAR_MS) {
        next.state.storage = { persistedAt: now, error: null };
        // Review logs first, in their own keys and their own try/catch. Only what is proven durable leaves the hot JSON.
        await this.persistReviewLog(next.state,now);
        const prepared = await prepareForwardWrite(previous.storage.persistedAt ? previous : null, next.state, now, {compact:true,offload:this.hotReviewOffload(next.state)});
        const bound=new Set([...Object.values(this.runtime.live.entries).flatMap(e=>e?.mirrorSourceId?[e.mirrorSourceId]:[]),
          ...Object.values(this.runtime.live.positions).flatMap(p=>p?.mirrorSourceId?[p.mirrorSourceId]:[])]);
        const closures=next.state.history.filter(t=>bound.has(t.id)&&!this.mirrorClosures.has(t.id));
        for(const t of closures)prepared.entries[`${LIVE_PARITY_PREFIX}source-close:${t.id}`]=structuredClone(t);
        const pathJobs=this.tradePathsLoaded&&pathFlushDue(this.tradePaths,now)?pendingPathWrites(this.tradePaths,8):[];
        const pathDeletes:string[]=[];
        for(const job of pathJobs){
          if(job.op==='delete')pathDeletes.push(`${TRADE_PATH_PAGE_PREFIX}${job.page}`);
          else if(job.op==='put')prepared.entries[`${TRADE_PATH_PAGE_PREFIX}${job.page}`]=job.value;
          else prepared.entries[TRADE_PATH_INDEX_KEY]=job.value;
        }
        prepared.writes+=closures.length+pathJobs.length;
        const reservation=this.reserveCriticalWrites(prepared.writes,writeKeyBreakdown(Object.keys(prepared.entries)));
        try {await this.ctx.storage.transaction(async transaction => {
          await transaction.put(prepared.entries);
          for(const key of pathDeletes)await transaction.delete(key);
        });reservation.finish(true);
          for(const job of pathJobs)commitPathWrite(this.tradePaths,job);
          this.tradePathsPending=peekPathWrite(this.tradePaths)!=null;
        }
        finally {reservation.finish(false);}
        next.state.storage.layout=FORWARD_PAGED_STATE_VERSION;next.state.storage.sampleIntegrity="raw-sha256";
        this.forwardCompression=prepared.compression;
        for(const t of closures)this.mirrorClosures.set(t.id,structuredClone(t));
      } else if (next.protectionChanged) {
        const prepared=prepareForwardProtectionWrite(next.state);
        const usage=await this.ctx.storage.transaction(async transaction => {
          const saved=await transaction.get<{writeBudget?:unknown}>(FORWARD_PROTECTION_STORAGE);
          const writeBudget=nextProtectionWriteBudget(saved?.writeBudget,now);
          await transaction.put({[FORWARD_PROTECTION_STORAGE]:{
            ...prepared.entries[FORWARD_PROTECTION_STORAGE],writeBudget}});
          return writeBudget;
        });
        this.forwardProtectionBudget=usage;
      }
      this.forwardState = next.state;
      this.forwardError = null;
      if(this.tradePathsPending)await this.persistTradePaths();
      if(this.orderJournalPending){
        const reservation=this.reserveCriticalWrites(1,"order-journal");
        try{await this.ctx.storage.put(ORDER_JOURNAL_KEY,this.orderJournal);reservation.finish(true);this.orderJournalPending=false;}
        catch{reservation.finish(false);}
      }
      try{await this.noteEquityMinute(now);}catch{/* 权益分钟线写失败不能挡住这一轮 */}
    } catch (error) { this.forwardError = safeError(error); }
    finally { this.forwardBusy = false; }
  }

  /** Read-only: the durable record of a past run-log wipe still sets the export/status "since". Nothing is wiped here any more. */
  private async loadRunlogWipeRecord(){
    if(this.runlogWipeChecked)return;
    try{this.runlogWipe=normalizeWipeRecord(await this.ctx.storage.get(RUNLOG_WIPE_KEY));this.runlogWipeChecked=true;}
    catch(error){this.runlogWipeError=safeError(error);}
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
    try{this.runtime.live.fills=applyConfirmedFillCosts(this.runtime.live.fills,rows);}catch{/* 费用只补在成交备注上，失败不影响成交额 */}
    if(this.liveClient!==client||this.turnoverAccountUser!==accountUser||this.turnoverAccountKey!==key)return;
    const multipliers=Object.fromEntries([...this.contractCatalog].map(([symbol,m])=>[symbol,m.quantoMultiplier]));
    for(const [symbol,m]of Object.entries(this.runtime.contractMeta))multipliers[symbol]=m.quantoMultiplier;
    const prepared=await prepareTurnoverPage({state:previous,window,rows,accountKey:key,storage:this.ctx.storage,multipliers,now,
      sessionStartedAt:this.runtime.live.activation?.enabledAt??null});
    if(this.liveClient!==client||this.turnoverAccountUser!==accountUser||this.turnoverAccountKey!==key||this.turnoverState!==previous)return;
    // Only an unchanged-money, non-paginated scan may advance in memory. Every
    // new fill/dedupe bucket and every pending-page transition remains atomic
    // and immediate. A restart merely rescans the last <=5min of read attempts;
    // already-persisted fill IDs still dedupe, with no invented/lost turnover.
    const persist=prepared.newFills>0||prepared.writes>1||previous.pending!==null||prepared.state.pending!==null
      ||!this.turnoverPersisted.at||now-this.turnoverPersisted.at>=300_000;
    if(persist){
      const reservation=this.reserveNonAlarmWrites(prepared.writes,256,"turnover");
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




  /** True when another batch of pre-cutover archive rows may remain. */
  private async sweepRetiredPaperArchives(sweepKey:string){
    const before=await this.ctx.storage.get<number>(sweepKey);
    if(!(typeof before==="number"&&before>0))return false;
    const prefix=`${FORWARD_STORAGE}archive:`,end=`${prefix}${String(before).padStart(16,"0")}`;
    const rows=await this.ctx.storage.list<unknown>({prefix,end,limit:32});
    const keys=[...rows.keys()];
    if(!keys.length){
      const reservation=this.reserveNonAlarmWrites(1,256,"paper-archive-sweep");if(!reservation)return true;
      try{await this.ctx.storage.delete(sweepKey);reservation.finish(true);}finally{reservation.finish(false);}
      return false;
    }
    const reservation=this.reserveNonAlarmWrites(keys.length,256,"paper-archive-sweep");if(!reservation)return true;
    try{await this.ctx.storage.delete(keys);reservation.finish(true);}finally{reservation.finish(false);}
    return true;
  }

  /** Empty-account standby: nothing held (paper or live mirror) and nothing pending, so there is no price to keep fresh.
   * Pure in-memory read; no Gate call, no write. Any paper position, live position or unfinished live entry ends it,
   * and the ordinary market-freshness check applies again from that very tick. */
  private idleStandby():boolean{
    return emptyAccountStandby({authorityReady:this.authorityReady,forwardLoaded:!!this.forwardState,forwardError:this.forwardError,
      paperPositions:this.forwardState?.positions.length??0,livePositions:this.activeLivePositions().length,
      liveEntries:this.activeLiveEntries().length});
  }
  /** Market-data staleness. In empty-account standby a quiet feed is not a fault. */
  private marketStale(now:number):boolean{
    return marketDataStale({authorityReady:this.authorityReady,standby:this.idleStandby(),lastSuccessAt:this.runtime.lastSuccessAt,now,
      staleAfterMs:SYSTEM_HEALTH_STALE_AFTER_MS});
  }
  private effectiveHealthState(stale:boolean):RuntimeState["state"]{
    return !this.authorityReady?"RECOVERY_REQUIRED":this.idleStandby()?"IDLE":stale?"RECONNECTING":this.runtime.state;
  }
  private standbyView(){return this.idleStandby()?{idle:true,label:"空仓待命",note:"当前无持仓、无实盘持仓/委托，不需要刷新行情；有持仓后自动恢复行情新鲜度检查。"}:null;}

  private stripResetBlockedNote:string|null=null;
  /** Why the one-time paper reset must wait: any live switch/position/entry. Pure in-memory read; no Gate call. */
  private liveMirrorBlocker():string|null{
    const live=this.runtime.live;
    if(live.requestedEnabled||live.operational)return"实盘开关未关闭";
    if(this.activeLivePositions().length)return"实盘镜像仍有持仓";
    if(this.activeLiveEntries().length)return"实盘镜像仍有未完成委托";
    return null;
  }

  private async resetPaperAccount() {
    const now=Date.now();let stage="检查实盘状态",claimed=false;
    try{
      if(this.runtime.live.requestedEnabled||this.runtime.live.operational
        ||Object.values(this.runtime.live.positions).some(position=>position?.status==="OPEN")
        ||Object.values(this.runtime.live.entries).some(entry=>entry&& !["FILLED","CANCELLED"].includes(entry.status)))
        throw new Error("请先关闭实盘并确认 Gate 没有本系统持仓或待成交订单");
      // A tick that is mid-flight would otherwise publish its pre-reset state over the reset one.
      if(this.forwardBusy)throw new Error("模拟账户正在结算这一轮，几秒后再试");
      this.forwardBusy=true;claimed=true;

      stage="读取当前模拟账户";
      if(!this.forwardState){
        try{this.forwardState=await readForwardStore(this.ctx.storage,now);}
        catch(error){
          if(!/部分兑现账本与剩余仓位不一致/.test(safeError(error)))throw error;
          this.forwardState=await readForwardStore(this.ctx.storage,now,{dropRealization:true});
        }
      }
      const previous=this.forwardState;if(!previous)throw new Error("模拟账户尚未恢复");

      stage="写入资金重置";
      // Funds only. No position is closed: with open positions the reset is booked as pending and advanceForward
      // runs it at the first moment the account is flat. startedAt (the log epoch) stays, so the run log is untouched.
      const result=requestFundsReset(previous,now);
      await this.commitForwardAccount(previous,result.state,now);
      if(result.status==="DONE"){try{await this.noteEquityMinute(now);}catch{/* 权益分钟线写失败不挡重置 */}}
      return{ok:true,status:result.status,open:result.open,equity:result.state.balance,reset:result.reset,
        pending:result.state.pendingFundsReset??null,forward:forwardSummary(result.state,this.regimeQuotes(now),now)};
    }catch(error){
      const raw=safeError(error),friendly=/The string did not match the expected pattern/i.test(raw)
        ?"底层存储参数校验失败；原账户保持不变":raw;
      throw new Error(`模拟账户重置失败（${stage}）：${friendly}`);
    }finally{if(claimed)this.forwardBusy=false;}
  }

  /** One atomic write of an operator-edited account (same layout as a tick's commit; run-log side stores untouched). */
  private async commitForwardAccount(previous:ForwardState,next:ForwardState,now:number){
    await this.ensureReviewLog();
    next.storage={persistedAt:now,error:null};
    await this.persistReviewLog(next,now);
    const prepared=await prepareForwardWrite(previous.storage.persistedAt?previous:null,next,now,{compact:true,offload:this.hotReviewOffload(next)});
    const saved=await this.ctx.storage.get<{writeBudget?:unknown}>(FORWARD_PROTECTION_STORAGE);
    const checkpoint=prepareForwardProtectionWrite(next).entries[FORWARD_PROTECTION_STORAGE] as Record<string,unknown>|undefined;
    if(checkpoint){prepared.entries[FORWARD_PROTECTION_STORAGE]=saved?.writeBudget!==undefined?{...checkpoint,writeBudget:saved.writeBudget}:checkpoint;prepared.writes++;}
    const reservation=this.reserveCriticalWrites(prepared.writes,writeKeyBreakdown(Object.keys(prepared.entries)));
    try{
      await this.ctx.storage.transaction(async transaction=>{await transaction.put(prepared.entries);});
      reservation.finish(true);
    }finally{reservation.finish(false);}
    next.storage.layout=FORWARD_PAGED_STATE_VERSION;next.storage.sampleIntegrity="raw-sha256";
    this.forwardCompression=prepared.compression;this.forwardState=next;this.forwardError=null;
    this.forwardProtectionBudget=readProtectionWriteBudget(saved?.writeBudget);
  }

  private async cancelPaperReset() {
    const now=Date.now();
    if(this.forwardBusy)throw new Error("模拟账户正在结算这一轮，几秒后再试");
    this.forwardBusy=true;
    try{
      const previous=this.forwardState;if(!previous)throw new Error("模拟账户尚未恢复");
      if(!previous.pendingFundsReset)return{ok:true,cancelled:false,forward:forwardSummary(previous,this.regimeQuotes(now),now)};
      const result=cancelFundsReset(previous,now);
      await this.commitForwardAccount(previous,result.state,now);
      return{ok:true,cancelled:result.cancelled,forward:forwardSummary(result.state,this.regimeQuotes(now),now)};
    }finally{this.forwardBusy=false;}
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
    const reservation=this.reserveCriticalWrites(1,"live-session");
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

  private async ensureLiveActivationSourceFence(now:number) {
    const activation=this.runtime.live.activation,state=this.forwardState;
    if(this.runtime.live.requestedEnabled&&activation&&state){
      const fenced=fenceLiveSourcePolicy(activation,state,now);
      if(fenced!==activation){
        if(fenced.sourceStartedAt==null)fenced.sourceStartedAt=state.startedAt;
        const reservation=this.reserveCriticalWrites(1,"live-session");
        let committed=false;
        try{await this.ctx.storage.transaction(async tx=>{
          const saved=await tx.get<{enabled:boolean;activation:LiveSession|null}>(LIVE_PARITY_PREFIX+'owner-intent');
          if(!this.runtime.live.requestedEnabled||!sameLiveSession(activation,this.runtime.live.activation)
            ||(saved&&(!saved.enabled||!sameLiveSession(saved.activation,activation))))return;
          await tx.put(LIVE_PARITY_PREFIX+'owner-intent',{
            enabled:true,changedAt:this.runtime.live.changedAt,activation:fenced});committed=true;
        });reservation.finish(committed);}
        finally{reservation.finish(false);}
        if(!committed&&this.runtime.live.requestedEnabled&&sameLiveSession(activation,this.runtime.live.activation))
          throw new Error('实盘源会话与持久化所有者意图未对齐，保留原意图并等待下轮核对');
        if(!committed||!this.runtime.live.requestedEnabled||!sameLiveSession(activation,this.runtime.live.activation))
          return this.runtime.live.activation;
        this.runtime.live.activation=fenced;
        this.recordLiveAudit({observedAt:now,symbol:null,planId:null,stage:'LIVE_CONTROL',level:'INFO',
          reason:'实盘复制源已改成当前模拟的同步爆发和趋势，名义按实盘权益相对模拟权益的比例。已有源单不补开，已绑定实盘继续原来的生命周期，所有者开关保持不变'});
        return fenced;
      }
    }
    if(!this.runtime.live.requestedEnabled||!activation||activation.version!==LIVE_SESSION_VERSION
      ||activation.sourceStartedAt!=null||!state)return activation;
    const repaired:LiveSession={...activation,sourceStartedAt:state.startedAt,
      excludedSourceIds:[...new Set([...(activation.excludedSourceIds??[]),
        ...state.positions.filter(t=>t.openedAt<=activation.enabledAt).map(t=>t.id)])]};
    const reservation=this.reserveCriticalWrites(1,"live-session");
    this.runtime.live.activation=repaired;
    try{
      await this.ctx.storage.put(LIVE_PARITY_PREFIX+"owner-intent",{
        enabled:true,changedAt:this.runtime.live.changedAt,activation:repaired,
      });
      reservation.finish(true);
    }finally{reservation.finish(false);}
    this.recordLiveAudit({observedAt:now,symbol:null,planId:null,stage:"LIVE_CONTROL",level:"INFO",
      reason:"已修复此前在模拟源尚未恢复时建立的空实盘起点；保留原开启时间，不补开开启前持仓，后续新源单恢复正常跟随"});
    return repaired;
  }

  private liveEntryAwaitingReconcile(entry: LiveEntry | null | undefined) {
    if(!entry?.parity || entry.marketSubmittedAt == null) return false;
    // Once this source has a durable LIVE position record (OPEN or CLOSED), the
    // one-shot entry identity itself is resolved. A CLOSED leg that diverges
    // from an still-OPEN PAPER source is classified separately by mirrorCoverage
    // and the post-sync invariant; it must not be charged again as pending risk.
    if(this.runtime.live.positions[entry.symbol]?.id === entry.planId) return false;
    return entry.status === "FILLED" || (entry.status === "CANCELLED" && !entry.submissionResolved);
  }

  protected liveNeedsSync() {
    return this.runtime.live.requestedEnabled
      || Object.values(this.runtime.live.entries).some(entry => entry &&
        (!["FILLED","CANCELLED"].includes(entry.status) || this.liveEntryAwaitingReconcile(entry)))
      || Object.values(this.runtime.live.positions).some(position => position?.status === "OPEN")
      || this.inverseProtectionPending();
  }

  private inverseProtectionPending() {
    return [...Object.values(this.runtime.live.entries),...Object.values(this.runtime.live.positions)].some(record=>record
      &&isInverseLiveReceipt(record.parity)&&(record.stopTag||record.stopOrderId||record.stopSubmittingAt
        ||(record.parity?.nativeProtectionPrice&&record.parity.exitPolicy!==INVERSE_LIVE_EXIT_POLICY)
        ||('replacementStopTag' in record&&(record.replacementStopTag||record.replacementStopOrderId))));
  }

  private async cancelInverseProtection(client:GateLiveClient,snapshot:GateLiveSnapshot) {
    const records=[...Object.values(this.runtime.live.entries),...Object.values(this.runtime.live.positions)]
      .filter((record):record is LiveEntry|LivePosition=>!!record&&isInverseLiveReceipt(record.parity));
    const refs=new Map<string,Set<string>>(),attemptedIds=new Set<string>();let changed=false,error:string|null=null;
    for(const record of records){
      const receipt=record.parity!,identity='planId' in record?record.planId:record.id,
        tags=new Set([...(refs.get(identity)??[]),...(receipt.retiredProtectionTags??[])]),ids=new Set<string>();
      if(record.stopTag)tags.add(record.stopTag);
      if(record.stopOrderId)ids.add(record.stopOrderId);
      if(receipt.nativeProtectionPrice&&receipt.nativeProtectionPrice>0){
        // The old immediate create could reach Gate before its response/stop
        // fields were checkpointed. Recover that exact deterministic identity
        // from the pre-submit receipt, rather than leaving an orphan guard.
        const tick=this.runtime.tickSize[record.symbol]??receipt.nativeProtectionPrice*1e-8;
        tags.add(buildLiveStopIntent({id:identity,symbol:record.symbol,side:record.side,
          currentStop:receipt.nativeProtectionPrice},tick).tag);
      }
      if('replacementStopTag' in record){
        if(record.replacementStopTag)tags.add(record.replacementStopTag);
        if(record.replacementStopOrderId)ids.add(record.replacementStopOrderId);
      }
      // Retain retired identities to cancel an old ambiguous stop that appears
      // late. Do not touch unrelated manual or legacy-source protection.
      if(tags.size&&!receipt.retiredProtectionTags?.every(tag=>tags.has(tag)))changed=true;
      if(tags.size!==(receipt.retiredProtectionTags?.length??0))changed=true;
      receipt.retiredProtectionTags=[...tags];
      if(receipt.exitPolicy!==INVERSE_LIVE_EXIT_POLICY)changed=true;
      receipt.exitPolicy=INVERSE_LIVE_EXIT_POLICY;
      refs.set(identity,tags);
      for(const order of snapshot.priceOrders){
        if(!tags.has(liveOrderTag(order)??'')&&!ids.has(liveOrderId(order)??''))continue;
        const id=liveOrderId(order);
        if(!id){error='反向实盘旧保护单缺少交易所编号，继续核对';continue;}
        if(attemptedIds.has(id))continue;
        attemptedIds.add(id);
        try{await client.cancelOrder('PRICE_TRIGGER',id);}
        catch(e){error=`反向实盘旧保护撤销尚未确认：${safeError(e)}`;}
      }
    }
    const hadOrders=snapshot.priceOrders.some(order=>records.some(record=>
      refs.get('planId' in record?record.planId:record.id)?.has(liveOrderTag(order)??'')
      ||!!record.stopOrderId&&record.stopOrderId===liveOrderId(order)
      ||('replacementStopOrderId' in record&&!!record.replacementStopOrderId&&record.replacementStopOrderId===liveOrderId(order))));
    if(hadOrders){
      try{snapshot=await client.snapshot();}catch(e){
        if(changed)await this.saveCheckpoint(Date.now(),true);
        throw e;
      }
    }
    for(const record of records){
      const tags=refs.get('planId' in record?record.planId:record.id)!;
      const remaining=snapshot.priceOrders.some(order=>tags.has(liveOrderTag(order)??'')
        ||!!record.stopOrderId&&record.stopOrderId===liveOrderId(order)
        ||('replacementStopOrderId' in record&&!!record.replacementStopOrderId&&record.replacementStopOrderId===liveOrderId(order)));
      if(remaining){error??='Gate 尚未确认反向实盘旧保护撤销，下一轮继续核对';continue;}
      if(record.stopSubmittingAt&&Date.now()-record.stopSubmittingAt<6_000){
        error??='反向实盘旧保护提交仍待交易所核对';continue;
      }
      if(record.stopOrderId||record.stopTag||record.stopPrice||record.stopSubmittingAt
        ||('replacementStopTag' in record&&(record.replacementStopTag||record.replacementStopOrderId))){
        record.stopOrderId=null;record.stopTag=null;record.stopPrice=null;record.stopSubmittingAt=null;
        if('replacementStopTag' in record)this.clearLiveStopReplacement(record);
        record.parity!.protectionRemovedAt=Date.now();changed=true;
      }
    }
    if(changed)await this.saveCheckpoint(Date.now(),true);
    return{snapshot,error};
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
    const pendingRisk = Object.values(this.runtime.live.entries).reduce((sum, entry) => sum + (entry
      &&(["SUBMITTING","OPEN","ERROR"].includes(entry.status)||this.liveEntryAwaitingReconcile(entry)) ? entry.plannedRisk : 0), 0);
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
    const pendingRisk = Object.values(this.runtime.live.entries).reduce((sum, entry) => sum + (entry && entry.side===side
      &&(["SUBMITTING","OPEN","ERROR"].includes(entry.status)||this.liveEntryAwaitingReconcile(entry)) ? entry.plannedRisk : 0), 0);
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
    if(isInverseLiveReceipt(entry.parity))return;
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

  private clearLiveStopReplacement(position:LivePosition) {
    position.replacementStopOrderId=null;
    position.replacementStopTag=null;
    position.replacementStopPrice=null;
    position.replacementStopSubmittingAt=null;
  }

  private async promoteLiveStopReplacement(position:LivePosition) {
    const id=position.replacementStopOrderId,tag=position.replacementStopTag,price=position.replacementStopPrice;
    if(!id||!tag||!(price&&price>0))return false;
    position.stopOrderId=id;position.stopTag=tag;position.stopPrice=price;position.stopSubmittingAt=null;
    this.clearLiveStopReplacement(position);
    await this.saveCheckpoint(Date.now(),true);
    return true;
  }

  private async ensureLiveStop(client: GateLiveClient, position: LivePosition, openPriceOrders: Awaited<ReturnType<GateLiveClient["snapshot"]>>["priceOrders"]) {
    if(isInverseLiveReceipt(position.parity))return;
    const byIdentity=(tag:string|null|undefined,id:string|null|undefined)=>openPriceOrders.find(order=>
      (!!tag&&liveOrderTag(order)===tag)|| (!!id&&liveOrderId(order)===id))??null;
    const existing=byIdentity(position.stopTag,position.stopOrderId);
    if(existing){
      position.stopOrderId=liveOrderId(existing)??position.stopOrderId;
      position.stopSubmittingAt=null;
    }else if(position.stopOrderId&&!position.stopSubmittingAt){
      position.stopOrderId=null;position.stopTag=null;position.stopPrice=null;
    }

    const replacement=byIdentity(position.replacementStopTag,position.replacementStopOrderId);
    if(replacement){
      position.replacementStopOrderId=liveOrderId(replacement)??position.replacementStopOrderId;
    }

    // Gate rejects editing API-created TP/SL touch orders. Replace instead:
    // keep the confirmed old close-only stop, create/confirm the new close-only
    // stop, then cancel the old one. A cancel fault leaves both protections
    // tracked and never blocks unrelated LIVE entries.
    if(position.replacementStopTag){
      if(replacement&&position.replacementStopOrderId){
        if(existing&&position.stopOrderId&&position.stopOrderId!==position.replacementStopOrderId){
          try{
            await client.cancelOrder("PRICE_TRIGGER",position.stopOrderId);
          }catch(error){
            this.recordLiveAudit({observedAt:Date.now(),symbol:position.symbol,planId:position.id,
              stage:"STOP_UPDATE",level:"RECOVERING",
              reason:`新结构止损已在 Gate 确认，旧保护撤销暂未确认；两张均为 close-only，继续保留并下轮清理：${safeError(error)}`,error});
            return;
          }
        }
        if(await this.promoteLiveStopReplacement(position)){
          this.recordLiveAudit({observedAt:Date.now(),symbol:position.symbol,planId:position.id,
            stage:"STOP_UPDATE",level:"INFO",reason:`新结构止损 ${position.stopPrice} 已确认接管，旧保护已撤销或已不存在`});
        }
        return;
      }

      const pendingAt=position.replacementStopSubmittingAt??0;
      if(pendingAt&&Date.now()-pendingAt<6_000)return;
      if(position.replacementStopOrderId){
        try{
          const inspected=await client.inspectEntry("PRICE_TRIGGER",position.symbol,position.replacementStopTag,position.replacementStopOrderId);
          if(inspected){
            const disposition=liveEntryDisposition(inspected,"PRICE_TRIGGER");
            if(disposition==="OPEN"||disposition==="FILLED")return;
          }
        }catch(error){
          this.recordLiveAudit({observedAt:Date.now(),symbol:position.symbol,planId:position.id,
            stage:"STOP_UPDATE",level:"RECOVERING",
            reason:`新结构止损状态暂时无法核对；旧保护仍保留，不阻塞其他交易：${safeError(error)}`,error});
          return;
        }
      }
      this.clearLiveStopReplacement(position);
      await this.saveCheckpoint(Date.now(),true);
      this.recordLiveAudit({observedAt:Date.now(),symbol:position.symbol,planId:position.id,
        stage:"STOP_UPDATE",level:"RECOVERING",
        reason:"新结构止损在核对窗口内未形成有效保护；旧保护保持不变，后续轮次重新尝试替换"});
      return;
    }

    const tick=this.runtime.tickSize[position.symbol]??position.currentStop*1e-8;
    const stop=buildLiveStopIntent(position,tick);
    if(existing&&position.stopOrderId&&position.stopTag===stop.tag&&position.stopPrice!=null&&Math.abs(position.stopPrice-stop.price)<tick*.5)return;

    if(existing&&position.stopOrderId){
      position.replacementStopTag=stop.tag;
      position.replacementStopPrice=stop.price;
      position.replacementStopOrderId=null;
      position.replacementStopSubmittingAt=Date.now();
      await this.saveCheckpoint(Date.now(),true);
      try{
        position.replacementStopOrderId=await client.createStop(stop);
        await this.saveCheckpoint(Date.now(),true);
        this.recordLiveAudit({observedAt:Date.now(),symbol:position.symbol,planId:position.id,
          stage:"STOP_UPDATE",level:"INFO",
          reason:`新的结构止损 ${stop.price} 已提交确认；旧止损 ${position.stopPrice} 在下一轮确认新单可见后才撤销`});
      }catch(error){
        if(definitiveGateRejection(error)){
          this.clearLiveStopReplacement(position);
          await this.saveCheckpoint(Date.now(),true);
          this.recordLiveAudit({observedAt:Date.now(),symbol:position.symbol,planId:position.id,
            stage:"STOP_UPDATE",level:"RECOVERING",
            reason:`Gate 拒绝新的结构止损；原保护仍有效，本轮不阻塞其他持仓或新单：${safeError(error)}`,error});
        }else{
          this.recordLiveAudit({observedAt:Date.now(),symbol:position.symbol,planId:position.id,
            stage:"STOP_UPDATE",level:"RECOVERING",
            reason:`新结构止损提交结果暂不明确；原保护仍有效，按新标签核对且不重复提交：${safeError(error)}`,error});
        }
      }
      return;
    }

    if(position.stopTag&&position.stopSubmittingAt){
      if(Date.now()-position.stopSubmittingAt<6_000)return;
      const failedAt=Date.now();
      this.recordLiveAudit({observedAt:failedAt,symbol:position.symbol,planId:position.id,
        stage:"STOP_CREATE",level:"FORCED_EXIT",
        reason:`Gate 在止损提交后6秒内仍未返回带标签 ${position.stopTag} 的保护单，已请求市价退出`});
      if(!position.exitRequestedAt){
        position.exitRequestedAt=failedAt;position.exitReason="PROTECTIVE_STOP_CREATE_UNCONFIRMED";
        await client.closePosition(position.symbol,liveExitTag(position.id));
      }
      throw new Error("结构止损提交6秒后仍未确认，已请求市价退出");
    }

    position.stopTag=stop.tag;position.stopPrice=stop.price;position.stopSubmittingAt=Date.now();
    await this.saveCheckpoint(Date.now(),true);
    try{
      position.stopOrderId=await client.createStop(stop);position.stopSubmittingAt=null;
    }catch(error){
      if(!definitiveGateRejection(error)){
        this.recordLiveAudit({observedAt:Date.now(),symbol:position.symbol,planId:position.id,
          stage:"STOP_CREATE",level:"RECOVERING",
          reason:`结构止损提交结果暂不明确；保留标签并核对6秒，不重复挂单也不立即误平仓：${safeError(error)}`,error});
        throw new Error(`结构止损提交结果暂不明确，正在按标签核对：${safeError(error)}`);
      }
      const failedAt=Date.now();
      this.recordLiveAudit({observedAt:failedAt,symbol:position.symbol,planId:position.id,
        stage:"STOP_CREATE",level:"FORCED_EXIT",
        reason:`结构止损挂单失败，系统已请求市价退出：${safeError(error)}`,error});
      if(!position.exitRequestedAt){
        position.exitRequestedAt=failedAt;position.exitReason="PROTECTIVE_STOP_CREATE_FAILED";
        await client.closePosition(position.symbol,liveExitTag(position.id));
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
      // A read-only Gate timeout is retryable because no exchange mutation
      // crossed the network boundary. A first owner-enable timeout occurs only
      // after its intent/fence were saved, so it remains pending and fail-closed;
      // forced OFF cleanup stays strict and receives the error immediately.
      if(!forceEntryCleanup&&isGateReadTimeoutError(error)){
        const decision=liveReadTimeoutDecision(this.liveReadTimeoutStreak);
        this.liveReadTimeoutStreak=decision.streak;
        if(!decision.escalated){
          if(initialEnable){
            this.runtime.live.operational=false;this.runtime.live.lastError=safeError(error);
            this.recordLiveAudit({observedAt:Date.now(),symbol:null,planId:null,stage:"LIVE_CONTROL",level:"RECOVERING",
              reason:"所有者开启意图与起点已保存；首次Gate只读核对超时，保持零新增并由后台继续核对",error});
          }else if(isTransientLiveReadErrorText(this.runtime.live.lastError))this.runtime.live.lastError=null;
          return;
        }
        throw new Error(decision.message!);
      }
      this.liveReadTimeoutStreak=0;
      throw error;
    } finally { if(this.liveSyncWork===work)this.liveSyncWork=null; }
  }

  private sourceExitPersist(position:LivePosition,source:{closedAt?:number|null;exitReason?:string|null;exitPrice:number|null}){
    return async (state:SourceExit)=>{
        position.sourceExit=state;position.exitRequestedAt??=state.observedAt;
        position.exitReason=source.exitReason??'PAPER_SOURCE_EXIT';position.exitOrderId=state.last.orderId;
        Object.assign(position.parity!,{sourceClosedAt:source.closedAt,sourceExitReason:source.exitReason,
          exitExecutionPolicy:state.version,sourceExitPrice:source.exitPrice,exitObservedAt:state.observedAt,
          exitSubmittedAt:state.last.submittedAt,exitDelayMs:Math.max(0,state.last.submittedAt-state.sourceClosedAt),
          exitLimitPrice:state.last.kind==='LIMIT'?Number(state.last.price):null});
        this.runtime.live.positions[position.symbol]=position;await this.saveCheckpoint(Date.now(),true);
      };
  }

  private async executeCommittedSourceClose(client:GateLiveClient,position:LivePosition,contracts:number,observedAt:number){
    // contracts may be refreshed after a maker window
    const lifecycle=this.currentMirrorSource(position.id);
    if(!isInverseLiveReceipt(position.parity)||lifecycle.status!=='CLOSED')return;
    if(position.exitRequestedAt&&!position.sourceExit)return; // retain an older in-flight close identity
    const source=lifecycle.trade,started=Date.now();
    let limit:{price:string;contractsText:string}|null=null;
    if(!position.sourceExit&&contracts>0&&this.mirrorQuoteReady(position.symbol,started)){
      try{
        const q=this.runtime.evidence[position.symbol],size=quantizeMirrorNotional(contracts,1,1,this.runtime.contractMeta[position.symbol]);
        if(size.quantity>0&&Math.abs(size.quantity-contracts)<=Math.max(1e-9,contracts*1e-8))
          limit={price:liveExitPriceLimit(position.side,q.bestBid??0,q.bestAsk??0,this.runtime.tickSize[position.symbol]),contractsText:size.quantityText};
      }catch{/* Missing/stale price metadata cannot delay a committed exit. */}
    }
    const stillClosed=()=>this.runtime.live.positions[position.symbol]?.id===position.id&&this.currentMirrorSource(position.id).status==='CLOSED';
    // Non-urgent source exits rest reduce-only post-only for 2s first; protective
    // and soft-loss exits keep the immediate path. Reduce-only can never flip.
    if(!position.sourceExit&&!position.makerExit&&contracts>0&&MAKER_EXIT_REASONS.has(String(source.exitReason??''))
      &&this.mirrorQuoteReady(position.symbol,started)){
      const q=this.runtime.evidence[position.symbol],size=(()=>{try{return quantizeMirrorNotional(contracts,1,1,this.runtime.contractMeta[position.symbol]);}catch{return null;}})();
      if(size&&size.quantity>0&&Math.abs(size.quantity-contracts)<=Math.max(1e-9,contracts*1e-8)){
        const tag=makerEntryTag(liveExitTag(position.id));
        position.makerExit={tag,startedAt:started};this.runtime.live.positions[position.symbol]=position;await this.saveCheckpoint(Date.now(),true);
        try{
          const r=await makerFirstEntry({placeMaker:(b,f)=>client.placeMakerEntry(b,f),
            inspect:id=>client.inspectEntry('LIMIT',position.symbol,tag,id),cancel:id=>client.cancelOrder('LIMIT',id)},
            {symbol:position.symbol,side:position.side==='LONG'?'SHORT':'LONG',contractsText:size.quantityText,
              bestBid:q.bestBid??0,bestAsk:q.bestAsk??0,tag,beforeSend:stillClosed,reduceOnly:true});
          Object.assign(position.makerExit,{orderId:r.makerOrderId,filled:r.filledContracts,price:r.fillPrice,rejected:r.rejected,waitedMs:r.waitedMs});
          if(position.parity)Object.assign(position.parity,{makerExitPolicy:LIVE_MAKER_ENTRY_POLICY,makerExitFilledContracts:r.filledContracts,
            makerExitPrice:r.fillPrice,makerExitWaitedMs:r.waitedMs});
          if(r.filledContracts>0&&r.fillPrice){
            const now2=Date.now(),prior:SourceExit={version:SOURCE_EXIT_EXECUTION_POLICY,sourceClosedAt:source.closedAt??started,
              sourceExitPrice:source.exitPrice,observedAt:started,initialContracts:contracts,attempt:1,
              knownFilled:r.filledContracts,knownValue:r.filledContracts*r.fillPrice,
              last:{tag,kind:'LIMIT',price:String(r.makerPrice),submittedAt:started,orderId:r.makerOrderId,terminal:true,accounted:true}};
            const current=await client.position(position.symbol),left=Math.abs(Number(current.size));
            await reconcileSourceClose({id:position.id,sourceClosedAt:prior.sourceClosedAt,sourceExitPrice:source.exitPrice,
              actualContracts:Number.isFinite(left)?left:contracts,observedAt:now2,now:now2,limit:null,prior,stillClosed,
              definitiveRejection:definitiveGateRejection,persist:this.sourceExitPersist(position,source),
              inspect:(t,id)=>client.inspectEntry('LIMIT',position.symbol,t,id),
              remaining:async()=>({contracts:Number.isFinite(left)?left:contracts,observedAt:now2}),
              submit:(t,price,guard)=>client.sourceExit(position.symbol,position.side,t,price,guard)});
            return;
          }
        }catch(error){
          // Unknown maker state cannot delay the exit: everything is reduce-only.
          position.makerExit.error=safeError(error);
        }
        await this.saveCheckpoint(Date.now(),true);
        const current=await client.position(position.symbol),left=Math.abs(Number(current.size));
        if(Number.isFinite(left))contracts=left;
        limit=null; // after the 2s maker window, finish immediately
        if(contracts<=0)return;
      }
    }
    await reconcileSourceClose({id:position.id,sourceClosedAt:source.closedAt??started,sourceExitPrice:source.exitPrice,
      actualContracts:contracts,observedAt,now:started,limit,prior:position.sourceExit,stillClosed,definitiveRejection:definitiveGateRejection,
      persist:this.sourceExitPersist(position,source),
      inspect:(tag,id)=>client.inspectEntry('LIMIT',position.symbol,tag,id),
      remaining:async()=>{
        const actual=await client.position(position.symbol),signed=Number(actual.size);
        if(!Number.isFinite(signed)||(signed!==0&&Math.sign(signed)!==(position.side==='LONG'?1:-1)))
          throw new Error(`${position.symbol} 退出仓位方向/数量未确认，保留订单身份`);
        return{contracts:Math.abs(signed),observedAt:Date.now()};
      },
      submit:(tag,price,guard)=>client.sourceExit(position.symbol,position.side,tag,price,guard),
    });
  }

  private async executeCommittedSourceReduction(client:GateLiveClient,position:LivePosition,contracts:number,observedAt:number){
    const source=this.currentMirrorSource(position.id);
    if(position.exitRequestedAt||!position.parity||source.status!=='OPEN'||!source.trade.realization)return;
    let price='0';
    const first=!position.sourceReduction||position.sourceReduction.sourceSequence!==source.trade.realization.sequence;
    if(first&&isInverseLiveReceipt(position.parity)&&this.mirrorQuoteReady(position.symbol)){
      try{const q=this.runtime.evidence[position.symbol];price=liveExitPriceLimit(position.side,q.bestBid??0,q.bestAsk??0,this.runtime.tickSize[position.symbol]);}catch{/* immediate market fallback */}
    }
    await reconcileSourceReduction({source:source.trade,receipt:position.parity,actualContracts:contracts,
      observedAt,now:Date.now(),spec:this.runtime.contractMeta[position.symbol],prior:position.sourceReduction,
      stillOpen:()=>!position.exitRequestedAt&&this.currentMirrorSource(position.id).status==='OPEN',
      inspect:(tag,id)=>client.inspectEntry('LIMIT',position.symbol,tag,id),
      persist:async reduction=>{position.sourceReduction=reduction;this.runtime.live.positions[position.symbol]=position;await this.saveCheckpoint(Date.now(),true);},
      submit:(text,tag,guard)=>client.reducePosition(position.symbol,position.side,text,tag,guard,price)});
  }

  private async prioritizeCommittedSourceCloses(client:GateLiveClient,positions:import('../lib/gate-live.ts').GateLivePosition[],observedAt:number){
    const pending=positions.flatMap(actual=>{
      const p=this.runtime.live.positions[actual.contract??''],signed=Number(actual.size);
      const source=p?this.currentMirrorSource(p.id):null;
      return p?.status==='OPEN'&&isInverseLiveReceipt(p.parity)&&source?.status==='CLOSED'
        &&Number.isFinite(signed)&&signed!==0&&Math.sign(signed)===(p.side==='LONG'?1:-1)
        &&(!p.exitRequestedAt||p.sourceExit)?[{p,contracts:Math.abs(signed),at:source.trade.closedAt??0}]:[];
    }).sort((a,b)=>a.at-b.at);
    // A fault in one symbol cannot hide independent committed exits.
    const errors:unknown[]=[];
    for(const item of pending)try{await this.executeCommittedSourceClose(client,item.p,item.contracts,observedAt);}catch(error){errors.push(error);}
    for(const actual of positions){
      const p=this.runtime.live.positions[actual.contract??''],signed=Number(actual.size);
      if(!p||p.status!=='OPEN'||!isInverseLiveReceipt(p.parity)||!Number.isFinite(signed)||signed===0
        ||Math.sign(signed)!==(p.side==='LONG'?1:-1))continue;
      try{await this.executeCommittedSourceReduction(client,p,Math.abs(signed),observedAt);}catch(error){errors.push(error);}
    }
    if(errors.length)throw errors[0];
  }

  private async syncLiveOnce(now: number, initialEnable = false, forceEntryCleanup = false) {
    // Full account/order authority remains mandatory for additions. Committed
    // source exits can use verified exposure before unrelated reads finish.
    this.reconcileCanonicalMirror(now);
    await this.ensureLiveActivationSourceFence(now);
    const activePositions = Object.values(this.runtime.live.positions).some((position) => position?.status === "OPEN");
    const activeEntries = Object.values(this.runtime.live.entries).some((entry) => entry &&
      (!["FILLED", "CANCELLED"].includes(entry.status) || this.liveEntryAwaitingReconcile(entry)));
    if (!this.runtime.live.requestedEnabled && !activePositions && !activeEntries && !initialEnable && !forceEntryCleanup&&!this.inverseProtectionPending()) return;
    const client = await this.gateLive();
    let snapshot=await client.snapshot((positions,at)=>this.prioritizeCommittedSourceCloses(client,positions,at));
    const protectionCleanup=await this.cancelInverseProtection(client,snapshot);
    snapshot=protectionCleanup.snapshot;
    this.liveOrderSnapshotCache={orders:structuredClone(snapshot.orders),priceOrders:structuredClone(snapshot.priceOrders),checkedAt:snapshot.checkedAt};
    this.liveOrderAuditAt=snapshot.checkedAt;
    this.liveSnapshotCache=structuredClone(snapshot);
    now=Date.now();this.reconcileCanonicalMirror(now);
    let sourceError=this.liveBindingError??this.forwardError;
    let desiredPortfolio:Record<string,MirrorSourceTrade>={};
    try{desiredPortfolio=this.liveDesiredPortfolio(now);}
    catch(error){sourceError=safeError(error);}
    this.turnoverAccountUser=snapshot.account.user==null?null:String(snapshot.account.user);
    const knownTags = new Set([
      ...Object.values(this.runtime.live.entries).flatMap((entry) => entry
        &&(!["FILLED","CANCELLED"].includes(entry.status)||this.liveEntryAwaitingReconcile(entry))
        ? [entry.tag,...(isInverseLiveReceipt(entry.parity)?entry.parity?.retiredProtectionTags??[]
          :[entry.stopTag ?? this.liveEntryStopIntent(entry).tag])] : []),
      ...Object.values(this.runtime.live.positions).flatMap((position) => position?.status === "OPEN"
        ? [position.stopTag,position.replacementStopTag,...(position.parity?.retiredProtectionTags??[])].filter((tag):tag is string=>!!tag) : []),
    ]);
    const trackedEntryIds = new Set(Object.values(this.runtime.live.entries)
      .flatMap((entry) => entry?.exchangeOrderId ? [entry.exchangeOrderId] : []));
    snapshot = forceEntryCleanup
      ? await this.cancelAndConfirmSystemEntries(client, snapshot, trackedEntryIds)
      : await this.cancelAndConfirmSystemEntries(client, snapshot, trackedEntryIds, knownTags);
    this.liveSnapshotCache=structuredClone(snapshot);
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
    let accountError:string|null=null,equity=0,markedEquity:number|null=null;
    try { markedEquity=equity=gateMarkedEquity(snapshot); }catch(error){accountError=safeError(error);}
    const available = Number(snapshot.account.available ?? 0);
    if (!(equity > 0) || !(available >= 0)||!Number.isFinite(available))accountError??="Gate 合约账户权益不可用";
    if (snapshot.account.in_dual_mode === true || ["dual", "dual_plus"].includes(String(snapshot.account.position_mode ?? "").toLowerCase())) {
      throw new Error("Gate 当前不是单向持仓模式");
    }
    this.runtime.live.equity = markedEquity;
    this.runtime.live.available = Number.isFinite(available)&&available>=0?available:null;
    this.runtime.live.lastSyncAt = snapshot.checkedAt;
    if(markedEquity!==null)this.runtime.live.accountMark=observeLiveAccount(snapshot,
      this.runtime.live.activation?.enabledAt??0,this.runtime.live.accountMark);

    const exchangeOrders = [...snapshot.orders, ...snapshot.priceOrders];
    const unknownOrders = exchangeOrders.filter((order) => !knownTags.has(liveOrderTag(order) ?? ""));
    const actualPositions = snapshot.positions.filter((position) => Number(position.size ?? 0) !== 0);
    const unmanagedPositions = actualPositions.filter((actual) => {
      const symbol = actual.contract ?? "";
      const side: Side = Number(actual.size ?? 0) > 0 ? "LONG" : "SHORT";
      const position = this.runtime.live.positions[symbol];
      const entry = this.runtime.live.entries[symbol];
      const entryCanOwnExposure=entry?.side===side&&(!entry.parity||entry.marketSubmittedAt!=null)
        &&(["SUBMITTING","OPEN","FILLED","ERROR"].includes(entry.status)
          ||(entry.status==="CANCELLED"&&(now-entry.createdAt<60_000||this.liveEntryAwaitingReconcile(entry))));
      return !(position?.status==="OPEN"&&position.side===side)&&!entryCanOwnExposure;
    });
    if (initialEnable && (unknownOrders.length || unmanagedPositions.length)) {
      throw new Error("Gate 已有未纳管仓位或挂单；执行暂停，所有者的开启选择保留");
    }

    for (const [symbol, entry] of Object.entries(this.runtime.live.entries)) {
      if (!entry || (entry.status==="FILLED"&&!this.liveEntryAwaitingReconcile(entry))
        || (entry.status==="CANCELLED"&&!this.liveEntryAwaitingReconcile(entry))) continue;
      const actualForEntry=actualPositions.find(p=>p.contract===symbol&&Number(p.size??0)!==0
        &&Math.sign(Number(p.size))===(entry.side==="LONG"?1:-1));
      if(entry.parity&&entry.marketSubmittedAt!=null&&actualForEntry){
        entry.status="FILLED";entry.submissionResolved=true;entry.missingSince=null;entry.lastError=null;
        const px=Number(actualForEntry.entry_price);
        if(entry.parity&&Number.isFinite(px)&&px>0){
          const source=this.currentMirrorSource(entry.planId).trade;
          if(source){const drift=liveEntryDriftGuard(source,px);Object.assign(entry.parity,{
            exchangeEntryPrice:px,exchangeEntryAt:snapshot.checkedAt,exchangeEntryDriftRate:drift.adverse});}
          this.noteLiveFill(entry.planId,symbol,entry.side,entry.parity);
        }
        continue;
      }
      if(entry.parity&&entry.marketSubmittedAt==null&&["SUBMITTING","ERROR"].includes(entry.status)
        &&now-entry.createdAt>=6_000){
        entry.status="CANCELLED";entry.submissionResolved=true;entry.missingSince=null;
        entry.lastError="实盘执行在订单提交网络边界之前中断；已确认没有提交订单，可由同一持久化模拟源重新进入本轮执行";
        this.recordLiveAudit({observedAt:now,symbol,planId:entry.planId,stage:"ENTRY_SUBMIT",level:"INFO",reason:entry.lastError});
        continue;
      }
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
        } else if (now - entry.missingSince >= 6_000) {
          entry.status = "CANCELLED";
          const reason = `Gate 在提交后6秒内未返回订单 ${entry.tag}，本计划不自动重放，避免重复开仓`;
          entry.lastError = reason;
          this.runtime.live.entrySkips[symbol] = { planId: entry.planId, symbol, code: "SUBMISSION_UNCONFIRMED", reason, observedAt: now };
          this.recordLiveAudit({ observedAt: now, symbol, planId: entry.planId, stage: "ENTRY_SUBMIT",
            level: "SKIPPED", reason });
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
        if (!entry || entry.side!==side || (entry.parity&&entry.marketSubmittedAt==null)
          || (!["SUBMITTING","OPEN","FILLED","ERROR"].includes(entry.status)
            && !(entry.status==="CANCELLED"&&now-entry.createdAt<60_000))) throw new Error(`发现未纳管实盘仓位 ${symbol}`);
        // A completed source can be replaced before an in-flight market order
        // returns. Reconcile the reserved OLD parent first, then close it; never
        // relabel that fill as the replacement or abandon its protection.
        if (!entry.parity && selectedTrade && selectedTrade.id !== entry.planId) throw new Error(`发现与模拟账户订单不一致的实盘仓位 ${symbol}`);
        const entryPrice = Number(actual.entry_price ?? entry.trigger) || entry.trigger;
        const multiplier = this.runtime.contractMeta[symbol]?.quantoMultiplier ?? 1;
        const notional = Math.abs(exchangeSize) * entryPrice * multiplier;
        const leverage = Math.max(1, Number(actual.leverage ?? entry.leverage) || entry.leverage);
        const inverse=isInverseLiveReceipt(entry.parity),expectedStop = inverse?null:this.liveEntryStopIntent(entry);
        const recoveredStop = expectedStop?snapshot.priceOrders.find((order) => liveOrderTag(order) === (entry.stopTag ?? expectedStop.tag)):null;
        position = {
          id: entry.planId, symbol, side, scenario: entry.scenario, entryAt: now, entryPrice,
          initialStop: entry.invalidation, currentStop: entry.invalidation, currentTarget: entry.target,
          plannedRisk: inverse?notional*(entry.parity?.sourceAllocationRiskRate??entry.plannedRisk/entry.notional)
            :notional * (Math.abs(entryPrice - entry.invalidation) / Math.max(entryPrice, 1e-9) + (selectedTrade?.context.modeledCostRate ?? 0.0018)),
          notional, targetScore: entry.targetScore ?? selectedTrade?.context.candidateScore ?? 0,
          targetIdentity: entry.targetIdentity ?? `arena:${entry.planId}`,
          routeId: entry.routeId, routeKind: entry.routeKind, targetTimeframe: entry.targetTimeframe,
          rangeBoundary: entry.rangeBoundary, rangeBuffer: entry.rangeBuffer, sweepExtreme: entry.sweepExtreme,
          reclaimSource: entry.reclaimSource, reclaimStrength: entry.reclaimStrength,
          status: "OPEN", exchangeSize: Math.abs(exchangeSize), leverage, margin: notional / leverage,
          stopOrderId: entry.stopOrderId ?? (recoveredStop ? liveOrderId(recoveredStop) : null),
          stopTag: entry.stopTag ?? expectedStop?.tag??null, stopPrice: entry.stopPrice ?? expectedStop?.price??null,
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
        const sourceForSize=this.currentMirrorSource(position.id),sizeTarget=sourceForSize.status==="OPEN"
          ?sourceReductionTarget(sourceForSize.trade,receipt,receipt.roundedContracts,this.runtime.contractMeta[symbol])?.targetContracts??receipt.roundedContracts
          :receipt.roundedContracts;
        receipt.discrepancy=Math.abs(Math.abs(exchangeSize)-sizeTarget)>1e-8
          ?`交易所实际${Math.abs(exchangeSize)}张，源单剩余比例目标${sizeTarget}张；未声称完整复制`:null;
        const px=Number(actual.entry_price);
        if(Number.isFinite(px)&&px>0){
          position.entryPrice=px;
          const source=receipt.sourceEntryPrice>0?this.currentMirrorSource(position.id).trade:null;
          if(source){
            const actualDrift=liveEntryDriftGuard(source,px);
            receipt.exchangeEntryPrice=px;receipt.exchangeEntryAt=snapshot.checkedAt;
            receipt.exchangeEntryDriftRate=actualDrift.adverse;
            this.noteLiveFill(position.id,symbol,side,receipt);
          }
        }
        position.exchangeSize=Math.abs(exchangeSize);
        position.notional=position.exchangeSize*position.entryPrice*(this.runtime.contractMeta[symbol]?.quantoMultiplier??0);
        position.leverage=Math.max(1,Number(actual.leverage)||receipt.sourceLeverage);
        const reportedMargin=position.exchangeMargin??position.exchangeInitialMargin;
        position.margin=reportedMargin!=null&&reportedMargin>0?reportedMargin:position.notional/position.leverage;
        const expectedLeverage=receipt.executionLeverage??receipt.sourceLeverage;
        if(position.leverage!==expectedLeverage)receipt.discrepancy=`交易所杠杆${position.leverage}×与请求${expectedLeverage}×不同`;
      }
      const selectedTrade = desiredPortfolio[symbol] ?? null;
      const lifecycle=position.parity?this.currentMirrorSource(position.id):null;
      const sourceClosed=lifecycle?.status==="CLOSED";
      if(position.parity&&sourceClosed){
        position.parity.sourceClosedAt=lifecycle.trade.closedAt;
        position.parity.sourceExitReason=lifecycle.trade.exitReason;
      }
      if(isInverseLiveReceipt(position.parity)&&sourceClosed&&(!position.exitRequestedAt||position.sourceExit)){
        await this.executeCommittedSourceClose(client,position,Math.abs(exchangeSize),snapshot.positionsCheckedAt??snapshot.checkedAt);
        continue; // the journal owns this close, including partial/unknown results
      }
      if (!position.exitRequestedAt && (position.parity?sourceClosed:liveMirrorExitRequired(position.id, selectedTrade))) {
        const chase=!position.parity||!this.runtime.live.requestedEnabled||liveStopShouldChase({exitReason:lifecycle?.trade?.exitReason,stop:position.stopPrice,
          closedAt:lifecycle?.trade?.closedAt,now});
        if(!chase){
          this.recordLiveAudit({ observedAt: now, symbol, planId: position.id, stage: "EXIT_REQUEST", level: "INFO",
            reason: `模拟已在保护价退出，实盘限价止损仍可成交，这一拍不改市价去追` });
        }else{
        position.exitRequestedAt = now;
        position.exitReason = sourceClosed?lifecycle!.trade!.exitReason??"PAPER_SOURCE_EXIT":"PAPER_PORTFOLIO_EXIT";
        this.recordLiveAudit({ observedAt: now, symbol, planId: position.id, stage: "EXIT_REQUEST", level: "INFO",
          reason: `模拟源单 ${position.id} 已退出，实盘跟随同一决定：${position.exitReason}` });
        await this.saveCheckpoint(Date.now(),true);
        position.exitOrderId=await client.closePosition(symbol, liveExitTag(position.id));
        }
      } else if (!position.exitRequestedAt && (position.parity?lifecycle?.status==="OPEN":selectedTrade)) {
        position.currentStop = position.parity?liveProtectionPrice(lifecycle!.trade!)??lifecycle!.trade!.stopPrice:arenaProtectionStop(selectedTrade!);
        if(isInverseLiveReceipt(position.parity))position.parity!.sourceAllocationRiskRate=lifecycle!.trade!.plannedRisk/lifecycle!.trade!.notional;
        position.currentTarget = position.parity?lifecycle!.trade!.armPrice:selectedTrade!.targetPrice;
        position.targetScore = selectedTrade?.context.candidateScore??0;
        position.targetIdentity = position.parity?`forward:${position.id}`:`arena:${selectedTrade!.id}`;
        this.runtime.live.positions[symbol] = position;
      }
      if (!position.exitRequestedAt) {
        await this.ensureLiveStop(client, position, snapshot.priceOrders);
        const reducingSource=position.parity?this.currentMirrorSource(position.id):null;
        if(!position.exitRequestedAt&&position.parity&&reducingSource?.status==="OPEN"&&reducingSource.trade.realization){
          await this.executeCommittedSourceReduction(client,position,Math.abs(exchangeSize),snapshot.positionsCheckedAt??snapshot.checkedAt);
        }
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
          verifiedExit=await client.inspectEntry("MARKET",symbol,position.sourceExit?.last.tag??liveExitTag(position.id),position.exitOrderId??null);
          for(const stopRef of [
            {id:position.stopOrderId,tag:position.stopTag},
            {id:position.replacementStopOrderId,tag:position.replacementStopTag},
          ]){
            if(verifiedExit||!stopRef.id)continue;
            const stop=await client.inspectEntry("PRICE_TRIGGER",symbol,stopRef.tag??"",stopRef.id);
            if(stop?.trade_id&&String(stop.trade_id)!=="0")
              verifiedExit=await client.inspectEntry("MARKET",symbol,"",String(stop.trade_id));
          }
        } catch(error){
          this.recordLiveAudit({observedAt:now,symbol,planId:position.id,stage:"POSITION_CLOSED",level:"RECOVERING",
            reason:`交易所仓位已归零，成交价尚待核对，不以模拟价代替：${safeError(error)}`});
        }
      }
      const stopIds=[...new Set([
        position.stopOrderId,
        position.stopTag?liveOrderId(snapshot.priceOrders.find(order=>liveOrderTag(order)===position.stopTag)??{}):null,
        position.replacementStopOrderId,
        position.replacementStopTag?liveOrderId(snapshot.priceOrders.find(order=>liveOrderTag(order)===position.replacementStopTag)??{}):null,
      ].filter((id):id is string=>!!id))];
      for(const stopId of stopIds)await client.cancelOrder("PRICE_TRIGGER",stopId);
      const verifiedPrice=position.sourceExit?sourceExitFillPrice(position.sourceExit)??NaN:Number(verifiedExit?.fill_price),
        verified=Number.isFinite(verifiedPrice)&&verifiedPrice>0;
      const closed:LivePosition = { ...position, status: "CLOSED", exitAt: now,
        exitPrice: position.parity?(verified?verifiedPrice:undefined):this.runtime.evidence[symbol]?.midpoint??position.entryPrice,
        actualExitPriceVerified:position.parity?verified:undefined,
        exitReason: position.exitReason ?? "EXCHANGE_FLAT", stopOrderId: null, stopTag: null, stopPrice: null, stopSubmittingAt: null,
        replacementStopOrderId:null,replacementStopTag:null,replacementStopPrice:null,replacementStopSubmittingAt:null };
      if(closed.parity){
        closed.parity={...closed.parity,actualExitPriceVerified:verified,actualExitOrderId:verifiedExit?liveOrderId(verifiedExit):position.exitOrderId??null};
        const lifecycle=this.currentMirrorSource(position.id);
        const key=`${LIVE_PARITY_PREFIX}binding:${position.id}`;
        const binding=(this.liveJournal.get(key) as MirrorBinding|undefined)??await this.ctx.storage.get<MirrorBinding>(key);
        if(binding)this.liveJournal.set(key,{...binding,receipt:closed.parity,
          ...(lifecycle.status==="CLOSED"?{sourceAtClose:structuredClone(lifecycle.trade)}:{}),actual:closed});
        this.liveJournal.set(`${LIVE_PARITY_PREFIX}closed:${String(now).padStart(16,"0")}:${position.id}`,
          {version:LIVE_PARITY_VERSION,position:closed});
        if(verified)this.noteLiveFill(position.id,symbol,position.side,position.parity,{leg:"EXIT",exchangePrice:verifiedPrice,
          paperPrice:typeof position.parity?.sourceExitPrice==="number"?position.parity.sourceExitPrice:null,at:now});
      }
      this.runtime.live.positions[symbol]=closed;
      this.recordLiveAudit({ observedAt: now, symbol, planId: position.id, stage: "POSITION_CLOSED", level: "INFO",
        reason: `Gate 已确认仓位归零；退出原因 ${position.exitReason ?? "EXCHANGE_FLAT"}` });
      await this.saveCheckpoint(Date.now(),true);
      this.liveHistory=[closed,...this.liveHistory.filter(p=>p.id!==closed.id)].slice(0,40);
    }

    if (!this.runtime.live.requestedEnabled) {
      this.runtime.live.operational = false;
      this.runtime.live.lastError = protectionCleanup.error;
      this.runtime.live.entrySkips = {};
      return;
    }
    if (unknownOrders.length) throw new Error("Gate 存在未纳管挂单；已停止新开仓");
    if(protectionCleanup.error)throw new Error(protectionCleanup.error);
    if(unmanagedPositions.length)throw new Error("Gate 存在未纳管仓位；停止新增复制，保留已纳管保护");
    if(sourceError)throw new Error(`当前模拟复制源尚待恢复：${sourceError}`);
    if(accountError)throw new Error(accountError);
    if(this.forwardError)throw new Error(`模拟状态尚未成功保存：${this.forwardError}；不复制未持久化决定`);

    let recoveringSubmission = Object.values(this.runtime.live.entries)
      .find((entry) => entry && (["SUBMITTING", "ERROR"].includes(entry.status) || this.liveEntryAwaitingReconcile(entry))) ?? null;
    const recoveringStop = Object.values(this.runtime.live.positions)
      .find((position) => position?.status === "OPEN" && position.stopSubmittingAt && !position.stopOrderId) ?? null;
    let recoveringEntryStop = Object.values(this.runtime.live.entries)
      .find((entry) => entry && !["FILLED","CANCELLED"].includes(entry.status)
        &&((entry.stopSubmittingAt&&!entry.stopOrderId)||entry.protectionExitRequestedAt)) ?? null;
    this.runtime.live.operational = !recoveringStop&&!recoveringEntryStop;
    this.runtime.live.lastError = recoveringStop ? `${recoveringStop.symbol} 的结构止损正在按订单标签核对`
      : recoveringEntryStop ? `${recoveringEntryStop.symbol} 的初始保护/强制退出正在 Gate 核对`
      : recoveringSubmission ? (recoveringSubmission.lastError
        ?? `${recoveringSubmission.symbol} 的唯一订单身份仍在 Gate 核对；该笔风险已冻结，其他独立新机会继续执行`) : null;
    if(recoveringStop||recoveringEntryStop) return;
    const unresolvedEntryMargin=Object.values(this.runtime.live.entries).reduce((sum,entry)=>sum+(entry
      &&(["SUBMITTING","OPEN","ERROR"].includes(entry.status)||this.liveEntryAwaitingReconcile(entry)) ? entry.margin : 0),0);
    // A submit whose result is not visible yet may already have consumed Gate
    // margin even when the current account snapshot has not caught up. Reserve
    // that margin locally; once Gate exposes the position, it leaves this
    // pending bucket and the exchange's available balance becomes authoritative.
    let availableForNewEntries = Math.max(0,available-unresolvedEntryMargin);
    // Existing inverse holdings receive the same owner-authorized half-leverage
    // policy. Source exits already ran; one adjustment per complete pass only.
    for(const actual of actualPositions){
      const position=this.runtime.live.positions[actual.contract??''];
      if(!position||!isInverseLiveReceipt(position.parity))continue;
      const result=await adjustInverseLeverage({position,actual,available:availableForNewEntries,now:Date.now(),
        enabled:this.runtime.live.requestedEnabled,sourceOpen:this.currentMirrorSource(position.id).status==='OPEN',
        stillAllowed:()=>this.runtime.live.requestedEnabled&&position.status==='OPEN'&&position.exitRequestedAt==null
          &&this.currentMirrorSource(position.id).status==='OPEN'&&Date.now()-snapshot.checkedAt<=30_000,
        setLeverage:(symbol,target)=>{this.liveLeverageConfirmed.delete(symbol);return client.setLeverage(symbol,target);},
        persist:async()=>{
          const key=`${LIVE_PARITY_PREFIX}binding:${position.id}`,
            binding=(this.liveJournal.get(key) as MirrorBinding|undefined)??await this.ctx.storage.get<MirrorBinding>(key);
          if(!binding)throw new Error('实盘原始绑定尚未恢复，不发送杠杆调整');
          this.liveJournal.set(key,{...binding,receipt:structuredClone(position.parity!),actual:structuredClone(position)});
          await this.saveCheckpoint(Date.now(),true);
        }});
      if(result.attempted){
        availableForNewEntries=Math.max(0,availableForNewEntries-result.reservedMargin);
        this.recordLiveAudit({observedAt:Date.now(),symbol:position.symbol,planId:position.id,stage:'LEVERAGE',
          level:result.error?'RECOVERING':'INFO',reason:result.error??`原持仓杠杆已确认降至${position.leverage}×；数量与名义仓位保持不变`});
        break;
      }
    }
    let riskForNewEntries = this.liveOpenRisk();
    const directionRiskForNewEntries: Record<Side, number> = {
      LONG: this.liveDirectionalRisk("LONG"),
      SHORT: this.liveDirectionalRisk("SHORT"),
    };
    let marginForNewEntries = [
      ...Object.values(this.runtime.live.positions).filter((position) => position?.status === "OPEN"),
      ...Object.values(this.runtime.live.entries).filter((entry) => entry
        &&(["SUBMITTING","OPEN","ERROR"].includes(entry.status)||this.liveEntryAwaitingReconcile(entry))),
    ].reduce((sum, item) => sum + (item?.margin ?? 0), 0);
    let notionalForNewEntries=[...Object.values(this.runtime.live.positions).filter(p=>p?.status==="OPEN"),
      ...Object.values(this.runtime.live.entries).filter(e=>e
        &&(["SUBMITTING","OPEN","ERROR"].includes(e.status)||this.liveEntryAwaitingReconcile(e)))]
      .reduce((n,p)=>n+(p?.notional??0),0);
    // LIVE sizing depends on the current PAPER equity mark. Refresh every open
    // PAPER source whose executable Gate book aged while the private account
    // snapshot was in flight; otherwise one unrelated stale PAPER holding can
    // block a brand-new eligible source from being copied.
    await this.refreshMirrorExecutableQuotes(this.forwardState!.positions.map(t=>t.symbol),Date.now());
    const paperMark=forwardEquity(this.forwardState!,this.regimeQuotes(Date.now()),Date.now());
    let mirrorRatio=this.runtime.live.activation?.scaleRatio??null;
    const staged: Array<{ symbol: string; plan: PaperPlan; intent: ReturnType<typeof buildLiveEntryIntent>;binding?:MirrorBinding;activation:LiveSession|null;
      sizing:Parameters<typeof buildProportionalMirror>[0] }> = [];
    for (const [symbol, skip] of Object.entries(this.runtime.live.entrySkips)) {
      const trade = desiredPortfolio[symbol] ?? null;
      if (!skip || !trade || trade.id !== skip.planId || now >= trade.openedAt + 45 * 60_000) delete this.runtime.live.entrySkips[symbol];
    }
    const desiredTrades=Object.values(desiredPortfolio).sort((a,b)=>{
      const scoreA=a.forwardSource?.entryContext?.entryScore??0,scoreB=b.forwardSource?.entryContext?.entryScore??0;
      return scoreB-scoreA||b.openedAt-a.openedAt;
    });
    for (const trade of desiredTrades) {
      const symbol = trade.symbol;
      if(!trade.forwardSource)continue; // Legacy sources only drain existing exposure.
      const plan = { ...arenaTradePlan(trade), expiresAt:trade.openedAt+trade.forwardSource.rule.horizon*60_000 };
      const prior = this.runtime.live.entries[symbol],priorPosition=this.runtime.live.positions[symbol];
      if(prior?.planId===plan.id&&prior.marketSubmittedAt!=null
        &&priorPosition?.id===plan.id&&priorPosition.status==="CLOSED"){
        const reason="该模拟源单对应的实盘仓位已经在 Gate 归零；同一源单禁止重复开仓，等待下一笔新模拟源单";
        this.runtime.live.entrySkips[symbol]={planId:plan.id,symbol,code:"SOURCE_ENDED_EARLY",reason,observedAt:now};
        continue;
      }
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
      if(justTriggeredEntry&&this.runtime.live.positions[symbol]?.status!=="OPEN"&&!this.mirrorQuoteReady(symbol))
        await this.ensureMirrorExecutableQuote(symbol,Date.now());
      if (!justTriggeredEntry
        || this.runtime.live.positions[symbol]?.status === "OPEN" || !this.mirrorQuoteReady(symbol)) {
        if(this.runtime.live.positions[symbol]?.id!==trade.id)
          this.runtime.live.entrySkips[symbol]={planId:trade.id,symbol,code:"ECONOMICS",
            reason:!justTriggeredEntry?"此单在本次开启前已存在，不补开；仅跟随开启后新模拟单":"已识别模拟源单，正在主动刷新 Gate 新鲜可执行盘口",observedAt:Date.now()};
        continue;
      }
      const midpoint = this.runtime.evidence[symbol]?.midpoint ?? 0;
      if (!(midpoint > 0)) {
        this.runtime.live.entrySkips[symbol]={planId:plan.id,symbol,code:"RETRYING",
          reason:"模拟源单已识别，但本轮 Gate 可执行中间价无效；未使用旧价，下一轮继续核对",observedAt:Date.now()};
        continue;
      }
      const retainedSkip = this.runtime.live.entrySkips[symbol];
      if (retainedSkip?.planId === plan.id && ["LEVERAGE_REJECTED","ENTRY_REJECTED","SUBMISSION_UNCONFIRMED"].includes(retainedSkip.code)
        && now-retainedSkip.observedAt<60_000) continue;
      if(this.liveEntryAwaitingReconcile(prior)) {
        this.runtime.live.entrySkips[symbol]={planId:plan.id,symbol,code:"SUBMISSION_UNCONFIRMED",
          reason:"此前源单的提交尚待交易所确认，保留原身份和保护，不覆盖为新源单",observedAt:now};
        continue;
      }
      // A non-market or pre-submit prior can still be cancelled/replaced below.
      if (prior && prior.planId === plan.id && prior.status !== "CANCELLED") {
        this.runtime.live.entrySkips[symbol]={planId:plan.id,symbol,code:"RETRYING",
          reason:prior.lastError??`同一模拟源单已有实盘执行记录（${prior.status}），正在核对唯一订单身份，不重复提交`,
          observedAt:Date.now()};
        continue;
      }
      if (prior && !["FILLED", "CANCELLED"].includes(prior.status)) await this.cancelLiveEntry(client, prior);
      let intent: ReturnType<typeof buildLiveEntryIntent>;
      let binding:MirrorBinding|undefined;
      let sizing:Parameters<typeof buildProportionalMirror>[0];
      try {
        if(paperMark.stalePositions)throw new LiveEntrySizingError("ECONOMICS",symbol,"模拟账户当前估值不完整，不能确定复制比例");
        const inverse=!!trade.forwardSource.inverseCopy;
        const scaled=inverse?this.runtime.live.activation:await this.ensureLiveSessionScale(paperMark.equity,equity,Date.now());
        // 同步爆发和趋势按当时锁定的实盘权益/模拟权益缩放名义，不按模拟单原名义一比一。
        if(inverse){
          const prior=this.runtime.live.fixedBasis,basis=fixedLiveBasis(prior,equity,
            String(snapshot.account.user??this.runtime.live.turnoverAccountKey??'program-account'),Date.now());
          if(!prior){this.runtime.live.fixedBasis=basis;
            try{await this.saveCheckpoint(Date.now(),true);}catch(error){delete this.runtime.live.fixedBasis;throw error;}}
        }
        mirrorRatio=inverse?this.runtime.live.fixedBasis!.liveEquity/FIXED_ALLOCATION_EQUITY:scaled?.scaleRatio??equity/paperMark.equity;
        const expectedLiveEquity=paperMark.equity*mirrorRatio;
        const liveEquityDrift=expectedLiveEquity>0?equity/expectedLiveEquity:0;
        if(!inverse&&liveEquityDrift<.85)throw new LiveEntrySizingError("ECONOMICS",symbol,
          `实盘权益已低于固定模拟比例预期的${(liveEquityDrift*100).toFixed(1)}%，暂停新增复制并保留已有保护`);
        const quote=this.runtime.evidence[symbol];
        const executablePrice=plan.side==='LONG'?quote?.bestAsk??0:quote?.bestBid??0;
        sizing={source:trade.forwardSource,sourceEquity:inverse?FIXED_ALLOCATION_EQUITY:paperMark.equity,equity,
          available:availableForNewEntries,openRisk:riskForNewEntries,sameDirectionRisk:directionRiskForNewEntries[plan.side],
          entryPrice:executablePrice,
          quantoMultiplier:this.runtime.contractMeta[symbol]?.quantoMultiplier??0,
          leverageMax:this.runtime.contractMeta[symbol]?.leverageMax??0,maintenanceRate:this.runtime.contractMeta[symbol]?.maintenanceRate??0.005,
          openMargin:marginForNewEntries,openNotional:notionalForNewEntries,now:Date.now(),policy:this.forwardState!.policyVersion??this.forwardState!.version,
          sizeRules:this.runtime.contractMeta[symbol],activationAt:this.runtime.live.activation?.enabledAt,
          mirrorRatio,sourceRiskAuthority:true,quoteObservedAt:quote?.observedAt};
        const result=buildProportionalMirror(sizing);
        intent=result.intent;binding=result.binding;
        if(inverse){binding.receipt.entryPricePolicy='fresh-market-v1';delete binding.receipt.allowedAdverseEntryDriftRate;
          binding.receipt.fixedAllocationPolicy=FIXED_ALLOCATION_POLICY;binding.receipt.fixedLiveEquity=this.runtime.live.fixedBasis!.liveEquity;}
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
      staged.push({ symbol, plan, intent, binding,sizing,activation:structuredClone(this.runtime.live.activation??null) });
    }
    for (const { symbol, plan, intent, binding,activation,sizing } of staged) {
      const stagedSource=this.currentMirrorSource(plan.id).trade,
        preflightFailure=!this.runtime.live.requestedEnabled?"所有者已关闭实盘复制"
          :!sameLiveSession(activation,this.runtime.live.activation)?"实盘开启会话在提交前发生变化"
          :!sourceAfterEnable(binding!.sourceAtCopy,this.runtime.live.activation,this.forwardState!.startedAt)?"模拟源单不再属于本次开启会话"
          :!mirrorSourceFresh(stagedSource??undefined,plan.id,Date.now())?"模拟源单在提交前已结束或超过自身持有期限":null;
      if(preflightFailure){
        this.runtime.live.entrySkips[symbol]={planId:plan.id,symbol,code:"RETRYING",
          reason:`${preflightFailure}；未发送 Gate 入场订单`,observedAt:Date.now()};
        continue;
      }
      if(!this.mirrorQuoteReady(symbol)&&!(await this.ensureMirrorExecutableQuote(symbol,Date.now()))){
        this.runtime.live.entrySkips[symbol]={planId:plan.id,symbol,code:"ECONOMICS",
          reason:"模拟源单已持久化，但 Gate 可执行盘口刷新仍未成功；保留源单身份并继续实时重试",observedAt:Date.now()};
        continue;
      }
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
        if(!this.runtime.live.requestedEnabled||!sameLiveSession(activation,this.runtime.live.activation)){
          entry.status="CANCELLED";entry.submissionResolved=true;
          entry.lastError="实盘会话在杠杆设置前发生变化；订单未发送";
          this.runtime.live.entrySkips[symbol]={planId:plan.id,symbol,code:"RETRYING",reason:entry.lastError,observedAt:Date.now()};
          await this.saveCheckpoint(Date.now(),true);continue;
        }
        try {
          // Latency: Gate keeps per-contract leverage. Skip the round trip only
          // when THIS executor already confirmed the same value for the same
          // client and no position is open on the symbol.
          const levKey=`${symbol}:${intent.leverage}`;
          if(!(this.liveLeverageConfirmed.get(symbol)===levKey&&this.liveLeverageClient===client&&this.runtime.live.positions[symbol]?.status!=="OPEN")){
            this.liveLeverageConfirmed.delete(symbol);
            await client.setLeverage(symbol,intent.leverage);
            this.liveLeverageClient=client;this.liveLeverageConfirmed.set(symbol,levKey);
          }else this.liveExecution.leverageSkips=(this.liveExecution.leverageSkips??0)+1;
        } catch (error) {
          const retryable=isGateTransportTimeoutError(error)||!definitiveGateRejection(error);
          const reason=retryable
            ?`Gate 暂未确认 ${symbol} 的 ${intent.leverage}× 杠杆；尚未发送入场订单，保留源单并自动重试：${safeError(error)}`
            :`Gate 拒绝 ${symbol} 的 ${intent.leverage}× 杠杆，本计划暂不提交且不会锁住其他新机会：${safeError(error)}`;
          entry.status="CANCELLED";entry.submissionResolved=true;entry.lastError=reason;
          this.runtime.live.entrySkips[symbol]={planId:plan.id,symbol,code:retryable?"RETRYING":"LEVERAGE_REJECTED",reason,observedAt:Date.now()};
          this.recordLiveAudit({observedAt:Date.now(),symbol,planId:plan.id,stage:"LEVERAGE",level:retryable?"RECOVERING":"SKIPPED",reason,error});
          await this.saveCheckpoint(Date.now(),true);
          continue;
        }
        try {
          // Owner OFF or source CLOSE during leverage/network await takes
          // precedence over the stale staged entry.
          const source=binding!.sourceAtCopy,currentSource=this.currentMirrorSource(plan.id).trade,
            sourceFenceFailure=!this.runtime.live.requestedEnabled?"所有者已关闭实盘复制"
              :!sameLiveSession(activation,this.runtime.live.activation)?"实盘开启会话在杠杆确认期间发生变化"
              :!sourceAfterEnable(source,this.runtime.live.activation,this.forwardState!.startedAt)?"模拟源单不再属于本次开启会话"
              :!mirrorSourceFresh(currentSource??undefined,plan.id,Date.now())?"模拟源单在杠杆确认期间已经结束":null;
          if(sourceFenceFailure){
            entry.status="CANCELLED";entry.submissionResolved=true;entry.lastError=`${sourceFenceFailure}；未发送 Gate 入场订单`;
            this.runtime.live.entrySkips[symbol]={planId:entry.planId,symbol,code:"RETRYING",reason:entry.lastError,observedAt:Date.now()};
            await this.saveCheckpoint(Date.now(),true);continue;
          }
          let submitQuote:{bestBid:number;bestAsk:number;observedAt:number;source:"resident"|"rest"};
          try{submitQuote=await this.mirrorSubmitQuote(symbol);}
          catch(error){
            entry.status="CANCELLED";entry.submissionResolved=true;
            entry.lastError=`最终 Gate 可执行盘口刷新失败：${safeError(error)}；未发送订单，下一轮继续核对`;
            this.runtime.live.entrySkips[symbol]={planId:entry.planId,symbol,code:"RETRYING",reason:entry.lastError,observedAt:Date.now()};
            await this.saveCheckpoint(Date.now(),true);continue;
          }
          const price=entry.side==="LONG"?submitQuote.bestAsk:submitQuote.bestBid;
          if(isInverseLiveReceipt(entry.parity)){
            // Re-price against the SAME final Gate response used for dispatch.
            // Never increase the staged contracts or capital reservation when
            // the book moves while setting leverage/checkpointing.
            const ratio=Math.min(sizing.mirrorRatio!,intent.contracts*source.quantoMultiplier*price/source.notional);
            const repriced=buildProportionalMirror({...sizing,entryPrice:price,mirrorRatio:ratio,
              quoteObservedAt:submitQuote.observedAt,now:Date.now()});
            Object.assign(intent,repriced.intent);
            Object.assign(entry,{size:intent.size,contracts:intent.contracts,notional:intent.notional,
              plannedRisk:intent.plannedRisk,leverage:intent.leverage,margin:intent.margin});
            Object.assign(binding!.receipt,repriced.binding.receipt,{entryPricePolicy:'fresh-market-v1'});
            delete binding!.receipt.allowedAdverseEntryDriftRate;
            entry.parity=structuredClone(binding!.receipt);
            this.liveJournal.set(`${LIVE_PARITY_PREFIX}binding:${plan.id}`,binding!);
          }
          if(!price||(!isInverseLiveReceipt(entry.parity)&&(entry.side==="LONG"?price<=entry.invalidation:price>=entry.invalidation))){
            entry.status="CANCELLED";entry.submissionResolved=true;entry.lastError="最终 Gate 盘口已越过源单止损，未追补旧成交";
            this.runtime.live.entrySkips[symbol]={planId:entry.planId,symbol,code:"ECONOMICS",reason:entry.lastError,observedAt:Date.now()};
            await this.saveCheckpoint(Date.now(),true);continue;
          }
          const drift=liveEntryDriftGuard(source,price);
          if(!isInverseLiveReceipt(entry.parity)&&drift.adverse>drift.allowed+1e-9){
            entry.status="CANCELLED";entry.submissionResolved=true;
            entry.lastError=`最终 Gate 盘口相对模拟入场不利偏差${(drift.adverse*100).toFixed(3)}%，超过动态上限${(drift.allowed*100).toFixed(3)}%，不追价`;
            this.runtime.live.entrySkips[symbol]={planId:entry.planId,symbol,code:"ECONOMICS",reason:entry.lastError,observedAt:Date.now()};
            await this.saveCheckpoint(Date.now(),true);continue;
          }
          const submittedAt=Date.now();
          if(entry.parity)Object.assign(entry.parity,{submitQuoteAt:submitQuote.observedAt,submitQuotePrice:price,submittedAt,
            submitBid:submitQuote.bestBid,submitAsk:submitQuote.bestAsk,
            submitDelayMs:Math.max(0,submittedAt-source.openedAt),
            ...(!isInverseLiveReceipt(entry.parity)?{allowedAdverseEntryDriftRate:drift.allowed}:{}),
            adverseEntryDriftRate:drift.adverse});
          entry.marketSubmittedAt=submittedAt;
          await this.saveCheckpoint(submittedAt,true);
          let finalValidatedAt=Date.now();const submissionStillAllowed=()=>{
            if(!this.runtime.live.requestedEnabled
              ||!sameLiveSession(activation,this.runtime.live.activation)
              ||!sourceAfterEnable(source,this.runtime.live.activation,this.forwardState?.startedAt??0)
              ||!mirrorSourceFresh(this.currentMirrorSource(plan.id).trade??undefined,plan.id,Date.now())
              ||Date.now()-finalValidatedAt>2_500)return false;
            // Re-check any newer in-memory Gate book that arrived while the
            // exactly-once reservation/signature was being prepared. Do NOT
            // require the earlier quote timestamp to remain inside the broad
            // 10s monitoring window: the final submit quote was validated just
            // before this <=2.5s local send window. Price/stop/drift safety,
            // however, remains mandatory right up to the network boundary.
            const latest=this.runtime.evidence[symbol],
              latestPrice=entry.side==="LONG"?latest?.bestAsk:latest?.bestBid;
            if(latestPrice){
              if(!isInverseLiveReceipt(entry.parity)&&(entry.side==="LONG"?latestPrice<=entry.invalidation:latestPrice>=entry.invalidation))return false;
              const latestDrift=liveEntryDriftGuard(source,latestPrice);
              if(!isInverseLiveReceipt(entry.parity)&&latestDrift.adverse>latestDrift.allowed+1e-9)return false;
            }
            return true;
          };
          if(!submissionStillAllowed())throw new GateEntryCancelledError("最终提交身份或2.5秒发送窗口已变化，订单尚未发送");
          // Keep the current final local safety fence, but use the proven
          // 2026-09-20 REST transport after it passes. This guard runs after
          // signing and immediately before the one network submission.
          // Maker-first for inverse copies: rest at our own side for 2s, then the
          // exact remainder goes to the existing IOC market order. Never skips.
          let maker:MakerResult|null=null;
          if(LIVE_MAKER_ENTRY_ENABLED&&isInverseLiveReceipt(entry.parity)&&entry.kind==="MARKET"){
            const totalText=String(intent.body.size).replace(/^-/,""),marketTag=entry.tag,makerTag=makerEntryTag(marketTag);
            // Persist the maker identity first so any crash/recovery looks for
            // the maker order, never re-sends a full market order on top of it.
            entry.tag=makerTag;await this.saveCheckpoint(Date.now(),true);
            try{
              maker=await makerFirstEntry({placeMaker:(b,f)=>client.placeMakerEntry(b,f),
                inspect:async id=>client.inspectEntry("MARKET",symbol,makerTag,id),cancel:id=>client.cancelOrder("MARKET",id)},
                {symbol,side:entry.side,contractsText:totalText,bestBid:submitQuote.bestBid,bestAsk:submitQuote.bestAsk,
                  tag:makerTag,beforeSend:submissionStillAllowed});
            }catch(error){
              if(error instanceof MakerStateUnknownError){entry.exchangeOrderId=entry.exchangeOrderId??null;throw error;}
              if(error instanceof GateEntryCancelledError){entry.tag=marketTag;throw error;}
              throw error;
            }
            entry.exchangeOrderId=maker.makerOrderId;
            if(entry.parity)Object.assign(entry.parity,{makerEntryPolicy:LIVE_MAKER_ENTRY_POLICY,makerOrderId:maker.makerOrderId,
              makerPrice:maker.makerPrice,makerFilledContracts:maker.filledContracts,makerFillPrice:maker.fillPrice,
              makerRejected:maker.rejected,makerWaitedMs:maker.waitedMs});
            await this.saveCheckpoint(Date.now(),true);
            if(Number(maker.remainingText)>0){
              intent.body={...intent.body,size:`${entry.side==="SHORT"?"-":""}${maker.remainingText}`};
              entry.tag=marketTag;finalValidatedAt=Date.now();
              if(!submissionStillAllowed()){
                if(maker.filledContracts<=0)throw new GateEntryCancelledError("挂单等待期间源单或会话已变化，订单尚未发送");
                // Source ended during the wait: keep the already-filled maker
                // exposure as the entry; the source close follows through on it.
                entry.tag=makerTag;maker={...maker,remainingText:"0"};
              }
            }
          }
          let filled:GateLiveOrder|null;
          if(maker&&Number(maker.remainingText)<=0){
            entry.status="OPEN";
            filled=await client.inspectEntry(entry.kind,symbol,entry.tag,entry.exchangeOrderId);
          }else{
            // Remainder after a partial maker fill must still be sent: the source
            // is live and live may never take fewer orders than paper.
            entry.exchangeOrderId = await client.createEntry(intent,submissionStillAllowed);
            entry.status = "OPEN";
            filled=await client.inspectEntry(entry.kind,symbol,entry.tag,entry.exchangeOrderId);
            if(maker&&maker.filledContracts>0&&filled){
              const mq=maker.filledContracts,mp=maker.fillPrice??maker.makerPrice,
                qq=Math.max(0,Math.abs(Number(filled.size))-Math.abs(Number(filled.left))),qp=Number(filled.fill_price);
              const avg=qq>0&&qp>0?(mq*mp+qq*qp)/(mq+qq):mp;
              filled={...filled,fill_price:avg,size:Number(maker.remainingText)+mq,left:Math.abs(Number(filled.left))||0,finish_as:"filled"};
            }
          }
          const fillPrice=Number(filled?.fill_price);
          if(entry.parity&&Number.isFinite(fillPrice)&&fillPrice>0){
            const actualDrift=liveEntryDriftGuard(source,fillPrice);
            Object.assign(entry.parity,{exchangeEntryPrice:fillPrice,exchangeEntryAt:Date.now(),
              exchangeEntryDriftRate:actualDrift.adverse});
            this.noteLiveFill(entry.planId,symbol,entry.side,entry.parity);
          }
          if(filled&&liveEntryDisposition(filled,entry.kind)==="CANCELLED"){
            entry.status="CANCELLED";entry.submissionResolved=true;entry.lastError="Gate IOC零成交；未完成复制，不冒充成功";
            this.runtime.live.entrySkips[symbol]={planId:entry.planId,symbol,code:"ENTRY_REJECTED",reason:entry.lastError,observedAt:Date.now()};
            await this.saveCheckpoint(Date.now(),true);continue;
          }
          await this.saveCheckpoint(Date.now(),true);
          await this.createImmediateLiveStop(client, entry);
          if (!isInverseLiveReceipt(entry.parity)&&!entry.stopOrderId) {
            if (entry.protectionExitRequestedAt) recoveringSubmission = entry;
            else recoveringEntryStop = entry;
            break;
          }
          await this.queueLiveBinding(entry);
          await this.saveCheckpoint(Date.now(),true);
        } catch (error) {
          if(error instanceof GateEntryCancelledError){
            entry.status="CANCELLED";entry.submissionResolved=true;
            entry.lastError=`${error.message}；已确认尚未跨过 Gate 订单网络边界，源单仍有效时下一轮可安全重试`;
            delete entry.marketSubmittedAt;
            if(entry.parity){delete entry.parity.submittedAt;delete entry.parity.submitDelayMs;}
            this.runtime.live.entrySkips[symbol]={planId:plan.id,symbol,code:"RETRYING",reason:entry.lastError,observedAt:Date.now()};
            this.recordLiveAudit({observedAt:Date.now(),symbol,planId:plan.id,stage:"ENTRY_SUBMIT",level:"INFO",reason:entry.lastError});
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
            entry.status = "ERROR";entry.missingSince = now;recoveringSubmission = entry;
            this.recordLiveAudit({ observedAt: now, symbol, planId: plan.id, stage: "ENTRY_SUBMIT", level: "RECOVERING",
              reason: reason+"；结果不明确，保留风险额度并按订单标签核对，不自动重复提交", error });
          }
        }
      } catch (error) {
        entry.status = "ERROR";
        entry.lastError = safeError(error);
        throw error;
      }
      if(entry.status==="ERROR"&&(entry.stopSubmittingAt||entry.protectionExitRequestedAt))break;
    }
    if (recoveringEntryStop) {
      this.runtime.live.operational = false;
      this.runtime.live.lastError = `${recoveringEntryStop.symbol} 的初始保护/强制退出正在按订单标签核对`;
    } else if(recoveringSubmission){
      this.runtime.live.operational=true;
      this.runtime.live.lastError=recoveringSubmission.lastError
        ?? `${recoveringSubmission.symbol} 的唯一订单身份仍在 Gate 核对；该笔风险已冻结，其他独立新机会继续执行`;
    }
    // No eligible source may leave a completed healthy reconciliation as an
    // unclassified WAITING row. That old fallback hid the real branch behind
    // "等待报价、账户与交易所确认" even when all three were healthy.
    for(const trade of Object.values(desiredPortfolio)){
      if(!trade.forwardSource||!sourceAfterEnable(trade.forwardSource,this.runtime.live.activation,this.forwardState!.startedAt))continue;
      const symbol=trade.symbol,position=this.runtime.live.positions[symbol],entry=this.runtime.live.entries[symbol],
        skip=this.runtime.live.entrySkips[symbol],
        copied=position?.status==="OPEN"&&position.id===trade.id,
        pending=entry?.planId===trade.id&&["SUBMITTING","OPEN","ERROR"].includes(entry.status);
      if(copied||pending||skip?.planId===trade.id)continue;
      const endedEarly=position?.id===trade.id&&position.status==="CLOSED",
        reason=endedEarly
          ?"该模拟源单仍开放，但对应实盘仓位已经在 Gate 归零；同一源单不重复开仓，等待下一笔新模拟源单"
          :entry?.planId===trade.id&&entry.lastError
            ?entry.lastError
            :"本轮账户/盘口核对已完成，但源单没有进入提交、挂起或明确阻塞状态；保留源单并在下一2秒循环重新执行";
      this.runtime.live.entrySkips[symbol]={planId:trade.id,symbol,code:endedEarly?"SOURCE_ENDED_EARLY":"RETRYING",
        reason,observedAt:Date.now()};
      this.recordLiveAudit({observedAt:Date.now(),symbol,planId:trade.id,stage:"ENTRY_SUBMIT",level:endedEarly?"SKIPPED":"RECOVERING",reason});
    }
    this.liveSnapshotCache=structuredClone(snapshot);
  }

  protected async setLiveMode(enabled: boolean) {
    const wasEnabled=this.runtime.live.requestedEnabled,priorActivation=this.runtime.live.activation??null,
      priorChangedAt=this.runtime.live.changedAt,changedAt=Date.now();
    if(enabled&&!wasEnabled&&!this.forwardState){
      const error="当前模拟源尚未恢复完整账户代次；实盘开关保持关闭，未建立空的开启起点";
      return {ok:false,error,live:this.runtime.live};
    }
    if(enabled&&!wasEnabled)this.runtime.live.activation=startLiveSession(changedAt,this.forwardState);
    this.runtime.live.requestedEnabled = enabled;
    if (!enabled) this.runtime.live.operational = false;
    if(wasEnabled!==enabled||this.runtime.live.changedAt==null)this.runtime.live.changedAt = changedAt;
    this.runtime.live.lastError = null;
    let intentPersisted=false;
    try {
      await this.ctx.storage.put(LIVE_PARITY_PREFIX+"owner-intent",{enabled,changedAt:this.runtime.live.changedAt,activation:this.runtime.live.activation??null});
      intentPersisted=true;
      await this.saveCheckpoint(Date.now(),true);
      await this.syncLive(Date.now(), enabled, !enabled);
      this.recordLiveAudit({ observedAt: Date.now(), symbol: null, planId: null, stage: "LIVE_CONTROL", level: "INFO",
        reason: enabled ? "所有者已开启，仅复制本次开启后新产生的模拟单；开启前已有单不补开，重复开启不重置起点" : "所有者已关闭实盘复制并请求撤销系统入场挂单" });
      await this.saveCheckpoint(Date.now(), true);
      return { ok: true, live: this.runtime.live };
    } catch (error) {
      if(enabled&&!wasEnabled&&!intentPersisted){
        this.runtime.live.requestedEnabled=wasEnabled;
        this.runtime.live.activation=priorActivation;
        this.runtime.live.changedAt=priorChangedAt;
      }
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
      ...(this.forwardState?.inverseTrial?.source.positions.map((position) => position.symbol) ?? []),
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
    // a gap shorter than PROTECTED_QUOTE_GRACE_MS is not reported (health stays LIVE); the held coin still only acts on fresh prices
    const delay=protectedQuoteDelay(this.protectedMissingSince,missingProtectedMarkets.length,now);this.protectedMissingSince=delay.since;
    return{capacity:FORWARD_EXECUTION_BBO_CAP,actionableMarkets,
      warmingMarkets:Math.max(0,this.runtime.symbols.length-actionableMarkets),
      protectedMarkets:protectedSymbols.size,protectedMarketsReady:!delay.delayed,missingProtectedMarkets,
      protectedMissingMs:delay.since==null?0:now-delay.since};
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
      const external=this.marketHub.quote(symbol,now),mid=(row.bestBid+row.bestAsk)/2,
        meta=this.runtime.contractMeta[symbol],book=meta?this.gateStream.book(symbol,this.runtime.tickSize[symbol]??1e-8,meta.quantoMultiplier,now):null,
        bidDepth=book?.bids.slice(0,5).reduce((n,x)=>n+x.size,0)??0,askDepth=book?.asks.slice(0,5).reduce((n,x)=>n+x.size,0)??0,
        gateImbalance=bidDepth+askDepth>0?(bidDepth-askDepth)/(bidDepth+askDepth):0,
        bookImbalance=(external?.liquiditySourceCount??0)>=2?external!.bookImbalance:gateImbalance;
      return[[symbol,{bestBid:row.bestBid,bestAsk:row.bestAsk,observedAt:row.observedAt,fresh:true,
        entryReady:this.symbolEntryReady(symbol,now),sourceCount:external?.sourceCount??0,
        disagreementRate:external?.disagreementRate??0,sourceBreadth:external?.sourceBreadth??0,
        directionalAgreement:external?.directionalAgreement??.5,medianShortMove:external?.medianShortMove??0,
        spreadRate:external?.spreadRate??(mid>0?(row.bestAsk-row.bestBid)/mid:0),bookImbalance,
        bidLiquidityChange:external?.bidLiquidityChange??0,askLiquidityChange:external?.askLiquidityChange??0,
        liquiditySourceCount:external?.liquiditySourceCount??0}]];
    }));
  }

  private launchExternalMarketRefresh(now=Date.now()){
    // Only needed to protect held positions (1m wick bars); an empty account makes no external request at all.
    if(!this.forwardState?.positions.length)return;
    const task=this.marketHub.launchRefresh(now);if(!task)return;
    this.ctx.waitUntil(task.then(()=>{
      const at=Date.now(),status=this.marketHub.status(at);
      if(status.healthySources>0)this.runtime.lastSuccessAt=at;
    }).catch(error=>{this.runtime.strategyLogError=`external-market: ${safeError(error)}`;}));
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
    const urgent=this.forwardState?forwardUrgentMinuteSymbols(this.forwardState):[];
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
    // REST fallback only where it matters: critical symbols keep the old every-loop behaviour; research/scanning symbols
    // back off while their websocket book stays silent and share a global REST budget (no new requests anywhere).
    // open/pending exposure only; research-only scanning symbols (opportunities, extremum watch list) are not critical
    const restCritical=new Set([...this.currentAuthorityProtectionSymbols(),
      ...(this.forwardState?forwardRestCriticalSymbols(this.forwardState,now,this.runtime.liquidUniverse??[]):[])]);
    const critical=(symbol:string)=>restCritical.has(symbol);
    this.gateRestThrottle.forget(this.runtime.symbols);
    const due=cycleSymbols.filter(symbol=>{
      if(streamBook(symbol)){this.gateRestThrottle.wsSeen(symbol);return true;}
      return (this.runtime.feedFailures[symbol]?.retryAt??0)<=now&&this.gateRestThrottle.allow(symbol,now,critical(symbol));
    });
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
      successes++;
    }
    if(successes>0)this.runtime.lastSuccessAt=Date.now();
    return{successes,requests:due.length,criticalChanged:false};
  }

  protected prepareLiveEquityWrite(now:number) {
    if(this.liveEquityWritePending)return null;
    const live=this.runtime.live,prepared=prepareLiveEquity(live.accountMark,live.requestedEnabled,
      live.activation?.enabledAt??0,live.equityCurve,now);
    if(!prepared)return null;
    const reservation=this.reserveNonAlarmWrites(1,256,"live-equity");
    if(!reservation)return null;
    this.liveEquityWritePending=true;
    return {...prepared,reservation:{finish:(committed:boolean)=>{reservation.finish(committed);this.liveEquityWritePending=false;}}};
  }

  protected async privateLiveEquity(url:URL) {
    const sessionAt=this.runtime.live.activation?.enabledAt??0,head=this.runtime.live.equityCurve;
    if(url.searchParams.get('session')!==String(sessionAt))return json({error:'LIVE_SESSION_CHANGED'},409);
    if(!head||head.sessionAt!==sessionAt)return json({error:'实盘净值尚未记录'},503);
    try{return json(await this.liveEquityReader.read(this.ctx.storage,head,url.searchParams.get('cursor'),Date.now(),url.searchParams.get('after')));}
    catch(error){const message=error instanceof Error?error.message:'';
      return json({error:message==='INVALID_CURSOR'?'净值游标无效':'实盘净值暂不可用'},message==='INVALID_CURSOR'?400:message==='CURVE_BUSY'?429:503);}
  }

  protected async privateLiveReview(url:URL) {
    const now=Date.now(),live=this.runtime.live,sessionAt=live.activation?.enabledAt??0;
    // Export uses existing state/cache only. Never launch the Gate history reader.
    const cached=this.historyReader.view(this.liveSettlementCurrent(),this.liveRecordEpochAt()).history;
    const review=buildLiveReview({live,account:this.liveSnapshotCache?.account,
      accountAt:this.liveSnapshotCache?.checkedAt,cached,at:now});
    if(url.searchParams.get('page')==='closed'){
      const asOf=Number(url.searchParams.get('asOf'));
      if(url.searchParams.get('session')!==String(sessionAt)
        ||url.searchParams.get('account')!==String(review.context.accountUser??''))return json({error:'LIVE_REVIEW_ACCOUNT_OR_SESSION_CHANGED'},409);
      if(asOf>now)return json({error:'INVALID_LIVE_REVIEW_CUTOFF'},400);
      try{return json(await readLiveReviewPage(this.ctx.storage,{...review.context,asOf},url.searchParams.get('cursor'),cached));}
      catch{return json({error:'LIVE_REVIEW_PAGE_UNAVAILABLE_OR_INVALID_CURSOR'},400);}
    }
    return json(review);
  }

  protected async saveCheckpoint(now: number, force = false) {
    this.resetDailyCounters(now);
    if (!force && this.runtime.lastHeartbeatAt != null && now - this.runtime.lastHeartbeatAt < HEARTBEAT_MS) return;
    const openCount = Object.values(this.runtime.positions).filter((position) => position?.status === "OPEN").length;
    const journal=new Map(this.liveJournal);
    const curve=this.prepareLiveEquityWrite(now);
    const writes=1+journal.size,critical=force||journal.size>0;
    const reservation=critical?this.reserveCriticalWrites(writes,{checkpoint:1,"live-journal":journal.size}):this.reserveNonAlarmWrites(writes,openCount,{checkpoint:1,"live-journal":journal.size});
    if (!reservation) {curve?.reservation.finish(false);return;}
    try {
      // Full immutable source snapshots live outside the bounded hot checkpoint.
      // A binding and its entry reservation commit atomically BEFORE a Gate call.
      const compact=<T extends {parity?:MirrorReceipt}>(value:T|null)=>{
        if(!value)return value;
        const {parity,...rest}=value;void parity;return rest;
      };
      const checkpoint = { ...this.runtime, live:{...this.runtime.live,...(curve?{equityCurve:curve.head}:{}),
        entries:Object.fromEntries(Object.entries(this.runtime.live.entries).map(([k,e])=>[k,compact(e)])),
        positions:Object.fromEntries(Object.entries(this.runtime.live.positions).map(([k,p])=>[k,compact(p)]))},
        analysisMs: [], nonAlarmWrites: this.runtime.nonAlarmWrites + this.nonAlarmPendingWrites,
        criticalWrites: this.runtime.criticalWrites + this.criticalPendingWrites, lastHeartbeatAt: now };
      await this.ctx.storage.transaction(async transaction=>{
        await transaction.put({checkpoint,...Object.fromEntries(journal),...(curve?{[curve.key]:curve.value}:{})});
      });
      for(const[key,value]of journal)if(this.liveJournal.get(key)===value)this.liveJournal.delete(key);
      reservation.finish(true);
      if(curve){this.runtime.live.equityCurve=curve.head;curve.reservation.finish(true);}
      this.runtime.lastHeartbeatAt = now;
    } finally {reservation.finish(false);curve?.reservation.finish(false);}
  }


  private publishCriticalHealth(observedAt:number,books:{successes:number;requests:number}) {
    this.runtime.lastAlarmAt=observedAt;
    const hub=this.marketHub.status(observedAt);
    if(books.successes>0||hub.healthySources>0)this.runtime.lastSuccessAt=observedAt;
    const readiness=this.realtimeReadiness(observedAt);
    const idle=this.idleStandby();
    const authorityStale=!idle&&(this.runtime.lastSuccessAt==null||observedAt-this.runtime.lastSuccessAt>SYSTEM_HEALTH_STALE_AFTER_MS);
    this.runtime.state=!this.authorityReady?"RECOVERY_REQUIRED":idle?"IDLE":authorityStale?"RECONNECTING"
      :!readiness.protectedMarketsReady?"DEGRADED":hub.healthySources>0||readiness.actionableMarkets>0?"LIVE":"WARMING";
    const feedError=authorityStale?"Bybit/OKX/KuCoin分析源与Gate执行源同时不可用"
      :!readiness.protectedMarketsReady?`持仓报价延迟：${readiness.missingProtectedMarkets.join("、")} 的Gate报价已断 ${Math.round(readiness.protectedMissingMs/1000)} 秒（超过 ${PROTECTED_QUOTE_GRACE_MS/1000} 秒才提示）`:null;
    this.runtime.lastError=feedError??this.runtime.d1MirrorError;
  }

  /** D1 run-log archive pass: off the trading clock, non-overlapping, never awaited by a tick. */
  private launchArchiveWork(now:number){
    try{
      if(this.archiveWork||!this.forwardState||!this.authorityReady||this.forwardError)return;
      if(!this.runLogArchiver.due(now))return;
      const state=this.forwardState;
      const task=this.runLogArchiver.step({now,state,
        book:this.tradePathsLoaded?this.tradePaths:null,journal:this.orderJournalLoaded&&this.orderJournalComplete?this.orderJournal:null}).catch(()=>undefined);
      this.archiveWork=task;
      const tracked=task.finally(()=>{if(this.archiveWork===task)this.archiveWork=null;});
      this.ctx.waitUntil(tracked);
    }catch{/* 归档只是记录，失败不能碰交易 */}
  }
  /** compact public summary of the research layer (no positions, no keys): boot, backfill progress, external requests, trades, predictor */
  /** In-memory alarm-loop timing (diagnosis of quote gaps): alarm runs >10s and gaps >10s between two alarm starts, last 8 each. */
  private alarmStats={lastStartAt:0,lastMs:0,slow:[] as {at:number;ms:number}[],gaps:[] as {at:number;ms:number}[]};
  private archiveView(now:number){
    return {...this.runLogArchiver.status,healthy:this.runLogArchiver.healthy(now),segmentSize:ARCHIVE_SEGMENT_SIZE};
  }
  /** Rows archived since the archive-export cursor. One count per cursor move (or every 6 h); in between, new rows
   *  are added from the archive's own running total, so an open panel never turns into repeated D1 scans. */
  private async archivePendingSinceCursor(now:number){
    const db=this.runLogArchiver.status.schemaReady?(this.env.DB as unknown as D1Like):null;if(!db)return null;
    const cursor=await readMeta<ArchiveCursor>(db,'export_cursor');
    const key=cursor?`${cursor.at}:${cursor.id}`:'none';
    const records=this.runLogArchiver.status.stats.records,c=this.archivePendingCache;
    if(c&&c.cursorKey===key&&now-c.at<6*60*60_000)return c.pending+Math.max(0,records-c.records);
    const pending=await countArchive(db,{mode:'since',cursor});
    this.archivePendingCache={at:now,cursorKey:key,pending,records};
    return pending;
  }
  /** Orders already copied to D1, so an export is not limited to the 1200 still in the hot book. Paths are attached only when stored; none are invented. */
  private async archivedOrders(){
    const db=this.env.DB as unknown as D1Like;
    if(!await this.runLogArchiver.ensureSchema())throw new Error("长期归档没准备好");
    const total=await countArchive(db,{mode:"all"}),segments=segmentCount(total);
    const rows:Record<string,unknown>[]=[],paths:{id:string}[]=[];
    for(let k=1;k<=segments;k++){
      const page=await readSegment(db,{mode:"all"},k);
      for(const r of page){
        if(r.kind!=="position")continue;
        try{const row=JSON.parse(r.row_json) as Record<string,unknown>;if(row&&row.id!=null)rows.push(row);}catch{/* 坏行留在库里，不挡其余 */}
        if(!r.path_json)continue;
        try{const path=JSON.parse(r.path_json) as {id:string};if(path&&path.id)paths.push(path);}catch{/* 路径坏了仍导出订单 */}
      }
    }
    return {rows,paths};
  }
  private async archiveExport(url:URL,owner:boolean){
    const now=Date.now(),db=this.env.DB as unknown as D1Like;
    if(!await this.runLogArchiver.ensureSchema())return json({error:"长期归档还没准备好，稍后再试"},503);
    const raw=url.searchParams.get("mode"),mode:ArchiveMode=raw==="range"?"range":raw==="all"?"all":"since";
    const num=(v:string|null)=>{const n=Number(v);return v!=null&&v!==""&&Number.isFinite(n)?n:null;};
    const from=mode==="range"?num(url.searchParams.get("from")):null,to=mode==="range"?num(url.searchParams.get("to")):null;
    if(mode==="range"&&(from==null||to==null||to<=from))return json({error:"时间段不对"},400);
    const cursor=mode==="since"?await readMeta<ArchiveCursor>(db,'export_cursor'):null;
    const query={mode,from,to,cursor};
    const total=await countArchive(db,query),segments=segmentCount(total);
    if(url.searchParams.get("count")==="1")return json({mode,from,to,total,segments,size:ARCHIVE_SEGMENT_SIZE,cursor});
    const segment=mode==="since"?1:Math.max(1,Math.min(Math.max(1,segments),Math.floor(num(url.searchParams.get("segment"))??1)));
    const rows=await readSegment(db,query,segment);
    const opened=rows.map(r=>r.opened_at),lo=opened.length?Math.min(...opened):(from??now),hi=opened.length?Math.max(...opened):(to??now);
    const [stages,equity]=await Promise.all([readStagesFor(db,lo,hi),readEquityFor(db,lo,hi)]);
    // 'since' always serves the first segment after the cursor; the panel passes label=k/n so file names keep counting up.
    const label=/^(\d{1,4})\/(\d{1,4})$/.exec(url.searchParams.get("label")??"");
    const shownSeg=mode==="since"&&label?Number(label[1]):segment,shownSegs=mode==="since"&&label?Math.max(Number(label[2]),shownSeg):segments;
    const file=buildArchiveFile({rows,stages,equity,exportedAt:now,mode,segment:shownSeg,segments:shownSegs,total,from,to});
    const name=archiveFileName({mode,segment:shownSeg,segments:shownSegs,from,to,openedFirst:opened.length?lo:null,openedLast:opened.length?hi:null});
    // The cursor moves only after this segment was built in full, and only for the owner.
    let advanced=false;
    if(mode==="since"&&rows.length&&owner){
      const last=rows.at(-1)!;
      try{await writeMeta(db,'export_cursor',{at:last.archived_at,id:last.id},now);advanced=true;this.archivePendingCache=null;}catch{advanced=false;}
    }
    try{const mark={at:now,mode,rows:rows.length};await writeMeta(db,'last_export',mark,now);this.runLogArchiver.noteExport(mark);}catch{/* 只是显示用 */}
    return json({...file,archive:{...file.archive,file_name:name,cursor_advanced:advanced,remaining_after:mode==="since"&&advanced?Math.max(0,total-rows.length):null}});
  }

  /** Background, non-overlapping, never delays the 2s protection loop. Only core upkeep: Gate settlement, contract catalog, 1m wick bars for held coins. */
  private launchOptionalWork(now:number,universeDue:boolean) {
    void now;
    if(this.optionalWork)return;
    const task=(async()=>{
      let subrequests=0;
      this.launchLiveSettlementBackground();
      if(universeDue){
        subrequests+=2;
        try{this.refreshUniverse(Date.now(),await fetchActiveContracts());}
        catch(error){this.runtime.lastError=`universe: ${safeError(error)}`;}
      }
      subrequests+=await this.refreshForwardUrgentMinutes(Date.now());
      this.runtime.subrequestCount+=subrequests;
      this.runtime.maxSubrequestsInAlarm=Math.max(this.runtime.maxSubrequestsInAlarm,subrequests);
    })().catch(error=>{this.runtime.strategyLogError=`core-upkeep: ${safeError(error)}`;});
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
    if(this.alarmStats.lastStartAt>0){const gap=now-this.alarmStats.lastStartAt;
      if(gap>10_000){this.alarmStats.gaps.push({at:this.alarmStats.lastStartAt,ms:gap});if(this.alarmStats.gaps.length>8)this.alarmStats.gaps.shift();}}
    this.alarmStats.lastStartAt=now;
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
      // Proven 2026-09-20 scheduling: PAPER is persisted first, then LIVE is
      // reconciled in the same serialized primary pass. No second LIVE executor
      // runs in the background.
      if(this.liveNeedsSync()){
        const liveStarted=Date.now(),liveRequestsBefore=this.liveClient?.requestCount??0;
        this.liveExecution.startedAt=liveStarted;this.liveExecution.cycles++;
        try{
          await this.syncLive(liveStarted);
        }catch(error){
          const message=safeError(error),blocked=liveFailureRequiresOff(error);
          const shouldRecord=this.runtime.live.lastError!==message||this.runtime.live.operational;
          this.runtime.live.operational=false;this.runtime.live.lastError=message;
          if(shouldRecord)this.recordLiveAudit({observedAt:Date.now(),symbol:null,planId:null,
            stage:"LIVE_CONTROL",level:"RECOVERING",reason:blocked
              ?"账户纳管冲突，执行暂停但不改写所有者开关："+message
              :"实盘核对暂时失败，所有者开关选择保持不变："+message,error});
        }finally{
          this.liveExecution.finishedAt=Date.now();
          this.liveExecution.lastDurationMs=Date.now()-liveStarted;
          subrequests+=Math.max(0,(this.liveClient?.requestCount??liveRequestsBefore)-liveRequestsBefore);
        }
      }
      this.launchOptionalWork(now, universeDue);
      this.launchTurnoverWork(Date.now());
      this.launchArchiveWork(Date.now());
    } catch (error) {
      this.runtime.state = "RECONNECTING";
      this.runtime.lastError = safeError(error);
    } finally {
      const finishedAt = Date.now(),took=finishedAt-now;
      this.alarmStats.lastMs=took;
      if(took>10_000){this.alarmStats.slow.push({at:now,ms:took});if(this.alarmStats.slow.length>8)this.alarmStats.slow.shift();}
      this.runtime.lastAlarmAt = finishedAt;
      this.runtime.subrequestCount += subrequests;
      this.runtime.maxSubrequestsInAlarm = Math.max(this.runtime.maxSubrequestsInAlarm, subrequests);
      try { await this.saveCheckpoint(finishedAt); } catch (error) { this.runtime.lastError = `checkpoint: ${safeError(error)}`; }
    }
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname;
    // Any write invalidates the owner home snapshot at once (live switch, reset, credentials, living mode…).
    if(request.method!=="GET"&&request.method!=="HEAD")this.ownerHomeCache=null;
    if(path==="/owner-home"&&request.method==="GET")return this.ownerHome();
    // Binding-only projections. No public route reaches these methods. They do
    // not mutate primary state, re-arm alarms, start market work or touch Gate.
    if(path === "/member-feed" && request.method === "GET") {
      const s=this.forwardState,now=Date.now();
      const sourceState=s?{version:s.version,startedAt:s.startedAt,initialEquity:s.initialEquity,balance:s.balance,
        positions:s.positions,history:s.history,policyVersion:s.policyVersion,storage:s.storage,
        // Only the marks required by strict inverse PAPER equity. No second
        // source engine, wallet or source history is published to members.
        ...(s.inverseTrial?{inverseTrial:{source:{positions:s.inverseTrial.source.positions.map(t=>({
          id:t.id,lastPrice:t.lastPrice,lastQuoteAt:t.lastQuoteAt}))}}}:{})} as ForwardState:null;
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
    if (path === "/forward-log-status" && request.method === "GET") {
      if(!this.forwardState||!this.authorityReady)return json({error:"权威账户尚未恢复"},503);
      const now=Date.now();
      try{await this.runLogArchiver.ensureSchema();}catch{/* 读不到库时仍返回热记录进度 */}
      let pendingExport:number|null=null;try{pendingExport=await this.archivePendingSinceCursor(now);}catch{pendingExport=null;}
      let archive={...this.archiveView(now),pendingExport};
      if(!archive.loaded||!(archive.stats?.records>0)){
        try{
          if(await this.runLogArchiver.ensureSchema()){
            const stats=await readMeta<ArchiveStats>(this.env.DB as unknown as D1Like,"stats");
            if(stats&&stats.records>0)archive={...archive,schemaReady:true,loaded:true,stats};
          }
        }catch{/* 库还在，只是这一次没读到条数 */}
      }
      return json({...await this.runLogStatus(now),archive});
    }
    if (path === "/forward-archive-export" && request.method === "GET") {
      if(!this.forwardState||!this.authorityReady)return json({error:"权威账户尚未恢复"},503);
      try{return await this.archiveExport(url,request.headers.get("x-archive-owner")==="1");}
      catch(error){return json({error:`长期归档读取失败：${safeError(error)}`},503);}
    }
    if (path === "/forward-export" && request.method === "GET") {
      if(!this.forwardState||!this.authorityReady)return json({error:"权威账户尚未恢复，不能导出空账户"},503);
      if(url.searchParams.get("kind")==="log"){
        const exportedAt=Date.now(),hub=this.marketHub.status(exportedAt),gate=this.gateStream.status(exportedAt);
        await this.ensureTradePaths();
        await this.ensureOrderJournal();
        const state=this.forwardState;
        const since=this.logSince();
        const book=accountLogBook(state,this.forwardQuotes(exportedAt),exportedAt,this.orderJournal,since);
        const pathsReady=this.tradePathsLoaded&&this.tradePaths.accountStartedAt===state.startedAt;
        const pathById=new Map(this.tradePaths.trades.map(row=>[row.id,row]));
        const minutes=(await this.readEquityMinutes(exportedAt)).filter(row=>row.ts>=Math.max(state.startedAt,since?.at??0));
        // Account part: every paper trade of the account (open + closed), no legacy not-opened rows.
        const file=buildRunLogExport({events:[],funnel:book.funnel,health:hub,gate,exportedAt,liveEnabled:this.runtime.live.requestedEnabled,
          positions:book.positions,fills:book.fills,curve:book.curve,equity:book.equity,initial:book.initial,closedNet:book.closedNet,
          priorAdjustment:book.priorAdjustment,unreconstructed:book.unreconstructed,unreconstructedN:book.unreconstructedN,places:book.places,notOpened:[],
          stageTimeline:[],liveFills:normalizeLiveFills(this.runtime.live.fills),equityMinutes:minutes,tallySince:book.tallySince,accountResets:book.accountResets,pendingResetAt:book.pendingResetAt});
        const ids=new Set(file.positions.map(row=>row.id));
        const columnsOf=(id:string,row:{side:'LONG'|'SHORT';gate_signal_side?:unknown;gate_btc_1h_pct?:unknown})=>{try{return pathColumns(pathById.get(id),shadowSignalOf(row));}catch{return null;}};
        const livingEpoch:number|null=null;
        const hotPositions=withLivingEpoch(withResearchColumns(file.positions,columnsOf),livingEpoch) as Record<string,unknown>[];
        let positions=hotPositions;
        const paths:unknown[]=pathsReady?exportTradePaths(this.tradePaths,id=>ids.has(id)):[];
        let archiveError:string|null=null;
        try{
          const saved=await this.archivedOrders();
          positions=withLivingEpoch(mergeContinuousOrders(hotPositions,saved.rows) as {opened_at:number;rule_epoch?:string}[],livingEpoch) as Record<string,unknown>[];
          const have=new Set(paths.map(p=>(p as {id?:string}).id));
          for(const path of saved.paths)if(path.id&&!have.has(path.id))paths.push(path);
        }catch(error){archiveError=safeError(error);positions=hotPositions;}
        const hoursRaw=Number(url.searchParams.get("hours")),hours=Number.isFinite(hoursRaw)&&hoursRaw>0?Math.min(720,Math.max(1,Math.round(hoursRaw))):72;
        const from=exportedAt-hours*3_600_000;
        let buckets:LivingBucket[]=[],cases:LivingFinalCase[]=[],d1Error:string|null=null,d1Counts:unknown=null;
        const db=(this.env as {DB?:unknown}).DB?(this.env.DB as unknown as D1Like):null;
        if(db){try{
          buckets=await readLivingLog(db,"bucket",from-600_000,exportedAt,hours*6*3+50) as LivingBucket[];
          cases=await readLivingLog(db,"case",from,exportedAt,2000) as LivingFinalCase[];
          d1Counts=await countLivingLog(db);
        }catch(error){d1Error=safeError(error);}}
        // The strategy engine is gone: buckets/cases are only what earlier runs already wrote to D1 (read-only history).
        const status:Record<string,unknown>|null=null;
        const lastReset=book.accountResets.at(-1)?.at??null;
        const out=buildLivingRunLog({exportedAt,liveEnabled:this.runtime.live.requestedEnabled,buildSha:FORWARD_BUILD_SHA,hours,since:since?.at??null,status,buckets,cases,
          account:{equity:file.invariants.equity,initial:file.invariants.initial,invariants:file.invariants,book_audit:file.book_audit,equity_curve:file.equity_curve,
            equity_minutes:file.equity_minutes,drawdown:summarizeEquity(lastReset==null?minutes:minutes.filter(row=>row.ts>=lastReset)),
            curve_since:file.curve_since,drawdown_since:file.drawdown_since,account_resets:file.account_resets,account_epoch:file.account_epoch,
            account_reset_pending:file.account_reset_pending,liveFills:file.liveFills,
            equity_gaps:(()=>{try{return equityGaps(file.equity_minutes);}catch{return [];}})(),equity_filled_min:file.equity_minutes.filter(row=>row.filled).length},
          positions,fills:file.fills,
          paths,
          archive:{d1Error,d1Counts,livingRunLog:null,runLogArchive:this.archiveView(exportedAt),path_check:pathsReady}});
        const openedAt=out.positions.map(row=>Number(row.opened_at)).filter(n=>Number.isFinite(n));
        const body={...out,orders_from:openedAt.length?Math.min(...openedAt):null,orders_to:openedAt.length?Math.max(...openedAt):null,orders_archive_error:archiveError};
        const markRows=body.positions.length+body.cases.length;
        // Stream the body (a single JSON.stringify is ~40 MB of two-byte text and pushes this isolate over its memory limit).
        // The export mark moves only after the whole body went out, so a failed download no longer pushes the deadline.
        return jsonStreamResponse(body,{
          headers:{"X-Export-Meta":JSON.stringify({at:exportedAt,positions:body.positions.length,cases:body.cases.length,timeline:out.timeline.length,
            from:body.orders_from,to:body.orders_to,archiveError:archiveError!=null})},
          onDone:()=>this.noteRunLogExport(exportedAt,markRows)});
      }
      if(url.searchParams.get("page")==="archive"){
        const startedAt=Number(url.searchParams.get("accountStartedAt")),asOf=Number(url.searchParams.get("asOf"));
        if(startedAt!==this.forwardState.startedAt)return json({error:"REVIEW_ACCOUNT_CHANGED"},409);
        if(asOf>Date.now())return json({error:"INVALID_REVIEW_CUTOFF"},400);
        try{return json(await readReviewArchivePage(this.ctx.storage,startedAt,asOf,url.searchParams.get("cursor")));}
        catch{return json({error:"REVIEW_ARCHIVE_UNAVAILABLE_OR_INVALID_CURSOR"},400);}
      }
      const exportedAt=Date.now(),view=structuredClone(this.forwardView(exportedAt));
      const quotes=this.forwardQuotes(exportedAt),minutePaths=this.forwardMinutePaths();
      // No alarm rearming, account normalization, research advancement, Gate calls or writes on export.
      return json(buildReviewSnapshot({view,exportedAt,buildSha:FORWARD_BUILD_SHA,strategyFingerprint:STRATEGY_FINGERPRINT,
        inverseSources:(()=>{const src=this.forwardState.inverseTrial?.source;if(!src)return [];
          return [...src.positions,...src.history].map(t=>({id:t.id,status:t.status==="CLOSED"?"CLOSED" as const:"OPEN" as const,
            price:quotes[t.symbol]?(quotes[t.symbol]!.bestBid+quotes[t.symbol]!.bestAsk)/2:t.lastPrice??null,quoteAt:quotes[t.symbol]?.observedAt??t.lastQuoteAt??null,
            exitPrice:t.exitPrice??null,closedAt:t.closedAt??null}));})(),
        journal:structuredClone(this.reviewJournal),
        marketData:{sources:this.marketHub.status(exportedAt),transport:this.gateStream.status(exportedAt),feedQuality:this.runtime.feedQuality,
          symbols:this.runtime.symbols.map(symbol=>({symbol,quoteAt:this.runtime.evidence[symbol]?.observedAt??null,
            entryReady:quotes[symbol]?.entryReady===true,completedMinuteAt:minutePaths[symbol]?.at(-1)
              ?(minutePaths[symbol]!.at(-1)!.time+60)*1000:null,failure:this.runtime.feedFailures[symbol]??null}))},
        runtime:{reviewError:this.reviewDiagnosticError,lastSuccessAt:this.runtime.lastSuccessAt,lastError:this.runtime.lastError,
          privateLiveReviewAvailable:true,
          compression:this.forwardCompression,
          liveAssessment:this.runtime.live.requestedEnabled?"CHECK_SESSION_EVIDENCE":"OWNER_OFF_NOT_A_COPY_FAILURE",
          liveSession:{requestedEnabled:this.runtime.live.requestedEnabled,operational:this.runtime.live.operational,
            changedAt:this.runtime.live.changedAt,lastSyncAt:this.runtime.live.lastSyncAt},
          liveAudit:this.runtime.live.auditEvents.slice(-100),
          liveEntries:Object.values(this.runtime.live.entries).filter((e):e is LiveEntry=>!!e).map(e=>({sourceId:e.mirrorSourceId??e.planId,
            symbol:e.symbol,status:e.status,createdAt:e.createdAt,submittedAt:e.marketSubmittedAt??null,exchangeOrderId:e.exchangeOrderId,
            stopOrderId:e.stopOrderId,stopSubmittingAt:e.stopSubmittingAt,lastError:e.lastError})),
          livePositions:Object.values(this.runtime.live.positions).filter((e):e is LivePosition=>!!e).map(e=>({sourceId:e.mirrorSourceId??e.id,
            symbol:e.symbol,status:e.status,exchangeUpdatedAt:e.exchangeUpdatedAt,exitRequestedAt:e.exitRequestedAt,
            stopOrderId:e.stopOrderId,stopPrice:e.stopPrice,exitOrderId:e.exitOrderId??null}))}}));
    }
    if (path === "/forward-equity" && request.method === "GET") {
      const s=this.forwardState;
      if(!s)return json({error:"净值源尚未恢复"},503);
      try {
        // The page curve restarts at the last funds reset; saved packets still carry the log epoch (startedAt).
        const curveStart=pageStartedAt(s);
        const page=await this.equityReader.read(this.ctx.storage,{startedAt:curveStart,initialEquity:s.initialEquity,
          policy:s.policyVersion,exitPolicy:ADAPTIVE_ENGINE_VERSION,
          comparableSince:curveStart,...(curveStart!==s.startedAt?{accountStartedAt:s.startedAt}:{}),
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
      const stale = this.marketStale(Date.now());
      const effectiveState = this.effectiveHealthState(stale);
      return json({
        version: this.runtime.version,
        buildSha: FORWARD_BUILD_SHA,
        liveMirror: {...this.liveMirrorView(),rows:undefined},
        liveTurnover:this.turnoverStatus(),
        liveEquityCurve:{version:LIVE_EQUITY_VERSION,sampleMs:LIVE_EQUITY_SAMPLE_MS,
          available:!!this.runtime.live.equityCurve&&this.runtime.live.equityCurve.sessionAt===this.runtime.live.activation?.enabledAt,
          lastSavedAt:this.runtime.live.equityCurve?.sessionAt===this.runtime.live.activation?.enabledAt?this.runtime.live.equityCurve?.lastAt??null:null},
        resourceAccounting:{policy:RESOURCE_DAY_POLICY,day:this.runtime.utcDay,nonAlarmWrites:this.runtime.nonAlarmWrites,
          cap:NON_ALARM_WRITE_CAP,pendingWrites:this.nonAlarmPendingWrites??0,criticalWrites:this.runtime.criticalWrites,
          criticalPendingWrites:this.criticalPendingWrites??0,financialAdmission:"independent-of-optional-cap",
          criticalProtection:protectionWriteBudgetView(this.forwardProtectionBudget,Date.now()),
          previous:this.runtime.resourceRollovers?.at(-1)??null,writesByKind:writeKindsView(this.runtime.writeKinds,Date.now()),forwardCompression:this.forwardCompression,
          reviewLog:{readyFor:this.reviewLogReadyFor,coldUnopened:this.reviewLogCursor.coldIds.length,error:this.reviewLogError,complete:this.reviewLogComplete},
          runLogArchive:this.archiveView(Date.now()),
          alarmLoop:{lastMs:this.alarmStats.lastMs,slow:this.alarmStats.slow,gaps:this.alarmStats.gaps},
          ghostPaths:{removed:this.ghostPathsRemoved,remaining:this.ghostPathsRemaining,error:this.ghostPathError},
          incompleteLog:{rowsRemoved:this.incompleteRowsRemoved,rowsRemaining:this.incompleteRowsRemaining,error:this.incompleteRowError,
            orphanPathsRemoved:this.orphanPathsRemoved,orphanPathsRemaining:this.orphanPathsRemaining}},
        forward: this.forwardHealth(),
        legacyRetired: true,
        mode: this.runtime.mode,
        state: effectiveState,
        stale,
        standby: this.standbyView(),
        lastError: this.runtime.lastError,
        lastSuccessAt: this.runtime.lastSuccessAt,
        lastHeartbeatAt: this.runtime.lastHeartbeatAt,
        authorityReady: this.authorityReady,
        symbols: this.runtime.symbols,
        realtimeReadiness: this.realtimeReadiness(),
        liveMode: { requestedEnabled: this.runtime.live.requestedEnabled, operational: this.runtime.live.operational },
        liveExecution:{...this.liveExecution,inFlight:!!this.liveSyncWork,queued:this.liveSourceQueued,
          timeoutStreak:this.liveReadTimeoutStreak,lastAccountAt:this.runtime.live.lastSyncAt,
          lastOrderAuditAt:(this.liveOrderSnapshotCache?.checkedAt??this.liveOrderAuditAt)||null,
          readTransport:this.liveClient?.readTransport??null,writeTransport:this.liveClient?.writeTransport??null},
        liveDiagnostics:{
          pendingProtectionExit:Object.values(this.runtime.live.entries).filter(e=>e?.protectionExitRequestedAt).length,
          pendingStopSubmission:Object.values(this.runtime.live.entries).filter(e=>e?.stopSubmittingAt&&!e.stopOrderId).length,
          openPositionExitRequested:Object.values(this.runtime.live.positions).filter(p=>p?.status==="OPEN"&&p.exitRequestedAt).length,
          recentAudit:this.runtime.live.auditEvents.slice(-16).map(e=>({at:e.observedAt,stage:e.stage,level:e.level,gateLabel:e.gateLabel})),
        },
        feedQuality: this.runtime.feedQuality,
        multiSourceMarket: this.marketHub.status(),
        marketDataTransport: this.gateStream.status(),
        gateRestThrottle: this.gateRestThrottle.status(),
        limits: {
          markets: this.runtime.symbols.length,
          scannedMarkets: this.runtime.radar.scanned,
          scanUniverse: SCAN_UNIVERSE_SIZE,
          realtimeCapacity: FORWARD_EXECUTION_BBO_CAP, minuteConfirmationCapacity: FORWARD_MINUTE_CONFIRMATION_CAP,
          plannedDoWritesPerDay: PRIMARY_PLANNED_DO_ROWS,
          twoMemberReservedDoRowsPerDay: TWO_MEMBER_PLANNED_DO_ROWS,
          plannedDoRowsPer31DayMonth:PAID_PLAN_PLANNED_MONTHLY_ROWS,
          paidDoIncludedRowsPerMonth:PAID_DO_INCLUDED_ROWS_PER_MONTH,
          paidDoSafetyLimitRowsPerMonth:PAID_PLAN_ROW_SAFETY_LIMIT,
          resourceModelScope:"Workers Paid row-write contract; requests, duration and unbounded external retries remain separately metered",
          capacityCertified: false,
          plannedTotalDoRequestsPerDay: 53_280,
          plannedMaxD1BilledWritesPerDay: 4_800,
        },
      });
    }
    if (path === "/status" || path === "/owner-runtime") {
      await this.ensureAlarm();
      if(path==="/owner-runtime")this.launchTurnoverWork(Date.now());
      const { outbox, live, paperCycle, bankruptcyOutbox, strategyArena: _sa, previousStrategyArena: _psa, regimePortfolio: _rp, canonicalPaper: _cp, marketRegimes: _mr,
        stableCandidates: _stableCandidates, previousStableCandidates: _previousStableCandidates, stableStructures: _ss,
        previousStableStructures: _previousStableStructures, liquidUniverse: _liquidUniverse,
        strategyCandleFailures: _scf, radar: _radar, regimeHourlyFailures: _rhf, ...publicRuntime } = this.runtime;
      void _sa; void _psa; void _rp; void _cp; void _mr; void _ss; void _scf; void _radar; void _rhf;
      void _stableCandidates; void _previousStableCandidates; void _previousStableStructures; void _liquidUniverse;
      const stale = this.marketStale(Date.now());
      const effectiveState = this.effectiveHealthState(stale);
      return json({ ...publicRuntime, ...this.authorityView, paperCycle: paperCycleSummary(paperCycle, this.authorityView.equity),
        buildSha: FORWARD_BUILD_SHA,
        forward: pageForwardView(this.forwardView()), legacyRetired: true,
        liveMirror: this.liveMirrorView(),
        liveTurnover:this.turnoverStatus(),
        liveDiagnostics:{
          pendingProtectionExit:Object.values(live.entries).filter(e=>e?.protectionExitRequestedAt).length,
          pendingStopSubmission:Object.values(live.entries).filter(e=>e?.stopSubmittingAt&&!e.stopOrderId).length,
          openPositionExitRequested:Object.values(live.positions).filter(p=>p?.status==="OPEN"&&p.exitRequestedAt).length,
          recentAudit:live.auditEvents.slice(-16).map(e=>({at:e.observedAt,stage:e.stage,level:e.level,gateLabel:e.gateLabel})),
        },
        ...(path === "/owner-runtime" ? { live:{...live,history:this.decoratedLiveHistory(),mirror:this.liveMirrorView(),
          turnover:turnoverView(this.turnoverState,this.turnoverError,Date.now(),live.activation?.enabledAt??null)} } : {}), liveMode: { requestedEnabled: live.requestedEnabled, operational: live.operational }, outboxLength: outbox.length + bankruptcyOutbox.length,
        oldestOutboxAgeMs: outbox.length ? Math.max(0, Date.now() - (outbox[0].position.exitAt ?? outbox[0].position.entryAt)) : 0,
        authorityReady: this.authorityReady, realtimeReadiness: this.realtimeReadiness(), multiSourceMarket:this.marketHub.status(),
        generatedAt: Date.now(), state: effectiveState, stale, standby: this.standbyView(),
        analysisP99Ms: percentile99(this.runtime.analysisMs), limits: { loopMs: LOOP_MS, markets: this.runtime.symbols.length, scannedMarkets: this.runtime.radar.scanned, scanUniverse: SCAN_UNIVERSE_SIZE, radarMs: RADAR_MS, warmupSnapshots: WARMUP_SNAPSHOTS,
          maxAncillaryConcurrency: MAX_ANCILLARY_CONCURRENCY, maxSubrequestsPerAlarm: 32, plannedAlarmRequestsPerDay: 43_200,
          plannedAlarmWritesPerDay: 43_200, watchdogWriteReservePerDay: WATCHDOG_WRITE_RESERVE,
          nonAlarmWriteCapPerDay: NON_ALARM_WRITE_CAP, nonAlarmWritesToday: this.runtime.nonAlarmWrites,
          criticalFinancialWritesToday:this.runtime.criticalWrites,criticalFinancialPending:this.criticalPendingWrites??0,
          criticalFinancialAdmission:"independent-of-optional-cap",
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
    if (path === "/live-review" && request.method === "GET") return this.privateLiveReview(url);
    if (path === "/live-equity" && request.method === "GET") return this.privateLiveEquity(url);
    if (path === "/owner-status" && request.method === "GET") {
      await this.ensureAlarm();
      this.launchTurnoverWork(Date.now());
      return json({ live:{...this.runtime.live,history:this.decoratedLiveHistory(),mirror:this.liveMirrorView(),
        turnover:turnoverView(this.turnoverState,this.turnoverError,Date.now(),this.runtime.live.activation?.enabledAt??null)}, generatedAt: Date.now() });
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
      if(body.enabled&&!this.forwardState){
        try{await this.ensureAdaptiveAccount(Date.now());}
        catch(error){return json({error:`模拟源尚未恢复，未改变实盘开关：${safeError(error)}`},409);}
      }
      const result = await this.setLiveMode(body.enabled);
      return json(result, result.ok ? 200 : 409);
    }
    if (path === "/paper-reset" && request.method === "POST") {
      try { return json(await this.ctx.blockConcurrencyWhile(() => this.resetPaperAccount())); }
      catch (error) { return json({ error: safeError(error) }, 409); }
    }
    if (path === "/paper-reset-cancel" && request.method === "POST") {
      try { return json(await this.ctx.blockConcurrencyWhile(() => this.cancelPaperReset())); }
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

const worker = {
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    // /forward is the long-lived bookmark from the previous route layout.
    // The current app is a single page at "/", so resolve the alias before the
    // vinext/RSC router can throw on a route that no longer exists.
    if(request.method==="GET"&&(url.pathname==="/forward"||url.pathname==="/forward/")){
      const target=new URL(request.url);target.pathname="/";
      return Response.redirect(target.toString(),307);
    }
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
    if (url.pathname === "/api/home" && request.method === "GET") {
      if(!await ownerAuthenticated(request, env))return Response.json({error:"需要登录"},{status:401,headers:{"Cache-Control":"no-store"}});
      return env.MARKET_STREAM.getByName("primary").fetch("https://market-stream/owner-home");
    }
    if (url.pathname === "/api/forward/archive-export" && request.method === "GET") {
      const owner=await ownerAuthenticated(request, env);
      return env.MARKET_STREAM.getByName("primary").fetch(`https://market-stream/forward-archive-export${url.search}`,{headers:{"x-archive-owner":owner?"1":"0"}});
    }
    if (url.pathname === "/api/forward/log-status" && request.method === "GET") return env.MARKET_STREAM.getByName("primary").fetch("https://market-stream/forward-log-status");
    if (url.pathname === "/api/forward/export" && request.method === "GET") return env.MARKET_STREAM.getByName("primary").fetch(`https://market-stream/forward-export${url.search}`);
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
    if (url.pathname === "/api/live/review" && request.method === "GET") {
      if(!await ownerAuthenticated(request,env))return json({error:"请先登录"},401);
      return env.MARKET_STREAM.getByName("primary").fetch(`https://market-stream/live-review${url.search}`);
    }
    if (url.pathname === "/api/live/equity" && request.method === "GET") {
      if(!await ownerAuthenticated(request,env))return json({error:"请先登录"},401);
      return env.MARKET_STREAM.getByName("primary").fetch(`https://market-stream/live-equity${url.search}`);
    }
    if (url.pathname === "/api/live/status" && request.method === "GET") return ownerLiveStatus(request, env);
    if (url.pathname === "/api/live/source" && request.method === "GET") return ownerLiveSource(request, env);
    if (url.pathname === "/api/live/mode" && request.method === "POST") return ownerLiveMode(request, env);
    if (url.pathname === "/api/live/credentials" && ["GET", "PUT", "DELETE"].includes(request.method)) return ownerLiveCredentials(request, env);
    if (url.pathname === "/api/paper/reset" && request.method === "POST") return ownerPaperAction(request, env, "RESET");
    if (url.pathname === "/api/paper/reset/cancel" && request.method === "POST") return ownerPaperAction(request, env, "RESET_CANCEL");
    if (url.pathname === "/api/paper/history/clear" && request.method === "POST") return ownerPaperAction(request, env, "CLEAR_HISTORY");
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    let pageResponse:Response;
    try{pageResponse=await handler.fetch(request, env, ctx);}
    catch(error){
      console.error("page-handler-failure",error);
      if(request.method==="GET"){
        const asset=await env.ASSETS.fetch(request);
        if(asset.ok)return asset;
        return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>哨兵恢复中</title><style>body{font-family:system-ui;background:#0b0f14;color:#e8edf2;display:grid;place-items:center;height:100vh;margin:0}main{max-width:520px;padding:28px}p{color:#9aa6b2}</style>
<main><h2>页面正在自动恢复</h2><p>交易后台与页面渲染相互隔离；本页将在几秒后重新连接。</p><script>setTimeout(()=>location.reload(),3000)</script></main>`,
          {status:503,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
      }
      return json({error:"page handler unavailable"},503);
    }
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
