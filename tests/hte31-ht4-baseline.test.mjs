import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("HT4 is a normal strategy family without a frozen-source exception", async () => {
  const [catalog, trading] = await Promise.all([
    readFile(new URL("../lib/hte31-strategy-catalog.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/resonance-trading.ts", import.meta.url), "utf8"),
  ]);
  assert.match(catalog, /id: "exhaustion_reversal"[\s\S]*?familyId: "SF04"[\s\S]*?variantId: "BASE"/);
  assert.doesNotMatch(trading, /HT4[^\n]*(?:frozen|冻结|priority|优先)/i);
});

test("router contains no strategy-specific HT4 ranking branch", async () => {
  const source = await readFile(new URL("../lib/hte31-strategy-router.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /exhaustion_reversal|trend_exhaustion_reversal|HT4/);
});
