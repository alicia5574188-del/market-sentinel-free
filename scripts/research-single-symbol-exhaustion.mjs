import { readFileSync, writeFileSync } from 'node:fs';

const INPUT = process.env.RESEARCH_DATASET ?? '/tmp/gate-history-expanded-12m.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/single-symbol-exhaustion.json';
const raw = JSON.parse(readFileSync(INPUT, 'utf8'));
if (raw.interval !== '5m' || raw.months.length !== 12) throw new Error('Need 12m 5m');

const BASE = .0014, STRESS = .0022, SLIP = .00025, ADV = .0005, DAY = 86400;
const LOOKS = [15, 30, 45, 60, 90];
const HOLDS = [60, 120, 240, 360, 480];
const QS = [.95, .97, .985, .99];
const LANE_CAP_PER_SYMBOL = 3;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
const quantile = (a, q) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.max(0, Math.floor((b.length - 1) * q)))]; };
const ms = (m) => Date.UTC(+m.slice(0, 4), +m.slice(4, 6) - 1, 1) / 1000;
const DISC = ms(raw.months[6]), VAL = ms(raw.months[9]);
const data = new Map(raw.datasets.map((d) => [d.symbol, d.rows]));
const syms = [...data.keys()];
const idx = new Map([...data].map(([s, r]) => [s, new Map(r.map((x, i) => [x.time, i]))]));
const times = [...new Set(raw.datasets.flatMap((d) => d.rows.map((x) => x.time)))].sort((a, b) => a - b).filter((t) => t % 300 === 0);
const ret = (r, i, b) => r[i].close / r[i - b].close - 1;
const monthIndex = (t) => { const d = new Date(t * 1000); const key = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; return raw.months.indexOf(key); };
const session = (h) => h < 8 ? 'ASIA' : h < 16 ? 'EU' : 'US';
const sign = (x) => x > 0 ? 1 : x < 0 ? -1 : 0;
const volRatio = (r, i) => { if (i < 12) return 0; const base = median(r.slice(i - 12, i).map((x) => x.volume).filter((v) => v > 0)); return base > 0 ? r[i].volume / base : 0; };

const CONDITIONS = [
  { id: 'ALL', test: () => true },
  { id: 'VOL_HIGH_150', test: (f) => f.vr >= 1.5 },
  { id: 'VOL_HIGH_200', test: (f) => f.vr >= 2 },
  { id: 'VOL_HIGH_300', test: (f) => f.vr >= 3 },
  { id: 'VOL_LOW_120', test: (f) => f.vr < 1.2 },
  { id: 'IDIO_150', test: (f) => Math.abs(f.residual) >= 1.5 * Math.max(f.disp, 1e-9) },
  { id: 'IDIO_200', test: (f) => Math.abs(f.residual) >= 2 * Math.max(f.disp, 1e-9) },
  { id: 'MARKET_QUIET', test: (f) => Math.abs(f.marketMedian) < .5 * Math.max(f.disp, 1e-9) },
  { id: 'MARKET_ACTIVE', test: (f) => Math.abs(f.marketMedian) >= .75 * Math.max(f.disp, 1e-9) },
  { id: 'ALIGNED_MARKET', test: (f) => sign(f.r) === sign(f.marketMedian) && Math.abs(f.marketMedian) >= .001 },
  { id: 'COUNTER_MARKET', test: (f) => sign(f.r) !== 0 && sign(f.r) !== sign(f.marketMedian) },
  { id: 'WEEKEND', test: (f) => f.weekend },
  { id: 'WEEKDAY', test: (f) => !f.weekend },
  { id: 'ASIA', test: (f) => f.session === 'ASIA' },
  { id: 'EU', test: (f) => f.session === 'EU' },
  { id: 'US', test: (f) => f.session === 'US' },
  { id: 'VOL150_IDIO150', test: (f) => f.vr >= 1.5 && Math.abs(f.residual) >= 1.5 * Math.max(f.disp, 1e-9) },
  { id: 'VOL200_IDIO150', test: (f) => f.vr >= 2 && Math.abs(f.residual) >= 1.5 * Math.max(f.disp, 1e-9) },
  { id: 'WEEKEND_VOL150', test: (f) => f.weekend && f.vr >= 1.5 },
  { id: 'WEEKDAY_VOL150', test: (f) => !f.weekend && f.vr >= 1.5 },
];
const condMap = new Map(CONDITIONS.map((x) => [x.id, x]));

