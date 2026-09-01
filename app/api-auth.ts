import { getChatGPTUser } from "./chatgpt-auth";
import { normalizeAccountEmail } from "../lib/account-identity";
import { getRuntimeBindings } from "../lib/runtime-bindings";
import { ensureUserAccount, type UserAccount } from "../lib/user-accounts";

export type ApiAccount = Pick<UserAccount, "id" | "email" | "displayName" | "role" | "status" | "createdAt" | "lastSeenAt">;
export type ApiViewer = Pick<UserAccount, "email" | "displayName" | "role">;

function unauthorized() {
  return Response.json({ error: "请先使用邮箱账户登录" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

function viewerRole(email: string): "owner" | "member" {
  const ownerEmail = getRuntimeBindings().SITE_OWNER_EMAIL;
  return ownerEmail && normalizeAccountEmail(ownerEmail) === email ? "owner" : "member";
}

/** Authenticate the read-only observer without requiring user_accounts persistence. */
export async function requireApiViewer(): Promise<{ account: ApiViewer } | { response: Response }> {
  try {
    const user = await getChatGPTUser();
    if (!user) return { response: unauthorized() };
    const email = normalizeAccountEmail(user.email);
    return {
      account: {
        email,
        displayName: user.displayName.trim() || email,
        role: viewerRole(email),
      },
    };
  } catch (error) {
    return { response: Response.json({ error: error instanceof Error ? error.message : "身份暂不可用" }, { status: 503, headers: { "Cache-Control": "no-store" } }) };
  }
}

export async function requireApiAccount(): Promise<{ account: ApiAccount } | { response: Response }> {
  try {
    const user = await getChatGPTUser();
    if (!user) return { response: unauthorized() };
    return { account: await ensureUserAccount({ email: user.email, displayName: user.displayName }) };
  } catch (error) {
    // Keep the shared API authentication boundary inside the JSON contract.
    // If the framework request-context or D1 account lookup is temporarily
    // unavailable, every account-scoped API caller receives deterministic JSON
    // instead of an HTML/Vinext error page that iOS cannot safely parse.
    return { response: Response.json({ error: error instanceof Error ? error.message : "账户暂不可用" }, { status: 503, headers: { "Cache-Control": "no-store" } }) };
  }
}

export function accountFrom(result: Awaited<ReturnType<typeof requireApiAccount>>) {
  return "account" in result ? result.account : null;
}
