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

test("iPhone pull-to-refresh performs one genuine full refresh without starting a deep scan", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const refreshBlock = page.match(/const performPullRefresh = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[refreshPositions, refreshVisibleData\]\);/)?.[1] ?? "";

  assert.match(page, /PULL_REFRESH_TRIGGER_PX\s*=\s*68/);
  assert.match(page, /document\.addEventListener\("touchmove", onTouchMove, \{ passive: false \}\)/);
  assert.match(page, /window\.addEventListener\("pageshow", syncVisibleData\)/);
  assert.match(page, /className=\{`pull-refresh \$\{pullRefreshState\}/);
  assert.match(refreshBlock, /pullRefreshRunning\.current/);
  assert.match(refreshBlock, /await refreshPositions\(\)/);
  assert.match(refreshBlock, /await refreshVisibleData\(\)/);
  assert.doesNotMatch(refreshBlock, /runDeepScan/);
  assert.match(css, /overscroll-behavior-y:\s*none/);
  assert.match(css, /\.pull-refresh\.refreshing svg\s*\{[^}]*animation:\s*pull-refresh-spin/s);
});

test("iPhone PWA never replaces API JSON with the cached app shell", async () => {
  const sw = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(sw, /market-sentinel-shell-v4/);
  assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(sw, /url\.pathname === "\/__health"/);
  assert.match(sw, /if \(!isNavigation && !isShellAsset\) return/);
  assert.doesNotMatch(sw, /caches\.match\(event\.request\)[\s\S]*caches\.match\("\/"\)/);
});

test("installed PWA metadata points at the production Worker origin", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /metadataBase: new URL\("https:\/\/market-sentinel-free\.alicia5574188\.workers\.dev"\)/);
  assert.doesNotMatch(layout, /market-sentinel\.alicia5574188\.chatgpt\.site/);
});
