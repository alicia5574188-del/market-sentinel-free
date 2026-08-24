import { getGlobalRiskContext } from "../../../lib/global-risk";
import { requireApiAccount } from "../../api-auth";

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  try {
    return Response.json(await getGlobalRiskContext(), {
      headers: { "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=900" },
    });
  } catch {
    return Response.json({ observedAt: Date.now(), error: "全局风险源暂不可用" }, { status: 503 });
  }
}