const featureCache = new Map();
for (const look of LOOKS) {
  const bars = look / 5;
  const perSymbol = new Map(syms.map((s) => [s, []]));
  for (const t of times) {
    const cross = [];
    for (const s of syms) {
      const r = data.get(s), i = idx.get(s)?.get(t);
      if (i == null || i < Math.max(bars, 12) || r[i - bars].time !== t - bars * 300) continue;
      cross.push({ s, r, i, r0: ret(r, i, bars), vr: volRatio(r, i) });
    }
    if (cross.length < 18) continue;
    const m = median(cross.map((x) => x.r0));
    const disp = median(cross.map((x) => Math.abs(x.r0 - m)));
    const entryAt = t + 300;
    const d = new Date(entryAt * 1000), weekend = [0, 6].includes(d.getUTCDay()), sess = session(d.getUTCHours());
    for (const x of cross) perSymbol.get(x.s).push({ t, i: x.i, r: x.r0, vr: x.vr, marketMedian: m, disp, residual: x.r0 - m, weekend, session: sess });
  }
  featureCache.set(look, perSymbol);
}

const thresholds = new Map();
for (const s of syms) for (const look of LOOKS) {
  const discoveryAbs = featureCache.get(look).get(s).filter((x) => x.t < DISC).map((x) => Math.abs(x.r));
  for (const q of QS) thresholds.set(`${s}:${look}:${q}`, quantile(discoveryAbs, q));
}

const eventCache = new Map();
function events(c) {
  const key = `${c.symbol}:${c.look}:${c.q}:${c.hold}`;
  if (eventCache.has(key)) return eventCache.get(key);
  const rows = data.get(c.symbol), threshold = thresholds.get(`${c.symbol}:${c.look}:${c.q}`) ?? 0, hb = c.hold / 5;
  const out = []; let busyUntil = 0;
  for (const f of featureCache.get(c.look).get(c.symbol)) {
    if (!(threshold > 0) || Math.abs(f.r) < threshold || f.t + 300 < busyUntil) continue;
    const entryIndex = f.i + 1, exitIndex = entryIndex + hb;
    if (!rows[entryIndex]?.open || !rows[exitIndex]?.open || rows[exitIndex].time !== f.t + 300 + c.hold * 60) continue;
    const side = f.r > 0 ? 'SHORT' : 'LONG';
    const rawEntry = rows[entryIndex].open, exit = rows[exitIndex].open;
    const entry = rawEntry * (side === 'LONG' ? 1 + SLIP : 1 - SLIP);
    const adverseEntry = rawEntry * (side === 'LONG' ? 1 + ADV : 1 - ADV);
    const gross = side === 'LONG' ? exit / entry - 1 : 1 - exit / entry;
    const grossAdv = side === 'LONG' ? exit / adverseEntry - 1 : 1 - exit / adverseEntry;
    const entryAt = f.t + 300, exitAt = rows[exitIndex].time;
    out.push({ symbol: c.symbol, entryAt, exitAt, side, month: monthIndex(entryAt), features: f,
      base: gross - BASE, stress: gross - STRESS, adverse: grossAdv - BASE });
    busyUntil = exitAt;
  }
  eventCache.set(key, out);
  return out;
}
function filtered(c, condition) { const fn = condMap.get(condition).test; return events(c).filter((e) => fn(e.features)); }
function stats(rows, a, b, field = 'base') {
  const x = rows.filter((e) => e.entryAt >= a && e.exitAt <= b), g = sum(x.filter((e) => e[field] > 0).map((e) => e[field])), l = Math.abs(sum(x.filter((e) => e[field] <= 0).map((e) => e[field]))), net = sum(x.map((e) => e[field]));
  return { trades: x.length, net, avgNet: x.length ? net / x.length : 0, pf: l ? g / l : g ? 99 : 0, tradesPerDay: x.length / ((b - a) / DAY) };
}
function monthly(rows, field = 'base') { return raw.months.map((m, i) => { const x = rows.filter((e) => e.month === i), net = sum(x.map((e) => e[field])); return { month: m, trades: x.length, net, positive: net > 0 }; }); }

