import { readFileSync, writeFileSync } from 'node:fs';
import {
  advanceRegimePortfolio,
  evaluateRegimePortfolio,
  initialRegimePortfolio,
  REGIME_EXECUTION_UNIVERSE,
  REGIME_SYSTEMS,
} from '../lib/regime-portfolio.ts';

const FIVE = JSON.parse(readFileSync(process.env.RESEARCH_5M_DATASET ?? '/tmp/gate-5m-13m.json', 'utf8'));
const HOURLY = JSON.parse(readFileSync(process.env.RESEARCH_1H_DATASET ?? '/tmp/gate-1h-13m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/regime-v11-capacity-frontier.json';
if (FIVE.interval !== '5m' || HOURLY.interval !== '1h') throw new Error('Need matching 5m and 1h Gate datasets');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const EXTRA_ADVERSE_ENTRY = 0.00025;
const FROM = Date.UTC(2025, 8, 1) / 1000;
const SPLIT = Date.UTC(2026, 5, 1) / 1000;
const TO = Date.UTC(2026, 8, 1) / 1000;
const SYSTEM_COUNT = REGIME_SYSTEMS.length;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const sideSign = (side) => side === 'LONG' ? 1 : -1;

const fiveBySymbol = new Map(FIVE.datasets.map((d) => [d.symbol, d.rows]));
const fiveMap = new Map(FIVE.datasets.map((d) => [d.symbol, new Map(d.rows.map((r) => [r.time, r]))]));
const hourlyBySymbol = new Map(HOURLY.datasets.map((d) => [d.symbol, d.rows]));
const hourlyMap = new Map(HOURLY.datasets.map((d) => [d.symbol, new Map(d.rows.map((r) => [r.time, r]))]));
for (const symbol of REGIME_EXECUTION_UNIVERSE) {
  if (!fiveBySymbol.has(symbol) || !hourlyBySymbol.has(symbol)) throw new Error(`Missing production symbol ${symbol}`);
}

const histories = Object.fromEntries(REGIME_EXECUTION_UNIVERSE.map((symbol) => [
  symbol,
  hourlyBySymbol.get(symbol).filter((r) => r.time < FROM),
]));
const contracts = Object.fromEntries(REGIME_EXECUTION_UNIVERSE.map((symbol) => [symbol, {
  quantoMultiplier: 1e-8,
  maintenanceRate: 0.005,
  leverageMax: 50,
  fundingRate: 0,
  volume24hUsd: 1_000_000_000,
}]));

let state = initialRegimePortfolio(FROM * 1000);
const records = new Map();
const closedSeen = new Set();

function quoteRow(symbol, candleTime, nowMs) {
  const row = fiveMap.get(symbol)?.get(candleTime);
  if (!row) return null;
  return { symbol, bestBid: row.close, bestAsk: row.close, fresh: true, observedAt: nowMs, completedMinuteAt: nowMs };
}

function capture(current) {
  for (const system of REGIME_SYSTEMS) {
    const account = current.accounts[system];
    for (const trade of Object.values(account.open)) {
      if (records.has(trade.id)) continue;
      const fraction = trade.notional / Math.max(trade.accountEquityAtOpen, 1e-12);
      const stopRate = Math.abs((trade.stopPrice ?? trade.entryPrice) / Math.max(trade.entryPrice, 1e-12) - 1);
      records.set(trade.id, {
        id: trade.id, system, symbol: trade.symbol, side: trade.side,
        openedAt: trade.openedAt / 1000, closedAt: null,
        fraction, stopRate,
        satellite: trade.symbol === 'SUI_USDT' || trade.symbol === 'UNI_USDT',
        grossRate: null, stressRate: null, adverseRate: null,
      });
    }
    for (const trade of account.recent) {
      if (trade.status !== 'CLOSED' || closedSeen.has(trade.id)) continue;
      closedSeen.add(trade.id);
      const fraction = trade.notional / Math.max(trade.accountEquityAtOpen, 1e-12);
      const row = records.get(trade.id) ?? {
        id: trade.id, system, symbol: trade.symbol, side: trade.side,
        openedAt: trade.openedAt / 1000,
        fraction,
        stopRate: Math.abs((trade.stopPrice ?? trade.entryPrice) / Math.max(trade.entryPrice, 1e-12) - 1),
        satellite: trade.symbol === 'SUI_USDT' || trade.symbol === 'UNI_USDT',
      };
      row.closedAt = trade.closedAt / 1000;
      row.grossRate = trade.grossReturnRate ?? 0;
      row.stressRate = row.grossRate - STRESS_COST;
      row.adverseRate = row.grossRate - BASE_COST - EXTRA_ADVERSE_ENTRY;
      records.set(trade.id, row);
    }
  }
}

const ref5 = fiveBySymbol.get('BTC_USDT').filter((r) => r.time >= FROM && r.time < TO);
for (const bar of ref5) {
  const nowSec = bar.time + 300;
  const nowMs = nowSec * 1000;
  const quotes = {};
  for (const symbol of REGIME_EXECUTION_UNIVERSE) {
    const q = quoteRow(symbol, bar.time, nowMs);
    if (q) quotes[symbol] = q;
  }
  if (nowSec % HOUR === 0) {
    const completedHour = nowSec - HOUR;
    for (const symbol of REGIME_EXECUTION_UNIVERSE) {
      const row = hourlyMap.get(symbol)?.get(completedHour);
      if (row && histories[symbol].at(-1)?.time !== row.time) histories[symbol].push(row);
    }
    state = evaluateRegimePortfolio({ state, hourly: histories, quotes, contracts, now: nowMs });
  } else {
    state = advanceRegimePortfolio({ state, quotes, now: nowMs });
  }
  capture(state);
}

const trades = [...records.values()]
  .filter((t) => t.openedAt >= FROM && t.openedAt < TO)
  .sort((a, b) => a.openedAt - b.openedAt || a.id.localeCompare(b.id));

function changes(scale) {
  const logical = [];
  for (const t of trades) {
    const sign = sideSign(t.side);
    logical.push({ time: t.openedAt, symbol: t.symbol, delta: sign * t.fraction * scale, system: t.system, id: t.id });
    if (t.closedAt != null) logical.push({ time: t.closedAt, symbol: t.symbol, delta: -sign * t.fraction * scale, system: t.system, id: t.id });
  }
  const buckets = new Map();
  for (const x of logical) {
    const key = `${x.time}:${x.symbol}`;
    buckets.set(key, (buckets.get(key) ?? 0) + x.delta);
  }
  const netted = [...buckets.entries()].map(([key, delta]) => {
    const i = key.indexOf(':');
    return { time: Number(key.slice(0, i)), symbol: key.slice(i + 1), delta };
  }).sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
  return { logical, netted };
}

function exposureStats(scale, from, to) {
  const { logical, netted } = changes(scale);
  const active = new Map();
  let peakNettedGross = 0;
  for (const x of netted) {
    if (x.time < from) active.set(x.symbol, (active.get(x.symbol) ?? 0) + x.delta);
  }
  peakNettedGross = sum([...active.values()].map(Math.abs));
  for (const x of netted) {
    if (x.time < from) continue;
    if (x.time >= to) break;
    active.set(x.symbol, (active.get(x.symbol) ?? 0) + x.delta);
    peakNettedGross = Math.max(peakNettedGross, sum([...active.values()].map(Math.abs)));
  }
  const bySystem = Object.fromEntries(REGIME_SYSTEMS.map((s) => [s, new Map()]));
  const peakSystemGross = Object.fromEntries(REGIME_SYSTEMS.map((s) => [s, 0]));
  const logicalRows = logical.sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
  for (const x of logicalRows) {
    if (x.time < from) {
      const m = bySystem[x.system];
      m.set(x.symbol, (m.get(x.symbol) ?? 0) + x.delta);
    }
  }
  for (const s of REGIME_SYSTEMS) peakSystemGross[s] = sum([...bySystem[s].values()].map(Math.abs));
  for (const x of logicalRows) {
    if (x.time < from) continue;
    if (x.time >= to) break;
    const m = bySystem[x.system];
    m.set(x.symbol, (m.get(x.symbol) ?? 0) + x.delta);
    peakSystemGross[x.system] = Math.max(peakSystemGross[x.system], sum([...m.values()].map(Math.abs)));
  }
  const rows = netted.filter((x) => x.time >= from && x.time < to);
  const lrows = logical.filter((x) => x.time >= from && x.time < to);
  const actual = sum(rows.map((x) => Math.abs(x.delta)));
  const logicalTurnover = sum(lrows.map((x) => Math.abs(x.delta)));
  const days = (to - from) / DAY;
  return {
    turnoverPerDay: actual / days,
    logicalTurnoverPerDay: logicalTurnover / days,
    nettingRetention: logicalTurnover ? actual / logicalTurnover : 1,
    peakNettedGross,
    peakSystemGross,
    worstSystemPeakGross: Math.max(...Object.values(peakSystemGross)),
    impliedMinLeverageAt70pctMargin: peakNettedGross / 0.70,
  };
}

function simulate(scale, field, from, to) {
  const events = [];
  for (const t of trades) {
    if (t.openedAt < from || t.openedAt >= to) continue;
    events.push({ time: t.openedAt, kind: 'OPEN', trade: t });
    if (t.closedAt != null && t.closedAt < to && Number.isFinite(t[field])) events.push({ time: t.closedAt, kind: 'CLOSE', trade: t });
  }
  events.sort((a, b) => a.time - b.time || (a.kind === 'CLOSE' ? -1 : 1));
  const equity = Object.fromEntries(REGIME_SYSTEMS.map((s) => [s, 1]));
  const peaks = { ...equity };
  const minEquity = { ...equity };
  const systemDd = Object.fromEntries(REGIME_SYSTEMS.map((s) => [s, 0]));
  const open = new Map();
  let aggregate = 1;
  let aggregatePeak = 1;
  let aggregateMin = 1;
  let aggregateDd = 0;
  const monthly = new Map();

  const recordPoint = (time) => {
    aggregate = sum(Object.values(equity)) / SYSTEM_COUNT;
    aggregatePeak = Math.max(aggregatePeak, aggregate);
    aggregateMin = Math.min(aggregateMin, aggregate);
    aggregateDd = Math.max(aggregateDd, (aggregatePeak - aggregate) / Math.max(aggregatePeak, 1e-12));
    for (const s of REGIME_SYSTEMS) {
      peaks[s] = Math.max(peaks[s], equity[s]);
      minEquity[s] = Math.min(minEquity[s], equity[s]);
      systemDd[s] = Math.max(systemDd[s], (peaks[s] - equity[s]) / Math.max(peaks[s], 1e-12));
    }
    const d = new Date(time * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    monthly.set(key, aggregate);
  };

  for (const e of events) {
    const t = e.trade;
    if (e.kind === 'CLOSE') {
      const o = open.get(t.id);
      if (o) {
        equity[t.system] += o.equityAtOpen * o.fraction * t[field];
        open.delete(t.id);
      }
    } else {
      open.set(t.id, { equityAtOpen: equity[t.system], fraction: t.fraction * scale });
    }
    recordPoint(e.time);
  }
  const finalAggregate = sum(Object.values(equity)) / SYSTEM_COUNT;
  return {
    startEquity: 1,
    endEquity: finalAggregate,
    net: finalAggregate - 1,
    minAggregateEquity: aggregateMin,
    maxAggregateDrawdown: aggregateDd,
    systemEndEquity: equity,
    systemMinEquity: minEquity,
    systemMaxDrawdown: systemDd,
    worstSystemMinEquity: Math.min(...Object.values(minEquity)),
    worstSystemMaxDrawdown: Math.max(...Object.values(systemDd)),
    allSystemsSurvived: Math.min(...Object.values(minEquity)) > 0,
    positiveSystems: Object.values(equity).filter((x) => x > 1).length,
  };
}

function summarize(scale) {
  const fullStress = simulate(scale, 'stressRate', FROM, TO);
  const fullAdverse = simulate(scale, 'adverseRate', FROM, TO);
  const trainStress = simulate(scale, 'stressRate', FROM, SPLIT);
  const evalStress = simulate(scale, 'stressRate', SPLIT, TO);
  const fullExposure = exposureStats(scale, FROM, TO);
  const trainExposure = exposureStats(scale, FROM, SPLIT);
  const evalExposure = exposureStats(scale, SPLIT, TO);
  const worstDd = Math.max(fullStress.maxAggregateDrawdown, fullAdverse.maxAggregateDrawdown,
    fullStress.worstSystemMaxDrawdown, fullAdverse.worstSystemMaxDrawdown);
  return {
    scale,
    full: { exposure: fullExposure, stress: fullStress, adverse: fullAdverse, worstDrawdown: worstDd },
    train: { exposure: trainExposure, stress: trainStress },
    evaluation: { exposure: evalExposure, stress: evalStress },
    maxTradeNotionalMultiple: Math.max(...trades.map((t) => t.fraction * scale)),
    maxTradeStopRiskFraction: Math.max(...trades.map((t) => t.fraction * scale * t.stopRate)),
    survived: fullStress.allSystemsSurvived && fullAdverse.allSystemsSurvived,
  };
}

const scales = Array.from({ length: 47 }, (_, i) => Number((0.5 + i * 0.25).toFixed(2)));
const frontier = scales.map(summarize);
const safe = frontier.filter((x) => x.survived);
const under = (cap) => [...safe]
  .filter((x) => x.full.worstDrawdown <= cap)
  .sort((a, b) => b.full.exposure.turnoverPerDay - a.full.exposure.turnoverPerDay)[0] ?? null;
const firstAtTurnover = (target) => [...safe]
  .filter((x) => x.full.exposure.turnoverPerDay >= target)
  .sort((a, b) => a.scale - b.scale)[0] ?? null;

const inventory = {
  trades: trades.length,
  closedTrades: trades.filter((t) => t.closedAt != null).length,
  coreTrades: trades.filter((t) => !t.satellite).length,
  satelliteTrades: trades.filter((t) => t.satellite).length,
  bySystem: Object.fromEntries(REGIME_SYSTEMS.map((s) => [s, trades.filter((t) => t.system === s).length])),
  baseFraction: {
    min: Math.min(...trades.map((t) => t.fraction)),
    median: [...trades.map((t) => t.fraction)].sort((a,b)=>a-b)[Math.floor(trades.length/2)],
    max: Math.max(...trades.map((t) => t.fraction)),
  },
};

const output = {
  research: 'regime-v11-frozen-signal-capacity-frontier-v1',
  objective: 'measure how far current V1.1 genuine turnover can be increased by scaling only the already-existing source-order notional, without changing any signal, regime, entry, exit, symbol, or trade timing',
  data: { fiveMinuteSha256: FIVE.sha256, hourlySha256: HOURLY.sha256, months: FIVE.months, symbols: FIVE.symbols },
  periods: { full: [FROM, TO], train: [FROM, SPLIT], evaluation: [SPLIT, TO] },
  protocol: {
    frozenSignals: 'imports current production lib/regime-portfolio.ts and replays the exact current five-system core+SUI/UNI satellite signal/execution manager once; all discovered source trades and exit timing are then frozen',
    scaleMeaning: 'scale multiplies each frozen source trade notional/equity-at-open fraction; every system equity path is re-compounded trade-by-trade at the new size, so PnL and drawdown are not obtained by multiplying the baseline result',
    sourceAccounts: 'five independent source systems start at 1.0 normalized equity each; aggregate equity is their equal-weight mean, preserving independent compounding',
    turnover: 'signed same-symbol source position changes are netted by timestamp before absolute turnover is counted; 1.0x baseline must reproduce the ~0.55x/day V1.1 capacity result from #247',
    scaleGrid: [0.5, 12.0, 0.25],
    costs: { baseRoundTrip: BASE_COST, stressRoundTrip: STRESS_COST, adverseEntryExtraVsBase: EXTRA_ADVERSE_ENTRY },
    leverageDiagnostic: 'implied minimum leverage is peak canonical netted gross divided by a 70% margin-use ceiling; it is a capacity diagnostic, not a liquidation model',
  },
  inventory,
  baseline1x: frontier.find((x) => x.scale === 1) ?? null,
  search: {
    variants: frontier.length,
    survived: safe.length,
    bestUnder20pctWorstDd: under(0.20),
    bestUnder30pctWorstDd: under(0.30),
    bestUnder40pctWorstDd: under(0.40),
    bestUnder50pctWorstDd: under(0.50),
    firstAt2xTurnover: firstAtTurnover(2),
    firstAt3xTurnover: firstAtTurnover(3),
    firstAt4xTurnover: firstAtTurnover(4),
    firstAt5xTurnover: firstAtTurnover(5),
  },
  frontier,
  limitations: [
    'This is a frozen-signal capacity study: scaling does not create or suppress signals through production admission caps. It asks whether the same validated opportunities can carry more notional, not whether a modified risk manager would choose a different trade set.',
    'The exact current manager is advanced on completed 5m closes with zero synthetic spread, matching #247. Turnover sizing is the primary hard result; exit PnL is an intrabar approximation and must not overwrite the committed 44-month V1.1 profitability evidence.',
    'The 13-month current replay is intentionally a first capacity screen. Any materially attractive high-scale point must later be checked on the longer committed-history execution path before production risk settings are changed.',
  ],
};

writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(`REGIME_V11_CAPACITY=${JSON.stringify({ inventory, baseline1x: output.baseline1x, search: output.search, limitations: output.limitations })}`);
