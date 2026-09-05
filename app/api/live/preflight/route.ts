import { requireApiViewer } from "../../../api-auth";
import { cutoverPreflightTokenMatches } from "../../../../lib/cutover-preflight-auth";
import { getLiveCutoverPreflight } from "../../../../lib/live-cutover-preflight";
import { getRuntimeBindings } from "../../../../lib/runtime-bindings";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const tokenAuthorized = await cutoverPreflightTokenMatches(
    request,
    getRuntimeBindings().CUTOVER_PREFLIGHT_TOKEN,
  );
  if (!tokenAuthorized) {
    const auth = await requireApiViewer();
    if ("response" in auth) return auth.response;
    if (auth.account.role !== "owner") {
      return Response.json({ error: "只有所有者可以执行 Gate 切换预检" }, {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      });
    }
  }

  try {
    return Response.json(await getLiveCutoverPreflight(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Gate 切换预检不可用" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
