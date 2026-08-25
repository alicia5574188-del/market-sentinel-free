import { inArray } from "drizzle-orm";
import { requireApiAccount } from "../../../api-auth";
import { getDb } from "../../../../db";
import { tradeCases } from "../../../../db/schema";
import { liveTradingCoordinator } from "../../../../lib/live-trading-coordinator";

export const dynamic = "force-dynamic";

function strategyLabel(trigger: string | null | undefined) {
  if (!trigger) return "综合确认";
  const match = trigger.match(/^成长策略 · ([^：]+)：/);
  return match?.[1]?.trim() || "综合确认";
}

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  if (auth.account.role !== "owner") return Response.json({ error: "只有所有者可以查看实盘账户" }, { status: 403 });
  try {
    const coordinator = liveTradingCoordinator();
    await coordinator.ensure();
    const snapshot = await coordinator.snapshot() as {
      orders?: { tradeCaseId: string; [key: string]: unknown }[];
      [key: string]: unknown;
    };
    const ids = [...new Set((snapshot.orders ?? []).map((order) => order.tradeCaseId).filter(Boolean))];
    const linked = ids.length ? await getDb().select({
      id: tradeCases.id,
      entryTrigger: tradeCases.entryTrigger,
      entryThesis: tradeCases.entryThesis,
      exitReason: tradeCases.exitReason,
      exitEvidenceJson: tradeCases.exitEvidenceJson,
    }).from(tradeCases).where(inArray(tradeCases.id, ids)) : [];
    const byId = new Map(linked.map((row) => [row.id, row]));
    const orders = (snapshot.orders ?? []).map((order) => {
      const trade = byId.get(order.tradeCaseId);
      return {
        ...order,
        strategyLabel: strategyLabel(trade?.entryTrigger),
        strategyTrigger: trade?.entryTrigger ?? null,
        strategyThesis: trade?.entryThesis ?? null,
        strategyExitReason: trade?.exitReason ?? null,
        strategyExitEvidence: trade?.exitEvidenceJson ? JSON.parse(trade.exitEvidenceJson) : [],
      };
    });
    return Response.json({ ...snapshot, orders }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "实盘状态不可用" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
