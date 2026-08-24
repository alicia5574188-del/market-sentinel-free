import { getQuickScanner } from "../../../lib/scanner";
import { requireApiAccount } from "../../api-auth";

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  try {
    return Response.json(await getQuickScanner(), {
      headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=30" },
    });
  } catch (error) {
    return Response.json({ observedAt: Date.now(), error: error instanceof Error ? error.message : "全市场初筛不可用" }, { status: 503 });
  }
}
