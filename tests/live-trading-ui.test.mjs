import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("owner-only live trading UI keeps credentials ephemeral, live-only and entry default-off", async () => {
  const [page, schema, credentialRoute, engine] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/live/credentials/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/live-trading-engine.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /canManage \? \["机会", "雷达", "订单", "实盘", "设置"\]/);
  assert.match(page, /tab === "实盘" && canManage/);
  assert.match(page, /API Key<\/span><input type="password"/);
  assert.match(page, /API Secret<\/span><input type="password"/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
  assert.match(page, /按住 1\.2 秒紧急停机/);
  assert.match(page, /包括非本程序仓位/);
  assert.doesNotMatch(page, /gateEnvironment|setGateEnvironment|live-environment/);
  assert.match(page, /API 环境：只接受 Gate 实盘 API；策略验证请使用程序内模拟交易/);
  assert.match(page, /旧 TestNet（需更换）/);
  assert.match(page, /credential\.environment !== "live"/);
  assert.match(credentialRoute, /environment: "live"/);
  assert.match(engine, /input\.environment !== "live"/);
  assert.match(engine, /旧 Gate TestNet 凭据不能开启自动交易/);
  assert.match(schema, /environment: text\("environment"[^\n]*default\("testnet"\)/);
  assert.match(schema, /entryEnabled: integer\("entry_enabled"[^\n]*default\(false\)/);
});

test("live tab embeds detailed Gate orders without a separate-page shortcut", async () => {
  const [layout, inlineOrders, semantics] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/live-orders-inline.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ui-status-semantic-fix.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /<LiveOrdersInline \/>/);
  assert.match(inlineOrders, /\.live-trading-card/);
  assert.doesNotMatch(inlineOrders, /querySelector<HTMLElement>\("\.order-ledger"\)/);
  assert.match(inlineOrders, /Gate 实盘订单/);
  assert.match(inlineOrders, /实盘持仓 \/ 活动订单/);
  assert.match(inlineOrders, /实盘已平仓订单/);
  assert.match(inlineOrders, /实盘订单详情/);
  assert.match(inlineOrders, /真实已实现盈亏/);
  assert.match(inlineOrders, /止损/);
  assert.match(inlineOrders, /TP2/);
  assert.match(inlineOrders, /fetch\("\/api\/live\/status"/);
  assert.doesNotMatch(semantics, /查看实盘订单|href = "\/live-orders"/);
});

test("live UI exposes real-funds and current-equity safety gates", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /TP2 预计净利润 ≥ Gate 当前权益的 1\.5%/);
  assert.match(page, /当前模拟权益 1\.5%/);
  assert.match(page, /Gate 当前权益 1% 单笔风险、20% 单笔保证金/);
  assert.match(page, /当日参考权益 3%.*峰值回撤.*10%/);
  assert.match(page, /Worker 新版本部署后会自动关闭新开仓；普通重启和刷新页面不会改变当前开关状态/);
});

test("Durable Object serializes live mutations and emergency reconciliation", async () => {
  const [worker, repository, engine] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/live-trading-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/live-trading-engine.ts", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /private operationTail: Promise<void>/);
  assert.match(worker, /private async exclusive<T>/);
  assert.match(worker, /async emergencyStop[\s\S]*this\.exclusive/);
  assert.match(worker, /async alarm\(\): Promise<void>[\s\S]*this\.exclusive/);
  assert.match(repository, /if \(current\.state === "emergency_stopped"\)[\s\S]*entryEnabled: false/);
  assert.match(engine, /sendAllPush\([\s\S]*credential\.ownerAccountId/);
  assert.match(engine, /nonProtective = initialPriceOrders\.filter\([\s\S]*reduce_only[\s\S]*initial\?\.close/);
  assert.match(engine, /nonProtective\.slice\(0, EMERGENCY_PRICE_CANCEL_BATCH\)/);
  assert.match(engine, /if \(postClosePositionsKnown && !postClosePositions\.length\)[\s\S]*cancelAllPriceOrders/);
  assert.match(engine, /removeOrphanProgramOrders\(client, trackedAfterReconcile/);
  assert.match(engine, /unmanaged_gate_exposure/);
  assert.match(engine, /只能轮换同一 Gate 用户、同一环境的 API 密钥/);
  assert.match(engine, /entry_submission_ambiguous/);
  assert.match(engine, /下一轮按客户端订单号确认是否到达 Gate/);
  assert.match(engine, /post_fill_validation_pending/);
  assert.match(engine, /validateRecoveredPostFill\(client, order, symbolPositions\)/);
  assert.match(engine, /recovered_position_unattributed/);
  assert.match(engine, /positionIntegrityIssue\(order, symbolPositions\)/);
  assert.match(engine, /新保护止损已先确认，再撤销旧止损/);
});
