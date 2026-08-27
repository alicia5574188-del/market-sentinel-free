"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

type HealthState = "healthy" | "starting" | "paused" | "degraded" | "recovering" | "failed";
type ModuleHealth = {
  module: string;
  label: string;
  health: HealthState;
  state: string;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  nextRunAt: number | null;
  staleForMs: number | null;
  lastError: string | null;
  autoRecoveryTriggered: boolean;
  detail: string;
};
type BackgroundHealth = {
  observedAt: number;
  overall: HealthState;
  active: boolean;
  position: ModuleHealth | null;
  scanner: ModuleHealth | null;
  live: ModuleHealth | null;
  issues: { module: string; health: HealthState; message: string }[];
  error?: string;
};

type WindowWithSentinelFetch = Window & typeof globalThis & {
  __SENTINEL_NATIVE_FETCH__?: typeof window.fetch;
  __SENTINEL_RESILIENT_FETCH_INSTALLED__?: boolean;
};

const RETRY_DELAYS = [350, 900];
const READ_TIMEOUT_MS = 8_000;
const MUTATION_TIMEOUT_MS = 20_000;
const DEEP_SCAN_TIMEOUT_MS = 45_000;

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function requestInfo(input: RequestInfo | URL, init?: RequestInit) {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, window.location.href);
    if (url.origin !== window.location.origin || !(url.pathname.startsWith("/api/") || url.pathname === "/__health")) return null;
    return { method, url };
  } catch {
    return null;
  }
}

function retryableRequest(input: RequestInfo | URL, init?: RequestInit) {
  const info = requestInfo(input, init);
  const method = info?.method ?? (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET") return false;
  return Boolean(info);
}

function requestTimeoutMs(input: RequestInfo | URL, init?: RequestInit) {
  const info = requestInfo(input, init);
  if (!info) return null;
  if (info.method === "GET") return READ_TIMEOUT_MS;
  if (info.url.pathname === "/api/scan/run") return DEEP_SCAN_TIMEOUT_MS;
  return MUTATION_TIMEOUT_MS;
}

async function fetchWithTimeout(nativeFetch: typeof window.fetch, input: RequestInfo | URL, init: RequestInit | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const sourceSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  let timedOut = false;
  const relayAbort = () => controller.abort(sourceSignal?.reason);
  if (sourceSignal?.aborted) relayAbort();
  else sourceSignal?.addEventListener("abort", relayAbort, { once: true });
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await nativeFetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}秒）`);
    throw error;
  } finally {
    window.clearTimeout(timer);
    sourceSignal?.removeEventListener("abort", relayAbort);
  }
}

function installResilientFetch(onRecovered: () => void) {
  const sentinelWindow = window as WindowWithSentinelFetch;
  if (sentinelWindow.__SENTINEL_RESILIENT_FETCH_INSTALLED__) return;
  const nativeFetch = window.fetch.bind(window);
  sentinelWindow.__SENTINEL_NATIVE_FETCH__ = nativeFetch;
  sentinelWindow.__SENTINEL_RESILIENT_FETCH_INSTALLED__ = true;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const timeoutMs = requestTimeoutMs(input, init);
    if (timeoutMs == null) return nativeFetch(input, init);
    if (!retryableRequest(input, init)) return fetchWithTimeout(nativeFetch, input, init, timeoutMs);
    let lastError: unknown = null;
    let lastResponse: Response | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
      try {
        const response = await fetchWithTimeout(nativeFetch, input, { ...init, cache: "no-store" }, timeoutMs);
        lastResponse = response;
        const transient = response.status === 429 || response.status >= 500;
        if (!transient || attempt === RETRY_DELAYS.length) {
          if (attempt > 0 && response.ok) onRecovered();
          return response;
        }
      } catch (error) {
        lastError = error;
        if (attempt === RETRY_DELAYS.length) throw error;
      }
      await wait(RETRY_DELAYS[attempt]);
    }
    if (lastResponse) return lastResponse;
    throw lastError instanceof Error ? lastError : new Error("网络请求失败");
  }) as typeof window.fetch;
}

function relativeTime(timestamp: number | null) {
  if (!timestamp) return "尚无成功记录";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}分钟前`;
  return `${Math.round(seconds / 3600)}小时前`;
}

