import { requireApiAccount } from "../../api-auth";
import { getLatestV2MarketContext, listRecentV2Opportunities, listRecentV2Warnings } from "../../../lib/sentinel-v2-repository";

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  try {
    const [market, opportunities, warnings] = await Promise.all([
      getLatestV2MarketContext(),
      listRecentV2Opportunities(120),
      listRecentV2Warnings(24),
    ]);
    return Response.json({
      observedAt: Date.now(),
      version: "sentinel-v2",
      market,
      opportunities,
      warnings,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({
      observedAt: Date.now(),
      version: "sentinel-v2",
      market: null,
      opportunities: [],
      warnings: [],
      error: error instanceof Error ? error.message : "Sentinel V2 数据暂不可用",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
