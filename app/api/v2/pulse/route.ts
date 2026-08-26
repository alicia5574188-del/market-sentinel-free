import { getSentinelV2Pulse } from "../../../../lib/sentinel-v2-repository";
import { requireApiAccount } from "../../../api-auth";

export async function GET(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") || "BTC_USDT").toUpperCase();
  if (!/^[A-Z0-9]{2,20}_[A-Z0-9]{2,12}$/.test(symbol)) {
    return Response.json({ error: "无效合约代码" }, { status: 400 });
  }
  try {
    return Response.json(await getSentinelV2Pulse(symbol), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return Response.json({
      observedAt: Date.now(),
      context: null,
      warnings: [],
      recommended: [],
      watch: [],
      rejected: [],
      error: error instanceof Error ? error.message : "Sentinel V2 暂无有效环境数据",
    }, { status: 503 });
  }
}
