import { readFileSync, writeFileSync } from 'node:fs';

const EXEC_PATH = process.env.RESEARCH_EXECUTION_DATASET ?? '/tmp/gate-history-44m-5m.json';
const SIGNAL_1H_PATH = process.env.RESEARCH_SIGNAL_1H_DATASET ?? '/tmp/gate-history-44m-from5m-1h.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/robust-mother-timescale-compression.json';
const BASE_FRICTION = 0.0014;
const STRESS_FRICTION = 0.0022;
const ENTRY_SLIPPAGE = 0.00025;
const INITIAL_EQUITY = 1_000;
const DAY_MS = 86_400_000;

const execRaw = JSON.parse(readFileSync(EXEC_PATH, 'utf8'));
const signal1hRaw = JSON.parse(readFileSync(SIGNAL_1H_PATH, 'utf8'));
if (execRaw.interval !== '5m' || signal1hRaw.interval !== '1h') throw new Error('expected 5m execution + 1h signal datasets');
if (execRaw.months.join() !== signal1hRaw.months.join()) throw new Error('month mismatch');
if (execRaw.symbols.join() !== signal1hRaw.symbols.join()) throw new Error('symbol mismatch');
if (execRaw.months.length !== 44) throw new Error(`expected 44 months, got ${execRaw.months.length}`);

const EXPECTED_EXEC_SHA = '9e5fd7d06eeee420d60318bee72de3b16e7e877247102a2b505453ab0b8a4522';
const EXPECTED_SIGNAL_SHA = '185bd97b968f96373bef6a174c8258d8ad5606a0d1ed824eaa2cc1ace1efa053';
if (execRaw.sha256 !== EXPECTED_EXEC_SHA || signal1hRaw.sha256 !== EXPECTED_SIGNAL_SHA) {
  throw new Error(`dataset hash mismatch exec=${execRaw.sha256} signal=${signal1hRaw.sha256}`);
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const sign = (x) => x > 0 ? 1 : x < 0 ? -1 : 0;
const median = (xs) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};
const monthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1);
const fromMs = execRaw.from * 1_000;
const discoveryEnd = monthStart(execRaw.months[30]);
const validationEnd = monthStart(execRaw.months[38]);
const toMs = execRaw.now * 1_000;
const executionBySymbol = new Map(execRaw.datasets.map((d) => [d.symbol, d.rows]));

function aggregate(rows, stepSeconds) {
  const expected = stepSeconds / 300;
  const minSamples = Math.ceil(expected * 5 / 6);
  const complete = [];
  let bucket = null;
  for (const row of rows) {
    const time = Math.floor(Number(row.time) / stepSeconds) * stepSeconds;
    if (!bucket || bucket.time !== time) {
      if (bucket?.samples >= minSamples) complete.push(bucket);
      bucket = { time, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume), samples: 1 };
    } else {
      bucket.high = Math.max(bucket.high, Number(row.high));
      bucket.low = Math.min(bucket.low, Number(row.low));
      bucket.close = Number(row.close);
      bucket.volume += Number(row.volume);
      bucket.samples += 1;
    }
  }
  if (bucket?.samples >= minSamples) complete.push(bucket);
  const filled = [];
  for (const row of complete) {
    const previous = filled.at(-1);
    const missing = previous ? (row.time - previous.time) / stepSeconds - 1 : 0;
    if (previous && missing > 0 && missing <= 3) {
      for (let k = 1; k <= missing; k += 1) {
        filled.push({ time: previous.time + k * stepSeconds, open: previous.close, high: previous.close,
          low: previous.close, close: previous.close, volume: 0, samples: 0, synthetic: true });
      }
    }
    filled.push(row);
  }
  return filled;
}

const signalDatasetsByStep = new Map();
signalDatasetsByStep.set(3600, signal1hRaw.datasets.map((d) => ({ symbol: d.symbol, rows: d.rows })));
for (const step of [1800, 900]) {
  signalDatasetsByStep.set(step, execRaw.datasets.map((d) => ({ symbol: d.symbol, rows: aggregate(d.rows, step) })));
}

function gapPrefix(rows, stepSeconds) {
  const prefix = [0];
  for (let i = 1; i < rows.length; i += 1) prefix.push(prefix.at(-1) + Number(rows[i].time !== rows[i - 1].time + stepSeconds));
  return prefix;
}
const ret = (rows, index, bars) => rows[index].close / rows[index - bars].close - 1;
const rangeRate = (row) => (row.high - row.low) / Math.max(row.close, 1e-12);

