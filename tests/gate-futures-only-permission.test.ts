import assert from "node:assert/strict";
import test from "node:test";
import { verifyGateCredentials } from "../lib/gate-private.ts";

test("Gate futures-only key does not require separate account permission", async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith("/account/detail") || url.pathname.endsWith("/account/main_keys")) {
      return Response.json({ label: "FORBIDDEN", message: "Request API key does not have account permission" }, { status: 403 });
    }
    if (url.pathname.endsWith("/futures/usdt/accounts")) {
      return Response.json({
        total: "50",
        available: "50",
        unrealised_pnl: "0",
        position_mode: "single",
        margin_mode: 0,
      });
    }
    return Response.json({ label: "NOT_FOUND" }, { status: 404 });
  };

  const verified = await verifyGateCredentials({
    apiKey: "api_key_123456",
    apiSecret: "api_secret_123456",
    environment: "live",
  }, fetcher as typeof fetch);

  assert.equal(verified.totalUsdt, 50);
  assert.equal(verified.availableUsdt, 50);
  assert.equal(verified.positionMode, "single");
  assert.equal(verified.perpetualReadWrite, null);
  assert.equal(verified.userId, null);
});
