import { requireApiAccount } from "../api-auth";

export const dynamic = "force-dynamic";

export async function retiredLegacyApi() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  return Response.json({
    error: "该旧策略接口已退役；HTE 3.1 Clean 是唯一生产交易权威。",
    replacement: "/api/hte31",
  }, {
    status: 410,
    headers: { "Cache-Control": "no-store" },
  });
}
