import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-5m-12m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/propagation-5m-turnover.json';
if (DATA.interval !== '5m' || DATA.months?.length !== 12) throw new Error('Need 12-month Gate 5m dataset');

const STEP = 300;
const DAY = 86400;
const BASE_RT_COST = 0.0014;
const STRESS_RT_COST = 0.0022;
const ADVERSE_ENTRY_SLIP = 0.00050;
const DISC_FROM = Date.UTC(2025, 8, 1) / 1000;
const DISC_TO = Date.UTC(2026, 2, 1) / 1000;
const VAL_TO = Date.UTC(2026, 5, 1) / 1000;
const EVAL_TO = Date.UTC(2026, 8, 1) / 1000;

const LEADERS = ['BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'BASKET'];
const LEADER_COINS = ['BTC_USDT', 'ETH_USDT', 'SOL_USDT'];
const LOOK_BARS = [1, 3, 6];
const IMPULSES = [0.0025, 0.0040, 0.0060];
const LAG_MAX = [0.00, 0.25, 0.50];
const BREADTH_MIN = [0.40, 0.60];
const DEPTHS = [1, 2, 3];
const HOLDS = [1, 3, 6];
const MIN_RATIO = -0.50;

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const median = (xs) => {
  const ys = [...xs].sort((a, b) => a - b);
  if (!ys.length) return 0;
  const m = Math.floor(ys.length / 2);
  return ys.length % 2 ? ys[m] : (ys[m - 1] + ys[m]) / 2;
};
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

const datasets = DATA.datasets ?? [];
const symbols = datasets.map((d) => d.symbol);
if (symbols.length < 15) throw new Error(`Need >=15 symbols, got ${symbols.length}`);
for (const s of LEADER_COINS) if (!symbols.includes(s)) throw new Error(`Missing leader ${s}`);

const maps = new Map();
for (const d of datasets) maps.set(d.symbol, new Map(d.rows.map((r) => [r.time, r])));
const times = datasets.find((d) => d.symbol === 'BTC_USDT').rows.map((r) => r.time)
  .filter((t) => t >= DISC_FROM - 12 * STEP && t < EVAL_TO);

function ret(symbol, t, bars) {
  const m = maps.get(symbol);
  const a = m.get(t - bars * STEP)?.open;
  const b = m.get(t)?.open;
  if (![a, b].every((v) => Number.isFinite(v) && v > 0)) return null;
  return b / a - 1;
}

function leaderRet(leader, t, bars) {
  if (leader !== 'BASKET') return ret(leader, t, bars);
  const rs = LEADER_COINS.map((s) => ret(s, t, bars)).filter(Number.isFinite);
  return rs.length === LEADER_COINS.length ? median(rs) : null;
}

const impulseCache = new Map();
for (const leader of LEADERS) {
  for (const bars of LOOK_BARS) {
    const key = `${leader}:${bars}`;
    const out = [];
    for (const t of times) {
      if (t < DISC_FROM || t + 7 * STEP >= EVAL_TO) continue;
      const lr = leaderRet(leader, t, bars);
      if (!Number.isFinite(lr) || Math.abs(lr) < Math.min(...IMPULSES)) continue;
      const dir = Math.sign(lr);
      if (!dir) continue;
      const excluded = leader === 'BASKET' ? new Set(LEADER_COINS) : new Set([leader]);
      const rows = [];
      let aligned = 0;
      let valid = 0;
      for (const symbol of symbols) {
        if (excluded.has(symbol)) continue;
        const r = ret(symbol, t, bars);
        if (!Number.isFinite(r)) continue;
        const ratio = dir * r / Math.abs(lr);
        valid += 1;
        if (dir * r > 0) aligned += 1;
        if (ratio >= MIN_RATIO && ratio <= Math.max(...LAG_MAX)) rows.push({ symbol, ratio });
      }
      if (valid < 12) continue;
      rows.sort((a, b) => a.ratio - b.ratio || a.symbol.localeCompare(b.symbol));
      out.push({ signalAt: t, leaderRet: lr, absLeader: Math.abs(lr), direction: dir, breadth: aligned / valid, rows });
    }
    impulseCache.set(key, out);
  }
}

function rawTrade(symbol, direction, entryAt, exitAt) {
  const m = maps.get(symbol);
  const e0 = m.get(entryAt)?.open;
  const x = m.get(exitAt)?.open;
  if (![e0, x].every((v) => Number.isFinite(v) && v > 0)) return null;
  const gross = direction > 0 ? x / e0 - 1 : 1 - x / e0;
  const adverseEntry = direction > 0 ? e0 * (1 + ADVERSE_ENTRY_SLIP) : e0 * (1 - ADVERSE_ENTRY_SLIP);
  const adverseGross = direction > 0 ? x / adverseEntry - 1 : 1 - x / adverseEntry;
  return { gross, base: gross - BASE_RT_COST, stress: gross - STRESS_RT_COST, adverse: adverseGross - BASE_RT_COST };
}

function buildTrades(c) {
  const source = impulseCache.get(`${c.leader}:${c.lookBars}`) ?? [];
  const busy = new Map();
  const out = [];
  for (const e of source) {
    if (e.absLeader < c.impulse || e.breadth < c.breadthMin) continue;
    const picks = e.rows.filter((x) => x.ratio <= c.lagMax).slice(0, c.depth);
    for (const p of picks) {
      const entryAt = e.signalAt + STEP;
      const exitAt = entryAt + c.holdBars * STEP;
      if (exitAt > EVAL_TO) continue;
      if ((busy.get(p.symbol) ?? 0) > entryAt) continue;
      const rr = rawTrade(p.symbol, e.direction, entryAt, exitAt);
      if (!rr) continue;
      out.push({ symbol: p.symbol, signalAt: e.signalAt, entryAt, exitAt, month: monthKey(entryAt), ratio: p.ratio, ...rr });
      busy.set(p.symbol, exitAt);
    }
  }
  return out;
}

function stats(rows, from, to, field = 'stress') {
  const xs = rows.filter((x) => x.entryAt >= from && x.exitAt <= to);
  const days = (to - from) / DAY;
  const net = sum(xs.map((x) => x[field]));
  const gains = sum(xs.filter((x) => x[field] > 0).map((x) => x[field]));
  const losses = Math.abs(sum(xs.filter((x) => x[field] <= 0).map((x) => x[field])));
  const monthly = monthKeys(from, to).map((month) => {
    const ys = xs.filter((x) => x.month === month);
    const v = sum(ys.map((x) => x[field]));
    return { month, events: ys.length, net: v, positive: v > 0 };
  });
  return {
    events: xs.length,
    eventsPerDay: days ? xs.length / days : 0,
    net,
    avgNet: xs.length ? net / xs.length : 0,
    pf: losses ? gains / losses : gains ? 99 : 0,
    winRate: xs.length ? xs.filter((x) => x[field] > 0).length / xs.length : 0,
    positiveMonths: monthly.filter((m) => m.positive).length,
    monthly,
  };
}

function maxConcurrency(rows, from, to) {
  const points = [];
  for (const x of rows) {
    if (x.entryAt < from || x.exitAt > to) continue;
    points.push([x.entryAt, 1], [x.exitAt, -1]);
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let n = 0; let best = 0;
  for (const [, d] of points) { n += d; best = Math.max(best, n); }
  return best;
}

function scaledPath(rows, from, to, field, size) {
  const xs = rows.filter((x) => x.entryAt >= from && x.exitAt <= to).sort((a, b) => a.exitAt - b.exitAt || a.symbol.localeCompare(b.symbol));
  let equity = 1; let peak = 1; let minEquity = 1; let maxDD = 0;
  for (const x of xs) {
    equity += size * x[field];
    peak = Math.max(peak, equity);
    minEquity = Math.min(minEquity, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }
  return { finalEquity: equity, minEquity, maxDrawdownAbs: maxDD, survived: minEquity > 0 };
}

const candidates = [];
let id = 0;
for (const leader of LEADERS) for (const lookBars of LOOK_BARS) for (const impulse of IMPULSES)
for (const lagMax of LAG_MAX) for (const breadthMin of BREADTH_MIN) for (const depth of DEPTHS) for (const holdBars of HOLDS) {
  const c = { id: `P5-${id++}`, leader, lookBars, impulse, lagMax, breadthMin, depth, holdBars };
  const trades = buildTrades(c);
  const discovery = { stress: stats(trades, DISC_FROM, DISC_TO), adverse: stats(trades, DISC_FROM, DISC_TO, 'adverse') };
  const validation = { stress: stats(trades, DISC_TO, VAL_TO), adverse: stats(trades, DISC_TO, VAL_TO, 'adverse') };
  const sampleEnough = discovery.stress.events >= 300 && validation.stress.events >= 150;
  const bothStressPositive = discovery.stress.net >= 0 && validation.stress.net >= 0;
  const bothAdversePositive = discovery.adverse.net >= 0 && validation.adverse.net >= 0;
  const edgeFloor = sampleEnough && bothStressPositive && bothAdversePositive;
  const minFreq = Math.min(discovery.stress.eventsPerDay, validation.stress.eventsPerDay);
  const requiredSizeFor5x = minFreq > 0 ? 5 / (2 * minFreq) : null;
  const maxConc = Math.max(maxConcurrency(trades, DISC_FROM, DISC_TO), maxConcurrency(trades, DISC_TO, VAL_TO));
  const requiredGrossFor5x = requiredSizeFor5x == null ? null : requiredSizeFor5x * maxConc;
  const d5 = requiredSizeFor5x == null ? null : scaledPath(trades, DISC_FROM, DISC_TO, 'stress', requiredSizeFor5x);
  const v5 = requiredSizeFor5x == null ? null : scaledPath(trades, DISC_TO, VAL_TO, 'stress', requiredSizeFor5x);
  const d5a = requiredSizeFor5x == null ? null : scaledPath(trades, DISC_FROM, DISC_TO, 'adverse', requiredSizeFor5x);
  const v5a = requiredSizeFor5x == null ? null : scaledPath(trades, DISC_TO, VAL_TO, 'adverse', requiredSizeFor5x);
  const viable5x = edgeFloor && requiredSizeFor5x <= 0.15 && requiredGrossFor5x <= 2.5
    && d5?.minEquity > 0.20 && v5?.minEquity > 0.20 && d5a?.minEquity > 0.20 && v5a?.minEquity > 0.20;
  const minPf = Math.min(discovery.stress.pf, validation.stress.pf);
  const score = (edgeFloor ? 1000 : 0) + (viable5x ? 10000 : 0) + minPf * 100 + Math.min(100, minFreq)
    - (requiredGrossFor5x ?? 99) * 2;
  candidates.push({ c, discovery, validation, sampleEnough, bothStressPositive, bothAdversePositive, edgeFloor,
    minFreq, requiredSizeFor5x, maxConcurrency: maxConc, requiredGrossFor5x, fiveXPaths: { discovery: d5, validation: v5, discoveryAdverse: d5a, validationAdverse: v5a }, viable5x, score });
}

const diagnosticPool = candidates.filter((x) => x.sampleEnough);
const edge = candidates.filter((x) => x.edgeFloor).sort((a, b) => b.score - a.score);
const viable = candidates.filter((x) => x.viable5x).sort((a, b) => b.score - a.score);
const selected = (viable[0] ?? edge[0] ?? null);
let evaluationOpened = false;
let evaluation = null;
if (selected) {
  evaluationOpened = true;
  const trades = buildTrades(selected.c);
  const stress = stats(trades, VAL_TO, EVAL_TO);
  const adverse = stats(trades, VAL_TO, EVAL_TO, 'adverse');
  const size = selected.requiredSizeFor5x;
  evaluation = {
    config: selected.c,
    stress,
    adverse,
    fiveX: size == null ? null : {
      size,
      turnoverTarget: 5,
      maxConcurrency: maxConcurrency(trades, VAL_TO, EVAL_TO),
      grossNeeded: size * maxConcurrency(trades, VAL_TO, EVAL_TO),
      stressPath: scaledPath(trades, VAL_TO, EVAL_TO, 'stress', size),
      adversePath: scaledPath(trades, VAL_TO, EVAL_TO, 'adverse', size),
    },
  };
}

const byLeader = Object.fromEntries(LEADERS.map((leader) => {
  const xs = diagnosticPool.filter((x) => x.c.leader === leader);
  const best = [...xs].sort((a, b) => b.score - a.score)[0] ?? null;
  return [leader, {
    configs: xs.length,
    bothStressPositive: xs.filter((x) => x.bothStressPositive).length,
    bothAdversePositive: xs.filter((x) => x.bothAdversePositive).length,
    edgeFloor: xs.filter((x) => x.edgeFloor).length,
    viable5x: xs.filter((x) => x.viable5x).length,
    best,
  }];
}));

const topNear = [...diagnosticPool].sort((a, b) => b.score - a.score).slice(0, 20);
const result = {
  research: '5m-propagation-turnover-v1',
  objective: 'find a genuine short-horizon leader-impulse -> laggard-catchup edge whose natural event density can support about 5x initial-equity daily round-trip turnover without large per-trade sizing',
  protocol: {
    periods: { discovery: [DISC_FROM, DISC_TO], validation: [DISC_TO, VAL_TO], evaluation: [VAL_TO, EVAL_TO] },
    symbols,
    configs: candidates.length,
    leaders: LEADERS,
    lookBars: LOOK_BARS,
    impulses: IMPULSES,
    lagMax: LAG_MAX,
    breadthMin: BREADTH_MIN,
    depths: DEPTHS,
    holdBars: HOLDS,
    minRatio: MIN_RATIO,
    execution: 'all features known at 5m open t; execute at next 5m open t+1; same-symbol overlap forbidden within each config',
    costs: { baseRoundTrip: BASE_RT_COST, stressRoundTrip: STRESS_RT_COST, adverseEntrySlip: ADVERSE_ENTRY_SLIP },
    turnover: 'genuine entry+exit notional only; 5x sizing = 5 / (2 * minimum discovery/validation events-per-day); no self-trade/order splitting',
    evaluationGate: 'evaluation is opened only for one config frozen from discovery+validation if the same rule is non-negative under both stress and adverse assumptions',
  },
  diagnostics: {
    configs: candidates.length,
    diagnosticPool: diagnosticPool.length,
    discoveryStressPositive: diagnosticPool.filter((x) => x.discovery.stress.net >= 0).length,
    validationStressPositive: diagnosticPool.filter((x) => x.validation.stress.net >= 0).length,
    bothStressPositive: diagnosticPool.filter((x) => x.bothStressPositive).length,
    bothAdversePositive: diagnosticPool.filter((x) => x.bothAdversePositive).length,
    edgeFloor: edge.length,
    viable5x: viable.length,
    evaluationOpened,
  },
  byLeader,
  selected,
  evaluation,
  viable: viable.slice(0, 20),
  edge: edge.slice(0, 20),
  topNear,
};
writeFileSync(OUTPUT, `${JSON.stringify(result)}\n`);
console.log(`PROPAGATION_5M_TURNOVER=${JSON.stringify(result)}`);