function classify(context, returnScale) {
  const aligned24 = Math.max(context.breadth24, 1 - context.breadth24);
  if (Math.abs(context.median24) >= 0.04 * returnScale
    || (Math.abs(context.median24) >= 0.02 * returnScale && aligned24 >= 0.82)) return 'SHOCK_TRANSITION';
  if (context.compression <= 0.68 && Math.abs(context.median24) < 0.025 * returnScale) return 'COMPRESSION';
  if ((context.median30 >= 0.08 * returnScale && context.median7 >= 0.015 * returnScale && context.breadth30 >= 0.60)
    || (context.median30 <= -0.08 * returnScale && context.median7 <= -0.015 * returnScale && context.breadth30 <= 0.40)) return 'DIRECTIONAL_TREND';
  if (Math.abs(context.median24) >= 0.018 * returnScale || aligned24 >= 0.75) return 'NON_TREND_EXPANSION';
  return 'BALANCED_ROTATION';
}

function buildObservations(stepSeconds, returnScale) {
  const datasets = signalDatasetsByStep.get(stepSeconds);
  const byTime = new Map();
  for (const { symbol, rows } of datasets) {
    const gaps = gapPrefix(rows, stepSeconds);
    for (let index = 720; index < rows.length - 1; index += 1) {
      const current = rows[index];
      if (gaps[index] !== gaps[index - 720] || rows[index + 1].time !== current.time + stepSeconds) continue;
      const currentRanges = rows.slice(index - 5, index + 1).map(rangeRate);
      const baselineRanges = rows.slice(index - 168, index - 6).map(rangeRate);
      const f = { symbol, rows, index, current,
        r6: ret(rows, index, 6), r24: ret(rows, index, 24), r7d: ret(rows, index, 168), r30d: ret(rows, index, 720),
        atr6: median(currentRanges), compression: median(currentRanges) / Math.max(median(baselineRanges), 1e-9) };
      const a = byTime.get(current.time) ?? [];
      a.push(f); byTime.set(current.time, a);
    }
  }
  const out = [];
  for (const [time, rows] of byTime) {
    if (rows.length < Math.max(8, execRaw.symbols.length - 2)) continue;
    const values = (key) => rows.map((r) => r[key]);
    const context = {
      median24: median(values('r24')), median7: median(values('r7d')), median30: median(values('r30d')),
      breadth24: rows.filter((r) => r.r24 > 0).length / rows.length,
      breadth7: rows.filter((r) => r.r7d > 0).length / rows.length,
      breadth30: rows.filter((r) => r.r30d > 0).length / rows.length,
      compression: median(values('compression')), markets: rows.length,
    };
    const system = classify(context, returnScale);
    for (const f of rows) out.push({ ...f, time, context, system, relative7: f.r7d - context.median7 });
  }
  return out;
}

function lowerBound(rows, time) {
  let low = 0; let high = rows.length;
  while (low < high) { const mid = (low + high) >> 1; if (rows[mid].time < time) low = mid + 1; else high = mid; }
  return low;
}

function rawTrades(spec, friction, slippage) {
  const observations = buildObservations(spec.stepSeconds, spec.returnScale);
  const trades = [];
  for (const f of observations) {
    if (f.system !== 'DIRECTIONAL_TREND' || f.time * 1_000 >= toMs) continue;
    const marketDirection = sign(f.context.median30);
    const direction = -marketDirection;
    if (!direction || direction * f.relative7 < 0.03 * spec.returnScale || direction * f.r6 < 0.004 * spec.returnScale) continue;
    const strength = direction * f.relative7 + direction * f.r6;
    const rows = executionBySymbol.get(f.symbol);
    const entryTime = f.rows[f.index + 1].time;
    const index = lowerBound(rows, entryTime);
    if (rows[index]?.time !== entryTime) continue;
    const entry = rows[index].open * (1 + direction * slippage);
    const stopFloor = 0.03 * spec.stopFloorScale;
    const stopRate = Math.min(0.20, Math.max(stopFloor, 5 * f.atr6));
    const targetRate = Math.max(stopRate * 2.2, friction * 2.2);
    const originalStop = entry * (1 - direction * stopRate);
    const target = entry * (1 + direction * targetRate);
    const maxBars = 72 * (spec.stepSeconds / 300);
    let exit = entry; let closedAt = rows[index].time * 1_000; let outcome = 'DATA_GAP';
    for (let offset = 0; offset < maxBars && index + offset < rows.length; offset += 1) {
      const candle = rows[index + offset];
      if (offset && candle.time !== rows[index + offset - 1].time + 300) {
        exit = rows[index + offset - 1].close; closedAt = rows[index + offset - 1].time * 1_000; break;
      }
      const stopped = direction > 0 ? candle.low <= originalStop : candle.high >= originalStop;
      const targeted = direction > 0 ? candle.high >= target : candle.low <= target;
      if (stopped || targeted) {
        exit = stopped ? originalStop : target; closedAt = candle.time * 1_000; outcome = stopped ? 'STOP' : 'TARGET'; break;
      }
      exit = candle.close; closedAt = candle.time * 1_000; outcome = offset === maxBars - 1 ? 'TIMEOUT' : outcome;
    }
    const grossReturnRate = direction * (exit - entry) / entry;
    trades.push({ strategyId: spec.id, symbol: f.symbol, side: direction > 0 ? 'LONG' : 'SHORT',
      openedAt: rows[index].time * 1_000, closedAt, stopRate, friction, strength, outcome,
      grossReturnRate, netReturnRate: grossReturnRate - friction });
  }
  trades.sort((a, b) => a.openedAt - b.openedAt || b.strength - a.strength);
  return trades;
}

