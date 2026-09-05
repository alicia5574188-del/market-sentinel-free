/// <reference types="@cloudflare/workers-types" />

/** Cloudflare Worker entry point for the vinext-starter template. */
import { DurableObject } from "cloudflare:workers";
import type { HistoricalArchive } from "./historical-archive";
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { setRuntimeDb } from "../db";
import { setRuntimeBindings } from "../lib/runtime-bindings";
import { runMarketScan, refreshOpenPositions } from "../lib/scanner";
import { snapshotBackgroundUniverse, type BackgroundMarketSnapshot } from "../lib/background-selection";
import { getSettings, publicSettings } from "../lib/repository";
import { SYMBOL_PATTERN, type GateAnalysisPacket } from "../lib/gate-client";
import type { SchedulerWorkerStatus } from "../lib/background-scheduler";
import { resolveVapidConfig } from "../lib/vapid-config";
import { workerVersionChanged } from "../lib/live-deployment-safety";
import {
  createFreeMarketScanJob,
  freeMarketScanPhaseLabel,
  runFreeMarketScanStep,
  type FreeMarketScanJob,
} from "../lib/free-market-scan";
import {
  getLiveTradingSnapshot,
  liveAlarmDelayMs,
  pauseAutomaticEntryForRecovery,
  reconcileLiveTrading,
  removeGateCredentials,
  resetEmergencyStop,
  runEmergencyStop,
  saveGateCredentials,
  setAutomaticEntry,
} from "../lib/live-trading-engine";
import {
  accessCodeMatches,
  clearOwnerCookie,
  ownerCookie,
  ownerSessionMatches,
  ownerSessionValue,
  validOwnerAccessToken,
} from "../lib/owner-access";

export interface CloudflareEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  HISTORICAL_ARCHIVE?: DurableObjectNamespace<HistoricalArchive>;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
  BACKGROUND_MODE?: string;
  SITE_OWNER_EMAIL?: string;
  OWNER_ACCESS_TOKEN?: string;
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
  POSITION_MONITOR?: DurableObjectNamespace<PositionMonitor>;
  MARKET_SCANNER?: DurableObjectNamespace<MarketScanner>;
  LIVE_TRADING_COORDINATOR?: DurableObjectNamespace<LiveTradingCoordinator>;
  IMAGES?: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

type BackgroundReadModel = {
  observedAt: number;
  status: "completed" | "degraded";
  universe: unknown[];
  context: unknown;
  v2: unknown;
  openTrades: unknown[];
  settings: ReturnType<typeof publicSettings>;
  failures: { symbol: string; error: string }[];
};

type BackgroundMarketRead = {
  savedAt: number;
  packet: GateAnalysisPacket;
};

