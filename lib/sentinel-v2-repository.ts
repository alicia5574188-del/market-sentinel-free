import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { v2MarketSnapshots, v2Opportunities, v2TradeThesis, v2WarningEvents } from "../db/v2-schema.ts";
import type { V2MarketContext } from "./sentinel-v2-core.ts";
import type { Strategy2Opportunity } from "./sentinel-v2-strategy.ts";

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
  const [row] = await getDb()
    .select({ contextJson: v2MarketSnapshots.contextJson })
    .from(v2MarketSnapshots)
    .orderBy(desc(v2MarketSnapshots.observedAt))
    .limit(1);
  return row ? parseJson(row.contextJson, null) : null;
}

// v2_opportunities currently binds 20 values per row. Cloudflare D1/SQLite has a
// finite bind-parameter budget per statement, so Strategy 2.0's 12 playbooks must
// not be emitted as one large multi-row INSERT. Four rows = 80 binds and leaves
// comfortable headroom for driver/compiler changes while preserving all records.
const V2_OPPORTUNITY_BATCH_SIZE = 4;

export async function saveV2Opportunities(opportunities: Strategy2Opportunity[]) {
  if (!opportunities.length) return 0;
  const db = getDb();
  const now = Date.now();
  const rows = opportunities.map((opportunity) => ({
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
  }));

  for (let index = 0; index < rows.length; index += V2_OPPORTUNITY_BATCH_SIZE) {
    await db.insert(v2Opportunities).values(rows.slice(index, index + V2_OPPORTUNITY_BATCH_SIZE));
  }
  return opportunities.length;
}

function stateRank(state: string) {
  return state === "TRADE" ? 3 : state === "WATCH" ? 2 : state === "REJECT" ? 1 : 0;
}

export async function listRecentV2Opportunities(limit = 80) {
  const rows = await getDb()
    .select({ payloadJson: v2Opportunities.payloadJson })
    .from(v2Opportunities)
    .orderBy(desc(v2Opportunities.observedAt))
    .limit(Math.max(12, Math.min(500, limit * 12)));
  const grouped = new Map<string, Strategy2Opportunity>();
  for (const row of rows) {
    const opportunity = parseJson<Strategy2Opportunity | null>(row.payloadJson, null);
    if (!opportunity) continue;
    const current = grouped.get(opportunity.symbol);
    if (
      !current
      || opportunity.observedAt > current.observedAt
      || (
        opportunity.observedAt === current.observedAt
        && (
          stateRank(opportunity.state) > stateRank(current.state)
          || (
            stateRank(opportunity.state) === stateRank(current.state)
            && opportunity.opportunityScore > current.opportunityScore
          )
        )
      )
    ) {
      grouped.set(opportunity.symbol, opportunity);
    }
  }
  return [...grouped.values()]
    .sort((a, b) => stateRank(b.state) - stateRank(a.state) || b.opportunityScore - a.opportunityScore)
    .slice(0, limit);
}

export async function getV2StrategyPoolActivity(windowMs = 5 * 60_000) {
  const cutoff = Date.now() - Math.max(60_000, windowMs);
  const rows = await getDb()
    .select({ observedAt: v2Opportunities.observedAt, payloadJson: v2Opportunities.payloadJson })
    .from(v2Opportunities)
    .orderBy(desc(v2Opportunities.observedAt))
    .limit(720);
  const opportunities = rows
    .filter((row) => row.observedAt >= cutoff)
    .map((row) => parseJson<Strategy2Opportunity | null>(row.payloadJson, null))
    .filter((row): row is Strategy2Opportunity => Boolean(row));
  const playbooks = [...new Set(opportunities.map((item) => item.playbook))]
    .sort((a, b) => Number(a.match(/^P(\d+)/)?.[1] ?? 99) - Number(b.match(/^P(\d+)/)?.[1] ?? 99));
  const symbols = [...new Set(opportunities.map((item) => item.symbol))];
  return {
    windowMinutes: Math.max(1, Math.round(windowMs / 60_000)),
    evaluations: opportunities.length,
    symbols: symbols.length,
    playbookCount: playbooks.length,
    playbooks,
    states: {
      trade: opportunities.filter((item) => item.state === "TRADE").length,
      watch: opportunities.filter((item) => item.state === "WATCH").length,
      reject: opportunities.filter((item) => item.state === "REJECT").length,
    },
  };
}

export async function getV2Opportunity(symbol: string) {
  const rows = await getDb()
    .select({ payloadJson: v2Opportunities.payloadJson })
    .from(v2Opportunities)
    .where(eq(v2Opportunities.symbol, symbol))
    .orderBy(desc(v2Opportunities.observedAt))
    .limit(24);
  const opportunities = rows
    .map((row) => parseJson<Strategy2Opportunity | null>(row.payloadJson, null))
    .filter((row): row is Strategy2Opportunity => Boolean(row));
  if (!opportunities.length) return null;
  const observedAt = opportunities[0].observedAt;
  return opportunities
    .filter((opportunity) => opportunity.observedAt === observedAt)
    .sort((a, b) => stateRank(b.state) - stateRank(a.state) || b.opportunityScore - a.opportunityScore)[0] ?? null;
}

export async function listRecentV2Warnings(limit = 20) {
  const rows = await getDb()
    .select({ payloadJson: v2WarningEvents.payloadJson })
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

export async function listV2TradeTheses(limit = 50) {
  const rows = await getDb()
    .select()
    .from(v2TradeThesis)
    .orderBy(desc(v2TradeThesis.updatedAt))
    .limit(Math.max(1, Math.min(200, limit)));
  return rows.map((row) => ({
    tradeId: row.tradeId,
    playbook: row.playbook,
    entryRegime: row.entryRegime,
    currentRegime: row.currentRegime,
    entryTransitionRisk: row.entryTransitionRisk,
    currentTransitionRisk: row.currentTransitionRisk,
    thesisHealth: row.thesisHealth,
    entryThesis: parseJson(row.entryThesisJson, {}),
    currentThesis: parseJson(row.currentThesisJson, {}),
    updatedAt: row.updatedAt,
  }));
}

export async function deleteV2ThesisForTrades(tradeIds: string[]) {
  if (!tradeIds.length) return;
  await getDb().delete(v2TradeThesis).where(inArray(v2TradeThesis.tradeId, tradeIds));
}
