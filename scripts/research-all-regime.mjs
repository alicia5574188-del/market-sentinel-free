import { detectAllRegimeRoutes } from "../lib/all-regime-engine.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const BASE = "https://api.gateio.ws/api/v4";
const STEP = 300;
const DAYS = Number(process.env.RESEARCH_DAYS ?? 30);
const SYMBOL_LIMIT = Number(process.env.RESEARCH_SYMBOLS ?? 20);
const FRICTION = 0.0014;
const ENTRY_SLIPPAGE = 0.00025;
const REVERSE_PF = Number(process.env.RESEARCH_REVERSE_PF ?? 2.5);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gate(path, attempts = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${BASE}${path}`, { headers: { Accept: "application/json", "X-Gate-Size-Decimal": "1" } });
      if (response.ok) return response.json();
      lastError = new Error(`Gate ${response.status}: ${path}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await wait(750 * attempt);
  }
  throw lastError ?? new Error(`Gate request failed: ${path}`);
}

async function universe() {
  const [tickers, contracts] = await Promise.all([gate("/futures/usdt/tickers"), gate("/futures/usdt/contracts")]);
  const active = new Set(contracts.filter((row) => !row.in_delisting && (!row.status || row.status === "trading")).map((row) => row.name));
  return tickers.filter((row) => active.has(row.contract) && row.contract?.endsWith("_USDT") && Number(row.last) > 0)
    .sort((a, b) => Number(b.volume_24h_usd ?? b.volume_24h_settle ?? 0) - Number(a.volume_24h_usd ?? a.volume_24h_settle ?? 0))
    .slice(0, SYMBOL_LIMIT).map((row) => row.contract);
}

async function candles(symbol, from, to) {
  const pages = [];
  for (let cursor = from; cursor < to; cursor += STEP * 950) {
    const end = Math.min(to, cursor + STEP * 950);
    pages.push(await gate(`/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&interval=5m&from=${cursor}&to=${end}`));
  }
  const rows = pages.flat().map((row) => ({ time: Number(row.t), volume: Number(row.v), close: Number(row.c),
    high: Number(row.h), low: Number(row.l), open: Number(row.o) }))
    .filter((row) => row.time > 0 && row.open > 0 && row.low > 0 && row.high >= row.low && [row.open, row.high, row.low, row.close].every(Number.isFinite))
    .sort((a, b) => a.time - b.time);
  return [...new Map(rows.map((row) => [row.time, row])).values()];
}

function resolveTrade(symbol, rows, signalIndex, route, reverse = false) {
  if (signalIndex + 1 >= rows.length) return null;
  const side = reverse ? route.side === "LONG" ? "SHORT" : "LONG" : route.side;
  const sign = side === "LONG" ? 1 : -1;
  const riskRate = Math.abs(route.triggerPrice - route.invalidationPrice) / route.triggerPrice;
  const armRate = Math.abs(route.profitArmPrice - route.triggerPrice) / route.triggerPrice;
  const entry = rows[signalIndex + 1].open * (1 + sign * ENTRY_SLIPPAGE);
  const stop = entry * (1 - sign * riskRate);
  const arm = entry * (1 + sign * armRate);
  const risk = Math.abs(entry - stop);
  let activeStop = stop;
  let armed = false;
  let bestFavorable = 0;
  const maxBars = Math.ceil(route.maxHoldMinutes / 5);
  const noProgressBars = Math.ceil(route.noProgressMinutes / 5);
  for (let offset = 1; offset <= maxBars && signalIndex + offset < rows.length; offset += 1) {
    const row = rows[signalIndex + offset];
    bestFavorable = Math.max(bestFavorable, side === "LONG" ? row.high - entry : entry - row.low);
    const stopHit = side === "LONG" ? row.low <= activeStop : row.high >= activeStop;
    const armHit = side === "LONG" ? row.high >= arm : row.low <= arm;
    let exit = null;
    let outcome = null;
    if (stopHit) { exit = activeStop; outcome = armed ? "RUNNER_EXIT" : "STOP"; }
    else if (armHit) armed = true;
    if (exit == null && armed) {
      const protectedMove = Math.max(risk * 0.18, (bestFavorable - risk) * 0.52);
      activeStop = side === "LONG" ? Math.max(activeStop, entry + protectedMove) : Math.min(activeStop, entry - protectedMove);
    }
    if (exit == null && !armed && offset >= noProgressBars && bestFavorable < risk * 0.4) { exit = row.close; outcome = "NO_PROGRESS"; }
    if (exit == null && offset === maxBars) { exit = row.close; outcome = "TIMEOUT"; }
    if (exit != null) {
      const gross = sign * (exit - entry) / entry;
      return { symbol, strategyId: route.strategyId, strategyName: route.strategyName, environment: route.environment, side,
        score: route.score, openedAt: rows[signalIndex + 1].time * 1000, closedAt: row.time * 1000,
        riskRate, armRate, grossReturnRate: gross, netReturnRate: gross - FRICTION,
        won: gross - FRICTION > 0, outcome, reverse };
    }
  }
  return null;
}

