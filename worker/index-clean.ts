/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import handler from "vinext/server/app-router-entry";
import { GatePublicError, fetchActiveContracts, fetchContractStats, fetchFuturesBook, fetchLiquidations, fetchRecentTrades, fetchStructureCandles } from "../lib/gate-market.ts";
import { closePaperPosition, PORTFOLIO_RISK_CAP, remainingStressRisk, SYSTEM_VERSION, updatePosition, type Decision, type LiquidityZone, type MarketState, type PaperPlan, type PaperPosition, type Side } from "../lib/liquidity-core.ts";
import { analyzeSnapshot, ancillaryIsFresh, ancillarySchedule, applyFlow, deriveStructureZones, emptySymbolMemory, reconcilePaper, structureDirection, updateOpenInterestCohorts, usableSnapshot, type SymbolMemory } from "../lib/liquidity-runtime.ts";
import { drainPositionOutbox, enqueuePositionTransition, type PositionOutboxItem } from "../lib/paper-outbox.ts";
import { runtimeReady, type RuntimeHealthShape } from "../lib/runtime-health.ts";
import { buildLiveEntryIntent, buildLiveStopIntent, liveEntryDisposition, liveExitTag, liveOrderId, liveOrderTag, loadGateLiveClient, type GateLiveClient } from "../lib/gate-live.ts";
import { clearOwnerSessionCookie, createOwnerSession, ownerAuthConfigured, ownerPasswordMatches, ownerSessionCookie, sameOriginMutation, verifyOwnerSession } from "../lib/owner-auth.ts";

const LOOP_MS = 2_000;
const HEARTBEAT_MS = 30_000;
const UNIVERSE_MS = 5 * 60_000;
const WARMUP_SNAPSHOTS = 30;
const MAX_ANCILLARY_CONCURRENCY = 2;
const MAX_OPEN_POSITIONS = 3;
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
  kind: "PRICE_TRIGGER" | "LIMIT";
  status: "SUBMITTING" | "OPEN" | "FILLED" | "CANCELLED" | "ERROR";
  tag: string;
  exchangeOrderId: string | null;
  createdAt: number;
  expiresAt: number;
  trigger: number;
  invalidation: number;
  target: number;
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
};

function initialLiveState(): LiveRuntime {
  return { requestedEnabled: false, operational: false, changedAt: null, lastSyncAt: null, lastError: null,
    equity: null, available: null, credentialConfigured: false, entries: {}, positions: {} };
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
  lastChartMirrorAt: number;
  utcDay: string;
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
  feedFailures: Record<string, { count: number; retryAt: number }>;
  lastError: string | null;
  d1MirrorError: string | null;
  riskBreach: boolean;
  tickSize: Record<string, number>;
  contractMeta: Record<string, { quantoMultiplier: number; maintenanceRate: number; leverageMax: number; fundingRate: number }>;
  decisions: Record<string, Decision | null>;
  plans: Record<string, PaperPlan | null>;
  positions: Record<string, PaperPosition | null>;
  evidence: Record<string, { midpoint: number; observedAt: number; warmup: number; fresh: boolean; ancillaryFresh: boolean; topLong: LiquidityZone | null; topShort: LiquidityZone | null; absorption: number }>;
  analysisMs: number[];
  equity: number;
  outbox: PositionOutboxItem[];
  live: LiveRuntime;
};

type Checkpoint = Omit<RuntimeState, "analysisMs">;

const day = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const safeError = (error: unknown) => error instanceof Error ? error.message.slice(0, 240) : "unknown error";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

