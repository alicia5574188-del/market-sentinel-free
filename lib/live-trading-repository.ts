import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import { hte31Trades } from "../db/hte31-schema";
import {
  liveAuditEvents,
  liveExchangeCredentials,
  liveOrders,
  liveTradingControl,
  tradeCases,
} from "../db/schema";
import type { EncryptedGateCredentials } from "./credential-vault";
import { liveEntryCandidateCutoff } from "./live-entry-freshness";
import { evaluateLivePerformanceGate } from "./live-performance-gate";

export type LiveCredentialRecord = typeof liveExchangeCredentials.$inferSelect;
export type LiveControlRecord = typeof liveTradingControl.$inferSelect;
export type LiveOrderRecord = typeof liveOrders.$inferSelect;
export type LiveOrderState = LiveOrderRecord["state"];

const ACTIVE_LIVE_STATES: LiveOrderState[] = ["submitting", "open", "protected", "closing"];
const LEGACY_RAW_EQUITY_LOCK = /Gate 权益较实盘峰值回撤/;
const ENTRY_EQUITY_SNAPSHOT_EVENT = "entry_equity_snapshot";
const HTE31_LIVE_BRIDGE_MODEL = "hte31_live_bridge";
const MIN_VALID_EQUITY_BASELINE_USDT = 0.01;

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validEquityBaseline(value: unknown): value is number {
  return finitePositive(value) && value >= MIN_VALID_EQUITY_BASELINE_USDT;
}

function hte31BridgeInsert(row: typeof hte31Trades.$inferSelect): typeof tradeCases.$inferInsert {
  const plannedRiskPct = row.entryPrice > 0 ? Math.abs(row.entryPrice - row.initialStopPrice) / row.entryPrice * 100 : 0;
  return {
    id: row.id,
    activeKey: null,
    symbol: row.symbol,
    status: row.status,
    side: row.side,
    confidence: row.confidence,
    posteriorLong: null,
    dataQuality: 1,
    regime: row.assetRegime,
    entryDirectionalScore: row.side === "LONG" ? 1 : -1,
    entryAt: row.entryAt,
    entryPrice: row.entryPrice,
    entryLow: row.entryPrice,
    entryHigh: row.entryPrice,
    entryTrigger: row.entryTrigger,
    entryThesis: row.entryThesis,
    entryChecksJson: row.entryChecksJson,
    exitRulesJson: "[]",
    entryEvidenceJson: "[]",
    entryCounterEvidenceJson: "[]",
    entryMetricsJson: row.entryMetricsJson,
    entrySnapshotJson: "{}",
    initialStopPrice: row.initialStopPrice,
    currentStopPrice: row.currentStopPrice,
    takeProfit1Price: row.takeProfit1Price,
    takeProfit2Price: row.takeProfit2Price,
    target1HitAt: row.target1HitAt,
    maxHoldingMinutes: row.maxHoldingMinutes,
    plannedRiskPct,
    riskReward: row.riskReward,
    riskBudgetUsdt: row.riskBudgetUsdt,
    suggestedNotionalUsdt: row.notionalUsdt,
    contractType: "USDT_PERPETUAL",
    marginMode: "isolated",
    leverage: row.leverage,
    leverageReason: "HTE 3.1 live compatibility bridge; Gate independently revalidates leverage and risk",
    marginUsdt: row.marginUsdt,
    contractNotionalUsdt: row.notionalUsdt,
    quantity: row.quantity,
    estimatedLiquidationPrice: null,
    simulationModel: HTE31_LIVE_BRIDGE_MODEL,
    accountBalanceBeforeUsdt: 0,
    accountBalanceAfterUsdt: null,
    lastPrice: row.lastPrice,
    lastEvaluatedAt: row.lastEvaluatedAt,
    maxPriceSeen: row.maxPriceSeen,
    minPriceSeen: row.minPriceSeen,
    unrealizedNetPct: row.unrealizedNetPct,
    unrealizedNetUsdt: row.unrealizedNetUsdt,
    progressR: row.progressR,
    exitAt: row.exitAt,
    exitPrice: row.exitPrice,
    exitCode: null,
    exitReason: row.exitReason,
    grossMovePct: row.grossMovePct,
    netMovePct: row.netMovePct,
    grossPnlUsdt: row.grossPnlUsdt,
    estimatedCostUsdt: row.costUsdt,
    netPnlUsdt: row.netPnlUsdt,
    mfePct: row.mfePct,
    maePct: row.maePct,
    holdMinutes: row.holdMinutes,
  };
}

