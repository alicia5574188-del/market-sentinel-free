import { resetHte31PaperCapital } from "../../../../lib/hte31-repository";
import { getSettings } from "../../../../lib/settings-repository";
import { requireApiAccount } from "../../../api-auth";

export async function POST(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  if (auth.account.role !== "owner") return Response.json({ error: "只有站点所有者可以重置模拟本金" }, { status: 403 });
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "cross-origin update rejected" }, { status: 403 });
    const payload = await request.json() as { confirmed?: boolean };
    if (payload.confirmed !== true) return Response.json({ error: "需要确认重置模拟本金" }, { status: 400 });
    const settings = await getSettings();
    const reset = await resetHte31PaperCapital(settings.trialCapitalUsdt);
    return Response.json({ ok: true, reset }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "模拟本金重置失败" }, { status: 400 });
  }
}
