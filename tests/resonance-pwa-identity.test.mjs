import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("installed app uses Resonance name and icon", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.equal(manifest.name, "Resonance 自适应交易系统");
  assert.equal(manifest.short_name, "Resonance");
  assert.equal(manifest.icons?.[0]?.src, "/resonance-icon-v1.svg");
  assert.doesNotMatch(JSON.stringify(manifest), /行情哨兵|Market Sentinel/);
  assert.match(layout, /apple:\s*"\/resonance-icon-v1\.svg"/);
});
