import { detectAllRegimeRoutes } from "../lib/all-regime-engine.ts";

const BASE = "https://api.gateio.ws/api/v4";
const STEP = 300;
const DAYS = Number(process.env.RESEARCH_DAYS ?? 45);
const SYMBOL_LIMIT = Number(process.env.RESEARCH_SYMBOLS ?? 24);
const FRICTION = 0.0014;
const ENTRY_SLIPPAGE = 0.00025;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gate(path, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(`${BASE}${path}`, { headers: { Accept: "application/json", "X-Gate-Size-Decimal": "1" } });
    if (response.ok) return response.json();
    if (attempt === attempts) throw new Error(`Gate ${response.status}: ${path}`);
    await wait(500 * attempt);
  }
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
    pages.push(gate(`/futures/usdt/candlesticks?contract=${encodeURIComponent(symbol)}&interval=5m&from=${cursor}&to=${end}`));
  }
  const rows = (await Promise.all(pages)).flat().map((row) => ({ time: Number(row.t), volume: Number(row.v), close: Number(row.c),
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
        grossReturnRate: gross, netReturnRate: gross - FRICTION, won: gross - FRICTION > 0, outcome, reverse };
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
  return { trades: trades.length, wins: trades.filter((row) => row.won).length,
    winRate: trades.length ? trades.filter((row) => row.won).length / trades.length : 0,
    netReturnRate: returns.reduce((sum, value) => sum + value, 0), meanReturnRate: trades.length ? returns.reduce((sum, value) => sum + value, 0) / trades.length : 0,
    profitFactor: loss > 0 ? gain / loss : gain > 0 ? 99 : 0, activeDays: days.size,
    profitableDayRate: days.size ? [...days.values()].filter((value) => value > 0).length / days.size : 0 };
}

function portfolio(candidateTrades, from, to) {
  const rows = candidateTrades.filter((row) => row.openedAt >= from && row.openedAt < to)
    .sort((a, b) => a.openedAt - b.openedAt || b.score - a.score);
  let equity = 1_000, peak = equity, maxDrawdown = 0;
  const selected = [], open = [];
  for (let index = 0; index < rows.length;) {
    const at = rows[index].openedAt;
    for (let cursor = open.length - 1; cursor >= 0; cursor -= 1) if (open[cursor].closedAt <= at) open.splice(cursor, 1);
    const group = [];
    while (index < rows.length && rows[index].openedAt === at) group.push(rows[index++]);
    const sides = new Set(group.filter((row) => row.score >= group[0].score - 4).map((row) => row.side));
    if (sides.size > 1) continue;
    for (const trade of group) {
      if (open.length >= 2 || open.some((row) => row.symbol === trade.symbol)) continue;
      const stopProxy = Math.max(0.005, Math.abs(trade.grossReturnRate) / 1.5 + FRICTION);
      const multiple = Math.min(4, 0.04 / stopProxy);
      const sized = { ...trade, equityAtOpen: equity, notional: equity * multiple, netPnl: equity * multiple * trade.netReturnRate };
      selected.push(sized); open.push(sized); equity += sized.netPnl; peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak); break;
    }
  }
  return { ...metrics(selected), startEquity: 1_000, endEquity: equity, maxDrawdown };
}

const now = Math.floor(Date.now() / 1000 / STEP) * STEP;
const from = now - DAYS * 86_400;
const symbols = await universe();
const datasets = [];
for (let index = 0; index < symbols.length; index += 4) {
  datasets.push(...await Promise.all(symbols.slice(index, index + 4).map(async (symbol) => ({ symbol, rows: await candles(symbol, from, now) }))));
  console.log(`loaded ${Math.min(index + 4, symbols.length)}/${symbols.length}`);
}
const generated = datasets.flatMap(({ symbol, rows }) => {
  const result = generate(symbol, rows);
  return result.trades.map((trade, index) => ({ ...trade, reverseResult: result.reverseTrades[index] }));
});
const split = from * 1000 + (now - from) * 500;
const ids = ["momentum_carry", "balance_return", "pressure_release", "exhaustion_turn"];
const byStrategy = Object.fromEntries(ids.map((id) => {
  const rows = generated.filter((row) => row.strategyId === id);
  return [id, { train: metrics(rows.filter((row) => row.openedAt < split)), validation: metrics(rows.filter((row) => row.openedAt >= split)),
    reverseValidation: metrics(rows.filter((row) => row.openedAt >= split).map((row) => row.reverseResult)) }];
}));
const trainPortfolio = portfolio(generated, from * 1000, split);
const validationPortfolio = portfolio(generated, split, now * 1000);
const summary = { generatedAt: new Date().toISOString(), days: DAYS, symbols, frictionRate: FRICTION, entrySlippageRate: ENTRY_SLIPPAGE,
  splitAt: new Date(split).toISOString(), signals: generated.length, byStrategy, trainPortfolio, validationPortfolio };
console.table(Object.entries(byStrategy).map(([strategy, value]) => ({ strategy, trainTrades: value.train.trades,
  trainPF: value.train.profitFactor.toFixed(2), validationTrades: value.validation.trades,
  validationWin: `${(value.validation.winRate * 100).toFixed(1)}%`, validationPF: value.validation.profitFactor.toFixed(2),
  validationNet: `${(value.validation.netReturnRate * 100).toFixed(2)}%` })));
console.log(`portfolio validation: ${validationPortfolio.trades} trades, PF ${validationPortfolio.profitFactor.toFixed(2)}, equity ${validationPortfolio.endEquity.toFixed(2)}, maxDD ${(validationPortfolio.maxDrawdown * 100).toFixed(2)}%`);
console.log(`ALL_REGIME_RESEARCH_JSON=${JSON.stringify(summary)}`);
