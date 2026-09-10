export type RuntimeHealthShape = {
  state?: string;
  stale?: boolean;
  authorityReady?: boolean;
  lastError?: unknown;
  symbols?: string[];
  evidence?: Record<string, { fresh?: boolean; ancillaryFresh?: boolean; entryReady?: boolean }>;
  realtimeReadiness?: { capacity?: number; actionableMarkets?: number; protectedMarketsReady?: boolean };
};

const OPERATIONAL_STATES = new Set(["LIVE", "DEGRADED", "WARMING"]);

export function runtimeBackendOperational(runtime: RuntimeHealthShape | null) {
  return Boolean(runtime && runtime.stale === false && runtime.authorityReady === true
    && OPERATIONAL_STATES.has(runtime.state ?? ""));
}

export function runtimeAuthorityOperational(runtime: RuntimeHealthShape | null, transportFresh = true) {
  return transportFresh && runtimeBackendOperational(runtime);
}

export function runtimeReady(runtime: RuntimeHealthShape | null, transportFresh = true) {
  if (!runtimeAuthorityOperational(runtime, transportFresh) || runtime?.state === "WARMING") return false;
  return runtime?.realtimeReadiness?.protectedMarketsReady === true;
}

export function runtimeStatusLabel(runtime: RuntimeHealthShape | null, transportFresh = true, transportError = false) {
  if (transportError) return "页面连接中断";
  if (!runtime) return "正在连接";
  if (!transportFresh) return "页面数据延迟";
  if (runtime.stale || runtime.state === "RECONNECTING") return "行情重连中";
  if (!runtime.authorityReady || runtime.state === "RECOVERY_REQUIRED") return "需要恢复";
  if (runtime.state === "WARMING") return "后台运行中 · 数据预热";
  if (runtime.realtimeReadiness?.protectedMarketsReady === false) return "后台运行中 · 新仓冻结";
  return "后台运行中";
}

export function runtimeNotice(runtime: RuntimeHealthShape | null) {
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
