import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { tradeCases } from "../db/schema";
import {
  ADAPTIVE_LEARNING_FORWARD_EPOCH_MS,
  makeAdaptivePrior,
  summarizeAdaptiveLearning,
  type AdaptiveLearningObservation,
  type AdaptiveLearningStats,
} from "./strategy-2-adaptive-learning.ts";
import {
  STRATEGY2_BEIJING_SESSION_ORDER,
  strategy2BeijingSession,
  strategy2BeijingSessionLabel,
  type Strategy2BeijingSession,
} from "./strategy-2-session.ts";
import {
  strategy2ExperienceKey,
  type Strategy2Experience,
  type Strategy2ExperienceBook,
} from "./sentinel-v2-strategy.ts";

export type Strategy2LearningStage = "exploration" | "calibrating" | "validated" | "negative_edge" | "degrading";

export type Strategy2LearningCell = Strategy2Experience & {
  key: string;
  playbook: string;
  globalRegime: string;
  assetRegime: string;
  side: "LONG" | "SHORT";
  stage: Strategy2LearningStage;
  riskAction: string;
};

export type Strategy2LearningTrade = {
  tradeId: string;
  exitAt: number | null;
  playbook: string;
  globalRegime: string;
  assetRegime: string;
  session: Strategy2BeijingSession;
  side: "LONG" | "SHORT";
  netPct: number;
  resultR: number;
  cellSamples: number;
  cellExpectancyR: number | null;
  cellRecentExpectancyR: number | null;
  t1Hit: boolean;
  stage: Strategy2LearningStage;
  riskAction: string;
};

export type Strategy2SessionProfile = {
  session: Strategy2BeijingSession;
  label: string;
  sampleCount: number;
  winRate: number | null;
  expectancyR: number | null;
  recentExpectancyR: number | null;
  t1HitRate: number | null;
  directionFailureRate: number | null;
  inverseT1PotentialRate: number | null;
  edgeState: Strategy2Experience["edgeState"];
  edgeConfidence: number;
};

export type Strategy2LearningDashboard = {
  totalSamples: number;
  playbookCoverage: number;
  exactCellCount: number;
  positiveCells: number;
  negativeCells: number;
  degradingCells: number;
  forwardSamples: number;
  activeSession: Strategy2BeijingSession;
  activeSessionLabel: string;
  activeSessionSamples: number;
  sessionProfiles: Strategy2SessionProfile[];
  cells: Strategy2LearningCell[];
  recentTrades: Strategy2LearningTrade[];
};

function parseStrategy2Regime(value: string | null | undefined) {
  if (!value?.startsWith("S2|")) return null;
  const parts = value.split("|");
  if (parts.length < 4) return null;
  const playbook = parts[1];
  const globalRegime = parts.find((part) => part.startsWith("global:"))?.slice(7) ?? "unknown";
  const assetRegime = parts.find((part) => part.startsWith("asset:"))?.slice(6) ?? "unknown";
  return { playbook, globalRegime, assetRegime };
}

type ClosedStrategy2Row = {
  id: string;
  entryAt: number | null;
  exitAt: number | null;
  regime: string | null;
  side: string;
  netMovePct: number | null;
  plannedRiskPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  target1HitAt: number | null;
};

type ParsedRow = {
  row: ClosedStrategy2Row;
  playbook: string;
  globalRegime: string;
  assetRegime: string;
  session: Strategy2BeijingSession;
  side: "LONG" | "SHORT";
  observation: AdaptiveLearningObservation;
  resultR: number;
};

async function loadClosedStrategy2Rows(limit: number): Promise<ClosedStrategy2Row[]> {
  return getDb().select({
    id: tradeCases.id,
    entryAt: tradeCases.entryAt,
    exitAt: tradeCases.exitAt,
    regime: tradeCases.regime,
    side: tradeCases.side,
    netMovePct: tradeCases.netMovePct,
    plannedRiskPct: tradeCases.plannedRiskPct,
    mfePct: tradeCases.mfePct,
    maePct: tradeCases.maePct,
    target1HitAt: tradeCases.target1HitAt,
  }).from(tradeCases).where(and(
    eq(tradeCases.status, "closed"),
    eq(tradeCases.simulationModel, "contract_v2"),
  )).orderBy(desc(tradeCases.exitAt)).limit(Math.max(100, Math.min(5000, limit)));
}

