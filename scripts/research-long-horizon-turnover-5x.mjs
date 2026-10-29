import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-21m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/long-horizon-turnover-5x.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 21) throw new Error('Need 21-month aligned Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.00050;

// Frozen from PR #227. No signal parameter is retuned in this stage.
const SIGNAL = Object.freeze({
  lookHours: 72,
  absMove: 0.02,
  marketFilter: 'MEDIAN',
  mode: 'FADE',
  holdHours: 48,
});

// Execution-only sizing frontier. eventGross is one position's entry notional / 1000U reference equity.
const EVENT_GROSS = [0.20, 0.25, 0.30, 0.35, 0.40, 0.50];
const GROSS_CAPS = [3, 4, 5, 6, 8, 10];
const TARGET_TURNOVER = 5;

const OLD_FROM = Date.UTC(2024, 8, 1) / 1000;
const OLD_TO = Date.UTC(2025, 8, 1) / 1000;
const CURRENT_FROM = OLD_TO;
const TRAIN_TO = Date.UTC(2026, 5, 1) / 1000;

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

const rowsBySymbol = new Map(DATA.datasets.map((d) => [d.symbol, [...d.rows].sort((a, b) => a.time - b.time)]));
const symbols = [...rowsBySymbol.keys()];
if (symbols.length < 15) throw new Error(`Only ${symbols.length} symbols; need >=15`);
const rowMap = new Map(symbols.map((s) => [s, new Map(rowsBySymbol.get(s).map((r) => [r.time, r]))]));
const anchor = rowsBySymbol.get('BTC_USDT') ?? rowsBySymbol.values().next().value;
const allTimes = anchor.map((r) => r.time).filter((t) => t >= OLD_FROM && t < TRAIN_TO);

function legReturn(symbol, direction, entryAt, exitAt, slip) {
  const rm = rowMap.get(symbol);
  const entry0 = rm.get(entryAt)?.open;
  const exit = rm.get(exitAt)?.open;
  if (![entry0, exit].every((v) => Number.isFinite(v) && v > 0)) return null;
  const entry = direction > 0 ? entry0 * (1 + slip) : entry0 * (1 - slip);
  return direction > 0 ? exit / entry - 1 : 1 - exit / entry;
}

function buildFrozenEvents() {
  const out = [];
  const busy = new Map();
  for (const t of allTimes) {
    const rows = [];
    for (const symbol of symbols) {
      const rm = rowMap.get(symbol);
      const p0 = rm.get(t - SIGNAL.lookHours * HOUR)?.open;
      const p1 = rm.get(t)?.open;
      if (![p0, p1].every((v) => Number.isFinite(v) && v > 0)) continue;
      const rawRet = p1 / p0 - 1;
      rows.push({ symbol, rawRet });
    }
    if (rows.length < 15) continue;
    const marketRet = median(rows.map((x) => x.rawRet));
    for (const x of rows) {
      if (Math.abs(x.rawRet) < SIGNAL.absMove) continue;
      const signalDirection = Math.sign(x.rawRet);
      if (!signalDirection) continue;
      const aligned = signalDirection > 0 ? marketRet > 0 : marketRet < 0;
      if (!aligned) continue;
      const entryAt = t + HOUR;
      const exitAt = entryAt + SIGNAL.holdHours * HOUR;
      if (exitAt > TRAIN_TO) continue;
      if ((busy.get(x.symbol) ?? 0) > entryAt) continue;
      const direction = -signalDirection; // frozen FADE rule
      const gross = legReturn(x.symbol, direction, entryAt, exitAt, ENTRY_SLIP);
      const adverseGross = legReturn(x.symbol, direction, entryAt, exitAt, ADVERSE_SLIP);
      if (![gross, adverseGross].every(Number.isFinite)) continue;
      out.push({
        symbol: x.symbol,
        signalAt: t,
        entryAt,
        exitAt,
        rawRet: x.rawRet,
        absRawRet: Math.abs(x.rawRet),
        marketRet,
        direction,
        base: gross - BASE_COST,
        stress: gross - STRESS_COST,
        adverse: adverseGross - BASE_COST,
        month: monthKey(entryAt),
      });
      busy.set(x.symbol, exitAt);
    }
  }
  return out.sort((a, b) => a.entryAt - b.entryAt || b.absRawRet - a.absRawRet || a.symbol.localeCompare(b.symbol));
}

const frozenEvents = buildFrozenEvents();

function allocatePeriod(from, to, eventGross, grossCap) {
  const source = frozenEvents.filter((e) => e.entryAt >= from && e.exitAt <= to);
  const byEntry = new Map();
  for (const e of source) {
    if (!byEntry.has(e.entryAt)) byEntry.set(e.entryAt, []);
    byEntry.get(e.entryAt).push(e);
  }
  const active = [];
  const accepted = [];
  let blockedGross = 0;
  let maxConcurrentGross = 0;
  for (const entryAt of [...byEntry.keys()].sort((a, b) => a - b)) {
    for (let i = active.length - 1; i >= 0; i -= 1) {
      if (active[i].exitAt <= entryAt) active.splice(i, 1);
    }
    let activeGross = sum(active.map((x) => x.eventGross));
    const batch = byEntry.get(entryAt).sort((a, b) => b.absRawRet - a.absRawRet || a.symbol.localeCompare(b.symbol));
    for (const e of batch) {
      if (activeGross + eventGross > grossCap + 1e-12) {
        blockedGross += 1;
        continue;
      }
      const row = { ...e, eventGross };
      accepted.push(row);
      active.push(row);
      activeGross += eventGross;
      maxConcurrentGross = Math.max(maxConcurrentGross, activeGross);
    }
  }
  return { sourceEvents: source.length, accepted, blockedGross, maxConcurrentGross };
}

function portfolioStats(allocated, from, to, field) {
  const xs = allocated.accepted;
  const days = (to - from) / DAY;
  const pnls = xs.map((e) => e[field] * e.eventGross);
  const gains = sum(pnls.filter((x) => x > 0));
  const losses = Math.abs(sum(pnls.filter((x) => x <= 0)));
  const net = sum(pnls);
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let minEquity = 1;
  for (const e of [...xs].sort((a, b) => a.exitAt - b.exitAt || a.symbol.localeCompare(b.symbol))) {
    equity += e[field] * e.eventGross;
    peak = Math.max(peak, equity);
    minEquity = Math.min(minEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const turnover = sum(xs.map((e) => 2 * e.eventGross));
  const monthly = monthKeys(from, to).map((month) => {
    const rows = xs.filter((e) => e.month === month);
    const monthNet = sum(rows.map((e) => e[field] * e.eventGross));
    return { month, events: rows.length, net: monthNet, positive: monthNet > 0 };
  });
  return {
    events: xs.length,
    eventsPerDay: days ? xs.length / days : 0,
    turnoverPerDay: days ? turnover / days : 0,
    net,
    avgDaily1000U: days ? (net / days) * 1000 : 0,
    avgMonthlyReturn: days ? (net / days) * 30 : 0,
    pf: losses ? gains / losses : gains ? 99 : 0,
    winRate: xs.length ? xs.filter((e) => e[field] > 0).length / xs.length : 0,
    maxDrawdown,
    minEquity,
    maxConcurrentGross: allocated.maxConcurrentGross,
    blockedGross: allocated.blockedGross,
    sourceEvents: allocated.sourceEvents,
    positiveMonths: monthly.filter((m) => m.positive).length,
    monthly,
  };
}

function evaluatePeriod(from, to, c) {
  const allocated = allocatePeriod(from, to, c.eventGross, c.grossCap);
  return {
    stress: portfolioStats(allocated, from, to, 'stress'),
    adverse: portfolioStats(allocated, from, to, 'adverse'),
  };
}

const candidates = [];
let id = 0;
for (const eventGross of EVENT_GROSS) for (const grossCap of GROSS_CAPS) {
  if (eventGross > grossCap) continue;
  const c = { id: `LHT5-${id++}`, eventGross, grossCap };
  const old = evaluatePeriod(OLD_FROM, OLD_TO, c);
  const current = evaluatePeriod(CURRENT_FROM, TRAIN_TO, c);
  const edgeFloor = old.stress.net >= 0 && current.stress.net >= 0
    && old.adverse.net >= 0 && current.adverse.net >= 0;
  const survival = old.stress.minEquity > 0 && current.stress.minEquity > 0
    && old.adverse.minEquity > 0 && current.adverse.minEquity > 0;
  const minTurnover = Math.min(old.stress.turnoverPerDay, current.stress.turnoverPerDay);
  const target5x = minTurnover >= TARGET_TURNOVER;
  const preferredDrawdown = Math.max(old.stress.maxDrawdown, current.stress.maxDrawdown) <= 0.50;
  const score = edgeFloor && survival
    ? minTurnover * (1 + 0.25 * Number(preferredDrawdown)) * Math.min(old.stress.pf, current.stress.pf)
    : -100 + minTurnover;
  candidates.push({ c, old, current, edgeFloor, survival, minTurnover, target5x, preferredDrawdown, score });
}

const viable = candidates.filter((x) => x.edgeFloor && x.survival).sort((a, b) => b.score - a.score);
const target = viable.filter((x) => x.target5x).sort((a, b) => {
  if (a.preferredDrawdown !== b.preferredDrawdown) return Number(b.preferredDrawdown) - Number(a.preferredDrawdown);
  return b.score - a.score;
});
const near = [...candidates].sort((a, b) => {
  const aq = Number(a.edgeFloor) + Number(a.survival);
  const bq = Number(b.edgeFloor) + Number(b.survival);
  return bq - aq || b.minTurnover - a.minTurnover || b.score - a.score;
});

const rawPeriod = (from, to) => {
  const xs = frozenEvents.filter((e) => e.entryAt >= from && e.exitAt <= to);
  return { events: xs.length, eventsPerDay: xs.length / ((to - from) / DAY) };
};

const diagnostics = {
  configs: candidates.length,
  rawFrozenSignal: { old: rawPeriod(OLD_FROM, OLD_TO), current: rawPeriod(CURRENT_FROM, TRAIN_TO) },
  edgeFloor: candidates.filter((x) => x.edgeFloor).length,
  survival: candidates.filter((x) => x.edgeFloor && x.survival).length,
  target5x: target.length,
  target5xPreferredDD50: target.filter((x) => x.preferredDrawdown).length,
  bestViableTurnover: viable[0]?.minTurnover ?? 0,
};

const output = {
  research: 'long-horizon-turnover-5x-v1',
  objective: 'reprice the exact frozen #227 72h ABS_2 MEDIAN FADE 48h signal for genuine ~5x initial-equity round-trip turnover/day; 5x is a target, not a permanent hard gate; stress/adverse non-loss is the floor',
  periods: { old: [OLD_FROM, OLD_TO], currentTrain: [CURRENT_FROM, TRAIN_TO] },
  frozenSignal: SIGNAL,
  protocol: {
    symbols,
    signalRetuned: false,
    evaluationPeriodUsed: false,
    sizingOnlyGrid: { eventGross: EVENT_GROSS, grossCaps: GROSS_CAPS },
    allocation: 'same frozen events; per-symbol overlap remains forbidden by the frozen signal; when portfolio gross cap binds, same-hour entries are admitted by descending absolute 72h move',
    turnoverDefinition: 'entry notional plus exit notional, divided by 1000U reference equity and days; no self-trade, no opposite-position volume, no order splitting',
    costsPerUnitNotional: { base: BASE_COST, stress: STRESS_COST, entrySlip: ENTRY_SLIP, adverseSlip: ADVERSE_SLIP },
    targetTurnoverPerDay: TARGET_TURNOVER,
  },
  diagnostics,
  target5x: target.slice(0, 20),
  viable: viable.slice(0, 20),
  topNear: near.slice(0, 20),
  note: 'The 2026-06..2026-08 period is intentionally excluded because the old #227 script computed it for every candidate, so it is not pristine. If a ~5x sizing candidate is found here, it still requires a separate frozen independent/backward OOS before production consideration.',
};

writeFileSync(OUTPUT, `${JSON.stringify(output)}\n`);
console.log(`LONG_HORIZON_TURNOVER_5X=${JSON.stringify({
  objective: output.objective,
  frozenSignal: SIGNAL,
  protocol: output.protocol,
  diagnostics,
  topTarget: output.target5x.slice(0, 5),
  topViable: output.viable.slice(0, 5),
  topNear: output.topNear.slice(0, 5),
  note: output.note,
})}`);
