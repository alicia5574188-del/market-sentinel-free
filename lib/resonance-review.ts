import { asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { hte31TradeCharts, hte31Trades } from "../db/hte31-schema";
import { buildHte31Counterfactual } from "./hte31-counterfactual.ts";
import { getSettings } from "./settings-repository.ts";
import type { Hte31Candle } from "./hte31-types.ts";

export type ResonanceReviewIssue = "direction" | "entry" | "exit" | "payoff" | "insufficient";

export type ResonanceSystemReview = {
  reviewNumber: number;
  completedTrades: number;
  nextReviewProgress: number;
  issue: ResonanceReviewIssue;
  issueLabel: string;
  headline: string;
  evidence: string[];
  action: string;
  status: "观察" | "验证中" | "已启用";
  directive: "none" | "respect_4h_direction";
  latest: {
    averageR: number;
    directionErrorRate: number;
    poorEntryRate: number;
    poorExitRate: number;
  };
  previous: {
    averageR: number;
    directionErrorRate: number;
    poorEntryRate: number;
    poorExitRate: number;
  } | null;
};

type ReviewedTrade = {
  r: number;
  directionError: boolean;
  poorEntry: boolean;
  poorExit: boolean;
  smallWinner: boolean;
};

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function candleMs(candle: Hte31Candle) {
  return candle.time > 10_000_000_000 ? candle.time : candle.time * 1000;
}

function mergeCandles(...groups: Hte31Candle[][]) {
  const byTime = new Map<number, Hte31Candle>();
  for (const candle of groups.flat()) byTime.set(candleMs(candle), candle);
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, candle]) => candle);
}

