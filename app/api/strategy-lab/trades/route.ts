import { desc, like, or, eq } from "drizzle-orm";
import { requireApiAccount } from "../../../api-auth";
import { getDb } from "../../../../db";
import { tradeCases } from "../../../../db/schema";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  try {
    const rows = await getDb().select({
      id: tradeCases.id,
      simulationModel: tradeCases.simulationModel,
      symbol: tradeCases.symbol,
      status: tradeCases.status,
      side: tradeCases.side,
      confidence: tradeCases.confidence,
      regime: tradeCases.regime,
      entryAt: tradeCases.entryAt,
      entryPrice: tradeCases.entryPrice,
      currentStopPrice: tradeCases.currentStopPrice,
      takeProfit1Price: tradeCases.takeProfit1Price,
      takeProfit2Price: tradeCases.takeProfit2Price,
      leverage: tradeCases.leverage,
      marginUsdt: tradeCases.marginUsdt,
      contractNotionalUsdt: tradeCases.contractNotionalUsdt,
      unrealizedNetPct: tradeCases.unrealizedNetPct,
      unrealizedNetUsdt: tradeCases.unrealizedNetUsdt,
      progressR: tradeCases.progressR,
      exitAt: tradeCases.exitAt,
      exitPrice: tradeCases.exitPrice,
      exitCode: tradeCases.exitCode,
      exitReason: tradeCases.exitReason,
      netMovePct: tradeCases.netMovePct,
      netPnlUsdt: tradeCases.netPnlUsdt,
    }).from(tradeCases).where(or(
      eq(tradeCases.simulationModel, "contract_v2"),
      like(tradeCases.simulationModel, "shadow_v3:%"),
    )).orderBy(desc(tradeCases.entryAt)).limit(200);

    return Response.json({ observedAt: Date.now(), trades: rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "策略订单记录暂不可用" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
