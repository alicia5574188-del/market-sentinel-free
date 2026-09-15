import { readFileSync, writeFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(process.env.RESEARCH_DATASET ?? '/tmp/gate-price-24m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/compression-breakout-cross-era.json';
if (DATA.interval !== '1h' || DATA.months?.length !== 24) throw new Error('Need 24-month aligned Gate 1h dataset');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const ENTRY_SLIP = 0.00025;
const ADVERSE_SLIP = 0.00050;
const LONG_RANGE_HOURS = 72;
const VOLUME_BASELINE_HOURS = 24;

const RANGE_LOOKS = [12, 24, 48];
const COMPRESSION_LOOKS = [6, 12];
const COMPRESSION_RATIOS = [0.65, 0.80, 0.95];
const BREAKOUT_BUFFERS_ATR = [0, 0.25];
const CLOSE_STRENGTHS = [0.65, 0.80];
const VOLUME_RATIOS = [0.80, 1.20];
const CONFIRMATIONS = ['NONE', 'SOFT', 'STRONG'];
const HOLDS = [2, 4, 8, 12];

const OLD_FROM = Date.UTC(2024, 8, 1) / 1000;
const OLD_TO = Date.UTC(2025, 8, 1) / 1000;
const CURRENT_FROM = OLD_TO;
const TRAIN_TO = Date.UTC(2026, 5, 1) / 1000;
const EVAL_TO = Date.UTC(2026, 8, 1) / 1000;

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

const rowsBySymbol = new Map(DATA.datasets.map((d) => [d.symbol, d.rows]));
const symbols = [...rowsBySymbol.keys()];
if (symbols.length < 15) throw new Error(`Only ${symbols.length} symbols; need >=15`);
const rowMap = new Map(symbols.map((s) => [s, new Map(rowsBySymbol.get(s).map((r) => [r.time, r]))]));
const allTimes = [...new Set(symbols.flatMap((s) => rowsBySymbol.get(s).map((r) => r.time)))]
  .sort((a, b) => a - b)
  .filter((t) => t >= OLD_FROM - 96 * HOUR && t < EVAL_TO);

// Cross-sectional confirmation is based only on each completed signal bar.
const breadthMap = new Map();
for (const t of allTimes) {
  const rets = [];
  for (const symbol of symbols) {
    const r = rowMap.get(symbol).get(t);
    if (!r || !(r.open > 0) || !Number.isFinite(r.close)) continue;
    rets.push(r.close / r.open - 1);
  }
  if (rets.length < 15) continue;
  const marketRet = median(rets);
  breadthMap.set(t, {
    marketRet,
    positiveBreadth: rets.filter((x) => x > 0).length / rets.length,
    negativeBreadth: rets.filter((x) => x < 0).length / rets.length,
  });
}

const featureMap = new Map();
for (const rangeLook of RANGE_LOOKS) {
  for (const compressionLook of COMPRESSION_LOOKS) {
    const features = [];
    for (const symbol of symbols) {
      const rm = rowMap.get(symbol);
      for (const t of allTimes) {
        if (t < OLD_FROM) continue;
        const current = rm.get(t);
        if (!current || ![current.open, current.close, current.high, current.low, current.volume].every(Number.isFinite)
          || current.open <= 0 || current.high < current.low) continue;
        const priorRangeBars = [];
        for (let k = 1; k <= rangeLook; k += 1) {
          const r = rm.get(t - k * HOUR);
          if (!r) { priorRangeBars.length = 0; break; }
          priorRangeBars.push(r);
        }
        if (priorRangeBars.length !== rangeLook) continue;
        const priorHigh = Math.max(...priorRangeBars.map((r) => r.high));
        const priorLow = Math.min(...priorRangeBars.map((r) => r.low));
        const rawDirection = current.close > priorHigh ? 1 : current.close < priorLow ? -1 : 0;
        if (!rawDirection) continue;

        const longBars = [];
        for (let k = 1; k <= LONG_RANGE_HOURS; k += 1) {
          const r = rm.get(t - k * HOUR);
          if (!r || !(r.open > 0) || !Number.isFinite(r.high) || !Number.isFinite(r.low)) { longBars.length = 0; break; }
          longBars.push(r);
        }
        if (longBars.length !== LONG_RANGE_HOURS) continue;
        const longRange = median(longBars.map((r) => (r.high - r.low) / r.open));
        const shortRange = median(longBars.slice(0, compressionLook).map((r) => (r.high - r.low) / r.open));
        if (!(longRange > 0) || !(shortRange >= 0)) continue;
        const compressionRatio = shortRange / longRange;

        const volumeBars = longBars.slice(0, VOLUME_BASELINE_HOURS);
        const volumeBaseline = median(volumeBars.map((r) => r.volume).filter((v) => Number.isFinite(v) && v >= 0));
        if (!(volumeBaseline > 0)) continue;
        const volumeRatio = current.volume / volumeBaseline;
        const candleRange = current.high - current.low;
        const closeLocation = candleRange > 0 ? (current.close - current.low) / candleRange : 0.5;
        const breakoutDistance = rawDirection > 0
          ? (current.close - priorHigh) / current.open
          : (priorLow - current.close) / current.open;
        const breadth = breadthMap.get(t);
        if (!breadth) continue;
        features.push({
          symbol,
          barStart: t,
          decisionAt: t + HOUR,
          direction: rawDirection,
          rangeLook,
          compressionLook,
          compressionRatio,
          longRange,
          breakoutDistance,
          closeLocation,
          volumeRatio,
          marketRet: breadth.marketRet,
          directionBreadth: rawDirection > 0 ? breadth.positiveBreadth : breadth.negativeBreadth,
        });
      }
    }
    features.sort((a, b) => a.decisionAt - b.decisionAt || a.symbol.localeCompare(b.symbol));
    featureMap.set(`${rangeLook}:${compressionLook}`, features);
  }
}

function confirmationOk(kind, x) {
  if (kind === 'NONE') return true;
  const marketAligned = x.direction > 0 ? x.marketRet > 0 : x.marketRet < 0;
  if (!marketAligned) return false;
  if (kind === 'SOFT') return x.directionBreadth >= 0.55;
  if (kind === 'STRONG') return x.directionBreadth >= 0.65 && Math.abs(x.marketRet) >= 0.001;
  return false;
}

const signalCache = new Map();
function signalsFor(config) {
  const key = `${config.rangeLook}:${config.compressionLook}:${config.compressionRatio}:${config.breakoutBufferAtr}:${config.closeStrength}:${config.volumeRatio}:${config.confirmation}`;
  if (signalCache.has(key)) return signalCache.get(key);
  const source = featureMap.get(`${config.rangeLook}:${config.compressionLook}`) ?? [];
  const rows = source.filter((x) => x.compressionRatio <= config.compressionRatio
    && x.breakoutDistance >= config.breakoutBufferAtr * x.longRange
    && (x.direction > 0 ? x.closeLocation >= config.closeStrength : x.closeLocation <= 1 - config.closeStrength)
    && x.volumeRatio >= config.volumeRatio
    && confirmationOk(config.confirmation, x));
  signalCache.set(key, rows);
  return rows;
}

function legReturn(symbol, direction, entryAt, exitAt, slip) {
  const rm = rowMap.get(symbol);
  const entry0 = rm.get(entryAt)?.open;
  const exit = rm.get(exitAt)?.open;
  if (![entry0, exit].every((v) => Number.isFinite(v) && v > 0)) return null;
  const entry = direction > 0 ? entry0 * (1 + slip) : entry0 * (1 - slip);
  return direction > 0 ? exit / entry - 1 : 1 - exit / entry;
}

function events(config) {
  const rows = signalsFor(config);
  const out = [];
  const busy = new Map();
  for (const x of rows) {
    const entryAt = x.decisionAt;
    const exitAt = entryAt + config.hold * HOUR;
    if (exitAt > EVAL_TO) continue;
    if ((busy.get(x.symbol) ?? 0) > entryAt) continue;
    const gross = legReturn(x.symbol, x.direction, entryAt, exitAt, ENTRY_SLIP);
    const adverseGross = legReturn(x.symbol, x.direction, entryAt, exitAt, ADVERSE_SLIP);
    if (![gross, adverseGross].every(Number.isFinite)) continue;
    out.push({
      ...x,
      entryAt,
      exitAt,
      hold: config.hold,
      thresholdCompressionRatio: config.compressionRatio,
      breakoutBufferAtr: config.breakoutBufferAtr,
      closeStrength: config.closeStrength,
      minVolumeRatio: config.volumeRatio,
      confirmation: config.confirmation,
      gross,
      base: gross - BASE_COST,
      stress: gross - STRESS_COST,
      adverse: adverseGross - BASE_COST,
      orderLegs: 1,
      month: monthKey(entryAt),
    });
    busy.set(x.symbol, exitAt);
  }
  return out;
}

function stats(rows, from, to, field = 'base') {
  const xs = rows.filter((e) => e.entryAt >= from && e.exitAt <= to);
  const gains = sum(xs.filter((e) => e[field] > 0).map((e) => e[field]));
  const losses = Math.abs(sum(xs.filter((e) => e[field] <= 0).map((e) => e[field])));
  const net = sum(xs.map((e) => e[field]));
  const days = (to - from) / DAY;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const e of [...xs].sort((a, b) => a.exitAt - b.exitAt || a.symbol.localeCompare(b.symbol))) {
    equity += e[field];
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const netPerDay = days ? net / days : 0;
  return {
    events: xs.length,
    independentEventsPerDay: days ? xs.length / days : 0,
    orderLegEntriesPerDay: days ? xs.length / days : 0,
    net,
    netPerDay,
    net1000At1x: net * 1000,
    avgDaily1000At1x: netPerDay * 1000,
    requiredLeverageFor50UDay: netPerDay > 0 ? 0.05 / netPerDay : null,
    avgNet: xs.length ? net / xs.length : 0,
    pf: losses ? gains / losses : gains ? 99 : 0,
    winRate: xs.length ? xs.filter((e) => e[field] > 0).length / xs.length : 0,
    maxDrawdown,
    maxDrawdown1000At1x: maxDrawdown * 1000,
    avgGross: xs.length ? sum(xs.map((e) => e.gross)) / xs.length : 0,
  };
}

function monthly(rows, from, to, field = 'stress') {
  return monthKeys(from, to).map((month) => {
    const xs = rows.filter((e) => e.month === month && e.entryAt >= from && e.exitAt <= to);
    const net = sum(xs.map((e) => e[field]));
    return { month, events: xs.length, net, positive: net > 0 };
  });
}

const candidates = [];
let id = 0;
for (const rangeLook of RANGE_LOOKS) for (const compressionLook of COMPRESSION_LOOKS) for (const compressionRatio of COMPRESSION_RATIOS) for (const breakoutBufferAtr of BREAKOUT_BUFFERS_ATR) for (const closeStrength of CLOSE_STRENGTHS) for (const volumeRatio of VOLUME_RATIOS) for (const confirmation of CONFIRMATIONS) for (const hold of HOLDS) {
  const c = { id: `CB-${id++}`, rangeLook, compressionLook, compressionRatio, breakoutBufferAtr, closeStrength, volumeRatio, confirmation, hold };
  const ev = events(c);
  const old = {
    base: stats(ev, OLD_FROM, OLD_TO),
    stress: stats(ev, OLD_FROM, OLD_TO, 'stress'),
    adverse: stats(ev, OLD_FROM, OLD_TO, 'adverse'),
  };
  const currentTrain = {
    base: stats(ev, CURRENT_FROM, TRAIN_TO),
    stress: stats(ev, CURRENT_FROM, TRAIN_TO, 'stress'),
    adverse: stats(ev, CURRENT_FROM, TRAIN_TO, 'adverse'),
  };
  const evaluation = {
    base: stats(ev, TRAIN_TO, EVAL_TO),
    stress: stats(ev, TRAIN_TO, EVAL_TO, 'stress'),
    adverse: stats(ev, TRAIN_TO, EVAL_TO, 'adverse'),
  };
  const oldMonthly = monthly(ev, OLD_FROM, OLD_TO);
  const currentTrainMonthly = monthly(ev, CURRENT_FROM, TRAIN_TO);
  const oldPositiveMonths = oldMonthly.filter((x) => x.positive).length;
  const currentTrainPositiveMonths = currentTrainMonthly.filter((x) => x.positive).length;
  const minFreq = Math.min(old.stress.independentEventsPerDay, currentTrain.stress.independentEventsPerDay);
  const sampleEnough = old.stress.events >= 80 && currentTrain.stress.events >= 60;
  const discoveryRobust = sampleEnough
    && old.stress.net > 0
    && currentTrain.stress.net > 0
    && old.adverse.net > 0
    && currentTrain.adverse.net > 0
    && old.stress.pf >= 1.03
    && currentTrain.stress.pf >= 1.03
    && oldPositiveMonths >= 7
    && currentTrainPositiveMonths >= 5;
  const eligible = discoveryRobust && minFreq >= 8;
  const targetFrequencyQualified = discoveryRobust && minFreq >= 12;
  const minPf = Math.min(old.stress.pf, currentTrain.stress.pf);
  const minAvg = Math.min(old.stress.avgNet, currentTrain.stress.avgNet);
  const positiveRatio = ((oldPositiveMonths / 12) + (currentTrainPositiveMonths / 9)) / 2;
  const adverseMargin = Math.min(old.adverse.avgNet, currentTrain.adverse.avgNet);
  const score = minPf * Math.sqrt(Math.max(0.01, minFreq))
    * (1 + Math.max(-0.5, Math.min(2, minAvg * 1000)))
    * (0.5 + positiveRatio)
    * (1 + Math.max(-0.25, Math.min(1, adverseMargin * 500)));
  candidates.push({ c, old, currentTrain, evaluation, oldPositiveMonths, currentTrainPositiveMonths, oldMonthly, currentTrainMonthly, discoveryRobust, eligible, targetFrequencyQualified, score });
}

const diagnosticPool = candidates.filter((x) => x.old.base.events >= 80 && x.currentTrain.base.events >= 60);
const discoveryRobust = candidates.filter((x) => x.discoveryRobust).sort((a, b) => b.score - a.score);
const eligible = candidates.filter((x) => x.eligible).sort((a, b) => b.score - a.score);
const targetFrequencyQualified = candidates.filter((x) => x.targetFrequencyQualified).sort((a, b) => b.score - a.score);
const topNear = [...diagnosticPool].sort((a, b) => b.score - a.score).slice(0, 50);

const groupSummary = (field, values) => Object.fromEntries(values.map((value) => {
  const xs = diagnosticPool.filter((x) => x.c[field] === value);
  const best = [...xs].sort((a, b) => b.score - a.score)[0];
  return [String(value), {
    configs: xs.length,
    oldStressPositive: xs.filter((x) => x.old.stress.net > 0).length,
    currentTrainStressPositive: xs.filter((x) => x.currentTrain.stress.net > 0).length,
    bothStressPositive: xs.filter((x) => x.old.stress.net > 0 && x.currentTrain.stress.net > 0).length,
    bothAdversePositive: xs.filter((x) => x.old.adverse.net > 0 && x.currentTrain.adverse.net > 0).length,
    discoveryRobust: xs.filter((x) => x.discoveryRobust).length,
    target12PerDay: xs.filter((x) => x.targetFrequencyQualified).length,
    best: best ? { c: best.c, score: best.score, old: best.old, currentTrain: best.currentTrain, evaluation: best.evaluation } : null,
  }];
}));

const diagnostics = {
  allSignalHours: allTimes.filter((t) => t >= OLD_FROM).length,
  breakoutFeatures: Object.fromEntries([...featureMap.entries()].map(([k, v]) => [k, v.length])),
  signalCaches: signalCache.size,
  candidates: candidates.length,
  eventfulConfigs: candidates.filter((x) => x.old.base.events + x.currentTrain.base.events + x.evaluation.base.events > 0).length,
  diagnosticPool: diagnosticPool.length,
  oldStressPositive: diagnosticPool.filter((x) => x.old.stress.net > 0).length,
  currentTrainStressPositive: diagnosticPool.filter((x) => x.currentTrain.stress.net > 0).length,
  bothStressPositive: diagnosticPool.filter((x) => x.old.stress.net > 0 && x.currentTrain.stress.net > 0).length,
  bothAdversePositive: diagnosticPool.filter((x) => x.old.adverse.net > 0 && x.currentTrain.adverse.net > 0).length,
  discoveryRobust: discoveryRobust.length,
  eligible8PerDay: eligible.length,
  target12PerDay: targetFrequencyQualified.length,
  byConfirmation: groupSummary('confirmation', CONFIRMATIONS),
  byRangeLook: groupSummary('rangeLook', RANGE_LOOKS),
  byCompressionLook: groupSummary('compressionLook', COMPRESSION_LOOKS),
  byHold: groupSummary('hold', HOLDS),
};

// Freeze only from discovery periods. Evaluation never participates in ranking or selection.
const freezePool = eligible.length ? eligible : discoveryRobust;
const frozenRows = [];
const familyKeys = new Set();
for (const x of freezePool) {
  const family = `${x.c.rangeLook}:${x.c.compressionLook}:${x.c.confirmation}:${x.c.hold}`;
  if (familyKeys.has(family)) continue;
  familyKeys.add(family);
  frozenRows.push(x);
  if (frozenRows.length >= 3) break;
}

function combineEvents(rows) {
  const buckets = new Map();
  for (const x of rows) {
    for (const e of events(x.c)) {
      const key = `${e.symbol}:${e.entryAt}`;
      if (!buckets.has(key)) { buckets.set(key, e); continue; }
      const prev = buckets.get(key);
      if (prev === null) continue;
      if (prev.direction !== e.direction) { buckets.set(key, null); continue; }
      if (e.breakoutDistance > prev.breakoutDistance) buckets.set(key, e);
    }
  }
  return [...buckets.values()].filter(Boolean).sort((a, b) => a.entryAt - b.entryAt || a.symbol.localeCompare(b.symbol));
}

const frozenEvents = combineEvents(frozenRows);
const periodResult = (from, to) => ({
  base: stats(frozenEvents, from, to, 'base'),
  stress: stats(frozenEvents, from, to, 'stress'),
  adverse: stats(frozenEvents, from, to, 'adverse'),
});
const results = {
  old: periodResult(OLD_FROM, OLD_TO),
  currentTrain: periodResult(CURRENT_FROM, TRAIN_TO),
  evaluation: periodResult(TRAIN_TO, EVAL_TO),
};

const evaluationRobustRows = frozenRows.filter((x) => x.evaluation.stress.net > 0
  && x.evaluation.adverse.net > 0 && x.evaluation.stress.pf >= 1.0);
const evaluationTargetRows = evaluationRobustRows.filter((x) => x.evaluation.stress.independentEventsPerDay >= 12);

const compact = (x) => ({
  c: x.c,
  old: x.old,
  currentTrain: x.currentTrain,
  evaluation: x.evaluation,
  oldPositiveMonths: x.oldPositiveMonths,
  currentTrainPositiveMonths: x.currentTrainPositiveMonths,
  oldMonthly: x.oldMonthly,
  currentTrainMonthly: x.currentTrainMonthly,
  discoveryRobust: x.discoveryRobust,
  eligible: x.eligible,
  targetFrequencyQualified: x.targetFrequencyQualified,
  score: x.score,
});

const output = {
  periods: {
    old: [OLD_FROM, OLD_TO],
    currentTrain: [CURRENT_FROM, TRAIN_TO],
    evaluation: [TRAIN_TO, EVAL_TO],
  },
  symbols,
  grid: {
    candidates: candidates.length,
    rangeLooksHours: RANGE_LOOKS,
    compressionLooksHours: COMPRESSION_LOOKS,
    compressionRatios: COMPRESSION_RATIOS,
    breakoutBuffersAtr: BREAKOUT_BUFFERS_ATR,
    closeStrengths: CLOSE_STRENGTHS,
    volumeRatios: VOLUME_RATIOS,
    confirmations: CONFIRMATIONS,
    holdsHours: HOLDS,
    longRangeHours: LONG_RANGE_HOURS,
    volumeBaselineHours: VOLUME_BASELINE_HOURS,
  },
  diagnostics,
  eligible: eligible.length,
  targetFrequencyQualified: targetFrequencyQualified.length,
  frozen: frozenRows.map(compact),
  results,
  evaluationRobust: evaluationRobustRows.length,
  evaluationTarget: evaluationTargetRows.length,
  topNear: topNear.map(compact),
  topEligible: eligible.slice(0, 50).map(compact),
  topTargetFrequency: targetFrequencyQualified.slice(0, 50).map(compact),
  note: 'Cross-era compression-to-breakout expansion frontier. Compression uses only prior completed hourly ranges versus a prior 72h range baseline. Breakout is confirmed by the completed signal bar close beyond a prior 12/24/48h high/low, close location, volume, and optional contemporaneous market breadth. Decision occurs only after that bar is complete; entry is the immediately following hourly open. Per-symbol busy windows prevent overlap. Discovery/freeze uses only 2024-09..2025-08 and 2025-09..2026-05. 2026-06..2026-08 is untouched evaluation and never affects selection.',
};
writeFileSync(OUTPUT, `${JSON.stringify(output)}\n`);
console.log(`COMPRESSION_BREAKOUT=${JSON.stringify({
  symbols,
  grid: output.grid,
  diagnostics,
  eligible: output.eligible,
  targetFrequencyQualified: output.targetFrequencyQualified,
  frozen: output.frozen.map((x) => x.c),
  results,
  evaluationRobust: output.evaluationRobust,
  evaluationTarget: output.evaluationTarget,
  topNear: output.topNear.slice(0, 12),
  topEligible: output.topEligible.slice(0, 12),
  topTargetFrequency: output.topTargetFrequency.slice(0, 12),
  note: output.note,
})}`);