async function ensureHte31LiveBridge(tradeId: string) {
  const db = getDb();
  const [hte] = await db.select().from(hte31Trades).where(eq(hte31Trades.id, tradeId)).limit(1);
  if (!hte) throw new Error("HTE 3.1 实盘候选已不存在，禁止创建 Gate 订单");
  const [existing] = await db.select({ id: tradeCases.id, simulationModel: tradeCases.simulationModel }).from(tradeCases).where(eq(tradeCases.id, tradeId)).limit(1);
  if (existing && existing.simulationModel !== HTE31_LIVE_BRIDGE_MODEL) {
    throw new Error("HTE 3.1 实盘候选 ID 与旧策略账本冲突，已禁止开仓");
  }
  if (!existing) await db.insert(tradeCases).values(hte31BridgeInsert(hte));
  return hte;
}

async function syncActiveHte31LiveBridges(rows: LiveOrderRecord[]) {
  if (!rows.length) return rows;
  const db = getDb();
  const ids = rows.map((row) => row.tradeCaseId);
  const [hteRows, bridgeRows] = await Promise.all([
    db.select().from(hte31Trades).where(inArray(hte31Trades.id, ids)),
    db.select({
      id: tradeCases.id,
      simulationModel: tradeCases.simulationModel,
      status: tradeCases.status,
      currentStopPrice: tradeCases.currentStopPrice,
      target1HitAt: tradeCases.target1HitAt,
      exitAt: tradeCases.exitAt,
      exitPrice: tradeCases.exitPrice,
      exitReason: tradeCases.exitReason,
    }).from(tradeCases).where(inArray(tradeCases.id, ids)),
  ]);
  const hteById = new Map(hteRows.map((row) => [row.id, row]));
  const bridgeById = new Map(bridgeRows.map((row) => [row.id, row]));
  for (const order of rows) {
    const hte = hteById.get(order.tradeCaseId);
    const bridge = bridgeById.get(order.tradeCaseId);
    if (!hte || !bridge || bridge.simulationModel !== HTE31_LIVE_BRIDGE_MODEL) continue;
    const changed = bridge.status !== hte.status
      || Math.abs(bridge.currentStopPrice - hte.currentStopPrice) > Math.max(1e-12, Math.abs(hte.currentStopPrice) * 1e-10)
      || bridge.target1HitAt !== hte.target1HitAt
      || bridge.exitAt !== hte.exitAt
      || bridge.exitPrice !== hte.exitPrice
      || bridge.exitReason !== hte.exitReason;
    if (!changed) continue;
    await db.update(tradeCases).set({
      status: hte.status,
      currentStopPrice: hte.currentStopPrice,
      target1HitAt: hte.target1HitAt,
      lastPrice: hte.lastPrice,
      lastEvaluatedAt: hte.lastEvaluatedAt,
      maxPriceSeen: hte.maxPriceSeen,
      minPriceSeen: hte.minPriceSeen,
      unrealizedNetPct: hte.unrealizedNetPct,
      unrealizedNetUsdt: hte.unrealizedNetUsdt,
      progressR: hte.progressR,
      exitAt: hte.exitAt,
      exitPrice: hte.exitPrice,
      exitReason: hte.exitReason,
      grossMovePct: hte.grossMovePct,
      netMovePct: hte.netMovePct,
      grossPnlUsdt: hte.grossPnlUsdt,
      estimatedCostUsdt: hte.costUsdt,
      netPnlUsdt: hte.netPnlUsdt,
      mfePct: hte.mfePct,
      maePct: hte.maePct,
      holdMinutes: hte.holdMinutes,
    }).where(eq(tradeCases.id, hte.id));
  }
  return rows;
}

