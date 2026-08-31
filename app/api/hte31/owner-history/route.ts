import {
  getOwnerTradeDiagnostic,
  getOwnerTradeHistory,
  type OwnerTradeDiagnosticSource,
} from "../../../../lib/owner-trade-diagnostics";
import { requireApiAccount } from "../../../api-auth";

export const dynamic = "force-dynamic";

function clampInt(value: string | null, fallback: number, min: number, max: number) {
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sourceFrom(value: string | null): OwnerTradeDiagnosticSource | null {
  if (!value || value === "all") return "all";
  if (value === "hte31" || value === "legacy") return value;
  return null;
}

export async function GET(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  if (auth.account.role !== "owner") {
    return Response.json({ error: "只有站点所有者可以读取交易诊断记录" }, { status: 403 });
  }

  const url = new URL(request.url);
  const tradeId = (url.searchParams.get("trade") ?? "").trim();
  if (tradeId) {
    if (tradeId.length > 160) return Response.json({ error: "交易 ID 无效" }, { status: 400 });
    const trade = await getOwnerTradeDiagnostic(tradeId);
    if (!trade) return Response.json({ error: "交易记录不存在" }, { status: 404 });
    return Response.json({
      version: "owner-trade-diagnostics-v1",
      generatedAt: Date.now(),
      trade,
    }, { headers: { "Cache-Control": "private, no-store" } });
  }

  const source = sourceFrom(url.searchParams.get("source"));
  if (!source) return Response.json({ error: "source 仅支持 hte31 / legacy / all" }, { status: 400 });
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 200);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 5000);
  const payload = await getOwnerTradeHistory({ source, limit, offset });
  const download = url.searchParams.get("download") === "1";
  return Response.json(payload, {
    headers: {
      "Cache-Control": "private, no-store",
      ...(download ? { "Content-Disposition": `attachment; filename="sentinel-trade-diagnostics-${Date.now()}.json"` } : {}),
    },
  });
}
