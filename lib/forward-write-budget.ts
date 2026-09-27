/** Separate, durable capacity for source protection. It cannot consume the
 * original financial/exit budget and adds no alarm or per-counter KV record.
 */
import { resourceDay } from "./resource-day.ts";
import { MEMBER_ACTIVE_LIMIT, MEMBER_USAGE_HEARTBEAT_MS } from "./member-auth.ts";

export const PROTECTION_WRITE_BUDGET_VERSION = "critical-protection-budget-v1";
export const PROTECTION_WRITE_CAP = 8_640;
export const PROTECTION_WRITE_INTERVAL_MS = 10_000;

/**
 * Workers Paid resource contract.
 *
 * Cloudflare Paid currently includes 50,000,000 SQLite Durable Object rows
 * written per subscription month. This project intentionally keeps its static
 * worst-case model below half that allowance, so normal feature growth cannot
 * silently consume the remaining headroom.
 */
export const PAID_DO_INCLUDED_ROWS_PER_MONTH = 50_000_000;
export const RESOURCE_MODEL_MONTH_DAYS = 31;
export const OPTIONAL_WRITE_GUARD_PER_DAY = 100_000;
export const CRITICAL_FINANCIAL_STRESS_ROWS_PER_DAY = 10_000;
export const PRIMARY_ALARM_ROWS_PER_DAY = 43_200;
export const MEMBER_ALARM_ROWS_PER_DAY = 8_640;
export const WATCHDOG_ROWS_PER_DAY = 2_880;
export const HOURLY_PATH_ROWS_PER_DAY = 13 * 24;
export const MEMBER_USAGE_HEARTBEATS_PER_DAY = Math.ceil(86_400_000 / MEMBER_USAGE_HEARTBEAT_MS);
export const PAID_RESOURCE_SAFETY_FRACTION = 0.50;

export const PRIMARY_PLANNED_DO_ROWS = PRIMARY_ALARM_ROWS_PER_DAY + OPTIONAL_WRITE_GUARD_PER_DAY
  + PROTECTION_WRITE_CAP + WATCHDOG_ROWS_PER_DAY + HOURLY_PATH_ROWS_PER_DAY
  + CRITICAL_FINANCIAL_STRESS_ROWS_PER_DAY;
export function plannedDoRowsPerDay(activeMembers:number) {
  if(!Number.isSafeInteger(activeMembers)||activeMembers<0)throw new Error("active member count invalid");
  return PRIMARY_PLANNED_DO_ROWS
    + activeMembers * (MEMBER_ALARM_ROWS_PER_DAY + OPTIONAL_WRITE_GUARD_PER_DAY + CRITICAL_FINANCIAL_STRESS_ROWS_PER_DAY)
    + activeMembers * MEMBER_USAGE_HEARTBEATS_PER_DAY;
}
export const DIRECTORY_USAGE_ROWS_PER_DAY = MEMBER_ACTIVE_LIMIT * MEMBER_USAGE_HEARTBEATS_PER_DAY;
export const TWO_MEMBER_PLANNED_DO_ROWS = plannedDoRowsPerDay(2);
export const ACTIVE_MEMBER_PLANNED_DO_ROWS = plannedDoRowsPerDay(MEMBER_ACTIVE_LIMIT);
export const PAID_PLAN_PLANNED_MONTHLY_ROWS = ACTIVE_MEMBER_PLANNED_DO_ROWS * RESOURCE_MODEL_MONTH_DAYS;
export const PAID_PLAN_ROW_SAFETY_LIMIT = PAID_DO_INCLUDED_ROWS_PER_MONTH * PAID_RESOURCE_SAFETY_FRACTION;
export type ProtectionWriteBudget = { version: typeof PROTECTION_WRITE_BUDGET_VERSION;
  day: string; writes: number; lastCommittedAt: number };

export function readProtectionWriteBudget(value: unknown): ProtectionWriteBudget | null {
  if (value == null) return null; // Legacy overlay has no dedicated lane yet.
  const v = value as ProtectionWriteBudget;
  if (v.version !== PROTECTION_WRITE_BUDGET_VERSION || !/^\d{4}-\d{2}-\d{2}$/.test(v.day)
    || !Number.isSafeInteger(v.writes) || v.writes < 1 || v.writes > PROTECTION_WRITE_CAP
    || !Number.isFinite(v.lastCommittedAt) || v.lastCommittedAt <= 0
    || resourceDay(v.lastCommittedAt) !== v.day)
    throw new Error("关键保护资源账异常；拒绝重置计数或发布未保存保护");
  return { version: v.version, day: v.day, writes: v.writes, lastCommittedAt: v.lastCommittedAt };
}

/** Call inside the SAME storage transaction as the checkpoint put. Financial
 * exits never call this function, even when this lane is full/unavailable.
 */
export function nextProtectionWriteBudget(value: unknown, now: number): ProtectionWriteBudget {
  if (!Number.isFinite(now) || now <= 0) throw new Error("关键保护提交时间异常");
  const prior = readProtectionWriteBudget(value), day = resourceDay(now);
  if (prior && (day < prior.day || now - prior.lastCommittedAt < PROTECTION_WRITE_INTERVAL_MS))
    throw new Error("关键保护提交须遵守持久化十秒间隔；不重复提交或回拨资源日");
  const writes = prior?.day === day ? prior.writes : 0;
  if (writes >= PROTECTION_WRITE_CAP) throw new Error("关键保护专用额度已满；金融退出额度未被占用");
  return { version: PROTECTION_WRITE_BUDGET_VERSION, day, writes: writes + 1, lastCommittedAt: now };
}

export function protectionWriteBudgetView(value: ProtectionWriteBudget | null | undefined, now: number) {
  return { policy: PROTECTION_WRITE_BUDGET_VERSION, day: resourceDay(now),
    writes: value?.day === resourceDay(now) ? value.writes : 0,
    cap: PROTECTION_WRITE_CAP, lastCommittedAt: value?.lastCommittedAt ?? null,
    independentOfFinancialWrites: true };
}
