import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FIVE_PATH = process.env.RESEARCH_5M_DATASET ?? '/tmp/gate-5m-satellite-expansion-13m.json';
const HOUR_PATH = process.env.RESEARCH_1H_DATASET ?? '/tmp/gate-1h-satellite-expansion-13m.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/regime-satellite-expansion-v2.json';
const FIVE = JSON.parse(readFileSync(FIVE_PATH, 'utf8'));
const HOURLY = JSON.parse(readFileSync(HOUR_PATH, 'utf8'));
if (FIVE.interval !== '5m' || HOURLY.interval !== '1h') throw new Error('Need matching 5m and 1h datasets');
if (FIVE.sha256 !== '55d4201c67196b231b1437c2891385b3d654ef39cba1e3be02b15e157763c648') throw new Error(`Unexpected 5m hash ${FIVE.sha256}`);
if (HOURLY.sha256 !== '7e06d28673395a8e5046380dc60809b72bd53b53688e7fdc69cffb8c35d330dc') throw new Error(`Unexpected 1h hash ${HOURLY.sha256}`);

const CORE = ['BTC_USDT','ETH_USDT','SOL_USDT','XRP_USDT','BNB_USDT','DOGE_USDT','ADA_USDT','LINK_USDT','LTC_USDT','AVAX_USDT','BCH_USDT'];
const EXISTING = ['SUI_USDT','UNI_USDT'];
const CANDIDATES = ['FIL_USDT','AAVE_USDT','ARB_USDT','APT_USDT','PEPE_USDT','WLD_USDT'];
const EXPECTED_19 = [...CORE, ...EXISTING, ...CANDIDATES];
if (EXPECTED_19.some((s) => !FIVE.symbols.includes(s) || !HOURLY.symbols.includes(s))) throw new Error('Dataset missing locked 19-symbol universe');
if (FIVE.symbols.includes('ZEC_USDT')) throw new Error('ZEC must remain excluded from this research universe');

const HOUR = 3600;
const DAY = 86400;
const MEASURE_FROM = Date.UTC(2025, 8, 1) / 1000;
const DISCOVERY_END = Date.UTC(2026, 2, 1) / 1000;
const VALIDATION_END = Date.UTC(2026, 5, 1) / 1000;
const EVALUATION_END = Date.UTC(2026, 8, 1) / 1000;
const PERIODS = {
  discovery: [MEASURE_FROM, DISCOVERY_END],
  validation: [DISCOVERY_END, VALIDATION_END],
  evaluation: [VALIDATION_END, EVALUATION_END],
  full: [MEASURE_FROM, EVALUATION_END],
};
const SCENARIOS = {
  base: { friction: 0.0014, slippage: 0.00025 },
  stress: { friction: 0.0022, slippage: 0.00025 },
  adverse: { friction: 0.0014, slippage: 0.00050 },
};

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const monthKey = (t) => new Date(t * 1000).toISOString().slice(0, 7).replace('-', '');
const fiveBySymbol = new Map(FIVE.datasets.map((d) => [d.symbol, d.rows]));
const fiveMap = new Map(FIVE.datasets.map((d) => [d.symbol, new Map(d.rows.map((r) => [r.time, r]))]));
const hourBySymbol = new Map(HOURLY.datasets.map((d) => [d.symbol, d.rows]));
const hourMap = new Map(HOURLY.datasets.map((d) => [d.symbol, new Map(d.rows.map((r) => [r.time, r]))]));
const referenceBars = fiveBySymbol.get('BTC_USDT').filter((r) => r.time >= MEASURE_FROM && r.time < EVALUATION_END);

const here = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(here, '../lib');
const productionModulePath = resolve(libDir, 'regime-portfolio.ts');
const productionSource = readFileSync(productionModulePath, 'utf8');
const tempModules = [];
let moduleCounter = 0;

