import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { userAccounts } from "../db/schema";
import { getRuntimeBindings } from "./runtime-bindings";
import { normalizeAccountEmail } from "./account-identity";

export { normalizeAccountEmail } from "./account-identity";

export type UserAccount = typeof userAccounts.$inferSelect;

function accountRole(email: string): "owner" | "member" {
  const ownerEmail = getRuntimeBindings().SITE_OWNER_EMAIL;
  return ownerEmail && normalizeAccountEmail(ownerEmail) === email ? "owner" : "member";
}

export async function ensureUserAccount(input: { email: string; displayName: string }) {
  const db = getDb();
  const email = normalizeAccountEmail(input.email);
  const displayName = input.displayName.trim() || email;
  const now = Date.now();
  const role = accountRole(email);
  const [existing] = await db.select().from(userAccounts).where(eq(userAccounts.email, email)).limit(1);

  if (existing) {
    if (existing.status !== "active") throw new Error("账户不可用，请联系站点管理员");
    if (existing.displayName !== displayName || existing.role !== role || now - existing.lastSeenAt >= 15 * 60_000) {
      await db.update(userAccounts).set({ displayName, role, lastSeenAt: now }).where(eq(userAccounts.id, existing.id));
      return { ...existing, displayName, role, lastSeenAt: now };
    }
    // The normal hot path is read-only and now needs one D1 lookup instead of
    // selecting the same account twice for every API poll.
    return existing;
  }

  await db.insert(userAccounts).values({
    id: crypto.randomUUID(),
    email,
    displayName,
    role,
    status: "active",
    createdAt: now,
    lastSeenAt: now,
  }).onConflictDoNothing();

  // Only the first-login/concurrent-create path needs a second read.
  const [account] = await db.select().from(userAccounts).where(eq(userAccounts.email, email)).limit(1);
  if (!account || account.status !== "active") throw new Error("账户不可用，请联系站点管理员");
  return account;
}
