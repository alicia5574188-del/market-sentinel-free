/** Separate, durable capacity for source protection. It cannot consume the
 * original financial/exit budget and adds no alarm or per-counter KV record.
 */
import { resourceDay } from "./resource-day.ts";

export const PROTECTION_WRITE_BUDGET_VERSION = "critical-protection-budget-v1";
export const PROTECTION_WRITE_CAP = 8_640;
export const PROTECTION_WRITE_INTERVAL_MS = 10_000;
// Reserved workload model, not a guarantee for unbounded retries, UI traffic,
// administrative actions or other Workers on the same Cloudflare account.
export const PRIMARY_PLANNED_DO_ROWS = 43_200 + 8_000 + PROTECTION_WRITE_CAP + 2_880 + 13 * 24;
export const TWO_MEMBER_PLANNED_DO_ROWS = PRIMARY_PLANNED_DO_ROWS + 2 * (8_640 + 8_000) + 2_880;
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
