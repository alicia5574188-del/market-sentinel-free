import { decryptGateCredentials, type EncryptedGateCredentials, type GateCredentials } from "./credential-vault.ts";
import { CORRELATED_DIRECTION_RISK_CAP, MAX_NOTIONAL_TO_EQUITY, PORTFOLIO_MARGIN_CAP, PORTFOLIO_RISK_CAP, ROUND_TRIP_FRICTION_RATE, selectSafeLeverage, sizePaperPosition, stagedEconomicTarget, tradeEconomics, type PaperPlan, type Side } from "./liquidity-core.ts";
import type { SizeDiagnostic } from "./gate-quantity.ts";
import type { GateConfirmedFill } from "./live-turnover.ts";

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
  margin_mode?: number;
};

export type GateLivePosition = {
  contract?: string;
  size?: string | number;
  entry_price?: string | number;
  leverage?: string | number;
  value?: string | number;
  unrealised_pnl?: string | number;
  mark_price?: string | number;
  margin?: string | number;
  initial_margin?: string | number;
};

/** Exchange values only; never substitute the PAPER or public quote estimate. */
export function gatePositionValuation(position: GateLivePosition, checkedAt: number) {
  const finite = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
  const pnl = finite(position.unrealised_pnl), price = finite(position.mark_price);
  const margin = finite(position.margin), initial = finite(position.initial_margin);
  const basis = margin != null && margin > 0 ? margin : initial != null && initial > 0 ? initial : null;
  return { exchangeUnrealisedPnl: pnl, exchangeMarkPrice: price != null && price > 0 ? price : null,
    exchangeMargin: margin, exchangeInitialMargin: initial, exchangePnlMargin: basis,
    exchangePnlMarginSource: basis == null ? null : margin != null && margin > 0 ? "margin" as const : "initial_margin" as const,
    exchangePnlAt: Number.isFinite(checkedAt) && checkedAt > 0 ? checkedAt : null };
}

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
  create_time?: number; finish_time?: number | string;
  initial?: { contract?: string; text?: string; size?: string | number; price?: string; close?: boolean; reduce_only?: boolean };
};

export type GateLiveCoreSnapshot = {
  account: GateLiveAccount;
  positions: GateLivePosition[];
  checkedAt: number;
};
export type GateLiveOrderSnapshot = {
  orders: GateLiveOrder[];
  priceOrders: GateLiveOrder[];
  checkedAt: number;
};
export type GateLiveSnapshot = GateLiveCoreSnapshot & GateLiveOrderSnapshot;

/** Gate classic futures `total` is wallet balance, not marked equity.
 * Never compare it directly with a PAPER balance including open PnL. Unified
 * cross-currency collateral needs its own adapter; do not guess its equity.
 */
export function gateMarkedEquity(snapshot:GateLiveSnapshot) {
  const a=snapshot.account;
  if(a.margin_mode!=null&&a.margin_mode!==0)throw new Error("当前Gate统一保证金模式尚无相同净值适配，停止新增复制，不更改账户模式");
  const balance=Number(a.total),explicit=a.unrealised_pnl!=null;
  const held=snapshot.positions.filter(p=>Number(p.size??0)!==0);
  if(a.total==null||!Number.isFinite(balance))throw new Error("Gate余额缺失，不能确定实盘复制权益");
  if(!explicit&&held.some(p=>p.unrealised_pnl==null))throw new Error("Gate持仓浮盈缺失，不能用余额假装完整净值");
  const pnl=explicit?Number(a.unrealised_pnl):held.reduce((sum,p)=>sum+Number(p.unrealised_pnl),0);
  if(!Number.isFinite(pnl)||!Number.isFinite(balance+pnl))throw new Error("Gate浮盈无效，不能确定复制净值");
  return balance+pnl;
}

export const GATE_CUSTOM_TEXT_NO_FILL_LOOKUP_MS = 60_000;
export const GATE_UNKNOWN_SUBMISSION_RESOLVE_MS = 65_000;
export function gateUnknownSubmissionCanResolve(submittedAt:number,now:number){
  return Number.isFinite(submittedAt)&&submittedAt>0&&Number.isFinite(now)&&now-submittedAt>=GATE_UNKNOWN_SUBMISSION_RESOLVE_MS;
}

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
  price: number;
  body: Record<string, unknown>;
};

