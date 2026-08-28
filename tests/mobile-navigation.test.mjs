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

test("iOS bottom navigation is protected from ancestor containing-block regressions", async () => {
  const [layout, fix] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/bottom-nav-viewport-fix.css", import.meta.url), "utf8"),
  ]);
  const rootBlock = fix.match(/html,\s*body\s*\{([^}]*)\}/s)?.[1] ?? "";
  const navBlock = fix.match(/\.bottom-nav,\s*body\s*>\s*\.bottom-nav\s*\{([^}]*)\}/s)?.[1] ?? "";

  assert.match(layout, /import "\.\/runtime-stability\.css";\s*import "\.\/bottom-nav-viewport-fix\.css";/);
  assert.match(rootBlock, /transform:\s*none\s*!important/);
  assert.match(rootBlock, /filter:\s*none\s*!important/);
  assert.match(rootBlock, /perspective:\s*none\s*!important/);
  assert.match(rootBlock, /contain:\s*none\s*!important/);
  assert.match(navBlock, /position:\s*fixed\s*!important/);
  assert.match(navBlock, /bottom:\s*0\s*!important/);
  assert.match(navBlock, /z-index:\s*2147483000\s*!important/);
  assert.match(fix, /@media \(min-width:\s*680px\)[\s\S]*bottom:\s*24px\s*!important/);
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

test("iPhone PWA keeps APIs network-only, bounds navigation stalls and never replays stale dynamic app HTML", async () => {
  const sw = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(sw, /market-sentinel-shell-v7/);
  assert.match(sw, /RECOVERY_URL = "\/recovery\.html"/);
  assert.match(sw, /NAVIGATION_TIMEOUT_MS = 5_000/);
  assert.match(sw, /navigationFetch/);
  assert.match(sw, /new AbortController\(\)/);
  assert.match(sw, /"\/sentinel-runtime-guard\.js"/);
  assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(sw, /url\.pathname === "\/__health"/);
  assert.match(sw, /if \(!isNavigation\) return/);
  assert.match(sw, /if \(transientEdgeFailure\) return recoveryResponse\(\)/);
  assert.doesNotMatch(sw, /caches\.match\("\/"\)/);
  assert.doesNotMatch(sw, /cache\.put\([^\n]*"\/"/);
});

test("installed PWA metadata points at the production Worker origin", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /metadataBase: new URL\("https:\/\/market-sentinel-free\.alicia5574188\.workers\.dev"\)/);
  assert.doesNotMatch(layout, /market-sentinel\.alicia5574188\.chatgpt\.site/);
});
