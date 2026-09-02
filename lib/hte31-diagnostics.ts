import { and, asc, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../db";
import { hte31ShadowSamples, hte31TriggerBuckets } from "../db/hte31-diagnostics-schema";
import type { AppSettings } from "./settings-repository.ts";
import { HTE31_ALL_TRADER_IDS, hte31TraderIdForSignal, type Hte31TraderId } from "./hte31-strategy-catalog.ts";
import { buildHte31StrategyRouterDecision, HTE31_ROUTER_PROMOTION_POLICY, type Hte31RouterEvidence } from "./hte31-strategy-router.ts";
import type { Hte31Candle, Hte31Signal } from "./hte31-types.ts";
import type { GateAnalysisPacket } from "./gate-client.ts";

const BUCKET_MS = 10 * 60_000;
const SHADOW_DEDUPE_MS = 30 * 60_000;
const SHADOW_HORIZONS = [30, 60, 120, 240, 480, 720] as const;
const TRADERS: Hte31TraderId[] = [...HTE31_ALL_TRADER_IDS];
const SOFT_CONFIRMATION_KEYS: Partial<Record<Hte31TraderId, ReadonlySet<string>>> = {
  dennis_trend: new Set(["dennis-flow"]),
  raschke_pullback: new Set(["raschke-flow"]),
  turtle_soup: new Set(),
};

export const HTE31_RESEARCH_MAX_PENDING = 64;

export const HTE31_SHADOW_MIN_SAMPLES = 30;
export const HTE31_SHADOW_MIN_PROFIT_FACTOR = 1.3;
export const HTE31_SHADOW_MIN_EXPECTANCY_R = 0.15;

type FailedCheck = { key: string; label: string };
type NearestCandidate = {
  symbol: string;
  observedAt: number;
  state: string;
  confidence: number;
  setupScore: number;
  evidenceScore: number;
  failed: FailedCheck[];
};

type TraderBucket = {
  evaluations: number;
  ready: number;
  watching: number;
  blocked: number;
  nearReady: number;
  failures: Record<string, number>;
  nearest: NearestCandidate | null;
};

type TriggerBucketPayload = Record<Hte31TraderId, TraderBucket>;

type ShadowObservation = {
  horizonMinutes: number;
  observedAt: number;
  price: number;
  closeR: number;
  favorableR: number;
  adverseR: number;
};

function emptyTraderBucket(): TraderBucket {
  return { evaluations: 0, ready: 0, watching: 0, blocked: 0, nearReady: 0, failures: {}, nearest: null };
}

function emptyBucket(): TriggerBucketPayload {
  return Object.fromEntries(TRADERS.map((traderId) => [traderId, emptyTraderBucket()])) as TriggerBucketPayload;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function failedRequired(signal: Hte31Signal): FailedCheck[] {
  return signal.entryPlan?.checks
    .filter((check) => check.required && !check.passed)
    .map((check) => ({ key: check.key, label: check.label })) ?? [];
}

function isNearReady(traderId: Hte31TraderId, signal: Hte31Signal, failed: FailedCheck[]) {
  return signal.state === "watching"
    && signal.side !== "WAIT"
    && Boolean(signal.entryPlan)
    && failed.length === 1
    && Boolean(SOFT_CONFIRMATION_KEYS[traderId]?.has(failed[0].key));
}

function mergeSignal(bucket: TraderBucket, packet: GateAnalysisPacket, signal: Hte31Signal, failed: FailedCheck[], nearReady: boolean) {
  bucket.evaluations += 1;
  if (signal.state === "ready") bucket.ready += 1;
  else if (signal.state === "blocked") bucket.blocked += 1;
  else bucket.watching += 1;
  if (nearReady) bucket.nearReady += 1;
  for (const item of failed) bucket.failures[item.label] = (bucket.failures[item.label] ?? 0) + 1;

  const candidate: NearestCandidate = {
    symbol: packet.symbol,
    observedAt: packet.observedAt,
    state: signal.state,
    confidence: signal.confidence,
    setupScore: signal.strategyMeta.setupScore,
    evidenceScore: signal.strategyMeta.evidenceScore,
    failed,
  };
  const previous = bucket.nearest;
  if (!previous
    || candidate.failed.length < previous.failed.length
    || (candidate.failed.length === previous.failed.length && candidate.confidence > previous.confidence)
    || (candidate.failed.length === previous.failed.length && candidate.confidence === previous.confidence && candidate.observedAt > previous.observedAt)) {
    bucket.nearest = candidate;
  }
}

function costR(entryPrice: number, riskPerUnit: number, roundTripCostBps: number) {
  if (!(entryPrice > 0 && riskPerUnit > 0)) return 0;
  return (entryPrice * roundTripCostBps / 10_000) / riskPerUnit;
}

function excursionR(side: "LONG" | "SHORT", entry: number, high: number, low: number, risk: number) {
  if (!(risk > 0)) return { favorable: 0, adverse: 0 };
  return side === "LONG"
    ? { favorable: Math.max(0, (high - entry) / risk), adverse: Math.max(0, (entry - low) / risk) }
    : { favorable: Math.max(0, (entry - low) / risk), adverse: Math.max(0, (high - entry) / risk) };
}

function closeR(side: "LONG" | "SHORT", entry: number, price: number, risk: number) {
  if (!(risk > 0)) return 0;
  return (side === "LONG" ? price - entry : entry - price) / risk;
}

function candleTimeMs(time: number) {
  return time > 10_000_000_000 ? time : time * 1000;
}

function terminalHit(sample: typeof hte31ShadowSamples.$inferSelect, high: number, low: number) {
  const stopped = sample.side === "LONG" ? low <= sample.stopPrice : high >= sample.stopPrice;
  const targeted = sample.side === "LONG" ? high >= sample.takeProfit2Price : low <= sample.takeProfit2Price;
  // With no tick ordering inside a candle, apply the conservative stop-first rule.
  if (stopped) return { reason: "stop_loss" as const, price: sample.stopPrice };
  if (targeted) return { reason: "take_profit" as const, price: sample.takeProfit2Price };
  return null;
}

async function advanceShadowSamples(
  symbol: string,
  observedAt: number,
  price: number,
  candles: Hte31Candle[],
  roundTripCostBps: number,
) {
  const db = getDb();
  const pending = await db.select().from(hte31ShadowSamples)
    .where(and(eq(hte31ShadowSamples.symbol, symbol), eq(hte31ShadowSamples.status, "pending")))
    .orderBy(asc(hte31ShadowSamples.entryAt)).limit(HTE31_RESEARCH_MAX_PENDING);

  for (const sample of pending) {
    if (observedAt <= sample.entryAt) continue;
    const freshBars = candles
      .map((bar) => ({ ...bar, completedAt: candleTimeMs(bar.time) + 5 * 60_000 }))
      .filter((bar) => bar.completedAt > sample.lastObservedAt && bar.completedAt <= observedAt)
      .sort((a, b) => a.completedAt - b.completedAt);
    let high = sample.maxPriceSeen;
    let low = sample.minPriceSeen;
    let terminalAt = sample.terminalAt;
    let terminalPrice = sample.terminalPrice;
    let terminalReason = sample.terminalReason;
    const observations = parseJson<ShadowObservation[]>(sample.observationsJson, []);
    const seen = new Set(observations.map((item) => item.horizonMinutes));
    const feeR = costR(sample.entryPrice, sample.riskPerUnit, roundTripCostBps);

    for (const bar of freshBars) {
      high = Math.max(high, bar.high);
      low = Math.min(low, bar.low);
      const move = excursionR(sample.side, sample.entryPrice, high, low, sample.riskPerUnit);
      if (terminalAt == null) {
        const hit = terminalHit(sample, bar.high, bar.low);
        if (hit) {
          terminalAt = bar.completedAt;
          terminalPrice = hit.price;
          terminalReason = hit.reason;
        }
      }
      for (const horizon of SHADOW_HORIZONS) {
        if (!seen.has(horizon) && bar.completedAt >= sample.entryAt + horizon * 60_000) {
          observations.push({
            horizonMinutes: horizon,
            observedAt: bar.completedAt,
            price: bar.close,
            closeR: closeR(sample.side, sample.entryPrice, bar.close, sample.riskPerUnit) - feeR,
            favorableR: move.favorable,
            adverseR: move.adverse,
          });
          seen.add(horizon);
        }
      }
      if (terminalAt != null) break;
    }

    if (terminalAt == null) {
      high = Math.max(high, price);
      low = Math.min(low, price);
      const maxHoldingMinutes = Math.max(30, Math.min(720, sample.maxHoldingMinutes));
      if (observedAt >= sample.entryAt + maxHoldingMinutes * 60_000) {
        terminalAt = observedAt;
        terminalPrice = price;
        terminalReason = "timeout";
      }
    }

    const move = excursionR(sample.side, sample.entryPrice, high, low, sample.riskPerUnit);
    if (terminalAt == null) {
      for (const horizon of SHADOW_HORIZONS) {
        if (!seen.has(horizon) && observedAt >= sample.entryAt + horizon * 60_000) {
          observations.push({
            horizonMinutes: horizon,
            observedAt,
            price,
            closeR: closeR(sample.side, sample.entryPrice, price, sample.riskPerUnit) - feeR,
            favorableR: move.favorable,
            adverseR: move.adverse,
          });
          seen.add(horizon);
        }
      }
    }

    const complete = terminalAt != null;
    const targetR = Math.abs(sample.takeProfit2Price - sample.entryPrice) / Math.max(sample.riskPerUnit, Number.EPSILON);
    const resultR = !complete || terminalPrice == null || terminalReason == null
      ? null
      : terminalReason === "stop_loss"
        ? -1 - feeR
        : terminalReason === "take_profit"
          ? targetR - feeR
          : closeR(sample.side, sample.entryPrice, terminalPrice, sample.riskPerUnit) - feeR;
    const outcome: "win" | "loss" | "flat" | null = resultR == null
      ? null
      : resultR > 0.05 ? "win" : resultR < -0.05 ? "loss" : "flat";

    await db.update(hte31ShadowSamples).set({
      maxPriceSeen: high,
      minPriceSeen: low,
      lastPrice: price,
      lastObservedAt: observedAt,
      observationsJson: JSON.stringify(observations.sort((a, b) => a.horizonMinutes - b.horizonMinutes)),
      status: complete ? "complete" : "pending",
      finalAt: terminalAt,
      finalPrice: terminalPrice,
      resultR,
      mfeR: move.favorable,
      maeR: move.adverse,
      outcome,
      terminalAt,
      terminalPrice,
      terminalReason,
      updatedAt: observedAt,
    }).where(eq(hte31ShadowSamples.id, sample.id));
  }
}

async function createShadowSample(
  packet: GateAnalysisPacket,
  signal: Hte31Signal,
  traderId: Hte31TraderId,
  failed: FailedCheck[],
  availableSlots: number,
) {
  if (availableSlots <= 0 || !signal.entryPlan || signal.side === "WAIT") return false;
  const nearReady = isNearReady(traderId, signal, failed);
  const ready = signal.state === "ready" && signal.entryPlan.ready;
  if (!nearReady && !ready) return false;
  const plan = signal.entryPlan;
  const riskPerUnit = Math.abs(plan.entryPrice - plan.stopLossPrice);
  if (!(plan.entryPrice > 0 && plan.stopLossPrice > 0 && plan.takeProfit2Price > 0 && riskPerUnit > 0)) return false;
  const sampleKind = ready ? "ready" as const : "near_ready" as const;
  const missingKey = ready ? "complete-setup" : failed[0].key;
  const missingLabel = ready ? "完整 Setup 并发研究" : failed[0].label;
  const dedupeBucket = Math.floor(packet.observedAt / SHADOW_DEDUPE_MS);
  const id = `hte31-shadow:${traderId}:${packet.symbol}:${signal.side}:${signal.strategyMeta.assetRegime}:${sampleKind}:${missingKey}:${dedupeBucket}`;
  const inserted = await getDb().insert(hte31ShadowSamples).values({
    id,
    symbol: packet.symbol,
    traderId,
    setupId: signal.strategyId,
    side: signal.side,
    assetRegime: signal.strategyMeta.assetRegime,
    missingKey,
    missingLabel,
    sampleKind,
    playbookId: signal.strategyMeta.playbookId,
    maxHoldingMinutes: plan.maxHoldingMinutes,
    confidence: signal.confidence,
    setupScore: signal.strategyMeta.setupScore,
    evidenceScore: signal.strategyMeta.evidenceScore,
    thesis: signal.thesis,
    entryAt: packet.observedAt,
    entryPrice: plan.entryPrice,
    stopPrice: plan.stopLossPrice,
    takeProfit2Price: plan.takeProfit2Price,
    riskPerUnit,
    status: "pending",
    maxPriceSeen: plan.entryPrice,
    minPriceSeen: plan.entryPrice,
    lastPrice: plan.entryPrice,
    lastObservedAt: packet.observedAt,
    observationsJson: "[]",
    finalAt: null,
    finalPrice: null,
    resultR: null,
    mfeR: null,
    maeR: null,
    outcome: null,
    terminalAt: null,
    terminalPrice: null,
    terminalReason: null,
    createdAt: packet.observedAt,
    updatedAt: packet.observedAt,
  }).onConflictDoNothing().returning({ id: hte31ShadowSamples.id });
  return inserted.length > 0;
}

export async function recordHte31DiagnosticCycle(
  packet: GateAnalysisPacket,
  signals: Hte31Signal[],
  settings: AppSettings,
  candles: Hte31Candle[] = [],
  activePosition: { traderId: string; side: "LONG" | "SHORT" } | null = null,
) {
  await advanceShadowSamples(packet.symbol, packet.observedAt, packet.market.futuresPrice, candles, settings.roundTripCostBps);

  const bucketStart = Math.floor(packet.observedAt / BUCKET_MS) * BUCKET_MS;
  const [existing] = await getDb().select().from(hte31TriggerBuckets).where(eq(hte31TriggerBuckets.bucketStart, bucketStart)).limit(1);
  const payload = parseJson<TriggerBucketPayload>(existing?.payloadJson, emptyBucket());

  const pendingRows = await getDb().select({ id: hte31ShadowSamples.id }).from(hte31ShadowSamples)
    .where(eq(hte31ShadowSamples.status, "pending")).limit(HTE31_RESEARCH_MAX_PENDING + 1);
  let availableSlots = Math.max(0, HTE31_RESEARCH_MAX_PENDING - pendingRows.length);

  for (const signal of signals) {
    const traderId = hte31TraderIdForSignal(signal);
    const failed = failedRequired(signal);
    const nearReady = isNearReady(traderId, signal, failed);
    const bucket = payload[traderId] ?? (payload[traderId] = emptyTraderBucket());
    mergeSignal(bucket, packet, signal, failed, nearReady);
    if (await createShadowSample(packet, signal, traderId, failed, availableSlots)) availableSlots -= 1;
  }

  await getDb().insert(hte31TriggerBuckets).values({
    bucketStart,
    payloadJson: JSON.stringify(payload),
    updatedAt: packet.observedAt,
  }).onConflictDoUpdate({
    target: hte31TriggerBuckets.bucketStart,
    set: { payloadJson: JSON.stringify(payload), updatedAt: packet.observedAt },
  });

  const evidenceRows = await getDb().select().from(hte31ShadowSamples)
    .where(eq(hte31ShadowSamples.sampleKind, "ready"))
    .orderBy(desc(hte31ShadowSamples.entryAt)).limit(500);
  const evidence = buildRouterEvidence(evidenceRows);
  return buildHte31StrategyRouterDecision({
    observedAt: packet.observedAt,
    symbol: packet.symbol,
    signals,
    evidence,
    activePosition,
  });
}

function maximumDrawdownR(rows: typeof hte31ShadowSamples.$inferSelect[]) {
  let cumulative = 0;
  let peak = 0;
  let maximum = 0;
  for (const row of [...rows].sort((a, b) => a.entryAt - b.entryAt)) {
    cumulative += row.resultR ?? 0;
    peak = Math.max(peak, cumulative);
    maximum = Math.max(maximum, peak - cumulative);
  }
  return maximum;
}

function independentCompletedRows(rows: typeof hte31ShadowSamples.$inferSelect[]) {
  const accepted: typeof rows = [];
  const lastTerminalByPath = new Map<string, number>();
  for (const row of [...rows].sort((a, b) => a.entryAt - b.entryAt)) {
    if (row.status !== "complete" || row.resultR == null) continue;
    const path = `${row.traderId}:${row.symbol}`;
    const previousTerminal = lastTerminalByPath.get(path) ?? -Infinity;
    if (row.entryAt < previousTerminal) continue;
    accepted.push(row);
    lastTerminalByPath.set(path, Math.max(
      row.entryAt + 1,
      row.terminalAt ?? row.finalAt ?? row.entryAt + Math.max(30, row.maxHoldingMinutes) * 60_000,
    ));
  }
  return accepted;
}

function buildRouterEvidence(rows: typeof hte31ShadowSamples.$inferSelect[]): Hte31RouterEvidence[] {
  return TRADERS.map((traderId) => {
    const own = independentCompletedRows(rows.filter((row) => row.traderId === traderId));
    const grossProfitR = own.reduce((sum, row) => sum + Math.max(0, row.resultR ?? 0), 0);
    const grossLossR = Math.abs(own.reduce((sum, row) => sum + Math.min(0, row.resultR ?? 0), 0));
    const expectancyR = own.length ? own.reduce((sum, row) => sum + (row.resultR ?? 0), 0) / own.length : 0;
    const profitFactor = grossLossR > 0 ? grossProfitR / grossLossR : grossProfitR > 0 ? 99 : null;
    const drawdown = maximumDrawdownR(own);
    const qualified = own.length >= HTE31_ROUTER_PROMOTION_POLICY.minimumSamples
      && profitFactor != null && profitFactor >= HTE31_ROUTER_PROMOTION_POLICY.minimumProfitFactor
      && expectancyR >= HTE31_ROUTER_PROMOTION_POLICY.minimumExpectancyR
      && drawdown <= HTE31_ROUTER_PROMOTION_POLICY.maximumDrawdownR;
    return {
      traderId,
      sampleCount: own.length,
      expectancyR,
      profitFactor,
      maximumDrawdownR: drawdown,
      qualified,
    };
  });
}

type FailureSummary = { label: string; count: number; rate: number };
type TraderWindowSummary = {
  evaluations: number;
  ready: number;
  watching: number;
  blocked: number;
  nearReady: number;
  readyRate: number;
  topFailures: FailureSummary[];
  nearest: NearestCandidate | null;
};

type WindowSummary = { traders: Record<Hte31TraderId, TraderWindowSummary> };

function summarizeBuckets(rows: { bucketStart: number; payloadJson: string }[], cutoff: number): WindowSummary {
  const totals = Object.fromEntries(TRADERS.map((id) => [id, emptyTraderBucket()])) as TriggerBucketPayload;
  for (const row of rows) {
    if (row.bucketStart < cutoff) continue;
    const payload = parseJson<TriggerBucketPayload>(row.payloadJson, emptyBucket());
    for (const traderId of TRADERS) {
      const source = payload[traderId] ?? emptyTraderBucket();
      const target = totals[traderId];
      target.evaluations += source.evaluations;
      target.ready += source.ready;
      target.watching += source.watching;
      target.blocked += source.blocked;
      target.nearReady += source.nearReady;
      for (const [label, count] of Object.entries(source.failures)) target.failures[label] = (target.failures[label] ?? 0) + count;
      if (source.nearest && (!target.nearest || source.nearest.failed.length < target.nearest.failed.length || source.nearest.observedAt > target.nearest.observedAt)) target.nearest = source.nearest;
    }
  }
  return {
    traders: Object.fromEntries(TRADERS.map((traderId) => {
      const row = totals[traderId];
      const topFailures = Object.entries(row.failures)
        .map(([label, count]) => ({ label, count, rate: row.evaluations ? count / row.evaluations : 0 }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 4);
      return [traderId, {
        evaluations: row.evaluations,
        ready: row.ready,
        watching: row.watching,
        blocked: row.blocked,
        nearReady: row.nearReady,
        readyRate: row.evaluations ? row.ready / row.evaluations : 0,
        topFailures,
        nearest: row.nearest,
      } satisfies TraderWindowSummary];
    })) as Record<Hte31TraderId, TraderWindowSummary>,
  };
}

function metricsForSamples(rows: typeof hte31ShadowSamples.$inferSelect[]) {
  const complete = independentCompletedRows(rows);
  const pending = rows.filter((row) => row.status === "pending").length;
  const grossProfitR = complete.reduce((sum, row) => sum + Math.max(0, row.resultR ?? 0), 0);
  const grossLossR = Math.abs(complete.reduce((sum, row) => sum + Math.min(0, row.resultR ?? 0), 0));
  const expectancyR = complete.length ? complete.reduce((sum, row) => sum + (row.resultR ?? 0), 0) / complete.length : 0;
  const profitFactor = grossLossR > 0 ? grossProfitR / grossLossR : grossProfitR > 0 ? 99 : null;
  return {
    completed: complete.length,
    pending,
    wins: complete.filter((row) => row.outcome === "win").length,
    losses: complete.filter((row) => row.outcome === "loss").length,
    expectancyR,
    profitFactor,
    maximumDrawdownR: maximumDrawdownR(complete),
  };
}

function shadowSummary(rows: typeof hte31ShadowSamples.$inferSelect[], traderId: Hte31TraderId) {
  const own = rows.filter((row) => row.traderId === traderId);
  const complete = independentCompletedRows(own);
  const all = metricsForSamples(own);
  const ready = metricsForSamples(own.filter((row) => row.sampleKind === "ready"));
  const nearReady = metricsForSamples(own.filter((row) => row.sampleKind === "near_ready"));
  const qualifiesForCalibration = ready.completed >= HTE31_SHADOW_MIN_SAMPLES
    && ready.profitFactor != null && ready.profitFactor >= HTE31_SHADOW_MIN_PROFIT_FACTOR
    && ready.expectancyR >= HTE31_SHADOW_MIN_EXPECTANCY_R
    && ready.maximumDrawdownR <= HTE31_ROUTER_PROMOTION_POLICY.maximumDrawdownR;
  const missing = Object.entries(complete.reduce<Record<string, number>>((acc, row) => {
    acc[row.missingLabel] = (acc[row.missingLabel] ?? 0) + 1;
    return acc;
  }, {})).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    ...all,
    ready,
    nearReady,
    dominantMissingCondition: missing,
    qualifiesForCalibration,
    calibrationRule: `至少 ${HTE31_SHADOW_MIN_SAMPLES} 个样本，PF ≥ ${HTE31_SHADOW_MIN_PROFIT_FACTOR.toFixed(2)} 且 Expectancy ≥ +${HTE31_SHADOW_MIN_EXPECTANCY_R.toFixed(2)}R 才允许进入下一阶段校准；不会自动修改正式阈值。`,
  };
}

export async function getHte31Diagnostics(now = Date.now()) {
  const db = getDb();
  const [buckets, shadowRows] = await Promise.all([
    db.select().from(hte31TriggerBuckets).where(gte(hte31TriggerBuckets.bucketStart, now - 6 * 60 * 60_000)).orderBy(asc(hte31TriggerBuckets.bucketStart)),
    db.select().from(hte31ShadowSamples).orderBy(desc(hte31ShadowSamples.updatedAt)).limit(500),
  ]);
  return {
    windows: {
      h1: summarizeBuckets(buckets, now - 60 * 60_000),
      h6: summarizeBuckets(buckets, now - 6 * 60 * 60_000),
    },
    shadow: Object.fromEntries(TRADERS.map((traderId) => [traderId, shadowSummary(shadowRows, traderId)])) as Record<Hte31TraderId, ReturnType<typeof shadowSummary>>,
    routerEvidence: buildRouterEvidence(shadowRows.filter((row) => row.sampleKind === "ready")),
    policy: {
      softConfirmationKeys: {
        dennis_trend: [...(SOFT_CONFIRMATION_KEYS.dennis_trend ?? [])],
        raschke_pullback: [...(SOFT_CONFIRMATION_KEYS.raschke_pullback ?? [])],
        turtle_soup: [],
      },
      turtleSoupRelaxationEnabled: false,
      automaticThresholdChanges: false,
      maximumConcurrentResearchPositions: HTE31_RESEARCH_MAX_PENDING,
      routerAuthority: "research_only",
      promotion: HTE31_ROUTER_PROMOTION_POLICY,
    },
  };
}
