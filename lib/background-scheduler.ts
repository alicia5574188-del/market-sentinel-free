import { getRuntimeBindings } from "./runtime-bindings";

export type SchedulerWorkerStatus = {
  state: "starting" | "live" | "paused" | "degraded" | "error";
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  refreshed?: number;
  analyzed?: number;
  symbols?: string[];
};

export type RuntimeHealthState = "healthy" | "starting" | "paused" | "degraded" | "recovering" | "failed";

export type RuntimeModuleHealth = {
  module: "position_monitor" | "market_scanner" | "live_coordinator";
  label: string;
  health: RuntimeHealthState;
  state: string;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  nextRunAt: number | null;
  staleForMs: number | null;
  lastError: string | null;
  autoRecoveryTriggered: boolean;
  detail: string;
};

export type BackgroundSchedulerStatus = {
  mode: "foreground-only" | "cloudflare-free";
  active: boolean;
  observedAt: number;
  overall: RuntimeHealthState;
  positionCadenceSeconds: number | null;
  scanCadenceSeconds: number | null;
  deepBatchSize: number | null;
  position: (SchedulerWorkerStatus & RuntimeModuleHealth) | null;
  scanner: (SchedulerWorkerStatus & RuntimeModuleHealth) | null;
  live: RuntimeModuleHealth | null;
  issues: { module: string; health: RuntimeHealthState; message: string }[];
  error?: string;
};

const POSITION_STALE_MS = 45_000;
const SCANNER_STALE_MS = 180_000;
const LIVE_STALE_MS = 180_000;

function staleFor(lastSuccessAt: number | null, lastRunAt: number | null, now: number) {
  const anchor = lastSuccessAt ?? lastRunAt;
  return anchor == null ? null : Math.max(0, now - anchor);
}

function healthFromScheduler(status: SchedulerWorkerStatus, staleMs: number, now: number): RuntimeHealthState {
  if (status.state === "paused") return "paused";
  if (status.state === "starting" && status.lastRunAt == null) return "starting";
  const stale = staleFor(status.lastSuccessAt, status.lastRunAt, now);
  if (status.state === "error" || (stale != null && stale > staleMs)) return "recovering";
  if (status.state === "degraded" || status.lastError) return "degraded";
  return "healthy";
}

function moduleDetail(label: string, health: RuntimeHealthState, stale: number | null, lastError: string | null) {
  if (health === "healthy") return `${label}运行正常`;
  if (health === "paused") return `${label}已按设置暂停`;
  if (health === "starting") return `${label}正在启动`;
  if (health === "recovering") return `${label}已触发自动恢复${stale != null ? ` · 已滞后 ${Math.round(stale / 1000)} 秒` : ""}`;
  if (lastError) return `${label}部分异常 · ${lastError}`;
  return `${label}处于降级状态`;
}

async function inspectScheduler(
  stub: { ensure(): Promise<SchedulerWorkerStatus>; status(): Promise<SchedulerWorkerStatus>; wake(): Promise<{ ok: true; nextRunAt: number }> },
  module: "position_monitor" | "market_scanner",
  label: string,
  staleMs: number,
) {
  await stub.ensure();
  let status = await stub.status();
  const now = Date.now();
  let health = healthFromScheduler(status, staleMs, now);
  let autoRecoveryTriggered = false;
  if (health === "recovering") {
    const wake = await stub.wake();
    autoRecoveryTriggered = true;
    status = { ...status, nextRunAt: wake.nextRunAt };
  }
  const stale = staleFor(status.lastSuccessAt, status.lastRunAt, now);
  return {
    ...status,
    module,
    label,
    health,
    staleForMs: stale,
    autoRecoveryTriggered,
    detail: moduleDetail(label, health, stale, status.lastError),
  } satisfies SchedulerWorkerStatus & RuntimeModuleHealth;
}

