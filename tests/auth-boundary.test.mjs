import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const protectedRoutes = [
  "alerts", "background", "chart", "context", "market", "scanner", "settings",
  "account", "positions/refresh", "push/key", "push/subscribe", "push/test", "scan/run",
];

test("主页面要求登录后才渲染", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /requireChatGPTUser\("\/"\)/);
  assert.match(layout, /dynamic\s*=\s*"force-dynamic"/);
});

test("所有业务 API 都在服务端检查账户身份", async () => {
  for (const route of protectedRoutes) {
    const source = await readFile(new URL(`../app/api/${route}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /requireApiAccount/, route);
    assert.match(source, /"response" in [A-Za-z]+/, route);
  }
});

test("系统设置和手动深度扫描只允许所有者修改", async () => {
  const settings = await readFile(new URL("../app/api/settings/route.ts", import.meta.url), "utf8");
  const scan = await readFile(new URL("../app/api/scan/run/route.ts", import.meta.url), "utf8");
  assert.match(settings, /role !== "owner"/);
  assert.match(scan, /role !== "owner"/);
  assert.match(scan, /tokenAuthorized/);
});
