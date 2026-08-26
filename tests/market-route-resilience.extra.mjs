import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("market route keeps Gate core live when optional enrichments fail", async () => {
  const route = await readFile(new URL("../app/api/market/route.ts", import.meta.url), "utf8");
  assert.match(route, /Promise\.allSettled/);
  assert.match(route, /optionalSourceErrors/);
  assert.match(route, /globalResult\.status === "rejected"/);
  assert.match(route, /v2OpportunityResult\.status === "rejected"/);
  assert.match(route, /contractPreview[\s\S]*try[\s\S]*previewDecisionContract[\s\S]*catch/);
});
