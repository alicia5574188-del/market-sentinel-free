import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("single-symbol market route isolates optional data failures", async () => {
  const route = await readFile(new URL("../app/api/market/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /new URL\(request\.url\)/);
  assert.match(route, /new URLSearchParams\(query\)/);
  assert.match(route, /Promise\.allSettled/);
  assert.match(route, /optionalSourceErrors/);
  assert.match(route, /contractPreview[\s\S]*try[\s\S]*previewDecisionContract[\s\S]*catch/);
});
