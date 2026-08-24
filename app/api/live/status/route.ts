import { requireApiAccount } from "../../../api-auth";
import { liveTradingCoordinator } from "../../../../lib/live-trading-coordinator";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  if (auth.account.role !== "owner") return Response.json({ error: "只有所有者可以查看实盘账户" }, { status: 403 });
  try {
    const coordinator = liveTradingCoordinator();
    await coordinator.ensure();
    return Response.json(await coordinator.snapshot(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "实盘状态不可用" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
