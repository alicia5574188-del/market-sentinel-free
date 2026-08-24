import { getAlertDashboard } from "../../../lib/repository";
import { requireApiAccount } from "../../api-auth";

export async function GET(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  const requestedLimit = Number(new URL(request.url).searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(requestedLimit) ? requestedLimit : 100;
  try {
    return Response.json(await getAlertDashboard(limit), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "提醒历史不可用" }, { status: 503 });
  }
}
