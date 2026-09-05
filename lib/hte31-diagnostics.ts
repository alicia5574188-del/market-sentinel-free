import { asc, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../db";
import { hte31ShadowSamples, hte31TriggerBuckets } from "../db/hte31-diagnostics-schema";
import { hte31Trades } from "../db/hte31-schema";
import { HTE31_PAPER_PORTFOLIO_POLICY } from "./hte31-position-sizing.ts";
import { isCurrentResonanceTrade } from "./resonance-policy-version.ts";
import { HTE31_ALL_TRADER_IDS, HTE31_STRATEGY_FAMILIES, hte31TraderDefinition, hte31TraderIdForSignal, type Hte31TraderId } from "./hte31-strategy-catalog.ts";
import { buildHte31StrategyRouterDecision, HTE31_ROUTER_PROMOTION_POLICY, type Hte31RouterEvidence } from "./hte31-strategy-router.ts";
import { evaluateHte31StrategyHealth, summarizeHte31FamilyHealth } from "./hte31-strategy-health.ts";
import type { Hte31Signal } from "./hte31-types.ts";
import type { GateAnalysisPacket } from "./gate-client.ts";

const BUCKET_MS = 10 * 60_000;
const TRADERS: Hte31TraderId[] = [...HTE31_ALL_TRADER_IDS];
const SOFT_CONFIRMATION_KEYS: Partial<Record<Hte31TraderId, ReadonlySet<string>>> = {
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
  triggerActive: number;
  ready: number;
  watching: number;
  blocked: number;
  nearReady: number;
  failures: Record<string, number>;
  nearest: NearestCandidate | null;
};

type TriggerBucketPayload = Record<Hte31TraderId, TraderBucket>;

function emptyTraderBucket(): TraderBucket {
  return { evaluations: 0, triggerActive: 0, ready: 0, watching: 0, blocked: 0, nearReady: 0, failures: {}, nearest: null };
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
  bucket.triggerActive = (bucket.triggerActive ?? 0) + (signal.strategyMeta.triggerActive ? 1 : 0);
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

export async function recordHte31DiagnosticCycle(
  packet: GateAnalysisPacket,
  signals: Hte31Signal[],
  activePosition: { traderId: string; side: "LONG" | "SHORT" } | null = null,
) {
  const bucketStart = Math.floor(packet.observedAt / BUCKET_MS) * BUCKET_MS;
  const [existing] = await getDb().select().from(hte31TriggerBuckets).where(eq(hte31TriggerBuckets.bucketStart, bucketStart)).limit(1);
  const payload = parseJson<TriggerBucketPayload>(existing?.payloadJson, emptyBucket());

  for (const signal of signals) {
    const traderId = hte31TraderIdForSignal(signal);
    const failed = failedRequired(signal);
    const nearReady = isNearReady(traderId, signal, failed);
    const bucket = payload[traderId] ?? (payload[traderId] = emptyTraderBucket());
    mergeSignal(bucket, packet, signal, failed, nearReady);
  }

  await getDb().insert(hte31TriggerBuckets).values({
    bucketStart,
    payloadJson: JSON.stringify(payload),
    updatedAt: packet.observedAt,
  }).onConflictDoUpdate({
    target: hte31TriggerBuckets.bucketStart,
    set: { payloadJson: JSON.stringify(payload), updatedAt: packet.observedAt },
  });

  const evidence = await buildPaperRouterEvidence();
  return buildHte31StrategyRouterDecision({
    observedAt: packet.observedAt,
    symbol: packet.symbol,
    signals,
    evidence,
    activePosition,
  });
}

function paperMaximumDrawdownR(rows: (typeof hte31Trades.$inferSelect)[]) {
  let cumulative = 0;
  let peak = 0;
  let maximum = 0;
  for (const row of [...rows].sort((a, b) => a.entryAt - b.entryAt)) {
    const resultR = row.riskBudgetUsdt > 0 ? (row.netPnlUsdt ?? 0) / row.riskBudgetUsdt : 0;
    cumulative += resultR;
    peak = Math.max(peak, cumulative);
    maximum = Math.max(maximum, peak - cumulative);
  }
  return maximum;
}

async function buildPaperRouterEvidence(): Promise<Hte31RouterEvidence[]> {
  const rows = (await getDb().select().from(hte31Trades)
    .where(eq(hte31Trades.status, "closed"))
    .orderBy(desc(hte31Trades.exitAt)).limit(500))
    .filter((row) => isCurrentResonanceTrade(row.entryAt) && row.netPnlUsdt != null && row.riskBudgetUsdt > 0);
  return TRADERS.map((traderId) => {
    const own = rows.filter((row) => row.traderId === traderId);
    const results = own.map((row) => (row.netPnlUsdt ?? 0) / row.riskBudgetUsdt);
    const recent = results.slice(0, 8);
    const baseline = results.slice(8);
    const grossProfitR = results.reduce((sum, value) => sum + Math.max(0, value), 0);
    const grossLossR = Math.abs(results.reduce((sum, value) => sum + Math.min(0, value), 0));
    const expectancyR = results.length ? results.reduce((sum, value) => sum + value, 0) / results.length : 0;
    const profitFactor = grossLossR > 0 ? grossProfitR / grossLossR : grossProfitR > 0 ? 99 : null;
    const maximumDrawdownR = paperMaximumDrawdownR(own);
    const qualified = results.length >= HTE31_ROUTER_PROMOTION_POLICY.minimumSamples
      && profitFactor != null && profitFactor >= HTE31_ROUTER_PROMOTION_POLICY.minimumProfitFactor
      && expectancyR >= HTE31_ROUTER_PROMOTION_POLICY.minimumExpectancyR
      && maximumDrawdownR <= HTE31_ROUTER_PROMOTION_POLICY.maximumDrawdownR;
    const recentExpectancyR = recent.length ? recent.reduce((sum, value) => sum + value, 0) / recent.length : 0;
    const baselineExpectancyR = baseline.length ? baseline.reduce((sum, value) => sum + value, 0) / baseline.length : 0;
    let historical = 0;
    let everProfitable = false;
    for (const value of [...results].reverse()) {
      historical += value;
      if (historical > 0) everProfitable = true;
    }
    return {
      traderId,
      sampleCount: results.length,
      expectancyR,
      profitFactor,
      maximumDrawdownR,
      qualified,
      recentSampleCount: recent.length,
      recentExpectancyR,
      baselineSampleCount: baseline.length,
      baselineExpectancyR,
      everProfitable,
    };
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

type FailureSummary = { label: string; count: number; rate: number };
type TraderWindowSummary = {
  evaluations: number;
  triggerActive: number;
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
      target.triggerActive += source.triggerActive ?? 0;
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
        triggerActive: row.triggerActive,
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
  const [buckets, shadowRows, routerEvidence] = await Promise.all([
    db.select().from(hte31TriggerBuckets).where(gte(hte31TriggerBuckets.bucketStart, now - 24 * 60 * 60_000)).orderBy(asc(hte31TriggerBuckets.bucketStart)),
    db.select().from(hte31ShadowSamples).orderBy(desc(hte31ShadowSamples.updatedAt)).limit(500),
    buildPaperRouterEvidence(),
  ]);
  const h24 = summarizeBuckets(buckets, now - 24 * 60 * 60_000);
  const strategyHealth = Object.fromEntries(routerEvidence.map((evidence) => {
    const activity = h24.traders[evidence.traderId];
    return [evidence.traderId, {
      traderId: evidence.traderId,
      familyId: hte31TraderDefinition(evidence.traderId).familyId,
      ...evaluateHte31StrategyHealth({
        sampleCount: evidence.sampleCount,
        expectancyR: evidence.expectancyR,
        recentSampleCount: evidence.recentSampleCount ?? 0,
        recentExpectancyR: evidence.recentExpectancyR ?? 0,
        baselineSampleCount: evidence.baselineSampleCount ?? 0,
        baselineExpectancyR: evidence.baselineExpectancyR ?? 0,
        everProfitable: evidence.everProfitable ?? false,
        evaluations: activity.evaluations,
        triggerActive: activity.triggerActive,
        ready: activity.ready,
        nearReady: activity.nearReady,
        topFailures: activity.topFailures,
      }),
    }];
  })) as Record<Hte31TraderId, ReturnType<typeof evaluateHte31StrategyHealth> & { traderId: Hte31TraderId; familyId: string }>;
  const familyHealth = Object.fromEntries(HTE31_STRATEGY_FAMILIES.map((family) => [family.id, summarizeHte31FamilyHealth({
    familyId: family.id,
    members: family.traderIds.map((traderId) => ({ traderId, health: strategyHealth[traderId] })),
  })]));
  return {
    windows: {
      h1: summarizeBuckets(buckets, now - 60 * 60_000),
      h6: summarizeBuckets(buckets, now - 6 * 60 * 60_000),
      h24,
    },
    shadow: Object.fromEntries(TRADERS.map((traderId) => [traderId, shadowSummary(shadowRows, traderId)])) as Record<Hte31TraderId, ReturnType<typeof shadowSummary>>,
    routerEvidence,
    strategyHealth,
    familyHealth,
    policy: {
      softConfirmationKeys: {
        dennis_trend: [...(SOFT_CONFIRMATION_KEYS.dennis_trend ?? [])],
        raschke_pullback: [...(SOFT_CONFIRMATION_KEYS.raschke_pullback ?? [])],
        turtle_soup: [],
      },
      turtleSoupRelaxationEnabled: false,
      automaticThresholdChanges: false,
      maximumConcurrentResearchPositions: 0,
      maximumConcurrentPaperPositions: null,
      maximumPortfolioRiskRate: HTE31_PAPER_PORTFOLIO_POLICY.maximumTotalPlannedRiskRate,
      routerAuthority: "paper_brain_live_parity",
      promotion: HTE31_ROUTER_PROMOTION_POLICY,
    },
  };
}
