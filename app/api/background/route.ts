import { ensureBackgroundSchedulers } from "../../../lib/background-scheduler";
import { requireApiAccount } from "../../api-auth";

export async function GET() {
  const auth = await requireApiAccount();
  if ("response" in auth) return auth.response;
  return Response.json(await ensureBackgroundSchedulers(), {
    headers: { "Cache-Control": "no-store" },
  });
}