function portfolio(spec, trades) {
  let equity = INITIAL_EQUITY; let peak = equity; let maxDrawdown = 0;
  const open = []; const accepted = []; const cooldown = new Map();
  const settle = (time) => {
    for (const trade of open.filter((t) => t.closedAt <= time).sort((a, b) => a.closedAt - b.closedAt)) {
      equity += trade.netPnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-12));
      open.splice(open.indexOf(trade), 1);
      cooldown.set(trade.symbol, trade.closedAt + 24 * spec.stepSeconds * 1_000);
    }
  };
  for (let i = 0; i < trades.length;) {
    const openedAt = trades[i].openedAt; settle(openedAt);
    const simultaneous = [];
    while (i < trades.length && trades[i].openedAt === openedAt) simultaneous.push(trades[i++]);
    for (const trade of simultaneous.sort((a, b) => b.strength - a.strength || a.symbol.localeCompare(b.symbol))) {
      if (equity <= 100 || open.some((row) => row.symbol === trade.symbol) || (cooldown.get(trade.symbol) ?? 0) > trade.openedAt) continue;
      const sameSide = open.filter((row) => row.side === trade.side);
      const multiple = Math.min(0.5, 0.015 / Math.max(trade.stopRate + trade.friction, 1e-9));
      if (multiple < 0.05) continue;
      const notional = equity * multiple;
      const plannedRisk = notional * (trade.stopRate + trade.friction);
      if (sum(open.map((row) => row.plannedRisk)) + plannedRisk > equity * 0.10
        || sum(sameSide.map((row) => row.plannedRisk)) + plannedRisk > equity * 0.065) continue;
      const acceptedTrade = { ...trade, equityAtOpen: equity, notional, plannedRisk, netPnl: notional * trade.netReturnRate };
      open.push(acceptedTrade); accepted.push(acceptedTrade);
    }
  }
  settle(Infinity);
  return { trades: accepted, endEquity: equity, maxDrawdown };
}

function metrics(result, start, end) {
  const rows = result.trades.filter((t) => t.openedAt >= start && t.openedAt < end);
  const gains = rows.filter((t) => t.netPnl > 0); const losses = rows.filter((t) => t.netPnl <= 0);
  let equity = INITIAL_EQUITY; let peak = equity; let maxDrawdown = 0;
  for (const trade of [...rows].sort((a, b) => a.closedAt - b.closedAt)) {
    equity += trade.netPnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-12));
  }
  const months = execRaw.months.flatMap((month) => {
    const a = monthStart(month); const b = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)), 1);
    if (a < start || b > end) return [];
    const m = rows.filter((t) => t.openedAt >= a && t.openedAt < b);
    return m.length ? [{ month, pnl: sum(m.map((t) => t.netPnl)), trades: m.length }] : [];
  });
  return { trades: rows.length, netPnl: sum(rows.map((t) => t.netPnl)),
    profitFactor: losses.length ? sum(gains.map((t) => t.netPnl)) / Math.abs(sum(losses.map((t) => t.netPnl))) : gains.length ? 99 : 0,
    maxDrawdown, activeMonths: months.length, positiveMonths: months.filter((m) => m.pnl > 0).length };
}