function initialState(): RuntimeState {
  return {
    version: SYSTEM_VERSION, authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION, mode: "PAPER", state: "STARTING", symbols: DEFAULT_SYMBOLS,
    lastAlarmAt: null, lastSuccessAt: null, lastHeartbeatAt: null, lastStopCheckpointAt: null, nextAlarmAt: null, lastUniverseAt: 0, lastChartMirrorAt: 0,
    utcDay: day(), alarmCount: 0, d1Writes: 0, nonAlarmWrites: 0, d1RetryAt: 0, d1FailureCount: 0, equityVersion: 0, ancillaryCursor: 0, subrequestCount: 0, maxSubrequestsInAlarm: 0, sequenceRebuilds: 0, lastProcessedSlot: -1, feedFailures: {},
    lastError: null, d1MirrorError: null, riskBreach: false, tickSize: Object.fromEntries(DEFAULT_SYMBOLS.map((symbol) => [symbol, 0.0001])), contractMeta: {},
    decisions: {}, plans: {}, positions: {}, evidence: {}, analysisMs: [], equity: 1_000, outbox: [], live: initialLiveState(),
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
  private chartCandles: Record<string, Partial<Record<"1m" | "15m" | "1h", Awaited<ReturnType<typeof fetchStructureCandles>>>>> = {};
  private sessionWarmup: Record<string, number> = {};
  private authorityReady = true;
  private authorityView = { positions: {} as RuntimeState["positions"], equity: 1_000, equityVersion: 0 };
  private liveClient: GateLiveClient | null = null;

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Checkpoint>("checkpoint");
      if (saved?.authoritySchemaVersion === AUTHORITY_SCHEMA_VERSION) {
        this.runtime = { ...initialState(), ...saved, version: SYSTEM_VERSION, symbols: [...DEFAULT_SYMBOLS], outbox: saved.outbox ?? [], live: saved.live ?? initialLiveState(), analysisMs: [], state: "WARMING" };
        for (const symbol of new Set([...Object.keys(this.runtime.decisions), ...Object.keys(this.runtime.plans),
          ...Object.keys(this.runtime.positions), ...Object.keys(this.runtime.evidence), ...Object.keys(this.runtime.feedFailures),
          ...Object.keys(this.runtime.tickSize), ...Object.keys(this.runtime.contractMeta)])) {
          if (DEFAULT_SYMBOLS.includes(symbol)) continue;
          delete this.runtime.decisions[symbol]; delete this.runtime.plans[symbol]; delete this.runtime.positions[symbol];
          delete this.runtime.evidence[symbol]; delete this.runtime.feedFailures[symbol]; delete this.runtime.tickSize[symbol];
          delete this.runtime.contractMeta[symbol];
        }
        for (const symbol of this.runtime.symbols) {
          this.memory[symbol] = emptySymbolMemory();
          this.memory[symbol].quantoMultiplier = this.runtime.contractMeta[symbol]?.quantoMultiplier ?? 1;
          this.memory[symbol].maintenanceRate = this.runtime.contractMeta[symbol]?.maintenanceRate ?? 0.005;
          this.memory[symbol].flow.funding = this.runtime.contractMeta[symbol]?.fundingRate ?? 0;
          this.sessionWarmup[symbol] = 0;
          if (this.runtime.plans[symbol]?.state === "PREPARED") this.runtime.plans[symbol] = { ...this.runtime.plans[symbol]!, state: "CANCELLED" };
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
    return structuredClone({ positions: this.runtime.positions, plans: this.runtime.plans, decisions: this.runtime.decisions,
      evidence: this.runtime.evidence, equity: this.runtime.equity, equityVersion: this.runtime.equityVersion,
      outbox: this.runtime.outbox, lastStopCheckpointAt: this.runtime.lastStopCheckpointAt });
  }

  private restoreAuthority(authority: ReturnType<MarketStream["captureAuthority"]>) {
    this.runtime.positions = authority.positions;
    this.runtime.plans = authority.plans;
    this.runtime.decisions = authority.decisions;
    this.runtime.evidence = authority.evidence;
    this.runtime.equity = authority.equity;
    this.runtime.equityVersion = authority.equityVersion;
    this.runtime.outbox = authority.outbox;
    this.runtime.lastStopCheckpointAt = authority.lastStopCheckpointAt;
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
    }
  }

  private refreshUniverse(now: number, ranked: Awaited<ReturnType<typeof fetchActiveContracts>>) {
    const next = [...DEFAULT_SYMBOLS];
    if (!next.length) return;
    const prior = new Set(this.runtime.symbols);
    const changed = next.some((symbol, index) => symbol !== this.runtime.symbols[index]);
    this.runtime.symbols = next;
    this.runtime.tickSize = { ...this.runtime.tickSize, ...Object.fromEntries(ranked.map((row) => [row.symbol, row.tickSize])) };
    const oldMeta = this.runtime.contractMeta;
    this.runtime.contractMeta = { ...oldMeta, ...Object.fromEntries(ranked.map((row) => [row.symbol, { quantoMultiplier: row.quantoMultiplier, maintenanceRate: row.maintenanceRate, leverageMax: row.leverageMax, fundingRate: row.fundingRate }])) };
    this.runtime.lastUniverseAt = now;
    if (changed) {
      for (const symbol of Object.keys(this.runtime.plans)) {
        if (!next.includes(symbol) && this.runtime.plans[symbol]?.state === "PREPARED") this.runtime.plans[symbol] = { ...this.runtime.plans[symbol]!, state: "CANCELLED" };
      }
    }
    for (const symbol of next) {
      const before = oldMeta[symbol];
      const after = this.runtime.contractMeta[symbol];
      const metadataChanged = !before || before.quantoMultiplier !== after?.quantoMultiplier || before.maintenanceRate !== after?.maintenanceRate;
      if (!prior.has(symbol) || metadataChanged) {
        this.memory[symbol] = emptySymbolMemory();
        this.memory[symbol].quantoMultiplier = after?.quantoMultiplier ?? 1;
        this.memory[symbol].maintenanceRate = after?.maintenanceRate ?? 0.005;
        this.memory[symbol].flow.funding = after?.fundingRate ?? 0;
        this.sessionWarmup[symbol] = 0;
        this.runtime.decisions[symbol] = null;
      }
      if (this.memory[symbol]) this.memory[symbol].flow.funding = after?.fundingRate ?? 0;
    }
    for (const symbol of new Set([...Object.keys(this.memory), ...Object.keys(this.sessionWarmup), ...Object.keys(this.runtime.decisions),
      ...Object.keys(this.runtime.plans), ...Object.keys(this.runtime.positions), ...Object.keys(this.runtime.evidence),
      ...Object.keys(this.runtime.feedFailures), ...Object.keys(this.runtime.tickSize), ...Object.keys(this.runtime.contractMeta)])) {
      if (next.includes(symbol)) continue;
      delete this.memory[symbol]; delete this.sessionWarmup[symbol]; delete this.runtime.decisions[symbol]; delete this.runtime.plans[symbol];
      delete this.runtime.positions[symbol]; delete this.runtime.evidence[symbol]; delete this.runtime.feedFailures[symbol];
      delete this.runtime.tickSize[symbol]; delete this.runtime.contractMeta[symbol];
    }
  }

  private async updateAncillary(now: number) {
    const scheduled = ancillarySchedule(this.runtime.ancillaryCursor++, this.runtime.symbols);
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
        (this.chartCandles[result.value.symbol] ??= {})[timeframe] = rows;
        const key = timeframe === "1m" ? "m1" : timeframe === "15m" ? "m15" : "h1";
        memory.structureByTimeframe[key] = deriveStructureZones(rows, timeframe, memory.lastMid);
        memory.structureZones = [...memory.structureByTimeframe.m1, ...memory.structureByTimeframe.m15, ...memory.structureByTimeframe.h1];
        if (rows.length >= 20) {
          memory.timeframeBias[key] = structureDirection(memory.structureByTimeframe[key]);
          const seconds = timeframe === "1m" ? 60 : timeframe === "15m" ? 900 : 3_600;
          memory.timeframeUpdatedAt[key] = (rows.at(-1)!.time + seconds) * 1_000;
        }
      }
    }
    return tasks.length;
  }

  private queueTransition(position: PaperPosition | null, priorPosition: PaperPosition | null) {
    const changed = position != null && !(priorPosition?.id === position.id && priorPosition.status === position.status && priorPosition.currentStop === position.currentStop);
    if (!changed) return;
    if (priorPosition?.status === "OPEN" && position.status === "CLOSED") this.runtime.equity = Math.max(0.01, this.runtime.equity + (position.realizedPnl ?? 0));
    this.runtime.equityVersion += 1;
    this.runtime.outbox = enqueuePositionTransition(this.runtime.outbox, priorPosition, position, this.runtime.equity, this.runtime.equityVersion);
  }

  private async writePosition(item: PositionOutboxItem) {
    const { position } = item;
    const billedWrites = 2;
    if (this.runtime.d1Writes + billedWrites > 4_800) throw new Error("daily D1 write budget reached");
    await this.env.DB.batch([
      this.env.DB.prepare(`INSERT INTO paper_positions
        (id,symbol,market_state,side,status,entry_at,entry_price,initial_stop,current_stop,current_target,target_identity,planned_risk,notional,exit_at,exit_price,exit_reason,realized_pnl,fees_and_slippage,mirror_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,current_stop=excluded.current_stop,current_target=excluded.current_target,target_identity=excluded.target_identity,exit_at=excluded.exit_at,exit_price=excluded.exit_price,exit_reason=excluded.exit_reason,realized_pnl=excluded.realized_pnl,fees_and_slippage=excluded.fees_and_slippage,mirror_version=excluded.mirror_version WHERE excluded.mirror_version > paper_positions.mirror_version`).bind(
        position.id, position.symbol, position.scenario, position.side, position.status, position.entryAt, position.entryPrice,
        position.initialStop, position.currentStop, position.currentTarget, position.targetIdentity ?? "legacy:none", position.plannedRisk, position.notional,
        position.exitAt ?? null, position.exitPrice ?? null, position.exitReason ?? null, position.realizedPnl ?? null, position.feesAndSlippage ?? null, item.equityVersion,
      ),
      this.env.DB.prepare("UPDATE system_settings SET paper_equity=?,equity_version=?,updated_at=? WHERE id=1 AND equity_version<?")
        .bind(item.equity, item.equityVersion, Date.now(), item.equityVersion),
    ]);
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
  }

  private async mirrorChartCandles(now: number) {
    if (now - this.runtime.lastChartMirrorAt < 5 * 60_000 || this.runtime.d1Writes >= 4_800) return;
    const complete = DEFAULT_SYMBOLS.every((symbol) => ["1m", "15m", "1h"].every((interval) => (this.chartCandles[symbol]?.[interval as "1m" | "15m" | "1h"]?.length ?? 0) >= 20));
    if (!complete) return;
    try {
      await this.env.DB.prepare("UPDATE system_settings SET chart_cache_json=?,chart_cache_at=? WHERE id=1")
        .bind(JSON.stringify(this.chartCandles), now).run();
      this.runtime.d1Writes += 1;
      this.runtime.lastChartMirrorAt = now;
    } catch { /* Chart mirroring is optional and must never interrupt PAPER authority. */ }
  }

  private async gateLive() {
    if (!this.env.OWNER_ACCESS_TOKEN) throw new Error("所有者访问码尚未配置");
    this.liveClient ??= await loadGateLiveClient(this.env.DB, this.env.OWNER_ACCESS_TOKEN);
    this.runtime.live.credentialConfigured = true;
    return this.liveClient;
  }

  private liveOpenRisk() {
    const positionRisk = Object.values(this.runtime.live.positions).reduce((sum, position) => sum + (position?.status === "OPEN"
      ? remainingStressRisk(position, this.runtime.evidence[position.symbol]?.midpoint ?? position.entryPrice) : 0), 0);
    const pendingRisk = Object.values(this.runtime.live.entries).reduce((sum, entry) => sum + (entry && ["SUBMITTING", "OPEN"].includes(entry.status)
      ? entry.plannedRisk : 0), 0);
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

  private async syncLive(now: number, initialEnable = false) {
    const activePositions = Object.values(this.runtime.live.positions).some((position) => position?.status === "OPEN");
    const activeEntries = Object.values(this.runtime.live.entries).some((entry) => entry && !["FILLED", "CANCELLED"].includes(entry.status));
    if (!this.runtime.live.requestedEnabled && !activePositions && !activeEntries && !initialEnable) return;
    const client = await this.gateLive();
    const snapshot = await client.snapshot();
    const equity = Number(snapshot.account.total ?? 0);
    const available = Number(snapshot.account.available ?? 0);
    if (!(equity > 0) || !(available >= 0)) throw new Error("Gate 合约账户权益不可用");
    if (snapshot.account.in_dual_mode === true || ["dual", "dual_plus"].includes(String(snapshot.account.position_mode ?? "").toLowerCase())) {
      throw new Error("Gate 当前不是单向持仓模式");
    }
    this.runtime.live.equity = equity;
    this.runtime.live.available = available;
    this.runtime.live.lastSyncAt = now;

    const knownTags = new Set([
      ...Object.values(this.runtime.live.entries).flatMap((entry) => entry?.tag && !["FILLED", "CANCELLED"].includes(entry.status) ? [entry.tag] : []),
      ...Object.values(this.runtime.live.positions).flatMap((position) => position?.status === "OPEN" && position.stopTag ? [position.stopTag] : []),
    ]);
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
      const plan = this.runtime.plans[symbol] ?? null;
      const shouldCancel = !this.runtime.live.requestedEnabled || !plan || plan.id !== entry.planId || plan.state === "CANCELLED" || now >= entry.expiresAt;
      if (shouldCancel && openOrder && entry.exchangeOrderId) await this.cancelLiveEntry(client, entry);
      else if (shouldCancel && !openOrder && entry.status !== "FILLED" && entry.missingSince != null && now - entry.missingSince >= 6_000) entry.status = "CANCELLED";
    }

    for (const actual of actualPositions) {
      const symbol = actual.contract ?? "";
      if (!DEFAULT_SYMBOLS.includes(symbol)) throw new Error(`发现未纳管实盘仓位 ${symbol || "UNKNOWN"}`);
      const exchangeSize = Number(actual.size ?? 0);
      const side: Side = exchangeSize > 0 ? "LONG" : "SHORT";
      let position = this.runtime.live.positions[symbol] ?? null;
      if (!position || position.status !== "OPEN") {
        const entry = this.runtime.live.entries[symbol];
        if (!entry || entry.side !== side || (!["SUBMITTING", "OPEN", "FILLED", "ERROR"].includes(entry.status)
          && !(entry.status === "CANCELLED" && now - entry.createdAt < 60_000))) throw new Error(`发现未纳管实盘仓位 ${symbol}`);
        const entryPrice = Number(actual.entry_price ?? entry.trigger) || entry.trigger;
        const multiplier = this.runtime.contractMeta[symbol]?.quantoMultiplier ?? 1;
        const notional = Math.abs(exchangeSize) * entryPrice * multiplier;
        const leverage = Math.max(1, Number(actual.leverage ?? entry.leverage) || entry.leverage);
        position = {
          id: entry.planId, symbol, side, scenario: entry.scenario, entryAt: now, entryPrice,
          initialStop: entry.invalidation, currentStop: entry.invalidation, currentTarget: entry.target,
          plannedRisk: notional * (Math.abs(entryPrice - entry.invalidation) / Math.max(entryPrice, 1e-9) + 0.0018),
          notional, targetScore: this.runtime.plans[symbol]?.score ?? 0, targetIdentity: this.runtime.plans[symbol]?.targetIdentity,
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
      const evidence = this.runtime.evidence[symbol];
      if (evidence?.fresh && evidence.ancillaryFresh && !position.exitRequestedAt) {
        const bestTarget = position.side === "LONG" ? evidence.topLong : evidence.topShort;
        const oppositeTarget = position.side === "LONG" ? evidence.topShort : evidence.topLong;
        const updated = updatePosition(position, { now, price: evidence.midpoint, bestTarget, oppositeTarget, absorption: evidence.absorption });
        if (updated.status === "CLOSED") {
          position = { ...position, currentStop: updated.currentStop, currentTarget: updated.currentTarget,
            exitReason: updated.exitReason, exitRequestedAt: now };
          await client.closePosition(symbol, liveExitTag(position.id));
          this.runtime.live.positions[symbol] = position;
        } else {
          position = { ...position, currentStop: updated.currentStop, currentTarget: updated.currentTarget, targetScore: updated.targetScore };
          this.runtime.live.positions[symbol] = position;
        }
      }
      if (!position.exitRequestedAt) {
        await this.ensureLiveStop(client, position, snapshot.priceOrders);
        if (this.liveOpenRisk() > equity * PORTFOLIO_RISK_CAP + 1e-8) {
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
      return;
    }
    if (unknownOrders.length) throw new Error("Gate 存在未纳管挂单；已停止新开仓");

    this.runtime.live.operational = true;
    this.runtime.live.lastError = null;
    let availableForNewEntries = available;
    for (const symbol of this.runtime.symbols) {
      const plan = this.runtime.plans[symbol] ?? null;
      if (!plan || plan.state !== "PREPARED" || now >= plan.expiresAt || this.runtime.live.positions[symbol]?.status === "OPEN") continue;
      const prior = this.runtime.live.entries[symbol];
      // A timed-out submission remains reserved until Gate proves it absent for
      // six seconds. Never replay the same plan while its status is ambiguous.
      if (prior && prior.planId === plan.id && prior.status !== "CANCELLED") continue;
      if (prior && !["FILLED", "CANCELLED"].includes(prior.status)) await this.cancelLiveEntry(client, prior);
      const intent = buildLiveEntryIntent({ plan, equity, available: availableForNewEntries, openRisk: this.liveOpenRisk(),
        quantoMultiplier: this.runtime.contractMeta[symbol]?.quantoMultiplier ?? 1,
        leverageMax: this.runtime.contractMeta[symbol]?.leverageMax ?? 50 });
      const entry: LiveEntry = {
        planId: plan.id, symbol, side: plan.side, scenario: plan.marketState, kind: intent.kind, status: "SUBMITTING",
        tag: intent.tag, exchangeOrderId: null, createdAt: now, expiresAt: plan.expiresAt, trigger: plan.entryTrigger,
        invalidation: plan.invalidation, target: plan.target, size: intent.size, contracts: intent.contracts,
        notional: intent.notional, plannedRisk: intent.plannedRisk, leverage: intent.leverage, margin: intent.margin,
        missingSince: null, lastError: null,
      };
      this.runtime.live.entries[symbol] = entry;
      await this.saveCheckpoint(now, true);
      try {
        await client.setLeverage(symbol, intent.leverage);
        entry.exchangeOrderId = await client.createEntry(intent);
        entry.status = "OPEN";
        availableForNewEntries = Math.max(0, availableForNewEntries - intent.margin);
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
      await this.syncLive(Date.now(), enabled);
      await this.saveCheckpoint(Date.now(), true);
      return { ok: true, live: this.runtime.live };
    } catch (error) {
      if (enabled) this.runtime.live.requestedEnabled = false;
      this.runtime.live.operational = false;
      this.runtime.live.lastError = safeError(error);
      await this.saveCheckpoint(Date.now(), true).catch(() => undefined);
      return { ok: false, error: this.runtime.live.lastError, live: this.runtime.live };
    }
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
        this.runtime.feedFailures[attemptedSymbol] = { count, retryAt: Math.max(now + backoff, gateRetry ?? 0) };
        const plan = this.runtime.plans[attemptedSymbol] ?? null;
        const position = this.runtime.positions[attemptedSymbol] ?? null;
        const cancelled = reconcilePaper({ now, midpoint: this.runtime.evidence[attemptedSymbol]?.midpoint ?? 0, fresh: false,
          sequenceFault: false, decision: null, plan, position, zones: [], absorption: 0, equity: this.runtime.equity,
          openRisk: openStressRisk(this.runtime) });
        this.runtime.plans[attemptedSymbol] = cancelled.plan;
        this.runtime.positions[attemptedSymbol] = cancelled.position;
        this.runtime.decisions[attemptedSymbol] = null;
        if (this.runtime.evidence[attemptedSymbol]) this.runtime.evidence[attemptedSymbol].fresh = false;
        continue;
      }
      const { symbol, snapshot } = result.value;
      let memory = this.memory[symbol] ??= emptySymbolMemory();
      // Network time belongs to freshness validation too. An exchange update
      // received near the request timeout may legitimately be later than the
      // alarm's start timestamp.
      const validation = usableSnapshot(snapshot, Math.max(now, Date.now()), memory.lastSequence, memory.lastBookObservedAt);
      if (validation.sequenceReset) {
        const replacement = emptySymbolMemory();
        replacement.quantoMultiplier = memory.quantoMultiplier;
        replacement.maintenanceRate = memory.maintenanceRate;
        replacement.flow.funding = memory.flow.funding;
        this.memory[symbol] = memory = replacement;
        this.sessionWarmup[symbol] = 0;
      }
      const progressed = validation.advanced || validation.sequenceReset;
      if (validation.fresh && !validation.sequenceFault && progressed) {
        successes += 1;
        this.runtime.feedFailures[symbol] = { count: 0, retryAt: 0 };
      }
      if (validation.fresh && validation.unchanged) successes += 1;
      if (validation.sequenceFault || validation.sequenceReset) this.runtime.sequenceRebuilds += 1;
      if (validation.fresh && !validation.sequenceFault && progressed) {
        applyFlow(memory, snapshot);
        this.sessionWarmup[symbol] = (this.sessionWarmup[symbol] ?? 0) + 1;
      }
      if (validation.unchanged) {
        if (this.runtime.evidence[symbol]) this.runtime.evidence[symbol].fresh = validation.fresh;
        if (!validation.fresh) {
          const cancelled = reconcilePaper({ now, midpoint: this.runtime.evidence[symbol]?.midpoint ?? memory.lastMid, fresh: false,
            sequenceFault: false, decision: null, plan: this.runtime.plans[symbol] ?? null, position: this.runtime.positions[symbol] ?? null,
            zones: [], absorption: 0, equity: markToMarketEquity(this.runtime), openRisk: openStressRisk(this.runtime), allowOpen: false });
          this.runtime.plans[symbol] = cancelled.plan;
          this.runtime.positions[symbol] = cancelled.position;
          this.runtime.decisions[symbol] = null;
        }
        continue;
      }
      const analysisStart = performance.now();
      const analyzed = validation.fresh && !validation.sequenceFault && progressed
        ? analyzeSnapshot(memory, snapshot)
        : { midpoint: memory.lastMid, zones: [] as LiquidityZone[], bands: [], absorption: 0, decision: null };
      this.runtime.analysisMs.push(performance.now() - analysisStart);
      if (this.runtime.analysisMs.length > 240) this.runtime.analysisMs.shift();
      const priorPlan = this.runtime.plans[symbol] ?? null;
      const priorPosition = this.runtime.positions[symbol] ?? null;
      const ancillaryFresh = ancillaryIsFresh(memory, now);
      const contractReady = this.runtime.contractMeta[symbol] != null;
      const decision = this.authorityReady && contractReady && ancillaryFresh && (this.sessionWarmup[symbol] ?? 0) >= WARMUP_SNAPSHOTS ? analyzed.decision : null;
      const openRisk = openStressRisk(this.runtime);
      const reconciled = reconcilePaper({ now, midpoint: analyzed.midpoint, fresh: validation.fresh, sequenceFault: validation.sequenceFault,
        decision, plan: priorPlan, position: priorPosition, zones: analyzed.zones, absorption: analyzed.absorption,
        equity: markToMarketEquity(this.runtime), openRisk, allowOpen: false, protectOnly: (this.sessionWarmup[symbol] ?? 0) < WARMUP_SNAPSHOTS });
      this.runtime.decisions[symbol] = decision;
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
        midpoint: analyzed.midpoint, observedAt: snapshot.observedAt, warmup: Math.min(WARMUP_SNAPSHOTS, this.sessionWarmup[symbol] ?? 0),
        fresh: validation.fresh && !validation.sequenceFault, ancillaryFresh,
        topLong: analyzed.zones.filter((zone) => zone.side === "LONG").sort((a, b) => b.score - a.score)[0] ?? null,
        topShort: analyzed.zones.filter((zone) => zone.side === "SHORT").sort((a, b) => b.score - a.score)[0] ?? null,
        absorption: analyzed.absorption,
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
      const evidence = this.runtime.evidence[symbol];
      if (evidence && now - evidence.observedAt > 3_000) evidence.fresh = false;
      const plan = this.runtime.plans[symbol] ?? null;
      const position = this.runtime.positions[symbol] ?? null;
      const cancelled = reconcilePaper({ now, midpoint: evidence?.midpoint ?? 0, fresh: false, sequenceFault: false, decision: null,
        plan, position, zones: [], absorption: 0, equity: this.runtime.equity,
        openRisk: openStressRisk(this.runtime) });
      this.runtime.plans[symbol] = cancelled.plan;
      this.runtime.positions[symbol] = cancelled.position;
    }
    // A realized loss can shrink the 5% cap. Reduce weakest fresh PAPER exposure before considering any new entry.
    for (const candidate of Object.values(this.runtime.positions)
      .filter((position): position is PaperPosition => position?.status === "OPEN")
      .sort((a, b) => a.targetScore - b.targetScore)) {
      if (openStressRisk(this.runtime) <= markToMarketEquity(this.runtime) * 0.05 + 1e-9) break;
      const row = analyzedRows.find((item) => item.symbol === candidate.symbol && item.validation.fresh && !item.validation.sequenceFault);
      if (!row) continue;
      const closed = closePaperPosition(candidate, now, row.analyzed.midpoint, "PORTFOLIO_RISK_REBALANCE");
      this.runtime.positions[candidate.symbol] = closed;
      this.queueTransition(closed, candidate);
      closedThisCycle.add(candidate.symbol);
      criticalChanged = true;
    }
    this.runtime.riskBreach = openStressRisk(this.runtime) > markToMarketEquity(this.runtime) * 0.05 + 1e-9;
    // Exits update draft absolute equity before candidates are ranked; nothing is published yet.
    const rankedCandidates = analyzedRows
      .filter(({ symbol, validation }) => validation.fresh && !validation.sequenceFault && !closedThisCycle.has(symbol) && this.runtime.positions[symbol]?.status !== "OPEN")
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
      const reconciled = reconcilePaper({ now, midpoint: row.analyzed.midpoint, fresh: true, sequenceFault: false,
        decision: this.runtime.decisions[row.symbol], plan: priorPlan, position: priorPosition, zones: row.analyzed.zones,
        absorption: row.analyzed.absorption, equity: markToMarketEquity(this.runtime), openRisk, allowOpen: true });
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
      const cycleSymbols = [...this.runtime.symbols];
      // Use the actual invocation time for exchange freshness. The slot is
      // only an idempotency key; its floor can be almost two seconds behind a
      // fresh Gate snapshot and must never be used as the freshness clock.
      const booksPromise = this.processBooks(now, cycleSymbols);
      let books: Awaited<ReturnType<MarketStream["processBooks"]>>;
      if (universeDue) {
        books = await booksPromise;
      } else {
        const [bookResult, ancillary] = await Promise.all([booksPromise, this.updateAncillary(now)]);
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
      await this.mirrorChartCandles(now);
      this.runtime.lastAlarmAt = now;
      this.runtime.lastSuccessAt = successes > 0 ? now : this.runtime.lastSuccessAt;
      const allWarm = this.runtime.symbols.every((symbol) => (this.sessionWarmup[symbol] ?? 0) >= WARMUP_SNAPSHOTS);
      const allMeta = this.runtime.symbols.every((symbol) => this.runtime.contractMeta[symbol] != null);
      const allAncillary = this.runtime.symbols.every((symbol) => ancillaryIsFresh(this.memory[symbol] ?? emptySymbolMemory(), now));
      const ancillaryStarted = this.runtime.symbols.every((symbol) => {
        const memory = this.memory[symbol];
        return memory && memory.oiUpdatedAt > 0 && memory.tradesUpdatedAt > 0 && memory.liquidationsUpdatedAt > 0
          && memory.timeframeUpdatedAt.m1 > 0 && memory.timeframeUpdatedAt.m15 > 0 && memory.timeframeUpdatedAt.h1 > 0;
      });
      this.runtime.state = !this.authorityReady ? "RECOVERY_REQUIRED" : successes === 0 ? "RECONNECTING"
        : successes !== this.runtime.symbols.length ? "DEGRADED"
          : this.runtime.riskBreach ? "DEGRADED" : allWarm && allMeta && allAncillary ? "LIVE" : allWarm && allMeta && ancillaryStarted ? "DEGRADED" : "WARMING";
      const feedError = successes !== this.runtime.symbols.length ? `${this.runtime.symbols.length - successes} market snapshots unavailable; retrying`
        : !allMeta ? "contract metadata unavailable" : !allAncillary && ancillaryStarted ? "ancillary evidence stale; entries blocked" : null;
      this.runtime.lastError = (this.runtime.riskBreach ? "portfolio stress risk exceeds 5%; new entries blocked" : feedError) ?? this.runtime.d1MirrorError;
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
      const stale = this.runtime.lastSuccessAt == null || Date.now() - this.runtime.lastSuccessAt > 3_000;
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm == null || alarm < Date.now() - 6_000) {
        this.runtime.state = this.authorityReady ? "RECONNECTING" : "RECOVERY_REQUIRED";
        if (alarm != null) await this.ctx.storage.deleteAlarm();
        await this.ensureAlarm();
      }
      return json({ ok: true, stale, nextAlarmAt: await this.ctx.storage.getAlarm() });
    }
    if (path === "/status" || path === "/owner-runtime") {
      await this.ensureAlarm();
      const { outbox, live, ...publicRuntime } = this.runtime;
      const stale = !this.authorityReady || this.runtime.lastSuccessAt == null || Date.now() - this.runtime.lastSuccessAt > 3_000;
      const effectiveState = !this.authorityReady ? "RECOVERY_REQUIRED" : stale ? "RECONNECTING" : this.runtime.state;
      return json({ ...publicRuntime, ...this.authorityView, ...(path === "/owner-runtime" ? { live } : {}), liveMode: { requestedEnabled: live.requestedEnabled, operational: live.operational }, outboxLength: outbox.length,
        oldestOutboxAgeMs: outbox.length ? Math.max(0, Date.now() - (outbox[0].position.exitAt ?? outbox[0].position.entryAt)) : 0,
        authorityReady: this.authorityReady, generatedAt: Date.now(), state: effectiveState, stale,
        analysisP99Ms: percentile99(this.runtime.analysisMs), limits: { loopMs: LOOP_MS, markets: 3, warmupSnapshots: WARMUP_SNAPSHOTS,
          maxAncillaryConcurrency: MAX_ANCILLARY_CONCURRENCY, maxSubrequestsPerAlarm: 24, plannedAlarmRequestsPerDay: 43_200,
          plannedAlarmWritesPerDay: 43_200, watchdogWriteReservePerDay: WATCHDOG_WRITE_RESERVE,
          nonAlarmWriteCapPerDay: NON_ALARM_WRITE_CAP, nonAlarmWritesToday: this.runtime.nonAlarmWrites,
          plannedDoWritesPerDay: 54_080,
          internalAnalysisP99RedlineMs: 25, topLevelCpuP99RedlineMs: 8, assumedRuntimePollSeconds: 15,
          plannedForegroundDoRequestsPerDay: 5_760, plannedCronWatchdogsPerDay: 1_440, plannedTotalDoRequestsPerDay: 50_400,
          maxOpenPositions: MAX_OPEN_POSITIONS, plannedMaxD1BilledWritesPerDay: 4_800 } });
    }
    if (path === "/owner-status" && request.method === "GET") {
      await this.ensureAlarm();
      return json({ live: this.runtime.live, generatedAt: Date.now() });
    }
    if (path === "/live-mode" && request.method === "POST") {
      const body = await request.json<{ enabled?: unknown }>().catch(() => ({} as { enabled?: unknown }));
      if (typeof body.enabled !== "boolean") return json({ error: "invalid live mode" }, 400);
      const result = await this.setLiveMode(body.enabled);
      return json(result, result.ok ? 200 : 409);
    }
    return json({ error: "not found" }, 404);
  }
}

const isAsset = (pathname: string) => pathname.startsWith("/_next/") || pathname.startsWith("/assets/") || /\.[a-z0-9]{2,8}$/i.test(pathname);
let runtimeCache: { response: string; expiresAt: number } | null = null;
let historyCache: { response: string; expiresAt: number } | null = null;
const candleCache = new Map<string, { response: string; expiresAt: number }>();
const failedLogins = new Map<string, { count: number; resetAt: number }>();
async function runtimeStatus(env: CloudflareEnv, useCache = true, owner = false) {
  if (!owner && useCache && runtimeCache && runtimeCache.expiresAt > Date.now()) return new Response(runtimeCache.response, { headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=10" } });
  const response = await env.MARKET_STREAM.getByName("primary").fetch(owner ? "https://market-stream/owner-runtime" : "https://market-stream/status");
  const body = await response.text();
  if (!owner && response.ok) runtimeCache = { response: body, expiresAt: Date.now() + 10_000 };
  return new Response(body, { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=10" } });
}

async function paperHistory(env: CloudflareEnv) {
  if (historyCache && historyCache.expiresAt > Date.now()) {
    return new Response(historyCache.response, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } });
  }
  const result = await env.DB.prepare(`SELECT
    id, symbol, market_state AS marketState, side, status,
    entry_at AS entryAt, entry_price AS entryPrice,
    current_stop AS currentStop, current_target AS currentTarget,
    planned_risk AS plannedRisk, notional,
    exit_at AS exitAt, exit_price AS exitPrice,
    exit_reason AS exitReason, realized_pnl AS realizedPnl
    FROM paper_positions
    ORDER BY COALESCE(exit_at, entry_at) DESC
    LIMIT 60`).all();
  const body = JSON.stringify({ items: result.results ?? [], generatedAt: Date.now() });
  historyCache = { response: body, expiresAt: Date.now() + 30_000 };
  return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } });
}

