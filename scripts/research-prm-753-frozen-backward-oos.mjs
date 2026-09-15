import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-prm-backward-13m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/prm-753-frozen-backward-oos.json';
if (DATA.interval !== '1h') throw new Error(`Expected 1h dataset, got ${DATA.interval}`);

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.00050;
const MAX_GROSS_X = 5;
const DD_CAPS = [0.10, 0.20, 0.30, 0.50];

// Exact frozen PRM-753 parameters from PR #236. No parameter is tunable here.
const FROZEN = Object.freeze({
  id: 'PRM-753',
  window: 336,
  minCorr: 0.50,
  entryZ: 2.00,
  persistence: 24,
  hold: 24,
  depth: 1,
  decisionStepHours: 6,
});

const EXPECTED_SYMBOLS = [
  'BTC_USDT','ETH_USDT','SOL_USDT','XRP_USDT','BNB_USDT','DOGE_USDT','ADA_USDT','LINK_USDT','LTC_USDT',
  'AVAX_USDT','BCH_USDT','SUI_USDT','UNI_USDT','FIL_USDT','AAVE_USDT','ARB_USDT','APT_USDT','PEPE_USDT','WLD_USDT',
];

const BACK_FROM = Date.UTC(2023, 8, 1) / 1000;
const BACK_TO = Date.UTC(2024, 8, 1) / 1000;
const WARMUP_FROM = BACK_FROM - FROZEN.window * HOUR;

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const monthKey = (t) => {
  const d = new Date(t * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthKeys = (from, to) => {
  const out = [];
  const d = new Date(from * 1000);
  d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
  while (d.getTime() / 1000 < to) {
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
};

const availableDatasets = (DATA.datasets ?? [])
  .filter((d) => EXPECTED_SYMBOLS.includes(d.symbol))
  .map((d) => ({ ...d, rows: [...d.rows].sort((a, b) => a.time - b.time) }));
const symbols = EXPECTED_SYMBOLS.filter((symbol) => availableDatasets.some((d) => d.symbol === symbol));
const missingSymbols = EXPECTED_SYMBOLS.filter((symbol) => !symbols.includes(symbol));
if (symbols.length < 15) throw new Error(`Only ${symbols.length}/19 deterministic coverage-qualified symbols; need >=15`);

const rowsBySymbol = new Map(availableDatasets.map((d) => [d.symbol, d.rows]));
const rowMap = new Map(symbols.map((s) => [s, new Map(rowsBySymbol.get(s).map((r) => [r.time, r]))]));
const anchor = rowsBySymbol.get('BTC_USDT') ?? rowsBySymbol.values().next().value;
const times = anchor.map((r) => r.time).filter((t) => t >= BACK_FROM && t < BACK_TO);

function intervalResidual(a, b, t, hours, beta) {
  const am = rowMap.get(a); const bm = rowMap.get(b);
  const a0 = am.get(t - hours * HOUR)?.close; const a1 = am.get(t)?.close;
  const b0 = bm.get(t - hours * HOUR)?.close; const b1 = bm.get(t)?.close;
  if (![a0, a1, b0, b1].every((v) => Number.isFinite(v) && v > 0)) return null;
  return Math.log(a1 / a0) - beta * Math.log(b1 / b0);
}

function pairFeature(a, b, t) {
  const am = rowMap.get(a); const bm = rowMap.get(b);
  let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
  for (let k = FROZEN.window; k >= 1; k -= 1) {
    const a0 = am.get(t - k * HOUR)?.close; const a1 = am.get(t - (k - 1) * HOUR)?.close;
    const b0 = bm.get(t - k * HOUR)?.close; const b1 = bm.get(t - (k - 1) * HOUR)?.close;
    if (![a0, a1, b0, b1].every((v) => Number.isFinite(v) && v > 0)) return null;
    const x = Math.log(a1 / a0); const y = Math.log(b1 / b0);
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  const n = FROZEN.window; const mx = sx / n; const my = sy / n;
  const vx = Math.max(0, sxx / n - mx * mx); const vy = Math.max(0, syy / n - my * my);
  const cov = sxy / n - mx * my;
  if (!(vx > 1e-12) || !(vy > 1e-12)) return null;
  const corr = cov / Math.sqrt(vx * vy); const beta = cov / vy;
  if (!Number.isFinite(corr) || !Number.isFinite(beta) || beta < 0.25 || beta > 4) return null;
  const residualVar = Math.max(1e-12, vx + beta * beta * vy - 2 * beta * cov);
  const residual = sx - beta * sy;
  const z = residual / Math.sqrt(residualVar * n);
  if (!Number.isFinite(z)) return null;
  const r24 = intervalResidual(a, b, t, FROZEN.persistence, beta);
  if (!Number.isFinite(r24)) return null;
  return { a, b, signalAt: t, corr, beta, z, absZ: Math.abs(z), r24 };
}

const featuresByTime = new Map();
for (const t of times) {
  if (new Date(t * 1000).getUTCHours() % FROZEN.decisionStepHours !== 0) continue;
  if (t - FROZEN.window * HOUR < WARMUP_FROM) continue;
  const rows = [];
  for (let i = 0; i < symbols.length; i += 1) for (let j = i + 1; j < symbols.length; j += 1) {
    const f = pairFeature(symbols[i], symbols[j], t);
    if (f) rows.push(f);
  }
  if (rows.length) featuresByTime.set(t, rows);
}

function legReturn(symbol, direction, entryAt, exitAt, slip) {
  const rm = rowMap.get(symbol); const e0 = rm.get(entryAt)?.open; const x0 = rm.get(exitAt)?.open;
  if (![e0, x0].every((v) => Number.isFinite(v) && v > 0)) return null;
  const entry = direction > 0 ? e0 * (1 + slip) : e0 * (1 - slip);
  return direction > 0 ? x0 / entry - 1 : 1 - x0 / entry;
}

function generate() {
  const busy = new Map(); const out = [];
  for (const [signalAt, rows] of featuresByTime) {
    const entryAt = signalAt + HOUR; const exitAt = entryAt + FROZEN.hold * HOUR;
    if (entryAt < BACK_FROM || exitAt > BACK_TO) continue;
    const eligible = rows
      .filter((f) => f.corr >= FROZEN.minCorr && f.absZ >= FROZEN.entryZ
        && Math.sign(f.r24) === Math.sign(f.z) && Math.abs(f.r24) > 1e-6)
      .sort((x, y) => y.absZ - x.absZ || y.corr - x.corr || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
    const usedNow = new Set(); let selected = 0;
    for (const f of eligible) {
      if (selected >= FROZEN.depth) break;
      if (usedNow.has(f.a) || usedNow.has(f.b)) continue;
      if ((busy.get(f.a) ?? 0) > entryAt || (busy.get(f.b) ?? 0) > entryAt) continue;
      const dirA = f.z > 0 ? 1 : -1; const dirB = -dirA;
      const betaAbs = Math.abs(f.beta); const wA = 1 / (1 + betaAbs); const wB = betaAbs / (1 + betaAbs);
      const aBase = legReturn(f.a, dirA, entryAt, exitAt, ENTRY_SLIP);
      const bBase = legReturn(f.b, dirB, entryAt, exitAt, ENTRY_SLIP);
      const aAdv = legReturn(f.a, dirA, entryAt, exitAt, ADVERSE_SLIP);
      const bAdv = legReturn(f.b, dirB, entryAt, exitAt, ADVERSE_SLIP);
      if (![aBase, bBase, aAdv, bAdv].every(Number.isFinite)) continue;
      const gross = wA * aBase + wB * bBase;
      const adverseGross = wA * aAdv + wB * bAdv;
      out.push({ ...f, entryAt, exitAt, dirA, dirB, wA, wB,
        gross, base: gross - BASE_COST, stress: gross - STRESS_COST,
        adverse: adverseGross - BASE_COST, roundTripTurnover1x: 2, month: monthKey(entryAt) });
      busy.set(f.a, exitAt); busy.set(f.b, exitAt); usedNow.add(f.a); usedNow.add(f.b); selected += 1;
    }
  }
  return out;
}

function stats(rows, field) {
  const xs = rows.filter((e) => e.entryAt >= BACK_FROM && e.exitAt <= BACK_TO);
  const days = (BACK_TO - BACK_FROM) / DAY;
  const gains = sum(xs.filter((e) => e[field] > 0).map((e) => e[field]));
  const losses = Math.abs(sum(xs.filter((e) => e[field] <= 0).map((e) => e[field])));
  const net = sum(xs.map((e) => e[field]));
  let equity = 0; let peak = 0; let maxDrawdown = 0;
  for (const e of [...xs].sort((a, b) => a.exitAt - b.exitAt || a.a.localeCompare(b.a) || a.b.localeCompare(b.b))) {
    equity += e[field]; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const turnover1xPerDay = days ? sum(xs.map((e) => e.roundTripTurnover1x)) / days : 0;
  const avgDaily = days ? net / days : 0;
  const scaling = Object.fromEntries(DD_CAPS.map((cap) => {
    const scale = maxDrawdown > 0 ? Math.min(MAX_GROSS_X, cap / maxDrawdown) : MAX_GROSS_X;
    return [String(cap), { scale, turnoverPerDay: turnover1xPerDay * scale,
      avgMonthlyReturn: avgDaily * 30 * scale, avgMonthly1000U: avgDaily * 30 * scale * 1000 }];
  }));
  return { events: xs.length, eventsPerDay: xs.length / days, turnover1xPerDay, net,
    avgDaily1000At1x: avgDaily * 1000, avgNet: xs.length ? net / xs.length : 0,
    pf: losses ? gains / losses : gains ? 99 : 0,
    winRate: xs.length ? xs.filter((e) => e[field] > 0).length / xs.length : 0,
    maxDrawdown, scaling };
}

const events = generate();
const base = stats(events, 'base');
const stress = stats(events, 'stress');
const adverse = stats(events, 'adverse');
const months = monthKeys(BACK_FROM, BACK_TO).map((month) => {
  const rows = events.filter((e) => e.month === month);
  const stressNet = sum(rows.map((e) => e.stress));
  const adverseNet = sum(rows.map((e) => e.adverse));
  return { month, events: rows.length, stressNet, adverseNet, stressPositive: stressNet > 0, adversePositive: adverseNet > 0 };
});
const sampleEnough = stress.events >= 120;
const backwardPass = sampleEnough && stress.net >= 0 && adverse.net >= 0 && stress.pf >= 1.0;

const output = {
  research: 'prm-753-frozen-backward-oos-v1',
  decision: backwardPass ? 'BACKWARD_OOS_PASS' : 'BACKWARD_OOS_REJECT',
  objective: 'independent frozen backward OOS of the exact PRM-753 rule; zero retuning',
  data: { source: DATA.source, sha256: DATA.sha256, months: DATA.months,
    expectedSymbols: EXPECTED_SYMBOLS, symbols, missingSymbols,
    universeMode: missingSymbols.length ? 'DETERMINISTIC_COVERAGE_SUBSET' : 'EXACT_19' },
  period: { warmupFrom: WARMUP_FROM, backwardFrom: BACK_FROM, backwardTo: BACK_TO,
    months: monthKeys(BACK_FROM, BACK_TO) },
  frozenRule: FROZEN,
  protocol: {
    construction: 'beta-weighted long/short correlated pair; follow standardized cumulative residual winner versus loser',
    entry: 'next hourly open after completed 6h decision anchor',
    noFutureLeakage: true, noSelfTrade: true, noSameSymbolConcurrentPairs: true,
    costsPerUnitGrossNotional: { base: BASE_COST, stress: STRESS_COST, entrySlip: ENTRY_SLIP, adverseSlip: ADVERSE_SLIP },
    turnoverDefinition: '2x round-trip gross notional per 1x pair event; no fake/self-offset volume',
    acceptanceFloor: { minEvents: 120, stressNetGte: 0, adverseNetGte: 0, stressPfGte: 1.0,
      turnover5xIsHardGate: false, monthly5PctIsHardGate: false },
  },
  result: { base, stress, adverse,
    positiveMonthsStress: months.filter((m) => m.stressPositive).length,
    positiveMonthsAdverse: months.filter((m) => m.adversePositive).length,
    months, sampleEnough, backwardPass },
  note: 'This period predates PR #236 discovery (2024-09 onward). No PRM parameter, symbol choice, threshold, hold, persistence, pair ranking, or direction is selected from backward performance. Symbols are included only by predeclared Gate coverage through the data fetch step.',
};

writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(`PRM_753_FROZEN_BACKWARD_OOS=${JSON.stringify({ decision: output.decision,
  universeMode: output.data.universeMode, symbols: symbols.length, missingSymbols,
  frozenRule: FROZEN, result: output.result, note: output.note })}`);
