import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("owner-only live trading UI keeps credentials ephemeral and entry default-off", async () => {
  const [page, schema] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /canManage \? \["机会", "雷达", "订单", "实盘", "设置"\]/);
  assert.match(page, /tab === "实盘" && canManage/);
  assert.match(page, /API Key<\/span><input type="password"/);
  assert.match(page, /API Secret<\/span><input type="password"/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
  assert.match(page, /按住 1\.2 秒紧急停机/);
  assert.match(page, /包括非本程序仓位/);
  assert.match(page, /useState<"live" \| "testnet">\("testnet"\)/);
  assert.match(schema, /environment: text\("environment"[^\n]*default\("testnet"\)/);
  assert.match(schema, /entryEnabled: integer\("entry_enabled"[^\n]*default\(false\)/);
});

test("live UI exposes the real-funds and 15U safety gates", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /TP2 预计净利润 ≥ 15U/);
  assert.match(page, /Gate 当前权益 1% 单笔风险、20% 单笔保证金/);
  assert.match(page, /Gate 当日已实现亏损或实盘权益回撤触线后/);
  assert.match(page, /开启、部署或刷新页面都不会自动恢复交易/);
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
