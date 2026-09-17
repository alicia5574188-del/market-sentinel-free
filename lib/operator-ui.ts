/** UI contracts only. No strategy, credentials storage, or exchange execution. */
import type { forwardSummary } from "./forward-relations.ts";
import type { RuntimeHealthShape } from "./runtime-health.ts";
import type { MirrorReceipt, mirrorCoverage } from "./live-parity.ts";
import type { gatePositionValuation } from "./gate-live.ts";
import type { LiveSession } from "./live-session.ts";
import type { SizeDiagnostic } from "./gate-quantity.ts";
export type AuthSession = { configured: boolean; authenticated: boolean; username: string };
export type LivePosition = Partial<ReturnType<typeof gatePositionValuation>> & {
  id: string; symbol: string; side: "LONG" | "SHORT"; status: "OPEN" | "CLOSED";
  entryAt?: number; exitAt?: number; entryPrice: number; exitPrice?: number;
  notional: number; plannedRisk: number; leverage: number; margin: number;
  exchangeSize: number; stopPrice: number | null; currentStop: number;
  currentTarget: number; realizedPnl?: number; exitReason?: string;
  parity?: MirrorReceipt; actualExitPriceVerified?: boolean;
};
export type LiveEntry = { planId: string; symbol: string; side: "LONG" | "SHORT"; status: string;
  trigger: number; invalidation: number; target: number; notional: number; plannedRisk: number;
  leverage: number; margin: number; lastError: string | null; parity?:MirrorReceipt };
export type LiveRuntime = { requestedEnabled: boolean; operational: boolean; changedAt: number | null;
  activation?: LiveSession | null;
  lastSyncAt: number | null; lastError: string | null; equity: number | null; available: number | null;
  credentialConfigured: boolean; positions: Record<string, LivePosition | null>; entries: Record<string, LiveEntry | null>;
  history?:LivePosition[]; mirror?:ReturnType<typeof mirrorCoverage>;
  entrySkips: Record<string, { planId: string; symbol: string; code: string; reason: string; observedAt: number; sizing?: SizeDiagnostic } | null>;
  auditEvents: { id: string; observedAt: number; symbol: string | null; stage: string;
    level: string; reason: string; gateLabel: string | null }[] };
export type OperatorRuntime = RuntimeHealthShape & { generatedAt: number; lastSuccessAt: number | null; buildSha?: string;
  forward?: ReturnType<typeof forwardSummary>; legacyRetired?: boolean;
  liveMirror?:ReturnType<typeof mirrorCoverage>;
  liveMode: { requestedEnabled: boolean; operational: boolean }; live?: LiveRuntime;
  evidence: Record<string, { bestBid?: number; bestAsk?: number; midpoint?: number; observedAt: number; fresh: boolean }> };
export type CredentialStatus = { configured: boolean; environment: string | null; keyHint: string | null;
  status: string; lastVerifiedAt: number | null; lastError: string | null };
export type CredentialVerification = { equity: number; available: number; positions: number; orders: number;
  conditionalOrders: number; checkedAt: number };
export const numberText = (value: number | null | undefined, digits=2) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—";
export const signedText = (value: number | null | undefined, digits=2) =>
  typeof value === "number" && Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${numberText(value,digits)}` : "—";
export const contractText = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value)
  ? value.toLocaleString("en-US",{minimumFractionDigits:0,maximumFractionDigits:12}) : "—";
export const operatorTime = (value?: number | null) => value ? new Date(value).toLocaleString("zh-CN", {
  timeZone: "Asia/Vientiane", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
}) : "—";
export function holdingTime(start: number | undefined, end: number) {
  if (!start || !end) return "—";
  const minutes = Math.max(0, Math.floor((end-start)/60_000));
  return minutes >= 60 ? `${Math.floor(minutes/60)}小时${minutes%60}分` : `${minutes}分钟`;
}
export function livePositionMark(position: LivePosition, runtime: OperatorRuntime | null, now: number) {
  // Keep the last REAL exchange valuation with a timestamp when stale.
  // Public market data and PAPER prices never substitute for Gate's PnL.
  const at=position.exchangePnlAt??null, pnl=position.exchangeUnrealisedPnl;
  const known=typeof pnl==="number"&&Number.isFinite(pnl)&&at!=null&&at>0&&at<=now;
  const fresh=known&&now-at!<=30_000&&!runtime?.live?.lastError;
  const basis=position.exchangePnlMargin;
  return { fresh, at, price:known?position.exchangeMarkPrice??null:null,pnl:known?pnl:null,
    margin:basis??null,rate:known&&basis!=null&&basis>0?pnl/basis:null };
}
export class OperatorRequestError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status=status; }
}
/** Never retries mutations. A timeout may mean the server accepted the action. */
export async function operatorRequest<T>(path: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", body?: unknown): Promise<T> {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(path, { method, cache: "no-store", credentials: "same-origin", signal: controller.signal,
      ...(method === "GET" ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }) });
    const payload = await response.json() as T & { error?: string };
    if (!response.ok) throw new OperatorRequestError(payload.error || `请求失败（${response.status}）`, response.status);
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new OperatorRequestError("未收到服务器确认，正在重新读取状态；不会自动重复提交。", 0);
    throw error;
  } finally { clearTimeout(timeout); }
}