export async function getLiveControl(): Promise<LiveControlRecord> {
  const db = getDb();
  const [existing] = await db.select().from(liveTradingControl).where(eq(liveTradingControl.id, 1)).limit(1);
  if (existing) {
    if (existing.state === "risk_locked" && LEGACY_RAW_EQUITY_LOCK.test(existing.lastError ?? "")) {
      const now = Date.now();
      await db.update(liveTradingControl).set({
        entryEnabled: false,
        state: "disabled",
        disabledAt: now,
        lastError: null,
        accountEquityPeakUsdt: existing.accountEquityLastUsdt ?? existing.accountEquityPeakUsdt,
        updatedAt: now,
      }).where(eq(liveTradingControl.id, 1));
      const [cleared] = await db.select().from(liveTradingControl).where(eq(liveTradingControl.id, 1)).limit(1);
      if (cleared) return cleared;
    }
    return existing;
  }
  const now = Date.now();
  await db.insert(liveTradingControl).values({ id: 1, entryEnabled: false, state: "disabled", activationEpoch: 0, updatedAt: now }).onConflictDoNothing();
  const [created] = await db.select().from(liveTradingControl).where(eq(liveTradingControl.id, 1)).limit(1);
  if (!created) throw new Error("无法初始化实盘控制状态");
  return created;
}

export async function patchLiveControl(values: Partial<typeof liveTradingControl.$inferInsert>) {
  const db = getDb();
  await getLiveControl();
  await db.update(liveTradingControl).set({ ...values, updatedAt: Date.now() }).where(eq(liveTradingControl.id, 1));
  return getLiveControl();
}

export async function armLiveControl() {
  const db = getDb();
  const current = await getLiveControl();
  if (current.state === "emergency_stopped") throw new Error("紧急停机锁仍生效，请先确认账户已清空并解除停机锁");
  const performanceGate = await getLivePerformanceGate();
  if (!performanceGate.passed) throw new Error(performanceGate.reason ?? "近期策略表现未达到实盘开仓要求");
  const now = Date.now();
  await db.update(liveTradingControl).set({
    entryEnabled: true,
    state: "armed",
    activationEpoch: current.activationEpoch + 1,
    enabledAt: now,
    disabledAt: null,
    emergencyReason: null,
    lastError: null,
    updatedAt: now,
  }).where(eq(liveTradingControl.id, 1));
  return getLiveControl();
}

export async function disableLiveControl(reason: string | null = null) {
  const current = await getLiveControl();
  if (current.state === "emergency_stopped") {
    return patchLiveControl({ entryEnabled: false, disabledAt: Date.now(), lastError: reason ?? current.lastError });
  }
  return patchLiveControl({ entryEnabled: false, state: "disabled", disabledAt: Date.now(), lastError: reason });
}

export async function latchEmergencyControl(reason: string) {
  const now = Date.now();
  return patchLiveControl({ entryEnabled: false, state: "emergency_stopped", disabledAt: now, emergencyAt: now, emergencyReason: reason, lastError: null });
}

export async function clearEmergencyControl() {
  const current = await getLiveControl();
  return patchLiveControl({
    entryEnabled: false,
    state: "disabled",
    disabledAt: Date.now(),
    emergencyAt: null,
    emergencyReason: null,
    lastError: null,
    accountEquityPeakUsdt: validEquityBaseline(current.accountEquityPeakUsdt) ? current.accountEquityPeakUsdt : null,
    accountEquityLastUsdt: validEquityBaseline(current.accountEquityLastUsdt) ? current.accountEquityLastUsdt : null,
    accountRiskCheckedAt: null,
  });
}

export async function getLiveCredentialRecord() {
  const db = getDb();
  const [row] = await db.select().from(liveExchangeCredentials).where(eq(liveExchangeCredentials.id, 1)).limit(1);
  return row ?? null;
}

export async function saveLiveCredentialRecord(values: {
  encrypted: EncryptedGateCredentials;
  environment: "live" | "testnet";
  keyHint: string;
  gateUserId: string | null;
  ownerAccountId: string;
  permissionSummary: Record<string, unknown>;
}) {
  const db = getDb();
  const now = Date.now();
  await db.insert(liveExchangeCredentials).values({
    id: 1,
    exchange: "gate",
    environment: values.environment,
    ciphertext: values.encrypted.ciphertext,
    iv: values.encrypted.iv,
    cryptoVersion: values.encrypted.cryptoVersion,
    keyHint: values.keyHint,
    gateUserId: values.gateUserId,
    ownerAccountId: values.ownerAccountId,
    permissionSummaryJson: JSON.stringify(values.permissionSummary),
    status: "verified",
    lastVerifiedAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: liveExchangeCredentials.id,
    set: {
      environment: values.environment,
      ciphertext: values.encrypted.ciphertext,
      iv: values.encrypted.iv,
      cryptoVersion: values.encrypted.cryptoVersion,
      keyHint: values.keyHint,
      gateUserId: values.gateUserId,
      ownerAccountId: values.ownerAccountId,
      permissionSummaryJson: JSON.stringify(values.permissionSummary),
      status: "verified",
      lastVerifiedAt: now,
      lastError: null,
      updatedAt: now,
    },
  });
  return getLiveCredentialRecord();
}