async function inspectLiveCoordinator(bindings: ReturnType<typeof getRuntimeBindings>): Promise<RuntimeModuleHealth | null> {
  if (!bindings.LIVE_TRADING_COORDINATOR) return null;
  const stub = bindings.LIVE_TRADING_COORDINATOR.getByName("live-trading");
  const ensured = await stub.ensure();
  const snapshot = await stub.snapshot();
  const now = Date.now();
  const control = snapshot.control;
  const configured = snapshot.credential.configured;
  const lastRunAt = control.lastReconciledAt ?? null;
  const lastSuccessAt = control.lastSuccessfulReconcileAt ?? null;
  const stale = staleFor(lastSuccessAt, lastRunAt, now);
  let health: RuntimeHealthState;
  let autoRecoveryTriggered = false;

  if (!configured) {
    health = "healthy";
  } else if (lastRunAt == null) {
    health = "starting";
  } else if ((stale != null && stale > LIVE_STALE_MS) || (control.lastError && (!lastSuccessAt || lastRunAt > lastSuccessAt))) {
    health = "recovering";
    if (now - lastRunAt > 60_000) {
      await stub.reconcileNow();
      autoRecoveryTriggered = true;
    }
  } else if (control.lastError) {
    health = "degraded";
  } else {
    health = "healthy";
  }

  const detail = !configured
    ? "实盘协调器正常 · 尚未启用 Gate 实盘"
    : moduleDetail("实盘协调器", health, stale, control.lastError);
  return {
    module: "live_coordinator",
    label: "实盘协调器",
    health,
    state: control.state,
    lastRunAt,
    lastSuccessAt,
    nextRunAt: ensured.nextRunAt ?? null,
    staleForMs: stale,
    lastError: control.lastError ?? null,
    autoRecoveryTriggered,
    detail,
  };
}

function overallHealth(modules: (RuntimeModuleHealth | null)[]): RuntimeHealthState {
  const states = modules.filter((item): item is RuntimeModuleHealth => Boolean(item)).map((item) => item.health);
  if (!states.length) return "failed";
  if (states.includes("failed")) return "failed";
  if (states.includes("recovering")) return "recovering";
  if (states.includes("degraded")) return "degraded";
  if (states.includes("starting")) return "starting";
  if (states.every((state) => state === "paused")) return "paused";
  return "healthy";
}

export async function ensureBackgroundSchedulers(): Promise<BackgroundSchedulerStatus> {
  const bindings = getRuntimeBindings();
  if (bindings.BACKGROUND_MODE !== "cloudflare-free" || !bindings.POSITION_MONITOR || !bindings.MARKET_SCANNER) {
    return {
      mode: "foreground-only",
      active: false,
      observedAt: Date.now(),
      overall: "failed",
      positionCadenceSeconds: null,
      scanCadenceSeconds: null,
      deepBatchSize: null,
      position: null,
      scanner: null,
      live: null,
      issues: [{ module: "background", health: "failed", message: "Cloudflare 后台调度绑定不可用" }],
    };
  }

  const positionStub = bindings.POSITION_MONITOR.getByName("position-monitor");
  const scannerStub = bindings.MARKET_SCANNER.getByName("market-scanner");
  const settled = await Promise.allSettled([
    inspectScheduler(positionStub, "position_monitor", "持仓监控", POSITION_STALE_MS),
    inspectScheduler(scannerStub, "market_scanner", "市场扫描", SCANNER_STALE_MS),
    inspectLiveCoordinator(bindings),
  ]);

  const position = settled[0].status === "fulfilled" ? settled[0].value : null;
  const scanner = settled[1].status === "fulfilled" ? settled[1].value : null;
  const live = settled[2].status === "fulfilled" ? settled[2].value : null;
  const failures = settled.flatMap((result, index) => result.status === "rejected"
    ? [{ module: ["持仓监控", "市场扫描", "实盘协调器"][index], health: "failed" as const, message: result.reason instanceof Error ? result.reason.message : "模块状态读取失败" }]
    : []);
  const moduleIssues = [position, scanner, live].filter((item): item is RuntimeModuleHealth => Boolean(item))
    .filter((item) => ["degraded", "recovering", "failed"].includes(item.health))
    .map((item) => ({ module: item.label, health: item.health, message: item.detail }));
  const modules = [position, scanner, live];
  const overall = failures.length ? "failed" : overallHealth(modules);

  return {
    mode: "cloudflare-free",
    active: Boolean(position && scanner),
    observedAt: Date.now(),
    overall,
    positionCadenceSeconds: 10,
    scanCadenceSeconds: 60,
    deepBatchSize: 3,
    position,
    scanner,
    live,
    issues: [...failures, ...moduleIssues].slice(0, 10),
    ...(failures.length ? { error: failures.map((item) => `${item.module}: ${item.message}`).join("; ") } : {}),
  };
}