function patchedSource(satellites, scenario) {
  const satLiteral = `[${satellites.map((s) => JSON.stringify(s)).join(', ')}] as const`;
  let source = productionSource
    .replace(/export const REGIME_FRICTION_RATE = [^;]+;/, `export const REGIME_FRICTION_RATE = ${scenario.friction};`)
    .replace(/export const REGIME_ENTRY_SLIPPAGE_RATE = [^;]+;/, `export const REGIME_ENTRY_SLIPPAGE_RATE = ${scenario.slippage};`)
    .replace(/export const REGIME_SATELLITE_UNIVERSE = \[[^\]]*\] as const;/, `export const REGIME_SATELLITE_UNIVERSE = ${satLiteral};`);
  if (!source.includes(`REGIME_FRICTION_RATE = ${scenario.friction};`)
    || !source.includes(`REGIME_ENTRY_SLIPPAGE_RATE = ${scenario.slippage};`)
    || !source.includes(`REGIME_SATELLITE_UNIVERSE = ${satLiteral};`)) throw new Error('Failed to patch production manager research copy');
  return source;
}

async function loadManager(satellites, scenarioName) {
  const scenario = SCENARIOS[scenarioName];
  const token = `${String(moduleCounter++).padStart(3, '0')}-${scenarioName}-${satellites.join('-').replace(/_USDT/g, '')}`;
  const path = resolve(libDir, `__research-regime-sat-${token}.ts`);
  writeFileSync(path, patchedSource(satellites, scenario));
  tempModules.push(path);
  return import(`${pathToFileURL(path).href}?v=${moduleCounter}`);
}

function emptySymbolMetric() {
  return { trades: 0, netPnl: 0, profitFactor: 0, winRate: 0, activeMonths: 0, positiveMonths: 0 };
}

function tradeMetrics(rows, start, end, periodDrawdown = 0) {
  const trades = rows.filter((t) => t.openedAt >= start && t.closedAt != null && t.closedAt < end);
  const gains = sum(trades.filter((t) => t.netPnl > 0).map((t) => t.netPnl));
  const losses = Math.abs(sum(trades.filter((t) => t.netPnl <= 0).map((t) => t.netPnl)));
  const monthly = new Map();
  const bySymbolRows = new Map();
  const bySystemRows = new Map();
  for (const t of trades) {
    const m = monthKey(t.closedAt);
    monthly.set(m, (monthly.get(m) ?? 0) + t.netPnl);
    const sr = bySymbolRows.get(t.symbol) ?? []; sr.push(t); bySymbolRows.set(t.symbol, sr);
    const yr = bySystemRows.get(t.system) ?? []; yr.push(t); bySystemRows.set(t.system, yr);
  }
  const metricFor = (xs) => {
    const g = sum(xs.filter((t) => t.netPnl > 0).map((t) => t.netPnl));
    const l = Math.abs(sum(xs.filter((t) => t.netPnl <= 0).map((t) => t.netPnl)));
    const mm = new Map(); for (const t of xs) { const m = monthKey(t.closedAt); mm.set(m, (mm.get(m) ?? 0) + t.netPnl); }
    return { trades: xs.length, netPnl: sum(xs.map((t) => t.netPnl)), profitFactor: l ? g / l : g ? 99 : 0,
      winRate: xs.length ? xs.filter((t) => t.netPnl > 0).length / xs.length : 0,
      activeMonths: mm.size, positiveMonths: [...mm.values()].filter((v) => v > 0).length };
  };
  return {
    trades: trades.length,
    tradesPerDay: trades.length / Math.max(1, (end - start) / DAY),
    netPnl: sum(trades.map((t) => t.netPnl)),
    profitFactor: losses ? gains / losses : gains ? 99 : 0,
    winRate: trades.length ? trades.filter((t) => t.netPnl > 0).length / trades.length : 0,
    activeMonths: monthly.size,
    positiveMonths: [...monthly.values()].filter((v) => v > 0).length,
    monthly: Object.fromEntries([...monthly].sort()),
    bySymbol: Object.fromEntries([...bySymbolRows].sort().map(([s, xs]) => [s, metricFor(xs)])),
    bySystem: Object.fromEntries([...bySystemRows].sort().map(([s, xs]) => [s, metricFor(xs)])),
    maxDrawdown: periodDrawdown,
  };
}

