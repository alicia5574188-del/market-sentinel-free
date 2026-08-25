import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "../db";
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

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export async function getLiveControl(): Promise<LiveControlRecord> {
  const db = getDb();
  const [existing] = await db.select().from(liveTradingControl).where(eq(liveTradingControl.id, 1)).limit(1);
  if (existing) {
    // Older releases treated owner transfers between futures and spot as
    // trading drawdown because they compared raw Gate account equity with an
    // all-time raw-equity peak. That rule is retired. Clear only locks created
    // by that exact legacy reason; every other risk/emergency lock remains.
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
    return patchLiveControl({
      entryEnabled: false,
      disabledAt: Date.now(),
      lastError: reason ?? current.lastError,
    });
  }
  return patchLiveControl({
    entryEnabled: false,
    state: "disabled",
    disabledAt: Date.now(),
    lastError: reason,
  });
}

export async function latchEmergencyControl(reason: string) {
  const now = Date.now();
  return patchLiveControl({
    entryEnabled: false,
    state: "emergency_stopped",
    disabledAt: now,
    emergencyAt: now,
    emergencyReason: reason,
    lastError: null,
  });
}

export async function clearEmergencyControl() {
  return patchLiveControl({
    entryEnabled: false,
    state: "disabled",
    disabledAt: Date.now(),
    emergencyAt: null,
    emergencyReason: null,
    lastError: null,
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
  await db.update(liveExchangeCredentials).set({
    status: success ? "verified" : "error",
    lastVerifiedAt: success ? Date.now() : undefined,
    lastError: success ? null : error,
    updatedAt: Date.now(),
  }).where(eq(liveExchangeCredentials.id, 1));
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
  return getDb().select().from(liveOrders).where(inArray(liveOrders.state, ACTIVE_LIVE_STATES)).orderBy(asc(liveOrders.createdAt));
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
  const [recentLive, recentSimulation] = await Promise.all([
    db.select({
      realizedPnlUsdt: liveOrders.realizedPnlUsdt,
      riskBudgetUsdt: tradeCases.riskBudgetUsdt,
      closedAt: liveOrders.closedAt,
    }).from(liveOrders)
      .leftJoin(tradeCases, eq(liveOrders.tradeCaseId, tradeCases.id))
      .where(eq(liveOrders.state, "closed"))
      .orderBy(desc(liveOrders.closedAt))
      .limit(200),
    db.select({
      netMovePct: tradeCases.netMovePct,
      exitAt: tradeCases.exitAt,
    }).from(tradeCases)
      .where(and(eq(tradeCases.status, "closed"), eq(tradeCases.simulationModel, "contract_v2")))
      .orderBy(desc(tradeCases.exitAt))
      .limit(8),
  ]);
  return evaluateLivePerformanceGate({ now, recentLive, recentSimulation });
}

export async function listLiveEntryCandidates(enabledAt: number, now = Date.now()) {
  const performanceGate = await getLivePerformanceGate(now);
  if (!performanceGate.passed) return [];
  const db = getDb();
  const rows = await db.select().from(tradeCases).where(and(
    eq(tradeCases.status, "holding"),
    eq(tradeCases.simulationModel, "contract_v2"),
    gte(tradeCases.entryAt, liveEntryCandidateCutoff(enabledAt, now)),
  )).orderBy(desc(tradeCases.entryAt)).limit(20);
  if (!rows.length) return [];
  const existing = await db.select({ tradeCaseId: liveOrders.tradeCaseId }).from(liveOrders).where(inArray(liveOrders.tradeCaseId, rows.map((row) => row.id)));
  const claimed = new Set(existing.map((row) => row.tradeCaseId));
  return rows.filter((row) => !claimed.has(row.id));
}

export async function createLiveOrderIntent(values: typeof liveOrders.$inferInsert) {
  const db = getDb();
  const inserted = await db.insert(liveOrders).values(values).onConflictDoNothing().returning();
  if (inserted[0]) return inserted[0];
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
  return {
    ...row,
    lastGateStatus: parseJson<Record<string, unknown>>(row.lastGateStatusJson, {}),
    lastGateStatusJson: undefined,
  };
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
