import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [controls, layout, baseline] = await Promise.all([
  readFile(new URL("../app/resonance-operator-controls.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  readFile(new URL("../docs/RESONANCE_MUST_KEEP_FEATURES.md", import.meta.url), "utf8"),
]);

test("account push and audit controls remain reachable", () => {
  for (const phrase of [
    "账户 · 通知",
    "/api/account",
    "退出登录",
    "/api/push/key",
    "/api/push/subscribe",
    "/api/push/test",
    "开启通知",
    "关闭通知",
    "测试推送",
    "实盘安全审计",
    "/api/live/status",
  ]) assert.match(controls, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("operator controls are lazy and do not add periodic polling", () => {
  assert.match(controls, /if \(!open \|\| accountRequested\) return/);
  assert.match(controls, /onClick=\{\(\) => void loadAudit\(\)\}/);
  assert.doesNotMatch(controls, /setInterval\s*\(/);
  assert.doesNotMatch(controls, /setTimeout\s*\(/);
});

test("operator controls are mounted outside the trading page failure domain", () => {
  assert.match(layout, /ResonanceOperatorControls/);
  assert.match(layout, /resonance-operator-controls\.css/);
});

test("must-keep baseline makes preservation and stability explicit", () => {
  for (const phrase of [
    "Must-Keep",
    "不得仅为展示它们新增高频定时轮询",
    "辅助功能接口失败只能局部降级",
    "模拟资金重置",
    "Gate 凭据管理",
    "Emergency Stop",
    "Web Push 管理",
    "账户和退出登录",
    "MFE/MAE",
  ]) assert.match(baseline, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