function toParsedRows(rows: ClosedStrategy2Row[]) {
  const parsedRows: ParsedRow[] = [];
  for (const row of rows) {
    const parsed = parseStrategy2Regime(row.regime);
    if (!parsed || (row.side !== "LONG" && row.side !== "SHORT") || row.netMovePct == null) continue;
    const plannedRiskPct = Math.max(Math.abs(row.plannedRiskPct ?? 0), 0.05);
    const observation: AdaptiveLearningObservation = {
      exitAt: row.exitAt,
      netPct: row.netMovePct,
      plannedRiskPct,
      mfePct: row.mfePct,
      maePct: row.maePct,
      target1Hit: row.target1HitAt != null,
    };
    parsedRows.push({
      row,
      ...parsed,
      session: strategy2BeijingSession(row.entryAt ?? row.exitAt),
      side: row.side,
      observation,
      resultR: row.netMovePct / plannedRiskPct,
    });
  }
  return parsedRows;
}

function groupObservations(parsedRows: ParsedRow[], keyOf: (row: ParsedRow) => string) {
  const grouped = new Map<string, AdaptiveLearningObservation[]>();
  for (const row of parsedRows) {
    const key = keyOf(row);
    const observations = grouped.get(key) ?? [];
    observations.push(row.observation);
    grouped.set(key, observations);
  }
  return grouped;
}

function experienceFromStats(stats: AdaptiveLearningStats): Strategy2Experience {
  return {
    sampleCount: stats.sampleCount,
    wins: stats.wins,
    losses: stats.losses,
    winRate: stats.winRate,
    expectancyR: stats.posteriorExpectancyR,
    averageNetPct: stats.averageNetPct,
    rawExpectancyR: stats.rawExpectancyR,
    recencyExpectancyR: stats.recencyExpectancyR,
    recentExpectancyR: stats.recentExpectancyR,
    posteriorExpectancyR: stats.posteriorExpectancyR,
    effectiveSampleCount: stats.effectiveSampleCount,
    averageMfeR: stats.averageMfeR,
    averageMaeR: stats.averageMaeR,
    t1HitRate: stats.t1HitRate,
    directionFailureRate: stats.directionFailureRate,
    inverseT1PotentialRate: stats.inverseT1PotentialRate,
    edgeLowerBoundR: stats.edgeLowerBoundR,
    edgeUpperBoundR: stats.edgeUpperBoundR,
    edgeConfidence: stats.edgeConfidence,
    driftR: stats.driftR,
    edgeState: stats.edgeState,
    forwardSampleCount: stats.forwardSampleCount,
    forwardExpectancyR: stats.forwardExpectancyR,
    forwardInverseT1PotentialRate: stats.forwardInverseT1PotentialRate,
  };
}

function buildAdaptiveStats(parsedRows: ParsedRow[], activeSession: Strategy2BeijingSession) {
  const broadGroups = groupObservations(parsedRows, (row) => strategy2ExperienceKey(row.playbook, "*", "*", row.side));
  const assetGroups = groupObservations(parsedRows, (row) => strategy2ExperienceKey(row.playbook, "*", row.assetRegime, row.side));
  const exactGroups = groupObservations(parsedRows, (row) => strategy2ExperienceKey(row.playbook, row.globalRegime, row.assetRegime, row.side));

  const broad = new Map<string, AdaptiveLearningStats>();
  for (const [key, observations] of broadGroups) broad.set(key, summarizeAdaptiveLearning(observations));

  const asset = new Map<string, AdaptiveLearningStats>();
  for (const [key, observations] of assetGroups) {
    const [playbook, , , sidePart] = key.split("|");
    const side = sidePart.replace("side:", "") as "LONG" | "SHORT";
    const broadKey = strategy2ExperienceKey(playbook, "*", "*", side);
    asset.set(key, summarizeAdaptiveLearning(observations, makeAdaptivePrior(broad.get(broadKey), 6)));
  }

  const exact = new Map<string, AdaptiveLearningStats>();
  for (const [key, observations] of exactGroups) {
    const [playbook, , assetPart, sidePart] = key.split("|");
    const assetRegime = assetPart.replace("asset:", "");
    const side = sidePart.replace("side:", "") as "LONG" | "SHORT";
    const assetKey = strategy2ExperienceKey(playbook, "*", assetRegime, side);
    exact.set(key, summarizeAdaptiveLearning(observations, makeAdaptivePrior(asset.get(assetKey), 8)));
  }

  const activeRows = parsedRows.filter((row) => row.session === activeSession);
  const sessionBroadGroups = groupObservations(activeRows, (row) => strategy2ExperienceKey(row.playbook, "*", "*", row.side));
  const sessionAssetGroups = groupObservations(activeRows, (row) => strategy2ExperienceKey(row.playbook, "*", row.assetRegime, row.side));
  const sessionExactGroups = groupObservations(activeRows, (row) => strategy2ExperienceKey(row.playbook, row.globalRegime, row.assetRegime, row.side));

  const sessionBroad = new Map<string, AdaptiveLearningStats>();
  for (const [key, observations] of sessionBroadGroups) {
    sessionBroad.set(key, summarizeAdaptiveLearning(observations, makeAdaptivePrior(broad.get(key), 8)));
  }

  const sessionAsset = new Map<string, AdaptiveLearningStats>();
  for (const [key, observations] of sessionAssetGroups) {
    sessionAsset.set(key, summarizeAdaptiveLearning(observations, makeAdaptivePrior(asset.get(key), 9)));
  }

  const sessionExact = new Map<string, AdaptiveLearningStats>();
  for (const [key, observations] of sessionExactGroups) {
    sessionExact.set(key, summarizeAdaptiveLearning(observations, makeAdaptivePrior(exact.get(key), 10)));
  }

  return { broad, asset, exact, sessionBroad, sessionAsset, sessionExact, activeRows };
}

