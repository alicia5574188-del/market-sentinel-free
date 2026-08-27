import { getChatGPTUser } from "./chatgpt-auth";
import { ensureUserAccount, type UserAccount } from "../lib/user-accounts";

export type ApiAccount = Pick<UserAccount, "id" | "email" | "displayName" | "role" | "status" | "createdAt" | "lastSeenAt">;

export async function requireApiAccount(): Promise<{ account: ApiAccount } | { response: Response }> {
  try {
    const user = await getChatGPTUser();
    if (!user) {
      return { response: Response.json({ error: "请先使用邮箱账户登录" }, { status: 401, headers: { "Cache-Control": "no-store" } }) };
    }
    return { account: await ensureUserAccount({ email: user.email, displayName: user.displayName }) };
  } catch (error) {
    // Keep the shared API authentication boundary inside the JSON contract.
    // If the framework request-context or D1 account lookup is temporarily
    // unavailable, every API caller receives a deterministic 503 JSON body
    // instead of an HTML/Vinext error page that iOS cannot safely parse.
    return { response: Response.json({ error: error instanceof Error ? error.message : "账户暂不可用" }, { status: 503, headers: { "Cache-Control": "no-store" } }) };
  }
}

export function accountFrom(result: Awaited<ReturnType<typeof requireApiAccount>>) {
  return "account" in result ? result.account : null;
}
