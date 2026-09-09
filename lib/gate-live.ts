import { decryptGateCredentials, type EncryptedGateCredentials, type GateCredentials } from "./credential-vault.ts";
import { CORRELATED_DIRECTION_RISK_CAP, PORTFOLIO_MARGIN_CAP, PORTFOLIO_RISK_CAP, ROUND_TRIP_FRICTION_RATE, selectSafeLeverage, sizePaperPosition, stagedEconomicTarget, tradeEconomics, type PaperPlan, type Side } from "./liquidity-core.ts";

const encoder = new TextEncoder();
const GATE_TRIGGER_DAY_SECONDS = 86_400;
const GATE_TRIGGER_MAX_DAYS = 30;

export type GateLiveAccount = {
  user?: string | number;
  total?: string | number;
  available?: string | number;
  order_margin?: string | number;
  position_margin?: string | number;
  unrealised_pnl?: string | number;
  in_dual_mode?: boolean;
  position_mode?: string;
};

export type GateLivePosition = {
  contract?: string;
  size?: string | number;
  entry_price?: string | number;
  leverage?: string | number;
  value?: string | number;
  unrealised_pnl?: string | number;
};

export type GateLiveOrder = {
  id?: string | number;
  id_string?: string;
  text?: string;
  contract?: string;
  status?: string;
  finish_as?: string;
  size?: string | number;
  left?: string | number;
  fill_price?: string | number;
  trade_id?: string | number;
  close?: boolean;
  reduce_only?: boolean;
  initial?: { contract?: string; text?: string; size?: string | number; price?: string; close?: boolean; reduce_only?: boolean };
};

export type GateLiveSnapshot = {
  account: GateLiveAccount;
  positions: GateLivePosition[];
  orders: GateLiveOrder[];
  priceOrders: GateLiveOrder[];
  checkedAt: number;
};

export type LiveEntryIntent = {
  kind: "PRICE_TRIGGER" | "LIMIT" | "MARKET";
  tag: string;
  size: number;
  contracts: number;
  notional: number;
  plannedRisk: number;
  leverage: number;
  margin: number;
  body: Record<string, unknown>;
};

export type LiveStopIntent = {
  tag: string;
  body: Record<string, unknown>;
};

export type LiveEntrySizingCode = "MIN_CONTRACT" | "MARGIN" | "RISK_CAP" | "ECONOMICS";

export class LiveEntrySizingError extends Error {
  readonly code: LiveEntrySizingCode;
  readonly symbol: string;

  constructor(code: LiveEntrySizingCode, symbol: string, message: string) {
    super(message);
    this.name = "LiveEntrySizingError";
    this.code = code;
    this.symbol = symbol;
  }
}

