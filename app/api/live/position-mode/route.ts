import { requireApiAccount } from "../../../api-auth";
import { mutationRejected, readLimitedJsonObject } from "../../../api-security";
import { normalizeGateCredentials } from "../../../../lib/credential-vault";
import { GatePrivateClient } from "../../../../lib/gate-private";
import { switchGateToSinglePositionMode } from "../../../../lib/gate-position-mode";

export async function POST(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  if (auth.account.role !== "owner") return Response.json({ error: "只有所有者可以切换 Gate 持仓模式" }, { status: 403 });
  const rejected = mutationRejected(request, 4_096);
  if (rejected) return rejected;

  try {
    const payload = await readLimitedJsonObject(request, 4_096);
    if (payload.confirmSwitch !== true) {
      return Response.json({ error: "切换持仓模式需要明确确认" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const credentials = normalizeGateCredentials({
      apiKey: typeof payload.apiKey === "string" ? payload.apiKey : "",
      apiSecret: typeof payload.apiSecret === "string" ? payload.apiSecret : "",
      environment: "live",
    });
    const result = await switchGateToSinglePositionMode(new GatePrivateClient(credentials));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Gate 持仓模式切换失败" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
