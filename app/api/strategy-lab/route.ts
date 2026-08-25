import { requireApiAccount } from "../../api-auth";
import { getStrategyLabDashboard } from "../../../lib/shadow-strategy-repository.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  try {
    return Response.json(await getStrategyLabDashboard(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "策略实验室暂不可用" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