const replayCache = new Map();
async function replay(satellites, scenarioName) {
  const orderedSatellites = [...satellites];
  const cacheKey = `${scenarioName}:${orderedSatellites.join(',')}`;
  if (replayCache.has(cacheKey)) return replayCache.get(cacheKey);
  const manager = await loadManager(orderedSatellites, scenarioName);
  const symbols = [...manager.REGIME_EXECUTION_UNIVERSE];
  if (symbols.join(',') !== [...CORE, ...orderedSatellites].join(',')) throw new Error(`Execution universe patch mismatch: ${symbols.join(',')}`);
  const histories = Object.fromEntries(symbols.map((s) => [s, hourBySymbol.get(s).filter((r) => r.time < MEASURE_FROM)]));
  const contracts = Object.fromEntries(symbols.map((s) => [s, { quantoMultiplier: 1e-8, maintenanceRate: .005,
    leverageMax: 50, fundingRate: 0, volume24hUsd: 1_000_000_000 }]));
  let state = manager.initialRegimePortfolio(MEASURE_FROM * 1000);
  const records = new Map();
  const seenClosed = new Set();
  const dd = Object.fromEntries(Object.keys(PERIODS).map((k) => [k, { peak: null, max: 0 }]));

  function capture() {
    for (const system of manager.REGIME_SYSTEMS) {
      const account = state.accounts[system];
      for (const trade of Object.values(account.open)) {
        if (!records.has(trade.id)) records.set(trade.id, { id: trade.id, system, symbol: trade.symbol, side: trade.side,
          openedAt: trade.openedAt / 1000, closedAt: null, netPnl: null, grossReturnRate: null,
          notional: trade.notional, equityAtOpen: trade.accountEquityAtOpen,
          satellite: !CORE.includes(trade.symbol) });
      }
      for (const trade of account.recent) {
        if (trade.status !== 'CLOSED' || seenClosed.has(trade.id)) continue;
        seenClosed.add(trade.id);
        const row = records.get(trade.id) ?? { id: trade.id, system, symbol: trade.symbol, side: trade.side,
          openedAt: trade.openedAt / 1000, satellite: !CORE.includes(trade.symbol) };
        Object.assign(row, { closedAt: trade.closedAt / 1000, netPnl: trade.netPnl ?? 0,
          grossReturnRate: trade.grossReturnRate ?? 0, netReturnRate: trade.netReturnRate ?? 0,
          notional: trade.notional, equityAtOpen: trade.accountEquityAtOpen });
        records.set(trade.id, row);
      }
    }
  }
  function updateDd(nowSec) {
    const equity = sum(Object.values(state.accounts).map((a) => a.equity));
    for (const [name, [start, end]] of Object.entries(PERIODS)) {
      if (nowSec < start || nowSec >= end) continue;
      const tracker = dd[name];
      tracker.peak = tracker.peak == null ? equity : Math.max(tracker.peak, equity);
      tracker.max = Math.max(tracker.max, (tracker.peak - equity) / Math.max(tracker.peak, 1e-9));
    }
  }

  for (const bar of referenceBars) {
    const nowSec = bar.time + 300;
    const nowMs = nowSec * 1000;
    const quotes = {};
    for (const symbol of symbols) {
      const row = fiveMap.get(symbol)?.get(bar.time);
      if (!row) continue;
      const price = row.close;
      quotes[symbol] = { symbol, bestBid: price, bestAsk: price, fresh: true, observedAt: nowMs, completedMinuteAt: nowMs };
    }
    if (nowSec % HOUR === 0) {
      const completedHour = nowSec - HOUR;
      for (const symbol of symbols) {
        const row = hourMap.get(symbol)?.get(completedHour);
        if (row && histories[symbol].at(-1)?.time !== row.time) histories[symbol].push(row);
      }
      state = manager.evaluateRegimePortfolio({ state, hourly: histories, quotes, contracts, now: nowMs });
    } else state = manager.advanceRegimePortfolio({ state, quotes, now: nowMs });
    capture(); updateDd(nowSec);
  }
  capture();
  const rows = [...records.values()].sort((a, b) => a.openedAt - b.openedAt || a.id.localeCompare(b.id));
  const openedFull = rows.filter((t) => t.openedAt >= MEASURE_FROM && t.openedAt < EVALUATION_END);
  const result = {
    scenario: scenarioName,
    satellites: orderedSatellites,
    executionSymbols: symbols,
    sourceOrdersOpened: openedFull.length,
    sourceOrdersByClass: {
      core: openedFull.filter((t) => CORE.includes(t.symbol)).length,
      satellite: openedFull.filter((t) => !CORE.includes(t.symbol)).length,
    },
    ...Object.fromEntries(Object.entries(PERIODS).map(([name, [start, end]]) => [name, tradeMetrics(rows, start, end, dd[name].max)])),
  };
  replayCache.set(cacheKey, result);
  return result;
}

