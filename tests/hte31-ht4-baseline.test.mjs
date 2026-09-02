import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("HT4 Exhaustion source remains frozen while other strategies are challenged", async () => {
  const source = await readFile(new URL("../lib/hte31-advanced-traders.ts", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("function exhaustion("), source.indexOf("function higherTimeframeSwing("));
  assert.equal(createHash("sha256").update(block).digest("hex"), "05adae71b2c1169c441e409d831ceb5acbec1390f5b051a5cb18f7a7af8389a3");
});

test("research strategy module cannot redefine or wrap HT4", async () => {
  const source = await readFile(new URL("../lib/hte31-research-strategies.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /trend_exhaustion_reversal|HT4_EXHAUSTION_ANTI_CROWD/);
});
