import { disablePushSubscription, savePushSubscription } from "../../../../lib/repository";
import { requireApiAccount } from "../../../api-auth";

type SubscriptionPayload = { endpoint?: string; keys?: { p256dh?: string; auth?: string } };

function valid(payload: SubscriptionPayload): payload is { endpoint: string; keys: { p256dh: string; auth: string } } {
  if (!payload.endpoint || !payload.keys?.p256dh || !payload.keys.auth) return false;
  try { return new URL(payload.endpoint).protocol === "https:"; } catch { return false; }
}

export async function POST(request: Request) {
  const accountAuth = await requireApiAccount();
  if ("response" in accountAuth) return accountAuth.response;
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "cross-origin subscription rejected" }, { status: 403 });
    const payload = await request.json() as SubscriptionPayload;
    if (!valid(payload)) return Response.json({ error: "无效推送订阅" }, { status: 400 });
    const id = await savePushSubscription(payload, request.headers.get("user-agent"), accountAuth.account.id);
    return Response.json({ subscribed: true, id }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "推送订阅失败" }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const accountAuth = await requireApiAccount();
  if ("response" in accountAuth) return accountAuth.response;
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "cross-origin subscription rejected" }, { status: 403 });
    const payload = await request.json() as { endpoint?: string };
    if (!payload.endpoint) return Response.json({ error: "endpoint required" }, { status: 400 });
    try {
      if (new URL(payload.endpoint).protocol !== "https:") throw new Error("invalid endpoint");
    } catch {
      return Response.json({ error: "invalid endpoint" }, { status: 400 });
    }
    await disablePushSubscription(payload.endpoint, accountAuth.account.id);
    return Response.json({ subscribed: false });
  } catch {
    return Response.json({ error: "取消订阅失败" }, { status: 503 });
  }
}
