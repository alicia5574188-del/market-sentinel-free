import { createWriteStream, createReadStream, mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import readline from 'node:readline';
import { createHash } from 'node:crypto';

const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/anchor-dislocation-actual-trades.json';
const DATA_DIR = process.env.RESEARCH_DATA_DIR ?? '/tmp/anchor-dislocation-actual-trades';
const ARCHIVE = 'https://download.gatedata.org/futures_usdt';
const SYMBOLS = ['BTC_USDT', 'SOL_USDT', 'SUI_USDT'];
const PERIODS = {
  era1: ['202310'],
  era2: ['202410'],
  era3: ['202510'],
  evaluation: ['202607'],
};
const MONTH_TO_PERIOD = Object.fromEntries(Object.entries(PERIODS).flatMap(([p, months]) => months.map((m) => [m, p])));
const MONTHS = Object.values(PERIODS).flat();
const ANCHORS = ['MARK', 'INDEX', 'BLEND'];
const THRESHOLDS_BPS = [10, 15, 20, 25, 30, 40, 50, 75, 100];
const HORIZONS_SEC = [10, 30, 60, 180, 300];
const MAX_ANCHOR_AGE_MS = 5_000;
const MAX_ENTRY_DELAY_MS = 2_000;
const STRESS_COST = 0.0022; // 22bp round trip
const ADVERSE_EXTRA = 0.0005; // +5bp latency/slippage stress
const MIN_EVENTS_PER_ERA = 30;

mkdirSync(DATA_DIR, { recursive: true });

function normalizeTs(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return NaN;
  if (x > 1e17) return x / 1e6; // ns -> ms
  if (x > 1e14) return x / 1e3; // us -> ms
  if (x > 1e11) return x;       // ms
  return x * 1000;              // s -> ms
}
function daysInMonth(yyyymm) {
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function median(xs) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
}
function percentile(xs, q) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.max(0, Math.min(a.length - 1, Math.floor((a.length - 1) * q)))];
}
function pf(returns) {
  let gp = 0, gl = 0;
  for (const r of returns) {
    if (r > 0) gp += r;
    else gl += -r;
  }
  return gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
}
function summarize(returns, days) {
  const n = returns.length;
  const net = returns.reduce((a, b) => a + b, 0);
  const wins = returns.filter((x) => x > 0).length;
  const eventsPerDay = days > 0 ? n / days : 0;
  return {
    events: n,
    eventsPerDay,
    turnover1xPerDay: eventsPerDay * 2,
    eventGrossNeededFor5x: eventsPerDay > 0 ? 5 / (2 * eventsPerDay) : null,
    net,
    avgEvent: n ? net / n : 0,
    pf: pf(returns),
    winRate: n ? wins / n : 0,
  };
}
function configKey(anchor, threshold, horizon) { return `${anchor}|${threshold}|${horizon}`; }
function parseKey(key) {
  const [anchor, threshold, horizon] = key.split('|');
  return { anchor, thresholdBps: Number(threshold), horizonSec: Number(horizon) };
}