function generate(symbol, rows) {
  const trades = [];
  const reverseTrades = [];
  const busyUntil = new Map();
  for (let index = 119; index < rows.length - 1; index += 1) {
    for (const route of detectAllRegimeRoutes(rows.slice(index - 119, index + 1))) {
      if ((busyUntil.get(route.strategyId) ?? 0) >= rows[index + 1].time) continue;
      const nextOpen = rows[index + 1].open;
      const entryExtension = Math.abs(nextOpen - route.triggerPrice) / route.triggerPrice;
      const stopRate = Math.abs(nextOpen - route.invalidationPrice) / nextOpen;
      const rewardRate = Math.abs(route.profitArmPrice - nextOpen) / nextOpen;
      const netRewardRisk = (rewardRate - FRICTION) / Math.max(stopRate + FRICTION, 1e-9);
      if (entryExtension > stopRate * 0.5 || stopRate < FRICTION || FRICTION / Math.max(rewardRate, 1e-9) > 0.25
        || netRewardRisk < 1.2) continue;
      const trade = resolveTrade(symbol, rows, index, route);
      const reverse = resolveTrade(symbol, rows, index, route, true);
      if (!trade || !reverse) continue;
      trades.push(trade); reverseTrades.push(reverse); busyUntil.set(route.strategyId, trade.closedAt / 1000);
    }
  }
  return { trades, reverseTrades };
}

function metrics(trades) {
  const returns = trades.map((row) => row.netReturnRate);
  const gain = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const loss = Math.abs(returns.filter((value) => value <= 0).reduce((sum, value) => sum + value, 0));
  const days = new Map();
  for (const row of trades) {
    const day = new Date(row.closedAt).toISOString().slice(0, 10);
    days.set(day, (days.get(day) ?? 0) + row.netReturnRate);
  }
  const outcomes = Object.fromEntries([...new Set(trades.map((row) => row.outcome))].map((outcome) => [outcome,
    trades.filter((row) => row.outcome === outcome).length]));
  return { trades: trades.length, wins: trades.filter((row) => row.won).length,
    winRate: trades.length ? trades.filter((row) => row.won).length / trades.length : 0,
    netReturnRate: returns.reduce((sum, value) => sum + value, 0), meanReturnRate: trades.length ? returns.reduce((sum, value) => sum + value, 0) / trades.length : 0,
    profitFactor: loss > 0 ? gain / loss : gain > 0 ? 99 : 0, activeDays: days.size,
    profitableDayRate: days.size ? [...days.values()].filter((value) => value > 0).length / days.size : 0,
    grossMeanRate: trades.length ? trades.reduce((sum, row) => sum + row.grossReturnRate, 0) / trades.length : 0, outcomes };
}

function polarityTrade(trade, allTrades) {
  if (process.env.RESEARCH_BASE_ONLY === "1") return trade;
  const history = allTrades.filter((row) => row.strategyId === trade.strategyId && row.openedAt < trade.openedAt
    && row.closedAt < trade.openedAt && row.reverseResult.closedAt < trade.openedAt)
    .sort((a, b) => a.closedAt - b.closedAt);
  let orientation = "NORMAL";
  for (let index = 2; index < history.length; index += 1) {
    const latest = history.slice(index - 2, index + 1);
    const window = history.slice(Math.max(0, index - 11), index + 1);
    const normalEvidence = metrics(window);
    const reverseEvidence = metrics(window.map((row) => row.reverseResult));
    if (latest.every((row) => row.netReturnRate > 0) && normalEvidence.meanReturnRate > 0 && normalEvidence.profitFactor >= 1.05)
      orientation = "NORMAL";
    else if (latest.every((row) => row.netReturnRate < 0) && latest.every((row) => row.reverseResult.netReturnRate > 0)
      && window.length >= 12 && reverseEvidence.meanReturnRate > 0 && reverseEvidence.profitFactor >= REVERSE_PF) orientation = "REVERSE";
  }
  return orientation === "NORMAL" ? trade : trade.reverseResult;
}

