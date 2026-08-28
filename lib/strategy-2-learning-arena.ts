import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { tradeCases } from "../db/schema";
import { ADAPTIVE_LEARNING_FORWARD_EPOCH_MS } from "./strategy-2-adaptive-learning.ts";
import { calculateStrategyStatistics } from "./strategy-promotion.ts";

export type Strategy2ArenaTradeRow = {
  id: string;
  entryAt: number | null;
  exitAt: number | null;
  regime: string | null;
  side: string;
  netMovePct: number | null;
  plannedRiskPct: number | null;
  netPnlUsdt: number | null;
  exitCode: string | null;
  target1HitAt: number | null;
  mfePct: number | null;
  maePct: number | null;
};

export type Strategy2ArenaRollup = {
  label: "20" | "50" | "100" | "ALL" | "FORWARD" | "PRE_FORWARD";
  sampleCount: number;
  expectancyR: number | null;
  winRate: number | null;
  profitFactorR: number | null;
  cumulativeR: number;
  cumulativePnlUsdt: number;
  maxDrawdownR: number;
  maxLossStreak: number;
  t1HitRate: number | null;
};

export type Strategy2ArenaExitProfile = {
  code: string;
  label: string;
  recentCount: number;
  previousCount: number;
  recentRate: number;
  previousRate: number;
  deltaPctPoints: number;
};

export type Strategy2ArenaPlaybook = {
  playbook: string;
  sampleCount: number;
  expectancyR: number | null;
  recentExpectancyR: number | null;
  winRate: number | null;
  cumulativeR: number;
  state: "positive" | "negative" | "watch" | "collecting";
};

export type Strategy2ArenaCell = {
  key: string;
  globalRegime: string;
  playbook: string;
  side: "LONG" | "SHORT";
  sampleCount: number;
  expectancyR: number | null;
  winRate: number | null;
  cumulativeR: number;
};

export type Strategy2LearningArena = {
  version: "learning-arena-v1";
  generatedAt: number;
  source: "closed_contract_v2";
  readOnly: true;
  champion: {
    name: "Sentinel Strategy 2.0";
    all: Strategy2ArenaRollup;
    last20: Strategy2ArenaRollup;
    last50: Strategy2ArenaRollup;
    last100: Strategy2ArenaRollup;
    forward: Strategy2ArenaRollup;
    preForward: Strategy2ArenaRollup;
    governorState: "NORMAL" | "DEFENSIVE";
    governorReason: string;
  };
  trend: {
    state: "IMPROVING" | "FLAT" | "DEGRADING" | "COLLECTING";
    recent20ExpectancyR: number | null;
    previous20ExpectancyR: number | null;
    expectancyDeltaR: number | null;
    recent20ProfitFactor: number | null;
    previous20ProfitFactor: number | null;
  };
  forwardEvidence: {
    sampleCount: number;
    preForwardSampleCount: number;
    forwardExpectancyR: number | null;
    preForwardExpectancyR: number | null;
    periodDeltaR: number | null;
    interpretation: "period_shift_only";
    note: string;
  };
  learningProof: {
    status: "COLLECTING";
    learningAlphaR: null;
    frozenBaseline: "NOT_RECORDED";
    challenger: "NOT_ACTIVE";
    note: string;
  };
  exits: Strategy2ArenaExitProfile[];
  playbooks: Strategy2ArenaPlaybook[];
  heatmap: Strategy2ArenaCell[];
  safety: {
    changesTradingLogic: false;
    changesRisk: false;
    changesExecution: false;
    note: string;
  };
};

type ParsedArenaRow = Strategy2ArenaTradeRow & {
  playbook: string;
  globalRegime: string;
  side: "LONG" | "SHORT";
  resultR: number;
};

const EXIT_LABELS: Record<string, string> = {
  take_profit: "止盈",
  stop_loss: "止损",
  breakeven: "保本",
  structure_reversal: "结构反转",
  flow_reversal: "资金流反转",
  macro_risk: "宏观风险",
  timeout: "超时退出",
  unknown: "其他退出",
};

