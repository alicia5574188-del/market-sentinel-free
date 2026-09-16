import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const FUTURES_PATH = process.env.RESEARCH_DATASET ?? '/tmp/gate-history-basis-5m.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/spot-perp-basis-pairs.json';
const raw = JSON.parse(readFileSync(FUTURES_PATH, 'utf8'));
if (raw.interval !== '5m') throw new Error('expected futures 5m dataset');

const BASE_COST = 0.00165;
const STRESS_COST = 0.00270;
const ADVERSE_COST = 0.00350;
const SIDE_GROSS = 0.25;
const INITIAL_EQUITY = 1000;
const MIN_ACTIVE = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finite = Number.isFinite;
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const std = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const monthKey = (t) => new Date(t * 1000).toISOString().slice(0, 7).replace('-', '');

function parseSpotCsv(buf) {
  const text = gunzipSync(buf).toString('utf8');
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const p = line.trim().split(',');
    const time = Number(p[0]); const close = Number(p[2]); const open = Number(p[5]);
    return time > 0 && close > 0 && open > 0 ? [{ time, open, close }] : [];
  });
}

async function fetchArchive(url, tries = 5) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/octet-stream' } });
      if (r.status === 404) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.ok) return buf;
      last = new Error(`${r.status} ${url} ${buf.toString('utf8').slice(0, 180)}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { last = e; }
    await sleep(250 * (i + 1));
  }
  throw last ?? new Error(url);
}

function daysInMonth(month) {
  const y = Number(month.slice(0, 4)); const m = Number(month.slice(4, 6));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

async function fetchSpotMonth(symbol, month) {
  const base = `https://download.gatedata.org/spot/candlesticks_5m/${month}`;
  const monthlyUrl = `${base}/${symbol}-${month}.csv.gz`;
  const monthly = await fetchArchive(monthlyUrl);
  if (monthly) {
    const rows = parseSpotCsv(monthly);
    console.log(`spot-archive ${symbol} ${month} monthly ${rows.length}`);
    return rows;
  }

  const rows = []; let files = 0;
  for (let d = 1; d <= daysInMonth(month); d += 1) {
    const day = String(d).padStart(2, '0');
    const url = `${base}/${symbol}-${month}${day}.csv.gz`;
    const buf = await fetchArchive(url);
    if (!buf) continue;
    rows.push(...parseSpotCsv(buf)); files += 1;
  }
  console.log(`spot-archive ${symbol} ${month} dailyFiles=${files} rows=${rows.length}`);
  return rows;
}

const symbols = raw.datasets.map((d) => d.symbol);
const spotRows = new Map();
let cursor = 0;
async function worker() {
  while (cursor < symbols.length) {
    const symbol = symbols[cursor++];
    const rows = [];
    for (const month of raw.months) rows.push(...await fetchSpotMonth(symbol, month));
    const sorted = [...new Map(rows.map((r) => [r.time, r])).values()].sort((a, b) => a.time - b.time);
    spotRows.set(symbol, sorted);
    console.log(`spot ${symbol} ${sorted.length}`);
  }
}
await Promise.all(Array.from({ length: Math.min(10, symbols.length) }, worker));

const futuresBySymbol = new Map(raw.datasets.map((d) => [d.symbol, d.rows]));
const futuresMaps = new Map(raw.datasets.map((d) => [d.symbol, new Map(d.rows.map((r) => [Number(r.time), r]))]));
const spotMaps = new Map([...spotRows].map(([s, rows]) => [s, new Map(rows.map((r) => [r.time, r]))]));
const reference = raw.datasets.find((d) => d.symbol === 'BTC_USDT') ?? raw.datasets[0];
const times = reference.rows.map((r) => Number(r.time));

const activeSymbols = symbols.filter((symbol) => {
  const f = futuresBySymbol.get(symbol) ?? [];
  const s = spotRows.get(symbol) ?? [];
  if (f.length < times.length * 0.90 || s.length < times.length * 0.90) return false;
  const sm = spotMaps.get(symbol); const fm = futuresMaps.get(symbol);
  let hits = 0; let tests = 0;
  const step = Math.max(1, Math.floor(times.length / 1000));
  for (let i = 0; i < times.length; i += step) { tests += 1; if (sm.has(times[i]) && fm.has(times[i])) hits += 1; }
  return hits / Math.max(tests, 1) >= 0.85;
});
if (activeSymbols.length < MIN_ACTIVE) throw new Error(`only ${activeSymbols.length} active spot/perp symbols`);

const basisBySymbol = new Map();
for (const symbol of activeSymbols) {
  const fm = futuresMaps.get(symbol); const sm = spotMaps.get(symbol);
  const arr = new Float64Array(times.length); arr.fill(NaN);
  for (let i = 0; i < times.length; i += 1) {
    const f = fm.get(times[i]); const s = sm.get(times[i]);
    if (f && s && Number(f.close) > 0 && Number(s.close) > 0) arr[i] = Number(f.close) / Number(s.close) - 1;
  }
  basisBySymbol.set(symbol, arr);
}

