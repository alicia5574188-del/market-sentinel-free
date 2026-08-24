import { getRuntimeBindings } from "../../../../lib/runtime-bindings";
import { resolveVapidConfig } from "../../../../lib/vapid-config";
import { requireApiAccount } from "../../../api-auth";

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  const vapid = resolveVapidConfig(getRuntimeBindings());
  if (!vapid) return Response.json({ available: false, error: "推送密钥尚未激活" }, { status: 503 });
  return Response.json({ available: true, publicKey: vapid.publicKey }, { headers: { "Cache-Control": "private, max-age=3600" } });
}
