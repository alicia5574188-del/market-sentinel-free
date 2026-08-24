import { runMarketScan } from "../../../../lib/scanner";
import { getRuntimeBindings } from "../../../../lib/runtime-bindings";
import { resolveVapidConfig } from "../../../../lib/vapid-config";
import { requireApiAccount } from "../../../api-auth";

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return origin === new URL(request.url).origin || request.headers.get("sec-fetch-site") === "same-origin";
}

export async function POST(request: Request) {
  const bindings = getRuntimeBindings();
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const tokenAuthorized = Boolean(bindings.SCAN_TOKEN && token === bindings.SCAN_TOKEN);
  if (!tokenAuthorized) {
    const auth = await requireApiAccount();
    if ("response" in auth) return auth.response;
    if (auth.account.role !== "owner") return Response.json({ error: "只有站点所有者可以手动触发深度扫描" }, { status: 403 });
    if (!sameOrigin(request)) return Response.json({ error: "unauthorized scanner trigger" }, { status: 401 });
  }
  const vapid = resolveVapidConfig(bindings);
  try {
    const freeBackground = bindings.BACKGROUND_MODE === "cloudflare-free";
    return Response.json(await runMarketScan(vapid, freeBackground ? {
      profile: "free-background",
      deepLimit: 3,
      rotationOffset: Math.floor(Date.now() / 60_000),
    } : undefined), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "scanner failed" }, { status: 503 });
  }
}