function symbolMetric(run, period, symbol) { return run[period].bySymbol[symbol] ?? emptySymbolMetric(); }
function delta(run, base, period) { return { trades: run[period].trades - base[period].trades,
  frequencyGain: run[period].trades / Math.max(1, base[period].trades) - 1,
  netPnl: run[period].netPnl - base[period].netPnl,
  profitFactor: run[period].profitFactor - base[period].profitFactor,
  maxDrawdown: run[period].maxDrawdown - base[period].maxDrawdown } }
function selectedPnl(run, period, selected) { return sum(selected.map((s) => symbolMetric(run, period, s).netPnl)); }
function selectedPositive(run, period, selected) { return selected.filter((s) => symbolMetric(run, period, s).netPnl > 0).length; }

console.log('SATELLITE_EXPANSION: baseline production replay');
const baselineBase = await replay(EXISTING, 'base');
const baselineParity = {
  sourceOrders506: baselineBase.sourceOrdersOpened === 506,
  core383: baselineBase.sourceOrdersByClass.core === 383,
  satellite123: baselineBase.sourceOrdersByClass.satellite === 123,
};
if (!Object.values(baselineParity).every(Boolean)) throw new Error(`Production replay parity failed: ${JSON.stringify({ baselineParity, sourceOrders: baselineBase.sourceOrdersOpened, classes: baselineBase.sourceOrdersByClass })}`);

console.log('SATELLITE_EXPANSION: base discovery marginal screen');
const candidateAudits = [];
const preliminary = [];
for (const symbol of CANDIDATES) {
  const run = await replay([...EXISTING, symbol], 'base');
  const own = symbolMetric(run, 'discovery', symbol);
  const d = delta(run, baselineBase, 'discovery');
  const minPositiveMonths = Math.max(2, Math.ceil(own.activeMonths * .50));
  const basePass = own.trades >= 12 && own.netPnl > 0 && own.profitFactor >= 1.05
    && own.positiveMonths >= minPositiveMonths && d.trades >= 3 && d.netPnl > 0
    && run.discovery.maxDrawdown <= baselineBase.discovery.maxDrawdown + .02;
  const audit = { symbol, base: { own, marginal: d, aggregate: { trades: run.discovery.trades, netPnl: run.discovery.netPnl,
    profitFactor: run.discovery.profitFactor, maxDrawdown: run.discovery.maxDrawdown, positiveMonths: run.discovery.positiveMonths } },
    basePass, robustPass: false, stress: null, adverse: null };
  candidateAudits.push(audit);
  if (basePass) preliminary.push(symbol);
  console.log('SAT_BASE', symbol, JSON.stringify({ own, marginal: d, basePass }));
}

