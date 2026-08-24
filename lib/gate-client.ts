import { evaluateMarket, type Candle, type MarketInputs, type SignalDecision } from "./signal-engine.ts";
import type { ExperienceBySide } from "./trade-lifecycle.ts";

export const GATE_BASE = "https://api.gateio.ws/api/v4";
export const SYMBOL_PATTERN = /^[A-Z0-9]{2,18}_USDT$/;

type JsonObject = Record<string, unknown>;

export type GlobalRiskContext = {
  benchmarkMomentum: number | null;
  optionsIvPercentile: number | null;
  macroEventRisk: number | null;
  macroEventLabel: string | null;
  etfFlowScore: number | null;
};

export type GateMarketSnapshot = {
  futuresPrice: number;
  volumeUsd: number;
  changePercentage: number | null;
  markPrice: number | null;
  spotPrice: number | null;
  fundingRate: number | null;
  openInterestChangePct: number | null;
  basisPct: number | null;
  spotCvdRatio: number | null;
  orderBookImbalance: number | null;
  liquidationImbalance: number | null;
  multiTimeframeTrend: number | null;
  macroEventRisk: number | null;
  macroEventLabel: string | null;
  optionsIvPercentile: number | null;
  etfFlowScore: number | null;
  sourceAgesMs: Record<string, number | null>;
};

export type GateAnalysisPacket = {
  mode: "live" | "degraded";
  source: string;
  researchStatus: "uncalibrated-beta";
  observedAt: number;
  latencyMs: number;
  symbol: string;
  decision: SignalDecision;
  market: GateMarketSnapshot;
  sourceErrors: Record<string, string>;
};

export type UniverseTicker = {
  symbol: string;
  price: number;
  changePercentage: number;
  volumeUsd: number;
  fundingRate: number | null;
  basisPct: number | null;
  coarseScore: number;
  confidence: number;
  state: "observing" | "pre_alert" | "blocked";
  stateLabel: string;
  side: "LONG" | "SHORT" | "WAIT";
};

export type GatePositionQuote = {
  symbol: string;
  price: number;
  highPrice: number | null;
  lowPrice: number | null;
  candleTime: number | null;
  volumeUsd: number;
  observedAt: number;
};

export function finite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function firstObject(value: unknown): JsonObject {
  return Array.isArray(value) ? asObject(value[0]) : asObject(value);
}

async function gate(path: string, signal: AbortSignal) {
  const response = await fetch(`${GATE_BASE}${path}`, {
    signal,
    cache: "no-store",
    headers: { Accept: "application/json", "User-Agent": "Market-Sentinel/1.0" },
  });
  if (!response.ok) throw new Error(`Gate ${path.split("?")[0]} returned ${response.status}`);
  return response.json() as Promise<unknown>;
}

export function parseCandles(payload: unknown): Candle[] {
  if (!Array.isArray(payload)) return [];
  return payload.map((row): Candle | null => {
    if (Array.isArray(row)) {
      const time = finite(row[0]);
      const volume = finite(row[1]);
      const close = finite(row[2]);
      const high = finite(row[3]);
      const low = finite(row[4]);
      const open = finite(row[5]);
      return [time, volume, close, high, low, open].every((value) => value != null)
        ? { time: time!, volume: volume!, close: close!, high: high!, low: low!, open: open! }
        : null;
    }
    const item = asObject(row);
    const time = finite(item.t);
    const volume = finite(item.v);
    const close = finite(item.c);
    const high = finite(item.h);
    const low = finite(item.l);
    const open = finite(item.o);
    return [time, volume, close, high, low, open].every((value) => value != null)
      ? { time: time!, volume: volume!, close: close!, high: high!, low: low!, open: open! }
      : null;
  }).filter((item): item is Candle => item != null).sort((a, b) => a.time - b.time);
}

function payloadAge(now: number, timestamp: number | null) {
  if (timestamp == null) return null;
  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  return Math.max(0, now - milliseconds);
}