function exposure(result, start, end) {
  const changes = [];
  for (const t of result.trades) {
    const fraction = t.notional / Math.max(t.equityAtOpen, 1e-12);
    const dir = t.side === 'LONG' ? 1 : -1;
    if (t.openedAt >= start && t.openedAt < end) changes.push({ time: t.openedAt, symbol: t.symbol, delta: dir * fraction });
    if (t.closedAt >= start && t.closedAt < end) changes.push({ time: t.closedAt, symbol: t.symbol, delta: -dir * fraction });
  }
  const grouped = new Map();
  for (const x of changes) {
    const key = `${x.time}|${x.symbol}`; grouped.set(key, (grouped.get(key) ?? 0) + x.delta);
  }
  const netChanges = [...grouped.entries()].map(([key, delta]) => {
    const i = key.indexOf('|'); return { time: Number(key.slice(0, i)), symbol: key.slice(i + 1), delta };
  }).sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
  const days = Math.max(1e-9, (end - start) / DAY_MS);
  const turnoverPerDay = sum(netChanges.map((x) => Math.abs(x.delta))) / days;
  const positions = new Map(); let peakGross = 0; let i = 0;
  while (i < netChanges.length) {
    const time = netChanges[i].time;
    while (i < netChanges.length && netChanges[i].time === time) {
      const x = netChanges[i++]; positions.set(x.symbol, (positions.get(x.symbol) ?? 0) + x.delta);
    }
    peakGross = Math.max(peakGross, sum([...positions.values()].map(Math.abs)));
  }
  const entries = result.trades.filter((t) => t.openedAt >= start && t.openedAt < end).length;
  return { turnoverPerDay, entriesPerDay: entries / days, peakGross };
}

const specs = [
  { id: 'BASE_1H', stepSeconds: 3600, returnScale: 1, stopFloorScale: 1, normalization: 'frozen-original' },
  { id: 'FIXED_30M', stepSeconds: 1800, returnScale: 1, stopFloorScale: 1, normalization: 'fixed-return-thresholds' },
  { id: 'SQRT_30M', stepSeconds: 1800, returnScale: Math.sqrt(0.5), stopFloorScale: Math.sqrt(0.5), normalization: 'sqrt-time-return-and-stop-floor' },
  { id: 'FIXED_15M', stepSeconds: 900, returnScale: 1, stopFloorScale: 1, normalization: 'fixed-return-thresholds' },
  { id: 'SQRT_15M', stepSeconds: 900, returnScale: 0.5, stopFloorScale: 0.5, normalization: 'sqrt-time-return-and-stop-floor' },
];

const expectedBaselineStress = {
  discovery: { trades: 405, netPnl: 51.32916758231005, profitFactor: 1.0272665070296876 },
  validation: { trades: 110, netPnl: 63.98045967877867, profitFactor: 1.0966418747416167 },
  evaluation: { trades: 45, netPnl: 238.7399157602952, profitFactor: 2.771265720593711 },
};
const periods = { discovery: [fromMs, discoveryEnd], validation: [discoveryEnd, validationEnd], evaluation: [validationEnd, toMs], full: [fromMs, toMs] };

function evaluate(spec) {
  const paths = {};
  for (const [name, friction, slip] of [['base', BASE_FRICTION, ENTRY_SLIPPAGE], ['stress', STRESS_FRICTION, ENTRY_SLIPPAGE], ['adverse', BASE_FRICTION, ENTRY_SLIPPAGE * 2]]) {
    const account = portfolio(spec, rawTrades(spec, friction, slip));
    paths[name] = { endEquity: account.endEquity, maxDrawdown: account.maxDrawdown,
      periods: Object.fromEntries(Object.entries(periods).map(([key, [a, b]]) => [key, { ...metrics(account, a, b), ...exposure(account, a, b) }])) };
  }
  const s = paths.stress.periods; const a = paths.adverse.periods;
  const preQualified = s.discovery.trades >= 40 && s.validation.trades >= 20
    && s.discovery.netPnl > 0 && s.validation.netPnl > 0
    && s.discovery.profitFactor >= 1 && s.validation.profitFactor >= 1
    && a.discovery.netPnl > 0 && a.validation.netPnl > 0;
  const evaluationSurvivor = preQualified && s.evaluation.netPnl > 0 && s.evaluation.profitFactor >= 1 && a.evaluation.netPnl > 0;
  return { spec, preQualified, evaluationSurvivor, paths };
}

