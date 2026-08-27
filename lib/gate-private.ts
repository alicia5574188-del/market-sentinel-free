import type { GateCredentials } from "./credential-vault";

const encoder = new TextEncoder();
const API_PREFIX = "/api/v4";
const DEFAULT_GATE_READ_TIMEOUT_MS = 7_000;
const DEFAULT_GATE_MUTATION_TIMEOUT_MS = 8_000;
const SAFE_READ_RETRY_DELAY_MS = 250;

export type GateFuturesAccount = {
  total?: string;
  available?: string;
  unrealised_pnl?: string;
  unrealized_pnl?: string;
  cross_unrealised_pnl?: string;
  cross_available?: string;
  currency?: string;
  in_dual_mode?: boolean;
  position_mode?: string;
  margin_mode?: number;
};

export type GateContract = {
  name?: string;
  quanto_multiplier?: string;
  leverage_min?: string;
  leverage_max?: string;
  mark_price?: string;
  order_price_round?: string;
  mark_price_round?: string;
  last_price?: string;
  order_size_min?: string;
  order_size_max?: string;
  market_order_size_max?: string;
  market_order_slip_ratio?: string;
  taker_fee_rate?: string;
  in_delisting?: boolean;
  status?: string;
};

export type GatePosition = {
  contract?: string;
  size?: string;
  leverage?: string;
  lever?: string;
  value?: string;
  margin?: string;
  entry_price?: string;
  mark_price?: string;
  unrealised_pnl?: string;
  realised_pnl?: string;
  liq_price?: string;
  liquidation_price?: string;
  mode?: "single" | "dual_long" | "dual_short";
  pos_margin_mode?: string;
  pending_orders?: number;
};

export type GateFuturesOrder = {
  id?: string | number;
  contract?: string;
  size?: string;
  left?: string;
  price?: string;
  fill_price?: string;
  status?: "open" | "finished";
  finish_as?: string;
  text?: string;
  close?: boolean;
  is_close?: boolean;
  reduce_only?: boolean;
  is_reduce_only?: boolean;
};

export type GatePriceOrder = {
  id?: string | number;
  id_string?: string;
  status?: "open" | "finished" | "inactive" | "invalid";
  finish_as?: string;
  reason?: string;
  order_type?: string;
  initial?: { contract?: string; size?: string | number; amount?: string; price?: string; close?: boolean; text?: string; reduce_only?: boolean; market_order_slip_ratio?: string };
  trigger?: { price?: string; rule?: number | string; price_type?: number | string };
};

export type GatePositionClose = {
  time?: number;
  contract?: string;
  side?: "long" | "short";
  pnl?: string;
  pnl_pnl?: string;
  pnl_fund?: string;
  pnl_fee?: string;
  text?: string;
  accum_size?: string;
  first_open_time?: number;
};

type GateRequestOptions = {
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  timeoutMs?: number;
  expiresInMs?: number;
};

type GateKeyInfo = {
  key?: string;
  perms?: { name?: string; read_only?: boolean }[];
};

export class GateApiError extends Error {
  readonly status: number;
  readonly label: string | null;
  readonly traceId: string | null;

  constructor(message: string, status: number, label: string | null, traceId: string | null) {
    super(message);
    this.name = "GateApiError";
    this.status = status;
    this.label = label;
    this.traceId = traceId;
  }
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function gateSignature(secret: string, method: string, requestPath: string, query: string, body: string, timestamp: string) {
  const bodyHash = hex(await crypto.subtle.digest("SHA-512", encoder.encode(body)));
  const signatureText = `${method.toUpperCase()}\n${requestPath}\n${query}\n${bodyHash}\n${timestamp}`;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(signatureText)));
}

function safeGateMessage(payload: unknown, status: number) {
  if (!payload || typeof payload !== "object") return `Gate 请求失败 (${status})`;
  const record = payload as Record<string, unknown>;
  const label = typeof record.label === "string" ? record.label : null;
  const message = typeof record.message === "string" ? record.message : null;
  return [label, message].filter(Boolean).join(": ").slice(0, 300) || `Gate 请求失败 (${status})`;
}