export type LiveEntrySizingCode = "MIN_CONTRACT" | "CONTRACT_SPEC" | "MARGIN" | "RISK_CAP" | "ECONOMICS";

export class LiveEntrySizingError extends Error {
  readonly code: LiveEntrySizingCode;
  readonly symbol: string;
  readonly sizing?: SizeDiagnostic;

  constructor(code: LiveEntrySizingCode, symbol: string, message: string, sizing?: SizeDiagnostic) {
    super(message);
    this.name = "LiveEntrySizingError";
    this.code = code;
    this.symbol = symbol;
    this.sizing = sizing;
  }
}

/** The final local guard rejected an entry before any order request was sent. */
export class GateEntryCancelledError extends Error {
  constructor(message="实盘提交前所有者选择、源单或行情状态已变化，未发送入场请求") {
    super(message);
    this.name = "GateEntryCancelledError";
  }
}

export class GateReadTimeoutError extends Error {
  readonly code="GATE_READ_TIMEOUT";
  readonly path:string;
  constructor(path:string){
    super(`Gate只读核对超时：${path}；本轮不执行新增实盘动作，下一轮会自动重新核对。`);
    this.name="GateReadTimeoutError";this.path=path;
  }
}
export function isGateReadTimeoutError(error:unknown):error is GateReadTimeoutError{
  return error instanceof GateReadTimeoutError
    ||(error instanceof Error&&(error.name==="GateReadTimeoutError"||(error as Error&{code?:string}).code==="GATE_READ_TIMEOUT"));
}
function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function gateRequestSignature(secret: string, method: string, path: string, query: string, body: string, timestamp: string) {
  const bodyHash = hex(await crypto.subtle.digest("SHA-512", encoder.encode(body)));
  // Official gateapi-go signs URL.Path (decoded UTF-8) and QueryUnescape of
  // RawQuery. Keep the *transport* escaped; decode exactly once for signing.
  // Signing the %E9... spelling caused INVALID_SIGNATURE for Chinese symbols.
  const canonicalPath = decodeURIComponent(path);
  const canonicalQuery = decodeURIComponent(query.replace(/\+/g, " "));
  const payload = `${method}\n${canonicalPath}\n${canonicalQuery}\n${bodyHash}\n${timestamp}`;
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
  readonly readTransport={version:"gate-private-stable-rest-v1",hedges:0,recovered:0,timeouts:0,lastTimeoutPath:null as string|null,
    preferredAlternatePaths:0,preferredMutationHost:"api.gateio.ws" as const};
  readonly writeTransport={version:"gate-private-stable-rest-v1",connected:true,loggedIn:false,connections:0,
    orderRequests:0,orderAcks:0,orderResults:0,timeouts:0,lastAt:null as number|null,lastError:null as string|null,
    channel:"rest-single-submit" as const};
  constructor(credentials: GateCredentials) { this.credentials = credentials; }

  private async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, query = "", value?: unknown, beforeSend?:()=>boolean) {
    this.requestCount += 1;
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const signedPath = `/api/v4${path}`;
    const body = value == null ? "" : JSON.stringify(value);
    const base = this.credentials.environment === "testnet" ? "https://api-testnet.gateapi.io" : "https://api.gateio.ws";
    if(beforeSend&&!beforeSend())throw new GateEntryCancelledError();
    if(method!=="GET"){this.writeTransport.orderRequests++;this.writeTransport.lastAt=Date.now();}
    const response = await fetch(`${base}${signedPath}${query ? `?${query}` : ""}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        KEY: this.credentials.apiKey,
        Timestamp: timestamp,
        SIGN: await gateRequestSignature(this.credentials.apiSecret, method, signedPath, query, body, timestamp),
        "X-Gate-Exptime": String(Date.now() + 5_000),
        "X-Gate-Size-Decimal": "1",
      },
      body: body || undefined,
      signal: AbortSignal.timeout(6_000),
    });
    const raw = await response.text();
    if (!response.ok) {
      const error=new Error(safeGateError(raw,response.status));
      if(method!=="GET")this.writeTransport.lastError=error.message;
      throw error;
    }
    if(method!=="GET"){this.writeTransport.orderResults++;this.writeTransport.lastError=null;}
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

  async position(symbol:string):Promise<GateLivePosition>{
    return (await this.request<GateLivePosition>("GET",`/futures/usdt/positions/${encodeURIComponent(symbol)}`)).data;
  }

  async snapshotCore():Promise<GateLiveCoreSnapshot>{
    const [account,positions]=await Promise.all([
      this.request<GateLiveAccount>("GET","/futures/usdt/accounts"),
      this.request<GateLivePosition[]>("GET","/futures/usdt/positions","holding=true"),
    ]);
    return{account:account.data,positions:positions.data,checkedAt:Date.now()};
  }

  async snapshotOrders():Promise<GateLiveOrderSnapshot>{
    const [orders,priceOrders]=await Promise.all([
      this.request<GateLiveOrder[]>("GET","/futures/usdt/orders","status=open"),
      this.request<GateLiveOrder[]>("GET","/futures/usdt/price_orders","status=open"),
    ]);
    return{orders:orders.data,priceOrders:priceOrders.data,checkedAt:Date.now()};
  }

  async setLeverage(symbol: string, leverage: number) {
    const query = `leverage=${encodeURIComponent(String(leverage))}`;
    await this.request("POST", `/futures/usdt/positions/${encodeURIComponent(symbol)}/leverage`, query);
  }

  async ensureLeverage(symbol:string,leverage:number){
    await this.setLeverage(symbol,leverage);
    return{verified:true,recovered:false,already:false,actual:leverage};
  }

  /** Read-only, fixed time-window pagination; individual fills, not orders. */
  async confirmedFills(from: number, to: number, offset: number, limit = 100): Promise<GateConfirmedFill[]> {
    if (![from,to,offset,limit].every(Number.isSafeInteger) || from < 0 || to < from || offset < 0 || limit < 1 || limit > 100)
      throw new Error("成交额查询范围无效");
    const result = await this.request<GateConfirmedFill[]>("GET", "/futures/usdt/my_trades_timerange",
      `from=${from}&to=${to}&limit=${limit}&offset=${offset}`);
    if (!Array.isArray(result.data)) throw new Error("Gate成交记录不是有效列表");
    return result.data;
  }

  /** Read-only position-cycle settlements. No order side effects or automatic retries. */
  async positionCloseHistory(from:number,to:number,offset=0) {
    if(![from,to,offset].every(Number.isSafeInteger)||from<0||to<from||offset<0||offset>1000)
      throw new Error("实盘结算查询范围无效");
    const response=await this.request<import("./live-settlement.ts").GatePositionClose[]>("GET","/futures/usdt/position_close",
      `from=${from}&to=${to}&limit=100&offset=${offset}`);
    if(!Array.isArray(response.data)||response.data.length>100)throw new Error("实盘结算回报格式无效");
    return response.data;
  }

  async createEntry(intent: LiveEntryIntent,beforeSend?:()=>boolean) {
    const path = intent.kind === "PRICE_TRIGGER" ? "/futures/usdt/price_orders" : "/futures/usdt/orders";
    const response = await this.request<GateLiveOrder>("POST", path, "", intent.body,beforeSend);
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
  // IOC may finish with a nonzero partial execution. Treat that as exposure,
  // not a cancelled no-fill order which could then be replayed.
  if (order.finish_as === "filled" || (order.size != null && order.left != null
    && Math.abs(Number(order.size)) > Math.abs(Number(order.left)))) return "FILLED" as const;
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
  modeledCostRate?: number;
}): LiveEntryIntent {
  const { plan } = input;
  const entryPrice = input.entryPrice ?? plan.entryTrigger;
  const geometryLive = plan.side === "LONG" ? entryPrice > plan.invalidation && entryPrice < plan.target
    : entryPrice < plan.invalidation && entryPrice > plan.target;
  if (!geometryLive) throw new LiveEntrySizingError("ECONOMICS", plan.symbol,
    `${plan.symbol} 当前价格已破坏模拟订单的止损/目标结构，本轮未挂单`);
  const modeledCostRate = input.modeledCostRate ?? ROUND_TRIP_FRICTION_RATE;
  const confidence = plan.score / Math.max(plan.score + plan.oppositeScore, Number.EPSILON);
  const sized = sizePaperPosition({ equity: input.equity, entry: entryPrice, invalidation: plan.invalidation,
    feeBps: modeledCostRate * 10_000, stressSlippageBps: 0, confidence, openRisk: input.openRisk,
    sameDirectionRisk: input.sameDirectionRisk });
  const multiplier = Math.max(input.quantoMultiplier, 1e-12);
  const maxLeverage = Math.max(1, Math.floor(input.leverageMax ?? 50));
  const contractNotional = Math.max(entryPrice * multiplier, 1e-12);
  // LIVE follows the PAPER account ratio. When that proportional amount is
  // smaller than Gate's indivisible one-contract lot, use one lot only if its
  // real loss remains inside both account-wide and correlated-direction boundaries.
  const requestedNotional = input.mirrorNotionalFraction == null
    ? sized.notional
    : input.equity * Math.max(0, Math.min(MAX_NOTIONAL_TO_EQUITY, input.mirrorNotionalFraction));
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
  const lossRate = Math.abs(entryPrice - plan.invalidation) / Math.max(entryPrice, 1e-9) + modeledCostRate;
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
  const economics = tradeEconomics({ entry: entryPrice, target: stagedEconomicTarget(plan), lossRate, confidence, notional,
    equity: input.equity, frictionRate: modeledCostRate });
  if (!economics.executable) throw new LiveEntrySizingError("ECONOMICS", plan.symbol,
    `${plan.symbol} 实盘合约取整后扣成本盈亏比或期望不足，本轮未挂单`);
  const size = plan.side === "LONG" ? contracts : -contracts;
  const tag = shortTag("e", plan.id);
  const initial = { contract: plan.symbol, size, price: "0", tif: "ioc", text: tag, reduce_only: false };
  const kind = "MARKET" as const;
  const body = initial;
  return { kind, tag, size, contracts, notional, plannedRisk, leverage, margin, body };
}

function tickDecimals(tickSize: number) {
  const [coefficient, exponent = "0"] = tickSize.toString().toLowerCase().split("e");
  return Math.min(12, Math.max(0, (coefficient.split(".")[1]?.length ?? 0) - Number(exponent)));
}

export function liveStopPriceForTick(side: Side, currentStop: number, tickSize?: number) {
  if (!(currentStop > 0) || !(tickSize && tickSize > 0)) return currentStop;
  const units = currentStop / tickSize;
  // Never tighten the exchange stop beyond PAPER merely to satisfy Gate's
  // price grid: longs round down and shorts round up by at most one tick.
  const roundedUnits = side === "LONG" ? Math.floor(units + 1e-9) : Math.ceil(units - 1e-9);
  return Number((roundedUnits * tickSize).toFixed(tickDecimals(tickSize)));
}

export function buildLiveStopIntent(position: { id: string; symbol: string; side: Side; currentStop: number }, tickSize?: number) {
  const price = liveStopPriceForTick(position.side, position.currentStop, tickSize);
  const priceText = tickSize && tickSize > 0 ? price.toFixed(tickDecimals(tickSize)) : String(price);
  const tag = shortTag("s", `${position.id}:${price.toPrecision(12)}`);
  return {
    tag,
    price,
    body: {
      initial: { contract: position.symbol, size: 0, price: "0", tif: "ioc", close: true, reduce_only: true, text: tag },
      trigger: { strategy_type: 0, price_type: 0, price: priceText, rule: position.side === "LONG" ? 2 : 1, expiration: GATE_TRIGGER_DAY_SECONDS * GATE_TRIGGER_MAX_DAYS },
    },
  } satisfies LiveStopIntent;
}

export function liveExitTag(positionId: string) {
  return shortTag("x", positionId);
}

export function liveEntryTag(positionId: string) { return shortTag("e", positionId); }
