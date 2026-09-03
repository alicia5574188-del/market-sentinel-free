import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Resonance mobile navigation is one fixed five-tab control", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/resonance.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /const NAV: Tab\[\] = \["机会", "雷达", "订单", "实盘", "设置"\]/);
  assert.doesNotMatch(page, /const NAV: Tab\[\][^\n]+学习/);
  assert.match(page, /<nav className="rz-nav"/);
  const navBlock = css.match(/\.rz-nav \{([^}]*)\}/s)?.[1] ?? "";
  assert.match(navBlock, /position: fixed/);
  assert.match(navBlock, /grid-template-columns: repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(navBlock, /env\(safe-area-inset-bottom\)/);
});

test("switching tabs returns the document to the top", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /window\.scrollTo\(0, 0\);/);
  assert.match(page, /\}, \[tab, strategyCenterOpen\]\);/);
});

test("iPhone keeps native vertical scrolling with no document touch trap", async () => {
  const [page, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /(?:document|window)\s*\.\s*addEventListener\s*\(\s*["']touchmove|MutationObserver|createPortal|PULL_REFRESH_TRIGGER_PX/);
  assert.doesNotMatch(layout, /RuntimeStabilityClient|Strategy2Dashboard|Strategy2PlaybookDiagnostics|Strategy2LearningArena|UiStatusSemanticFix|LiveOrdersInline/);
});

test("dashboard has one main poll and live polling only on live tab", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /readJson<Snapshot>\("\/api\/hte31"\)/);
  assert.match(page, /MAIN_REFRESH_MS = 30_000/);
  assert.match(page, /最近可信快照/);
  assert.match(page, /后台扫描与持仓保护独立运行/);
  assert.match(page, /if \(tab !== "实盘"\) return/);
  assert.match(page, /readJson<LiveSnapshot>\("\/api\/live\/status"\)/);
  assert.match(page, /20_000/);
  assert.doesNotMatch(page, /\/api\/hte["']/);
});

test("installed PWA metadata points at production Worker origin", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /metadataBase: new URL\("https:\/\/market-sentinel-free\.alicia5574188\.workers\.dev"\)/);
  assert.match(layout, /applicationName: "Resonance"/);
});