const LOOKBACKS = [12, 36, 72];
const HOLDS = [6, 12, 24, 48];
const DEPTHS = [1, 2];
const ZS = [1.5, 2.0, 2.5];
const CADENCES = [3, 6, 12];
const features = new Map();
for (const lb of LOOKBACKS) {
  const bySymbol = new Map();
  for (const symbol of activeSymbols) {
    const b = basisBySymbol.get(symbol);
    const z = new Float32Array(times.length); z.fill(NaN);
    for (let i = lb; i < times.length; i += 1) {
      const window = [];
      for (let j = i - lb; j < i; j += 1) if (finite(b[j])) window.push(b[j]);
      if (window.length < Math.ceil(lb * 0.8) || !finite(b[i])) continue;
      const m = mean(window); const sd = std(window);
      if (sd > 1e-7) z[i] = (b[i] - m) / sd;
    }
    bySymbol.set(symbol, z);
  }
  features.set(lb, bySymbol);
}

const split = {
  discovery: new Set(raw.months.slice(0, 6)),
  validation: new Set(raw.months.slice(6, 9)),
  evaluation: new Set(raw.months.slice(9)),
  full: new Set(raw.months),
};

function simulate(config, selectedMonths, cost) {
  let equity = INITIAL_EQUITY; let peak = equity; let maxDD = 0;
  let grossWin = 0; let grossLoss = 0; let wins = 0; let trades = 0; let turnover = 0;
  const monthly = new Map();
  const zBySymbol = features.get(config.lookback);
  let i = config.lookback;
  while (i < times.length - config.hold - 2) {
    const t = times[i];
    if (!selectedMonths.has(monthKey(t)) || i % config.cadence !== 0) { i += 1; continue; }
    const ranked = [];
    for (const symbol of activeSymbols) {
      const z = zBySymbol.get(symbol)[i];
      if (finite(z)) ranked.push({ symbol, z });
    }
    if (ranked.length < Math.max(MIN_ACTIVE, config.depth * 2)) { i += 1; continue; }
    ranked.sort((a, b) => a.z - b.z);
    const lows = ranked.slice(0, config.depth);
    const highs = ranked.slice(-config.depth).reverse();
    if (lows.at(-1).z > -config.z || highs.at(-1).z < config.z) { i += 1; continue; }
    const entryI = i + 1; const exitI = entryI + config.hold;
    const legs = [...lows.map((x) => ({ ...x, side: 1 })), ...highs.map((x) => ({ ...x, side: -1 }))];
    const weight = SIDE_GROSS / config.depth;
    let eventRet = 0; let valid = true;
    for (const leg of legs) {
      const fm = futuresMaps.get(leg.symbol);
      const entry = Number(fm.get(times[entryI])?.open); const exit = Number(fm.get(times[exitI])?.open);
      if (!(entry > 0 && exit > 0)) { valid = false; break; }
      const r = leg.side > 0 ? exit / entry - 1 : 1 - exit / entry;
      eventRet += weight * (r - cost);
    }
    if (!valid) { i += 1; continue; }
    const before = equity; const pnl = before * eventRet; equity += pnl;
    peak = Math.max(peak, equity); maxDD = Math.max(maxDD, (peak - equity) / Math.max(peak, 1e-9));
    if (pnl > 0) { wins += 1; grossWin += pnl; } else grossLoss += -pnl;
    trades += 1; turnover += 4 * SIDE_GROSS;
    const mk = monthKey(times[exitI]);
    const row = monthly.get(mk) ?? { start: before, end: before, trades: 0, turnover: 0 };
    row.end = equity; row.trades += 1; row.turnover += 4 * SIDE_GROSS; monthly.set(mk, row);
    i = exitI;
  }
  const scopedTimes = times.filter((t) => selectedMonths.has(monthKey(t)));
  const days = scopedTimes.length > 1 ? Math.max(1, (scopedTimes.at(-1) - scopedTimes[0]) / 86400 + 1) : 1;
  const monthRows = [...monthly.entries()].map(([month, row]) => ({ month, return: row.end / row.start - 1, trades: row.trades }));
  const avgMonth = monthRows.length ? mean(monthRows.map((x) => x.return)) : -1;
  return {
    trades, days: Number(days.toFixed(2)), tradesPerDay: Number((trades / days).toFixed(3)),
    turnoverPerDay: Number((turnover / days).toFixed(3)), returnPct: Number(((equity / INITIAL_EQUITY - 1) * 100).toFixed(3)),
    avgMonthPct: Number((avgMonth * 100).toFixed(3)), positiveMonths: monthRows.filter((x) => x.return > 0).length,
    activeMonths: monthRows.length, winRatePct: trades ? Number((wins / trades * 100).toFixed(2)) : 0,
    profitFactor: Number((grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0).toFixed(3)),
    maxDrawdownPct: Number((maxDD * 100).toFixed(3)), monthly: monthRows,
  };
}