const evaluated = specs.map(evaluate);
const baseline = evaluated.find((x) => x.spec.id === 'BASE_1H');
const close = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;
const parity = Object.fromEntries(['discovery','validation','evaluation'].map((p) => [p, {
  trades: baseline.paths.stress.periods[p].trades === expectedBaselineStress[p].trades,
  netPnl: close(baseline.paths.stress.periods[p].netPnl, expectedBaselineStress[p].netPnl, 1e-5),
  profitFactor: close(baseline.paths.stress.periods[p].profitFactor, expectedBaselineStress[p].profitFactor, 1e-8),
  actual: baseline.paths.stress.periods[p], expected: expectedBaselineStress[p],
}]));
const parityValid = Object.values(parity).every((x) => x.trades && x.netPnl && x.profitFactor);
if (!parityValid) throw new Error(`BASE_1H parity failed: ${JSON.stringify(parity)}`);

const baseTurnover = baseline.paths.stress.periods.full.turnoverPerDay;
for (const row of evaluated) row.turnoverGainVs1h = row.paths.stress.periods.full.turnoverPerDay / Math.max(baseTurnover, 1e-12);
const compressedSurvivors = evaluated.filter((x) => x.spec.id !== 'BASE_1H' && x.evaluationSurvivor);
const decision = compressedSurvivors.length ? 'COMPRESSED_ROBUST_MOTHER_SURVIVOR' : 'COMPRESSED_ROBUST_MOTHER_REJECTED';

const report = {
  research: 'robust-positive-mother-timescale-compression-v1',
  authority: 'RESEARCH_ONLY_NO_DEPLOYMENT',
  decision,
  hypothesis: 'test whether a 44-month cross-period positive 1h mother strategy preserves after-cost edge when its entire bar-count geometry is compressed to 30m/15m, increasing independent decision opportunities without leverage or threshold relaxation',
  mother: { id: 'directional_trend-defensive_relative-5', system: 'DIRECTIONAL_TREND', tactic: 'DEFENSIVE_RELATIVE',
    frozen1h: { relative7: 0.03, confirm6: 0.004, stopFloor: 0.03, stopAtr: 5, rewardRisk: 2.2, maxHoldBars: 72, cooldownBars: 24 } },
  data: { months: execRaw.months, symbols: execRaw.symbols, executionSha256: execRaw.sha256, signal1hSha256: signal1hRaw.sha256 },
  split: { discovery: execRaw.months.slice(0,30), validation: execRaw.months.slice(30,38), evaluation: execRaw.months.slice(38),
    note: 'evaluation is historical gated evaluation, not project-wide pristine blind OOS' },
  protocol: {
    execution: 'all signals use completed bars; entry is next signal-bar open resolved on exact Gate 5m execution; 5m stop/target path; same-bar stop wins ties',
    timeCompression: '720/168/24/6-bar context, 72-bar max hold and 24-bar cooldown are invariant in bar count; therefore clock horizons compress with 60m->30m->15m',
    normalizationVariants: 'FIXED keeps original percent thresholds; SQRT multiplies return/regime thresholds and stop floor by sqrt(clock-scale). No validation/evaluation tuning.',
    costs: { baseRoundTrip: BASE_FRICTION, stressRoundTrip: STRESS_FRICTION, adverseEntryExtra: ENTRY_SLIPPAGE },
    sizing: 'same frozen 1.5% planned-risk rate, 0.5x notional cap, 10% aggregate planned-risk cap, 6.5% same-side planned-risk cap; no leverage scaling to force turnover',
    acceptance: 'compressed variant must be stress-positive and doubled-entry-adverse-positive in discovery and validation before evaluation is opened; evaluation survivor must remain positive under both',
    turnover: 'actual signed entry/exit fractions netted by symbol+timestamp before absolute turnover is counted',
  },
  baselineParity: { valid: parityValid, detail: parity },
  evaluated,
  compressedSurvivors: compressedSurvivors.map((x) => x.spec.id),
  nextStep: compressedSurvivors.length ? 'measure correlation and exact netted combined turnover of 1h + surviving compressed sleeves before any broader mother expansion' : 'do not retune this mother on 30m/15m; time-scale compression is not a portable turnover source for this structure',
};
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`ROBUST_MOTHER_TIMESCALE=${JSON.stringify({ decision, parityValid,
  rows: evaluated.map((x) => ({ id: x.spec.id, preQualified: x.preQualified, survivor: x.evaluationSurvivor,
    stress: { discovery: x.paths.stress.periods.discovery, validation: x.paths.stress.periods.validation, evaluation: x.paths.stress.periods.evaluation, full: x.paths.stress.periods.full },
    adverse: { discovery: x.paths.adverse.periods.discovery, validation: x.paths.adverse.periods.validation, evaluation: x.paths.adverse.periods.evaluation },
    turnoverGainVs1h: x.turnoverGainVs1h })) })}`);
