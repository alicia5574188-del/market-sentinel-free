import { requireApiAccount } from "../../../api-auth";
import { mutationRejected, readLimitedJsonObject } from "../../../api-security";
import { liveTradingCoordinator } from "../../../../lib/live-trading-coordinator";

export async function POST(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  if (auth.account.role !== "owner") return Response.json({ error: "只有所有者可以切换自动开仓" }, { status: 403 });
  const rejected = mutationRejected(request, 1_024);
  if (rejected) return rejected;
  try {
    const payload = await readLimitedJsonObject(request, 1_024);
    if (typeof payload.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
    return Response.json(await liveTradingCoordinator().setAutomaticEntry(payload.enabled, auth.account.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "自动开仓状态切换失败" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
