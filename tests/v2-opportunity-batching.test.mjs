import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Strategy 2.0 opportunity persistence batches D1 inserts", async () => {
  const repository = await readFile(new URL("../lib/sentinel-v2-repository.ts", import.meta.url), "utf8");
  assert.match(repository, /const V2_OPPORTUNITY_BATCH_SIZE = 4/);
  assert.match(repository, /index \+= V2_OPPORTUNITY_BATCH_SIZE/);
  assert.match(repository, /rows\.slice\(index, index \+ V2_OPPORTUNITY_BATCH_SIZE\)/);
  assert.doesNotMatch(repository, /values\(opportunities\.map\(/);
});
