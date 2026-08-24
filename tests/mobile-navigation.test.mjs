import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("iPhone bottom navigation stays outside the scrolling app shell", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<\/main>\s*<nav className="bottom-nav"/);
  assert.doesNotMatch(page, /<main className="app-shell">[\s\S]*<nav className="bottom-nav"[\s\S]*<\/main>/);
});

test("bottom navigation uses a viewport-fixed, transform-free iOS layout", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const block = css.match(/\.bottom-nav\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(block, /position:\s*fixed/);
  assert.match(block, /inset-inline:\s*0/);
  assert.match(block, /bottom:\s*0/);
  assert.doesNotMatch(block, /transform|backdrop-filter/);
  assert.match(css, /\.app-shell\s*\{[^}]*padding:[^;]*calc\(88px \+ env\(safe-area-inset-bottom\)\)/s);
});