function parseRegime(value: string | null | undefined) {
  if (!value?.startsWith("S2|")) return null;
  const parts = value.split("|");
  const playbook = parts[1];
  const globalRegime = parts.find((part) => part.startsWith("global:"))?.slice(7) ?? "unknown";
  if (!playbook) return null;
  return { playbook, globalRegime };
}

function parseRows(rows: Strategy2ArenaTradeRow[]) {
  return rows.flatMap((row): ParsedArenaRow[] => {
    const parsed = parseRegime(row.regime);
    if (!parsed || row.netMovePct == null || (row.side !== "LONG" && row.side !== "SHORT")) return [];
    const riskPct = Math.max(Math.abs(row.plannedRiskPct ?? 0), 0.05);
    return [{ ...row, ...parsed, side: row.side, resultR: row.netMovePct / riskPct }];
  }).sort((a, b) => (a.exitAt ?? 0) - (b.exitAt ?? 0));
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function profitFactor(values: number[]) {
  const gain = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const loss = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  if (loss === 0) return gain > 0 ? null : 0;
  return gain / loss;
}

function additiveDrawdown(values: number[]) {
  let equity = 0;
  let peak = 0;
  let worst = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    worst = Math.max(worst, peak - equity);
  }
  return worst;
}

function lossStreak(values: number[]) {
  let current = 0;
  let worst = 0;
  for (const value of values) {
    if (value < 0) {
      current += 1;
      worst = Math.max(worst, current);
    } else {
      current = 0;
    }
  }
  return worst;
}

function rollup(label: Strategy2ArenaRollup["label"], rows: ParsedArenaRow[]): Strategy2ArenaRollup {
  const values = rows.map((row) => row.resultR);
  return {
    label,
    sampleCount: rows.length,
    expectancyR: average(values),
    winRate: rows.length ? rows.filter((row) => row.resultR > 0).length / rows.length : null,
    profitFactorR: profitFactor(values),
    cumulativeR: values.reduce((sum, value) => sum + value, 0),
    cumulativePnlUsdt: rows.reduce((sum, row) => sum + (row.netPnlUsdt ?? 0), 0),
    maxDrawdownR: additiveDrawdown(values),
    maxLossStreak: lossStreak(values),
    t1HitRate: rows.length ? rows.filter((row) => row.target1HitAt != null).length / rows.length : null,
  };
}

function latest(rows: ParsedArenaRow[], count: number) {
  return rows.slice(Math.max(0, rows.length - count));
}

function previous(rows: ParsedArenaRow[], count: number) {
  return rows.slice(Math.max(0, rows.length - count * 2), Math.max(0, rows.length - count));
}

function trend(rows: ParsedArenaRow[]): Strategy2LearningArena["trend"] {
  const recentRows = latest(rows, 20);
  const previousRows = previous(rows, 20);
  if (recentRows.length < 10 || previousRows.length < 10) {
    return {
      state: "COLLECTING",
      recent20ExpectancyR: average(recentRows.map((row) => row.resultR)),
      previous20ExpectancyR: average(previousRows.map((row) => row.resultR)),
      expectancyDeltaR: null,
      recent20ProfitFactor: profitFactor(recentRows.map((row) => row.resultR)),
      previous20ProfitFactor: profitFactor(previousRows.map((row) => row.resultR)),
    };
  }
  const recentExpectancy = average(recentRows.map((row) => row.resultR));
  const previousExpectancy = average(previousRows.map((row) => row.resultR));
  const delta = recentExpectancy != null && previousExpectancy != null ? recentExpectancy - previousExpectancy : null;
  return {
    state: delta == null ? "COLLECTING" : delta > 0.08 ? "IMPROVING" : delta < -0.08 ? "DEGRADING" : "FLAT",
    recent20ExpectancyR: recentExpectancy,
    previous20ExpectancyR: previousExpectancy,
    expectancyDeltaR: delta,
    recent20ProfitFactor: profitFactor(recentRows.map((row) => row.resultR)),
    previous20ProfitFactor: profitFactor(previousRows.map((row) => row.resultR)),
  };
}

