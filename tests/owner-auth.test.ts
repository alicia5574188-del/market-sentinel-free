import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerSession, OWNER_SESSION_TTL_SECONDS, ownerPasswordMatches, ownerSessionCookie, sameOriginMutation, verifyOwnerSession } from "../lib/owner-auth.ts";

const secret = "owner-access-token-long-enough-for-tests";

test("owner password verification and signed HttpOnly session are fail closed", async () => {
  assert.equal(await ownerPasswordMatches(secret, secret), true);
  assert.equal(await ownerPasswordMatches("wrong-password-value", secret), false);
  const now = Date.now();
  const session = await createOwnerSession(secret, now);
  const cookie = ownerSessionCookie(session);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, new RegExp(`Max-Age=${30 * 24 * 60 * 60}`));
  assert.equal(OWNER_SESSION_TTL_SECONDS, 30 * 24 * 60 * 60);
  const request = new Request("https://sentinel.example/api/runtime", { headers: { Cookie: cookie.split(";")[0] } });
  assert.equal(await verifyOwnerSession(request, secret, now + 1_000), true);
  assert.equal(await verifyOwnerSession(request, "another-owner-access-token-long-enough", now + 1_000), false);
  assert.equal(await verifyOwnerSession(request, secret, now + 29 * 24 * 60 * 60_000), true);
  assert.equal(await verifyOwnerSession(request, secret, now + 31 * 24 * 60 * 60_000), false);
});

test("state-changing requests require same-origin JSON", () => {
  assert.equal(sameOriginMutation(new Request("https://sentinel.example/api/live/mode", {
    method: "POST", headers: { Origin: "https://sentinel.example", "Content-Type": "application/json" }, body: "{}",
  })), true);
  assert.equal(sameOriginMutation(new Request("https://sentinel.example/api/live/mode", {
    method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}",
  })), false);
});
