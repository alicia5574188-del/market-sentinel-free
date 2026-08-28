import { and, asc, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../db";
import { hte31ShadowSamples, hte31TriggerBuckets } from "../db/hte31-diagnostics-schema";
import type { AppSettings } from "./repository.ts";
import type { Strategy2Signal } from "./strategy-2-engine.ts";
import type { GateAnalysisPacket } from "./gate-client.ts";
import type { HumanTraderId } from "./human-trader-engine.ts";

const BUCKET_MS = 10 * 60_000;
const SHADOW_DEDUPE_MS = 30 * 60_000;
const SHADOW_HORIZONS = [30, 60, 120, 240] as const;
const TRADERS: HumanTraderId[] = ["dennis_trend", "raschke_pullback", "turtle_soup"];
const SOFT_CONFIRMATION_KEYS: Record<HumanTraderId, ReadonlySet<string>> = {
  dennis_trend: new Set(["dennis-flow"]),
  raschke_pullback: new Set(["raschke-flow"]),
  turtle_soup: new Set(),
};

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

type TriggerBucketPayload = Record<HumanTraderId, TraderBucket>;

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
  return {
    dennis_trend: emptyTraderBucket(),
    raschke_pullback: emptyTraderBucket(),
    turtle_soup: emptyTraderBucket(),
  };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function traderForSignal(signal: Strategy2Signal): HumanTraderId | null {
  if (signal.strategyId === "trend_breakout") return "dennis_trend";
  if (signal.strategyId === "trend_pullback") return "raschke_pullback";
  if (signal.strategyId === "failed_breakout") return "turtle_soup";
  return null;
}

function failedRequired(signal: Strategy2Signal): FailedCheck[] {
  return signal.entryPlan?.checks
    .filter((check) => check.required && !check.passed)
    .map((check) => ({ key: check.key, label: check.label })) ?? [];
}

function isNearReady(traderId: HumanTraderId, signal: Strategy2Signal, failed: FailedCheck[]) {
  return signal.state === "watching"
    && signal.side !== "WAIT"
    && Boolean(signal.entryPlan)
    && failed.length === 1
    && SOFT_CONFIRMATION_KEYS[traderId].has(failed[0].key);
}

function mergeSignal(bucket: TraderBucket, packet: GateAnalysisPacket, signal: Strategy2Signal, failed: FailedCheck[], nearReady: boolean) {
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

async function advanceShadowSamples(symbol: string, observedAt: number, price: number, roundTripCostBps: number) {
  const db = getDb();
  const pending = await db.select().from(hte31ShadowSamples)
    .where(and(eq(hte31ShadowSamples.symbol, symbol), eq(hte31ShadowSamples.status, "pending")))
    .orderBy(asc(hte31ShadowSamples.entryAt)).limit(24);

  for (const sample of pending) {
    if (observedAt <= sample.entryAt) continue;
    const high = Math.max(sample.maxPriceSeen, price);
    const low = Math.min(sample.minPriceSeen, price);
    const observations = parseJson<ShadowObservation[]>(sample.observationsJson, []);
    const seen = new Set(observations.map((item) => item.horizonMinutes));
    const move = excursionR(sample.side, sample.entryPrice, high, low, sample.riskPerUnit);
    const feeR = costR(sample.entryPrice, sample.riskPerUnit, roundTripCostBps);

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
      }
    }

    const complete = observedAt >= sample.entryAt + 240 * 60_000;
    let resultR: number | null = sample.resultR;
    let outcome: "win" | "loss" | "flat" | null = sample.outcome;
    if (complete) {
      const targetR = Math.abs(sample.takeProfit2Price - sample.entryPrice) / Math.max(sample.riskPerUnit, Number.EPSILON);
      const stopped = move.adverse >= 1;
      const targeted = move.favorable >= targetR;
      resultR = stopped ? -1 - feeR : targeted ? targetR - feeR : closeR(sample.side, sample.entryPrice, price, sample.riskPerUnit) - feeR;
      outcome = resultR > 0.05 ? "win" : resultR < -0.05 ? "loss" : "flat";
    }

    await db.update(hte31ShadowSamples).set({
      maxPriceSeen: high,
      minPriceSeen: low,
      lastPrice: price,
      lastObservedAt: observedAt,
      observationsJson: JSON.stringify(observations.sort((a, b) => a.horizonMinutes - b.horizonMinutes)),
      status: complete ? "complete" : "pending",
      finalAt: complete ? observedAt : sample.finalAt,
      finalPrice: complete ? price : sample.finalPrice,
      resultR,
      mfeR: move.favorable,
      maeR: move.adverse,
      outcome,
      updatedAt: observedAt,
    }).where(eq(hte31ShadowSamples.id, sample.id));
  }
}

