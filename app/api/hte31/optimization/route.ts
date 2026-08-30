import { getHte31OptimizationReport } from "../../../../lib/hte31-optimization";
import { requireApiAccount } from "../../../api-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  try {
    return Response.json(await getHte31OptimizationReport(), {
      headers: { "Cache-Control": "private, max-age=5, stale-while-revalidate=15" },
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "HTE 3.1 optimization report unavailable",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
