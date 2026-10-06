import type { CloudflareEnv } from "./index-clean.ts";
import type { BankruptcyReport } from "../lib/paper-cycle.ts";
import { clearOwnerSessionCookie, createOwnerSession, ownerAuthConfigured, ownerPasswordMatches, ownerSessionCookie, sameOriginMutation, verifyOwnerSession } from "../lib/owner-auth.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

export const isAsset = (pathname: string) => pathname.startsWith("/_next/") || pathname.startsWith("/assets/") || /\.[a-z0-9]{2,8}$/i.test(pathname);
let runtimeCache: { response: string; expiresAt: number } | null = null;
const historyCache = new Map<string, { response: string; expiresAt: number }>();
let accountLogCache: { response: string; expiresAt: number } | null = null;
let strategyLogCache: { response: string; expiresAt: number } | null = null;
const failedLogins = new Map<string, { count: number; resetAt: number }>();
export async function runtimeStatus(env: CloudflareEnv, useCache = true, owner = false) {
  if (!owner && useCache && runtimeCache && runtimeCache.expiresAt > Date.now()) return new Response(runtimeCache.response, { headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=10" } });
  const response = await env.MARKET_STREAM.getByName("primary").fetch(owner ? "https://market-stream/owner-runtime" : "https://market-stream/status");
  const body = await response.text();
  if (!owner && response.ok) runtimeCache = { response: body, expiresAt: Date.now() + 10_000 };
  return new Response(body, { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=10" } });
}

export async function paperHistory(url: URL, env: CloudflareEnv) {
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 100) || 100));
  const cursor = url.searchParams.get("cursor") ?? "";
  const separator = cursor.indexOf("|");
  const beforeAt = separator > 0 ? Number(cursor.slice(0, separator)) : null;
  const beforeId = separator > 0 ? cursor.slice(separator + 1) : null;
  if (cursor && (!(beforeAt! > 0) || !beforeId || beforeId.length > 96)) return json({ error: "invalid history cursor" }, 400);
  const cacheKey = `${limit}:${cursor}`;
  const cached = historyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return new Response(cached.response, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=10" } });
  }
  const result = await env.DB.prepare(`SELECT
    id, symbol, market_state AS marketState, side, status,
    entry_at AS entryAt, entry_price AS entryPrice, initial_stop AS initialStop,
    current_stop AS currentStop, current_target AS currentTarget,
    planned_risk AS plannedRisk, notional,
    exit_at AS exitAt, exit_price AS exitPrice,
    exit_reason AS exitReason, realized_pnl AS realizedPnl, fees_and_slippage AS feesAndSlippage
    FROM paper_positions
    WHERE (? IS NULL OR COALESCE(exit_at,entry_at) < ? OR (COALESCE(exit_at,entry_at)=? AND id<?))
    ORDER BY COALESCE(exit_at,entry_at) DESC,id DESC
    LIMIT ?`).bind(beforeAt, beforeAt, beforeAt, beforeId, limit + 1).all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const items = rows.slice(0, limit);
  const tail = items.at(-1);
  const sortAt = tail ? Number(tail.exitAt ?? tail.entryAt) : null;
  const nextCursor = rows.length > limit && tail && sortAt ? `${sortAt}|${String(tail.id)}` : null;
  const body = JSON.stringify({ items, nextCursor, generatedAt: Date.now() });
  historyCache.set(cacheKey, { response: body, expiresAt: Date.now() + 10_000 });
  if (historyCache.size > 30) historyCache.delete(historyCache.keys().next().value!);
  return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=10" } });
}

export async function accountLogs(env: CloudflareEnv) {
  if (accountLogCache && accountLogCache.expiresAt > Date.now()) {
    return new Response(accountLogCache.response, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } });
  }
  const result = await env.DB.prepare(`SELECT id,observed_at AS observedAt,payload_json AS payload
    FROM paper_events WHERE event_type='PAPER_BANKRUPTCY'
    ORDER BY observed_at DESC LIMIT 30`).all<{ id: string; observedAt: number; payload: string }>();
  const items = (result.results ?? []).flatMap((row) => {
    try { return [{ id: row.id, observedAt: row.observedAt, report: JSON.parse(row.payload) as BankruptcyReport }]; }
    catch { return []; }
  });
  const body = JSON.stringify({ items, generatedAt: Date.now() });
  accountLogCache = { response: body, expiresAt: Date.now() + 30_000 };
  return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } });
}