function portfolio(candidateTrades, from, to) {
  const rows = candidateTrades.filter((row) => row.openedAt >= from && row.openedAt < to)
    .sort((a, b) => a.openedAt - b.openedAt
      || Number(b.strategyId === "momentum_carry") - Number(a.strategyId === "momentum_carry")
      || (a.symbolRank ?? 999) - (b.symbolRank ?? 999) || b.score - a.score);
  let equity = 1_000, peak = equity, maxDrawdown = 0;
  const selected = [], open = [];
  const settle = (trade) => {
    equity += trade.netPnl; peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  };
  for (let index = 0; index < rows.length;) {
    const at = rows[index].openedAt;
    const closed = open.filter((row) => row.closedAt <= at).sort((a, b) => a.closedAt - b.closedAt);
    for (const trade of closed) { open.splice(open.indexOf(trade), 1); settle(trade); }
    const group = [];
    while (index < rows.length && rows[index].openedAt === at) group.push(rows[index++]);
    const sides = new Set(group.filter((row) => row.score >= group[0].score - 4).map((row) => row.side));
    if (sides.size > 1) continue;
    for (const rawTrade of group) {
      const trade = polarityTrade(rawTrade, candidateTrades);
      if (!trade) continue;
      if (open.some((row) => row.symbol === trade.symbol)) continue;
      const multiple = Math.min(0.5, 0.02 / Math.max(trade.riskRate + FRICTION, 0.005));
      const notional = equity * multiple;
      const plannedRisk = notional * (trade.riskRate + FRICTION);
      const leverage = Math.max(1, Math.ceil(notional / Math.max(equity * 0.1, 1e-9)));
      const margin = notional / leverage;
      const openRisk = open.reduce((total, row) => total + row.plannedRisk, 0);
      const sameDirectionRisk = open.filter((row) => row.side === trade.side)
        .reduce((total, row) => total + row.plannedRisk, 0);
      const openMargin = open.reduce((total, row) => total + row.margin, 0);
      if (openRisk + plannedRisk > equity * 0.10 || sameDirectionRisk + plannedRisk > equity * 0.065
        || openMargin + margin > equity * 0.30) continue;
      const sized = { ...trade, equityAtOpen: equity, notional, plannedRisk, leverage, margin,
        netPnl: notional * trade.netReturnRate };
      selected.push(sized); open.push(sized);
    }
  }
  for (const trade of [...open].sort((a, b) => a.closedAt - b.closedAt)) settle(trade);
  return { ...metrics(selected), startEquity: 1_000, endEquity: equity, maxDrawdown };
}