function learningStage(stats: AdaptiveLearningStats): Strategy2LearningStage {
  if (stats.edgeState === "negative") return "negative_edge";
  if (stats.edgeState === "degrading") return "degrading";
  if (stats.sampleCount < 5) return "exploration";
  if (stats.edgeState === "positive") return "validated";
  return "calibrating";
}

function pct(value: number | null) {
  return value == null ? "--" : `${Math.round(value * 100)}%`;
}

function riskAction(stats: AdaptiveLearningStats, stage: Strategy2LearningStage) {
  if (stage === "negative_edge") return `停止该环境组合；后验 ${stats.posteriorExpectancyR?.toFixed(2) ?? "--"}R，方向失败 ${pct(stats.directionFailureRate)}`;
  if (stage === "degrading") return `近期优势衰退，强制降风险；近窗 ${stats.recentExpectancyR?.toFixed(2) ?? "--"}R，漂移 ${stats.driftR?.toFixed(2) ?? "--"}R`;
  if (stage === "exploration") return "小风险探索；继承上层 Playbook/Asset 先验，并叠加 Session 条件，不再从零学习";
  if (stage === "validated") return `正优势通过收缩与近期验证；T1 ${pct(stats.t1HitRate)}，置信 ${stats.edgeConfidence}%`;
  if ((stats.directionFailureRate ?? 0) >= 0.5) return `方向失败偏高，继续降权；T1 ${pct(stats.t1HitRate)} / 反向T1潜力 ${pct(stats.inverseT1PotentialRate)}`;
  if ((stats.posteriorExpectancyR ?? 0) < -0.08) return "层级后验仍偏负，降低风险并等待新证据";
  return "继续校准；长期、近期、时段与路径质量共同决定后续风险";
}

function sessionProfiles(parsedRows: ParsedRow[]): Strategy2SessionProfile[] {
  const overall = summarizeAdaptiveLearning(parsedRows.map((row) => row.observation));
  return STRATEGY2_BEIJING_SESSION_ORDER.map((session) => {
    const observations = parsedRows.filter((row) => row.session === session).map((row) => row.observation);
    const stats = summarizeAdaptiveLearning(observations, makeAdaptivePrior(overall, 8));
    return {
      session,
      label: strategy2BeijingSessionLabel(session),
      sampleCount: observations.length,
      winRate: stats.winRate,
      expectancyR: stats.posteriorExpectancyR,
      recentExpectancyR: stats.recentExpectancyR,
      t1HitRate: stats.t1HitRate,
      directionFailureRate: stats.directionFailureRate,
      inverseT1PotentialRate: stats.inverseT1PotentialRate,
      edgeState: stats.edgeState,
      edgeConfidence: stats.edgeConfidence,
    };
  });
}

/**
 * Adaptive experience book used by every Strategy 2.0 scan.
 * Exact Regime × Playbook × Asset-Regime × Direction remains the long-run
 * public learning contract. The active Beijing-time Session then conditions
 * that exact posterior through hierarchical partial pooling. Session evidence
 * is never a global on/off clock: only the affected strategy combinations are
 * reduced or rejected, so Strategy 2.0 can keep running 24 hours.
 */