const rows = []; let id = 0;
for (const symbol of syms) for (const look of LOOKS) for (const q of QS) for (const hold of HOLDS) {
  const c = { id: `SSE-${id++}`, symbol, look, q, hold, threshold: thresholds.get(`${symbol}:${look}:${q}`) };
  for (const condition of CONDITIONS) {
    const ev = filtered(c, condition.id);
    const d = { base: stats(ev, raw.from, DISC), stress: stats(ev, raw.from, DISC, 'stress'), adverse: stats(ev, raw.from, DISC, 'adverse') };
    const v = { base: stats(ev, DISC, VAL), stress: stats(ev, DISC, VAL, 'stress'), adverse: stats(ev, DISC, VAL, 'adverse') };
    const e = { base: stats(ev, VAL, raw.now), stress: stats(ev, VAL, raw.now, 'stress'), adverse: stats(ev, VAL, raw.now, 'adverse') };
    const mb = monthly(ev), msx = monthly(ev, 'stress');
    const discoveryPositive = mb.slice(0, 6).filter((x) => x.positive).length;
    const validationPositive = mb.slice(6, 9).filter((x) => x.positive).length;
    const trainStressPositive = msx.slice(0, 9).filter((x) => x.positive).length;
    const eligible = d.base.trades >= 50 && v.base.trades >= 15 && d.base.net > 0 && v.base.net > 0 && d.stress.net > 0 && v.stress.net > 0 && d.adverse.net > 0 && v.adverse.net > 0
      && d.base.pf >= 1.15 && v.base.pf >= 1.10 && d.base.avgNet >= .0012 && v.base.avgNet >= .0012
      && discoveryPositive >= 4 && validationPositive >= 2 && trainStressPositive >= 6;
    rows.push({ c, condition: condition.id, discovery: d, validation: v, evaluation: e, discoveryPositive, validationPositive, trainStressPositive, eligible });
  }
}

const eligible = rows.filter((x) => x.eligible).sort((a, b) => Math.min(b.discovery.base.pf, b.validation.base.pf) - Math.min(a.discovery.base.pf, a.validation.base.pf)
  || b.validation.base.avgNet - a.validation.base.avgNet || b.validation.base.trades - a.validation.base.trades);
const frozenByKey = new Map();
for (const x of eligible) { const k = `${x.c.symbol}:${x.condition}`; if (!frozenByKey.has(k)) frozenByKey.set(k, x); }
const frozen = [...frozenByKey.values()].sort((a, b) => Math.min(b.discovery.base.pf, b.validation.base.pf) - Math.min(a.discovery.base.pf, a.validation.base.pf)
  || b.validation.base.avgNet - a.validation.base.avgNet);