function defaultSchedulerStatus(): SchedulerWorkerStatus {
  return {
    state: "starting",
    lastRunAt: null,
    nextRunAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
}

abstract class SchedulerObject extends DurableObject<CloudflareEnv> {
  protected abstract readonly intervalMs: number;

  async ensure(): Promise<SchedulerWorkerStatus> {
    const now = Date.now();
    const status = await this.ctx.storage.get<SchedulerWorkerStatus>("status") ?? defaultSchedulerStatus();
    let nextRunAt = await this.ctx.storage.getAlarm();
    if (status.circuitOpen && status.retryAfter != null && status.retryAfter > now) {
      if (nextRunAt !== status.retryAfter) {
        nextRunAt = status.retryAfter;
        await this.ctx.storage.setAlarm(nextRunAt);
      }
      return { ...status, nextRunAt };
    }
    const activityAt = status.lastRunAt ?? status.lastSuccessAt;
    const staleActivity = status.state !== "paused"
      && activityAt != null
      && now - activityAt > Math.max(this.intervalMs * 3, 90_000);
    const invalidAlarm = nextRunAt != null
      && (nextRunAt < now - 5_000 || nextRunAt > now + Math.max(this.intervalMs * 4, 120_000));
    if (nextRunAt == null || invalidAlarm || staleActivity) {
      nextRunAt = now + 1_000;
      await this.ctx.storage.setAlarm(nextRunAt);
    }
    return { ...status, nextRunAt };
  }

  async status(): Promise<SchedulerWorkerStatus> {
    const status = await this.ctx.storage.get<SchedulerWorkerStatus>("status") ?? defaultSchedulerStatus();
    return { ...status, nextRunAt: await this.ctx.storage.getAlarm() ?? status.nextRunAt };
  }

  async wake(): Promise<{ ok: true; nextRunAt: number }> {
    const status = await this.ctx.storage.get<SchedulerWorkerStatus>("status") ?? defaultSchedulerStatus();
    const now = Date.now();
    if (status.circuitOpen && status.retryAfter != null && status.retryAfter > now) {
      await this.ctx.storage.setAlarm(status.retryAfter);
      return { ok: true, nextRunAt: status.retryAfter };
    }
    const nextRunAt = now + Math.min(1_000, this.intervalMs);
    await this.ctx.storage.setAlarm(nextRunAt);
    return { ok: true, nextRunAt };
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown scheduler error";
}

async function readHealthStatus<T>(promise: Promise<T>, timeoutMs = 900): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`health_status_timeout_${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class PositionMonitor extends SchedulerObject {
  protected readonly intervalMs = 10_000;

  async alarm(): Promise<void> {
    const startedAt = Date.now();
    let nextRunAt = startedAt + 10_000;
    await this.ctx.storage.setAlarm(nextRunAt);
    const previous = await this.ctx.storage.get<SchedulerWorkerStatus>("status") ?? defaultSchedulerStatus();
    setRuntimeDb(this.env.DB);
    setRuntimeBindings(this.env);
    try {
      const settings = await getSettings();
      if (!settings.scanEnabled) {
        nextRunAt = startedAt + 60_000;
        await this.ctx.storage.setAlarm(nextRunAt);
        await this.ctx.storage.put<SchedulerWorkerStatus>("status", {
          ...previous,
          state: "paused",
          lastRunAt: startedAt,
          nextRunAt,
          lastError: null,
          refreshed: 0,
        });
        return;
      }
      const result = await refreshOpenPositions(resolveVapidConfig(this.env), { includeDashboard: false });
      await this.ctx.storage.put<SchedulerWorkerStatus>("status", {
        state: result.status === "degraded" ? "degraded" : "live",
        lastRunAt: startedAt,
        nextRunAt,
        lastSuccessAt: result.observedAt,
        lastError: result.failures.length ? result.failures.map((failure) => `${failure.symbol}: ${failure.error}`).join("; ") : null,
        refreshed: result.refreshed,
      });
    } catch (error) {
      await this.ctx.storage.put<SchedulerWorkerStatus>("status", {
        ...previous,
        state: "error",
        lastRunAt: startedAt,
        nextRunAt,
        lastError: errorMessage(error),
      });
    }
  }
}

export class MarketScanner extends SchedulerObject {
  protected readonly intervalMs = 20_000;

  async readModel(): Promise<BackgroundReadModel | null> {
    return await this.ctx.storage.get<BackgroundReadModel>("foregroundReadModel") ?? null;
  }

  async marketSnapshot(symbol: string): Promise<{ readModel: BackgroundReadModel | null; deep: BackgroundMarketRead | null }> {
    if (!SYMBOL_PATTERN.test(symbol)) return { readModel: null, deep: null };
    const [readModel, deep] = await Promise.all([
      this.ctx.storage.get<BackgroundReadModel>("foregroundReadModel"),
      this.ctx.storage.get<BackgroundMarketRead>(`foregroundMarket:${symbol}`),
    ]);
    return { readModel: readModel ?? null, deep: deep ?? null };
  }

  async status(): Promise<SchedulerWorkerStatus> {
    const status = await super.status();
    const now = Date.now();
    if (!status.circuitOpen && status.state === "starting" && status.lastRunAt != null && now - status.lastRunAt > 40_000) {
      return {
        ...status,
        state: "error",
        lastError: status.lastError ?? `市场扫描阶段「${status.phase ?? "unknown"}」在完成状态写入前中断；后台只会重试当前阶段。`,
      };
    }
    return status;
  }

  private async runCycle(): Promise<SchedulerWorkerStatus> {
    const startedAt = Date.now();
    const previous = await this.ctx.storage.get<SchedulerWorkerStatus>("status") ?? defaultSchedulerStatus();
    if (previous.lastRunAt != null && startedAt - previous.lastRunAt < 750) {
      const nextRunAt = await this.ctx.storage.getAlarm() ?? startedAt + 1_000;
      if (await this.ctx.storage.getAlarm() == null) await this.ctx.storage.setAlarm(nextRunAt);
      return { ...previous, nextRunAt };
    }

    const rotationOffset = await this.ctx.storage.get<number>("rotationOffset") ?? 0;
    const previousMarketSnapshot = await this.ctx.storage.get<BackgroundMarketSnapshot>("backgroundMarketSnapshot") ?? {};
    let job = await this.ctx.storage.get<FreeMarketScanJob>("freeScanJob")
      ?? createFreeMarketScanJob(rotationOffset, previousMarketSnapshot);

    if (job.retryAfter != null && job.retryAfter > startedAt) {
      await this.ctx.storage.setAlarm(job.retryAfter);
      const status: SchedulerWorkerStatus = {
        ...previous,
        state: "degraded",
        lastRunAt: previous.lastRunAt,
        nextRunAt: job.retryAfter,
        lastError: `市场扫描阶段「${freeMarketScanPhaseLabel(job.phase)}」已熔断，等待冷却后只重试该阶段。`,
        phase: freeMarketScanPhaseLabel(job.phase),
        phaseAttempt: job.phaseAttempts[job.phase] ?? 0,
        circuitOpen: true,
        retryAfter: job.retryAfter,
        jobId: job.jobId,
      };
      await this.ctx.storage.put<SchedulerWorkerStatus>("status", status);
      return status;
    }

    if (job.retryAfter != null && job.retryAfter <= startedAt) {
      job = {
        ...job,
        retryAfter: null,
        phaseAttempts: { ...job.phaseAttempts, [job.phase]: 0 },
      };
      await this.ctx.storage.put("freeScanJob", job);
    }

    const priorAttempts = job.phaseAttempts[job.phase] ?? 0;
    if (priorAttempts >= 3) {
      const retryAfter = startedAt + 5 * 60_000;
      job = { ...job, retryAfter };
      await this.ctx.storage.put("freeScanJob", job);
      await this.ctx.storage.setAlarm(retryAfter);
      const status: SchedulerWorkerStatus = {
        ...previous,
        state: "degraded",
        lastRunAt: previous.lastRunAt,
        nextRunAt: retryAfter,
        lastError: `市场扫描阶段「${freeMarketScanPhaseLabel(job.phase)}」连续 3 次未完成，已停止快速重试 5 分钟；不会再从头启动整轮扫描。`,
        phase: freeMarketScanPhaseLabel(job.phase),
        phaseAttempt: priorAttempts,
        circuitOpen: true,
        retryAfter,
        jobId: job.jobId,
      };
      await this.ctx.storage.put<SchedulerWorkerStatus>("status", status);
      return status;
    }

    const phaseAttempt = priorAttempts + 1;
    job = {
      ...job,
      retryAfter: null,
      phaseAttempts: { ...job.phaseAttempts, [job.phase]: phaseAttempt },
    };
    await this.ctx.storage.put("freeScanJob", job);

    // The fallback alarm survives a hard Cloudflare termination. Because the
    // job and phase attempt are already durable, the next invocation resumes
    // this exact phase instead of restarting Universe -> Global Risk -> deep scan.
    let nextRunAt = startedAt + 35_000;
    await this.ctx.storage.setAlarm(nextRunAt);
    await this.ctx.storage.put<SchedulerWorkerStatus>("status", {
      ...previous,
      state: "starting",
      lastRunAt: startedAt,
      nextRunAt,
      lastError: null,
      phase: freeMarketScanPhaseLabel(job.phase),
      phaseAttempt,
      circuitOpen: false,
      retryAfter: null,
      jobId: job.jobId,
    });

    setRuntimeDb(this.env.DB);
    setRuntimeBindings(this.env);
    try {
      const step = await runFreeMarketScanStep(job, resolveVapidConfig(this.env));

      if (step.kind === "progress") {
        await this.ctx.storage.put("freeScanJob", step.job);
        nextRunAt = Date.now() + 1_000;
        await this.ctx.storage.setAlarm(nextRunAt);
        const status: SchedulerWorkerStatus = {
          ...previous,
          state: "starting",
          lastRunAt: startedAt,
          nextRunAt,
          lastError: null,
          phase: freeMarketScanPhaseLabel(step.job.phase),
          phaseAttempt: step.job.phaseAttempts[step.job.phase] ?? 0,
          circuitOpen: false,
          retryAfter: null,
          jobId: step.job.jobId,
        };
        await this.ctx.storage.put<SchedulerWorkerStatus>("status", status);
        return status;
      }

      if (step.kind === "paused") {
        await this.ctx.storage.delete("freeScanJob");
        nextRunAt = Date.now() + 60_000;
        await this.ctx.storage.setAlarm(nextRunAt);
        const status: SchedulerWorkerStatus = {
          ...previous,
          state: "paused",
          lastRunAt: startedAt,
          nextRunAt,
          lastError: null,
          phase: null,
          phaseAttempt: 0,
          circuitOpen: false,
          retryAfter: null,
          jobId: null,
        };
        await this.ctx.storage.put<SchedulerWorkerStatus>("status", status);
        return status;
      }

      const result = step.result;
      await this.ctx.storage.delete("freeScanJob");
      await this.ctx.storage.put("rotationOffset", rotationOffset + 1);
      const readModel: BackgroundReadModel = {
        observedAt: result.observedAt,
        status: result.status,
        universe: result.universe,
        context: result.context,
        v2: result.v2,
        openTrades: result.openTrades,
        settings: result.settings,
        failures: result.failures,
      };
      await this.ctx.storage.put("backgroundMarketSnapshot", snapshotBackgroundUniverse(result.universe));
      await this.ctx.storage.put("foregroundReadModel", readModel);
      for (const packet of result.analyzed) {
        await this.ctx.storage.put<BackgroundMarketRead>(`foregroundMarket:${packet.symbol}`, {
          savedAt: packet.observedAt,
          packet,
        });
      }

      nextRunAt = Math.max(Date.now() + 5_000, startedAt + 20_000);
      await this.ctx.storage.setAlarm(nextRunAt);
      const status: SchedulerWorkerStatus = {
        state: result.status === "degraded" ? "degraded" : "live",
        lastRunAt: startedAt,
        nextRunAt,
        lastSuccessAt: result.observedAt,
        lastError: result.failures.length
          ? result.failures.map((failure) => `${failure.symbol}: ${failure.error}`).join("; ")
          : null,
        analyzed: result.analyzed.length,
        symbols: result.analyzed.map((packet) => packet.symbol),
        phase: null,
        phaseAttempt: 0,
        circuitOpen: false,
        retryAfter: null,
        jobId: null,
      };
      await this.ctx.storage.put<SchedulerWorkerStatus>("status", status);
      return status;
    } catch (error) {
      nextRunAt = Date.now() + 10_000;
      await this.ctx.storage.setAlarm(nextRunAt);
      const status: SchedulerWorkerStatus = {
        ...previous,
        state: "error",
        lastRunAt: startedAt,
        nextRunAt,
        lastError: `阶段「${freeMarketScanPhaseLabel(job.phase)}」失败：${errorMessage(error)}`,
        phase: freeMarketScanPhaseLabel(job.phase),
        phaseAttempt,
        circuitOpen: false,
        retryAfter: null,
        jobId: job.jobId,
      };
      await this.ctx.storage.put<SchedulerWorkerStatus>("status", status);
      console.error("market scanner phase failed", status.lastError);
      return status;
    }
  }

  async runIfDue(): Promise<SchedulerWorkerStatus> {
    return this.runCycle();
  }

  async alarm(): Promise<void> {
    await this.runCycle();
  }
}

export class LiveTradingCoordinator extends DurableObject<CloudflareEnv> {
  private operationTail: Promise<void> = Promise.resolve();

  private initializeRuntime() {
    setRuntimeDb(this.env.DB);
    setRuntimeBindings(this.env);
  }

  private async enforceDeploymentBoundary() {
    const versionId = this.env.CF_VERSION_METADATA?.id?.trim();
    if (!versionId) return;
    const previousVersionId = await this.ctx.storage.get<string>("workerVersionId");
    if (!workerVersionChanged(previousVersionId, versionId)) return;
    const snapshot = await getLiveTradingSnapshot();
    if (snapshot.control.entryEnabled && snapshot.control.state === "armed") {
      // A deployment is a safety boundary, but it must not erase the owner's
      // 24/7 Auto Live intent. Mark one recovery cycle instead: reconcile all
      // Gate positions/orders and account risk first, skip new entry for that
      // clean cycle, then resume automatically on the following alarm.
      await pauseAutomaticEntryForRecovery(
        `Worker 已更新到新版本 ${versionId.slice(0, 8)}，正在执行部署后安全对账`,
        "worker_deployment_recovery_pause",
      );
      await this.schedule(1_000);
    }
    await this.ctx.storage.put("workerVersionId", versionId);
  }

  private async schedule(delayMs = 1_000) {
    const current = await this.ctx.storage.getAlarm();
    const requested = Date.now() + delayMs;
    if (current == null || current > requested) await this.ctx.storage.setAlarm(requested);
  }

  private async ensureScheduled() {
    const current = await this.ctx.storage.getAlarm();
    if (current != null) return current;
    const requested = Date.now() + 1_000;
    await this.ctx.storage.setAlarm(requested);
    return requested;
  }

  private async nextLiveDelay() {
    try {
      return await liveAlarmDelayMs();
    } catch {
      return 10_000;
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      this.initializeRuntime();
      await this.enforceDeploymentBoundary();
      return await operation();
    } finally {
      release();
    }
  }

  async ensure() {
    return this.exclusive(async () => {
      const nextRunAt = await this.ensureScheduled();
      return { ok: true as const, nextRunAt };
    });
  }

  async snapshot() {
    return this.exclusive(() => getLiveTradingSnapshot());
  }

  async saveCredentials(input: Parameters<typeof saveGateCredentials>[0], actorAccountId: string) {
    return this.exclusive(async () => {
      const result = await saveGateCredentials(input, actorAccountId);
      await this.schedule();
      return result;
    });
  }

  async removeCredentials(actorAccountId: string) {
    return this.exclusive(() => removeGateCredentials(actorAccountId));
  }

  async setAutomaticEntry(enabled: boolean, actorAccountId: string) {
    return this.exclusive(async () => {
      const result = await setAutomaticEntry(enabled, actorAccountId);
      await this.schedule();
      return result;
    });
  }

  async emergencyStop(actorAccountId: string) {
    return this.exclusive(async () => {
      const result = await runEmergencyStop(actorAccountId);
      await this.schedule(10_000);
      return result;
    });
  }

  async resetEmergencyStop(actorAccountId: string) {
    return this.exclusive(async () => {
      const result = await resetEmergencyStop(actorAccountId);
      await this.schedule(60_000);
      return result;
    });
  }

  async reconcileNow() {
    return this.exclusive(async () => {
      const result = await reconcileLiveTrading();
      await this.schedule(await this.nextLiveDelay());
      return result;
    });
  }

  async alarm(): Promise<void> {
    await this.exclusive(async () => {
      try {
        await reconcileLiveTrading();
      } catch (error) {
        // Error details are persisted in the redacted live control/audit records.
        console.error("live trading reconciliation failed", error instanceof Error ? error.message : "unknown error");
      } finally {
        await this.ctx.storage.setAlarm(Date.now() + await this.nextLiveDelay());
      }
    });
  }
}

async function runScheduledSchedulers(env: CloudflareEnv) {
  if (!env.POSITION_MONITOR || !env.MARKET_SCANNER) {
    await runMarketScan(resolveVapidConfig(env));
    return;
  }
  await Promise.all([
    env.POSITION_MONITOR.getByName("position-monitor").ensure(),
    env.MARKET_SCANNER.getByName("market-scanner").runIfDue(),
    env.LIVE_TRADING_COORDINATOR?.getByName("live-trading").ensure(),
  ]);
}

function loginPage(error = false, unavailable = false) {
  const message = unavailable
    ? "后台访问密钥尚未配置，请重新运行一键部署程序。"
    : error
      ? "访问码不正确，请重新输入。"
      : "请输入部署程序生成的访问码。";
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Market Sentinel 登录</title><style>html{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#06111a;color:#e9f5ff;font-family:system-ui,-apple-system,sans-serif;padding:24px}.card{width:min(100%,390px);padding:26px;border:1px solid #203445;border-radius:18px;background:#0a1925;box-shadow:0 24px 70px #0008}.mark{width:44px;height:44px;display:grid;place-items:center;border-radius:13px;background:#43c7ef1f;color:#43c7ef;font-weight:900}h1{font-size:22px;margin:18px 0 6px}p{color:#93aabd;font-size:13px;line-height:1.6;margin:0 0 18px}input,button{width:100%;height:46px;border-radius:11px;font:inherit}input{border:1px solid #294052;background:#07131d;color:#fff;padding:0 13px;outline:none}input:focus{border-color:#43c7ef}button{border:0;margin-top:11px;background:#43c7ef;color:#04131b;font-weight:800;cursor:pointer}.error{color:#ff8791}</style></head><body><main class="card"><div class="mark">MS</div><h1>Market Sentinel</h1><p class="${error || unavailable ? "error" : ""}">${message}</p>${unavailable ? "" : '<form method="post" action="/__owner-login"><input name="access_code" type="password" autocomplete="current-password" required autofocus placeholder="访问码"><button type="submit">进入量化监控</button></form>'}</main></body></html>`, {
    status: unavailable ? 503 : error ? 401 : 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function isPublicAsset(pathname: string) {
  return pathname === "/manifest.webmanifest"
    || pathname === "/sw.js"
    || pathname === "/favicon.ico"
    || pathname.startsWith("/_next/")
    || pathname.startsWith("/assets/")
    || /\.(?:avif|css|gif|ico|jpe?g|js|json|png|svg|webp|woff2?)$/i.test(pathname);
}

async function ownerProtectedRequest(request: Request, env: CloudflareEnv): Promise<Request | Response> {
  if (env.BACKGROUND_MODE !== "cloudflare-free") return request;
  const url = new URL(request.url);

  if (url.pathname === "/__health") {
    let schedulers: unknown = null;
    let schedulerError: string | null = null;
    try {
      if (env.POSITION_MONITOR && env.MARKET_SCANNER) {
        const [position, scanner] = await Promise.all([
          readHealthStatus<SchedulerWorkerStatus>(env.POSITION_MONITOR.getByName("position-monitor").status()),
          readHealthStatus<SchedulerWorkerStatus>(env.MARKET_SCANNER.getByName("market-scanner").status()),
        ]);
        schedulers = {
          position: { state: position.state, lastRunAt: position.lastRunAt, lastSuccessAt: position.lastSuccessAt, nextRunAt: position.nextRunAt, lastError: position.lastError },
          scanner: {
            state: scanner.state,
            lastRunAt: scanner.lastRunAt,
            lastSuccessAt: scanner.lastSuccessAt,
            nextRunAt: scanner.nextRunAt,
            lastError: scanner.lastError,
            phase: scanner.phase ?? null,
            phaseAttempt: scanner.phaseAttempt ?? 0,
            circuitOpen: scanner.circuitOpen ?? false,
            retryAfter: scanner.retryAfter ?? null,
            jobId: scanner.jobId ?? null,
            analyzed: scanner.analyzed,
            symbols: scanner.symbols,
          },
        };
      }
    } catch (error) {
      schedulerError = errorMessage(error);
    }
    return Response.json({
      ok: Boolean(env.DB && env.POSITION_MONITOR && env.MARKET_SCANNER && env.LIVE_TRADING_COORDINATOR && validOwnerAccessToken(env.OWNER_ACCESS_TOKEN)),
      mode: env.BACKGROUND_MODE,
      schedulers,
      schedulerError,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  if (url.pathname === "/__owner-logout") {
    return new Response(null, {
      status: 303,
      headers: { Location: "/", "Set-Cookie": clearOwnerCookie(), "Cache-Control": "no-store" },
    });
  }

  if (url.pathname === "/__owner-login" && request.method === "POST") {
    const secret = env.OWNER_ACCESS_TOKEN;
    if (!validOwnerAccessToken(secret)) return loginPage(false, true);
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > 4_096) {
      return new Response("Invalid payload", { status: contentLength > 4_096 ? 413 : 400 });
    }
    const data = await request.formData();
    const submitted = String(data.get("access_code") ?? "");
    if (!(await accessCodeMatches(submitted, secret))) return loginPage(true);
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/",
        "Set-Cookie": ownerCookie(await ownerSessionValue(secret)),
        "Cache-Control": "no-store",
      },
    });
  }

  if (isPublicAsset(url.pathname)) return request;
  const secret = env.OWNER_ACCESS_TOKEN;
  if (!validOwnerAccessToken(secret)) return loginPage(false, true);
  if (!(await ownerSessionMatches(request.headers.get("cookie"), secret))) {
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "请先输入后台访问码" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    return loginPage();
  }

  const authenticatedHeaders = new Headers(request.headers);
  const ownerEmail = env.SITE_OWNER_EMAIL ?? "owner@market-sentinel.local";
  authenticatedHeaders.set("oai-authenticated-user-email", ownerEmail);
  authenticatedHeaders.set("oai-authenticated-user-full-name", encodeURIComponent("所有者"));
  authenticatedHeaders.set("oai-authenticated-user-full-name-encoding", "percent-encoded-utf-8");
  return new Request(request, { headers: authenticatedHeaders });
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
    setRuntimeDb(env.DB);
    setRuntimeBindings(env);
    const protectedRequest = await ownerProtectedRequest(request, env);
    if (protectedRequest instanceof Response) return protectedRequest;
    request = protectedRequest;
    const url = new URL(request.url);

    // `run_worker_first` sends every request through this Worker, including
    // Vite's hashed CSS and client bundles. Vinext does not fall through to the
    // Assets binding for `/assets/*`, so serving those requests through the app
    // handler leaves the SSR markup unstyled and unhydrated. Return a real
    // static asset before invoking the Vinext router, while preserving its 404
    // fallback for route-like paths that merely have a file extension.
    if (isPublicAsset(url.pathname)) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) return assetResponse;
    }

    if (url.pathname === "/_vinext/image") {
      const images = env.IMAGES;
      if (!images) return new Response("Image transformation unavailable", { status: 404 });
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await images.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext): Promise<void> {
    setRuntimeDb(env.DB);
    setRuntimeBindings(env);
    ctx.waitUntil(runScheduledSchedulers(env));
  },
} satisfies ExportedHandler<CloudflareEnv>;

export default worker;
