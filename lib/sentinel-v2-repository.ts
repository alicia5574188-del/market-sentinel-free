import { getRuntimeD1 } from "../db";
import type { SentinelMarketContext, SentinelOpportunity, SentinelV2Evaluation } from "./sentinel-v2-engine.ts";

let schemaReady: Promise<void> | null = null;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = getRuntimeD1();
      await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS v2_market_snapshots (
          id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          regime TEXT NOT NULL,
          confidence INTEGER NOT NULL,
          stability INTEGER NOT NULL,
          transition_risk INTEGER NOT NULL,
          risk_velocity REAL NOT NULL,
          risk_acceleration REAL NOT NULL,
          permission TEXT NOT NULL,
          direction_bias TEXT NOT NULL,
          developing_regime TEXT,
          regime_margin REAL NOT NULL,
          context_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`),
        db.prepare("CREATE INDEX IF NOT EXISTS v2_market_snapshots_symbol_time_idx ON v2_market_snapshots(symbol, observed_at DESC)"),
        db.prepare(`CREATE TABLE IF NOT EXISTS v2_warning_events (
          id TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL,
          symbol TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          warning_type TEXT NOT NULL,
          status TEXT NOT NULL,
          severity REAL NOT NULL,
          confidence REAL NOT NULL,
          relevance REAL NOT NULL,
          warning_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`),
        db.prepare("CREATE INDEX IF NOT EXISTS v2_warning_events_symbol_time_idx ON v2_warning_events(symbol, observed_at DESC)"),
        db.prepare(`CREATE TABLE IF NOT EXISTS v2_opportunity_decisions (
          id TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL,
          symbol TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          playbook_id TEXT NOT NULL,
          decision_state TEXT NOT NULL,
          side TEXT NOT NULL,
          score REAL NOT NULL,
          confidence REAL NOT NULL,
          environment_fit REAL NOT NULL,
          structure_score REAL NOT NULL,
          timing_score REAL NOT NULL,
          confirmation_score REAL NOT NULL,
          risk_reward_score REAL NOT NULL,
          opportunity_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`),
        db.prepare("CREATE INDEX IF NOT EXISTS v2_opportunity_decisions_symbol_time_idx ON v2_opportunity_decisions(symbol, observed_at DESC)"),
      ]);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function snapshotId(context: SentinelMarketContext) {
  return `v2:${context.symbol}:${context.observedAt}`;
}

export async function saveSentinelV2Evaluation(evaluation: SentinelV2Evaluation) {
  await ensureSchema();
  const db = getRuntimeD1();
  const context = evaluation.context;
  const id = snapshotId(context);
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT OR REPLACE INTO v2_market_snapshots (
      id, symbol, observed_at, regime, confidence, stability, transition_risk,
      risk_velocity, risk_acceleration, permission, direction_bias, developing_regime,
      regime_margin, context_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id,
      context.symbol,
      context.observedAt,
      context.regime,
      context.confidence,
      context.stability,
      context.transitionRisk,
      context.riskVelocity,
      context.riskAcceleration,
      context.permission,
      context.directionBias,
      context.developingRegime,
      context.regimeMargin,
      JSON.stringify(context),
      now,
    ),
  ];
  for (const warning of context.warnings) {
    statements.push(db.prepare(`INSERT OR REPLACE INTO v2_warning_events (
      id, snapshot_id, symbol, observed_at, warning_type, status, severity, confidence,
      relevance, warning_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      `${id}:warning:${warning.id}`,
      id,
      context.symbol,
      context.observedAt,
      warning.type,
      warning.status,
      warning.severity,
      warning.confidence,
      warning.relevance,
      JSON.stringify(warning),
      now,
    ));
  }
  for (const opportunity of evaluation.opportunities) {
    statements.push(db.prepare(`INSERT OR REPLACE INTO v2_opportunity_decisions (
      id, snapshot_id, symbol, observed_at, playbook_id, decision_state, side, score,
      confidence, environment_fit, structure_score, timing_score, confirmation_score,
      risk_reward_score, opportunity_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      opportunity.id,
      id,
      opportunity.symbol,
      opportunity.observedAt,
      opportunity.playbookId,
      opportunity.state,
      opportunity.side,
      opportunity.score,
      opportunity.confidence,
      opportunity.environmentFit,
      opportunity.structureScore,
      opportunity.timingScore,
      opportunity.confirmationScore,
      opportunity.riskRewardScore,
      JSON.stringify(opportunity),
      now,
    ));
  }
  await db.batch(statements);
}

export async function getLatestSentinelV2Context(symbol: string): Promise<SentinelMarketContext | null> {
  await ensureSchema();
  const row = await getRuntimeD1().prepare(
    "SELECT context_json FROM v2_market_snapshots WHERE symbol = ? ORDER BY observed_at DESC LIMIT 1",
  ).bind(symbol).first<{ context_json: string }>();
  if (!row?.context_json) return null;
  try {
    return JSON.parse(row.context_json) as SentinelMarketContext;
  } catch {
    return null;
  }
}

export async function getSentinelV2Pulse(symbol = "BTC_USDT") {
  await ensureSchema();
  const db = getRuntimeD1();
  const [contextRow, warningsResult, opportunitiesResult] = await Promise.all([
    db.prepare("SELECT context_json FROM v2_market_snapshots WHERE symbol = ? ORDER BY observed_at DESC LIMIT 1").bind(symbol).first<{ context_json: string }>(),
    db.prepare("SELECT warning_json FROM v2_warning_events WHERE symbol = ? ORDER BY observed_at DESC, relevance * severity DESC LIMIT 5").bind(symbol).all<{ warning_json: string }>(),
    db.prepare("SELECT opportunity_json FROM v2_opportunity_decisions ORDER BY observed_at DESC, score DESC LIMIT 30").all<{ opportunity_json: string }>(),
  ]);
  const context = contextRow?.context_json ? JSON.parse(contextRow.context_json) as SentinelMarketContext : null;
  const warnings = warningsResult.results.flatMap((row) => {
    try { return [JSON.parse(row.warning_json)]; } catch { return []; }
  });
  const opportunities = opportunitiesResult.results.flatMap((row) => {
    try { return [JSON.parse(row.opportunity_json) as SentinelOpportunity]; } catch { return []; }
  });
  const latestByPlaybook = new Map<string, SentinelOpportunity>();
  for (const opportunity of opportunities) {
    const key = `${opportunity.symbol}:${opportunity.playbookId}`;
    if (!latestByPlaybook.has(key)) latestByPlaybook.set(key, opportunity);
  }
  const latest = [...latestByPlaybook.values()];
  return {
    observedAt: context?.observedAt ?? Date.now(),
    context,
    warnings,
    recommended: latest.filter((item) => item.state === "TRADE").sort((a, b) => b.score - a.score),
    watch: latest.filter((item) => item.state === "WATCH").sort((a, b) => b.score - a.score),
    rejected: latest.filter((item) => item.state === "REJECT").sort((a, b) => b.score - a.score),
  };
}
