import { fetchGateChartCandles } from "../../../lib/gate-client";
import { getTrade } from "../../../lib/repository";
import { requireApiAccount } from "../../api-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  try {
    const id = new URL(request.url).searchParams.get("trade") ?? "";
    if (!id || id.length > 128) return Response.json({ error: "缺少有效订单 ID" }, { status: 400 });
    const trade = await getTrade(id);
    if (!trade) return Response.json({ error: "订单不存在" }, { status: 404 });
    const now = Date.now();
    const isRecent = now - trade.entryAt <= 70 * 60 * 60_000;
    const to = isRecent ? now : (trade.exitAt ?? trade.lastEvaluatedAt) + 60 * 60_000;
    const candles = await fetchGateChartCandles(trade.symbol, trade.entryAt - 60 * 60_000, to);
    const markers = [
      {
        kind: trade.side === "LONG" ? "B" : "S",
        action: trade.side === "LONG" ? "买入开多" : "卖出开空",
        time: trade.entryAt,
        price: trade.entryPrice,
      },
      ...(trade.status === "closed" && trade.exitAt && trade.exitPrice ? [{
        kind: trade.side === "LONG" ? "S" : "B",
        action: trade.side === "LONG" ? "卖出平多" : "买入平空",
        time: trade.exitAt,
        price: trade.exitPrice,
      }] : []),
    ];
    return Response.json({
      tradeId: trade.id,
      symbol: trade.symbol,
      observedAt: now,
      live: isRecent,
      candles,
      currentPrice: candles.at(-1)?.close ?? trade.lastPrice,
      levels: {
        entry: trade.entryPrice,
        stop: trade.currentStopPrice,
        takeProfit1: trade.takeProfit1Price,
        takeProfit2: trade.takeProfit2Price,
      },
      markers,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Gate 行情图暂不可用" }, { status: 503 });
  }
}