async function download(kind, month, symbol) {
  const path = `${DATA_DIR}/${kind}-${month}-${symbol}.csv.gz`;
  if (existsSync(path) && statSync(path).size > 100) return path;
  const url = `${ARCHIVE}/${kind}/${month}/${symbol}-${month}.csv.gz`;
  const r = await fetch(url, { headers: { 'User-Agent': 'market-sentinel-research' }, signal: AbortSignal.timeout(180_000) });
  if (!r.ok || !r.body) throw new Error(`download ${url} failed: HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(path));
  if (statSync(path).size < 100) throw new Error(`archive too small: ${url}`);
  return path;
}

async function parseMarks(path) {
  const out = [];
  const rl = readline.createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const p = line.split(',');
    if (p.length < 4) continue;
    const ts = normalizeTs(p[0]);
    const index = Number(p[1]);
    const mark = Number(p[2]);
    if (!Number.isFinite(ts) || !Number.isFinite(index) || !Number.isFinite(mark) || index <= 0 || mark <= 0) continue;
    out.push({ ts, index, mark });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function freshState() {
  const map = new Map();
  for (const anchor of ANCHORS) {
    for (const threshold of THRESHOLDS_BPS) {
      map.set(`${anchor}|${threshold}`, {
        anchor, threshold, armed: true, pendingEntry: null, active: null, rearmReady: false,
      });
    }
  }
  return map;
}

function anchorValue(markRow, anchor) {
  if (anchor === 'MARK') return markRow.mark;
  if (anchor === 'INDEX') return markRow.index;
  return (markRow.mark + markRow.index) / 2;
}

async function processTrades({ tradePath, marks, period, month, symbol, returns, diagnostics }) {
  const states = freshState();
  let markIdx = -1;
  let lastTradeTs = -Infinity;
  let tradeRows = 0;
  let eligibleAnchorTrades = 0;
  const anchorAges = [];
  let outOfOrder = 0;

  const rl = readline.createInterface({ input: createReadStream(tradePath).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const p = line.split(',');
    if (p.length < 4) continue;
    const ts = normalizeTs(p[0]);
    const price = Number(p[2]);
    if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0) continue;
    tradeRows += 1;
    if (ts < lastTradeTs) outOfOrder += 1;
    lastTradeTs = Math.max(lastTradeTs, ts);

    while (markIdx + 1 < marks.length && marks[markIdx + 1].ts <= ts) markIdx += 1;
    if (markIdx < 0) continue;
    const markRow = marks[markIdx];
    const anchorAge = ts - markRow.ts;
    if (anchorAge < 0 || anchorAge > MAX_ANCHOR_AGE_MS) continue;
    eligibleAnchorTrades += 1;
    if (anchorAges.length < 100_000) anchorAges.push(anchorAge);

    for (const state of states.values()) {
      const a = anchorValue(markRow, state.anchor);
      const dev = price / a - 1;
      const absBps = Math.abs(dev) * 10_000;

      // If a signal was observed on the previous actual trade, enter only on the next actual trade.
      if (state.pendingEntry) {
        const s = state.pendingEntry;
        const delay = ts - s.signalTs;
        if (delay <= MAX_ENTRY_DELAY_MS) {
          state.active = {
            entryTs: ts,
            entryPrice: price,
            dir: s.dir,
            outcomes: new Set(),
          };
        }
        state.pendingEntry = null;
      }

      if (state.active) {
        for (const h of HORIZONS_SEC) {
          if (state.active.outcomes.has(h)) continue;
          if (ts >= state.active.entryTs + h * 1000) {
            const raw = state.active.dir * (price / state.active.entryPrice - 1);
            const key = configKey(state.anchor, state.threshold, h);
            if (!returns[period][key]) returns[period][key] = { raw: [], stress: [], adverse: [] };
            returns[period][key].raw.push(raw);
            returns[period][key].stress.push(raw - STRESS_COST);
            returns[period][key].adverse.push(raw - STRESS_COST - ADVERSE_EXTRA);
            state.active.outcomes.add(h);
          }
        }
        if (state.active.outcomes.size === HORIZONS_SEC.length) {
          state.active = null;
          if (state.rearmReady) { state.armed = true; state.rearmReady = false; }
        }
      }

      if (!state.armed && absBps <= state.threshold / 3) {
        if (state.active || state.pendingEntry) state.rearmReady = true;
        else { state.armed = true; state.rearmReady = false; }
      }

      if (state.armed && !state.active && !state.pendingEntry && absBps >= state.threshold) {
        // price above anchor -> short; below anchor -> long
        state.pendingEntry = { signalTs: ts, dir: dev > 0 ? -1 : 1 };
        state.armed = false;
        state.rearmReady = false;
      }
    }
  }

  diagnostics.push({
    period, month, symbol, tradeRows, markRows: marks.length, eligibleAnchorTrades,
    eligibleRatio: tradeRows ? eligibleAnchorTrades / tradeRows : 0,
    anchorAgeMsP50: median(anchorAges), anchorAgeMsP95: percentile(anchorAges, 0.95),
    outOfOrder,
  });
}

const returns = Object.fromEntries(Object.keys(PERIODS).map((p) => [p, {}]));
const diagnostics = [];
const archiveMeta = [];

for (const month of MONTHS) {
  const period = MONTH_TO_PERIOD[month];
  for (const symbol of SYMBOLS) {
    const [markPath, tradePath] = await Promise.all([
      download('mark_prices', month, symbol),
      download('trades', month, symbol),
    ]);
    archiveMeta.push({ month, symbol, markBytes: statSync(markPath).size, tradeBytes: statSync(tradePath).size });
    const marks = await parseMarks(markPath);
    if (!marks.length) throw new Error(`no mark rows ${month} ${symbol}`);
    await processTrades({ tradePath, marks, period, month, symbol, returns, diagnostics });
  }
}

const daysByPeriod = Object.fromEntries(Object.entries(PERIODS).map(([p, months]) => [p, months.reduce((s, m) => s + daysInMonth(m), 0)]));
const keys = [];
for (const anchor of ANCHORS) for (const t of THRESHOLDS_BPS) for (const h of HORIZONS_SEC) keys.push(configKey(anchor, t, h));

const configs = [];
for (const key of keys) {
  const periods = {};
  for (const p of Object.keys(PERIODS)) {
    const r = returns[p][key] ?? { raw: [], stress: [], adverse: [] };
    periods[p] = {
      raw: summarize(r.raw, daysByPeriod[p]),
      stress: summarize(r.stress, daysByPeriod[p]),
      adverse: summarize(r.adverse, daysByPeriod[p]),
    };
  }
  const pre = ['era1', 'era2', 'era3'];
  const floor = pre.every((p) => periods[p].stress.events >= MIN_EVENTS_PER_ERA && periods[p].stress.net >= 0 && periods[p].stress.pf >= 1 && periods[p].adverse.net >= 0);
  const minStressPf = Math.min(...pre.map((p) => periods[p].stress.pf));
  const minAdverseNet = Math.min(...pre.map((p) => periods[p].adverse.net));
  const minEventsPerDay = Math.min(...pre.map((p) => periods[p].stress.eventsPerDay));
  configs.push({ key, ...parseKey(key), floor, minStressPf, minAdverseNet, minEventsPerDay, periods });
}

const qualified = configs.filter((c) => c.floor).sort((a, b) =>
  (b.minAdverseNet - a.minAdverseNet) || (b.minStressPf - a.minStressPf) || (b.minEventsPerDay - a.minEventsPerDay)
);
const frozen = qualified[0] ?? null;
const evaluation = frozen ? frozen.periods.evaluation : null;

const result = {
  research: 'anchor-dislocation-actual-trades-v1',
  objective: 'screen whether actual Gate futures transactions that dislocate from the causal mark/index anchor exhibit portable post-trade convergence large enough to survive realistic costs',
  protocol: {
    symbols: SYMBOLS,
    periods: PERIODS,
    archives: 'official Gate futures_usdt trades + mark_prices monthly archives',
    signal: 'actual trade price versus latest causal mark/index observation only; no mark last_price signal',
    anchors: ANCHORS,
    thresholdsBps: THRESHOLDS_BPS,
    horizonsSec: HORIZONS_SEC,
    maxAnchorAgeMs: MAX_ANCHOR_AGE_MS,
    entry: `next actual archived trade after signal, max ${MAX_ENTRY_DELAY_MS}ms delay`,
    eventDedup: 'one event per symbol/anchor/threshold until the 5m outcome matures and deviation has re-armed inside one-third threshold',
    costs: { stressRoundTrip: STRESS_COST, adverseExtra: ADVERSE_EXTRA },
    acceptanceFloor: `same exact config: >=${MIN_EVENTS_PER_ERA} matured events, stress net>=0, stress PF>=1, adverse net>=0 in era1/era2/era3`,
    turnover: '2x round-trip notional per matured event; 5x/day is a soft target',
    evaluationGate: '2026-07 opened only if the same exact configuration clears all three pre-evaluation months',
  },
  diagnostics,
  archiveMeta,
  counts: {
    configs: configs.length,
    era1StressPositive: configs.filter((c) => c.periods.era1.stress.net >= 0).length,
    era2StressPositive: configs.filter((c) => c.periods.era2.stress.net >= 0).length,
    era3StressPositive: configs.filter((c) => c.periods.era3.stress.net >= 0).length,
    allThreeStressPositive: configs.filter((c) => ['era1','era2','era3'].every((p) => c.periods[p].stress.net >= 0)).length,
    allThreeAdversePositive: configs.filter((c) => ['era1','era2','era3'].every((p) => c.periods[p].adverse.net >= 0)).length,
    floorQualified: qualified.length,
  },
  frozen: frozen ? { key: frozen.key, anchor: frozen.anchor, thresholdBps: frozen.thresholdBps, horizonSec: frozen.horizonSec, minStressPf: frozen.minStressPf, minAdverseNet: frozen.minAdverseNet, minEventsPerDay: frozen.minEventsPerDay, prePeriods: { era1: frozen.periods.era1, era2: frozen.periods.era2, era3: frozen.periods.era3 } } : null,
  evaluation,
  topQualified: qualified.slice(0, 10).map((c) => ({ key: c.key, anchor: c.anchor, thresholdBps: c.thresholdBps, horizonSec: c.horizonSec, minStressPf: c.minStressPf, minAdverseNet: c.minAdverseNet, minEventsPerDay: c.minEventsPerDay, periods: c.periods })),
  topDiagnostics: configs.slice().sort((a,b) => (b.minAdverseNet - a.minAdverseNet) || (b.minStressPf - a.minStressPf)).slice(0, 10).map((c) => ({ key: c.key, anchor: c.anchor, thresholdBps: c.thresholdBps, horizonSec: c.horizonSec, floor: c.floor, minStressPf: c.minStressPf, minAdverseNet: c.minAdverseNet, minEventsPerDay: c.minEventsPerDay, periods: c.periods })),
};
result.decision = frozen ? (evaluation?.stress?.net >= 0 && evaluation?.adverse?.net >= 0 ? 'STRUCTURAL_SCREEN_QUALIFIED' : 'EVALUATION_FAILED') : 'PRE_ERA_REJECT';
result.sha256 = createHash('sha256').update(JSON.stringify(result)).digest('hex');
writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(`ANCHOR_DISLOCATION_ACTUAL_TRADES=${JSON.stringify({ decision: result.decision, counts: result.counts, frozen: result.frozen, evaluation: result.evaluation, diagnostics: result.diagnostics, archiveMeta: result.archiveMeta, sha256: result.sha256 })}`);