const now = Math.floor(Date.now() / 1000 / STEP) * STEP;
const from = now - DAYS * 86_400;
const cachePath = "/tmp/all-regime-candles.json";
let symbols;
let datasets;
if (existsSync(cachePath)) {
  const cached = JSON.parse(readFileSync(cachePath, "utf8"));
  if (cached.days === DAYS && cached.symbolLimit === SYMBOL_LIMIT && now - cached.now <= STEP * 2) {
    ({ symbols, datasets } = cached); console.log(`loaded ${symbols.length}/${symbols.length} from bounded local cache`);
  }
}
if (!datasets) {
  symbols = await universe(); datasets = [];
  for (let index = 0; index < symbols.length; index += 2) {
    datasets.push(...await Promise.all(symbols.slice(index, index + 2).map(async (symbol) => ({ symbol, rows: await candles(symbol, from, now) }))));
    console.log(`loaded ${Math.min(index + 2, symbols.length)}/${symbols.length}`);
  }
  writeFileSync(cachePath, JSON.stringify({ days: DAYS, symbolLimit: SYMBOL_LIMIT, now, symbols, datasets }));
}
const marketMoves = new Map();
for (const { rows } of datasets) for (let index = 6; index < rows.length; index += 1) {
  const values = marketMoves.get(rows[index].time) ?? [];
  values.push(rows[index].close / rows[index - 6].close - 1); marketMoves.set(rows[index].time, values);
}
const marketContext = new Map([...marketMoves.entries()].map(([time, values]) => {
  const ordered = [...values].sort((a, b) => a - b);
  return [time, { breadth: values.filter((value) => value > 0).length / values.length,
    medianMove: ordered[Math.floor(ordered.length / 2)] ?? 0, markets: values.length }];
}));
function marketClass(trade) {
  const context = marketContext.get(trade.openedAt / 1000 - STEP);
  if (!context || context.markets < Math.max(4, symbols.length * 0.7)) return "MISSING";
  const long = trade.side === "LONG";
  const aligned = long ? context.breadth >= 0.62 && context.medianMove >= 0.0012
    : context.breadth <= 0.38 && context.medianMove <= -0.0012;
  const opposed = long ? context.breadth <= 0.38 && context.medianMove <= -0.0012
    : context.breadth >= 0.62 && context.medianMove >= 0.0012;
  return aligned ? "ALIGNED" : opposed ? "OPPOSED" : "NEUTRAL";
}
const generated = datasets.flatMap(({ symbol, rows }) => {
  const result = generate(symbol, rows);
  return result.trades.map((trade, index) => ({ ...trade, reverseResult: result.reverseTrades[index] }));
}).map((trade) => ({ ...trade, marketClass: marketClass(trade), symbolRank: symbols.indexOf(trade.symbol) }));
const split = from * 1000 + (now - from) * 500;
const ids = ["momentum_carry", "balance_return", "pressure_release", "exhaustion_turn"];
const byStrategy = Object.fromEntries(ids.map((id) => {
  const rows = generated.filter((row) => row.strategyId === id);
  return [id, { train: metrics(rows.filter((row) => row.openedAt < split)), validation: metrics(rows.filter((row) => row.openedAt >= split)),
    reverseTrain: metrics(rows.filter((row) => row.openedAt < split).map((row) => row.reverseResult)),
    reverseValidation: metrics(rows.filter((row) => row.openedAt >= split).map((row) => row.reverseResult)),
    marketClasses: Object.fromEntries(["ALIGNED", "OPPOSED", "NEUTRAL"].map((kind) => [kind, {
      train: metrics(rows.filter((row) => row.openedAt < split && row.marketClass === kind)),
      validation: metrics(rows.filter((row) => row.openedAt >= split && row.marketClass === kind)),
      reverseTrain: metrics(rows.filter((row) => row.openedAt < split && row.marketClass === kind).map((row) => row.reverseResult)),
      reverseValidation: metrics(rows.filter((row) => row.openedAt >= split && row.marketClass === kind).map((row) => row.reverseResult)),
    }])),
    scoreBands: Object.fromEntries([70, 75, 80, 85, 90].map((minimum) => [minimum, {
      train: metrics(rows.filter((row) => row.openedAt < split && row.score >= minimum)),
      validation: metrics(rows.filter((row) => row.openedAt >= split && row.score >= minimum)),
    }])) }];
}));
const approvedGenerated = generated.flatMap((row) => {
  if (row.strategyId !== "exhaustion_turn") return [];
  if (row.marketClass === "OPPOSED") return [{ ...row.reverseResult, strategyId: "momentum_carry", strategyName: "势承",
    marketClass: row.marketClass, reverseResult: { ...row, strategyId: "momentum_carry", strategyName: "势承" } }];
  if (row.marketClass === "NEUTRAL") return [{ ...row, strategyName: "竭转" }];
  return [];
});
const byApprovedRoute = {
  momentum_carry: { train: metrics(approvedGenerated.filter((row) => row.strategyId === "momentum_carry" && row.openedAt < split)),
    validation: metrics(approvedGenerated.filter((row) => row.strategyId === "momentum_carry" && row.openedAt >= split)) },
  exhaustion_turn: { train: metrics(approvedGenerated.filter((row) => row.strategyId === "exhaustion_turn" && row.openedAt < split)),
    validation: metrics(approvedGenerated.filter((row) => row.strategyId === "exhaustion_turn" && row.openedAt >= split)) },
};
const approvedBySymbol = Object.fromEntries(symbols.map((symbol) => [symbol, {
  train: metrics(approvedGenerated.filter((row) => row.symbol === symbol && row.openedAt < split)),
  validation: metrics(approvedGenerated.filter((row) => row.symbol === symbol && row.openedAt >= split)),
}]).filter(([, value]) => value.train.trades + value.validation.trades > 0));
const trainPortfolio = portfolio(approvedGenerated, from * 1000, split);
const validationPortfolio = portfolio(approvedGenerated, split, now * 1000);
const summary = { generatedAt: new Date().toISOString(), days: DAYS, symbols, frictionRate: FRICTION, entrySlippageRate: ENTRY_SLIPPAGE,
  splitAt: new Date(split).toISOString(), signals: generated.length, approvedSignals: approvedGenerated.length,
  byStrategy, byApprovedRoute, approvedBySymbol, trainPortfolio, validationPortfolio };
console.table(Object.entries(byStrategy).map(([strategy, value]) => ({ strategy, trainTrades: value.train.trades,
  trainPF: value.train.profitFactor.toFixed(2), validationTrades: value.validation.trades,
  validationWin: `${(value.validation.winRate * 100).toFixed(1)}%`, validationPF: value.validation.profitFactor.toFixed(2),
  validationNet: `${(value.validation.netReturnRate * 100).toFixed(2)}%` })));
console.log(`portfolio validation: ${validationPortfolio.trades} trades, PF ${validationPortfolio.profitFactor.toFixed(2)}, equity ${validationPortfolio.endEquity.toFixed(2)}, maxDD ${(validationPortfolio.maxDrawdown * 100).toFixed(2)}%`);
console.log(`ALL_REGIME_RESEARCH_JSON=${JSON.stringify(summary)}`);
