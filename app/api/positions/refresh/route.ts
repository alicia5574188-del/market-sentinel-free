import { refreshOpenPositions } from "../../../../lib/scanner";
import { getRuntimeBindings } from "../../../../lib/runtime-bindings";
import { resolveVapidConfig } from "../../../../lib/vapid-config";
import { requireApiAccount } from "../../../api-auth";

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return origin === new URL(request.url).origin || request.headers.get("sec-fetch-site") === "same-origin";
}

export async function POST(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  if (!sameOrigin(request)) return Response.json({ error: "unauthorized position refresh" }, { status: 401 });
  const bindings = getRuntimeBindings();
  const vapid = resolveVapidConfig(bindings);
  try {
    return Response.json(await refreshOpenPositions(vapid), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "position refresh failed" }, { status: 503 });
  }
}