export async function markLiveCredentialVerification(success: boolean, error: string | null = null) {
  const db = getDb();
  await db.update(liveExchangeCredentials).set({ status: success ? "verified" : "error", lastVerifiedAt: success ? Date.now() : undefined, lastError: success ? null : error, updatedAt: Date.now() }).where(eq(liveExchangeCredentials.id, 1));
}

export async function deleteLiveCredentialRecord() {
  const db = getDb();
  await db.delete(liveExchangeCredentials).where(eq(liveExchangeCredentials.id, 1));
}

export async function countActiveLiveOrders() {
  const db = getDb();
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(liveOrders).where(inArray(liveOrders.state, ACTIVE_LIVE_STATES));
  return Number(row?.count ?? 0);
}

export async function listActiveLiveOrders() {
  const db = getDb();
  const rows = await db.select().from(liveOrders).where(inArray(liveOrders.state, ACTIVE_LIVE_STATES)).orderBy(asc(liveOrders.createdAt));
  await syncActiveHte31LiveBridges(rows);
  return rows;
}

export async function listLiveOrdersAwaitingRealizedPnl(now = Date.now()) {
  return getDb().select().from(liveOrders).where(and(
    eq(liveOrders.state, "closed"),
    isNull(liveOrders.realizedPnlUsdt),
    gte(liveOrders.closedAt, now - 24 * 60 * 60 * 1_000),
    or(isNull(liveOrders.lastReconciledAt), lt(liveOrders.lastReconciledAt, now - 60_000)),
  )).orderBy(asc(liveOrders.closedAt)).limit(3);
}

export async function getLivePerformanceGate(now = Date.now()) {
  const db = getDb();
  const [recentLive, entrySnapshots, recentSimulation] = await Promise.all([
    db.select({ id: liveOrders.id, realizedPnlUsdt: liveOrders.realizedPnlUsdt, closedAt: liveOrders.closedAt }).from(liveOrders)
      .where(eq(liveOrders.state, "closed")).orderBy(desc(liveOrders.closedAt)).limit(200),
    db.select({ liveOrderId: liveAuditEvents.liveOrderId, detailsJson: liveAuditEvents.detailsJson }).from(liveAuditEvents)
      .where(eq(liveAuditEvents.eventType, ENTRY_EQUITY_SNAPSHOT_EVENT)).orderBy(desc(liveAuditEvents.createdAt)).limit(250),
    db.select({ netMovePct: hte31Trades.netMovePct, exitAt: hte31Trades.exitAt }).from(hte31Trades)
      .where(eq(hte31Trades.status, "closed")).orderBy(desc(hte31Trades.exitAt)).limit(8),
  ]);
  const entryEquityByOrder = new Map<string, number>();
  for (const row of entrySnapshots) {
    if (!row.liveOrderId || entryEquityByOrder.has(row.liveOrderId)) continue;
    const details = parseJson<{ entryEquityUsdt?: number }>(row.detailsJson, {});
    if (finitePositive(details.entryEquityUsdt)) entryEquityByOrder.set(row.liveOrderId, details.entryEquityUsdt);
  }
  return evaluateLivePerformanceGate({
    now,
    recentLive: recentLive.map((row) => ({ realizedPnlUsdt: row.realizedPnlUsdt, entryEquityUsdt: entryEquityByOrder.get(row.id) ?? null, closedAt: row.closedAt })),
    recentSimulation,
  });
}

