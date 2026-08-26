import { requireApiAccount } from "../../api-auth";
import { listOpenTrades } from "../../../lib/repository";
import { getLatestV2MarketContext, listRecentV2Opportunities, listRecentV2Warnings } from "../../../lib/sentinel-v2-repository";

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  try {
    const [market, opportunities, warnings, openTrades] = await Promise.all([
      getLatestV2MarketContext(),
      listRecentV2Opportunities(120),
      listRecentV2Warnings(24),
      listOpenTrades(),
    ]);
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

    return Response.json({
      observedAt: Date.now(),
      version: "sentinel-v2",
      market,
      opportunities,
      warnings,
      portfolio: {
        openCount: openTrades.length,
        longCount,
        shortCount,
        directionConcentration: concentration,
        riskLevel: marketRisk,
        currentAction,
      },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({
      observedAt: Date.now(),
      version: "sentinel-v2",
      market: null,
      opportunities: [],
      warnings: [],
      portfolio: null,
      error: error instanceof Error ? error.message : "Sentinel V2 数据暂不可用",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
