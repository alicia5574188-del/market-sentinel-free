import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("HTE 3.1 mobile navigation is one fixed five-tab control", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/hte31.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /const TABS: Tab\[\] = \["总览", "雷达", "订单", "实盘", "设置"\]/);
  assert.match(page, /<nav className="clean-nav"/);
  const navBlock = css.match(/\.clean-nav\s*\{([^}]*)\}/s)?.[1] ?? "";
  assert.match(navBlock, /position:fixed!important/);
  assert.match(navBlock, /grid-template-columns:repeat\(5,1fr\)/);
  assert.match(navBlock, /env\(safe-area-inset-bottom\)/);
});

test("iPhone uses native vertical scrolling and no document touch trap", async () => {
  const [page, css, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/hte31-chart.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(css, /overflow-y:auto!important/);
  assert.match(css, /touch-action:pan-y/);
  assert.match(css, /-webkit-overflow-scrolling:touch/);
  assert.doesNotMatch(page, /touchmove|preventDefault\(\)|MutationObserver|createPortal|PULL_REFRESH_TRIGGER_PX/);
  assert.doesNotMatch(layout, /RuntimeStabilityClient|Strategy2Dashboard|Strategy2PlaybookDiagnostics|Strategy2LearningArena|UiStatusSemanticFix|LiveOrdersInline/);
});

test("main dashboard has one clean poll and live polling only on live tab", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /readJson<CleanSnapshot>\("\/api\/hte31"\)/);
  assert.match(page, /20_000/);
  assert.match(page, /if \(tab !== "实盘"\) return/);
  assert.match(page, /readJson<LiveSnapshot>\("\/api\/live\/status"\)/);
  assert.match(page, /12_000/);
  assert.doesNotMatch(page, /\/api\/hte["']/);
});

test("installed PWA metadata points at production Worker origin", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /metadataBase: new URL\("https:\/\/market-sentinel-free\.alicia5574188\.workers\.dev"\)/);
});