function exitProfiles(rows: ParsedArenaRow[]): Strategy2ArenaExitProfile[] {
  const recentRows = latest(rows, 50);
  const previousRows = previous(rows, 50);
  const codes = [...new Set([...recentRows, ...previousRows].map((row) => row.exitCode ?? "unknown"))];
  return codes.map((code) => {
    const recentCount = recentRows.filter((row) => (row.exitCode ?? "unknown") === code).length;
    const previousCount = previousRows.filter((row) => (row.exitCode ?? "unknown") === code).length;
    const recentRate = recentRows.length ? recentCount / recentRows.length : 0;
    const previousRate = previousRows.length ? previousCount / previousRows.length : 0;
    return {
      code,
      label: EXIT_LABELS[code] ?? code,
      recentCount,
      previousCount,
      recentRate,
      previousRate,
      deltaPctPoints: (recentRate - previousRate) * 100,
    };
  }).sort((a, b) => Math.abs(b.deltaPctPoints) - Math.abs(a.deltaPctPoints) || b.recentCount - a.recentCount);
}

function playbookScoreboard(rows: ParsedArenaRow[]): Strategy2ArenaPlaybook[] {
  const groups = new Map<string, ParsedArenaRow[]>();
  for (const row of rows) {
    const bucket = groups.get(row.playbook) ?? [];
    bucket.push(row);
    groups.set(row.playbook, bucket);
  }
  return [...groups.entries()].map(([playbook, bucket]) => {
    const recent = latest(bucket, 20);
    const expectancyR = average(bucket.map((row) => row.resultR));
    const recentExpectancyR = average(recent.map((row) => row.resultR));
    const sampleCount = bucket.length;
    const state = sampleCount < 5
      ? "collecting" as const
      : (expectancyR ?? 0) > 0.08 && (recentExpectancyR ?? 0) >= 0
        ? "positive" as const
        : (expectancyR ?? 0) < -0.08 || (recentExpectancyR ?? 0) < -0.15
          ? "negative" as const
          : "watch" as const;
    return {
      playbook,
      sampleCount,
      expectancyR,
      recentExpectancyR,
      winRate: sampleCount ? bucket.filter((row) => row.resultR > 0).length / sampleCount : null,
      cumulativeR: bucket.reduce((sum, row) => sum + row.resultR, 0),
      state,
    };
  }).sort((a, b) => {
    const priority = (state: Strategy2ArenaPlaybook["state"]) => state === "negative" ? 4 : state === "positive" ? 3 : state === "watch" ? 2 : 1;
    return priority(b.state) - priority(a.state) || b.sampleCount - a.sampleCount;
  });
}

