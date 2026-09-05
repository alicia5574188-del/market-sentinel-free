import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Resonance stays compact on iPhone and expands on desktop", async () => {
  const css = await readFile(new URL("../app/resonance.css", import.meta.url), "utf8");
  assert.match(css, /\.rz-shell \{ width: min\(920px, 100%\)/);
  assert.match(css, /\.rz-memory-grid, \.rz-metric-grid, \.rz-econ-grid/);
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0,1fr\)\)/);
  assert.match(css, /@media \(min-width: 720px\)[\s\S]*\.rz-metric-grid \{ grid-template-columns: repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.rz-memory-grid \{ grid-template-columns: 1fr/);
});

test("new layout mounts one page tree and only Resonance UI styles", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.equal(layout.match(/\{children\}/g)?.length, 1);
  assert.match(layout, /<body>[\s\S]*<ResonanceOperatorControls \/>[\s\S]*\{children\}[\s\S]*<\/body>/);
  assert.match(layout, /import "\.\/resonance\.css"/);
  assert.doesNotMatch(layout, /hte31\.css|hte31-chart\.css|hte31-economics\.css|human-trader\.css|strategy-2-unified\.css|runtime-stability\.css|bottom-nav-viewport-fix\.css/);
});