export async function listLiveEntryCandidates(enabledAt: number, now = Date.now()) {
  const performanceGate = await getLivePerformanceGate(now);
  if (!performanceGate.passed) return [];
  const db = getDb();
  const rows = await db.select().from(hte31Trades).where(and(
    eq(hte31Trades.status, "holding"),
    gte(hte31Trades.entryAt, liveEntryCandidateCutoff(enabledAt, now)),
  )).orderBy(desc(hte31Trades.entryAt)).limit(20);
  if (!rows.length) return [];
  const existing = await db.select({ tradeCaseId: liveOrders.tradeCaseId }).from(liveOrders).where(inArray(liveOrders.tradeCaseId, rows.map((row) => row.id)));
  const claimed = new Set(existing.map((row) => row.tradeCaseId));
  return rows
    .filter((row) => !claimed.has(row.id))
    .map((row) => ({ ...row, entryLow: row.entryPrice, entryHigh: row.entryPrice, contractNotionalUsdt: row.notionalUsdt }))
    .filter((row) => row.riskBudgetUsdt > 0 && row.contractNotionalUsdt >= 1);
}

export async function createLiveOrderIntent(values: typeof liveOrders.$inferInsert) {
  const db = getDb();
  await ensureHte31LiveBridge(values.tradeCaseId);
  const inserted = await db.insert(liveOrders).values(values).onConflictDoNothing().returning();
  if (inserted[0]) {
    if (inserted[0].state === "submitting") {
      const control = await getLiveControl();
      if (finitePositive(control.accountEquityLastUsdt)) {
        await addLiveAudit({ eventType: ENTRY_EQUITY_SNAPSHOT_EVENT, liveOrderId: inserted[0].id, symbol: inserted[0].symbol, message: `${inserted[0].symbol} 已记录实盘入场时 Gate 权益基准`, details: { entryEquityUsdt: control.accountEquityLastUsdt } });
      }
    }
    return inserted[0];
  }
  const [existing] = await db.select().from(liveOrders).where(eq(liveOrders.tradeCaseId, values.tradeCaseId)).limit(1);
  return existing ?? null;
}

export async function patchLiveOrder(id: string, values: Partial<typeof liveOrders.$inferInsert>) {
  const db = getDb();
  await db.update(liveOrders).set({ ...values, updatedAt: Date.now() }).where(eq(liveOrders.id, id));
  const [row] = await db.select().from(liveOrders).where(eq(liveOrders.id, id)).limit(1);
  return row ?? null;
}

export async function addLiveAudit(values: {
  eventType: string;
  severity?: "info" | "warning" | "critical";
  liveOrderId?: string | null;
  symbol?: string | null;
  actorAccountId?: string | null;
  message: string;
  details?: Record<string, unknown>;
}) {
  await getDb().insert(liveAuditEvents).values({
    id: crypto.randomUUID(),
    eventType: values.eventType,
    severity: values.severity ?? "info",
    liveOrderId: values.liveOrderId ?? null,
    symbol: values.symbol ?? null,
    actorAccountId: values.actorAccountId ?? null,
    message: values.message.slice(0, 500),
    detailsJson: JSON.stringify(values.details ?? {}),
    createdAt: Date.now(),
  });
}

function publicCredential(row: LiveCredentialRecord | null) {
  if (!row) return { configured: false as const };
  return {
    configured: true as const,
    exchange: row.exchange,
    environment: row.environment,
    keyHint: row.keyHint,
    gateUserId: row.gateUserId,
    permissionSummary: parseJson<Record<string, unknown>>(row.permissionSummaryJson, {}),
    status: row.status,
    lastVerifiedAt: row.lastVerifiedAt,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

function publicOrder(row: LiveOrderRecord) {
  return { ...row, lastGateStatus: parseJson<Record<string, unknown>>(row.lastGateStatusJson, {}), lastGateStatusJson: undefined };
}

export async function getLiveTradingSnapshot() {
  const db = getDb();
  const now = Date.now();
  const [control, credential, orders, audits, performanceGate] = await Promise.all([
    getLiveControl(),
    getLiveCredentialRecord(),
    db.select().from(liveOrders).orderBy(desc(liveOrders.createdAt)).limit(100),
    db.select().from(liveAuditEvents).orderBy(desc(liveAuditEvents.createdAt)).limit(30),
    getLivePerformanceGate(now),
  ]);
  return {
    observedAt: now,
    control,
    credential: publicCredential(credential),
    performanceGate,
    orders: orders.map(publicOrder),
    audit: audits.map((row) => ({ ...row, details: parseJson<Record<string, unknown>>(row.detailsJson, {}), detailsJson: undefined })),
  };
}
