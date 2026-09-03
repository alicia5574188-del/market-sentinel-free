import { inArray } from "drizzle-orm";
import { requireApiAccount } from "../../../api-auth";
import { getDb } from "../../../../db";
import { tradeCases } from "../../../../db/schema";
import { hte31Trades } from "../../../../db/hte31-schema";
import { getLiveTradingSnapshot } from "../../../../lib/live-trading-repository";
import { hte31CanonicalStrategyLabel, type Hte31TraderId } from "../../../../lib/hte31-strategy-catalog";

export const dynamic = "force-dynamic";

function strategyLabel(trigger: string | null | undefined) {
  if (!trigger) return "Human Trader";
  const human = trigger.match(/^Human Trader · ([^：]+)：/);
  if (human?.[1]) return human[1].trim();
  const strategy2 = trigger.match(/^成长策略 · ([^：]+)：/);
  return strategy2?.[1]?.trim() || "Human Trader";
}

function stringList(value: string | null | undefined) {
  if (!value) return [] as string[];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 12) : [];
  } catch {
    return [] as string[];
  }
}

type LinkedStrategy = {
  id: string;
  traderId: string | null;
  entryTrigger: string | null;
  entryThesis: string | null;
  exitReason: string | null;
  exitEvidenceJson: string | null;
  strategyLabel: string;
};

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  if (auth.account.role !== "owner") return Response.json({ error: "只有所有者可以查看实盘账户" }, { status: 403 });
  try {
    // Status polling is deliberately read-only. Do not enqueue behind the
    // Durable Object's Gate reconciliation queue: a slow Gate cycle must never
    // make the phone's live-status poll wait for execution to finish.
    const snapshot = await getLiveTradingSnapshot() as {
      orders?: { tradeCaseId: string; [key: string]: unknown }[];
      [key: string]: unknown;
    };
    const ids = [...new Set((snapshot.orders ?? []).map((order) => order.tradeCaseId).filter(Boolean))];
    const currentLinked = ids.length ? await getDb().select({
      id: hte31Trades.id,
      traderId: hte31Trades.traderId,
      entryTrigger: hte31Trades.entryTrigger,
      entryThesis: hte31Trades.entryThesis,
      exitReason: hte31Trades.exitReason,
    }).from(hte31Trades).where(inArray(hte31Trades.id, ids)) : [];
    const currentIds = new Set(currentLinked.map((row) => row.id));
    const legacyIds = ids.filter((id) => !currentIds.has(id));
    const legacyLinked = legacyIds.length ? await getDb().select({
      id: tradeCases.id,
      entryTrigger: tradeCases.entryTrigger,
      entryThesis: tradeCases.entryThesis,
      exitReason: tradeCases.exitReason,
      exitEvidenceJson: tradeCases.exitEvidenceJson,
    }).from(tradeCases).where(inArray(tradeCases.id, legacyIds)) : [];
    const byId = new Map<string, LinkedStrategy>([
      ...currentLinked.map((row): [string, LinkedStrategy] => [row.id, { ...row, strategyLabel: hte31CanonicalStrategyLabel(row.traderId as Hte31TraderId), exitEvidenceJson: null }]),
      ...legacyLinked.map((row): [string, LinkedStrategy] => [row.id, { ...row, strategyLabel: strategyLabel(row.entryTrigger), traderId: null }]),
    ]);
    const orders = (snapshot.orders ?? []).map((order) => {
      const trade = byId.get(order.tradeCaseId);
      return {
        ...order,
        strategyLabel: trade?.strategyLabel ?? strategyLabel(trade?.entryTrigger),
        strategyTrigger: trade?.entryTrigger ?? null,
        strategyThesis: trade?.entryThesis ?? null,
        strategyExitReason: trade?.exitReason ?? null,
        strategyExitEvidence: stringList(trade?.exitEvidenceJson),
      };
    });
    return Response.json({ ...snapshot, orders }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "实盘状态不可用" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
