import assert from "node:assert/strict";
import test from "node:test";
import { GateApiError, GatePrivateClient } from "../lib/gate-private.ts";

const credentials = {
  apiKey: "api_key_123456",
  apiSecret: "api_secret_123456",
  environment: "live" as const,
};

test("Gate private client preserves the Cloudflare Worker global receiver for fetch", async () => {
  let receiverWasGlobal = false;
  const hostSensitiveFetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
    void args;
    receiverWasGlobal = this === globalThis;
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(Response.json({ total: "100", available: "100", position_mode: "single" }));
  } as typeof fetch;

  const client = new GatePrivateClient(credentials, hostSensitiveFetch);
  const account = await client.futuresAccount();
  assert.equal(receiverWasGlobal, true);
  assert.equal(account.total, "100");
});

test("Gate private client retries one transient GET but never replays a mutation", async () => {
  let readCalls = 0;
  const readFetch = (async () => {
    readCalls += 1;
    if (readCalls === 1) return Response.json({ label: "TEMPORARY", message: "try again" }, { status: 503 });
    return Response.json({ total: "100", available: "100", position_mode: "single" });
  }) as typeof fetch;
  const readClient = new GatePrivateClient(credentials, readFetch);
  const account = await readClient.futuresAccount();
  assert.equal(readCalls, 2);
  assert.equal(account.total, "100");

  let mutationCalls = 0;
  const mutationFetch = (async () => {
    mutationCalls += 1;
    return Response.json({ label: "TEMPORARY", message: "do not replay" }, { status: 503 });
  }) as typeof fetch;
  const mutationClient = new GatePrivateClient(credentials, mutationFetch);
  await assert.rejects(
    mutationClient.createOrder({ contract: "BTC_USDT", size: "1", price: "0" }),
    (error: unknown) => error instanceof GateApiError && error.status === 503,
  );
  assert.equal(mutationCalls, 1);
});
