import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { v2MarketSnapshots, v2Opportunities, v2TradeThesis, v2WarningEvents } from "../db/v2-schema.ts";
import type { V2MarketContext, V2Opportunity } from "./sentinel-v2-core.ts";

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function saveV2MarketContext(context: V2MarketContext) {
  const db = getDb();
  const id = crypto.randomUUID();
  await db.insert(v2MarketSnapshots).values({
    id,
    observedAt: context.observedAt,
    regime: context.regime,
    confidence: context.confidence,
    stability: context.stability,
    regimeScore: context.regimeScore,
    regimeMargin: context.regimeMargin,
    transitionRisk: context.transitionRisk,
    transitionVelocity: context.transitionVelocity,
    riskAcceleration: context.riskAcceleration,
    developingRegime: context.developingRegime,
    permission: context.permission,
    bias: context.bias,
    contextJson: JSON.stringify(context),
    createdAt: Date.now(),
  });

  if (context.warnings.length) {
    await db.insert(v2WarningEvents).values(context.warnings.map((warning) => ({
      id: crypto.randomUUID(),
      snapshotId: id,
      warningKey: warning.id,
      observedAt: context.observedAt,
      type: warning.type,
      level: warning.level,
      status: warning.status,
      severity: warning.severity,
      confidence: warning.confidence,
      relevance: warning.relevance,
      timeframe: warning.timeframe,
      direction: warning.direction,
      title: warning.title,
      detail: warning.detail,
      impact: warning.impact,
      payloadJson: JSON.stringify(warning),
      createdAt: Date.now(),
    })));
  }
  return id;
}

export async function getLatestV2MarketContext(): Promise<V2MarketContext | null> {
  const [row] = await getDb().select({ contextJson: v2MarketSnapshots.contextJson })
    .from(v2MarketSnapshots)
    .orderBy(desc(v2MarketSnapshots.observedAt))
    .limit(1);
  return row ? parseJson<V2MarketContext | null>(row.contextJson, null) : null;
}

export async function saveV2Opportunities(opportunities: V2Opportunity[]) {
  if (!opportunities.length) return 0;
  const now = Date.now();
  await getDb().insert(v2Opportunities).values(opportunities.map((opportunity) => ({
    id: crypto.randomUUID(),
    symbol: opportunity.symbol,
    observedAt: opportunity.observedAt,
    playbook: opportunity.playbook,
    side: opportunity.side,
    state: opportunity.state,
    opportunityScore: opportunity.opportunityScore,
    environmentFit: opportunity.environmentFit,
    playbookFit: opportunity.playbookFit,
    structureScore: opportunity.structure,
    timingScore: opportunity.timing,
    confirmationScore: opportunity.confirmation,
    riskReward: opportunity.riskReward,
    portfolioImpact: opportunity.portfolioImpact,
    riskMultiplier: opportunity.riskMultiplier,
    reasonsJson: JSON.stringify(opportunity.reasons),
    waitingJson: JSON.stringify(opportunity.waitingFor),
    rejectJson: JSON.stringify(opportunity.rejectReasons),
    payloadJson: JSON.stringify(opportunity),
    createdAt: now,
  })));
  return opportunities.length;
}

export async function listRecentV2Opportunities(limit = 80) {
  const rows = await getDb().select({
    payloadJson: v2Opportunities.payloadJson,
  }).from(v2Opportunities).orderBy(desc(v2Opportunities.observedAt)).limit(Math.max(1, Math.min(250, limit)));
  const seen = new Set<string>();
  const result: V2Opportunity[] = [];
  for (const row of rows) {
    const opportunity = parseJson<V2Opportunity | null>(row.payloadJson, null);
    if (!opportunity || seen.has(opportunity.symbol)) continue;
    seen.add(opportunity.symbol);
    result.push(opportunity);
  }
  return result;
}

export async function getV2Opportunity(symbol: string) {
  const [row] = await getDb().select({ payloadJson: v2Opportunities.payloadJson })
    .from(v2Opportunities)
    .where(eq(v2Opportunities.symbol, symbol))
    .orderBy(desc(v2Opportunities.observedAt))
    .limit(1);
  return row ? parseJson<V2Opportunity | null>(row.payloadJson, null) : null;
}

export async function listRecentV2Warnings(limit = 20) {
  const rows = await getDb().select({ payloadJson: v2WarningEvents.payloadJson })
    .from(v2WarningEvents)
    .orderBy(desc(v2WarningEvents.observedAt))
    .limit(Math.max(1, Math.min(100, limit)));
  return rows.map((row) => parseJson(row.payloadJson, null)).filter(Boolean);
}

export async function upsertV2TradeThesis(input: {
  tradeId: string;
  playbook: string;
  entryRegime: string;
  currentRegime: string;
  entryTransitionRisk: number;
  currentTransitionRisk: number;
  thesisHealth: number;
  entryThesis: unknown;
  currentThesis: unknown;
}) {
  await getDb().insert(v2TradeThesis).values({
    tradeId: input.tradeId,
    playbook: input.playbook,
    entryRegime: input.entryRegime,
    currentRegime: input.currentRegime,
    entryTransitionRisk: input.entryTransitionRisk,
    currentTransitionRisk: input.currentTransitionRisk,
    thesisHealth: input.thesisHealth,
    entryThesisJson: JSON.stringify(input.entryThesis),
    currentThesisJson: JSON.stringify(input.currentThesis),
    updatedAt: Date.now(),
  }).onConflictDoUpdate({
    target: v2TradeThesis.tradeId,
    set: {
      currentRegime: input.currentRegime,
      currentTransitionRisk: input.currentTransitionRisk,
      thesisHealth: input.thesisHealth,
      currentThesisJson: JSON.stringify(input.currentThesis),
      updatedAt: Date.now(),
    },
  });
}

export async function deleteV2ThesisForTrades(tradeIds: string[]) {
  if (!tradeIds.length) return;
  await getDb().delete(v2TradeThesis).where(inArray(v2TradeThesis.tradeId, tradeIds));
}
