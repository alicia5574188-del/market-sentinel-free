import { requireApiAccount } from "../../api-auth";
import { listOpenTrades } from "../../../lib/repository";
import { getStrategy2CounterfactualArchiveStats } from "../../../lib/strategy-2-counterfactual";
import { buildStrategy2Intelligence } from "../../../lib/strategy-2-intelligence";
import { getStrategy2LearningDashboard } from "../../../lib/strategy-2-learning";
import { getLatestV2MarketContext, getV2StrategyPoolActivity, listRecentV2Opportunities, listRecentV2Warnings, listV2TradeTheses } from "../../../lib/sentinel-v2-repository";

const HEAVY_CACHE_MS = 60_000;
const INTERACTIVE_LEARNING_LIMIT = 800;
let learningCache: { savedAt: number; value: Awaited<ReturnType<typeof getStrategy2LearningDashboard>> } | null = null;
let learningPending: Promise<Awaited<ReturnType<typeof getStrategy2LearningDashboard>>> | null = null;
let counterfactualCache: { savedAt: number; value: Awaited<ReturnType<typeof getStrategy2CounterfactualArchiveStats>> } | null = null;
let counterfactualPending: Promise<Awaited<ReturnType<typeof getStrategy2CounterfactualArchiveStats>>> | null = null;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "source failed";
}

async function cachedLearning() {
  const now = Date.now();
  if (learningCache && now - learningCache.savedAt < HEAVY_CACHE_MS) return learningCache.value;
  if (!learningPending) {
    // The interactive dashboard only exposes recent trades and the top cells.
    // Keep the full 2,500-row hierarchy for background strategy learning, but
    // do not make every 15-second UI reader rebuild it from the entire history.
    learningPending = getStrategy2LearningDashboard(INTERACTIVE_LEARNING_LIMIT).then((value) => {
      learningCache = { savedAt: Date.now(), value };
      return value;
    }).finally(() => { learningPending = null; });
  }
  return learningPending;
}

async function cachedCounterfactual(observedAt: number) {
  const now = Date.now();
  if (counterfactualCache && now - counterfactualCache.savedAt < HEAVY_CACHE_MS) return counterfactualCache.value;
  if (!counterfactualPending) {
    counterfactualPending = getStrategy2CounterfactualArchiveStats({ observedAt }).then((value) => {
      counterfactualCache = { savedAt: Date.now(), value };
      return value;
    }).finally(() => { counterfactualPending = null; });
  }
  return counterfactualPending;
}

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;

  const observedAt = Date.now();
  const results = await Promise.allSettled([
    getLatestV2MarketContext(),
    listRecentV2Opportunities(120),
    getV2StrategyPoolActivity(),
    cachedLearning(),
    listRecentV2Warnings(24),
    listOpenTrades(),
    listV2TradeTheses(80),
    cachedCounterfactual(observedAt),
  ] as const);

  const sourceNames = ["market", "opportunities", "strategyPool", "learning", "warnings", "openTrades", "theses", "counterfactual"] as const;
  const optionalSourceErrors: Record<string, string> = {};
  results.forEach((result, index) => {
    if (result.status === "rejected") optionalSourceErrors[sourceNames[index]] = errorMessage(result.reason);
  });

  const market = results[0].status === "fulfilled" ? results[0].value : null;
  const opportunities = results[1].status === "fulfilled" ? results[1].value : [];
  const strategyPool = results[2].status === "fulfilled" ? results[2].value : null;
  const learning = results[3].status === "fulfilled" ? results[3].value : learningCache?.value ?? null;
  const warnings = results[4].status === "fulfilled" ? results[4].value : [];
  const openTrades = results[5].status === "fulfilled" ? results[5].value : [];
  const theses = results[6].status === "fulfilled" ? results[6].value : [];
  const counterfactualArchive = results[7].status === "fulfilled" ? results[7].value : counterfactualCache?.value ?? null;

  // Keep rendering whatever is still trustworthy. A diagnostics/learning query
  // must never turn the entire Strategy 2.0 dashboard into a 503 response.
  const openIds = new Set(openTrades.map((trade) => trade.id));
  const activeTheses = theses.filter((thesis) => openIds.has(thesis.tradeId));
  const longCount = openTrades.filter((trade) => trade.side === "LONG").length;
  const shortCount = openTrades.filter((trade) => trade.side === "SHORT").length;
  const dominantSideCount = Math.max(longCount, shortCount);
  const concentration = openTrades.length ? Math.round(dominantSideCount / openTrades.length * 100) : 0;
  const marketRisk = market?.permission === "RED" ? "CRITICAL"
    : market?.permission === "ORANGE" ? "HIGH"
      : market?.permission === "YELLOW" ? "ELEVATED"
        : "NORMAL";
  const currentAction = market?.permission === "RED" ? "停止新增风险，优先保护已有仓位"
    : market?.permission === "ORANGE" ? "限制新增仓位，只保留最高质量机会"
      : market?.permission === "YELLOW" ? "缩小新增风险并提高确认门槛"
        : market?.permission === "BLUE" ? "正常持仓，避免追价"
          : "正常风险预算";
  const averageThesisHealth = activeTheses.length
    ? Math.round(activeTheses.reduce((sum, thesis) => sum + thesis.thesisHealth, 0) / activeTheses.length)
    : null;
  const weakestThesisHealth = activeTheses.length
    ? Math.min(...activeTheses.map((thesis) => thesis.thesisHealth))
    : null;
  const intelligence = buildStrategy2Intelligence({
    observedAt,
    market,
    opportunities,
    learning,
    counterfactualArchive,
    openTrades: openTrades
      .filter((trade) => trade.side === "LONG" || trade.side === "SHORT")
      .map((trade) => ({ side: trade.side as "LONG" | "SHORT", regime: trade.regime })),
  });

  const degraded = Object.keys(optionalSourceErrors).length > 0;
  return Response.json({
    observedAt,
    version: "strategy-2.0",
    market,
    opportunities,
    strategyPool,
    learning,
    intelligence,
    warnings,
    theses: activeTheses,
    portfolio: {
      openCount: openTrades.length,
      longCount,
      shortCount,
      directionConcentration: concentration,
      riskLevel: marketRisk,
      currentAction,
      averageThesisHealth,
      weakestThesisHealth,
    },
    degraded,
    optionalSourceErrors,
  }, {
    headers: {
      "Cache-Control": "private, max-age=5, stale-while-revalidate=20",
      ...(degraded ? { "X-Sentinel-Partial-Data": "1" } : {}),
    },
  });
}