function gateTimeout(error: unknown) {
  return error instanceof Error && (
    error.name === "TimeoutError"
    || /aborted due to timeout|timed out|timeout/i.test(error.message)
  );
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GatePrivateClient {
  private readonly baseUrl: string;
  private readonly credentials: GateCredentials;
  private readonly fetcher: typeof fetch;

  constructor(credentials: GateCredentials, fetcher: typeof fetch = fetch) {
    this.credentials = credentials;
    // Cloudflare's host-provided fetch requires the Worker global as its receiver.
    // Calling an unbound host function through `this.fetcher(...)` changes `this`
    // to the GatePrivateClient instance and triggers "Illegal invocation".
    this.fetcher = fetcher.bind(globalThis) as typeof fetch;
    this.baseUrl = credentials.environment === "testnet" ? "https://api-testnet.gateapi.io" : "https://api.gateio.ws";
  }

  async request<T>(method: "GET" | "POST" | "DELETE", path: string, options: GateRequestOptions = {}): Promise<T> {
    if (!path.startsWith("/") || path.includes("..")) throw new Error("Gate API path invalid");
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) params.append(key, String(value));
    }
    const query = params.toString();
    const body = options.body === undefined ? "" : JSON.stringify(options.body);
    const requestPath = `${API_PREFIX}${path}`;
    const url = `${this.baseUrl}${requestPath}${query ? `?${query}` : ""}`;
    const safeRead = method === "GET";
    const maxAttempts = safeRead ? 2 : 1;
    const timeoutMs = options.timeoutMs ?? (safeRead ? DEFAULT_GATE_READ_TIMEOUT_MS : DEFAULT_GATE_MUTATION_TIMEOUT_MS);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const timestamp = Math.floor(Date.now() / 1_000).toString();
      const headers = new Headers({
        Accept: "application/json",
        "Content-Type": "application/json",
        KEY: this.credentials.apiKey,
        Timestamp: timestamp,
        SIGN: await gateSignature(this.credentials.apiSecret, method, requestPath, query, body, timestamp),
        "X-Gate-Size-Decimal": "1",
      });
      if (!safeRead) headers.set("x-gate-exptime", String(Date.now() + (options.expiresInMs ?? 5_000)));

      let response: Response;
      try {
        response = await this.fetcher(url, {
          method,
          headers,
          body: body || undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (safeRead && attempt + 1 < maxAttempts) {
          await wait(SAFE_READ_RETRY_DELAY_MS);
          continue;
        }
        if (gateTimeout(error)) throw new Error(`Gate ${path} 读取超时（${Math.round(timeoutMs / 1000)}秒）`);
        throw error;
      }

      const raw = await response.text();
      let payload: unknown = null;
      if (raw) {
        try { payload = JSON.parse(raw); } catch { payload = null; }
      }
      if (!response.ok) {
        if (safeRead && (response.status === 429 || response.status >= 500) && attempt + 1 < maxAttempts) {
          await wait(SAFE_READ_RETRY_DELAY_MS);
          continue;
        }
        const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
        throw new GateApiError(
          safeGateMessage(payload, response.status),
          response.status,
          typeof record?.label === "string" ? record.label : null,
          response.headers.get("x-gate-trace-id"),
        );
      }
      return payload as T;
    }

    throw new Error(`Gate ${path} 读取失败`);
  }

  async accountDetail() {
    try {
      return await this.request<{ user_id?: string | number; ip_whitelist?: string[] }>("GET", "/account/detail");
    } catch (error) {
      // A futures-only key intentionally lacks the separate Gate `account`
      // permission. Account metadata is optional for Market Sentinel; the
      // futures account endpoint below remains the authoritative credential
      // and balance check.
      if (error instanceof GateApiError && error.status === 403) return {};
      throw error;
    }
  }

  keyInfo() {
    return this.request<GateKeyInfo | GateKeyInfo[]>("GET", "/account/main_keys");
  }

  futuresAccount() {
    return this.request<GateFuturesAccount>("GET", "/futures/usdt/accounts");
  }

  positions(holding = true) {
    return this.request<GatePosition[]>("GET", "/futures/usdt/positions", { query: { holding } });
  }

  positionCloses(from: number, to: number, limit = 100, offset = 0) {
    return this.request<GatePositionClose[]>("GET", "/futures/usdt/position_close", { query: { from, to, limit, offset } });
  }

  contract(symbol: string) {
    return this.request<GateContract>("GET", `/futures/usdt/contracts/${encodeURIComponent(symbol)}`);
  }

  openOrders(contract?: string) {
    return this.request<GateFuturesOrder[]>("GET", "/futures/usdt/orders", { query: { status: "open", contract } });
  }

  order(orderIdOrText: string) {
    return this.request<GateFuturesOrder>("GET", `/futures/usdt/orders/${encodeURIComponent(orderIdOrText)}`);
  }

  setIsolatedLeverage(contract: string, leverage: number) {
    return this.request<GatePosition>("POST", `/futures/usdt/positions/${encodeURIComponent(contract)}/set_leverage`, {
      query: { leverage, margin_mode: "isolated" },
    });
  }

  createOrder(body: Record<string, unknown>) {
    return this.request<GateFuturesOrder>("POST", "/futures/usdt/orders", { body });
  }

  cancelOrder(orderId: string) {
    return this.request<GateFuturesOrder>("DELETE", `/futures/usdt/orders/${encodeURIComponent(orderId)}`, { query: { action_mode: "FULL" } });
  }

  cancelAllOrders(excludeReduceOnly = false) {
    return this.request<GateFuturesOrder[]>("DELETE", "/futures/usdt/orders", { query: { action_mode: "FULL", exclude_reduce_only: excludeReduceOnly } });
  }

  priceOrders(status: "open" | "finished" = "open", contract?: string) {
    return this.request<GatePriceOrder[]>("GET", "/futures/usdt/price_orders", { query: { status, contract } });
  }

  createPriceOrder(body: Record<string, unknown>) {
    return this.request<{ id?: string | number; id_string?: string }>("POST", "/futures/usdt/price_orders", { body });
  }

  cancelPriceOrder(orderId: string) {
    return this.request<GatePriceOrder>("DELETE", `/futures/usdt/price_orders/${encodeURIComponent(orderId)}`);
  }

  cancelAllPriceOrders(contract?: string) {
    return this.request<GatePriceOrder[]>("DELETE", "/futures/usdt/price_orders", { query: { contract } });
  }
}

