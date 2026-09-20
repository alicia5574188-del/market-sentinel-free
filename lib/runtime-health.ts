export type RuntimeHealthShape = {
  state?: string;
  stale?: boolean;
  authorityReady?: boolean;
  lastError?: unknown;
  lastSuccessAt?: number | null;
  forward?: { mode?: string; lastCycleAt?: number | null;
    storage?: { persistedAt?: number; error?: unknown } } | null;
  symbols?: string[];
  evidence?: Record<string, { fresh?: boolean; ancillaryFresh?: boolean; entryReady?: boolean }>;
  realtimeReadiness?: { capacity?: number; actionableMarkets?: number; protectedMarketsReady?: boolean };
  strategyData?: { stableMarkets?: number; lastCompletedCandleAt?: number; hourlyPathFailures?: number };
};

const OPERATIONAL_STATES = new Set(["LIVE", "DEGRADED", "WARMING"]);
// Diagnostic only: tolerate three nominal five-minute cycles, including
// scheduling delay. Never turn this read-only status into trading authority.
const FORWARD_CYCLE_STALL_MS = 15 * 60_000;

function forwardRuntimeIssue(runtime: RuntimeHealthShape | null, now?: number) {
  const forward = runtime?.forward;
  // Old runtime payloads have no forward field. Explicit null means the
  // current source is unavailable, including the member projection.
  if (forward === undefined) return null;
  if (!forward || forward.mode === "RECOVERY_REQUIRED") return {
    label: "后台运行中 · 策略状态未恢复", notice: "当前前向策略状态尚未恢复；行情服务正常不代表策略已就绪。" };
  if (forward.storage?.error) return {
    label: "后台运行中 · 策略存储异常", notice: `前向策略存储异常，不能确认最新策略状态已保存：${String(forward.storage.error)}` };
  const cycle = forward.lastCycleAt;
  if (typeof cycle !== "number" || !Number.isFinite(cycle) || cycle <= 0) return {
    label: "后台运行中 · 策略周期未启动", notice: "前向策略尚无已完成周期；这不是没有交易机会，也不表示行情断网。" };
  const persisted = forward.storage?.persistedAt;
  if (typeof persisted !== "number" || !Number.isFinite(persisted) || persisted <= 0) return {
    label: "后台运行中 · 策略尚未持久化", notice: "前向策略尚无持久化记录；不能将内存中的状态视为已保存。" };
  if (persisted < cycle) return {
    label: "后台运行中 · 策略持久化落后", notice: "前向策略周期晚于已保存状态；需要核查持久化进度。" };
  // Use the payload's own clock unless explicitly supplied. Browser clock
  // drift and replaying an old snapshot must not invent a strategy outage.
  const reference = now ?? runtime?.lastSuccessAt;
  if (typeof reference === "number" && Number.isFinite(reference) && reference - cycle > FORWARD_CYCLE_STALL_MS) return {
    label: "后台运行中 · 策略周期未推进", notice: "行情仍在更新，但前向策略超过15分钟未完成新周期；需要核查策略执行。" };
  return null;
}

export function runtimeBackendOperational(runtime: RuntimeHealthShape | null) {
  return Boolean(runtime && runtime.stale === false && runtime.authorityReady === true
    && OPERATIONAL_STATES.has(runtime.state ?? ""));
}

export function runtimeAuthorityOperational(runtime: RuntimeHealthShape | null, transportFresh = true) {
  return transportFresh && runtimeBackendOperational(runtime);
}

export function runtimeReady(runtime: RuntimeHealthShape | null, transportFresh = true, now?: number) {
  if (!runtimeAuthorityOperational(runtime, transportFresh) || runtime?.state === "WARMING") return false;
  return runtime?.realtimeReadiness?.protectedMarketsReady === true && !forwardRuntimeIssue(runtime, now);
}

export function runtimeStatusLabel(runtime: RuntimeHealthShape | null, transportFresh = true, transportError = false, now?: number) {
  if (transportError) return "页面连接中断";
  if (!runtime) return "正在连接";
  if (!transportFresh) return "页面数据延迟";
  if (runtime.stale || runtime.state === "RECONNECTING") return "行情重连中";
  if (!runtime.authorityReady || runtime.state === "RECOVERY_REQUIRED") return "需要恢复";
  if (runtime.state === "WARMING") return "后台运行中 · 数据预热";
  const forwardIssue = forwardRuntimeIssue(runtime, now);
  if (forwardIssue) return forwardIssue.label;
  if (runtime.forward === undefined && runtime.strategyData
    && ((runtime.strategyData.stableMarkets ?? 0) < 8 || !(runtime.strategyData.lastCompletedCandleAt ?? 0))) {
    return "后台运行中 · 策略路径预热";
  }
  if (runtime.realtimeReadiness?.protectedMarketsReady === false) return "后台运行中 · 新仓冻结";
  return "后台运行中";
}

export function runtimeNotice(runtime: RuntimeHealthShape | null, now?: number) {
  const forwardIssue = forwardRuntimeIssue(runtime, now);
  if (forwardIssue) return forwardIssue.notice;
  const error = typeof runtime?.lastError === "string" ? runtime.lastError : "";
  if (!error) return null;
  if (error.startsWith("D1")) return `历史镜像稍后重试，不影响行情判断和开仓：${error}`;
  if (error.startsWith("portfolio stress risk")) return "账户风险已触及保护线，后台继续管理持仓并暂停新开仓。";
  if (error.startsWith("protected position data")) return "持仓相关盘口正在等待新鲜数据；旧价格不会触发平仓，新开仓已暂停。";
  if (error.includes("realtime markets warming")) return "部分精细市场正在准备新鲜数据；后台持续运行，未准备好的币种不会开仓。";
  if (runtime?.stale || runtime?.state === "RECONNECTING" || runtime?.state === "RECOVERY_REQUIRED"
    || error.startsWith("checkpoint:") || error.startsWith("authority checkpoint")) {
    return `系统正在自动恢复：${error}`;
  }
  return `部分市场数据稍后重试；后台与可用市场继续运行：${error}`;
}
