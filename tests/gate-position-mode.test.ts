import assert from "node:assert/strict";
import test from "node:test";
import type { GatePrivateClient } from "../lib/gate-private.ts";
import { switchGateToSinglePositionMode } from "../lib/gate-position-mode.ts";

function fakeClient(input: { withPosition?: boolean; withOrder?: boolean }) {
  let mode = "dual";
  const requests: { method: string; path: string; positionMode: unknown }[] = [];
  const client = {
    async futuresAccount() {
      return { position_mode: mode };
    },
    async positions() {
      return input.withPosition ? [{ size: "1" }] : [];
    },
    async openOrders() {
      return input.withOrder ? [{ id: "1" }] : [];
    },
    async priceOrders() {
      return [];
    },
    async request(method: string, path: string, options: { query?: Record<string, unknown> }) {
      requests.push({ method, path, positionMode: options.query?.position_mode });
      if (path.endsWith("/set_position_mode") && options.query?.position_mode === "single") mode = "single";
      return {};
    },
  } as unknown as GatePrivateClient;
  return { client, requests };
}

test("empty Gate futures account can switch from hedge to one-way mode", async () => {
  const { client, requests } = fakeClient({});
  const result = await switchGateToSinglePositionMode(client);
  assert.deepEqual(result, { changed: true, positionMode: "single" });
  assert.deepEqual(requests, [{ method: "POST", path: "/futures/usdt/set_position_mode", positionMode: "single" }]);
});

test("position mode switch is refused while Gate has a position or pending order", async () => {
  const withPosition = fakeClient({ withPosition: true });
  await assert.rejects(() => switchGateToSinglePositionMode(withPosition.client), /持仓或挂单/);
  assert.equal(withPosition.requests.length, 0);

  const withOrder = fakeClient({ withOrder: true });
  await assert.rejects(() => switchGateToSinglePositionMode(withOrder.client), /持仓或挂单/);
  assert.equal(withOrder.requests.length, 0);
});