console.log('SATELLITE_EXPANSION: pressure tests for base-qualified symbols');
const baselineStress = preliminary.length ? await replay(EXISTING, 'stress') : null;
const baselineAdverse = preliminary.length ? await replay(EXISTING, 'adverse') : null;
const selected = [];
for (const symbol of preliminary) {
  const audit = candidateAudits.find((x) => x.symbol === symbol);
  const stressRun = await replay([...EXISTING, symbol], 'stress');
  const adverseRun = await replay([...EXISTING, symbol], 'adverse');
  const stressOwn = symbolMetric(stressRun, 'discovery', symbol), adverseOwn = symbolMetric(adverseRun, 'discovery', symbol);
  const stressDelta = delta(stressRun, baselineStress, 'discovery'), adverseDelta = delta(adverseRun, baselineAdverse, 'discovery');
  const robustPass = stressOwn.netPnl > 0 && stressOwn.profitFactor >= 1 && stressDelta.netPnl > 0
    && adverseOwn.netPnl > 0 && adverseOwn.profitFactor >= 1 && adverseDelta.netPnl > 0;
  audit.stress = { own: stressOwn, marginal: stressDelta };
  audit.adverse = { own: adverseOwn, marginal: adverseDelta };
  audit.robustPass = robustPass;
  if (robustPass) selected.push(symbol);
  console.log('SAT_PRESSURE', symbol, JSON.stringify({ stressOwn, stressDelta, adverseOwn, adverseDelta, robustPass }));
}

let combo = null;
let discoveryQualified = false;
let validationPass = false;
let evaluationPass = false;
let decision = 'NO_RELEASE';
if (selected.length) {
  console.log('SATELLITE_EXPANSION: frozen selected combination', selected.join(','));
  const comboBase = await replay([...EXISTING, ...selected], 'base');
  const comboStress = await replay([...EXISTING, ...selected], 'stress');
  const comboAdverse = await replay([...EXISTING, ...selected], 'adverse');
  const baseD = delta(comboBase, baselineBase, 'discovery');
  const stressD = delta(comboStress, baselineStress, 'discovery');
  const adverseD = delta(comboAdverse, baselineAdverse, 'discovery');
  discoveryQualified = baseD.frequencyGain >= .05 && baseD.netPnl > 0 && comboBase.discovery.profitFactor >= 1.05
    && comboBase.discovery.positiveMonths >= 4 && comboBase.discovery.maxDrawdown <= .08
    && comboBase.discovery.maxDrawdown <= baselineBase.discovery.maxDrawdown + .02
    && stressD.netPnl > 0 && adverseD.netPnl > 0
    && selectedPnl(comboBase, 'discovery', selected) > 0
    && selectedPnl(comboStress, 'discovery', selected) > 0
    && selectedPnl(comboAdverse, 'discovery', selected) > 0;
  const periodCheck = (period) => {
    const bd = delta(comboBase, baselineBase, period), sd = delta(comboStress, baselineStress, period), ad = delta(comboAdverse, baselineAdverse, period);
    const positive = selectedPositive(comboBase, period, selected);
    const pass = bd.frequencyGain >= .05 && bd.netPnl > 0 && sd.netPnl > 0 && ad.netPnl > 0
      && comboBase[period].positiveMonths >= 2
      && comboBase[period].maxDrawdown <= baselineBase[period].maxDrawdown + .02
      && positive >= Math.ceil(selected.length / 2);
    return { pass, marginal: { base: bd, stress: sd, adverse: ad }, selectedNetPnl: {
      base: selectedPnl(comboBase, period, selected), stress: selectedPnl(comboStress, period, selected), adverse: selectedPnl(comboAdverse, period, selected) },
      selectedPositiveSymbols: positive, selectedSymbolMetrics: Object.fromEntries(selected.map((s) => [s, {
        base: symbolMetric(comboBase, period, s), stress: symbolMetric(comboStress, period, s), adverse: symbolMetric(comboAdverse, period, s) }])) };
  };
  const validation = periodCheck('validation');
  const evaluation = periodCheck('evaluation');
  validationPass = discoveryQualified && validation.pass;
  evaluationPass = discoveryQualified && evaluation.pass;
  decision = validationPass && evaluationPass ? 'EXPANSION_CANDIDATE_NEEDS_FORWARD_PAPER' : 'NO_RELEASE';
  combo = {
    base: comboBase, stress: comboStress, adverse: comboAdverse,
    discovery: { qualified: discoveryQualified, marginal: { base: baseD, stress: stressD, adverse: adverseD },
      selectedNetPnl: { base: selectedPnl(comboBase, 'discovery', selected), stress: selectedPnl(comboStress, 'discovery', selected), adverse: selectedPnl(comboAdverse, 'discovery', selected) } },
    validation, evaluation,
  };
}