function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signature(secret: string, method: string, path: string, query: string, body: string, timestamp: string) {
  const bodyHash = hex(await crypto.subtle.digest("SHA-512", encoder.encode(body)));
  const payload = `${method}\n${path}\n${query}\n${bodyHash}\n${timestamp}`;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

function safeGateError(raw: string, status: number) {
  try {
    const parsed = JSON.parse(raw) as { label?: string; message?: string };
    return `Gate ${status}${parsed.label ? ` ${parsed.label}` : ""}${parsed.message ? `: ${parsed.message}` : ""}`.slice(0, 240);
  } catch {
    return `Gate ${status}`;
  }
}

function responseId(raw: string, parsed: GateLiveOrder) {
  if (typeof parsed.id_string === "string" && /^\d+$/.test(parsed.id_string)) return parsed.id_string;
  const match = raw.match(/"id"\s*:\s*(?:"(\d+)"|(\d+))/);
  if (match?.[1] || match?.[2]) return match[1] ?? match[2];
  if (parsed.id != null && /^\d+$/.test(String(parsed.id))) return String(parsed.id);
  throw new Error("Gate 返回的订单编号无效");
}

// Gate uses signed int64 identifiers. JSON.parse would round bare integers
// above Number.MAX_SAFE_INTEGER, which can turn a valid cancel request into a
// different order ID. Quote identifier fields before parsing so they remain
// byte-for-byte strings throughout reconciliation and cancellation.
function parseGateJson<T>(raw: string): T {
  const idSafe = raw.replace(/("(?:id|order_id|trade_id)"\s*:\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(idSafe) as T;
}

export class GateLiveClient {
  readonly credentials: GateCredentials;
  requestCount = 0;
  constructor(credentials: GateCredentials) { this.credentials = credentials; }

  private async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, query = "", value?: unknown) {
    this.requestCount += 1;
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const signedPath = `/api/v4${path}`;
    const body = value == null ? "" : JSON.stringify(value);
    const base = this.credentials.environment === "testnet" ? "https://api-testnet.gateapi.io" : "https://api.gateio.ws";
    const response = await fetch(`${base}${signedPath}${query ? `?${query}` : ""}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        KEY: this.credentials.apiKey,
        Timestamp: timestamp,
        SIGN: await signature(this.credentials.apiSecret, method, signedPath, query, body, timestamp),
        "X-Gate-Exptime": String(Date.now() + 5_000),
      },
      body: body || undefined,
      signal: AbortSignal.timeout(6_000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(safeGateError(raw, response.status));
    return { data: (raw ? parseGateJson<T>(raw) : {}) as T, raw };
  }

  async snapshot(): Promise<GateLiveSnapshot> {
    const [account, positions, orders, priceOrders] = await Promise.all([
      this.request<GateLiveAccount>("GET", "/futures/usdt/accounts"),
      this.request<GateLivePosition[]>("GET", "/futures/usdt/positions", "holding=true"),
      this.request<GateLiveOrder[]>("GET", "/futures/usdt/orders", "status=open"),
      this.request<GateLiveOrder[]>("GET", "/futures/usdt/price_orders", "status=open"),
    ]);
    return { account: account.data, positions: positions.data, orders: orders.data, priceOrders: priceOrders.data, checkedAt: Date.now() };
  }

  async setLeverage(symbol: string, leverage: number) {
    const query = `leverage=${encodeURIComponent(String(leverage))}`;
    await this.request("POST", `/futures/usdt/positions/${encodeURIComponent(symbol)}/leverage`, query);
  }

  async createEntry(intent: LiveEntryIntent) {
    const path = intent.kind === "PRICE_TRIGGER" ? "/futures/usdt/price_orders" : "/futures/usdt/orders";
    const response = await this.request<GateLiveOrder>("POST", path, "", intent.body);
    return responseId(response.raw, response.data);
  }

  async createStop(intent: LiveStopIntent) {
    const response = await this.request<GateLiveOrder>("POST", "/futures/usdt/price_orders", "", intent.body);
    return responseId(response.raw, response.data);
  }

  async inspectEntry(kind: "PRICE_TRIGGER" | "LIMIT" | "MARKET", symbol: string, tag: string, orderId: string | null) {
    try {
      if (kind !== "PRICE_TRIGGER") {
        return (await this.request<GateLiveOrder>("GET", `/futures/usdt/orders/${encodeURIComponent(orderId ?? tag)}`)).data;
      }
      if (orderId) {
        return (await this.request<GateLiveOrder>("GET", `/futures/usdt/price_orders/${encodeURIComponent(orderId)}`)).data;
      }
      const query = `status=finished&contract=${encodeURIComponent(symbol)}&limit=100`;
      const rows = (await this.request<GateLiveOrder[]>("GET", "/futures/usdt/price_orders", query)).data;
      return rows.find((order) => liveOrderTag(order) === tag) ?? null;
    } catch (error) {
      if (error instanceof Error && /Gate 404|ORDER_NOT_FOUND/.test(error.message)) return null;
      throw error;
    }
  }

  async amendStop(orderId: string, stopPrice: number) {
    await this.request("PUT", "/futures/usdt/price_orders/amend", "", {
      order_id: orderId,
      size: 0,
      price: "0",
      trigger_price: String(stopPrice),
      price_type: 0,
      close: true,
    });
  }

  async cancelOrder(kind: "PRICE_TRIGGER" | "LIMIT" | "MARKET", orderId: string) {
    const family = kind === "PRICE_TRIGGER" ? "price_orders" : "orders";
    try {
      await this.request("DELETE", `/futures/usdt/${family}/${encodeURIComponent(orderId)}`);
    } catch (error) {
      if (!(error instanceof Error) || !/404|ORDER_NOT_FOUND/.test(error.message)) throw error;
    }
  }

  async closePosition(symbol: string, tag: string) {
    const response = await this.request<GateLiveOrder>("POST", "/futures/usdt/orders", "", {
      contract: symbol,
      size: 0,
      price: "0",
      tif: "ioc",
      close: true,
      reduce_only: true,
      text: tag,
    });
    return responseId(response.raw, response.data);
  }
}

type CredentialRow = { ciphertext: string; iv: string; crypto_version: number; environment: string; status: string };

export async function loadGateLiveClient(db: D1Database, ownerAccessToken: string) {
  const row = await db.prepare("SELECT ciphertext,iv,crypto_version,environment,status FROM live_exchange_credentials WHERE id=1 LIMIT 1").first<CredentialRow>();
  if (!row) throw new Error("Gate 实盘 API 尚未配置");
  if (row.environment !== "live") throw new Error("Gate 凭据不是实盘环境");
  if (row.status !== "verified") throw new Error("Gate 实盘 API 尚未通过验证");
  const credentials = await decryptGateCredentials({ ciphertext: row.ciphertext, iv: row.iv, cryptoVersion: row.crypto_version as EncryptedGateCredentials["cryptoVersion"] }, ownerAccessToken);
  if (credentials.environment !== "live") throw new Error("加密凭据不是实盘环境");
  return new GateLiveClient(credentials);
}

function shortTag(prefix: "e" | "s" | "x", id: string) {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `t-ms-${prefix}-${(hash >>> 0).toString(36)}`;
}

export function liveOrderTag(order: GateLiveOrder) {
  return order.text ?? order.initial?.text ?? null;
}

export function liveOrderId(order: GateLiveOrder) {
  return order.id_string ?? (order.id == null ? null : String(order.id));
}

export function liveEntryDisposition(order: GateLiveOrder, kind: "PRICE_TRIGGER" | "LIMIT" | "MARKET") {
  if (order.status === "open") return "OPEN" as const;
  if (kind === "PRICE_TRIGGER") {
    if (order.finish_as === "succeeded") return "FILLED" as const;
    if (["cancelled", "expired"].includes(order.finish_as ?? "")) return "CANCELLED" as const;
    return "ERROR" as const;
  }
  if (order.finish_as === "filled") return "FILLED" as const;
  if (order.status === "finished") return "CANCELLED" as const;
  return "ERROR" as const;
}

export function buildLiveEntryIntent(input: {
  plan: PaperPlan;
  equity: number;
  available: number;
  openRisk: number;
  sameDirectionRisk?: number;
  quantoMultiplier: number;
  maintenanceRate?: number;
  leverageMax?: number;
  openMargin?: number;
  entryPrice?: number;
  mirrorNotionalFraction?: number;
}): LiveEntryIntent {
  const { plan } = input;
  const entryPrice = input.entryPrice ?? plan.entryTrigger;
  const confidence = plan.score / Math.max(plan.score + plan.oppositeScore, Number.EPSILON);
  const sized = sizePaperPosition({ equity: input.equity, entry: entryPrice, invalidation: plan.invalidation, feeBps: 10,
    stressSlippageBps: 8, confidence, openRisk: input.openRisk, sameDirectionRisk: input.sameDirectionRisk });
  const multiplier = Math.max(input.quantoMultiplier, 1e-12);
  const maxLeverage = Math.max(1, Math.floor(input.leverageMax ?? 50));
  const contractNotional = Math.max(entryPrice * multiplier, 1e-12);
  // LIVE follows the PAPER account ratio. When that proportional amount is
  // smaller than Gate's indivisible one-contract lot, use one lot only if its
  // real loss remains inside both account-wide and correlated-direction boundaries.
  const requestedNotional = input.mirrorNotionalFraction == null
    ? sized.notional
    : input.equity * Math.max(0, Math.min(1, input.mirrorNotionalFraction));
  let contracts = Math.max(1, Math.floor(requestedNotional / contractNotional));
  let leverageChoice = selectSafeLeverage({ notional: contracts * contractNotional, equity: input.equity,
    entry: entryPrice, invalidation: plan.invalidation, maintenanceRate: input.maintenanceRate, leverageMax: maxLeverage });
  const affordable = Math.floor(input.available * 0.95 * leverageChoice.leverage / contractNotional);
  contracts = Math.min(contracts, affordable);
  if (contracts < 1) throw new LiveEntrySizingError("MARGIN", plan.symbol, `${plan.symbol} 可用保证金不足 1 张合约，本轮未挂单`);
  const notional = contracts * entryPrice * multiplier;
  leverageChoice = selectSafeLeverage({ notional, equity: input.equity, entry: entryPrice,
    invalidation: plan.invalidation, maintenanceRate: input.maintenanceRate, leverageMax: maxLeverage });
  const leverage = leverageChoice.leverage;
  const margin = leverageChoice.margin;
  const lossRate = Math.abs(entryPrice - plan.invalidation) / Math.max(entryPrice, 1e-9) + ROUND_TRIP_FRICTION_RATE;
  const plannedRisk = notional * lossRate;
  if (input.openRisk + plannedRisk > input.equity * PORTFOLIO_RISK_CAP + 1e-8) {
    throw new LiveEntrySizingError("RISK_CAP", plan.symbol, `${plan.symbol} 最小 1 张合约将超过账户 10% 总风险，本轮未挂单`);
  }
  if ((input.sameDirectionRisk ?? 0) + plannedRisk > input.equity * CORRELATED_DIRECTION_RISK_CAP + 1e-8) {
    throw new LiveEntrySizingError("RISK_CAP", plan.symbol, `${plan.symbol} 最小 1 张合约将超过同方向 6.5% 相关风险，本轮未挂单`);
  }
  if ((input.openMargin ?? 0) + margin > input.equity * PORTFOLIO_MARGIN_CAP + 1e-8) {
    throw new LiveEntrySizingError("MARGIN", plan.symbol, `${plan.symbol} 将超过账户 30% 挂单与持仓保证金上限，本轮未挂单`);
  }
  if (input.mirrorNotionalFraction == null) {
    const economics = tradeEconomics({ entry: entryPrice, target: stagedEconomicTarget(plan), lossRate, confidence, notional, equity: input.equity });
    if (!economics.executable) throw new LiveEntrySizingError("ECONOMICS", plan.symbol, `${plan.symbol} 实盘合约取整后净利润空间不足，本轮未挂单`);
  }
  const size = plan.side === "LONG" ? contracts : -contracts;
  const tag = shortTag("e", plan.id);
  const initial = { contract: plan.symbol, size, price: "0", tif: "ioc", text: tag, reduce_only: false };
  const kind = "MARKET" as const;
  const body = initial;
  return { kind, tag, size, contracts, notional, plannedRisk, leverage, margin, body };
}

export function buildLiveStopIntent(position: { id: string; symbol: string; side: Side; currentStop: number }) {
  const tag = shortTag("s", `${position.id}:${position.currentStop.toPrecision(12)}`);
  return {
    tag,
    body: {
      initial: { contract: position.symbol, size: 0, price: "0", tif: "ioc", close: true, reduce_only: true, text: tag },
      trigger: { strategy_type: 0, price_type: 0, price: String(position.currentStop), rule: position.side === "LONG" ? 2 : 1, expiration: GATE_TRIGGER_DAY_SECONDS * GATE_TRIGGER_MAX_DAYS },
    },
  } satisfies LiveStopIntent;
}

export function liveExitTag(positionId: string) {
  return shortTag("x", positionId);
}