function heatmap(rows: ParsedArenaRow[]): Strategy2ArenaCell[] {
  const groups = new Map<string, ParsedArenaRow[]>();
  for (const row of rows) {
    const key = `${row.globalRegime}|${row.playbook}|${row.side}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return [...groups.entries()].map(([key, bucket]) => ({
    key,
    globalRegime: bucket[0].globalRegime,
    playbook: bucket[0].playbook,
    side: bucket[0].side,
    sampleCount: bucket.length,
    expectancyR: average(bucket.map((row) => row.resultR)),
    winRate: bucket.length ? bucket.filter((row) => row.resultR > 0).length / bucket.length : null,
    cumulativeR: bucket.reduce((sum, row) => sum + row.resultR, 0),
  })).sort((a, b) => b.sampleCount - a.sampleCount || Math.abs(b.expectancyR ?? 0) - Math.abs(a.expectancyR ?? 0)).slice(0, 24);
}

export function buildStrategy2LearningArena(rows: Strategy2ArenaTradeRow[], generatedAt = Date.now()): Strategy2LearningArena {
  const parsed = parseRows(rows);
  const forwardRows = parsed.filter((row) => (row.exitAt ?? 0) >= ADAPTIVE_LEARNING_FORWARD_EPOCH_MS);
  const preForwardRows = parsed.filter((row) => (row.exitAt ?? 0) < ADAPTIVE_LEARNING_FORWARD_EPOCH_MS);
  const all = rollup("ALL", parsed);
  const last20 = rollup("20", latest(parsed, 20));
  const last50 = rollup("50", latest(parsed, 50));
  const last100 = rollup("100", latest(parsed, 100));
  const forward = rollup("FORWARD", forwardRows);
  const preForward = rollup("PRE_FORWARD", preForwardRows);
  const periodDeltaR = forward.expectancyR != null && preForward.expectancyR != null
    ? forward.expectancyR - preForward.expectancyR
    : null;

  const stats = calculateStrategyStatistics(parsed.map((row) => ({
    netMovePct: row.netMovePct,
    exitAt: row.exitAt,
    regime: row.regime ?? "unknown",
  })));
  const overallWeak = stats.sampleCount >= 40
    && (stats.averageNetPct ?? 0) < -0.02
    && (stats.profitFactor ?? 0) < 0.95;
  const recentWeak = stats.recentSampleCount >= 20
    && (stats.recentAverageNetPct ?? 0) < 0
    && (stats.recentProfitFactor ?? 0) < 1;
  const defensive = overallWeak || recentWeak;

  return {
    version: "learning-arena-v1",
    generatedAt,
    source: "closed_contract_v2",
    readOnly: true,
    champion: {
      name: "Sentinel Strategy 2.0",
      all,
      last20,
      last50,
      last100,
      forward,
      preForward,
      governorState: defensive ? "DEFENSIVE" : "NORMAL",
      governorReason: defensive
        ? "当前整体或最近窗口仍为负优势，执行层应保持防守，只让已验证高置信单元承担新增风险。"
        : "当前未触发整体负优势防守条件；是否实际开仓仍由 Strategy 2.0 与硬风控共同决定。",
    },
    trend: trend(parsed),
    forwardEvidence: {
      sampleCount: forward.sampleCount,
      preForwardSampleCount: preForward.sampleCount,
      forwardExpectancyR: forward.expectancyR,
      preForwardExpectancyR: preForward.expectancyR,
      periodDeltaR,
      interpretation: "period_shift_only",
      note: "这是学习启用前后两个时期的变化，不是同一市场的因果对照，因此不能冒充 Learning Alpha。",
    },
    learningProof: {
      status: "COLLECTING",
      learningAlphaR: null,
      frozenBaseline: "NOT_RECORDED",
      challenger: "NOT_ACTIVE",
      note: "真正的 Learning Alpha 需要 Champion、冻结基准与 Challenger 在同一市场同时做影子决策并保存后续结果。当前系统先展示可验证的前向 Edge，绝不用时期差异伪造 Alpha。",
    },
    exits: exitProfiles(parsed),
    playbooks: playbookScoreboard(parsed),
    heatmap: heatmap(parsed),
    safety: {
      changesTradingLogic: false,
      changesRisk: false,
      changesExecution: false,
      note: "Learning Arena 只读取已经完成的 contract_v2 结果，不参与开仓、仓位、风控或 Execution Engine。",
    },
  };
}

export async function getStrategy2LearningArena(limit = 1000) {
  const rows = await getDb().select({
    id: tradeCases.id,
    entryAt: tradeCases.entryAt,
    exitAt: tradeCases.exitAt,
    regime: tradeCases.regime,
    side: tradeCases.side,
    netMovePct: tradeCases.netMovePct,
    plannedRiskPct: tradeCases.plannedRiskPct,
    netPnlUsdt: tradeCases.netPnlUsdt,
    exitCode: tradeCases.exitCode,
    target1HitAt: tradeCases.target1HitAt,
    mfePct: tradeCases.mfePct,
    maePct: tradeCases.maePct,
  }).from(tradeCases).where(and(
    eq(tradeCases.status, "closed"),
    eq(tradeCases.simulationModel, "contract_v2"),
  )).orderBy(desc(tradeCases.exitAt)).limit(Math.max(100, Math.min(2500, limit)));

  return buildStrategy2LearningArena(rows);
}
