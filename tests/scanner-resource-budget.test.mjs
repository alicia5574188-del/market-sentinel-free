import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("background deep targets are serialized below Cloudflare connection ceiling", async () => {
  const [scanner, gateClient] = await Promise.all([
    readFile(new URL("../lib/scanner.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/gate-client.ts", import.meta.url), "utf8"),
  ]);

  assert.match(scanner, /const DEEP_TARGET_CONCURRENCY = 1;/);
  assert.match(gateClient, /const ANALYSIS_UPSTREAM_CONCURRENCY = 4;/);
  assert.match(scanner, /const growthCandlesPromise = fetchGateChartCandles/);

  const targetConcurrency = Number(scanner.match(/const DEEP_TARGET_CONCURRENCY = (\d+);/)?.[1]);
  const upstreamConcurrency = Number(gateClient.match(/const ANALYSIS_UPSTREAM_CONCURRENCY = (\d+);/)?.[1]);
  const extraParallelCandleConnection = 1;
  const peakOutgoingConnections = targetConcurrency * (upstreamConcurrency + extraParallelCandleConnection);

  assert.ok(peakOutgoingConnections <= 6, `scanner can open ${peakOutgoingConnections} outgoing connections, above Cloudflare ceiling`);
});
