import { requireApiAccount } from "../../api-auth";
import { chatGPTSignOutPath } from "../../chatgpt-auth";
import { getRuntimeBindings } from "../../../lib/runtime-bindings";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  return Response.json({
    ...auth.account,
    signOutPath: getRuntimeBindings().BACKGROUND_MODE === "cloudflare-free"
      ? "/__owner-logout"
      : chatGPTSignOutPath("/"),
  }, { headers: { "Cache-Control": "no-store" } });
}