export async function strategyRuntimeLogs(url: URL, env: CloudflareEnv) {
  const limit = Math.max(1, Math.min(576, Number(url.searchParams.get("limit") ?? 288) || 288));
  if (strategyLogCache && strategyLogCache.expiresAt > Date.now() && limit === 288) {
    return new Response(strategyLogCache.response, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } });
  }
  const result = await env.DB.prepare(`SELECT id,observed_at AS observedAt,version,scanned_markets AS scannedMarkets,
    stable_markets AS stableMarkets,realtime_markets AS realtimeMarkets,regime_counts_json AS regimeCounts,
    strategy_metrics_json AS strategyMetrics,shadow_open AS shadowOpen,shadow_resolved AS shadowResolved,
    active_strategies AS activeStrategies,portfolio_open AS portfolioOpen,portfolio_equity AS portfolioEquity,
    portfolio_resolved AS portfolioResolved,portfolio_net_pnl AS portfolioNetPnl,strategy_candle_error AS strategyCandleError,
    authority_state AS authorityState,live_requested AS liveRequested,live_operational AS liveOperational
    FROM strategy_runtime_log ORDER BY observed_at DESC LIMIT ?`).bind(limit).all<Record<string, unknown>>();
  const items = (result.results ?? []).flatMap((row) => {
    try {
      return [{ ...row, regimeCounts: JSON.parse(String(row.regimeCounts ?? "{}")),
        strategyMetrics: JSON.parse(String(row.strategyMetrics ?? "[]")),
        liveRequested: Boolean(row.liveRequested), liveOperational: Boolean(row.liveOperational) }];
    } catch { return []; }
  });
  const body = JSON.stringify({ items, generatedAt: Date.now(), intervalMinutes: 5, retentionDays: 14 });
  if (limit === 288) strategyLogCache = { response: body, expiresAt: Date.now() + 30_000 };
  return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" } });
}

export async function ownerAuthenticated(request: Request, env: CloudflareEnv) {
  return env.OWNER_ACCESS_TOKEN ? verifyOwnerSession(request, env.OWNER_ACCESS_TOKEN) : false;
}

export async function authSession(request: Request, env: CloudflareEnv) {
  const configured = ownerAuthConfigured(env.OWNER_ACCESS_TOKEN);
  const authenticated = await ownerAuthenticated(request, env);
  if (!authenticated) return json({ configured, authenticated: false, username: "owner" });
  // A valid owner visit renews the signed HttpOnly session. This keeps the
  // phone control surface usable without weakening same-origin LIVE mutation.
  const session = await createOwnerSession(env.OWNER_ACCESS_TOKEN!);
  return new Response(JSON.stringify({ configured, authenticated: true, username: "owner" }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": ownerSessionCookie(session) },
  });
}

export async function ownerLogin(request: Request, env: CloudflareEnv) {
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败" }, 403);
  if (!ownerAuthConfigured(env.OWNER_ACCESS_TOKEN)) return json({ error: "后台所有者访问码尚未配置" }, 503);
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 2_048) return json({ error: "登录请求过大" }, 413);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const attempt = failedLogins.get(ip);
  if (attempt && attempt.resetAt > Date.now() && attempt.count >= 5) return json({ error: "登录尝试过多，请稍后再试" }, 429);
  if (attempt && attempt.resetAt <= Date.now()) failedLogins.delete(ip);
  const body = await request.json<{ username?: unknown; password?: unknown }>().catch(() => ({} as { username?: unknown; password?: unknown }));
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const valid = username === "owner" && await ownerPasswordMatches(password, env.OWNER_ACCESS_TOKEN!);
  if (!valid) {
    const current = failedLogins.get(ip);
    failedLogins.set(ip, { count: (current?.count ?? 0) + 1, resetAt: current?.resetAt ?? Date.now() + 15 * 60_000 });
    return json({ error: "账户或密码不正确" }, 401);
  }
  failedLogins.delete(ip);
  const session = await createOwnerSession(env.OWNER_ACCESS_TOKEN!);
  return new Response(JSON.stringify({ ok: true, authenticated: true, username: "owner" }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": ownerSessionCookie(session) },
  });
}