function round(value: number, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function summarize(rows: ReviewedTrade[]) {
  const count = Math.max(1, rows.length);
  return {
    averageR: round(rows.reduce((sum, row) => sum + row.r, 0) / count),
    directionErrorRate: rows.filter((row) => row.directionError).length / count,
    poorEntryRate: rows.filter((row) => row.poorEntry).length / count,
    poorExitRate: rows.filter((row) => row.poorExit).length / count,
    smallWinnerRate: rows.filter((row) => row.smallWinner).length / count,
  };
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function pickIssue(summary: ReturnType<typeof summarize>): ResonanceReviewIssue {
  const ranked: [ResonanceReviewIssue, number][] = [
    ["direction", summary.directionErrorRate],
    ["entry", summary.poorEntryRate],
    ["exit", summary.poorExitRate],
    ["payoff", summary.smallWinnerRate],
  ];
  const [issue, score] = ranked.sort((a, b) => b[1] - a[1])[0];
  return score >= 0.6 ? issue : "insufficient";
}

function issueLabel(issue: ResonanceReviewIssue) {
  return ({ direction: "方向判断", entry: "进场时机", exit: "退出管理", payoff: "盈亏结构", insufficient: "暂无单一主因" } satisfies Record<ResonanceReviewIssue, string>)[issue];
}

export async function getResonanceSystemReview(): Promise<ResonanceSystemReview> {
  const db = getDb();
  const [{ count: totalRaw }, rows, settings] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(hte31Trades).where(eq(hte31Trades.status, "closed")),
    db.select().from(hte31Trades).where(eq(hte31Trades.status, "closed")).orderBy(asc(hte31Trades.exitAt)).limit(500),
    getSettings(),
  ]);
  const total = Number(totalRaw ?? rows.length);
  const completedTrades = Math.floor(total / 5) * 5;
  const reviewNumber = Math.floor(total / 5);
  const nextReviewProgress = total % 5;
  if (reviewNumber < 1 || rows.length < 5) {
    return {
      reviewNumber: 0,
      completedTrades,
      nextReviewProgress,
      issue: "insufficient",
      issueLabel: "样本积累中",
      headline: `还差 ${5 - nextReviewProgress} 笔完成第一次整体复盘`,
      evidence: ["系统会把方向、进场、退出和盈亏结构放在一起复盘，而不是只看胜率。"],
      action: "继续收集样本，不因少量交易直接改策略。",
      status: "观察",
      directive: "none",
      latest: { averageR: 0, directionErrorRate: 0, poorEntryRate: 0, poorExitRate: 0 },
      previous: null,
    };
  }

  const completedRows = rows.slice(0, completedTrades);
  const latestRows = completedRows.slice(-5);
  const previousRows = completedRows.length >= 10 ? completedRows.slice(-10, -5) : [];
  const ids = [...latestRows, ...previousRows].map((row) => row.id);
  const charts = ids.length ? await db.select().from(hte31TradeCharts).where(inArray(hte31TradeCharts.tradeId, ids)) : [];
  const chartById = new Map(charts.map((chart) => [chart.tradeId, chart] as const));

  const reviewTrade = (trade: typeof hte31Trades.$inferSelect): ReviewedTrade => {
    const riskR = trade.riskBudgetUsdt > 0 ? (trade.netPnlUsdt ?? 0) / trade.riskBudgetUsdt : 0;
    const structuralRiskPct = trade.entryPrice > 0 ? Math.abs(trade.entryPrice - trade.initialStopPrice) / trade.entryPrice * 100 : 0;
    const mfeR = structuralRiskPct > 0 ? (trade.mfePct ?? 0) / structuralRiskPct : 0;
    const maeR = structuralRiskPct > 0 ? (trade.maePct ?? 0) / structuralRiskPct : 0;
    const chart = chartById.get(trade.id);
    let directionError = false;
    if (chart) {
      const candles = mergeCandles(
        parseJson<Hte31Candle[]>(chart.entryCandlesJson, []),
        parseJson<Hte31Candle[]>(chart.holdingCandlesJson, []),
        parseJson<Hte31Candle[]>(chart.postExitCandlesJson, []),
      );
      const counterfactual = buildHte31Counterfactual(trade, candles, settings.roundTripCostBps, Date.now());
      const horizon = counterfactual?.horizons.find((item) => item.minutes === 240) ?? counterfactual?.horizons.at(-1);
      directionError = Boolean(horizon && horizon.originalR < -0.15 && horizon.oppositeR > horizon.originalR + 0.6);
    }
    const poorEntry = maeR >= 0.75 && mfeR >= 0.6;
    const poorExit = trade.postExitLabel === "退出偏早" || trade.postExitLabel === "疑似假止损" || (trade.exitEfficiency != null && trade.exitEfficiency < 42);
    const smallWinner = riskR > 0 && riskR < 0.55;
    return { r: riskR, directionError, poorEntry, poorExit, smallWinner };
  };

  const latestReviewed = latestRows.map(reviewTrade);
  const previousReviewed = previousRows.map(reviewTrade);
  const latest = summarize(latestReviewed);
  const previous = previousReviewed.length ? summarize(previousReviewed) : null;
  const issue = pickIssue(latest);
  const previousIssue = previous ? pickIssue(previous) : "insufficient";
  const repeated = issue !== "insufficient" && issue === previousIssue;
  const directive = repeated && issue === "direction" ? "respect_4h_direction" as const : "none" as const;
  const status: ResonanceSystemReview["status"] = directive !== "none" ? "已启用" : issue === "insufficient" ? "观察" : "验证中";

  const evidence = [
    `最近5笔平均 ${latest.averageR >= 0 ? "+" : ""}${latest.averageR.toFixed(2)}R`,
    `方向疑似错误 ${pct(latest.directionErrorRate)} · 进场偏早 ${pct(latest.poorEntryRate)} · 退出质量偏弱 ${pct(latest.poorExitRate)}`,
  ];
  if (previous) evidence.push(`上一组5笔平均 ${previous.averageR >= 0 ? "+" : ""}${previous.averageR.toFixed(2)}R，方向错误 ${pct(previous.directionErrorRate)}`);

  let headline = "最近5笔没有出现一个压倒性的共同错误";
  let action = "保持核心规则，继续观察下一组5笔，避免为了噪声频繁改策略。";
  if (issue === "direction") {
    headline = "当前最值得怀疑的是方向判断，而不是止损大小";
    action = repeated
      ? "方向问题连续两轮出现：已加强4小时方向约束，反向Setup只观察不新开仓。"
      : "先验证下一组5笔；如果方向错误再次成为主因，再加强4小时方向约束。";
  } else if (issue === "entry") {
    headline = "方向未必错，但进场经常太早";
    action = "下一轮重点验证等待确认是否能降低先吃止损再运行的情况；暂不直接改核心入场。";
  } else if (issue === "exit") {
    headline = "最近主要损失来自退出管理，而不是找不到行情";
    action = "把退出方案作为候选规则继续对照，不直接改正式止损/止盈，避免5笔样本过拟合。";
  } else if (issue === "payoff") {
    headline = "最近盈利单赚得太小，无法覆盖完整亏损";
    action = "继续验证目标位和保护方式，优先改善盈亏结构，不用降频掩盖问题。";
  }

  return {
    reviewNumber,
    completedTrades,
    nextReviewProgress,
    issue,
    issueLabel: issueLabel(issue),
    headline,
    evidence,
    action,
    status,
    directive,
    latest: {
      averageR: latest.averageR,
      directionErrorRate: latest.directionErrorRate,
      poorEntryRate: latest.poorEntryRate,
      poorExitRate: latest.poorExitRate,
    },
    previous: previous ? {
      averageR: previous.averageR,
      directionErrorRate: previous.directionErrorRate,
      poorEntryRate: previous.poorEntryRate,
      poorExitRate: previous.poorExitRate,
    } : null,
  };
}
