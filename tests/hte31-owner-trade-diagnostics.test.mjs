import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("../app/api/hte31/owner-history/route.ts", import.meta.url), "utf8");
const repo = await readFile(new URL("../lib/owner-trade-diagnostics.ts", import.meta.url), "utf8");

test("owner diagnostics route is private and owner-only", () => {
  assert.match(route, /requireApiAccount\(\)/);
  assert.match(route, /auth\.account\.role !== "owner"/);
  assert.match(route, /Cache-Control": "private, no-store"/);
  assert.doesNotMatch(route, /Access-Control-Allow-Origin/);
});

test("diagnostics reads both HTE31 and legacy history without mutating it", () => {
  assert.match(repo, /from\(hte31Trades\)/);
  assert.match(repo, /from\(tradeCases\)/);
  assert.match(repo, /hte31PostExitObservations/);
  assert.match(repo, /hte31TradeCharts/);
  assert.match(repo, /buildHte31Counterfactual/);
  assert.match(repo, /hte31Learning/);
  assert.match(repo, /hte31SimulationEpochs/);
  assert.doesNotMatch(repo, /\.insert\(/);
  assert.doesNotMatch(repo, /\.update\(/);
  assert.doesNotMatch(repo, /\.delete\(/);
});

test("history supports pagination and exact-trade diagnostics", () => {
  assert.match(route, /searchParams\.get\("trade"\)/);
  assert.match(route, /searchParams\.get\("limit"\)/);
  assert.match(route, /searchParams\.get\("offset"\)/);
  assert.match(route, /source 仅支持 hte31 \/ legacy \/ all/);
  assert.match(repo, /nextOffset/);
  assert.match(repo, /entryChecks/);
  assert.match(repo, /entryMetrics/);
  assert.match(repo, /observations/);
  assert.match(repo, /counterfactual/);
});