function bounds(p) { return p === 'discovery' ? [raw.from, DISC] : p === 'validation' ? [DISC, VAL] : [VAL, raw.now]; }
function overlapAgainst(x, selected) {
  const [a, b] = bounds('validation');
  const seen = new Set();
  for (const s of selected) for (const e of filtered(s.c, s.condition)) if (e.entryAt >= a && e.exitAt <= b) seen.add(`${e.symbol}:${e.entryAt}`);
  const ev = filtered(x.c, x.condition).filter((e) => e.entryAt >= a && e.exitAt <= b);
  if (!ev.length) return 1;
  return 1 - ev.filter((e) => !seen.has(`${e.symbol}:${e.entryAt}`)).length / ev.length;
}
const diverse = [], usage = new Map();
for (const x of frozen) {
  if ((usage.get(x.c.symbol) ?? 0) >= LANE_CAP_PER_SYMBOL) continue;
  const ov = overlapAgainst(x, diverse);
  if (ov <= .50) { diverse.push({ ...x, validationOverlapAtSelection: ov }); usage.set(x.c.symbol, (usage.get(x.c.symbol) ?? 0) + 1); }
}
function unionStats(arr, p, field = 'base') {
  const [a, b] = bounds(p), all = [];
  for (const x of arr) for (const e of filtered(x.c, x.condition)) if (e.entryAt >= a && e.exitAt <= b) all.push({ ...e, engine: `${x.c.id}:${x.condition}` });
  all.sort((u, v) => u.entryAt - v.entryAt || u.symbol.localeCompare(v.symbol));
  const seen = new Set(), unique = [];
  for (const e of all) { const k = `${e.symbol}:${e.entryAt}`; if (seen.has(k)) continue; seen.add(k); unique.push(e); }
  const calc = (z) => { const g = sum(z.filter((e) => e[field] > 0).map((e) => e[field])), l = Math.abs(sum(z.filter((e) => e[field] <= 0).map((e) => e[field]))), net = sum(z.map((e) => e[field])); return { trades: z.length, net, avgNet: z.length ? net / z.length : 0, pf: l ? g / l : g ? 99 : 0, tradesPerDay: z.length / ((b - a) / DAY) }; };
  return { raw: calc(all), unique: calc(unique), overlapRate: all.length ? 1 - unique.length / all.length : 0 };
}
const pack = (arr) => Object.fromEntries(['discovery', 'validation', 'evaluation'].map((p) => [p, { base: unionStats(arr, p), stress: unionStats(arr, p, 'stress'), adverse: unionStats(arr, p, 'adverse') }]));
const evaluationRobust = diverse.filter((x) => x.evaluation.base.net > 0 && x.evaluation.stress.net > 0 && x.evaluation.adverse.net > 0 && x.evaluation.base.pf >= 1.05);
const bySymbol = Object.fromEntries(syms.map((s) => [s, { eligible: eligible.filter((x) => x.c.symbol === s).length, frozen: frozen.filter((x) => x.c.symbol === s).length, diverse: diverse.filter((x) => x.c.symbol === s).length,
  evaluationRobust: evaluationRobust.filter((x) => x.c.symbol === s).length }]));
const report = { universe: syms, grid: { baseConfigs: id, conditions: CONDITIONS.length, candidates: rows.length, looks: LOOKS, holds: HOLDS, quantiles: QS },
  eligible: eligible.length, frozen: frozen.length, diverse: diverse.length, laneCapPerSymbol: LANE_CAP_PER_SYMBOL, symbolUsage: Object.fromEntries(usage), bySymbol,
  full: pack(frozen), diverseResults: pack(diverse), evaluationRobust: evaluationRobust.length, evaluationRobustResults: pack(evaluationRobust),
  frozenRows: frozen.slice(0, 250), diverseRows: diverse.slice(0, 250),
  note: 'Single-symbol exhaustion reversal. Per-symbol move thresholds are frozen from discovery-only empirical absolute-return quantiles. Candidate selection uses discovery+validation only, including cost/adverse and month-level recurrence. Validation-only overlap filtering and a max three lanes per symbol control duplicate event inflation. Evaluation is untouched until final reporting.' };
writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + '\n');
console.log('SINGLE_SYMBOL_EXHAUSTION=' + JSON.stringify({ universe: report.universe, grid: report.grid, eligible: report.eligible, frozen: report.frozen, diverse: report.diverse, symbolUsage: report.symbolUsage, bySymbol: report.bySymbol, diverseResults: report.diverseResults, evaluationRobust: report.evaluationRobust, evaluationRobustResults: report.evaluationRobustResults, note: report.note }));