function spotFlow(payload: unknown) {
  if (!Array.isArray(payload)) return { ratio: null as number | null, age: null as number | null };
  let signedNotional = 0;
  let totalNotional = 0;
  let latestTime: number | null = null;
  for (const row of payload) {
    const trade = asObject(row);
    const price = finite(trade.price);
    const amount = finite(trade.amount);
    if (price == null || amount == null) continue;
    const notional = price * amount;
    totalNotional += notional;
    signedNotional += trade.side === "buy" ? notional : -notional;
    const timestamp = finite(trade.create_time_ms) ?? finite(trade.create_time);
    if (timestamp != null) latestTime = Math.max(latestTime ?? 0, timestamp);
  }
  return { ratio: totalNotional > 0 ? signedNotional / totalNotional : null, age: latestTime };
}

function bookImbalance(payload: unknown) {
  const book = asObject(payload);
  const bids = Array.isArray(book.bids) ? book.bids : [];
  const asks = Array.isArray(book.asks) ? book.asks : [];
  const notional = (rows: unknown[]) => rows.reduce<number>((sum, row) => {
    if (!Array.isArray(row)) return sum;
    const price = finite(row[0]);
    const amount = finite(row[1]);
    return sum + (price != null && amount != null ? price * amount : 0);
  }, 0);
  const bid = notional(bids);
  const ask = notional(asks);
  return {
    imbalance: bid + ask > 0 ? (bid - ask) / (bid + ask) : null,
    update: finite(book.update) ?? finite(book.current),
  };
}

function openInterestChange(payload: unknown) {
  if (!Array.isArray(payload)) return { change: null as number | null, time: null as number | null };
  const rows = payload.map((row) => asObject(row)).map((row) => ({
    value: finite(row.open_interest),
    time: finite(row.time),
  })).filter((row) => row.value != null).sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  if (!rows.length) return { change: null, time: null };
  const first = rows[0].value!;
  const last = rows.at(-1)!.value!;
  return { change: first > 0 && rows.length > 1 ? (last / first - 1) * 100 : null, time: rows.at(-1)!.time };
}

export function computeLiquidationImbalance(payload: unknown) {
  if (!Array.isArray(payload)) return null;
  let shortLiquidations = 0;
  let longLiquidations = 0;
  for (const row of payload) {
    const item = asObject(row);
    const size = finite(item.order_size) ?? finite(item.size);
    const price = finite(item.fill_price) ?? finite(item.price) ?? 1;
    if (size == null || price == null) continue;
    const notional = Math.abs(size * price);
    if (size > 0) shortLiquidations += notional;
    else if (size < 0) longLiquidations += notional;
  }
  const total = shortLiquidations + longLiquidations;
  return total > 0 ? (shortLiquidations - longLiquidations) / total : null;
}

function ema(values: number[], period: number) {
  if (!values.length) return null;
  const alpha = 2 / (period + 1);
  let value = values[0];
  for (let index = 1; index < values.length; index += 1) value = values[index] * alpha + value * (1 - alpha);
  return value;
}

function timeframeTrend(candles: Candle[]) {
  const closes = candles.map((candle) => candle.close);
  if (closes.length < 21) return null;
  const fast = ema(closes, 9)!;
  const slow = ema(closes, 21)!;
  const range = Math.max(...closes.slice(-21)) - Math.min(...closes.slice(-21));
  const scale = Math.max(range / Math.max(closes.at(-1)!, Number.EPSILON), 0.003);
  return clamp((fast / slow - 1) / scale * 3, -1, 1);
}

export function computeMultiTimeframeTrend(payloads: unknown[], observedAt?: number) {
  const intervalsMs = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];
  const timeframeWeights = [0.45, 0.35, 0.20];
  const trends = payloads.map((payload, index) => {
    const parsed = parseCandles(payload);
    const completed = observedAt == null ? parsed : parsed.filter((candle) => {
      const startedAt = candle.time > 10_000_000_000 ? candle.time : candle.time * 1000;
      return startedAt + intervalsMs[index] <= observedAt;
    });
    return { value: timeframeTrend(completed), weight: timeframeWeights[index] };
  }).filter((item): item is { value: number; weight: number } => item.value != null && item.weight != null);
  if (!trends.length) return null;
  const used = trends.reduce((sum, item) => sum + item.value * item.weight, 0);
  const weight = trends.reduce((sum, item) => sum + item.weight, 0);
  return clamp(used / weight, -1, 1);
}

