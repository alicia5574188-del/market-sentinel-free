import { readFileSync, writeFileSync } from "node:fs";

const DATASET = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-12m.json";
const SIGNAL_DATASET = process.env.RESEARCH_SIGNAL_DATASET;
const OUTPUT = process.env.RESEARCH_OUTPUT ?? "/tmp/v6-macro-5m-validation.json";
const FRICTION = Number(process.env.RESEARCH_FRICTION ?? 0.0014);
const ENTRY_SLIPPAGE = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);
const raw = JSON.parse(readFileSync(DATASET, "utf8"));
if (raw.interval !== "5m" || raw.months.length < 12) throw new Error("Requires at least twelve months of Gate 5m archives");
const signalRaw = SIGNAL_DATASET ? JSON.parse(readFileSync(SIGNAL_DATASET, "utf8")) : raw;
if (SIGNAL_DATASET && signalRaw.interval !== "1h") throw new Error("Signal dataset must contain Gate 1h archives");

const config = { id: "macro-six-hourly-0.15-0.04-7-0.5-0.12-2.2-72", family: "MACRO_TREND",
  trend30: 0.15, impulse7: 0.04, breakDays: 7, breadth: 0.5,
  stopFloor: 0.12, stopCap: 0.25, stopAtr: 8, rewardRisk: 2.2, maxHoldHours: 72,
  cooldownHours: 24, riskRate: 0.015, notionalMultiple: 0.50, minNotionalMultiple: 0.05,
  maxOpen: 3, maxSameSide: 2 };
const sum = (values) => values.reduce((total, value) => total + value, 0);
const median = (values) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
};
const sign = (value) => value > 0 ? 1 : value < 0 ? -1 : 0;
const ret = (rows, index, bars) => rows[index].close / rows[index - bars].close - 1;
const continuous = (rows, index, count, step) => {
  if (index + 1 < count) return false;
  for (let cursor = index - count + 2; cursor <= index; cursor += 1) {
    if (rows[cursor].time !== rows[cursor - 1].time + step) return false;
  }
  return true;
};
const aggregateHourly = (rows) => {
  const hours = [];
  let bucket;
  for (const row of rows) {
    const time = Math.floor(row.time / 3_600) * 3_600;
    if (!bucket || bucket.time !== time) {
      if (bucket?.samples >= 10) hours.push(bucket);
      bucket = { time, open: row.open, high: row.high, low: row.low, close: row.close,
        volume: row.volume, samples: 1 };
    } else {
      bucket.high = Math.max(bucket.high, row.high); bucket.low = Math.min(bucket.low, row.low);
      bucket.close = row.close; bucket.volume += row.volume; bucket.samples += 1;
    }
  }
  if (bucket?.samples >= 10) hours.push(bucket);
  return hours;
};

const symbolFilter = new Set((process.env.RESEARCH_SYMBOLS ?? raw.symbols.join(",")).split(","));
const executionBySymbol = new Map(raw.datasets.map(({ symbol, rows }) => [symbol, rows]));
const datasets = signalRaw.datasets.filter(({ symbol }) => symbolFilter.has(symbol) && executionBySymbol.has(symbol))
  .map(({ symbol, rows }) => ({ symbol, execution: executionBySymbol.get(symbol),
    hourly: SIGNAL_DATASET ? rows : aggregateHourly(rows) }));
if (datasets.length < 10) throw new Error(`Hybrid validation requires at least ten contracts, received ${datasets.length}`);
const contexts = new Map();
for (const { hourly } of datasets) {
  for (let index = 720; index < hourly.length; index += 1) {
    if (!continuous(hourly, index, 720, 3_600)) continue;
    const values = contexts.get(hourly[index].time) ?? [];
    values.push({ r30d: ret(hourly, index, 720) }); contexts.set(hourly[index].time, values);
  }
}
for (const [time, values] of contexts) {
  const r30d = values.map((row) => row.r30d);
  contexts.set(time, { markets: values.length, median30d: median(r30d),
    breadth30d: r30d.filter((value) => value > 0).length / values.length });
}

function signal(hourly, index) {
  if (!continuous(hourly, index, 720, 3_600)) return null;
  const context = contexts.get(hourly[index].time);
  if (!context || context.markets < Math.max(8, datasets.length - 2)) return null;
  const r30d = ret(hourly, index, 720); const r7d = ret(hourly, index, 168);
  const direction = sign(r30d); const breadth = direction > 0 ? context.breadth30d : 1 - context.breadth30d;
  if (!direction || Math.abs(r30d) < config.trend30 || sign(r7d) !== direction
    || Math.abs(r7d) < config.impulse7 || sign(context.median30d) !== direction || breadth < config.breadth) return null;
  const previous = hourly.slice(index - 168, index);
  const boundary = direction > 0 ? Math.max(...previous.map((row) => row.high)) : Math.min(...previous.map((row) => row.low));
  if (direction * (hourly[index].close / boundary - 1) < 0) return null;
  const ranges = hourly.slice(index - 5, index + 1).map((row) => (row.high - row.low) / row.close);
  return { direction, strength: Math.abs(r30d) + Math.abs(r7d) + breadth * 0.02, atr6: median(ranges) };
}