const report = {
  research: 'regime-satellite-expansion-v2',
  objective: 'Expand execution-only satellite coverage without changing the frozen 11-symbol regime context or any of the 12 production strategy parameters.',
  data: { fiveSha256: FIVE.sha256, hourlySha256: HOURLY.sha256, months: FIVE.months,
    lockedUniverse: EXPECTED_19, core: CORE, existingSatellites: EXISTING, newCandidates: CANDIDATES, excluded: ['ZEC_USDT'] },
  protocol: {
    splits: { discovery: '2025-09..2026-02', validation: '2026-03..2026-05', evaluation: '2026-06..2026-08' },
    selection: 'Discovery only. Each new symbol is first replayed as a marginal addition to production SUI/UNI. Base pass requires >=12 own trades, positive own PnL, PF>=1.05, >=50% positive active months (minimum 2), >=3 marginal trades, positive marginal portfolio PnL, and <=2pp DD degradation. Only base-pass symbols receive pressure tests. Stress and doubled-slippage own and marginal PnL must remain positive. All robust symbols are frozen as one combination before validation/evaluation.',
    heldOut: 'No symbol or threshold may be changed after discovery. Validation/evaluation each require >=5% frequency gain vs production SUI/UNI baseline, positive marginal PnL under base/stress/adverse, at least 2 positive months, <=2pp DD degradation, and at least half of newly selected symbols individually positive.',
    productionParity: 'Research-only modules are generated at runtime from the exact production lib/regime-portfolio.ts. Only REGIME_SATELLITE_UNIVERSE, friction, and entry slippage constants are patched in temporary copies. Core context and all 12 strategy definitions remain untouched.',
    caveat: 'These 2025-2026 periods have been viewed elsewhere in the project and are not pristine external holdouts. Any survivor still requires forward PAPER validation before production candidacy.'
  },
  baselineParity,
  baseline: { base: baselineBase, stress: baselineStress, adverse: baselineAdverse },
  candidateAudits,
  preliminary,
  selected,
  combo,
  discoveryQualified,
  validationPass,
  evaluationPass,
  decision,
};
writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
for (const path of tempModules) { try { rmSync(path); } catch {} }
console.log('SATELLITE_EXPANSION_RESULT=' + JSON.stringify({ baselineParity, preliminary, selected, discoveryQualified,
  validationPass, evaluationPass, decision,
  candidates: candidateAudits.map((x) => ({ symbol: x.symbol, basePass: x.basePass, robustPass: x.robustPass,
    own: x.base.own, marginal: x.base.marginal, stress: x.stress, adverse: x.adverse })),
  combo: combo ? { discovery: combo.discovery, validation: combo.validation, evaluation: combo.evaluation } : null }));