function benchmarkChange(...payloads: unknown[]) {
  const values = payloads.map((payload) => finite(firstObject(payload).change_percentage)).filter((value): value is number => value != null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function volumeUsd(ticker: JsonObject) {
  return finite(ticker.volume_24h_usd)
    ?? finite(ticker.volume_24h_quote)
    ?? finite(ticker.volume_24h_settle)
    ?? finite(ticker.volume_24h)
    ?? 0;
}

export function rankUniverseFromPayload(payload: unknown, limit = 30, coreSymbols: string[] = []): UniverseTicker[] {
  if (!Array.isArray(payload)) return [];
  const rows = payload.map((row): UniverseTicker | null => {
    const ticker = asObject(row);
    const symbol = typeof ticker.contract === "string" ? ticker.contract : "";
    if (!SYMBOL_PATTERN.test(symbol)) return null;
    const price = finite(ticker.last);
    const change = finite(ticker.change_percentage) ?? 0;
    const funding = finite(ticker.funding_rate);
    const mark = finite(ticker.mark_price);
    const indexPrice = finite(ticker.index_price);
    if (price == null || price <= 0) return null;
    const basis = mark != null && indexPrice != null && indexPrice > 0 ? (mark / indexPrice - 1) * 100 : null;
    const direction = change === 0 ? 0 : change > 0 ? 1 : -1;
    const momentum = direction * clamp(Math.abs(change) / 7, 0, 1);
    const fundingPenalty = funding == null ? 0 : Math.sign(funding) * clamp(Math.abs(funding) / 0.001, 0, 1) * 0.28;
    const basisPenalty = basis == null ? 0 : Math.sign(basis) * clamp(Math.abs(basis) / 0.8, 0, 1) * 0.12;
    const coarseScore = clamp(momentum - fundingPenalty - basisPenalty, -1, 1);
    const blocked = funding != null && Math.abs(funding) >= 0.001;
    const state = blocked ? "blocked" : Math.abs(coarseScore) >= 0.34 ? "pre_alert" : "observing";
    return {
      symbol,
      price,
      changePercentage: change,
      volumeUsd: volumeUsd(ticker),
      fundingRate: funding,
      basisPct: basis,
      coarseScore: Number(coarseScore.toFixed(4)),
      confidence: Math.round(clamp(45 + Math.abs(coarseScore) * 24, 45, 69)),
      state,
      stateLabel: state === "blocked" ? "风险拦截" : state === "pre_alert" ? "初筛预警" : "持续观察",
      side: state === "pre_alert" ? (coarseScore > 0 ? "LONG" : "SHORT") : "WAIT",
    };
  }).filter((row): row is UniverseTicker => row != null).sort((a, b) => b.volumeUsd - a.volumeUsd);

  const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
  const selected = rows.slice(0, limit);
  for (const symbol of coreSymbols) {
    const row = bySymbol.get(symbol);
    if (row && !selected.some((item) => item.symbol === symbol)) selected.push(row);
  }
  return selected.sort((a, b) => b.volumeUsd - a.volumeUsd);
}

export async function fetchGateUniverse(limit = 30, coreSymbols: string[] = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_000);
  try {
    const payload = await gate("/futures/usdt/tickers", controller.signal);
    return rankUniverseFromPayload(payload, limit, coreSymbols);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchGatePositionQuotes(symbols: string[]): Promise<GatePositionQuote[]> {
  const unique = [...new Set(symbols)].slice(0, 20);
  if (unique.some((symbol) => !SYMBOL_PATTERN.test(symbol))) throw new Error("Invalid Gate symbol");
  if (!unique.length) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_000);
  try {
    const [tickerPayload, candleResults] = await Promise.all([
      gate("/futures/usdt/tickers", controller.signal),
      Promise.allSettled(unique.map((symbol) => gate(
        `/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&interval=5m&limit=2`,
        controller.signal,
      ))),
    ]);
    const tickerMap = new Map<string, JsonObject>();
    if (Array.isArray(tickerPayload)) {
      for (const row of tickerPayload) {
        const ticker = asObject(row);
        if (typeof ticker.contract === "string") tickerMap.set(ticker.contract, ticker);
      }
    }
    const observedAt = Date.now();
    return unique.flatMap((symbol, index) => {
      const ticker = tickerMap.get(symbol);
      const price = finite(ticker?.last);
      if (!ticker || price == null || price <= 0) return [];
      const candleResult = candleResults[index];
      const candle = candleResult.status === "fulfilled" ? parseCandles(candleResult.value).at(-1) : null;
      return [{
        symbol,
        price,
        highPrice: candle?.high ?? null,
        lowPrice: candle?.low ?? null,
        candleTime: candle?.time ?? null,
        volumeUsd: volumeUsd(ticker),
        observedAt,
      }];
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchGateChartCandles(symbol: string, fromMs: number, toMs: number) {
  if (!SYMBOL_PATTERN.test(symbol)) throw new Error("Invalid Gate symbol");
  const now = Date.now();
  const boundedTo = Math.min(now, Math.max(fromMs + 5 * 60_000, toMs));
  const boundedFrom = Math.max(boundedTo - 72 * 60 * 60_000, Math.min(fromMs, boundedTo - 5 * 60_000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_000);
  try {
    const payload = await gate(
      `/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&interval=5m&from=${Math.floor(boundedFrom / 1000)}&to=${Math.floor(boundedTo / 1000)}`,
      controller.signal,
    );
    return parseCandles(payload).slice(-864);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchBenchmarkMomentum() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_000);
  try {
    const [btc, eth] = await Promise.all([
      gate("/futures/usdt/tickers?contract=BTC_USDT", controller.signal),
      gate("/futures/usdt/tickers?contract=ETH_USDT", controller.signal),
    ]);
    return benchmarkChange(btc, eth);
  } finally {
    clearTimeout(timeout);
  }
}

export async function analyzeGateSymbol(symbol: string, options: {
  global?: Partial<GlobalRiskContext>;
  priorLongProbability?: number | null;
  experience?: ExperienceBySide;
  alertStyle?: "early" | "balanced" | "confirmed";
  detail?: "full" | "scan";
} = {}): Promise<GateAnalysisPacket> {
  if (!SYMBOL_PATTERN.test(symbol)) throw new Error("Invalid Gate symbol");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9_000);
  const startedAt = Date.now();
  try {
    const requestFactories: Record<string, () => Promise<unknown>> = {
      ticker: () => gate(`/futures/usdt/tickers?contract=${encodeURIComponent(symbol)}`, controller.signal),
      candles: () => gate(`/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&interval=5m&limit=80`, controller.signal),
      candles15m: () => gate(`/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&interval=15m&limit=60`, controller.signal),
      candles1h: () => gate(`/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&interval=1h&limit=60`, controller.signal),
      candles4h: () => gate(`/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&interval=4h&limit=50`, controller.signal),
      spotTicker: () => gate(`/spot/tickers?currency_pair=${encodeURIComponent(symbol)}`, controller.signal),
      spotTrades: () => gate(`/spot/trades?currency_pair=${encodeURIComponent(symbol)}&limit=100`, controller.signal),
      contractStats: () => gate(`/futures/usdt/contract_stats?contract=${encodeURIComponent(symbol)}&interval=5m&limit=12`, controller.signal),
      liquidations: () => gate(`/futures/usdt/liq_orders?status=finished&contract=${encodeURIComponent(symbol)}&limit=100`, controller.signal),
    };
    requestFactories.orderBook = () => gate(`/spot/order_book?currency_pair=${encodeURIComponent(symbol)}&limit=50`, controller.signal);
    if (options.global?.benchmarkMomentum == null) {
      requestFactories.btc = () => gate("/futures/usdt/tickers?contract=BTC_USDT", controller.signal);
      requestFactories.eth = () => gate("/futures/usdt/tickers?contract=ETH_USDT", controller.signal);
    }
    const keys = Object.keys(requestFactories);
    const settled = await Promise.allSettled(keys.map((key) => requestFactories[key]()));
    const data = Object.fromEntries(keys.map((key, index) => [key, settled[index].status === "fulfilled" ? settled[index].value : null])) as Record<string, unknown>;
    const sourceErrors = Object.fromEntries(keys.flatMap((key, index) => settled[index].status === "rejected" ? [[key, settled[index].reason instanceof Error ? settled[index].reason.message : "request failed"]] : []));
    const observedAt = Date.now();
    const ticker = firstObject(data.ticker);
    const spotTicker = firstObject(data.spotTicker);
    const candles = parseCandles(data.candles);
    const futuresPrice = finite(ticker.last);
    if (futuresPrice == null || !candles.length) throw new Error("关键价格或 K 线不可用，系统拒绝生成进场结论。");

    const flow = spotFlow(data.spotTrades);
    const book = bookImbalance(data.orderBook);
    const oi = openInterestChange(data.contractStats);
    const spotPrice = finite(spotTicker.last);
    const multiTimeframeTrend = computeMultiTimeframeTrend([data.candles15m, data.candles1h, data.candles4h], observedAt);
    const liquidationImbalance = computeLiquidationImbalance(data.liquidations);
    const benchmarkMomentum = options.global?.benchmarkMomentum ?? benchmarkChange(data.btc, data.eth);
    const sourceAgesMs: MarketInputs["sourceAgesMs"] = {
      ticker: data.ticker ? observedAt - startedAt : null,
      candles: payloadAge(observedAt, candles.at(-1)?.time ?? null),
      spotTicker: data.spotTicker ? observedAt - startedAt : null,
      spotTrades: payloadAge(observedAt, flow.age),
      orderBook: payloadAge(observedAt, book.update),
      contractStats: payloadAge(observedAt, oi.time),
      benchmarks: benchmarkMomentum != null ? observedAt - startedAt : null,
    };
    const input: MarketInputs = {
      symbol,
      observedAt,
      futuresPrice,
      changePercentage: finite(ticker.change_percentage),
      markPrice: finite(ticker.mark_price),
      spotPrice,
      fundingRate: finite(ticker.funding_rate),
      openInterestChangePct: oi.change,
      basisPct: spotPrice && spotPrice > 0 ? (futuresPrice / spotPrice - 1) * 100 : null,
      spotCvdRatio: flow.ratio,
      orderBookImbalance: book.imbalance,
      benchmarkMomentum,
      multiTimeframeTrend,
      liquidationImbalance,
      optionsIvPercentile: options.global?.optionsIvPercentile ?? null,
      macroEventRisk: options.global?.macroEventRisk ?? null,
      macroEventLabel: options.global?.macroEventLabel ?? null,
      etfFlowScore: options.global?.etfFlowScore ?? null,
      priorLongProbability: options.priorLongProbability ?? null,
      experience: options.experience,
      alertStyle: options.alertStyle ?? "balanced",
      candles,
      sourceAgesMs,
    };
    const decision = evaluateMarket(input);
    const mode = decision.dataQuality >= 0.74 ? "live" : "degraded";
    return {
      mode,
      source: "Gate API v4 public market data",
      researchStatus: "uncalibrated-beta",
      observedAt,
      latencyMs: observedAt - startedAt,
      symbol,
      decision,
      market: {
        futuresPrice,
        volumeUsd: volumeUsd(ticker),
        changePercentage: finite(ticker.change_percentage),
        markPrice: input.markPrice,
        spotPrice,
        fundingRate: input.fundingRate,
        openInterestChangePct: input.openInterestChangePct,
        basisPct: input.basisPct,
        spotCvdRatio: input.spotCvdRatio,
        orderBookImbalance: input.orderBookImbalance,
        liquidationImbalance,
        multiTimeframeTrend,
        macroEventRisk: input.macroEventRisk ?? null,
        macroEventLabel: input.macroEventLabel ?? null,
        optionsIvPercentile: input.optionsIvPercentile ?? null,
        etfFlowScore: input.etfFlowScore ?? null,
        sourceAgesMs,
      },
      sourceErrors,
    };
  } finally {
    clearTimeout(timeout);
  }
}
