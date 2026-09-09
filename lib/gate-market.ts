import type { BookLevel, BookSnapshot } from "./liquidity-core.ts";

const BASE = "https://api.gateio.ws/api/v4";
const GATE_PUBLIC_TIMEOUT_MS = 2_000;
const GATE_BULK_TICKER_TIMEOUT_MS = 4_000;

export class GatePublicError extends Error {
  readonly status: number;
  readonly retryAt: number | null;
  constructor(message: string, status: number, retryAt: number | null) {
    super(message);
    this.status = status;
    this.retryAt = retryAt;
  }
}

async function gatePublic<T>(path: string, timeoutMs = GATE_PUBLIC_TIMEOUT_MS): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Accept: "application/json", "X-Gate-Size-Decimal": "1" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const retryAfter = Number(response.headers.get("retry-after") ?? 0);
    const reset = Number(response.headers.get("x-gate-ratelimit-reset-timestamp") ?? 0);
    const retryAt = reset > 0 ? (reset < 1e12 ? reset * 1_000 : reset) : retryAfter > 0 ? Date.now() + retryAfter * 1_000 : null;
    throw new GatePublicError(`Gate public ${response.status}`, response.status, retryAt);
  }
  return await response.json() as T;
}

type GateBook = {
  id?: number;
  current?: number;
  update?: number;
  asks?: Array<{ p?: string; s?: string | number } | [string, string]>;
  bids?: Array<{ p?: string; s?: string | number } | [string, string]>;
};

function levels(rows: GateBook["asks"]): BookLevel[] {
  return (rows ?? []).map((row) => Array.isArray(row)
    ? { price: Number(row[0]), size: Math.abs(Number(row[1])) }
    : { price: Number(row.p), size: Math.abs(Number(row.s)) })
    .filter((row) => row.price > 0 && row.size > 0);
}

export async function fetchFuturesBook(symbol: string, tickSize = 0.0001, quantoMultiplier = 1): Promise<BookSnapshot> {
  const book = await gatePublic<GateBook>(`/futures/usdt/order_book?contract=${encodeURIComponent(symbol)}&limit=50&with_id=true`);
  const toNotional = (row: BookLevel) => ({ ...row, size: row.size * row.price * Math.max(quantoMultiplier, 1e-12) });
  const bids = levels(book.bids).map(toNotional).sort((a, b) => b.price - a.price);
  const asks = levels(book.asks).map(toNotional).sort((a, b) => a.price - b.price);
  if (!bids.length || !asks.length) throw new Error(`${symbol} empty futures book`);
  const update = Number(book.update ?? 0);
  const sequence = Number(book.id ?? 0);
  if (!(update > 0)) throw new Error(`${symbol} futures book missing exchange update time`);
  if (!(sequence > 0)) throw new Error(`${symbol} futures book missing sequence id`);
  return {
    symbol,
    observedAt: update < 1e12 ? update * 1_000 : update,
    sequence,
    tickSize,
    bids,
    asks,
  };
}

export type GateTicker = {
  contract?: string;
  last?: string;
  volume_24h?: string;
  volume_24h_usd?: string;
  volume_24h_settle?: string;
  funding_rate?: string;
  mark_price?: string;
  index_price?: string;
  total_size?: string;
};

export type GateContract = {
  name?: string;
  in_delisting?: boolean;
  status?: string;
  order_price_round?: string;
  quanto_multiplier?: string;
  maintenance_rate?: string;
  leverage_max?: string;
};

