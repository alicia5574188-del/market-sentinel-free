import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeUrl = new URL("../app/api/live/preflight/route.ts", import.meta.url);
const helperUrl = new URL("../lib/live-cutover-preflight.ts", import.meta.url);
const summaryUrl = new URL("../lib/live-cutover-summary.ts", import.meta.url);

test("Gate cutover preflight is owner-authenticated, GET-only, and never writes D1", async () => {
  const [route, helper, summary] = await Promise.all([
    readFile(routeUrl, "utf8"),
    readFile(helperUrl, "utf8"),
    readFile(summaryUrl, "utf8"),
  ]);

  assert.match(route, /export async function GET\(\)/);
  assert.doesNotMatch(route, /export async function (?:POST|PUT|PATCH|DELETE)/);
  assert.match(route, /requireApiViewer/);
  assert.match(route, /role !== "owner"/);
  assert.match(route, /Cache-Control": "no-store"/);

  assert.match(summary, /client\.positions\(true\)/);
  assert.match(summary, /client\.openOrders\(\)/);
  assert.match(summary, /client\.priceOrders\("open"\)/);
  assert.doesNotMatch(`${helper}\n${summary}`, /client\.(?:createOrder|cancelOrder|cancelAllOrders|createPriceOrder|cancelPriceOrder|cancelAllPriceOrders|setIsolatedLeverage)\s*\(/);
  assert.doesNotMatch(helper, /getDb\(\)\.(?:insert|update|delete)\s*\(/);
});

test("Gate client methods used by cutover preflight are signed GET requests", async () => {
  const client = await readFile(new URL("../lib/gate-private.ts", import.meta.url), "utf8");
  assert.match(client, /positions\(holding = true\)[\s\S]*?this\.request<GatePosition\[\]>\("GET"/);
  assert.match(client, /openOrders\(contract\?: string\)[\s\S]*?this\.request<GateFuturesOrder\[\]>\("GET"/);
  assert.match(client, /priceOrders\(status:[\s\S]*?this\.request<GatePriceOrder\[\]>\("GET"/);
});
