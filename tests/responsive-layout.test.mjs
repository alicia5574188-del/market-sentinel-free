import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Human Trader dashboard is mobile-first and expands to desktop grids", async () => {
  const css = await readFile(new URL("../app/human-trader.css", import.meta.url), "utf8");
  assert.match(css, /\.hte-content\s*\{[^}]*width:\s*min\(1240px/s);
  assert.match(css, /\.hte-hero\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.45fr\)\s*minmax\(300px,\s*0\.55fr\)/s);
  assert.match(css, /\.hte-trader-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3/s);
  const tablet = css.match(/@media \(max-width:\s*900px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(tablet, /\.hte-hero,[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(tablet, /\.hte-trader-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
  const phone = css.match(/@media \(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(phone, /\.hte-hero-grid,[\s\S]*grid-template-columns:\s*repeat\(2/s);
  assert.match(phone, /\.hte-bottom-nav\s*\{[^}]*width:\s*calc\(100% - 12px\)/s);
});

test("new layout mounts only one React page tree", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /<body>\{children\}<\/body>/);
  assert.match(layout, /import "\.\/human-trader\.css"/);
  assert.doesNotMatch(layout, /strategy-2-unified\.css|strategy-2-learning-arena\.css|runtime-stability\.css|bottom-nav-viewport-fix\.css/);
});
