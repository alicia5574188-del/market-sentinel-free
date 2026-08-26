import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("market route parses query without URL construction", async () => {
  const route = await readFile(new URL("../app/api/market/route.ts", import.meta.url), "utf8");
  assert.match(route, /request\.url\.indexOf\("\?"\)/);
  assert.match(route, /new URLSearchParams\(query\)/);
  assert.doesNotMatch(route, /new URL\(request\.url\)/);
});
