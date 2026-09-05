import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, css] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/resonance.css", import.meta.url), "utf8"),
]);

test("Resonance keeps critical operator capabilities reachable after product refactors", () => {
  for (const phrase of [
    "重置模拟本金",
    "/api/hte31/paper-reset",
    "立即对账",
    "/api/live/reconcile",
    "删除凭据",
    "/api/live/credentials",
    "按住 1.2 秒紧急停机",
    "/api/live/emergency",
    "实盘资格",
    "最近成功对账",
    "市场扫描",
    "持仓管理",
  ]) assert.match(page, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("paper reset remains reachable without duplicating the destructive action", () => {
  const resetButtons = page.match(/onClick=\{\(\) => void resetPaper\(\)\}/g) ?? [];
  assert.equal(resetButtons.length, 1);
  assert.match(page, /资金设置/);
  assert.match(page, /重新开始资金曲线/);
  assert.match(page, /等待持仓结束/);
  assert.match(page, /paperReset\.status === "pending"/);
});

test("fixed navigation and full pre-trade evidence survive product refactors", () => {
  assert.match(page, /const NAV: Tab\[\] = \["大脑", "订单", "管理"\]/);
  assert.match(page, /function DecisionEvidenceCard/);
  for (const phrase of ["触发状态", "入场区", "止损", "第一止盈", "第二止盈", "触发与硬闸门", "支持证据", "反证 / 缺失条件", "失效条件"]) {
    assert.match(page, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(page, /candidate\.checks\.map/);
  assert.match(page, /candidate\.invalidationPrice/);
});

test("trade review keeps the information operators rely on", () => {
  for (const phrase of [
    "原始止损",
    "当前保护价",
    "第一止盈",
    "第二止盈",
    "隔离保证金",
    "名义仓位",
    "计划亏损",
    "第二止盈预计净利",
    "仓内最大浮盈",
    "仓内最大浮亏",
    "出场后最大有利波动",
    "出场后最大不利波动",
    "收益捕获率",
    "退出效率",
  ]) assert.match(page, new RegExp(phrase));
});

test("mobile emergency hold suppresses browser selection and context gestures", () => {
  assert.match(page, /event\.preventDefault\(\); startEmergency\(\)/);
  assert.match(page, /onContextMenu=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(page, /onDragStart=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(css, /\.rz-hold-button[\s\S]*user-select:\s*none/);
  assert.match(css, /\.rz-hold-button[\s\S]*-webkit-user-select:\s*none/);
  assert.match(css, /\.rz-hold-button[\s\S]*-webkit-touch-callout:\s*none/);
  assert.match(css, /\.rz-hold-button[\s\S]*touch-action:\s*manipulation/);
});
