import { requireApiAccount } from "../../../api-auth";
import { mutationRejected } from "../../../api-security";
import { liveTradingCoordinator } from "../../../../lib/live-trading-coordinator";

export async function POST(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  if (auth.account.role !== "owner") return Response.json({ error: "只有所有者可以执行实盘对账" }, { status: 403 });
  const rejected = mutationRejected(request, 1_024);
  if (rejected) return rejected;
  try {
    return Response.json(await liveTradingCoordinator().reconcileNow(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "实盘对账失败" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
