import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { hte31TradeCharts, hte31Trades } from "../db/hte31-schema";
import { buildHte31Counterfactual } from "./hte31-counterfactual.ts";
import { RESONANCE_POLICY_STARTED_AT } from "./resonance-policy-version.ts";
import { getSettings } from "./settings-repository.ts";
import type { Hte31Candle } from "./hte31-types.ts";

export type ResonanceReviewIssue = "direction" | "entry" | "stop" | "exit" | "payoff" | "market_fit" | "insufficient";
export type ResonanceDirective = "respect_4h_direction" | "require_retest" | "delay_protection" | "improve_payoff" | "respect_market_fit";

export type ResonanceTradeAutopsy = {
  tradeId: string;
  symbol: string;
  traderId: string;
  setupId: string;
  resultR: number;
  primaryCause: ResonanceReviewIssue;
  causeLabel: string;
  explanation: string;
  evidence: string[];
};

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
  directive: "none" | ResonanceDirective;
  directives: ResonanceDirective[];
  latestAutopsy: ResonanceTradeAutopsy | null;
  pattern: {
    sampleSize: number;
    repeatedCause: ResonanceReviewIssue;
    repeatedCount: number;
  };
  challengerSetupId: string | null;
  weakSetup: {
    setupId: string;
    sampleCount: number;
    averageR: number;
    wins: number;
  } | null;
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
  tradeId: string;
  symbol: string;
  traderId: string;
  setupId: string;
  r: number;
  directionError: boolean;
  poorEntry: boolean;
  stopProblem: boolean;
  poorExit: boolean;
  smallWinner: boolean;
  marketMismatch: boolean;
  primaryCause: ResonanceReviewIssue;
  evidence: string[];
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

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function issueLabel(issue: ResonanceReviewIssue) {
  return ({
    direction: "方向判断",
    entry: "进场时机",
    stop: "止损/保护",
    exit: "退出管理",
    payoff: "盈亏结构",
    market_fit: "打法与行情不匹配",
    insufficient: "暂无单一主因",
  } satisfies Record<ResonanceReviewIssue, string>)[issue];
}

function setupFitsRegime(setupId: string, assetRegime: string) {
  if (setupId === "trend_breakout") return ["compression", "expansion_up", "expansion_down", "trend_up", "trend_down", "transition"].includes(assetRegime);
  if (setupId === "trend_pullback") return ["trend_up", "trend_down", "expansion_up", "expansion_down"].includes(assetRegime);
  if (setupId === "failed_breakout") return ["range", "transition", "compression", "leverage_liquidation"].includes(assetRegime);
  if (setupId === "trend_exhaustion_reversal") return ["expansion_up", "expansion_down", "transition", "leverage_liquidation"].includes(assetRegime);
  if (setupId === "higher_timeframe_swing") return ["trend_up", "trend_down", "expansion_up", "expansion_down", "transition"].includes(assetRegime);
  return true;
}

function primaryCause(input: Omit<ReviewedTrade, "primaryCause" | "evidence">): ResonanceReviewIssue {
  if (input.directionError) return "direction";
  if (input.marketMismatch && input.r < 0) return "market_fit";
  if (input.stopProblem) return "stop";
  if (input.poorEntry) return "entry";
  if (input.poorExit) return "exit";
  if (input.smallWinner) return "payoff";
  return "insufficient";
}

function summarize(rows: ReviewedTrade[]) {
  const count = Math.max(1, rows.length);
  return {
    averageR: round(rows.reduce((sum, row) => sum + row.r, 0) / count),
    directionErrorRate: rows.filter((row) => row.directionError).length / count,
    poorEntryRate: rows.filter((row) => row.poorEntry).length / count,
    poorExitRate: rows.filter((row) => row.poorExit || row.stopProblem).length / count,
  };
}

function directivesFromRecent(rows: ReviewedTrade[]) {
  const recent = rows.slice(0, 3);
  const count = (issue: ResonanceReviewIssue) => recent.filter((row) => row.primaryCause === issue).length;
  const directives: ResonanceDirective[] = [];
  if (count("direction") >= 2) directives.push("respect_4h_direction");
  if (count("entry") >= 2) directives.push("require_retest");
  if (count("stop") + count("exit") >= 2) directives.push("delay_protection");
  if (count("payoff") >= 2) directives.push("improve_payoff");
  if (count("market_fit") >= 2) directives.push("respect_market_fit");
  return directives;
}

