import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const protectedRoutes = [
  "alerts", "background", "chart", "context", "market", "scanner", "settings",
  "account", "positions/refresh", "push/key", "push/subscribe", "push/test", "scan/run",
  "live/status", "live/credentials", "live/control", "live/emergency", "live/reconcile",
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

test("HTE31 高频只读快照认证不依赖 user_accounts D1 写入", async () => {
  const route = await readFile(new URL("../app/api/hte31/route.ts", import.meta.url), "utf8");
  const auth = await readFile(new URL("../app/api-auth.ts", import.meta.url), "utf8");
  const viewer = auth.match(/export async function requireApiViewer[\s\S]*?\n}\n\nexport async function requireApiAccount/)?.[0] ?? "";

  assert.match(route, /requireApiViewer/);
  assert.doesNotMatch(route, /requireApiAccount/);
  assert.match(viewer, /getChatGPTUser/);
  assert.match(viewer, /normalizeAccountEmail/);
  assert.match(viewer, /viewerRole/);
  assert.doesNotMatch(viewer, /ensureUserAccount/);
});

test("系统设置和手动深度扫描只允许所有者修改", async () => {
  const settings = await readFile(new URL("../app/api/settings/route.ts", import.meta.url), "utf8");
  const scan = await readFile(new URL("../app/api/scan/run/route.ts", import.meta.url), "utf8");
  assert.match(settings, /role !== "owner"/);
  assert.match(scan, /role !== "owner"/);
  assert.match(scan, /tokenAuthorized/);
});

test("实盘账户和所有变更接口均为所有者专用并保持跨站保护", async () => {
  for (const route of ["status", "credentials", "control", "emergency", "reconcile"]) {
    const source = await readFile(new URL(`../app/api/live/${route}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /role !== "owner"/, route);
  }

  for (const route of ["credentials", "control", "emergency"]) {
    const source = await readFile(new URL(`../app/api/live/${route}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /mutationRejected/, route);
  }

  const reconcile = await readFile(new URL("../app/api/live/reconcile/route.ts", import.meta.url), "utf8");
  assert.match(reconcile, /mutationOriginRejected\(request\)/);
  assert.doesNotMatch(reconcile, /mutationRejected\(request/);

  const credentials = await readFile(new URL("../app/api/live/credentials/route.ts", import.meta.url), "utf8");
  assert.match(credentials, /readLimitedJsonObject\(request, 4_096\)/);
  assert.match(credentials, /export async function DELETE[\s\S]*mutationOriginRejected\(request\)/);
});
