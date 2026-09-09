/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import handler from "vinext/server/app-router-entry";
import { GatePublicError, fetchActiveContracts, fetchContractStats, fetchFuturesBook, fetchLiquidations, fetchMarketTickers, fetchRecentTrades, fetchStructureCandles } from "../lib/gate-market.ts";
import { closePaperPosition, CORRELATED_DIRECTION_RISK_CAP, PORTFOLIO_RISK_CAP, remainingStressRisk, STALE_AFTER_MS, SYSTEM_VERSION, type Decision, type LiquidityRoute, type LiquidityZone, type MarketState, type PaperPlan, type PaperPosition, type RangeStructure, type Side } from "../lib/liquidity-core.ts";
import { aggregateFourHourCandles, analyzeSnapshot, ancillarySchedule, applyFlow, deriveMinuteNoiseRate, deriveRangeStructure, deriveStructureZones, emptySymbolMemory, optionalEvidenceIsFresh, reconcilePaper, structureDirection, updateOpenInterestCohorts, usableSnapshot, type SymbolMemory } from "../lib/liquidity-runtime.ts";
import { arenaTradePlan, eligibleForLiveMirror, liveMirrorExitRequired } from "../lib/arena-live.ts";
import { drainPositionOutbox, enqueuePositionTransition, type PositionOutboxItem } from "../lib/paper-outbox.ts";
import { buildBankruptcyReport, diagnoseClosedPosition, paperCycleSummary, recordCycleTrade, startPaperCycle,
  PAPER_BANKRUPTCY_EQUITY, PAPER_INITIAL_EQUITY, type BankruptcyReport, type PaperCycle } from "../lib/paper-cycle.ts";
import { runtimeReady, type RuntimeHealthShape } from "../lib/runtime-health.ts";
import { buildLiveEntryIntent, buildLiveStopIntent, GateLiveClient, LiveEntrySizingError, liveEntryDisposition, liveExitTag, liveOrderId, liveOrderTag, loadGateLiveClient, type GateLiveOrder, type GateLiveSnapshot, type LiveEntrySizingCode } from "../lib/gate-live.ts";
import { encryptGateCredentials, gateKeyHint, normalizeGateCredentials, type GateCredentials } from "../lib/credential-vault.ts";
import { credentialMetadata } from "../lib/gate-readonly.ts";
import { clearOwnerSessionCookie, createOwnerSession, ownerAuthConfigured, ownerPasswordMatches, ownerSessionCookie, sameOriginMutation, verifyOwnerSession } from "../lib/owner-auth.ts";
import { eventAlignedFlow, updateRadar, type EventEntryAssessment, type RadarBaseline, type RadarCandidate } from "../lib/market-radar.ts";
import { anomalyCandidate, initialMarketRegimes, marketRegimeSummary, normalizeMarketRegimes, selectDiverseMarketPool, updateMarketRegimes,
  type MarketRegimeState } from "../lib/market-regime.ts";
import { advanceStrategyArena, applyStrategySleepStates, arenaSummary, initialStrategyArena, normalizeStrategyArena, observeStrategyArena,
  PORTFOLIO_REALTIME_CAPACITY, resetStrategyArenaAccount, type StrategyArenaState } from "../lib/strategy-arena.ts";

const LOOP_MS = 2_000;
const AUTHORITY_STALE_AFTER_MS = 8_000;
const FEED_HARD_FAILURE_COUNT = 4;
const FEED_HARD_FAILURE_MS = 15_000;
const FEED_RECOVERY_CONFIRMATIONS = 2;
const HEARTBEAT_MS = 30_000;
const UNIVERSE_MS = 10 * 60_000;
const RADAR_MS = 10_000;
const WARMUP_SNAPSHOTS = 4;
const MAX_ANCILLARY_CONCURRENCY = 2;
const MAX_OPEN_POSITIONS = PORTFOLIO_REALTIME_CAPACITY;
const SCAN_UNIVERSE_SIZE = 30;
const MAX_OUTBOX_ITEMS = 512;
const NON_ALARM_WRITE_CAP = 8_000;
const WATCHDOG_WRITE_RESERVE = 2_880;
const AUTHORITY_SCHEMA_VERSION = 1;
const DEFAULT_SYMBOLS = ["BTC_USDT", "ETH_USDT", "SOL_USDT"];

export interface CloudflareEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  MARKET_STREAM: DurableObjectNamespace<MarketStream>;
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
  missingSince: number | null;
  lastError: string | null;
};

type LivePosition = PaperPosition & {
  exchangeSize: number;
  leverage: number;
  margin: number;
  stopOrderId: string | null;
  stopTag: string | null;
  stopPrice: number | null;
  stopSubmittingAt: number | null;
  exitRequestedAt: number | null;
  exchangeUpdatedAt: number;
};

type LiveRuntime = {
  requestedEnabled: boolean;
  operational: boolean;
  changedAt: number | null;
  lastSyncAt: number | null;
  lastError: string | null;
  equity: number | null;
  available: number | null;
  credentialConfigured: boolean;
  entries: Record<string, LiveEntry | null>;
  positions: Record<string, LivePosition | null>;
  entrySkips: Record<string, { planId: string; symbol: string; code: LiveEntrySizingCode; reason: string; observedAt: number } | null>;
};

function initialLiveState(): LiveRuntime {
  return { requestedEnabled: false, operational: false, changedAt: null, lastSyncAt: null, lastError: null,
    equity: null, available: null, credentialConfigured: false, entries: {}, positions: {}, entrySkips: {} };
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
  utcDay: string;
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
  lastError: string | null;
  d1MirrorError: string | null;
  riskBreach: boolean;
  tickSize: Record<string, number>;
  contractMeta: Record<string, { quantoMultiplier: number; maintenanceRate: number; leverageMax: number; fundingRate: number }>;
  decisions: Record<string, Decision | null>;
  routes: Record<string, LiquidityRoute[]>;
  plans: Record<string, PaperPlan | null>;
  positions: Record<string, PaperPosition | null>;
  evidence: Record<string, { midpoint: number; bestBid?: number; bestAsk?: number; observedAt: number; warmup: number; fresh: boolean; ancillaryFresh: boolean;
    entryReady?: boolean; optionalFresh?: boolean; recoveryFreshCount?: number; suspensionReason?: string | null;
    topLong: LiquidityZone | null; topShort: LiquidityZone | null; absorption: number; range15m: RangeStructure | null }>;
  entryAssessments: Record<string, EventEntryAssessment | null>;
  strategyArena: StrategyArenaState;
  marketRegimes: MarketRegimeState;
  radar: { scanned: number; lastScanAt: number | null; candidates: RadarCandidate[] };
  analysisMs: number[];
  equity: number;
  outbox: PositionOutboxItem[];
  paperCycle: PaperCycle;
  bankruptcyOutbox: Array<{ report: BankruptcyReport; equity: number; equityVersion: number }>;
  live: LiveRuntime;
};

type Checkpoint = Omit<RuntimeState, "analysisMs">;