const configs = [];
for (const lookback of LOOKBACKS) for (const hold of HOLDS) for (const depth of DEPTHS)
  for (const z of ZS) for (const cadence of CADENCES) configs.push({ lookback, hold, depth, z, cadence });

const discoveryRows = configs.map((config) => {
  const zero = simulate(config, split.discovery, 0);
  const base = simulate(config, split.discovery, BASE_COST);
  const stress = simulate(config, split.discovery, STRESS_COST);
  const eligible = stress.trades >= 60 && stress.returnPct > 0 && stress.profitFactor >= 1.03
    && stress.turnoverPerDay >= 3.5 && stress.turnoverPerDay <= 6.5 && stress.maxDrawdownPct <= 25;
  const score = stress.avgMonthPct * 3 + stress.returnPct * 0.2 - Math.abs(stress.turnoverPerDay - 5) * 2 - stress.maxDrawdownPct * 0.15;
  return { config, zero, base, stress, eligible, score };
}).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);

const topFrozen = discoveryRows.slice(0, 5).map((row) => ({ ...row,
  validation: simulate(row.config, split.validation, BASE_COST),
  validationStress: simulate(row.config, split.validation, STRESS_COST),
  validationAdverse: simulate(row.config, split.validation, ADVERSE_COST),
}));
const validationPassers = topFrozen.filter((row) => row.eligible && row.validationStress.returnPct > 0
  && row.validationStress.profitFactor >= 1 && row.validationAdverse.returnPct > 0);
const selected = validationPassers[0] ?? null;
const enrichedSelected = selected ? {
  ...selected,
  evaluationZero: simulate(selected.config, split.evaluation, 0),
  evaluation: simulate(selected.config, split.evaluation, BASE_COST),
  evaluationStress: simulate(selected.config, split.evaluation, STRESS_COST),
  evaluationAdverse: simulate(selected.config, split.evaluation, ADVERSE_COST),
  fullZero: simulate(selected.config, split.full, 0),
  full: simulate(selected.config, split.full, BASE_COST),
  fullStress: simulate(selected.config, split.full, STRESS_COST),
} : null;
const passes = Boolean(enrichedSelected && enrichedSelected.evaluationStress.returnPct > 0
  && enrichedSelected.evaluationAdverse.returnPct > 0 && enrichedSelected.evaluationStress.avgMonthPct >= 5
  && enrichedSelected.evaluationStress.turnoverPerDay >= 3.5 && enrichedSelected.evaluationStress.turnoverPerDay <= 6.5);

const targetBandBest = discoveryRows.filter((r) => r.stress.turnoverPerDay >= 3.5 && r.stress.turnoverPerDay <= 6.5)
  .sort((a, b) => b.stress.avgMonthPct - a.stress.avgMonthPct)[0] ?? null;
const grossBest = [...discoveryRows].sort((a, b) => b.zero.avgMonthPct - a.zero.avgMonthPct)[0] ?? null;

const report = {
  research: 'gate-spot-perp-cross-sectional-basis-pairs-v1',
  authority: 'RESEARCH_ONLY_NO_DEPLOYMENT',
  decision: passes ? 'SPOT_PERP_BASIS_FORWARD_CANDIDATE' : 'SPOT_PERP_BASIS_REJECTED',
  passes,
  hypothesis: 'trade only perpetuals: long contracts unusually cheap versus their own Gate spot and short contracts unusually rich versus their own Gate spot; equal-gross cross-sectional pair seeks basis normalization rather than outright market direction',
  data: { months: raw.months, futuresSymbols: symbols, activeSymbols, futuresSha256: raw.sha256,
    spotSource: 'Gate historical spot candlesticks_5m archive; monthly path first, daily-file fallback on 404' },
  split: { discovery: raw.months.slice(0, 6), validation: raw.months.slice(6, 9), evaluation: raw.months.slice(9) },
  protocol: { completed5mOnly: true, entry: 'next 5m futures open', onePairAtATime: true, sideGross: SIDE_GROSS,
    cost: { base: BASE_COST, stress: STRESS_COST, adverse: ADVERSE_COST },
    grid: { lookbacks: LOOKBACKS, holds: HOLDS, depths: DEPTHS, z: ZS, cadences: CADENCES, count: configs.length },
    selection: 'top five frozen strictly by discovery score; validation is pass/fail only; evaluation never selects' },
  discoveryEligible: discoveryRows.filter((x) => x.eligible).length,
  topFrozen,
  selected: enrichedSelected,
  targetBandBest,
  grossBest,
  interpretation: passes ? 'Basis signal survives realistic taker costs; next stage may test execution refinements and combination with existing core.'
    : 'Do not tune these same basis lookback/z/hold/cadence parameters against evaluation. If gross edge exists but costs kill it, only a materially different execution mechanism could reopen this family; if gross is weak, close the family entirely.'
};
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`SPOT_PERP_BASIS_JSON=${JSON.stringify({ decision: report.decision, passes, activeSymbols: activeSymbols.length,
  configCount: configs.length, discoveryEligible: report.discoveryEligible, selected: enrichedSelected,
  targetBandBest, grossBest })}`);
