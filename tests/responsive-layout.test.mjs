import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("HTE 3.1 workbench stays compact on iPhone and expands on desktop", async () => {
  const css = await readFile(new URL("../app/hte31.css", import.meta.url), "utf8");
  assert.match(css, /\.clean-shell\{width:min\(100%,820px\)/);
  assert.match(css, /\.clean-trader-grid\{display:grid;grid-template-columns:repeat\(3/);
  assert.match(css, /\.account-grid\{display:grid;grid-template-columns:repeat\(4/);
  assert.match(css, /@media\(max-width:700px\)[\s\S]*\.clean-trader-grid\{grid-template-columns:1fr\}/);
  assert.match(css, /@media\(max-width:700px\)[\s\S]*\.account-grid\{grid-template-columns:1fr 1fr\}/);
  assert.match(css, /\.order-numbers\{display:grid;grid-template-columns:repeat\(4/);
});

test("new layout mounts one page tree and only clean UI styles", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /<body>\{children\}<\/body>/);
  assert.match(layout, /import "\.\/hte31\.css"/);
  assert.match(layout, /import "\.\/hte31-chart\.css"/);
  assert.doesNotMatch(layout, /human-trader\.css|strategy-2-unified\.css|runtime-stability\.css|bottom-nav-viewport-fix\.css/);
});
