import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/positive-edge-turnover-portfolio.json';
const REGIME_REPORT = JSON.parse(readFileSync('research-results/regime-system-portfolios-2026-09-14.json', 'utf8'));
if (DATA.interval !== '1h' || DATA.months?.length !== 24) throw new Error('Need 24-month aligned Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.00050;
const OLD_FROM = Date.UTC(2024, 8, 1) / 1000;
const OLD_TO = Date.UTC(2025, 8, 1) / 1000;
const CURRENT_FROM = OLD_TO;
const TRAIN_TO = Date.UTC(2026, 5, 1) / 1000;
const EVAL_TO = Date.UTC(2026, 8, 1) / 1000;
const CORE = ['BTC_USDT', 'ETH_USDT', 'SOL_USDT'];

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const ys = [...xs].sort((a, b) => a - b);
  const i = Math.floor(ys.length / 2);
  return ys.length % 2 ? ys[i] : (ys[i - 1] + ys[i]) / 2;
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
const pearson = (a, b) => {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const x = a.slice(0, n); const y = b.slice(0, n);
  const mx = sum(x) / n; const my = sum(y) / n;
  let cov = 0; let vx = 0; let vy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i] - mx; const dy = y[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null;
};

const rowsBySymbol = new Map(DATA.datasets.map((d) => [d.symbol, [...d.rows].sort((a, b) => a.time - b.time)]));
const symbols = [...rowsBySymbol.keys()];
if (symbols.length < 15) throw new Error(`Need >=15 symbols, got ${symbols.length}`);
for (const s of CORE) if (!rowsBySymbol.has(s)) throw new Error(`Missing core symbol ${s}`);
const rowMap = new Map(symbols.map((s) => [s, new Map(rowsBySymbol.get(s).map((r) => [r.time, r]))]));
const anchor = rowsBySymbol.get('BTC_USDT') ?? rowsBySymbol.values().next().value;
const allTimes = anchor.map((r) => r.time).filter((t) => t >= OLD_FROM && t < EVAL_TO);

function legReturn(symbol, direction, entryAt, exitAt, slip) {
  const rm = rowMap.get(symbol);
  const e0 = rm.get(entryAt)?.open; const x0 = rm.get(exitAt)?.open;
  if (![e0, x0].every((v) => Number.isFinite(v) && v > 0)) return null;
  const entry = direction > 0 ? e0 * (1 + slip) : e0 * (1 - slip);
  return direction > 0 ? x0 / entry - 1 : 1 - x0 / entry;
}

function finalizeSingleLeg(component, source, direction, entryAt, exitAt, extra = {}) {
  const gross = legReturn(source.symbol, direction, entryAt, exitAt, ENTRY_SLIP);
  const adverseGross = legReturn(source.symbol, direction, entryAt, exitAt, ADVERSE_SLIP);
  if (![gross, adverseGross].every(Number.isFinite)) return null;
  return {
    component, entryAt, exitAt, month: monthKey(entryAt),
    stress: gross - STRESS_COST, adverse: adverseGross - BASE_COST,
    legs: [{ symbol: source.symbol, direction, weight: 1 }], ...extra,
  };
}

// --- Component 1: exact frozen #227/#239 long-horizon route ---
// 72h absolute move >=2%, market-median alignment, FADE, next-hour entry, 48h hold.
function buildLht() {
  const features = [];
  for (const t of allTimes) {
    const rows = [];
    for (const symbol of symbols) {
      const rm = rowMap.get(symbol);
      const p0 = rm.get(t - 72 * HOUR)?.open; const p1 = rm.get(t)?.open;
      if (![p0, p1].every((v) => Number.isFinite(v) && v > 0)) continue;
      rows.push({ symbol, rawRet: p1 / p0 - 1 });
    }
    if (rows.length < 15) continue;
    const marketRet = median(rows.map((x) => x.rawRet));
    for (const x of rows) {
      const direction = Math.sign(x.rawRet);
      if (!direction || Math.abs(x.rawRet) < 0.02 || Math.sign(marketRet) !== direction) continue;
      features.push({ ...x, signalAt: t, direction });
    }
  }
  features.sort((a, b) => a.signalAt - b.signalAt || a.symbol.localeCompare(b.symbol));
  const busy = new Map(); const out = [];
  for (const x of features) {
    const entryAt = x.signalAt + HOUR; const exitAt = entryAt + 48 * HOUR;
    if (exitAt > EVAL_TO || (busy.get(x.symbol) ?? 0) > entryAt) continue;
    const e = finalizeSingleLeg('LHT72_FADE', x, -x.direction, entryAt, exitAt, { strength: Math.abs(x.rawRet) });
    if (!e) continue;
    out.push(e); busy.set(x.symbol, exitAt);
  }
  return out;
}

// --- Component 2: all exact RSB configurations that are stress-positive in BOTH discovery eras. ---
const RSB_LOOKS = [24, 48, 72, 168];
const RSB_HOLDS = [6, 12, 24, 48];
const RSB_PROFILES = [
  { id: 'R15', rankCut: 0.15, minResidual: 0 },
  { id: 'R25', rankCut: 0.25, minResidual: 0 },
  { id: 'R25_R005', rankCut: 0.25, minResidual: 0.005 },
  { id: 'R25_R010', rankCut: 0.25, minResidual: 0.010 },
  { id: 'R35_R010', rankCut: 0.35, minResidual: 0.010 },
  { id: 'R35_R020', rankCut: 0.35, minResidual: 0.020 },
];
const RSB_MODES = ['FOLLOW', 'FADE'];
const RSB_FILTERS = ['NONE', 'MKT_ALIGN', 'BREADTH60', 'DUAL_MKT', 'REL_PERSIST', 'FULL_ALIGN'];

function crossSection(t, look) {
  const rows = [];
  for (const symbol of symbols) {
    const rm = rowMap.get(symbol);
    const p0 = rm.get(t - look * HOUR)?.open; const p1 = rm.get(t)?.open;
    if (![p0, p1].every((v) => Number.isFinite(v) && v > 0)) continue;
    rows.push({ symbol, rawRet: p1 / p0 - 1 });
  }
  if (rows.length < 15) return null;
  const marketRet = median(rows.map((x) => x.rawRet));
  const positiveBreadth = rows.filter((x) => x.rawRet > 0).length / rows.length;
  const negativeBreadth = rows.filter((x) => x.rawRet < 0).length / rows.length;
  const coreRows = rows.filter((x) => CORE.includes(x.symbol));
  if (coreRows.length !== CORE.length) return null;
  const coreMedian = median(coreRows.map((x) => x.rawRet));
  const sorted = [...rows].sort((a, b) => a.rawRet - b.rawRet);
  const rank = new Map(sorted.map((x, i) => [x.symbol, sorted.length === 1 ? 0.5 : i / (sorted.length - 1)]));
  return { rows, marketRet, positiveBreadth, negativeBreadth, coreMedian, rank };
}

const rsbState24 = new Map(); const rsbState72 = new Map();
for (const t of allTimes) {
  const x24 = crossSection(t, 24); const x72 = crossSection(t, 72);
  if (x24) rsbState24.set(t, x24); if (x72) rsbState72.set(t, x72);
}
const rsbFeatures = new Map();
for (const look of RSB_LOOKS) {
  const rows = [];
  for (const t of allTimes) {
    const cs = crossSection(t, look); const s24 = rsbState24.get(t); const s72 = rsbState72.get(t);
    if (!cs || !s24 || !s72) continue;
    const by24 = new Map(s24.rows.map((x) => [x.symbol, x]));
    const by72 = new Map(s72.rows.map((x) => [x.symbol, x]));
    for (const x of cs.rows) {
      const rankPct = cs.rank.get(x.symbol); const r24 = by24.get(x.symbol); const r72 = by72.get(x.symbol);
      if (!Number.isFinite(rankPct) || !r24 || !r72) continue;
      const residual = x.rawRet - cs.marketRet; const direction = Math.sign(residual);
      if (!direction) continue;
      rows.push({ symbol: x.symbol, signalAt: t, rawRet: x.rawRet, marketRet: cs.marketRet, residual, rankPct, direction,
        directionBreadth: direction > 0 ? cs.positiveBreadth : cs.negativeBreadth,
        market24: s24.marketRet, market72: s72.marketRet,
        breadth24: direction > 0 ? s24.positiveBreadth : s24.negativeBreadth,
        breadth72: direction > 0 ? s72.positiveBreadth : s72.negativeBreadth,
        residual24: r24.rawRet - s24.marketRet, residual72: r72.rawRet - s72.marketRet,
        core24: s24.coreMedian, core72: s72.coreMedian });
    }
  }
  rows.sort((a, b) => a.signalAt - b.signalAt || a.symbol.localeCompare(b.symbol)); rsbFeatures.set(look, rows);
}
function rsbProfileOk(p, x) {
  const extreme = x.direction > 0 ? x.rankPct >= 1 - p.rankCut : x.rankPct <= p.rankCut;
  return extreme && Math.abs(x.residual) >= p.minResidual;
}
function rsbStructureOk(filter, x) {
  if (filter === 'NONE') return true;
  const align = (v) => Math.sign(v) === x.direction;
  if (filter === 'MKT_ALIGN') return align(x.marketRet);
  if (filter === 'BREADTH60') return align(x.marketRet) && x.directionBreadth >= 0.60;
  if (filter === 'DUAL_MKT') return align(x.market24) && align(x.market72) && x.breadth24 >= 0.55 && x.breadth72 >= 0.55;
  if (filter === 'REL_PERSIST') return align(x.residual24) && align(x.residual72);
  if (filter === 'FULL_ALIGN') return align(x.market24) && align(x.market72) && x.breadth24 >= 0.55 && x.breadth72 >= 0.55
    && align(x.residual24) && align(x.residual72) && align(x.core24) && align(x.core72);
  return false;
}
const rsbSignalCache = new Map();
function rsbSignals(c) {
  const key = `${c.look}:${c.profileId}:${c.mode}:${c.structureFilter}`;
  if (rsbSignalCache.has(key)) return rsbSignalCache.get(key);
  const p = RSB_PROFILES.find((x) => x.id === c.profileId);
  const rows = (rsbFeatures.get(c.look) ?? []).filter((x) => rsbProfileOk(p, x) && rsbStructureOk(c.structureFilter, x));
  rsbSignalCache.set(key, rows); return rows;
}
function rsbEvents(c) {
  const busy = new Map(); const out = [];
  for (const x of rsbSignals(c)) {
    const entryAt = x.signalAt + HOUR; const exitAt = entryAt + c.hold * HOUR;
    if (exitAt > EVAL_TO || (busy.get(x.symbol) ?? 0) > entryAt) continue;
    const direction = c.mode === 'FOLLOW' ? x.direction : -x.direction;
    const e = finalizeSingleLeg(`RSB:${c.id}`, x, direction, entryAt, exitAt, { strength: Math.abs(x.residual), rsbConfig: c });
    if (!e) continue;
    out.push(e); busy.set(x.symbol, exitAt);
  }
  return out;
}
function simpleStats(rows, from, to, field) {
  const xs = rows.filter((e) => e.entryAt >= from && e.exitAt <= to);
  const gains = sum(xs.filter((e) => e[field] > 0).map((e) => e[field]));
  const losses = Math.abs(sum(xs.filter((e) => e[field] <= 0).map((e) => e[field])));
  return { events: xs.length, net: sum(xs.map((e) => e[field])), pf: losses ? gains / losses : gains ? 99 : 0 };
}
const rsbCrossEra = [];
let rsbId = 0;
for (const look of RSB_LOOKS) for (const profile of RSB_PROFILES) for (const mode of RSB_MODES)
for (const structureFilter of RSB_FILTERS) for (const hold of RSB_HOLDS) {
  const c = { id: `RSB-${rsbId++}`, look, profileId: profile.id, rankCut: profile.rankCut,
    minResidual: profile.minResidual, mode, structureFilter, hold };
  const ev = rsbEvents(c);
  const oldStress = simpleStats(ev, OLD_FROM, OLD_TO, 'stress'); const curStress = simpleStats(ev, CURRENT_FROM, TRAIN_TO, 'stress');
  if (oldStress.events >= 100 && curStress.events >= 75 && oldStress.net > 0 && curStress.net > 0) {
    const oldAdv = simpleStats(ev, OLD_FROM, OLD_TO, 'adverse'); const curAdv = simpleStats(ev, CURRENT_FROM, TRAIN_TO, 'adverse');
    rsbCrossEra.push({ c, ev, oldStress, curStress, oldAdv, curAdv });
  }
}
// Combine the already-discovered cross-era-positive RSB pockets without using evaluation to choose among them.
const rsbBuckets = new Map();
for (const q of rsbCrossEra) for (const e of q.ev) {
  const key = `${e.legs[0].symbol}:${e.entryAt}`;
  if (!rsbBuckets.has(key)) { rsbBuckets.set(key, e); continue; }
  const prev = rsbBuckets.get(key);
  if (prev === null) continue;
  if (prev.legs[0].direction !== e.legs[0].direction) { rsbBuckets.set(key, null); continue; }
  if ((e.strength ?? 0) > (prev.strength ?? 0)) rsbBuckets.set(key, e);
}
const RSB_EVENTS = [...rsbBuckets.values()].filter(Boolean).map((e) => ({ ...e, component: 'RSB_CROSS_ERA' }))
  .sort((a, b) => a.entryAt - b.entryAt || a.legs[0].symbol.localeCompare(b.legs[0].symbol));

// --- Component 3: exact frozen PRM-753 from #236 ---
function intervalResidual(a, b, t, hours, beta) {
  const am = rowMap.get(a); const bm = rowMap.get(b);
  const a0 = am.get(t - hours * HOUR)?.close; const a1 = am.get(t)?.close;
  const b0 = bm.get(t - hours * HOUR)?.close; const b1 = bm.get(t)?.close;
  if (![a0, a1, b0, b1].every((v) => Number.isFinite(v) && v > 0)) return null;
  return Math.log(a1 / a0) - beta * Math.log(b1 / b0);
}
function prmFeature(a, b, t) {
  const window = 336; const am = rowMap.get(a); const bm = rowMap.get(b);
  let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
  for (let k = window; k >= 1; k -= 1) {
    const a0 = am.get(t - k * HOUR)?.close; const a1 = am.get(t - (k - 1) * HOUR)?.close;
    const b0 = bm.get(t - k * HOUR)?.close; const b1 = bm.get(t - (k - 1) * HOUR)?.close;
    if (![a0, a1, b0, b1].every((v) => Number.isFinite(v) && v > 0)) return null;
    const x = Math.log(a1 / a0); const y = Math.log(b1 / b0);
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  const n = window; const mx = sx / n; const my = sy / n;
  const vx = Math.max(0, sxx / n - mx * mx); const vy = Math.max(0, syy / n - my * my); const cov = sxy / n - mx * my;
  if (!(vx > 1e-12) || !(vy > 1e-12)) return null;
  const corr = cov / Math.sqrt(vx * vy); const beta = cov / vy;
  if (!Number.isFinite(corr) || !Number.isFinite(beta) || beta < 0.25 || beta > 4) return null;
  const residualVar = Math.max(1e-12, vx + beta * beta * vy - 2 * beta * cov);
  const z = (sx - beta * sy) / Math.sqrt(residualVar * n);
  const r24 = intervalResidual(a, b, t, 24, beta);
  return Number.isFinite(z) && Number.isFinite(r24) ? { a, b, signalAt: t, corr, beta, z, absZ: Math.abs(z), r24 } : null;
}
function buildPrm() {
  const byTime = new Map();
  for (const t of allTimes) {
    if (new Date(t * 1000).getUTCHours() % 6 !== 0 || t < OLD_FROM + 336 * HOUR) continue;
    const rows = [];
    for (let i = 0; i < symbols.length; i += 1) for (let j = i + 1; j < symbols.length; j += 1) {
      const f = prmFeature(symbols[i], symbols[j], t); if (f) rows.push(f);
    }
    if (rows.length) byTime.set(t, rows);
  }
  const busy = new Map(); const out = [];
  for (const [signalAt, rows] of byTime) {
    const entryAt = signalAt + HOUR; const exitAt = entryAt + 24 * HOUR;
    if (exitAt > EVAL_TO) continue;
    const eligible = rows.filter((f) => f.corr >= 0.50 && f.absZ >= 2 && Math.sign(f.r24) === Math.sign(f.z) && Math.abs(f.r24) > 1e-6)
      .sort((x, y) => y.absZ - x.absZ || y.corr - x.corr);
    for (const f of eligible) {
      if ((busy.get(f.a) ?? 0) > entryAt || (busy.get(f.b) ?? 0) > entryAt) continue;
      const dirA = f.z > 0 ? 1 : -1; const dirB = -dirA; const betaAbs = Math.abs(f.beta);
      const wA = 1 / (1 + betaAbs); const wB = betaAbs / (1 + betaAbs);
      const aBase = legReturn(f.a, dirA, entryAt, exitAt, ENTRY_SLIP); const bBase = legReturn(f.b, dirB, entryAt, exitAt, ENTRY_SLIP);
      const aAdv = legReturn(f.a, dirA, entryAt, exitAt, ADVERSE_SLIP); const bAdv = legReturn(f.b, dirB, entryAt, exitAt, ADVERSE_SLIP);
      if (![aBase, bBase, aAdv, bAdv].every(Number.isFinite)) continue;
      out.push({ component: 'PRM753', entryAt, exitAt, month: monthKey(entryAt),
        stress: wA * aBase + wB * bBase - STRESS_COST,
        adverse: wA * aAdv + wB * bAdv - BASE_COST,
        legs: [{ symbol: f.a, direction: dirA, weight: wA }, { symbol: f.b, direction: dirB, weight: wB }], strength: f.absZ });
      busy.set(f.a, exitAt); busy.set(f.b, exitAt); break; // frozen depth=1
    }
  }
  return out;
}

const LHT_EVENTS = buildLht();
const PRM_EVENTS = buildPrm();
const COMPONENTS = { LHT72_FADE: LHT_EVENTS, RSB_CROSS_ERA: RSB_EVENTS, PRM753: PRM_EVENTS };

function componentStats(rows, from, to) {
  const xs = rows.filter((e) => e.entryAt >= from && e.exitAt <= to); const days = (to - from) / DAY;
  const one = (field) => {
    const gains = sum(xs.filter((e) => e[field] > 0).map((e) => e[field]));
    const losses = Math.abs(sum(xs.filter((e) => e[field] <= 0).map((e) => e[field])));
    return { events: xs.length, eventsPerDay: days ? xs.length / days : 0, net: sum(xs.map((e) => e[field])),
      pf: losses ? gains / losses : gains ? 99 : 0 };
  };
  return { stress: one('stress'), adverse: one('adverse') };
}

function simulate(scales, from, to, field) {
  const events = [];
  for (const [component, rows] of Object.entries(COMPONENTS)) {
    const scale = scales[component] ?? 0;
    if (!(scale > 0)) continue;
    for (const e of rows) if (e.entryAt >= from && e.exitAt <= to) events.push({ e, scale, component });
  }
  const pnlByTime = new Map(); const deltas = new Map();
  let logicalGrossTurnover = 0;
  for (const { e, scale } of events) {
    pnlByTime.set(e.exitAt, (pnlByTime.get(e.exitAt) ?? 0) + scale * e[field]);
    for (const leg of e.legs) {
      const notional = scale * leg.weight; logicalGrossTurnover += 2 * notional;
      for (const [t, d] of [[e.entryAt, leg.direction * notional], [e.exitAt, -leg.direction * notional]]) {
        const key = `${t}:${leg.symbol}`; deltas.set(key, (deltas.get(key) ?? 0) + d);
      }
    }
  }
  const byTime = new Map();
  for (const [key, delta] of deltas) {
    const i = key.indexOf(':'); const t = Number(key.slice(0, i)); const symbol = key.slice(i + 1);
    const rows = byTime.get(t) ?? []; rows.push({ symbol, delta }); byTime.set(t, rows);
  }
  const exposures = new Map(); let netTurnover = 0; let maxGross = 0;
  for (const t of [...byTime.keys()].sort((a, b) => a - b)) {
    for (const { symbol, delta } of byTime.get(t)) {
      netTurnover += Math.abs(delta);
      const next = (exposures.get(symbol) ?? 0) + delta;
      if (Math.abs(next) < 1e-12) exposures.delete(symbol); else exposures.set(symbol, next);
    }
    maxGross = Math.max(maxGross, sum([...exposures.values()].map(Math.abs)));
  }
  let equity = 1; let peak = 1; let minEquity = 1; let maxDrawdown = 0;
  for (const t of [...pnlByTime.keys()].sort((a, b) => a - b)) {
    equity += pnlByTime.get(t); peak = Math.max(peak, equity); minEquity = Math.min(minEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-9));
  }
  const days = (to - from) / DAY;
  return { events: events.length, net: equity - 1, finalEquity: equity, minEquity, maxDrawdown, survived: minEquity > 0,
    turnoverPerDay: days ? netTurnover / days : 0,
    logicalGrossTurnoverPerDay: days ? logicalGrossTurnover / days : 0,
    nettingRetention: logicalGrossTurnover > 0 ? netTurnover / logicalGrossTurnover : 1,
    maxGross };
}

const LHT_SCALES = [0, 0.025, 0.05, 0.075, 0.10, 0.125, 0.15, 0.175, 0.20, 0.225, 0.25];
const RSB_SCALES = [0, 0.025, 0.05, 0.075, 0.10, 0.125, 0.15, 0.175, 0.20, 0.225, 0.25];
const PRM_SCALES = [0, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.75, 1.00];
const variants = [];
for (const lht of LHT_SCALES) for (const rsb of RSB_SCALES) for (const prm of PRM_SCALES) {
  if ([lht, rsb, prm].filter((x) => x > 0).length < 2) continue;
  const scales = { LHT72_FADE: lht, RSB_CROSS_ERA: rsb, PRM753: prm };
  const oldStress = simulate(scales, OLD_FROM, OLD_TO, 'stress'); const oldAdv = simulate(scales, OLD_FROM, OLD_TO, 'adverse');
  const curStress = simulate(scales, CURRENT_FROM, TRAIN_TO, 'stress'); const curAdv = simulate(scales, CURRENT_FROM, TRAIN_TO, 'adverse');
  const floor = oldStress.net >= 0 && curStress.net >= 0 && oldAdv.net >= 0 && curAdv.net >= 0
    && oldStress.survived && curStress.survived && oldAdv.survived && curAdv.survived;
  const minTurnover = Math.min(oldStress.turnoverPerDay, curStress.turnoverPerDay);
  const worstDd = Math.max(oldStress.maxDrawdown, curStress.maxDrawdown, oldAdv.maxDrawdown, curAdv.maxDrawdown);
  const maxGross = Math.max(oldStress.maxGross, curStress.maxGross, oldAdv.maxGross, curAdv.maxGross);
  variants.push({ scales, floor, minTurnover, worstDd, maxGross, oldStress, oldAdv, curStress, curAdv,
    target5x: floor && minTurnover >= 5 });
}
const floorVariants = variants.filter((v) => v.floor);
const target5x = floorVariants.filter((v) => v.target5x).sort((a, b) => a.worstDd - b.worstDd || a.maxGross - b.maxGross);
const bestByDd = (cap) => floorVariants.filter((v) => v.worstDd <= cap)
  .sort((a, b) => b.minTurnover - a.minTurnover || a.worstDd - b.worstDd)[0] ?? null;
const closest5 = [...floorVariants].sort((a, b) => Math.abs(a.minTurnover - 5) - Math.abs(b.minTurnover - 5)
  || a.worstDd - b.worstDd || a.maxGross - b.maxGross)[0] ?? null;
const lowestRisk5 = target5x[0] ?? null;
const selectedForEvaluation = [lowestRisk5, bestByDd(0.20), bestByDd(0.30), bestByDd(0.50), closest5]
  .filter(Boolean).filter((x, i, a) => a.findIndex((y) => JSON.stringify(y.scales) === JSON.stringify(x.scales)) === i);
const evaluations = selectedForEvaluation.map((v) => ({ scales: v.scales,
  stress: simulate(v.scales, TRAIN_TO, EVAL_TO, 'stress'), adverse: simulate(v.scales, TRAIN_TO, EVAL_TO, 'adverse') }));

function componentMonthly(rows, field = 'stress') {
  return Object.fromEntries(monthKeys(OLD_FROM, EVAL_TO).map((m) => [m,
    sum(rows.filter((e) => e.month === m).map((e) => e[field]))]));
}
const monthlyByComponent = Object.fromEntries(Object.entries(COMPONENTS).map(([k, rows]) => [k, componentMonthly(rows)]));
const regimeMonthlyRows = REGIME_REPORT?.candidateCombined?.higherCost?.monthly ?? [];
const regimeMonthly = new Map(regimeMonthlyRows.map((x) => [x.month, x.pnl]));
const overlapMonths = monthKeys(OLD_FROM, EVAL_TO).filter((m) => regimeMonthly.has(m));
const correlations = {};
for (const [component, monthly] of Object.entries(monthlyByComponent)) {
  correlations[`${component}:REGIME_CORE_PROXY`] = pearson(overlapMonths.map((m) => monthly[m] ?? 0), overlapMonths.map((m) => regimeMonthly.get(m) ?? 0));
}
for (const a of Object.keys(monthlyByComponent)) for (const b of Object.keys(monthlyByComponent)) {
  if (a >= b) continue;
  correlations[`${a}:${b}`] = pearson(overlapMonths.map((m) => monthlyByComponent[a][m] ?? 0), overlapMonths.map((m) => monthlyByComponent[b][m] ?? 0));
}

const componentEvidence = Object.fromEntries(Object.entries(COMPONENTS).map(([name, rows]) => [name, {
  old: componentStats(rows, OLD_FROM, OLD_TO), current: componentStats(rows, CURRENT_FROM, TRAIN_TO),
  evaluation: componentStats(rows, TRAIN_TO, EVAL_TO),
}]));
const regimeCoreProxy = {
  source: 'committed research-results/regime-system-portfolios-2026-09-14.json',
  higherCost: {
    netPnlU: REGIME_REPORT?.candidateCombined?.higherCost?.netPnlU ?? null,
    maxDrawdown: REGIME_REPORT?.candidateCombined?.higherCost?.maxDrawdown ?? null,
    discovery: REGIME_REPORT?.candidateCombined?.higherCost?.discovery ?? null,
    validation: REGIME_REPORT?.candidateCombined?.higherCost?.validation ?? null,
    evaluation: REGIME_REPORT?.candidateCombined?.higherCost?.evaluation ?? null,
  },
  turnoverCountedInOptimizer: false,
  reason: 'The production five-regime replay uses 5m execution and equity/risk-sized notionals; this 1h inventory does not invent a normalized turnover number. Its monthly higher-cost PnL is used only for correlation context.',
};
const satelliteEvidence = { trades: 99, netPnlUAcrossFive1000UAccounts: 156.95, pf: 1.351, maxDrawdown: 0.0229,
  higherCostPf: 1.310, turnoverCountedInOptimizer: false, source: 'merged PR #217 release evidence' };

const report = {
  research: 'positive-edge-turnover-portfolio-v1',
  objective: 'inventory previously discovered cross-era after-cost positive edges and test whether genuine netted turnover can approach 5x/day through combination rather than forcing one signal to carry all volume',
  data: { sha256: DATA.sha256, symbols, months: DATA.months },
  protocol: {
    frozenResearchComponents: {
      LHT72_FADE: 'exact #227/#239: 72h ABS>=2%, MEDIAN alignment, FADE, next-hour entry, 48h hold',
      RSB_CROSS_ERA: 'all #233-family configs re-identified using discovery periods only where the same exact rule is stress-positive in both eras; combined by same-symbol/time dedup without consulting evaluation',
      PRM753: 'exact #236: 336h pair window, corr>=0.50, |z|>=2, 24h residual-sign persistence, 24h hold, depth1 continuation',
    },
    costs: { baseRoundTrip: BASE_COST, stressRoundTrip: STRESS_COST, adverseEntrySlip: ADVERSE_SLIP },
    turnover: 'actual signed-notional changes are netted by symbol and timestamp before absolute turnover is counted; simultaneous opposing logical orders cannot manufacture volume',
    pnl: 'logical component PnL is additive at each component scale; discovery floor requires stress and adverse non-loss in both 2024-09..2025-08 and 2025-09..2026-05 plus positive equity path',
    production: 'current five-regime monthly higher-cost PnL is included for correlation context but its turnover is conservatively excluded from the 5x optimizer rather than guessed',
    evaluation: '2026-06..2026-08 is reported only after portfolio scales are chosen from the two discovery eras. This is historical/gated evaluation, not project-wide pristine blind data.',
  },
  inventory: {
    rsbCrossEraCount: rsbCrossEra.length,
    rsbConfigs: rsbCrossEra.map((x) => ({ c: x.c, oldStress: x.oldStress, currentStress: x.curStress, oldAdverse: x.oldAdv, currentAdverse: x.curAdv })),
    componentEvidence, regimeCoreProxy, satelliteEvidence, correlations,
  },
  portfolioSearch: {
    variants: variants.length, floorVariants: floorVariants.length, target5xCount: target5x.length,
    lowestRisk5x: lowestRisk5,
    bestUnder20pctDd: bestByDd(0.20), bestUnder30pctDd: bestByDd(0.30), bestUnder50pctDd: bestByDd(0.50), closestTo5x: closest5,
    evaluation: evaluations,
  },
  limitations: [
    'LHT evaluation was already touched by its legacy source research; PRM evaluation was previously opened; the combined evaluation is not a new blind holdout.',
    'Realized drawdown is measured on closed-event equity, consistent with the prior research family, and is not a guarantee of intratrade live drawdown.',
    'Production regime turnover is deliberately not added to the target because its exact risk-sized 5m execution notionals are not normalized by this 1h script.',
  ],
};
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`POSITIVE_EDGE_TURNOVER_PORTFOLIO=${JSON.stringify({
  objective: report.objective,
  rsbCrossEraCount: report.inventory.rsbCrossEraCount,
  componentEvidence,
  correlations,
  search: { variants: variants.length, floorVariants: floorVariants.length, target5xCount: target5x.length,
    lowestRisk5x: lowestRisk5, bestUnder20pctDd: bestByDd(0.20), bestUnder30pctDd: bestByDd(0.30),
    bestUnder50pctDd: bestByDd(0.50), closestTo5x: closest5, evaluation: evaluations },
  productionTurnoverConservativelyExcluded: true,
})}`);
