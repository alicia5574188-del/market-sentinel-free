import { getRuntimeBindings } from "../../../../lib/runtime-bindings";
import { resolveVapidConfig } from "../../../../lib/vapid-config";
import { sendAllPush } from "../../../../lib/web-push";
import { requireApiAccount } from "../../../api-auth";

export async function POST(request: Request) {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "cross-origin request rejected" }, { status: 403 });
  const config = resolveVapidConfig(getRuntimeBindings());
  if (!config) return Response.json({ error: "推送服务尚未激活" }, { status: 503 });
  try {
    const result = await sendAllPush({ title: "Market Sentinel 测试提醒", body: "推送链路正常。正式提醒会同时给出证据、反证与失效条件。", url: "/", tag: "market-sentinel-test" }, config, auth.account.id);
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "测试推送失败" }, { status: 503 });
  }
}
