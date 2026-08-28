import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Human Trader mobile navigation is one fixed five-tab control", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/human-trader.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /const TABS: Tab\[\] = \["总览", "雷达", "订单", "实盘", "设置"\]/);
  assert.match(page, /<nav className="hte-bottom-nav"/);
  const navBlock = css.match(/\.hte-bottom-nav\s*\{([^}]*)\}/s)?.[1] ?? "";
  assert.match(navBlock, /position:\s*fixed/);
  assert.match(navBlock, /grid-template-columns:\s*repeat\(5/);
  assert.match(navBlock, /env\(safe-area-inset-bottom\)/);
});

test("iPhone uses native vertical scrolling and never installs a touchmove scroll trap", async () => {
  const [page, css, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/human-trader.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);
  const rootBlock = css.match(/html,\s*\nbody\s*\{([^}]*)\}/s)?.[1] ?? "";
  assert.match(rootBlock, /overflow-y:\s*auto\s*!important/);
  assert.match(rootBlock, /touch-action:\s*pan-y/);
  assert.match(rootBlock, /-webkit-overflow-scrolling:\s*touch/);
  assert.doesNotMatch(page, /touchmove|preventDefault\(\)|PULL_REFRESH_TRIGGER_PX/);
  assert.doesNotMatch(layout, /RuntimeStabilityClient|Strategy2Dashboard|Strategy2PlaybookDiagnostics|Strategy2LearningArena|UiStatusSemanticFix|LiveOrdersInline/);
});

test("main dashboard has one orchestrated poll and live polling starts only on the live tab", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /readJson<HteSnapshot>\("\/api\/hte"\)/);
  assert.match(page, /20_000/);
  assert.match(page, /if \(tab !== "实盘" \|\| snapshot\?\.account\.role !== "owner"\) return/);
  assert.match(page, /readJson<LiveSnapshot>\("\/api\/live\/status"\)/);
  assert.match(page, /15_000/);
});

test("installed PWA metadata points at the production Worker origin", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /metadataBase: new URL\("https:\/\/market-sentinel-free\.alicia5574188\.workers\.dev"\)/);
  assert.doesNotMatch(layout, /market-sentinel\.alicia5574188\.chatgpt\.site/);
});
