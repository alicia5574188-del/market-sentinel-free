import { requireApiAccount } from "../../../api-auth";
import { mutationRejected, readLimitedJsonObject } from "../../../api-security";
import { liveTradingCoordinator } from "../../../../lib/live-trading-coordinator";

export async function PUT(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  if (auth.account.role !== "owner") return Response.json({ error: "只有所有者可以保存 Gate API 凭据" }, { status: 403 });
  const rejected = mutationRejected(request, 4_096);
  if (rejected) return rejected;
  try {
    const payload = await readLimitedJsonObject(request, 4_096);
    const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
    const apiSecret = typeof payload.apiSecret === "string" ? payload.apiSecret : "";
    if (payload.environment !== "live" && payload.environment !== "testnet") throw new Error("Gate 环境必须明确选择实盘或 TestNet");
    const environment = payload.environment;
    const permissionsConfirmed = payload.permissionsConfirmed === true;
    return Response.json(await liveTradingCoordinator().saveCredentials({ apiKey, apiSecret, environment, permissionsConfirmed }, auth.account.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Gate API 凭据保存失败" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}

export async function DELETE(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  if (auth.account.role !== "owner") return Response.json({ error: "只有所有者可以删除 Gate API 凭据" }, { status: 403 });
  const rejected = mutationRejected(request, 1_024);
  if (rejected) return rejected;
  try {
    return Response.json(await liveTradingCoordinator().removeCredentials(auth.account.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Gate API 凭据删除失败" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
