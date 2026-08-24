import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("手机保持单列，电脑切换为行情与机会队列双栏", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.app-shell\s*\{[^}]*max-width:\s*480px/s);
  const desktop = css.match(/@media \(min-width:\s*960px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(desktop, /max-width:\s*1180px/);
  assert.match(desktop, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*370px/);
  assert.match(desktop, /\.opportunity-section\s*\{[^}]*grid-column:\s*2/s);
  assert.match(desktop, /\.utility-card\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
});

test("账户入口同时适配窄屏头像和宽屏邮箱信息", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(page, /className="account-chip"/);
  assert.match(page, /className="account-panel"/);
  assert.match(css, /\.account-chip\s*>\s*span\s*\{\s*display:\s*none/);
  assert.match(css, /@media \(min-width:\s*680px\)[\s\S]*\.account-chip\s*>\s*span\s*\{\s*display:\s*block/);
});
