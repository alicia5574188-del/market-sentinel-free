import test from "node:test";
import assert from "node:assert/strict";
import { chatGPTSignInPath, chatGPTSignOutPath } from "../lib/auth-paths.ts";
import { normalizeAccountEmail } from "../lib/account-identity.ts";

test("邮箱账户统一按小写和去空格保存", () => {
  assert.equal(normalizeAccountEmail("  User.Name+Tag@Example.COM "), "user.name+tag@example.com");
});

test("登录和退出只能返回站内安全路径", () => {
  assert.equal(chatGPTSignInPath("/?symbol=BTC_USDT"), "/signin-with-chatgpt?return_to=%2F%3Fsymbol%3DBTC_USDT");
  assert.equal(chatGPTSignOutPath("https://evil.example/"), "/signout-with-chatgpt?return_to=%2F");
  assert.equal(chatGPTSignOutPath("//evil.example/"), "/signout-with-chatgpt?return_to=%2F");
});