function resolve(symbol, execution, hour, found) {
  const entryTime = hour.time + 3_600;
  const start = execution.findIndex((row) => row.time >= entryTime);
  if (start < 0 || execution[start].time > entryTime + 300) return null;
  const direction = found.direction; const entry = execution[start].open * (1 + direction * ENTRY_SLIPPAGE);
  const stopRate = Math.min(config.stopCap, Math.max(config.stopFloor, config.stopAtr * found.atr6));
  const targetRate = Math.max(stopRate * config.rewardRisk, FRICTION * 2.2);
  const stop = entry * (1 - direction * stopRate); const target = entry * (1 + direction * targetRate);
  let exit = execution[Math.min(execution.length - 1, start + config.maxHoldHours * 12)].close;
  let closedAt = execution[Math.min(execution.length - 1, start + config.maxHoldHours * 12)].time * 1_000;
  let outcome = "TIMEOUT";
  for (let offset = 0; offset <= config.maxHoldHours * 12 && start + offset < execution.length; offset += 1) {
    const candle = execution[start + offset];
    const stopped = direction > 0 ? candle.low <= stop : candle.high >= stop;
    const targeted = direction > 0 ? candle.high >= target : candle.low <= target;
    if (stopped || targeted) {
      exit = stopped ? stop : target; closedAt = candle.time * 1_000; outcome = stopped ? "STOP" : "TARGET"; break;
    }
  }
  const grossReturnRate = direction * (exit - entry) / entry;
  return { symbol, side: direction > 0 ? "LONG" : "SHORT", openedAt: execution[start].time * 1_000,
    closedAt, entry, stop, target, stopRate, targetRate, strength: found.strength, outcome,
    grossReturnRate, netReturnRate: grossReturnRate - FRICTION };
}

const candidates = [];
for (const { symbol, hourly, execution } of datasets) {
  for (let index = 720; index < hourly.length - 1; index += 1) {
    if (hourly[index].time % 21_600 !== 18_000) continue;
    const found = signal(hourly, index); if (!found) continue;
    const trade = resolve(symbol, execution, hourly[index], found); if (trade) candidates.push(trade);
  }
}
candidates.sort((left, right) => left.openedAt - right.openedAt || right.strength - left.strength);

let equity = 1_000; let peak = equity; let maxDrawdown = 0;
const open = []; const trades = []; const cooldown = new Map();
const settle = (time) => {
  const closing = open.filter((trade) => trade.closedAt <= time).sort((left, right) => left.closedAt - right.closedAt);
  for (const trade of closing) {
    equity += trade.netPnl; peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    open.splice(open.indexOf(trade), 1); cooldown.set(trade.symbol, trade.closedAt + config.cooldownHours * 3_600_000);
  }
};
for (const trade of candidates) {
  settle(trade.openedAt);
  if (open.some((row) => row.symbol === trade.symbol) || (cooldown.get(trade.symbol) ?? 0) > trade.openedAt) continue;
  const sameSide = open.filter((row) => row.side === trade.side);
  if (open.length >= config.maxOpen || sameSide.length >= config.maxSameSide) continue;
  const multiple = Math.min(config.notionalMultiple, config.riskRate / (trade.stopRate + FRICTION));
  if (multiple < config.minNotionalMultiple) continue;
  const notional = equity * multiple; const plannedRisk = notional * (trade.stopRate + FRICTION);
  if (sum(open.map((row) => row.plannedRisk)) + plannedRisk > equity * 0.10
    || sum(sameSide.map((row) => row.plannedRisk)) + plannedRisk > equity * 0.065) continue;
  const accepted = { ...trade, equityAtOpen: equity, notional, plannedRisk, netPnl: notional * trade.netReturnRate };
  trades.push(accepted); open.push(accepted);
}
settle(Infinity);

const monthlyPnls = raw.months.map((month) => {
  const year = Number(month.slice(0, 4)); const zeroMonth = Number(month.slice(4, 6)) - 1;
  const start = Date.UTC(year, zeroMonth, 1); const end = Date.UTC(year, zeroMonth + 1, 1);
  return { month, pnl: sum(trades.filter((trade) => trade.openedAt >= start && trade.openedAt < end).map((trade) => trade.netPnl)) };
});
const gains = trades.filter((trade) => trade.netPnl > 0).map((trade) => trade.netPnl);
const losses = trades.filter((trade) => trade.netPnl <= 0).map((trade) => trade.netPnl);
const report = { source: raw.source, datasetSha256: raw.sha256,
  signalSource: signalRaw.source, signalDatasetSha256: signalRaw.sha256, config,
  aggregation: "5m execution / completed official 1h signals",
  candidates: candidates.length, trades: trades.length, netPnl: sum(trades.map((trade) => trade.netPnl)),
  profitFactor: losses.length ? sum(gains) / Math.abs(sum(losses)) : gains.length ? 99 : 0,
  winRate: trades.length ? gains.length / trades.length : 0, maxDrawdown,
  activeMonths: monthlyPnls.filter((row) => row.pnl !== 0).length,
  positiveMonths: monthlyPnls.filter((row) => row.pnl > 0).length, monthlyPnls, trades };
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: OUTPUT, ...report, trades: undefined }, null, 2));