async function createNearReadySample(packet: GateAnalysisPacket, signal: Strategy2Signal, traderId: HumanTraderId, failed: FailedCheck[]) {
  if (!isNearReady(traderId, signal, failed) || !signal.entryPlan || signal.side === "WAIT") return;
  const plan = signal.entryPlan;
  const riskPerUnit = Math.abs(plan.entryPrice - plan.stopLossPrice);
  if (!(plan.entryPrice > 0 && plan.stopLossPrice > 0 && plan.takeProfit2Price > 0 && riskPerUnit > 0)) return;
  const dedupeBucket = Math.floor(packet.observedAt / SHADOW_DEDUPE_MS);
  const id = `hte31-shadow:${traderId}:${packet.symbol}:${failed[0].key}:${dedupeBucket}`;
  await getDb().insert(hte31ShadowSamples).values({
    id,
    symbol: packet.symbol,
    traderId,
    setupId: signal.strategyId,
    side: signal.side,
    assetRegime: signal.strategyMeta.assetRegime,
    missingKey: failed[0].key,
    missingLabel: failed[0].label,
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
    createdAt: packet.observedAt,
    updatedAt: packet.observedAt,
  }).onConflictDoNothing();
}

export async function recordHte31DiagnosticCycle(packet: GateAnalysisPacket, signals: Strategy2Signal[], settings: AppSettings) {
  await advanceShadowSamples(packet.symbol, packet.observedAt, packet.market.futuresPrice, settings.roundTripCostBps);

  const bucketStart = Math.floor(packet.observedAt / BUCKET_MS) * BUCKET_MS;
  const [existing] = await getDb().select().from(hte31TriggerBuckets).where(eq(hte31TriggerBuckets.bucketStart, bucketStart)).limit(1);
  const payload = parseJson<TriggerBucketPayload>(existing?.payloadJson, emptyBucket());

  for (const signal of signals) {
    const traderId = traderForSignal(signal);
    if (!traderId) continue;
    const failed = failedRequired(signal);
    const nearReady = isNearReady(traderId, signal, failed);
    mergeSignal(payload[traderId], packet, signal, failed, nearReady);
    if (nearReady) await createNearReadySample(packet, signal, traderId, failed);
  }

  await getDb().insert(hte31TriggerBuckets).values({
    bucketStart,
    payloadJson: JSON.stringify(payload),
    updatedAt: packet.observedAt,
  }).onConflictDoUpdate({
    target: hte31TriggerBuckets.bucketStart,
    set: { payloadJson: JSON.stringify(payload), updatedAt: packet.observedAt },
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

type WindowSummary = { traders: Record<HumanTraderId, TraderWindowSummary> };

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
    })) as Record<HumanTraderId, TraderWindowSummary>,
  };
}

function shadowSummary(rows: typeof hte31ShadowSamples.$inferSelect[], traderId: HumanTraderId) {
  const own = rows.filter((row) => row.traderId === traderId);
  const complete = own.filter((row) => row.status === "complete" && row.resultR != null);
  const pending = own.filter((row) => row.status === "pending").length;
  const grossProfitR = complete.reduce((sum, row) => sum + Math.max(0, row.resultR ?? 0), 0);
  const grossLossR = Math.abs(complete.reduce((sum, row) => sum + Math.min(0, row.resultR ?? 0), 0));
  const expectancyR = complete.length ? complete.reduce((sum, row) => sum + (row.resultR ?? 0), 0) / complete.length : 0;
  const profitFactor = grossLossR > 0 ? grossProfitR / grossLossR : grossProfitR > 0 ? 99 : null;
  const qualifiesForCalibration = complete.length >= HTE31_SHADOW_MIN_SAMPLES
    && profitFactor != null && profitFactor >= HTE31_SHADOW_MIN_PROFIT_FACTOR
    && expectancyR >= HTE31_SHADOW_MIN_EXPECTANCY_R;
  const missing = Object.entries(complete.reduce<Record<string, number>>((acc, row) => {
    acc[row.missingLabel] = (acc[row.missingLabel] ?? 0) + 1;
    return acc;
  }, {})).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    completed: complete.length,
    pending,
    wins: complete.filter((row) => row.outcome === "win").length,
    losses: complete.filter((row) => row.outcome === "loss").length,
    expectancyR,
    profitFactor,
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
    shadow: Object.fromEntries(TRADERS.map((traderId) => [traderId, shadowSummary(shadowRows, traderId)])) as Record<HumanTraderId, ReturnType<typeof shadowSummary>>,
    policy: {
      softConfirmationKeys: {
        dennis_trend: [...SOFT_CONFIRMATION_KEYS.dennis_trend],
        raschke_pullback: [...SOFT_CONFIRMATION_KEYS.raschke_pullback],
        turtle_soup: [],
      },
      turtleSoupRelaxationEnabled: false,
      automaticThresholdChanges: false,
    },
  };
}