async function chartCandles(url: URL, env: CloudflareEnv) {
  const symbol = url.searchParams.get("symbol") ?? "";
  const interval = url.searchParams.get("interval") ?? "15m";
  if (!DEFAULT_SYMBOLS.includes(symbol) || !["1m", "15m", "1h"].includes(interval)) {
    return json({ error: "unsupported futures chart" }, 400);
  }
  const key = `${symbol}:${interval}`;
  const cached = candleCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return new Response(cached.response, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=20" } });
  }
  try {
    const row = await env.DB.prepare("SELECT chart_cache_json AS chartCache,chart_cache_at AS chartCacheAt FROM system_settings WHERE id=1").first<{ chartCache: string | null; chartCacheAt: number | null }>();
    const bundle = row?.chartCache ? JSON.parse(row.chartCache) as Record<string, Partial<Record<"1m" | "15m" | "1h", Awaited<ReturnType<typeof fetchStructureCandles>>>>> : {};
    const candles = bundle[symbol]?.[interval as "1m" | "15m" | "1h"] ?? [];
    if (candles.length < 20) throw new Error("actual candles warming");
    const body = JSON.stringify({ symbol, interval, source: "GATE_USDT_FUTURES", candles, generatedAt: row?.chartCacheAt ?? Date.now() });
    candleCache.set(key, { response: body, expiresAt: Date.now() + 20_000 });
    return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=20" } });
  } catch (error) {
    if (cached) return new Response(cached.response, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=5", Warning: '110 - "Gate refresh delayed; serving last actual candles"' } });
    return json({ error: safeError(error) }, 503);
  }
}

async function ownerAuthenticated(request: Request, env: CloudflareEnv) {
  return env.OWNER_ACCESS_TOKEN ? verifyOwnerSession(request, env.OWNER_ACCESS_TOKEN) : false;
}

async function authSession(request: Request, env: CloudflareEnv) {
  return json({ configured: ownerAuthConfigured(env.OWNER_ACCESS_TOKEN), authenticated: await ownerAuthenticated(request, env), username: "owner" });
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

const worker = {
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (isAsset(url.pathname)) return env.ASSETS.fetch(request);
    if (url.pathname === "/__health") {
      const started = performance.now();
      const response = await runtimeStatus(env, false);
      const runtime = await response.json<Record<string, unknown>>();
      const live = runtimeReady(runtime as RuntimeHealthShape);
      return json({ ok: response.ok && live, ready: live, version: SYSTEM_VERSION, mode: "PAPER", runtime, topLevelCpuMs: performance.now() - started }, live ? 200 : 503);
    }
    if (url.pathname === "/api/runtime" && request.method === "GET") return runtimeStatus(env, true, await ownerAuthenticated(request, env));
    if (url.pathname === "/api/history" && request.method === "GET") return paperHistory(env);
    if (url.pathname === "/api/candles" && request.method === "GET") return chartCandles(url, env);
    if (url.pathname === "/api/auth/session" && request.method === "GET") return authSession(request, env);
    if (url.pathname === "/api/auth/login" && request.method === "POST") return ownerLogin(request, env);
    if (url.pathname === "/api/auth/logout" && request.method === "POST") return ownerLogout(request);
    if (url.pathname === "/api/live/status" && request.method === "GET") return ownerLiveStatus(request, env);
    if (url.pathname === "/api/live/mode" && request.method === "POST") return ownerLiveMode(request, env);
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return handler.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
    ctx.waitUntil(env.MARKET_STREAM.getByName("primary").fetch("https://market-stream/watchdog"));
  },
};
export default worker;