function repeatedPattern(rows: ReviewedTrade[]) {
  const recent = rows.slice(0, 3);
  const counts = new Map<ResonanceReviewIssue, number>();
  for (const row of recent) counts.set(row.primaryCause, (counts.get(row.primaryCause) ?? 0) + 1);
  const [cause, repeatedCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["insufficient" as const, 0];
  return {
    sampleSize: recent.length,
    repeatedCause: repeatedCount >= 2 ? cause : "insufficient" as ResonanceReviewIssue,
    repeatedCount,
  };
}

function weakSetup(rows: ReviewedTrade[]) {
  const groups = new Map<string, ReviewedTrade[]>();
  for (const row of rows) groups.set(row.setupId, [...(groups.get(row.setupId) ?? []), row]);
  const weak = [...groups.entries()].flatMap(([setupId, items]) => {
    const averageR = items.reduce((sum, row) => sum + row.r, 0) / Math.max(1, items.length);
    const wins = items.filter((row) => row.r > 0).length;
    const clearlyWeak = (items.length >= 8 && averageR <= -0.20) || (items.length >= 6 && wins === 0 && averageR <= -0.35);
    return clearlyWeak ? [{ setupId, sampleCount: items.length, averageR: round(averageR), wins }] : [];
  }).sort((a, b) => a.averageR - b.averageR);
  return weak[0] ?? null;
}

export async function getResonanceSystemReview(): Promise<ResonanceSystemReview> {
  const db = getDb();
  const currentPolicyClosed = and(
    eq(hte31Trades.status, "closed"),
    gte(hte31Trades.entryAt, RESONANCE_POLICY_STARTED_AT),
  );
  const [{ count: totalRaw }, rows, settings] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(hte31Trades).where(currentPolicyClosed),
    db.select().from(hte31Trades).where(currentPolicyClosed).orderBy(desc(hte31Trades.exitAt)).limit(40),
    getSettings(),
  ]);
  const total = Number(totalRaw ?? rows.length);
  const ids = rows.slice(0, 10).map((row) => row.id);
  const charts = ids.length ? await db.select().from(hte31TradeCharts).where(inArray(hte31TradeCharts.tradeId, ids)) : [];
  const chartById = new Map(charts.map((chart) => [chart.tradeId, chart] as const));

  const reviewed: ReviewedTrade[] = rows.map((trade) => {
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
    const stopProblem = Boolean(trade.stopRecovery) || trade.postExitLabel === "疑似假止损";
    const poorExit = trade.postExitLabel === "退出偏早" || trade.postExitLabel === "退出偏晚" || (trade.exitEfficiency != null && trade.exitEfficiency < 42);
    const smallWinner = riskR > 0 && riskR < 0.55;
    const marketMismatch = !setupFitsRegime(trade.setupId, trade.assetRegime);
    const base = {
      tradeId: trade.id,
      symbol: trade.symbol,
      traderId: trade.traderId,
      setupId: trade.setupId,
      r: riskR,
      directionError,
      poorEntry,
      stopProblem,
      poorExit,
      smallWinner,
      marketMismatch,
    };
    const cause = primaryCause(base);
    const evidence = [
      `结果 ${riskR >= 0 ? "+" : ""}${riskR.toFixed(2)}R`,
      `MFE ${mfeR.toFixed(2)}R · MAE ${maeR.toFixed(2)}R`,
      directionError ? "4小时反事实显示反方向明显更优" : "未发现明确的反方向优势",
      marketMismatch ? `当前打法与 ${trade.assetRegime} 环境匹配度偏低` : `打法与 ${trade.assetRegime} 环境没有明显冲突`,
      stopProblem ? "止损后出现明显恢复，怀疑保护过早/位置过紧" : "未发现明确假止损恢复",
    ];
    return { ...base, primaryCause: cause, evidence };
  });

  if (!reviewed.length) {
    return {
      reviewNumber: 0,
      completedTrades: 0,
      nextReviewProgress: 0,
      issue: "insufficient",
      issueLabel: "等待第一笔交易",
      headline: "系统会从第一笔平仓开始立即复盘",
      evidence: ["每笔交易都会检查市场、方向、进场、止损、退出和盈亏结构，不再等满5笔才开始思考。"],
      action: "继续扫描；出现第一笔平仓后立即生成单笔尸检。",
      status: "观察",
      directive: "none",
      directives: [],
      latestAutopsy: null,
      pattern: { sampleSize: 0, repeatedCause: "insufficient", repeatedCount: 0 },
      challengerSetupId: null,
      weakSetup: null,
      latest: { averageR: 0, directionErrorRate: 0, poorEntryRate: 0, poorExitRate: 0 },
      previous: null,
    };
  }

  const latestTrade = reviewed[0];
  const pattern = repeatedPattern(reviewed);
  const directives = directivesFromRecent(reviewed);
  const weak = weakSetup(reviewed);
  const latestAutopsy: ResonanceTradeAutopsy = {
    tradeId: latestTrade.tradeId,
    symbol: latestTrade.symbol,
    traderId: latestTrade.traderId,
    setupId: latestTrade.setupId,
    resultR: round(latestTrade.r),
    primaryCause: latestTrade.primaryCause,
    causeLabel: issueLabel(latestTrade.primaryCause),
    explanation: latestTrade.primaryCause === "insufficient"
      ? "这笔交易暂时没有单一错误能够压倒其他解释，继续保留多种可能。"
      : `当前首先追查「${issueLabel(latestTrade.primaryCause)}」，而不是因为亏损本身机械暂停。`,
    evidence: latestTrade.evidence,
  };

  const latestBlock = reviewed.slice(0, 5);
  const previousBlock = reviewed.slice(5, 10);
  const latest = summarize(latestBlock);
  const previous = previousBlock.length ? summarize(previousBlock) : null;
  const issue = pattern.repeatedCause !== "insufficient" ? pattern.repeatedCause : latestTrade.primaryCause;
  const directive = directives[0] ?? "none";
  const status: ResonanceSystemReview["status"] = directives.length || weak ? "已启用" : "验证中";

  const evidence = [
    `最新一笔：${latestTrade.symbol} ${latestTrade.r >= 0 ? "+" : ""}${latestTrade.r.toFixed(2)}R，首要追查 ${issueLabel(latestTrade.primaryCause)}`,
    `最近${latestBlock.length}笔平均 ${latest.averageR >= 0 ? "+" : ""}${latest.averageR.toFixed(2)}R · 方向错误 ${pct(latest.directionErrorRate)} · 进场偏早 ${pct(latest.poorEntryRate)} · 退出/保护偏弱 ${pct(latest.poorExitRate)}`,
  ];
  if (pattern.repeatedCause !== "insufficient") evidence.push(`最近${pattern.sampleSize}笔有 ${pattern.repeatedCount} 笔重复指向「${issueLabel(pattern.repeatedCause)}」`);
  if (weak) evidence.push(`${weak.setupId} 已有 ${weak.sampleCount} 笔，平均 ${weak.averageR >= 0 ? "+" : ""}${weak.averageR.toFixed(2)}R，仅 ${weak.wins} 笔盈利，进入挑战方案验证`);
  if (previous) evidence.push(`再前一组${previousBlock.length}笔平均 ${previous.averageR >= 0 ? "+" : ""}${previous.averageR.toFixed(2)}R`);

  let headline = `刚完成的交易首先暴露：${issueLabel(latestTrade.primaryCause)}`;
  let action = "保留原策略作为基线，下一笔继续观察同类问题是否重复。";
  if (directives.includes("respect_4h_direction")) {
    headline = "方向错误开始重复，系统已加强大周期方向约束";
    action = "反4小时结构的普通Setup不再直接开仓；继续记录被拦截机会，验证这个改变是否真的减少错误。";
  } else if (directives.includes("require_retest")) {
    headline = "方向未必错，但进场过早开始重复";
    action = "趋势型Setup改为等待回踩后重新启动再进场，原始触发继续作为对照。";
  } else if (directives.includes("delay_protection")) {
    headline = "退出/保护问题开始重复，系统会给正确交易更多空间";
    action = "候选方案推迟过早保护并延长合理持有时间；仍保持原始结构止损和风险预算。";
  } else if (directives.includes("improve_payoff")) {
    headline = "盈利单太小开始重复，系统正在提高有效盈亏空间";
    action = "只有历史和结构空间支持时才提高目标，不靠放大仓位凑利润。";
  } else if (directives.includes("respect_market_fit")) {
    headline = "同一种打法在不合适的行情里反复失效";
    action = "优先路由到与当前环境匹配的打法，不再让所有交易员在任何行情都拥有同等上场权。";
  }
  if (weak) action += ` ${weak.setupId} 不再原样重复试错，改用认知挑战版本继续做模拟对照。`;

  return {
    reviewNumber: Math.floor(total / 5),
    completedTrades: total,
    nextReviewProgress: total % 5,
    issue,
    issueLabel: issueLabel(issue),
    headline,
    evidence,
    action,
    status,
    directive,
    directives,
    latestAutopsy,
    pattern,
    challengerSetupId: weak?.setupId ?? null,
    weakSetup: weak,
    latest,
    previous,
  };
}
