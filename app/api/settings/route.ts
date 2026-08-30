import { getSettings, publicSettings, updateSettings } from "../../../lib/settings-repository";
import { requireApiAccount } from "../../api-auth";

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  try {
    return Response.json(publicSettings(await getSettings()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "设置不可用" }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  if (auth.account.role !== "owner") return Response.json({ error: "只有站点所有者可以修改系统监测参数" }, { status: 403 });
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "cross-origin update rejected" }, { status: 403 });
    const payload = await request.json() as Record<string, unknown>;
    const settings = await updateSettings(payload as Parameters<typeof updateSettings>[0]);
    return Response.json(publicSettings(settings));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "设置保存失败" }, { status: 400 });
  }
}