const day = (now = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
const safeError = (error: unknown) => error instanceof Error ? error.message.slice(0, 240) : "unknown error";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

function initialState(): RuntimeState {
  return {
    version: SYSTEM_VERSION, authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION, mode: "PAPER", state: "STARTING", symbols: DEFAULT_SYMBOLS,
    lastAlarmAt: null, lastSuccessAt: null, lastHeartbeatAt: null, lastStopCheckpointAt: null, nextAlarmAt: null, lastUniverseAt: 0, lastRadarAt: 0,
    utcDay: day(), dailyStartEquity: PAPER_INITIAL_EQUITY, alarmCount: 0, d1Writes: 0, nonAlarmWrites: 0, d1RetryAt: 0, d1FailureCount: 0, equityVersion: 0, ancillaryCursor: 0, subrequestCount: 0, maxSubrequestsInAlarm: 0, sequenceRebuilds: 0, lastProcessedSlot: -1, feedFailures: {},
    lastError: null, d1MirrorError: null, riskBreach: false, tickSize: Object.fromEntries(DEFAULT_SYMBOLS.map((symbol) => [symbol, 0.0001])), contractMeta: {},
    decisions: {}, routes: {}, plans: {}, positions: {}, evidence: {}, entryAssessments: {},
    strategyArena: initialStrategyArena(), marketRegimes: initialMarketRegimes(), analysisMs: [], equity: PAPER_INITIAL_EQUITY, outbox: [],
    radar: { scanned: 0, lastScanAt: null, candidates: [] }, paperCycle: startPaperCycle(Date.now()), bankruptcyOutbox: [], live: initialLiveState(),
  };
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

function paperRiskWithinLimits(runtime: RuntimeState, equity = markToMarketEquity(runtime)) {
  return openStressRisk(runtime) <= equity * PORTFOLIO_RISK_CAP + 1e-9
    && directionalStressRisk(runtime, "LONG") <= equity * CORRELATED_DIRECTION_RISK_CAP + 1e-9
    && directionalStressRisk(runtime, "SHORT") <= equity * CORRELATED_DIRECTION_RISK_CAP + 1e-9;
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
  private runtime = initialState();
  private memory: Record<string, SymbolMemory> = {};
  private structureCandles: Record<string, Partial<Record<"1m" | "15m" | "1h" | "4h", Awaited<ReturnType<typeof fetchStructureCandles>>>>> = {};
  private sessionWarmup: Record<string, number> = {};
  private radarBaselines: Record<string, RadarBaseline> = {};
  private contractCatalog = new Map<string, Awaited<ReturnType<typeof fetchActiveContracts>>[number]>();
  private authorityReady = true;
  private authorityView = { positions: {} as RuntimeState["positions"], equity: 1_000, equityVersion: 0 };
  private liveClient: GateLiveClient | null = null;

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Checkpoint>("checkpoint");
      if (saved?.authoritySchemaVersion === AUTHORITY_SCHEMA_VERSION) {
        const strategyCutover = saved.version !== SYSTEM_VERSION;
        this.runtime = { ...initialState(), ...saved, version: SYSTEM_VERSION, symbols: saved.symbols?.length ? saved.symbols : [...DEFAULT_SYMBOLS],
          lastUniverseAt: 0, lastRadarAt: 0, radar: saved.radar ?? { scanned: 0, lastScanAt: null, candidates: [] },
          strategyArena: normalizeStrategyArena(saved.strategyArena),
          marketRegimes: strategyCutover ? initialMarketRegimes() : normalizeMarketRegimes(saved.marketRegimes),
          equity: strategyCutover ? PAPER_INITIAL_EQUITY : saved.equity,
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
            requestedEnabled: false, operational: false }, analysisMs: [], state: "WARMING" };
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
      this.publishAuthority();
    });
  }

  private captureAuthority() {
    return structuredClone({ positions: this.runtime.positions, plans: this.runtime.plans, decisions: this.runtime.decisions, routes: this.runtime.routes,
      evidence: this.runtime.evidence, entryAssessments: this.runtime.entryAssessments,
      equity: this.runtime.equity, equityVersion: this.runtime.equityVersion,
      outbox: this.runtime.outbox, paperCycle: this.runtime.paperCycle, bankruptcyOutbox: this.runtime.bankruptcyOutbox,
      strategyArena: this.runtime.strategyArena, marketRegimes: this.runtime.marketRegimes,
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

  private resetDailyCounters(now: number) {
    if (day(now) !== this.runtime.utcDay) {
      this.runtime.utcDay = day(now);
      this.runtime.alarmCount = 0;
      this.runtime.d1Writes = 0;
      this.runtime.nonAlarmWrites = 0;
      this.runtime.subrequestCount = 0;
      this.runtime.maxSubrequestsInAlarm = 0;
      this.runtime.dailyStartEquity = markToMarketEquity(this.runtime);
    }
  }

  private refreshUniverse(now: number, ranked: Awaited<ReturnType<typeof fetchActiveContracts>>) {
    this.contractCatalog = new Map(ranked.map((row) => [row.symbol, row]));
    this.runtime.lastUniverseAt = now;
    for (const symbol of this.runtime.symbols) this.applyContractMetadata(symbol);
  }

  private applyContractMetadata(symbol: string) {
    const row = this.contractCatalog.get(symbol);
    if (!row) return;
    this.runtime.tickSize[symbol] = row.tickSize;
    this.runtime.contractMeta[symbol] = { quantoMultiplier: row.quantoMultiplier, maintenanceRate: row.maintenanceRate,
      leverageMax: row.leverageMax, fundingRate: row.fundingRate };
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
      ...Object.keys(this.runtime.feedFailures), ...Object.keys(this.runtime.tickSize), ...Object.keys(this.runtime.contractMeta)])) {
      if (next.includes(symbol)) continue;
      delete this.memory[symbol]; delete this.sessionWarmup[symbol]; delete this.runtime.decisions[symbol]; delete this.runtime.routes[symbol]; delete this.runtime.plans[symbol];
      delete this.runtime.positions[symbol]; delete this.runtime.evidence[symbol]; delete this.runtime.entryAssessments[symbol]; delete this.runtime.feedFailures[symbol];
      delete this.runtime.tickSize[symbol]; delete this.runtime.contractMeta[symbol];
    }
  }

  private refreshRadar(now: number, rows: Awaited<ReturnType<typeof fetchMarketTickers>>) {
    const eligible = new Set(this.contractCatalog.keys());
    const universeRows = rows.filter((row) => eligible.has(row.symbol))
      .sort((left, right) => right.volume24hUsd - left.volume24hUsd).slice(0, SCAN_UNIVERSE_SIZE);
    const universe = new Set(universeRows.map((row) => row.symbol));
    const radar = updateRadar(this.radarBaselines, universeRows, universe, now);
    this.radarBaselines = radar.baselines;
    this.runtime.radar = { scanned: radar.scanned, lastScanAt: now, candidates: radar.candidates };
    const regimes = updateMarketRegimes({ state: this.runtime.marketRegimes, rows: universeRows, eligible: universe, now });
    const allCandidates = [...regimes.candidates, ...radar.candidates.map(anomalyCandidate)]
      .sort((left, right) => right.score - left.score).slice(0, 36);
    this.runtime.marketRegimes = { ...regimes, candidates: allCandidates };
    this.runtime.strategyArena = applyStrategySleepStates(this.runtime.strategyArena,
      new Set(allCandidates.map((candidate) => candidate.channel)), now);
    this.runtime.lastRadarAt = now;
    const locked = this.runtime.symbols.filter((symbol) => this.runtime.positions[symbol]?.status === "OPEN"
      || this.runtime.plans[symbol]?.state === "PREPARED" || this.runtime.live.positions[symbol]?.status === "OPEN"
      || this.runtime.strategyArena.portfolioOpen[symbol]
      || Object.values(this.runtime.strategyArena.open).some((trade) => trade.symbol === symbol)
      || Boolean(this.runtime.live.entries[symbol] && !["FILLED", "CANCELLED"].includes(this.runtime.live.entries[symbol]!.status)));
    const liquidFallback = universeRows.map((row) => row.symbol);
    const next = selectDiverseMarketPool({ locked, current: this.runtime.symbols, candidates: allCandidates,
      fallback: liquidFallback, limit: PORTFOLIO_REALTIME_CAPACITY });
    if (next.length) this.applyRealtimeSymbols(next);
  }

  private observeArena(symbol: string, midpoint: number, analyzed: ReturnType<typeof analyzeSnapshot>, now: number,
    spreadRate: number, bestBid: number, bestAsk: number, bidDepthUsd: number, askDepthUsd: number) {
    this.runtime.strategyArena = advanceStrategyArena({ state: this.runtime.strategyArena,
      quotes: { [symbol]: { midpoint, bestBid, bestAsk } }, now });
    const candidates = this.runtime.marketRegimes.candidates.filter((row) => row.symbol === symbol);
    const memory = this.memory[symbol];
    if (!candidates.length || !memory) return;
    for (const candidate of candidates) {
      if (candidate.channel === "ANOMALY" && candidate.confirmations < 2) continue;
      this.runtime.strategyArena = observeStrategyArena({ state: this.runtime.strategyArena, observation: {
        candidate, midpoint, bestBid, bestAsk, alignedFlow: eventAlignedFlow(candidate.side, memory.flow), minuteNoiseRate: memory.minuteNoiseRate,
        spreadRate, range15m: analyzed.range15m, confirmationBySide: analyzed.confirmationBySide,
        fakeoutBySide: analyzed.fakeoutBySide, routes: analyzed.routes, bidDepthUsd, askDepthUsd,
        quantoMultiplier: this.runtime.contractMeta[symbol]?.quantoMultiplier,
        maintenanceRate: this.runtime.contractMeta[symbol]?.maintenanceRate, completedMinuteAt: memory.timeframeUpdatedAt.m1,
        leverageMax: this.runtime.contractMeta[symbol]?.leverageMax, now, dataFresh: true,
        contractReady: this.runtime.contractMeta[symbol] != null,
        managementCapacity: Object.keys(this.runtime.strategyArena.portfolioOpen)
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
        }])), now, reason: "V4切换：以新鲜可成交价格结算并归档V3模拟周期" });
    }
  }

  private priorityMinuteSymbols(now: number) {
    const completedMinute = Math.floor(now / 60_000) * 60_000;
    return this.runtime.symbols.filter((symbol) => {
      const plan = this.runtime.plans[symbol];
      const eventCandidate = this.runtime.marketRegimes.candidates.some((row) => row.symbol === symbol);
      return (eventCandidate || plan?.state === "PREPARED" && plan.marketState === "BREAKOUT")
        && (this.memory[symbol]?.timeframeUpdatedAt.m1 ?? 0) < completedMinute;
    });
  }

  private criticalEvidenceFresh(symbol: string, now: number) {
    const memory = this.memory[symbol] ?? emptySymbolMemory();
    const needsMinute = this.runtime.marketRegimes.candidates.some((row) => row.symbol === symbol)
      || this.runtime.plans[symbol]?.state === "PREPARED" || this.runtime.positions[symbol]?.status === "OPEN";
    return !needsMinute || now - memory.timeframeUpdatedAt.m1 <= 3 * 60_000;
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

  private async gateLive() {
    if (!this.env.OWNER_ACCESS_TOKEN) throw new Error("所有者访问码尚未配置");
    this.liveClient ??= await loadGateLiveClient(this.env.DB, this.env.OWNER_ACCESS_TOKEN);
    this.runtime.live.credentialConfigured = true;
    return this.liveClient;
  }

  private activeLivePositions() {
    return Object.values(this.runtime.live.positions).filter((position): position is LivePosition => position?.status === "OPEN");
  }

  private activeLiveEntries() {
    return Object.values(this.runtime.live.entries).filter((entry): entry is LiveEntry => Boolean(entry && !["FILLED", "CANCELLED"].includes(entry.status)));
  }

  private async replaceLiveCredentials(raw: GateCredentials) {
    if (this.runtime.live.requestedEnabled) throw new Error("请先关闭实盘开关，再更换 API");
    const credentials = normalizeGateCredentials(raw);
    if (credentials.environment !== "live") throw new Error("这里只接受 Gate 实盘 API");
    const candidate = new GateLiveClient(credentials);
    const snapshot = await candidate.snapshot();
    const equity = Number(snapshot.account.total);
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
    this.runtime.live.credentialConfigured = false;
    this.runtime.live.equity = null;
    this.runtime.live.available = null;
    this.runtime.live.lastSyncAt = null;
    this.runtime.live.lastError = null;
    await this.saveCheckpoint(Date.now(), true);
    return { ok: true, credential: await credentialMetadata(this.env.DB) };
  }

  private async resetPaperAccount() {
    const now = Date.now();
    const authorityBefore = this.captureAuthority();
    if (this.runtime.live.requestedEnabled || this.runtime.live.operational
      || Object.values(this.runtime.live.positions).some((position) => position?.status === "OPEN")
      || Object.values(this.runtime.live.entries).some((entry) => entry && !["FILLED", "CANCELLED"].includes(entry.status))) {
      throw new Error("请先关闭实盘并确认 Gate 没有本系统持仓或待成交订单");
    }
    const openPositions = Object.values(this.runtime.positions).filter((position): position is PaperPosition => position?.status === "OPEN");
    const arenaPositions = Object.values(this.runtime.strategyArena.portfolioOpen);
    for (const position of [...openPositions, ...arenaPositions]) {
      const evidence = this.runtime.evidence[position.symbol];
      if (!evidence?.fresh || now - evidence.observedAt > STALE_AFTER_MS || evidence.midpoint <= 0) {
        throw new Error(`${position.symbol} 行情不新鲜，不能用旧价格重置模拟持仓`);
      }
    }
    try {
      this.runtime.strategyArena = resetStrategyArenaAccount({ state: this.runtime.strategyArena,
        quotes: Object.fromEntries(arenaPositions.map((position) => {
          const evidence = this.runtime.evidence[position.symbol]!;
          return [position.symbol, { midpoint: evidence.midpoint, bestBid: evidence.bestBid, bestAsk: evidence.bestAsk }];
        })), now });
      for (const position of openPositions) {
        const closed = closePaperPosition(position, now, this.runtime.evidence[position.symbol]!.midpoint, "MANUAL_PAPER_RESET");
        this.runtime.positions[position.symbol] = closed;
        this.queueTransition(closed, position);
      }
      this.runtime.equity = PAPER_INITIAL_EQUITY;
      this.runtime.equityVersion += 1;
      this.runtime.paperCycle = startPaperCycle(now, PAPER_INITIAL_EQUITY, this.runtime.paperCycle.number + 1);
      this.runtime.positions = {};
      this.runtime.plans = {};
      this.runtime.decisions = {};
      this.runtime.routes = {};
      this.runtime.riskBreach = false;
      await this.saveCheckpoint(now, true);
      this.publishAuthority();
    } catch (error) {
      this.restoreAuthority(authorityBefore);
      this.publishAuthority();
      throw error;
    }
    await this.drainOutbox(now);
    try {
      await this.env.DB.batch([this.env.DB.prepare("UPDATE system_settings SET paper_equity=?,equity_version=?,updated_at=? WHERE id=1 AND equity_version<?")
        .bind(PAPER_INITIAL_EQUITY, this.runtime.equityVersion, now, this.runtime.equityVersion)]);
      this.runtime.d1Writes += 1;
    } catch (error) {
      this.runtime.d1MirrorError = `D1 reset mirror pending: ${safeError(error)}`;
    }
    return { ok: true, equity: this.runtime.strategyArena.portfolioEquity,
      strategyArena: arenaSummary(this.runtime.strategyArena), paperCycle: paperCycleSummary(this.runtime.paperCycle, this.runtime.equity) };
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

  private liveOpenRisk() {
    const positionRisk = Object.values(this.runtime.live.positions).reduce((sum, position) => sum + (position?.status === "OPEN"
      ? remainingStressRisk(position, this.runtime.evidence[position.symbol]?.midpoint ?? position.entryPrice) : 0), 0);
    const pendingRisk = Object.values(this.runtime.live.entries).reduce((sum, entry) => sum + (entry && ["SUBMITTING", "OPEN"].includes(entry.status)
      ? entry.plannedRisk : 0), 0);
    return positionRisk + pendingRisk;
  }

  private liveDirectionalRisk(side: Side) {
    const positionRisk = Object.values(this.runtime.live.positions).reduce((sum, position) => sum + (position?.status === "OPEN" && position.side === side
      ? remainingStressRisk(position, this.runtime.evidence[position.symbol]?.midpoint ?? position.entryPrice) : 0), 0);
    const pendingRisk = Object.values(this.runtime.live.entries).reduce((sum, entry) => sum + (entry && entry.side === side
      && ["SUBMITTING", "OPEN"].includes(entry.status) ? entry.plannedRisk : 0), 0);
    return positionRisk + pendingRisk;
  }

  private async cancelLiveEntry(client: GateLiveClient, entry: LiveEntry) {
    if (entry.status === "FILLED" || entry.status === "CANCELLED") return;
    if (entry.exchangeOrderId) await client.cancelOrder(entry.kind, entry.exchangeOrderId);
    entry.status = "CANCELLED";
    entry.lastError = null;
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
    if (position.stopOrderId && position.stopPrice != null && Math.abs(position.stopPrice - position.currentStop) < tick * 0.5) return;
    if (position.stopOrderId) {
      try {
        await client.amendStop(position.stopOrderId, position.currentStop);
        position.stopPrice = position.currentStop;
        return;
      } catch (error) {
        if (!position.exitRequestedAt) {
          position.exitRequestedAt = Date.now();
          position.exitReason = "PROTECTIVE_STOP_UPDATE_FAILED";
          await client.closePosition(position.symbol, liveExitTag(position.id));
        }
        throw new Error(`结构止损更新失败，已请求市价退出：${safeError(error)}`);
      }
    }
    if (position.stopTag && position.stopSubmittingAt && Date.now() - position.stopSubmittingAt < 6_000) return;
    const stop = buildLiveStopIntent(position);
    position.stopTag = stop.tag;
    position.stopPrice = position.currentStop;
    position.stopSubmittingAt = Date.now();
    await this.saveCheckpoint(Date.now(), true);
    try {
      const nextStopId = await client.createStop(stop);
      position.stopOrderId = nextStopId;
      position.stopSubmittingAt = null;
    } catch (error) {
      if (!position.exitRequestedAt) {
        position.exitRequestedAt = Date.now();
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

  private async syncLive(now: number, initialEnable = false, forceEntryCleanup = false) {
    const desiredPortfolio = this.runtime.strategyArena.portfolioOpen;
    const activePositions = Object.values(this.runtime.live.positions).some((position) => position?.status === "OPEN");
    const activeEntries = Object.values(this.runtime.live.entries).some((entry) => entry && !["FILLED", "CANCELLED"].includes(entry.status));
    if (!this.runtime.live.requestedEnabled && !activePositions && !activeEntries && !initialEnable && !forceEntryCleanup) return;
    const client = await this.gateLive();
    let snapshot = await client.snapshot();
    const knownTags = new Set([
      ...Object.values(this.runtime.live.entries).flatMap((entry) => entry?.tag && !["FILLED", "CANCELLED"].includes(entry.status) ? [entry.tag] : []),
      ...Object.values(this.runtime.live.positions).flatMap((position) => position?.status === "OPEN" && position.stopTag ? [position.stopTag] : []),
    ]);
    const trackedEntryIds = new Set(Object.values(this.runtime.live.entries)
      .flatMap((entry) => entry?.exchangeOrderId ? [entry.exchangeOrderId] : []));
    snapshot = forceEntryCleanup
      ? await this.cancelAndConfirmSystemEntries(client, snapshot, trackedEntryIds)
      : await this.cancelAndConfirmSystemEntries(client, snapshot, trackedEntryIds, knownTags);
    if (forceEntryCleanup) {
      for (const entry of Object.values(this.runtime.live.entries)) {
        if (!entry || ["FILLED", "CANCELLED"].includes(entry.status)) continue;
        entry.status = "CANCELLED";
        entry.missingSince = null;
        entry.lastError = null;
      }
    }
    const equity = Number(snapshot.account.total ?? 0);
    const available = Number(snapshot.account.available ?? 0);
    if (!(equity > 0) || !(available >= 0)) throw new Error("Gate 合约账户权益不可用");
    if (snapshot.account.in_dual_mode === true || ["dual", "dual_plus"].includes(String(snapshot.account.position_mode ?? "").toLowerCase())) {
      throw new Error("Gate 当前不是单向持仓模式");
    }
    this.runtime.live.equity = equity;
    this.runtime.live.available = available;
    this.runtime.live.lastSyncAt = now;

    const exchangeOrders = [...snapshot.orders, ...snapshot.priceOrders];
    const unknownOrders = exchangeOrders.filter((order) => !knownTags.has(liveOrderTag(order) ?? ""));
    const actualPositions = snapshot.positions.filter((position) => Number(position.size ?? 0) !== 0);
    const unmanagedPositions = actualPositions.filter((actual) => {
      const symbol = actual.contract ?? "";
      const side: Side = Number(actual.size ?? 0) > 0 ? "LONG" : "SHORT";
      const position = this.runtime.live.positions[symbol];
      const entry = this.runtime.live.entries[symbol];
      return !(position?.status === "OPEN" && position.side === side)
        && !(entry?.side === side && (["SUBMITTING", "OPEN", "FILLED", "ERROR"].includes(entry.status)
          || (entry.status === "CANCELLED" && now - entry.createdAt < 60_000)));
    });
    if (initialEnable && (unknownOrders.length || unmanagedPositions.length)) {
      throw new Error("Gate 已有未纳管仓位或挂单；为避免冲突，实盘未开启");
    }

    for (const [symbol, entry] of Object.entries(this.runtime.live.entries)) {
      if (!entry || entry.status === "FILLED" || entry.status === "CANCELLED") continue;
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
          entry.lastError = entry.status === "ERROR" ? `Gate 挂单执行失败：${inspected.finish_as ?? inspected.status ?? "unknown"}` : null;
        } else if (now - entry.missingSince >= 6_000) {
          entry.status = "CANCELLED";
        }
      }
      const selectedTrade = desiredPortfolio[symbol] ?? null;
      const shouldCancel = !this.runtime.live.requestedEnabled || !selectedTrade || selectedTrade.id !== entry.planId
        || now >= entry.expiresAt || !this.symbolEntryReady(symbol);
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
        if (selectedTrade && selectedTrade.id !== entry.planId) throw new Error(`发现与模拟账户订单不一致的实盘仓位 ${symbol}`);
        const entryPrice = Number(actual.entry_price ?? entry.trigger) || entry.trigger;
        const multiplier = this.runtime.contractMeta[symbol]?.quantoMultiplier ?? 1;
        const notional = Math.abs(exchangeSize) * entryPrice * multiplier;
        const leverage = Math.max(1, Number(actual.leverage ?? entry.leverage) || entry.leverage);
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
          stopOrderId: null, stopTag: null, stopPrice: null, stopSubmittingAt: null, exitRequestedAt: null, exchangeUpdatedAt: now,
        };
        this.runtime.live.positions[symbol] = position;
        entry.status = "FILLED";
        entry.missingSince = null;
      } else if (position.side !== side) {
        throw new Error(`${symbol} 实盘方向与系统记录冲突`);
      }
      position.exchangeUpdatedAt = now;
      const selectedTrade = desiredPortfolio[symbol] ?? null;
      if (!position.exitRequestedAt && liveMirrorExitRequired(position.id, selectedTrade)) {
        position.exitRequestedAt = now;
        position.exitReason = "PAPER_PORTFOLIO_EXIT";
        await client.closePosition(symbol, liveExitTag(position.id));
      } else if (!position.exitRequestedAt && selectedTrade) {
        position.currentStop = selectedTrade.stopPrice;
        position.currentTarget = selectedTrade.targetPrice;
        position.targetScore = selectedTrade.context.candidateScore;
        position.targetIdentity = `arena:${selectedTrade.id}`;
        this.runtime.live.positions[symbol] = position;
      }
      if (!position.exitRequestedAt) {
        await this.ensureLiveStop(client, position, snapshot.priceOrders);
        if (this.liveOpenRisk() > equity * PORTFOLIO_RISK_CAP + 1e-8
          || this.liveDirectionalRisk(position.side) > equity * CORRELATED_DIRECTION_RISK_CAP + 1e-8) {
          position.exitRequestedAt = now;
          position.exitReason = "RISK_CAP_AFTER_FILL";
          await client.closePosition(symbol, liveExitTag(position.id));
        }
      } else if (now - position.exitRequestedAt >= 6_000) {
        position.exitRequestedAt = now;
        await client.closePosition(symbol, liveExitTag(position.id));
      }
    }

    for (const [symbol, position] of Object.entries(this.runtime.live.positions)) {
      if (!position || position.status !== "OPEN") continue;
      const actual = actualPositions.find((row) => row.contract === symbol && Number(row.size ?? 0) !== 0);
      if (actual) continue;
      const stopId = position.stopOrderId ?? (position.stopTag
        ? liveOrderId(snapshot.priceOrders.find((order) => liveOrderTag(order) === position.stopTag) ?? {})
        : null);
      if (stopId) await client.cancelOrder("PRICE_TRIGGER", stopId);
      this.runtime.live.positions[symbol] = { ...position, status: "CLOSED", exitAt: now,
        exitPrice: this.runtime.evidence[symbol]?.midpoint ?? position.entryPrice,
        exitReason: position.exitReason ?? "EXCHANGE_FLAT", stopOrderId: null, stopTag: null, stopPrice: null, stopSubmittingAt: null };
    }

    if (!this.runtime.live.requestedEnabled) {
      this.runtime.live.operational = false;
      this.runtime.live.lastError = null;
      this.runtime.live.entrySkips = {};
      return;
    }
    if (unknownOrders.length) throw new Error("Gate 存在未纳管挂单；已停止新开仓");

    this.runtime.live.operational = true;
    this.runtime.live.lastError = null;
    let availableForNewEntries = available;
    let riskForNewEntries = this.liveOpenRisk();
    const directionRiskForNewEntries: Record<Side, number> = {
      LONG: this.liveDirectionalRisk("LONG"),
      SHORT: this.liveDirectionalRisk("SHORT"),
    };
    let marginForNewEntries = [
      ...Object.values(this.runtime.live.positions).filter((position) => position?.status === "OPEN"),
      ...Object.values(this.runtime.live.entries).filter((entry) => entry && ["SUBMITTING", "OPEN"].includes(entry.status)),
    ].reduce((sum, item) => sum + (item?.margin ?? 0), 0);
    const staged: Array<{ symbol: string; plan: PaperPlan; intent: ReturnType<typeof buildLiveEntryIntent> }> = [];
    for (const [symbol, skip] of Object.entries(this.runtime.live.entrySkips)) {
      const trade = desiredPortfolio[symbol] ?? null;
      if (!skip || !trade || trade.id !== skip.planId || now >= trade.openedAt + 45 * 60_000) delete this.runtime.live.entrySkips[symbol];
    }
    for (const trade of Object.values(desiredPortfolio)) {
      const symbol = trade.symbol;
      const plan = arenaTradePlan(trade);
      const justTriggeredEntry = eligibleForLiveMirror(trade, this.runtime.live.changedAt, now);
      if (!justTriggeredEntry || now >= plan.expiresAt
        || this.runtime.live.positions[symbol]?.status === "OPEN" || !this.symbolEntryReady(symbol)) {
        delete this.runtime.live.entrySkips[symbol];
        continue;
      }
      const midpoint = this.runtime.evidence[symbol]?.midpoint ?? 0;
      if (!(midpoint > 0)) continue;
      const prior = this.runtime.live.entries[symbol];
      // A timed-out submission remains reserved until Gate proves it absent for
      // six seconds. Never replay the same plan while its status is ambiguous.
      if (prior && prior.planId === plan.id && prior.status !== "CANCELLED") {
        delete this.runtime.live.entrySkips[symbol];
        continue;
      }
      if (prior && !["FILLED", "CANCELLED"].includes(prior.status)) await this.cancelLiveEntry(client, prior);
      let intent: ReturnType<typeof buildLiveEntryIntent>;
      try {
        intent = buildLiveEntryIntent({ plan, equity, available: availableForNewEntries, openRisk: riskForNewEntries,
          sameDirectionRisk: directionRiskForNewEntries[plan.side],
          entryPrice: midpoint,
          quantoMultiplier: this.runtime.contractMeta[symbol]?.quantoMultiplier ?? 1,
          maintenanceRate: this.runtime.contractMeta[symbol]?.maintenanceRate ?? 0.005,
          leverageMax: this.runtime.contractMeta[symbol]?.leverageMax ?? 50, openMargin: marginForNewEntries,
          mirrorNotionalFraction: trade.notional / Math.max(trade.accountEquityAtOpen, 1e-9),
          modeledCostRate: trade.context.modeledCostRate });
      } catch (error) {
        if (!(error instanceof LiveEntrySizingError)) throw error;
        this.runtime.live.entrySkips[symbol] = { planId: plan.id, symbol, code: error.code, reason: error.message, observedAt: now };
        continue;
      }
      delete this.runtime.live.entrySkips[symbol];
      availableForNewEntries = Math.max(0, availableForNewEntries - intent.margin);
      riskForNewEntries += intent.plannedRisk;
      directionRiskForNewEntries[plan.side] += intent.plannedRisk;
      marginForNewEntries += intent.margin;
      staged.push({ symbol, plan, intent });
    }
    for (const { symbol, plan, intent } of staged) {
      const entry: LiveEntry = {
        planId: plan.id, symbol, side: plan.side, scenario: plan.marketState, kind: intent.kind, status: "SUBMITTING",
        tag: intent.tag, exchangeOrderId: null, createdAt: now, expiresAt: plan.expiresAt, trigger: plan.entryTrigger,
        invalidation: plan.invalidation, target: plan.target, targetIdentity: plan.targetIdentity, targetScore: plan.score,
        routeId: plan.routeId, routeKind: plan.routeKind, targetTimeframe: plan.targetTimeframe,
        rangeBoundary: plan.rangeBoundary, rangeBuffer: plan.rangeBuffer, sweepExtreme: plan.sweepExtreme,
        reclaimSource: plan.reclaimSource, reclaimStrength: plan.reclaimStrength,
        size: intent.size, contracts: intent.contracts,
        notional: intent.notional, plannedRisk: intent.plannedRisk, leverage: intent.leverage, margin: intent.margin,
        missingSince: null, lastError: null,
      };
      this.runtime.live.entries[symbol] = entry;
      await this.saveCheckpoint(now, true);
      try {
        await client.setLeverage(symbol, intent.leverage);
        entry.exchangeOrderId = await client.createEntry(intent);
        entry.status = "OPEN";
      } catch (error) {
        entry.status = "ERROR";
        entry.lastError = safeError(error);
        throw error;
      }
    }
  }

  private async setLiveMode(enabled: boolean) {
    this.runtime.live.requestedEnabled = enabled;
    if (!enabled) this.runtime.live.operational = false;
    this.runtime.live.changedAt = Date.now();
    this.runtime.live.lastError = null;
    try {
      await this.syncLive(Date.now(), enabled, !enabled);
      await this.saveCheckpoint(Date.now(), true);
      return { ok: true, live: this.runtime.live };
    } catch (error) {
      let cleanupError: string | null = null;
      if (enabled) {
        this.runtime.live.requestedEnabled = false;
        try { await this.syncLive(Date.now(), false, true); }
        catch (cleanupFailure) { cleanupError = safeError(cleanupFailure); }
      }
      this.runtime.live.operational = false;
      this.runtime.live.lastError = cleanupError ? `${safeError(error)}；撤单核对失败：${cleanupError}` : safeError(error);
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
    return { entryReady, recoveryFreshCount };
  }

  private symbolEntryReady(symbol: string) {
    const evidence = this.runtime.evidence[symbol];
    return Boolean(evidence?.fresh && evidence.ancillaryFresh && evidence.entryReady !== false);
  }

  private realtimeReadiness() {
    const protectedSymbols = new Set([
      ...Object.values(this.runtime.positions).flatMap((position) => position?.status === "OPEN" ? [position.symbol] : []),
      ...Object.values(this.runtime.plans).flatMap((plan) => plan?.state === "PREPARED" ? [plan.symbol] : []),
      ...Object.values(this.runtime.live.positions).flatMap((position) => position?.status === "OPEN" ? [position.symbol] : []),
      ...Object.values(this.runtime.live.entries).flatMap((entry) => entry && !["FILLED", "CANCELLED"].includes(entry.status) ? [entry.symbol] : []),
      ...Object.values(this.runtime.strategyArena.portfolioOpen).map((position) => position.symbol),
    ]);
    const actionableMarkets = this.runtime.symbols.filter((symbol) => (this.sessionWarmup[symbol] ?? 0) >= WARMUP_SNAPSHOTS
      && this.runtime.contractMeta[symbol] != null && this.symbolEntryReady(symbol)).length;
    const protectedMarketsReady = [...protectedSymbols].every((symbol) => this.runtime.symbols.includes(symbol)
      && (this.sessionWarmup[symbol] ?? 0) >= WARMUP_SNAPSHOTS && this.runtime.contractMeta[symbol] != null
      && this.symbolEntryReady(symbol));
    return { capacity: PORTFOLIO_REALTIME_CAPACITY, actionableMarkets,
      warmingMarkets: Math.max(0, this.runtime.symbols.length - actionableMarkets),
      protectedMarkets: protectedSymbols.size, protectedMarketsReady };
  }

  private async processBooks(now: number, cycleSymbols = [...this.runtime.symbols]) {
    const authorityBefore = this.captureAuthority();
    const dueSymbols = cycleSymbols.filter((symbol) => (this.runtime.feedFailures[symbol]?.retryAt ?? 0) <= now);
    const rows = await Promise.allSettled(dueSymbols.map(async (symbol) => ({
      symbol, snapshot: await fetchFuturesBook(symbol, this.runtime.tickSize[symbol] ?? 0.0001, this.runtime.contractMeta[symbol]?.quantoMultiplier ?? 1),
    })));
    let successes = 0;
    let criticalChanged = false;
    let stopCheckpointDue = false;
    const closedThisCycle = new Set<string>();
    const analyzedRows: Array<{ symbol: string; snapshot: Awaited<ReturnType<typeof fetchFuturesBook>>; validation: ReturnType<typeof usableSnapshot>; analyzed: ReturnType<typeof analyzeSnapshot> }> = [];
    for (let index = 0; index < rows.length; index += 1) {
      const result = rows[index];
      const attemptedSymbol = dueSymbols[index];
      if (result.status !== "fulfilled") {
        const prior = this.runtime.feedFailures[attemptedSymbol]?.count ?? 0;
        const count = Math.min(5, prior + 1);
        const backoff = [2_000, 4_000, 8_000, 16_000, 30_000][count - 1];
        const gateRetry = result.reason instanceof GatePublicError ? result.reason.retryAt : null;
        criticalChanged = this.suspendSymbol(attemptedSymbol, now, safeError(result.reason), Math.max(now + backoff, gateRetry ?? 0)) || criticalChanged;
        continue;
      }
      const { symbol, snapshot } = result.value;
      let memory = this.memory[symbol] ??= emptySymbolMemory();
      // Network time belongs to freshness validation too. An exchange update
      // received near the request timeout may legitimately be later than the
      // alarm's start timestamp.
      const validation = usableSnapshot(snapshot, Math.max(now, Date.now()), memory.lastSequence, memory.lastBookObservedAt);
      if (!validation.fresh) {
        criticalChanged = this.suspendSymbol(symbol, now, "Gate 订单簿时间戳失鲜", now + LOOP_MS) || criticalChanged;
        continue;
      }
      if (validation.sequenceReset) {
        const replacement = emptySymbolMemory();
        replacement.quantoMultiplier = memory.quantoMultiplier;
        replacement.maintenanceRate = memory.maintenanceRate;
        replacement.flow.funding = memory.flow.funding;
        this.memory[symbol] = memory = replacement;
        this.sessionWarmup[symbol] = 0;
      }
      const progressed = validation.advanced || validation.sequenceReset;
      if (validation.sequenceFault || validation.sequenceReset) {
        this.runtime.sequenceRebuilds += 1;
        const plan = this.runtime.plans[symbol];
        if (plan?.state === "PREPARED") {
          this.runtime.plans[symbol] = { ...plan, state: "CANCELLED", cancelReason: "SEQUENCE_REBUILD_CANCEL", cancelledAt: now };
          criticalChanged = true;
        }
        this.runtime.decisions[symbol] = null;
        this.runtime.routes[symbol] = [];
        if (validation.sequenceFault) {
          if (this.runtime.evidence[symbol]) {
            this.runtime.evidence[symbol].fresh = false;
            this.runtime.evidence[symbol].entryReady = false;
            this.runtime.evidence[symbol].suspensionReason = "订单簿序列异常，原计划已撤销";
          }
          continue;
        }
      }
      const recovery = this.acceptFreshSymbol(symbol, now, snapshot.observedAt, progressed);
      if (validation.fresh && !validation.sequenceFault && progressed) {
        successes += 1;
      }
      if (validation.fresh && validation.unchanged) successes += 1;
      if (validation.fresh && !validation.sequenceFault && progressed) {
        applyFlow(memory, snapshot);
        this.sessionWarmup[symbol] = (this.sessionWarmup[symbol] ?? 0) + 1;
      }
      if (validation.unchanged) {
        if (this.runtime.evidence[symbol]) {
          const coreFresh = this.criticalEvidenceFresh(symbol, now);
          this.runtime.evidence[symbol].fresh = true;
          this.runtime.evidence[symbol].ancillaryFresh = coreFresh;
          this.runtime.evidence[symbol].optionalFresh = optionalEvidenceIsFresh(memory, now);
          this.runtime.evidence[symbol].entryReady = recovery.entryReady && coreFresh;
          this.runtime.evidence[symbol].recoveryFreshCount = recovery.recoveryFreshCount;
          this.runtime.evidence[symbol].suspensionReason = recovery.entryReady ? null : "已恢复第一份盘口，等待第二份新盘口确认";
        }
        continue;
      }
      const analysisStart = performance.now();
      const analyzed = validation.fresh && !validation.sequenceFault && progressed
        ? analyzeSnapshot(memory, snapshot)
        : { midpoint: memory.lastMid, zones: [] as LiquidityZone[], bands: [], absorption: 0, decision: null,
          routes: [] as LiquidityRoute[], range15m: memory.range15m, confirmationBySide: { LONG: 0, SHORT: 0 },
          fakeoutBySide: { LONG: 1, SHORT: 1 } };
      this.runtime.analysisMs.push(performance.now() - analysisStart);
      if (this.runtime.analysisMs.length > 240) this.runtime.analysisMs.shift();
      const priorPlan = this.runtime.plans[symbol] ?? null;
      const priorPosition = this.runtime.positions[symbol] ?? null;
      const ancillaryFresh = this.criticalEvidenceFresh(symbol, now);
      const optionalFresh = optionalEvidenceIsFresh(memory, now);
      const contractReady = this.runtime.contractMeta[symbol] != null;
      const entryReady = recovery.entryReady && ancillaryFresh;
      const decision: Decision | null = null;
      if (this.authorityReady && contractReady && entryReady && (this.sessionWarmup[symbol] ?? 0) >= WARMUP_SNAPSHOTS) {
        const bestBid = snapshot.bids[0]?.price ?? analyzed.midpoint;
        const bestAsk = snapshot.asks[0]?.price ?? analyzed.midpoint;
        const spreadRate = bestAsk >= bestBid ? (bestAsk - bestBid) / Math.max(analyzed.midpoint, 1e-9) : 0;
        this.observeArena(symbol, analyzed.midpoint, analyzed, now, spreadRate, bestBid, bestAsk,
          snapshot.bids.slice(0, 5).reduce((total, level) => total + level.size, 0),
          snapshot.asks.slice(0, 5).reduce((total, level) => total + level.size, 0));
      }
      const openRisk = openStressRisk(this.runtime);
      const planSide = priorPlan?.state === "PREPARED" ? priorPlan.side : undefined;
      const reconciled = reconcilePaper({ now, midpoint: analyzed.midpoint, fresh: validation.fresh, sequenceFault: validation.sequenceFault,
        decision, plan: priorPlan, position: priorPosition, zones: analyzed.zones, absorption: analyzed.absorption,
        confirmationMinute: memory.timeframeUpdatedAt.m1, confirmationPrice: memory.lastCompletedMinuteClose,
        confirmationCandle: memory.lastCompletedMinuteCandle,
        equity: markToMarketEquity(this.runtime), openRisk, sameDirectionRisk: directionalStressRisk(this.runtime, planSide), allowOpen: false,
        protectOnly: (this.sessionWarmup[symbol] ?? 0) < WARMUP_SNAPSHOTS,
        activeRoutes: analyzed.routes, breakoutConfirmation: priorPlan ? analyzed.confirmationBySide[priorPlan.side] : undefined,
        breakoutFakeoutRisk: priorPlan ? analyzed.fakeoutBySide[priorPlan.side] : undefined,
        maintenanceRate: this.runtime.contractMeta[symbol]?.maintenanceRate, leverageMax: this.runtime.contractMeta[symbol]?.leverageMax });
      this.runtime.decisions[symbol] = decision;
      this.runtime.entryAssessments[symbol] = null;
      this.runtime.routes[symbol] = [];
      this.runtime.plans[symbol] = reconciled.plan;
      const closedNow = priorPosition?.status === "OPEN" && reconciled.position?.status === "CLOSED";
      if (closedNow) closedThisCycle.add(symbol);
      const stopTightened = priorPosition?.status === "OPEN" && reconciled.position?.status === "OPEN" && priorPosition.currentStop !== reconciled.position.currentStop;
      if (stopTightened && this.runtime.lastStopCheckpointAt != null && now - this.runtime.lastStopCheckpointAt < 60_000) {
        reconciled.position = { ...reconciled.position!, currentStop: priorPosition.currentStop };
      } else if (stopTightened) {
        stopCheckpointDue = true;
      }
      this.runtime.positions[symbol] = reconciled.position;
      this.runtime.evidence[symbol] = {
        midpoint: analyzed.midpoint, bestBid: snapshot.bids[0]?.price ?? analyzed.midpoint,
        bestAsk: snapshot.asks[0]?.price ?? analyzed.midpoint,
        observedAt: snapshot.observedAt, warmup: Math.min(WARMUP_SNAPSHOTS, this.sessionWarmup[symbol] ?? 0),
        fresh: true, ancillaryFresh, optionalFresh, entryReady,
        recoveryFreshCount: recovery.recoveryFreshCount,
        suspensionReason: !ancillaryFresh ? "关键周期结构正在刷新，禁止成交" : recovery.entryReady ? null : "已恢复第一份盘口，等待第二份新盘口确认",
        topLong: analyzed.zones.filter((zone) => zone.side === "LONG").sort((a, b) => b.score - a.score)[0] ?? null,
        topShort: analyzed.zones.filter((zone) => zone.side === "SHORT").sort((a, b) => b.score - a.score)[0] ?? null,
        absorption: analyzed.absorption, range15m: analyzed.range15m,
      };
      if (validation.fresh && !validation.sequenceFault && progressed) {
        memory.lastSequence = snapshot.sequence || memory.lastSequence;
        memory.lastBookObservedAt = snapshot.observedAt;
      }
      this.queueTransition(reconciled.position, priorPosition);
      if (priorPosition?.status !== reconciled.position?.status || (priorPosition?.status === "OPEN" && reconciled.position?.status === "OPEN" && priorPosition.currentStop !== reconciled.position.currentStop)) criticalChanged = true;
      analyzedRows.push({ symbol, snapshot, validation, analyzed });
    }
    for (const symbol of cycleSymbols.filter((item) => !dueSymbols.includes(item))) {
      const feed = this.runtime.feedFailures[symbol];
      criticalChanged = this.suspendSymbol(symbol, now, feed?.lastError ?? "等待 Gate 重试", feed?.retryAt ?? now + LOOP_MS, false) || criticalChanged;
    }
    // A realized loss can shrink the 10% cap. Reduce weakest fresh PAPER exposure before considering any new entry.
    for (const candidate of Object.values(this.runtime.positions)
      .filter((position): position is PaperPosition => position?.status === "OPEN")
      .sort((a, b) => a.targetScore - b.targetScore)) {
      if (paperRiskWithinLimits(this.runtime)) break;
      const row = analyzedRows.find((item) => item.symbol === candidate.symbol && item.validation.fresh && !item.validation.sequenceFault);
      if (!row) continue;
      const closed = closePaperPosition(candidate, now, row.analyzed.midpoint, "PORTFOLIO_RISK_REBALANCE");
      this.runtime.positions[candidate.symbol] = closed;
      this.queueTransition(closed, candidate);
      closedThisCycle.add(candidate.symbol);
      criticalChanged = true;
    }
    const paperEquity = markToMarketEquity(this.runtime);
    this.runtime.paperCycle.peakEquity = Math.max(this.runtime.paperCycle.peakEquity, paperEquity);
    let bankruptcyPending = paperEquity <= PAPER_BANKRUPTCY_EQUITY;
    let rolledOverThisCycle = false;
    if (bankruptcyPending) {
      for (const symbol of this.runtime.symbols) {
        const plan = this.runtime.plans[symbol];
        if (plan?.state === "PREPARED") {
          this.runtime.plans[symbol] = { ...plan, state: "CANCELLED", cancelReason: "PAPER_CYCLE_BANKRUPTCY", cancelledAt: now };
          criticalChanged = true;
        }
        const position = this.runtime.positions[symbol];
        if (position?.status !== "OPEN") continue;
        const evidence = this.runtime.evidence[symbol];
        if (!evidence?.fresh || now - evidence.observedAt > STALE_AFTER_MS || evidence.midpoint <= 0) continue;
        const closed = closePaperPosition(position, now, evidence.midpoint, "PAPER_CYCLE_BANKRUPTCY");
        this.runtime.positions[symbol] = closed;
        this.queueTransition(closed, position);
        closedThisCycle.add(symbol);
        criticalChanged = true;
      }
      const openPositionsRemain = Object.values(this.runtime.positions).some((position) => position?.status === "OPEN");
      if (!openPositionsRemain) {
        const report = buildBankruptcyReport(this.runtime.paperCycle, now, this.runtime.equity);
        if (!this.runtime.bankruptcyOutbox.some((item) => item.report.id === report.id)) {
          const nextVersion = this.runtime.equityVersion + 1;
          this.runtime.bankruptcyOutbox.push({ report, equity: PAPER_INITIAL_EQUITY, equityVersion: nextVersion });
          this.runtime.equityVersion = nextVersion;
        }
        const nextCycleNumber = this.runtime.paperCycle.number + 1;
        this.runtime.equity = PAPER_INITIAL_EQUITY;
        this.runtime.paperCycle = startPaperCycle(now, PAPER_INITIAL_EQUITY, nextCycleNumber);
        this.runtime.positions = {};
        this.runtime.plans = {};
        this.runtime.decisions = {};
        this.runtime.routes = {};
        bankruptcyPending = false;
        rolledOverThisCycle = true;
        criticalChanged = true;
      }
    }
    this.runtime.riskBreach = !paperRiskWithinLimits(this.runtime);
    // Exits update draft absolute equity before candidates are ranked; nothing is published yet.
    const rankedCandidates = analyzedRows
      .filter(({ symbol, validation }) => !bankruptcyPending && !rolledOverThisCycle && validation.fresh && !validation.sequenceFault && !closedThisCycle.has(symbol) && this.runtime.positions[symbol]?.status !== "OPEN")
      .filter(({ symbol }) => this.symbolEntryReady(symbol))
      .filter(({ symbol }) => this.runtime.plans[symbol]?.state === "PREPARED")
      .sort((a, b) => {
        const utility = (row: typeof a) => {
          const plan = this.runtime.plans[row.symbol];
          if (!plan || plan.state !== "PREPARED") return -Infinity;
          const reward = Math.abs(plan.target - row.analyzed.midpoint) / Math.max(row.analyzed.midpoint, 1e-9) - 0.0018;
          return reward > 0 ? plan.score * reward / Math.max(plan.plannedRisk, 1e-9) : -Infinity;
        };
        return utility(b) - utility(a);
      });
    let openedThisCycle = false;
    for (const row of rankedCandidates) {
      if (this.runtime.riskBreach) break;
      const openCount = Object.values(this.runtime.positions).filter((position) => position?.status === "OPEN").length;
      if (openCount >= MAX_OPEN_POSITIONS) break;
      if (this.runtime.nonAlarmWrites + 1 + openCount + 1 > NON_ALARM_WRITE_CAP) break;
      if (this.runtime.outbox.length + openCount + 1 > MAX_OUTBOX_ITEMS) break;
      if (Object.values(this.runtime.positions).some((position) => position?.status === "OPEN" && !this.runtime.evidence[position.symbol]?.fresh)) break;
      const priorPosition = this.runtime.positions[row.symbol] ?? null;
      const priorPlan = this.runtime.plans[row.symbol] ?? null;
      const openRisk = openStressRisk(this.runtime);
      const planSide = priorPlan?.state === "PREPARED" ? priorPlan.side : this.runtime.decisions[row.symbol]?.side;
      const reconciled = reconcilePaper({ now, midpoint: row.analyzed.midpoint, fresh: true, sequenceFault: false,
        decision: this.runtime.decisions[row.symbol], plan: priorPlan, position: priorPosition, zones: row.analyzed.zones,
        absorption: row.analyzed.absorption, confirmationMinute: this.memory[row.symbol]?.timeframeUpdatedAt.m1,
        confirmationPrice: this.memory[row.symbol]?.lastCompletedMinuteClose,
        confirmationCandle: this.memory[row.symbol]?.lastCompletedMinuteCandle,
        equity: markToMarketEquity(this.runtime), openRisk, sameDirectionRisk: directionalStressRisk(this.runtime, planSide), allowOpen: true,
        activeRoutes: row.analyzed.routes, breakoutConfirmation: priorPlan ? row.analyzed.confirmationBySide[priorPlan.side] : undefined,
        breakoutFakeoutRisk: priorPlan ? row.analyzed.fakeoutBySide[priorPlan.side] : undefined,
        maintenanceRate: this.runtime.contractMeta[row.symbol]?.maintenanceRate, leverageMax: this.runtime.contractMeta[row.symbol]?.leverageMax });
      this.runtime.plans[row.symbol] = reconciled.plan;
      this.runtime.positions[row.symbol] = reconciled.position;
      this.queueTransition(reconciled.position, priorPosition);
      if (priorPosition?.status !== reconciled.position?.status) { criticalChanged = true; openedThisCycle = true; }
    }
    if (criticalChanged || openedThisCycle) {
      const priorStopCheckpointAt = this.runtime.lastStopCheckpointAt;
      if (stopCheckpointDue) this.runtime.lastStopCheckpointAt = now;
      try {
        await this.saveCheckpoint(now, true);
        this.publishAuthority();
      } catch (error) {
        this.runtime.lastStopCheckpointAt = priorStopCheckpointAt;
        this.restoreAuthority(authorityBefore);
        throw error;
      }
    }
    await this.drainOutbox(now);
    return { successes, requests: dueSymbols.length, criticalChanged };
  }

  private async saveCheckpoint(now: number, force = false) {
    if (!force && this.runtime.lastHeartbeatAt != null && now - this.runtime.lastHeartbeatAt < HEARTBEAT_MS) return;
    const openCount = Object.values(this.runtime.positions).filter((position) => position?.status === "OPEN").length;
    if (this.runtime.nonAlarmWrites + 1 + openCount > NON_ALARM_WRITE_CAP) {
      if (force) throw new Error("Durable Object non-alarm write reserve reached");
      return;
    }
    const checkpoint = { ...this.runtime, analysisMs: [], nonAlarmWrites: this.runtime.nonAlarmWrites + 1, lastHeartbeatAt: now };
    await this.ctx.storage.put("checkpoint", checkpoint);
    this.runtime.nonAlarmWrites += 1;
    this.runtime.lastHeartbeatAt = now;
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
    this.runtime.lastAlarmAt = now;
    this.runtime.alarmCount += 1;
    let subrequests = 0;
    try {
      const universeDue = now - this.runtime.lastUniverseAt >= UNIVERSE_MS;
      if (universeDue) {
        subrequests += 2;
        try { this.refreshUniverse(now, await fetchActiveContracts()); }
        catch (error) { this.runtime.lastError = `universe: ${safeError(error)}`; }
      }
      const radarDue = now - this.runtime.lastRadarAt >= RADAR_MS;
      if (radarDue) {
        subrequests += 1;
        try { this.refreshRadar(now, await fetchMarketTickers()); }
        catch (error) { this.runtime.lastError = `radar: ${safeError(error)}`; }
      }
      const cycleSymbols = [...this.runtime.symbols];
      // Use the actual invocation time for exchange freshness. The slot is
      // only an idempotency key; its floor can be almost two seconds behind a
      // fresh Gate snapshot and must never be used as the freshness clock.
      let books: Awaited<ReturnType<MarketStream["processBooks"]>>;
      if (universeDue) {
        books = await this.processBooks(now, cycleSymbols);
      } else if (this.priorityMinuteSymbols(now).length) {
        // A confirmed breakout must consume the newly completed official 1m
        // candle in the same decision pass. Fetch that candle before books;
        // otherwise LIVE could act one loop before PAPER sees the same proof.
        subrequests += await this.updateAncillary(now);
        books = await this.processBooks(now, cycleSymbols);
      } else {
        const [bookResult, ancillary] = await Promise.all([this.processBooks(now, cycleSymbols), this.updateAncillary(now)]);
        books = bookResult;
        subrequests += ancillary;
      }
      const successes = books.successes;
      subrequests += books.requests;
      const liveNeedsSync = this.runtime.live.requestedEnabled
        || Object.values(this.runtime.live.entries).some((entry) => entry && !["FILLED", "CANCELLED"].includes(entry.status))
        || Object.values(this.runtime.live.positions).some((position) => position?.status === "OPEN");
      if (liveNeedsSync) {
        const liveRequestsBefore = this.liveClient?.requestCount ?? 0;
        try {
          await this.syncLive(Date.now());
        } catch (error) {
          this.runtime.live.operational = false;
          this.runtime.live.lastError = safeError(error);
        } finally {
          subrequests += Math.max(0, (this.liveClient?.requestCount ?? liveRequestsBefore) - liveRequestsBefore);
        }
      }
      this.runtime.lastAlarmAt = now;
      this.runtime.lastSuccessAt = successes > 0 ? now : this.runtime.lastSuccessAt;
      const allWarm = this.runtime.symbols.every((symbol) => (this.sessionWarmup[symbol] ?? 0) >= WARMUP_SNAPSHOTS);
      const allMeta = this.runtime.symbols.every((symbol) => this.runtime.contractMeta[symbol] != null);
      const realtimeReadiness = this.realtimeReadiness();
      const ancillaryStarted = this.runtime.symbols.every((symbol) => {
        const memory = this.memory[symbol];
        return memory && memory.timeframeUpdatedAt.m1 > 0 && memory.timeframeUpdatedAt.m15 > 0
          && memory.timeframeUpdatedAt.h1 > 0 && memory.timeframeUpdatedAt.h4 > 0;
      });
      this.runtime.state = !this.authorityReady ? "RECOVERY_REQUIRED" : successes === 0 ? "RECONNECTING"
        : successes !== this.runtime.symbols.length ? "DEGRADED"
          : this.runtime.riskBreach ? "DEGRADED" : realtimeReadiness.actionableMarkets > 0 && realtimeReadiness.protectedMarketsReady ? "LIVE"
            : allWarm && allMeta && ancillaryStarted ? "DEGRADED" : "WARMING";
      const recoveringMarkets = this.runtime.symbols.filter((symbol) => !this.symbolEntryReady(symbol)).length;
      const feedError = successes !== this.runtime.symbols.length ? `${this.runtime.symbols.length - successes} market snapshots unavailable; retrying`
        : !realtimeReadiness.protectedMarketsReady ? "protected position data unavailable; new entries frozen"
          : realtimeReadiness.actionableMarkets === 0 ? `${recoveringMarkets} realtime markets warming; entries blocked`
            : !allMeta && realtimeReadiness.protectedMarkets > 0 ? "protected contract metadata unavailable" : null;
      this.runtime.lastError = (this.runtime.riskBreach ? "portfolio stress risk exceeds 10%; new entries blocked" : feedError) ?? this.runtime.d1MirrorError;
    } catch (error) {
      this.runtime.state = "RECONNECTING";
      this.runtime.lastError = safeError(error);
    } finally {
      this.runtime.lastAlarmAt = now;
      this.runtime.subrequestCount += subrequests;
      this.runtime.maxSubrequestsInAlarm = Math.max(this.runtime.maxSubrequestsInAlarm, subrequests);
      try { await this.saveCheckpoint(now); } catch (error) { this.runtime.lastError = `checkpoint: ${safeError(error)}`; }
    }
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/watchdog") {
      const stale = this.runtime.lastSuccessAt == null || Date.now() - this.runtime.lastSuccessAt > AUTHORITY_STALE_AFTER_MS;
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
      const stale = !this.authorityReady || this.runtime.lastSuccessAt == null || Date.now() - this.runtime.lastSuccessAt > AUTHORITY_STALE_AFTER_MS;
      const effectiveState = !this.authorityReady ? "RECOVERY_REQUIRED" : stale ? "RECONNECTING" : this.runtime.state;
      const strategies = Object.values(this.runtime.strategyArena.strategies);
      const regimes = marketRegimeSummary(this.runtime.marketRegimes);
      return json({
        version: this.runtime.version,
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
        strategyArena: {
          version: this.runtime.strategyArena.version,
          playbookCount: 12,
          catalogSize: strategies.length,
          shadowCount: strategies.filter((row) => row.lane === "SHADOW").length,
          activeCount: strategies.filter((row) => row.lane === "ACTIVE").length,
          sleepingCount: strategies.filter((row) => row.lane === "SLEEPING").length,
          portfolioEquity: this.runtime.strategyArena.portfolioEquity,
          portfolioOpen: Object.keys(this.runtime.strategyArena.portfolioOpen).length,
          observationShadow: this.runtime.strategyArena.recentObservations.length,
          effectiveShadowOpen: Object.keys(this.runtime.strategyArena.open).length,
          cutoverPending: this.runtime.strategyArena.cutoverPending,
          rules: {
            singleTradeRiskMin: 0.01,
            singleTradeRiskMax: 0.02,
            portfolioRiskCap: PORTFOLIO_RISK_CAP,
            correlatedRiskCap: CORRELATED_DIRECTION_RISK_CAP,
            marginCap: 0.30,
            maxNotionalMultiple: 4,
          },
        },
        marketRegimes: { tracked: regimes.tracked, warmed: regimes.warmed, counts: regimes.counts },
        limits: {
          markets: this.runtime.symbols.length,
          scannedMarkets: this.runtime.radar.scanned,
          scanUniverse: SCAN_UNIVERSE_SIZE,
          realtimeCapacity: PORTFOLIO_REALTIME_CAPACITY,
          plannedDoWritesPerDay: 54_080,
          plannedTotalDoRequestsPerDay: 50_400,
          plannedMaxD1BilledWritesPerDay: 4_800,
        },
      });
    }
    if (path === "/status" || path === "/owner-runtime") {
      await this.ensureAlarm();
      const { outbox, live, paperCycle, bankruptcyOutbox, strategyArena, marketRegimes, ...publicRuntime } = this.runtime;
      const stale = !this.authorityReady || this.runtime.lastSuccessAt == null || Date.now() - this.runtime.lastSuccessAt > AUTHORITY_STALE_AFTER_MS;
      const effectiveState = !this.authorityReady ? "RECOVERY_REQUIRED" : stale ? "RECONNECTING" : this.runtime.state;
      return json({ ...publicRuntime, ...this.authorityView, paperCycle: paperCycleSummary(paperCycle, this.authorityView.equity),
        strategyArena: arenaSummary(strategyArena), marketRegimes: marketRegimeSummary(marketRegimes),
        ...(path === "/owner-runtime" ? { live } : {}), liveMode: { requestedEnabled: live.requestedEnabled, operational: live.operational }, outboxLength: outbox.length + bankruptcyOutbox.length,
        oldestOutboxAgeMs: outbox.length ? Math.max(0, Date.now() - (outbox[0].position.exitAt ?? outbox[0].position.entryAt)) : 0,
        authorityReady: this.authorityReady, realtimeReadiness: this.realtimeReadiness(), generatedAt: Date.now(), state: effectiveState, stale,
        analysisP99Ms: percentile99(this.runtime.analysisMs), limits: { loopMs: LOOP_MS, markets: this.runtime.symbols.length, scannedMarkets: this.runtime.radar.scanned, scanUniverse: SCAN_UNIVERSE_SIZE, radarMs: RADAR_MS, warmupSnapshots: WARMUP_SNAPSHOTS,
          maxAncillaryConcurrency: MAX_ANCILLARY_CONCURRENCY, maxSubrequestsPerAlarm: 32, plannedAlarmRequestsPerDay: 43_200,
          plannedAlarmWritesPerDay: 43_200, watchdogWriteReservePerDay: WATCHDOG_WRITE_RESERVE,
          nonAlarmWriteCapPerDay: NON_ALARM_WRITE_CAP, nonAlarmWritesToday: this.runtime.nonAlarmWrites,
          plannedDoWritesPerDay: 54_080,
          internalAnalysisP99RedlineMs: 25, topLevelCpuP99RedlineMs: 8, assumedRuntimePollSeconds: 15,
          plannedForegroundDoRequestsPerDay: 5_760, plannedCronWatchdogsPerDay: 1_440, plannedTotalDoRequestsPerDay: 50_400,
          maxOpenPositions: null, realtimeCapacity: PORTFOLIO_REALTIME_CAPACITY, plannedMaxD1BilledWritesPerDay: 4_800 } });
    }
    if (path === "/owner-status" && request.method === "GET") {
      await this.ensureAlarm();
      return json({ live: this.runtime.live, generatedAt: Date.now() });
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

const isAsset = (pathname: string) => pathname.startsWith("/_next/") || pathname.startsWith("/assets/") || /\.[a-z0-9]{2,8}$/i.test(pathname);
let runtimeCache: { response: string; expiresAt: number } | null = null;
const historyCache = new Map<string, { response: string; expiresAt: number }>();
let accountLogCache: { response: string; expiresAt: number } | null = null;
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
    if (url.pathname === "/__health") {
      const started = performance.now();
      const response = await env.MARKET_STREAM.getByName("primary").fetch("https://market-stream/health-status");
      const runtime = await response.json<Record<string, unknown>>();
      const live = runtimeReady(runtime as RuntimeHealthShape);
      return json({ ok: response.ok && live, ready: live, version: SYSTEM_VERSION, mode: "PAPER", runtime, topLevelCpuMs: performance.now() - started }, live ? 200 : 503);
    }
    if (url.pathname === "/api/runtime" && request.method === "GET") return runtimeStatus(env, true, await ownerAuthenticated(request, env));
    if (url.pathname === "/api/history" && request.method === "GET") return paperHistory(url, env);
    if (url.pathname === "/api/account-logs" && request.method === "GET") return accountLogs(env);
    if (url.pathname === "/api/auth/session" && request.method === "GET") return authSession(request, env);
    if (url.pathname === "/api/auth/login" && request.method === "POST") return ownerLogin(request, env);
    if (url.pathname === "/api/auth/logout" && request.method === "POST") return ownerLogout(request);
    if (url.pathname === "/api/live/status" && request.method === "GET") return ownerLiveStatus(request, env);
    if (url.pathname === "/api/live/mode" && request.method === "POST") return ownerLiveMode(request, env);
    if (url.pathname === "/api/live/credentials" && ["GET", "PUT", "DELETE"].includes(request.method)) return ownerLiveCredentials(request, env);
    if (url.pathname === "/api/paper/reset" && request.method === "POST") return ownerPaperAction(request, env, "RESET");
    if (url.pathname === "/api/paper/history/clear" && request.method === "POST") return ownerPaperAction(request, env, "CLEAR_HISTORY");
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return handler.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
    ctx.waitUntil(env.MARKET_STREAM.getByName("primary").fetch("https://market-stream/watchdog"));
  },
};
export default worker;
