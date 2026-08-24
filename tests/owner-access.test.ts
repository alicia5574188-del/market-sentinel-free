import assert from "node:assert/strict";
import test from "node:test";
import {
  OWNER_COOKIE_NAME,
  accessCodeMatches,
  clearOwnerCookie,
  cookieValue,
  ownerCookie,
  ownerSessionMatches,
  ownerSessionValue,
  validOwnerAccessToken,
} from "../lib/owner-access.ts";
import { deriveVapidConfig, resolveVapidConfig } from "../lib/vapid-config.ts";
import { base64UrlToBytes } from "../lib/web-push-crypto.ts";

test("Cloudflare 所有者访问码使用摘要恒定时间核验", async () => {
  assert.equal(await accessCodeMatches("correct-code", "correct-code"), true);
  assert.equal(await accessCodeMatches("wrong-code", "correct-code"), false);
});

test("所有者会话 Cookie 不包含原始访问码且可撤销", async () => {
  const secret = "a-long-random-owner-access-code";
  const session = await ownerSessionValue(secret);
  assert.equal(session.includes(secret), false);
  const header = ownerCookie(session);
  assert.equal(cookieValue(header, OWNER_COOKIE_NAME), session);
  assert.equal(await ownerSessionMatches(header, secret), true);
  assert.equal(await ownerSessionMatches(header, `${secret}-changed`), false);
  assert.match(clearOwnerCookie(), /Max-Age=0/);
});

test("Cloudflare 手机部署拒绝过短访问码", () => {
  assert.equal(validOwnerAccessToken("short"), false);
  assert.equal(validOwnerAccessToken("1234567890abcdef"), true);
});

test("单个所有者访问码稳定派生合法 VAPID P-256 密钥", async () => {
  const secret = "phone-only-owner-secret-2026";
  const first = deriveVapidConfig(secret);
  const second = resolveVapidConfig({ OWNER_ACCESS_TOKEN: secret });
  assert.deepEqual(second, first);
  assert.equal(base64UrlToBytes(first.publicKey).length, 65);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(first.privateJwk),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode("market-sentinel"),
  );
  assert.equal(signature.byteLength > 0, true);
});