const HEALTH_LABEL: Record<HealthState, string> = {
  healthy: "运行正常",
  starting: "启动中",
  paused: "已暂停",
  degraded: "局部降级",
  recovering: "自动恢复中",
  failed: "需要处理",
};

function moduleSummary(module: ModuleHealth | null) {
  if (!module) return null;
  return (
    <div className={`runtime-module runtime-${module.health}`} key={module.module}>
      <span><i />{module.label}</span>
      <strong>{HEALTH_LABEL[module.health]}</strong>
      <small>{module.detail} · 最近成功 {relativeTime(module.lastSuccessAt)}</small>
      {module.lastError && <em>{module.lastError}</em>}
    </div>
  );
}

export function RuntimeStabilityClient() {
  const [health, setHealth] = useState<BackgroundHealth | null>(null);
  const [healthError, setHealthError] = useState("");
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [recoveredRequests, setRecoveredRequests] = useState(0);

  useEffect(() => {
    installResilientFetch(() => setRecoveredRequests((value) => value + 1));
  }, []);

  useEffect(() => {
    const ensureMount = () => {
      const banner = document.querySelector(".replay-banner");
      if (!banner) return;
      let target = document.getElementById("runtime-stability-target");
      if (!target) {
        target = document.createElement("div");
        target.id = "runtime-stability-target";
        banner.insertAdjacentElement("afterend", target);
      }
      setMount(target);
    };
    ensureMount();
    const observer = new MutationObserver(ensureMount);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/background", { cache: "no-store" });
        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok || !contentType.toLowerCase().includes("application/json")) throw new Error(`系统健康检查失败 (${response.status})`);
        const next = await response.json() as BackgroundHealth;
        if (!cancelled) {
          setHealth(next);
          setHealthError("");
        }
      } catch (error) {
        if (!cancelled) setHealthError(error instanceof Error ? error.message : "系统健康检查暂不可用");
      }
    };
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 20_000);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const effectiveState: HealthState = healthError ? "degraded" : health?.overall ?? "starting";
  const issueText = useMemo(() => {
    if (healthError) return healthError;
    if (!health) return "正在检查后台扫描、持仓监控与实盘协调器";
    if (health.issues?.length) return health.issues[0].message;
    return recoveredRequests > 0 ? `核心模块正常 · 本机已自动恢复 ${recoveredRequests} 次短暂网络请求` : "扫描、持仓监控与实盘协调器均正常";
  }, [health, healthError, recoveredRequests]);

  if (!mount) return null;
  return createPortal(
    <section className={`runtime-health runtime-${effectiveState}`} aria-label="系统运行健康">
      <button className="runtime-health-summary" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span><i />系统健康 · {HEALTH_LABEL[effectiveState]}</span>
        <small>{issueText}</small>
        <b>{expanded ? "收起" : "详情"}</b>
      </button>
      {expanded && <div className="runtime-health-detail">
        {[health?.scanner ?? null, health?.position ?? null, health?.live ?? null].map(moduleSummary)}
        {recoveredRequests > 0 && <div className="runtime-recovery-note">网络自动恢复：本次打开程序后已成功重试 {recoveredRequests} 次，未因此丢弃最后可靠数据。</div>}
        {health?.issues?.length ? <div className="runtime-issues">{health.issues.slice(0, 5).map((issue, index) => <p key={`${issue.module}-${index}`}><strong>{issue.module}</strong>{issue.message}</p>)}</div> : null}
      </div>}
    </section>,
    mount,
  );
}