export type VerifiedGateAccount = {
  userId: string | null;
  availableUsdt: number;
  totalUsdt: number;
  equityUsdt: number;
  positionMode: string;
  accountMarginMode: number | null;
  perpetualReadWrite: boolean | null;
  ipWhitelistConfigured: boolean;
};

export async function verifyGateCredentials(credentials: GateCredentials, fetcher: typeof fetch = fetch): Promise<VerifiedGateAccount> {
  const client = new GatePrivateClient(credentials, fetcher);
  const [detail, account, keyInfo] = await Promise.all([
    client.accountDetail(),
    client.futuresAccount(),
    client.keyInfo().catch(() => ({ perms: undefined })),
  ]);
  const currentKeyInfo = Array.isArray(keyInfo)
    ? keyInfo.find((item) => item.key === credentials.apiKey)
    : keyInfo;
  const perpetualPermission = currentKeyInfo?.perms?.find((permission) => /future|perpetual|contract/i.test(permission.name ?? ""));
  const perpetualReadWrite = perpetualPermission ? perpetualPermission.read_only === false : null;
  if (perpetualReadWrite === false) throw new Error("Gate API Key 的永续合约权限是只读，请改为读写后再保存");
  const unrelatedWritePermissions = currentKeyInfo?.perms?.filter((permission) => permission.read_only === false
    && !/future|perpetual|contract/i.test(permission.name ?? "")) ?? [];
  if (unrelatedWritePermissions.length) {
    throw new Error(`Gate API Key 还开启了非永续写权限：${unrelatedWritePermissions.map((permission) => permission.name ?? "未知权限").join("、")}；请关闭后再保存`);
  }
  const positionMode = account.position_mode ?? (account.in_dual_mode ? "dual" : "single");
  if (positionMode !== "single") throw new Error("当前 Gate 合约账户不是单向持仓模式；请先切换为单向模式");
  const accountMarginMode = account.margin_mode == null ? null : Number(account.margin_mode);
  if (accountMarginMode != null && accountMarginMode !== 0) {
    throw new Error("当前仅支持 Gate 经典合约账户；统一/组合保证金账户的权益口径不同，已拒绝保存以避免错误缩仓");
  }
  const availableUsdt = Number(account.available ?? 0);
  const totalUsdt = Number(account.total ?? 0);
  if (!Number.isFinite(availableUsdt) || !Number.isFinite(totalUsdt)) throw new Error("Gate 合约账户余额响应无效");
  const unrealizedPnlUsdt = Number(account.unrealised_pnl ?? account.unrealized_pnl ?? 0);
  const crossAvailableUsdt = Number(account.cross_available ?? 0);
  if (!Number.isFinite(unrealizedPnlUsdt) || !Number.isFinite(crossAvailableUsdt)) throw new Error("Gate 合约账户权益响应无效");
  const equityUsdt = totalUsdt > 0 ? totalUsdt + unrealizedPnlUsdt : Math.max(availableUsdt, crossAvailableUsdt);
  return {
    userId: detail.user_id == null ? null : String(detail.user_id),
    availableUsdt,
    totalUsdt,
    equityUsdt,
    positionMode,
    accountMarginMode,
    perpetualReadWrite,
    ipWhitelistConfigured: Boolean(detail.ip_whitelist?.length),
  };
}