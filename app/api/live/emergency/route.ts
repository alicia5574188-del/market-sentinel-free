import { requireApiAccount } from "../../../api-auth";
import { mutationRejected, readLimitedJsonObject } from "../../../api-security";
import { liveTradingCoordinator } from "../../../../lib/live-trading-coordinator";

export async function POST(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  if (auth.account.role !== "owner") return Response.json({ error: "只有所有者可以操作紧急停机" }, { status: 403 });
  const rejected = mutationRejected(request, 1_024);
  if (rejected) return rejected;
  try {
    const payload = await readLimitedJsonObject(request, 1_024);
    const coordinator = liveTradingCoordinator();
    if (payload.action === "stop") return Response.json(await coordinator.emergencyStop(auth.account.id), { headers: { "Cache-Control": "no-store" } });
    if (payload.action === "reset") return Response.json(await coordinator.resetEmergencyStop(auth.account.id), { headers: { "Cache-Control": "no-store" } });
    throw new Error("紧急停机动作无效");
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "紧急停机操作失败" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