export async function getStrategy2ExperienceBook(limit = 2500): Promise<Strategy2ExperienceBook> {
  const parsedRows = toParsedRows(await loadClosedStrategy2Rows(limit));
  const activeSession = strategy2BeijingSession(Date.now());
  const levels = buildAdaptiveStats(parsedRows, activeSession);
  const entries: [string, Strategy2Experience][] = [];

  // Preserve the complete long-run hierarchy as the fallback. Session evidence
  // overlays it only where this Beijing-time bucket has observations.
  for (const [key, stats] of levels.broad) entries.push([key, experienceFromStats(stats)]);
  for (const [key, stats] of levels.asset) entries.push([key, experienceFromStats(stats)]);
  for (const [key, stats] of levels.exact) entries.push([key, experienceFromStats(stats)]);

  for (const [key, stats] of levels.sessionBroad) entries.push([key, experienceFromStats(stats)]);
  for (const [key, stats] of levels.sessionAsset) entries.push([key, experienceFromStats(stats)]);
  for (const [key, stats] of levels.sessionExact) {
    const globalStats = levels.exact.get(key);
    // A globally proven-negative exact cell remains blocked in every session
    // until this session itself establishes a confidence-bounded positive edge.
    if (globalStats?.edgeState === "negative" && stats.edgeState !== "positive") continue;
    entries.push([key, experienceFromStats(stats)]);
  }

  return Object.fromEntries(entries);
}

/** User-facing all-time exact cells plus explicit time-of-day diagnostics. */
export async function getStrategy2LearningDashboard(limit = 2500): Promise<Strategy2LearningDashboard> {
  const parsedRows = toParsedRows(await loadClosedStrategy2Rows(limit));
  const activeSession = strategy2BeijingSession(Date.now());
  const levels = buildAdaptiveStats(parsedRows, activeSession);
  const metadata = new Map<string, { playbook: string; globalRegime: string; assetRegime: string; side: "LONG" | "SHORT" }>();
  for (const row of parsedRows) {
    metadata.set(strategy2ExperienceKey(row.playbook, row.globalRegime, row.assetRegime, row.side), {
      playbook: row.playbook,
      globalRegime: row.globalRegime,
      assetRegime: row.assetRegime,
      side: row.side,
    });
  }

  const cells = [...levels.exact.entries()].map(([key, stats]) => {
    const meta = metadata.get(key)!;
    const stage = learningStage(stats);
    return {
      key,
      ...meta,
      ...experienceFromStats(stats),
      stage,
      riskAction: riskAction(stats, stage),
    } satisfies Strategy2LearningCell;
  }).sort((a, b) => {
    const priority = (value: Strategy2LearningCell) => value.stage === "negative_edge" ? 4 : value.stage === "degrading" ? 3 : value.stage === "validated" ? 2 : 1;
    return priority(b) - priority(a) || b.sampleCount - a.sampleCount || (b.expectancyR ?? -99) - (a.expectancyR ?? -99);
  });

  const cellByKey = new Map(cells.map((cell) => [cell.key, cell]));
  const recentTrades = parsedRows.slice(0, 12).map((item) => {
    const key = strategy2ExperienceKey(item.playbook, item.globalRegime, item.assetRegime, item.side);
    const cell = cellByKey.get(key)!;
    return {
      tradeId: item.row.id,
      exitAt: item.row.exitAt,
      playbook: item.playbook,
      globalRegime: item.globalRegime,
      assetRegime: item.assetRegime,
      session: item.session,
      side: item.side,
      netPct: item.observation.netPct,
      resultR: item.resultR,
      cellSamples: cell.sampleCount,
      cellExpectancyR: cell.expectancyR,
      cellRecentExpectancyR: cell.recentExpectancyR ?? null,
      t1Hit: item.observation.target1Hit,
      stage: cell.stage,
      riskAction: cell.riskAction,
    } satisfies Strategy2LearningTrade;
  });

  return {
    totalSamples: parsedRows.length,
    playbookCoverage: new Set(parsedRows.map((item) => item.playbook)).size,
    exactCellCount: cells.length,
    positiveCells: cells.filter((cell) => cell.stage === "validated").length,
    negativeCells: cells.filter((cell) => cell.stage === "negative_edge").length,
    degradingCells: cells.filter((cell) => cell.stage === "degrading").length,
    forwardSamples: parsedRows.filter((item) => (item.row.exitAt ?? 0) >= ADAPTIVE_LEARNING_FORWARD_EPOCH_MS).length,
    activeSession,
    activeSessionLabel: strategy2BeijingSessionLabel(activeSession),
    activeSessionSamples: levels.activeRows.length,
    sessionProfiles: sessionProfiles(parsedRows),
    cells: cells.slice(0, 24),
    recentTrades,
  };
}
