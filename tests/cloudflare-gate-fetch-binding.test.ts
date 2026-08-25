import assert from "node:assert/strict";
import test from "node:test";
import { GatePrivateClient } from "../lib/gate-private.ts";

test("Gate private client preserves the Cloudflare Worker global receiver for fetch", async () => {
  let receiver: unknown = null;
  const hostSensitiveFetch = function (this: unknown, _input: string | URL | Request, _init?: RequestInit) {
    receiver = this;
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(Response.json({ total: "100", available: "100", position_mode: "single" }));
  } as typeof fetch;

  const client = new GatePrivateClient({
    apiKey: "api_key_123456",
    apiSecret: "api_secret_123456",
    environment: "live",
  }, hostSensitiveFetch);

  const account = await client.futuresAccount();
  assert.equal(receiver, globalThis);
  assert.equal(account.total, "100");
});