export async function fetchActiveContracts() {
  const [rows, contracts] = await Promise.all([
    gatePublic<GateTicker[]>("/futures/usdt/tickers"),
    gatePublic<GateContract[]>("/futures/usdt/contracts"),
  ]);
  const available = new Map(contracts
    .filter((contract) => !contract.in_delisting && (!contract.status || contract.status === "trading"))
    .map((contract) => [contract.name ?? "", Number(contract.order_price_round ?? 0.0001)]));
  return rows
    .filter((row) => available.has(row.contract ?? "") && Number(row.last ?? 0) > 0)
    .sort((a, b) => Number(b.volume_24h_usd ?? b.volume_24h_settle ?? 0) - Number(a.volume_24h_usd ?? a.volume_24h_settle ?? 0))
    .map((row) => {
      const contract = contracts.find((item) => item.name === row.contract);
      return {
        symbol: row.contract!,
        tickSize: available.get(row.contract!) ?? 0.0001,
        quantoMultiplier: Number(contract?.quanto_multiplier ?? 1),
        maintenanceRate: Number(contract?.maintenance_rate ?? 0.005),
        leverageMax: Number(contract?.leverage_max ?? 50),
        fundingRate: Number(row.funding_rate ?? 0),
        last: Number(row.last ?? 0),
        volume24hUsd: Number(row.volume_24h_usd ?? row.volume_24h_settle ?? 0),
      };
    });
}

export async function fetchMarketTickers() {
  const rows = await gatePublic<GateTicker[]>("/futures/usdt/tickers", GATE_BULK_TICKER_TIMEOUT_MS);
  return rows.map((row) => ({
    symbol: row.contract ?? "",
    last: Number(row.last ?? 0),
    volume24hUsd: Number(row.volume_24h_usd ?? row.volume_24h_settle ?? 0),
    fundingRate: Number(row.funding_rate ?? 0),
    openInterest: Math.abs(Number(row.total_size ?? 0)),
  })).filter((row) => row.symbol.endsWith("_USDT") && row.last > 0 && row.volume24hUsd > 0);
}

export async function fetchTicker(symbol: string) {
  const rows = await gatePublic<GateTicker[]>(`/futures/usdt/tickers?contract=${encodeURIComponent(symbol)}`);
  return rows[0] ?? null;
}

export type GateTrade = { id?: number; create_time_ms?: string; price?: string; size?: string | number };
export async function fetchRecentTrades(symbol: string) {
  return await gatePublic<GateTrade[]>(`/futures/usdt/trades?contract=${encodeURIComponent(symbol)}&limit=40`);
}

export type GateLiquidation = { time?: number; contract?: string; size?: string | number; order_size?: string | number; fill_price?: string; order_price?: string };
export async function fetchLiquidations(symbol: string) {
  return await gatePublic<GateLiquidation[]>(`/futures/usdt/liq_orders?contract=${encodeURIComponent(symbol)}&limit=20`);
}

export type GateContractStat = { time?: number; open_interest?: string | number };
export async function fetchContractStats(symbol: string) {
  const rows = await gatePublic<GateContractStat[]>(`/futures/usdt/contract_stats?contract=${encodeURIComponent(symbol)}&limit=1`);
  return rows.at(-1) ?? null;
}

export type GateCandle = { time: number; volume: number; close: number; high: number; low: number; open: number };
type GateCandleRow = { t?: number; v?: string | number; c?: string | number; h?: string | number; l?: string | number; o?: string | number };

export async function fetchStructureCandles(symbol: string, interval: "1m" | "5m" | "15m" | "1h") {
  const rows = await gatePublic<GateCandleRow[]>(
    `/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&interval=${interval}&limit=120`,
  );
  const intervalSeconds = interval === "1m" ? 60 : interval === "5m" ? 300 : interval === "15m" ? 900 : 3_600;
  const completedBefore = Math.floor(Date.now() / 1_000 / intervalSeconds) * intervalSeconds;
  const parsed = rows.map((row) => ({
    time: Number(row.t), volume: Number(row.v), close: Number(row.c), high: Number(row.h), low: Number(row.l), open: Number(row.o),
  })).filter((row) => row.time > 0 && row.time + intervalSeconds <= Date.now() / 1_000 && row.time < completedBefore
    && [row.volume, row.close, row.high, row.low, row.open].every(Number.isFinite)
    && row.close > 0 && row.high >= row.low && row.volume >= 0).sort((a, b) => a.time - b.time);
  const unique = [...new Map(parsed.map((row) => [row.time, row])).values()];
  let start = unique.length ? unique.length - 1 : 0;
  while (start > 0 && unique[start].time - unique[start - 1].time === intervalSeconds) start -= 1;
  return unique.slice(start);
}