export async function ownerLogout(request: Request) {
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败" }, 403);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": clearOwnerSessionCookie() },
  });
}

export async function ownerLiveStatus(request: Request, env: CloudflareEnv) {
  if (!await ownerAuthenticated(request, env)) return json({ error: "请先登录" }, 401);
  return env.MARKET_STREAM.getByName("primary").fetch("https://market-stream/owner-status");
}

export async function ownerLiveSource(request: Request, env: CloudflareEnv) {
  if (!await ownerAuthenticated(request, env)) return json({ error: "请先登录" }, 401);
  return env.MARKET_STREAM.getByName("primary").fetch(`https://market-stream/owner-live-source${new URL(request.url).search}`);
}

export async function ownerLiveMode(request: Request, env: CloudflareEnv) {
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败" }, 403);
  if (!await ownerAuthenticated(request, env)) return json({ error: "请先登录" }, 401);
  const body = await request.json<{ enabled?: unknown }>().catch(() => ({} as { enabled?: unknown }));
  if (typeof body.enabled !== "boolean") return json({ error: "实盘开关参数无效" }, 400);
  return env.MARKET_STREAM.getByName("primary").fetch("https://market-stream/live-mode", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: body.enabled }),
  });
}

export async function ownerLiveCredentials(request: Request, env: CloudflareEnv) {
  if (!await ownerAuthenticated(request, env)) return json({ error: "请先登录" }, 401);
  const stream = env.MARKET_STREAM.getByName("primary");
  if (request.method === "GET") return stream.fetch("https://market-stream/credential-status");
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败" }, 403);
  if (request.method === "DELETE") {
    return stream.fetch("https://market-stream/credentials", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
  }
  if (request.method !== "PUT") return json({ error: "不支持的 API 操作" }, 405);
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 2_048) return json({ error: "API 请求过大" }, 413);
  const raw = await request.text();
  if (raw.length > 2_048) return json({ error: "API 请求过大" }, 413);
  const body = (() => { try { return JSON.parse(raw) as { apiKey?: unknown; apiSecret?: unknown }; } catch { return {}; } })();
  if (typeof body.apiKey !== "string" || typeof body.apiSecret !== "string") return json({ error: "请完整填写 API Key 和 Secret" }, 400);
  return stream.fetch("https://market-stream/credentials", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: body.apiKey, apiSecret: body.apiSecret, environment: "live" }),
  });
}

export async function ownerPaperAction(request: Request, env: CloudflareEnv, action: "RESET" | "CLEAR_HISTORY") {
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败" }, 403);
  if (!await ownerAuthenticated(request, env)) return json({ error: "请先登录" }, 401);
  const body = await request.json<{ confirm?: unknown }>().catch(() => ({} as { confirm?: unknown }));
  const expected = action === "RESET" ? "RESET_PAPER" : "CLEAR_PAPER_HISTORY";
  if (body.confirm !== expected) return json({ error: "确认参数无效" }, 400);
  const path = action === "RESET" ? "/paper-reset" : "/paper-history-clear";
  const response = await env.MARKET_STREAM.getByName("primary").fetch(`https://market-stream${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  if (response.ok) {
    runtimeCache = null;
    historyCache.clear();
    accountLogCache = null;
  }
  return response;
}

