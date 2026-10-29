import { readFileSync, writeFileSync } from 'node:fs';

const SIGNAL_DATASET = process.env.RESEARCH_SIGNAL_DATASET ?? '/tmp/gate-history-anomaly-44m-1h.json';
const EXECUTION_DATASET = process.env.RESEARCH_EXECUTION_DATASET ?? '/tmp/gate-history-anomaly-44m-5m.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/cross-market-anomaly-engine-44m.json';
const FRICTION = Number(process.env.RESEARCH_FRICTION ?? 0.0014);
const STRESS_FRICTION = Number(process.env.RESEARCH_STRESS_FRICTION ?? 0.0022);
const ENTRY_SLIPPAGE = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);

const signalRaw = JSON.parse(readFileSync(SIGNAL_DATASET, 'utf8'));
const executionRaw = JSON.parse(readFileSync(EXECUTION_DATASET, 'utf8'));
if (signalRaw.interval !== '1h' || executionRaw.interval !== '5m' || signalRaw.months.join() !== executionRaw.months.join()) throw new Error('Requires matching 1h signal + 5m execution datasets');
if (signalRaw.months.length !== 44 || signalRaw.symbols.length !== 11) throw new Error('Requires frozen 44m / 11-symbol core universe');

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => xs.length ? sum(xs) / xs.length : 0;
const median = (xs) => { if (!xs.length) return 0; const ys = [...xs].sort((a, b) => a - b); const m = Math.floor(ys.length / 2); return ys.length % 2 ? ys[m] : (ys[m - 1] + ys[m]) / 2; };
const sign = (x) => x > 0 ? 1 : x < 0 ? -1 : 0;
const monthStart = (m) => Date.UTC(Number(m.slice(0, 4)), Number(m.slice(4, 6)) - 1, 1);
const fromMs = signalRaw.from * 1000;
const toMs = signalRaw.now * 1000;
const discoveryEnd = monthStart(signalRaw.months[30]);
const validationEnd = monthStart(signalRaw.months[38]);
const executionBySymbol = new Map(executionRaw.datasets.map((d) => [d.symbol, d.rows]));
const ret = (rows, i, h) => rows[i].close / rows[i - h].close - 1;
const rangeRate = (r) => (r.high - r.low) / Math.max(r.close, 1e-12);
function gapPrefix(rows) { const p = [0]; for (let i = 1; i < rows.length; i += 1) p.push(p.at(-1) + Number(rows[i].time !== rows[i - 1].time + 3600)); return p; }
function lowerBound(rows, time) { let lo = 0, hi = rows.length; while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (rows[mid].time < time) lo = mid + 1; else hi = mid; } return lo; }

// Build synchronized, causal hourly cross-sections. All signal fields use only completed candles.
const byTime = new Map();
for (const { symbol, rows } of signalRaw.datasets) {
  const gaps = gapPrefix(rows);
  for (let i = 168; i < rows.length - 9; i += 1) {
    if (gaps[i] !== gaps[i - 168]) continue;
    if (rows[i + 1].time !== rows[i].time + 3600) continue;
    const ranges = rows.slice(i - 5, i + 1).map(rangeRate);
    const f = {
      symbol, rows, index: i, current: rows[i],
      r1: ret(rows, i, 1), r4: ret(rows, i, 4), r12: ret(rows, i, 12), r24: ret(rows, i, 24),
      prev1: rows[i - 1].close / rows[i - 2].close - 1,
      prev4: rows[i - 1].close / rows[i - 5].close - 1,
      atr6: median(ranges),
    };
    const arr = byTime.get(rows[i].time) ?? []; arr.push(f); byTime.set(rows[i].time, arr);
  }
}

const contexts = [];
for (const [time, rows] of byTime) {
  if (rows.length < 9) continue;
  const c = {
    median1: median(rows.map((r) => r.r1)), median4: median(rows.map((r) => r.r4)),
    median12: median(rows.map((r) => r.r12)), median24: median(rows.map((r) => r.r24)),
    medianPrev1: median(rows.map((r) => r.prev1)), medianPrev4: median(rows.map((r) => r.prev4)),
    breadth1: rows.filter((r) => r.r1 > 0).length / rows.length,
    breadth4: rows.filter((r) => r.r4 > 0).length / rows.length,
  };
  const enriched = rows.map((f) => ({
    ...f,
    relative1: f.r1 - c.median1,
    relative4: f.r4 - c.median4,
    relative1Prev: f.prev1 - c.medianPrev1,
    relative4Prev: f.prev4 - c.medianPrev4,
    context: c,
  }));
  const robustScale4 = Math.max(0.001, median(enriched.map((f) => Math.abs(f.relative4))));
  contexts.push({ time, rows: enriched, context: c, robustScale4 });
}
contexts.sort((a, b) => a.time - b.time);

// “Special” means cross-sectional outlier, not a directional instruction. We retain the most
// exceptional positive and negative relative-4h member per synchronized hour (max two candidates/hour).
function classifyState(e) {
  const p = e.direction * e.f.relative1;
  const pp = e.direction * e.f.relative1Prev;
  const anomalyDelta = e.direction * (e.f.relative4 - e.f.relative4Prev);
  const marketNow = e.direction * e.f.context.median1;
  if (p <= -0.001) {
    if (marketNow >= 0.0005) return 'DIVERGENCE_REV';
    if (marketNow <= -0.0005) return 'MARKET_TURN_REV';
    return 'RELATIVE_FAIL';
  }
  if (pp <= 0 && p >= 0.0015 && anomalyDelta >= 0.001) return 'REACCEL';
  if (p >= 0.0015 && anomalyDelta >= 0.001) return 'EXPANDING';
  if (pp >= 0.002 && p <= pp * 0.5 && anomalyDelta <= 0.0005) return 'DECELERATING';
  return 'NEUTRAL';
}

const events = [];
for (const state of contexts) {
  for (const direction of [1, -1]) {
    const ranked = state.rows
      .filter((f) => direction * f.relative4 > 0)
      .sort((a, b) => direction * (b.relative4 - a.relative4));
    if (!ranked.length) continue;
    const f = ranked[0];
    const magnitude = direction * f.relative4;
    const runnerMagnitude = ranked[1] ? direction * ranked[1].relative4 : 0;
    const event = {
      time: state.time, f, stateRef: state, direction,
      magnitude, runnerGap: Math.max(0, magnitude - runnerMagnitude),
      robustScore: magnitude / state.robustScale4,
      relativePressure: direction * f.relative1,
      previousPressure: direction * f.relative1Prev,
      anomalyDelta: direction * (f.relative4 - f.relative4Prev),
      marketPressure: direction * f.context.median1,
    };
    event.state = classifyState(event);
    events.push(event);
  }
}

const PREDECLARED_SPECIAL = { minAbsRelative4: 0.012, minRobustScore: 1.8, minRunnerGap: 0.002 };
function specialPass(e, cfg = PREDECLARED_SPECIAL) {
  return e.magnitude >= cfg.minAbsRelative4 && e.robustScore >= cfg.minRobustScore && e.runnerGap >= cfg.minRunnerGap;
}

function futureSnapshot(e, h) {
  const f = e.f;
  if (f.index + h >= f.rows.length || f.rows[f.index + h].time !== f.current.time + h * 3600) return null;
  const symbolReturn = f.rows[f.index + h].close / f.current.close - 1;
  const marketReturns = [];
  for (const peer of e.stateRef.rows) {
    if (peer.index + h >= peer.rows.length || peer.rows[peer.index + h].time !== peer.current.time + h * 3600) continue;
    marketReturns.push(peer.rows[peer.index + h].close / peer.current.close - 1);
  }
  if (marketReturns.length < 9) return null;
  const marketReturn = median(marketReturns);
  const relativeFuture = symbolReturn - marketReturn;
  return {
    symbolReturn, marketReturn, relativeFuture,
    continuationRelative: e.direction * relativeFuture,
    reversionRelative: -e.direction * relativeFuture,
    continuationAbsolute: e.direction * symbolReturn,
    reversionAbsolute: -e.direction * symbolReturn,
  };
}

function studyRows(start, end) {
  const selected = events.filter((e) => e.time * 1000 >= start && e.time * 1000 < end && specialPass(e));
  const states = ['EXPANDING', 'REACCEL', 'DECELERATING', 'DIVERGENCE_REV', 'MARKET_TURN_REV', 'RELATIVE_FAIL', 'NEUTRAL'];
  const out = {};
  for (const s of states) {
    const xs = selected.filter((e) => e.state === s);
    const horizons = {};
    for (const h of [1, 2, 4, 8]) {
      const snaps = xs.map((e) => futureSnapshot(e, h)).filter(Boolean);
      horizons[`${h}h`] = {
        samples: snaps.length,
        continuationRelativeMean: mean(snaps.map((x) => x.continuationRelative)),
        reversionRelativeMean: mean(snaps.map((x) => x.reversionRelative)),
        reversionRelativeWinRate: snaps.length ? snaps.filter((x) => x.reversionRelative > 0).length / snaps.length : 0,
        continuationAbsoluteMean: mean(snaps.map((x) => x.continuationAbsolute)),
        reversionAbsoluteMean: mean(snaps.map((x) => x.reversionAbsolute)),
      };
    }
    out[s] = {
      events: xs.length,
      eventsPerDay: xs.length / Math.max(1, (end - start) / 86400000),
      upOutliers: xs.filter((e) => e.direction > 0).length,
      downOutliers: xs.filter((e) => e.direction < 0).length,
      meanMagnitude: mean(xs.map((e) => e.magnitude)),
      meanRobustScore: mean(xs.map((e) => e.robustScore)),
      horizons,
    };
  }
  return out;
}

const COMMON = {
  riskRate: 0.01, notionalMultiple: 0.40, minNotionalMultiple: 0.05,
  stopFloor: 0.025, stopAtr: 3, stopCap: 0.10, rewardRisk: 1.6,
  trailScale: 0.75, maxHoldHours: 12, cooldownHours: 4,
};
const CONFIGS = [
  { ...COMMON, id: 'ADAPTIVE_BASE', family: 'ADAPTIVE', special: PREDECLARED_SPECIAL, states: 'ADAPTIVE' },
  { ...COMMON, id: 'ADAPTIVE_STRICT', family: 'ADAPTIVE', special: { minAbsRelative4: 0.020, minRobustScore: 2.5, minRunnerGap: 0.004 }, states: 'ADAPTIVE' },
  { ...COMMON, id: 'REV_FAILURE', family: 'REVERSAL', special: PREDECLARED_SPECIAL, states: ['DIVERGENCE_REV', 'MARKET_TURN_REV', 'RELATIVE_FAIL'] },
  { ...COMMON, id: 'REV_DECEL_EARLY', family: 'REVERSAL', special: { minAbsRelative4: 0.015, minRobustScore: 2.0, minRunnerGap: 0.002 }, states: ['DECELERATING'] },
  { ...COMMON, id: 'DIVERGENCE_REV_ONLY', family: 'REVERSAL', special: PREDECLARED_SPECIAL, states: ['DIVERGENCE_REV'] },
  { ...COMMON, id: 'CONT_EXPAND', family: 'CONTINUATION', special: PREDECLARED_SPECIAL, states: ['EXPANDING', 'REACCEL'] },
];

function modeFor(config, e) {
  if (!specialPass(e, config.special)) return null;
  if (config.states === 'ADAPTIVE') {
    if (['EXPANDING', 'REACCEL'].includes(e.state)) return 'CONTINUE';
    if (['DIVERGENCE_REV', 'MARKET_TURN_REV', 'RELATIVE_FAIL'].includes(e.state)) return 'REVERSE';
    return null;
  }
  if (!config.states.includes(e.state)) return null;
  return config.family === 'CONTINUATION' ? 'CONTINUE' : 'REVERSE';
}

function candidateSignals(config) {
  return events.flatMap((e) => {
    const mode = modeFor(config, e);
    if (!mode) return [];
    const tradeDirection = mode === 'CONTINUE' ? e.direction : -e.direction;
    const strength = e.robustScore + e.runnerGap * 100 + Math.abs(e.relativePressure) * 50;
    return [{ configId: config.id, e, mode, tradeDirection, strength }];
  }).sort((a, b) => a.e.f.rows[a.e.f.index + 1].time - b.e.f.rows[b.e.f.index + 1].time || b.strength - a.strength);
}

function resolve(config, sig, friction = FRICTION, slippage = ENTRY_SLIPPAGE) {
  const f = sig.e.f;
  const rows = executionBySymbol.get(f.symbol);
  const entryTime = f.rows[f.index + 1].time;
  const index = lowerBound(rows, entryTime);
  if (rows[index]?.time !== entryTime) return null;
  const d = sig.tradeDirection;
  const entry = rows[index].open * (1 + d * slippage);
  const stopRate = Math.min(config.stopCap, Math.max(config.stopFloor, config.stopAtr * f.atr6));
  const originalStop = entry * (1 - d * stopRate);
  const trail = sig.mode === 'CONTINUE';
  const target = trail ? null : entry * (1 + d * Math.max(stopRate * config.rewardRisk, friction * 2.2));
  let activeStop = originalStop, extreme = entry, exit = entry, closedAt = rows[index].time * 1000, outcome = 'DATA_GAP';
  const maxBars = config.maxHoldHours * 12;
  for (let o = 0; o < maxBars && index + o < rows.length; o += 1) {
    const candle = rows[index + o];
    if (o && candle.time !== rows[index + o - 1].time + 300) { exit = rows[index + o - 1].close; closedAt = rows[index + o - 1].time * 1000; outcome = 'DATA_GAP'; break; }
    const stopped = d > 0 ? candle.low <= activeStop : candle.high >= activeStop;
    const targeted = !trail && (d > 0 ? candle.high >= target : candle.low <= target);
    if (stopped || targeted) { exit = stopped ? activeStop : target; closedAt = candle.time * 1000; outcome = stopped ? (activeStop === originalStop ? 'STOP' : 'TRAIL') : 'TARGET'; break; }
    if (trail) {
      extreme = d > 0 ? Math.max(extreme, candle.high) : Math.min(extreme, candle.low);
      const candidate = extreme * (1 - d * stopRate * config.trailScale);
      activeStop = d > 0 ? Math.max(activeStop, candidate) : Math.min(activeStop, candidate);
    }
    exit = candle.close; closedAt = candle.time * 1000; outcome = o === maxBars - 1 ? 'TIMEOUT' : outcome;
  }
  const grossReturnRate = d * (exit - entry) / entry;
  return {
    strategyId: config.id, family: config.family, anomalyState: sig.e.state, anomalyDirection: sig.e.direction,
    mode: sig.mode, symbol: f.symbol, side: d > 0 ? 'LONG' : 'SHORT', openedAt: rows[index].time * 1000, closedAt,
    stopRate, strength: sig.strength, friction, outcome, grossReturnRate, netReturnRate: grossReturnRate - friction,
  };
}

const tradeCache = new Map();
function rawTrades(config, friction = FRICTION, slippage = ENTRY_SLIPPAGE) {
  const key = `${config.id}:${friction}:${slippage}`;
  if (tradeCache.has(key)) return tradeCache.get(key);
  const rows = candidateSignals(config).flatMap((sig) => { const t = resolve(config, sig, friction, slippage); return t ? [t] : []; })
    .sort((a, b) => a.openedAt - b.openedAt || b.strength - a.strength);
  tradeCache.set(key, rows); return rows;
}

function portfolio(trades, configs) {
  let equity = 1000, peak = equity, maxDrawdown = 0;
  const open = [], accepted = [], cooldown = new Map();
  const cfg = new Map(configs.map((c) => [c.id, c]));
  const settle = (time) => {
    for (const t of open.filter((r) => r.closedAt <= time).sort((a, b) => a.closedAt - b.closedAt)) {
      equity += t.netPnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
      open.splice(open.indexOf(t), 1); cooldown.set(`${t.strategyId}:${t.symbol}`, t.closedAt + cfg.get(t.strategyId).cooldownHours * 3600000);
    }
  };
  for (let i = 0; i < trades.length;) {
    const openedAt = trades[i].openedAt; settle(openedAt); const same = [];
    while (i < trades.length && trades[i].openedAt === openedAt) same.push(trades[i++]);
    for (const t of same.sort((a, b) => b.strength - a.strength || a.symbol.localeCompare(b.symbol))) {
      const c = cfg.get(t.strategyId);
      if (equity <= 100 || open.some((r) => r.symbol === t.symbol) || (cooldown.get(`${t.strategyId}:${t.symbol}`) ?? 0) > t.openedAt) continue;
      const sameSide = open.filter((r) => r.side === t.side);
      const multiple = Math.min(c.notionalMultiple, c.riskRate / Math.max(t.stopRate + t.friction, 1e-9));
      if (multiple < c.minNotionalMultiple) continue;
      const notional = equity * multiple, plannedRisk = notional * (t.stopRate + t.friction);
      if (sum(open.map((r) => r.plannedRisk)) + plannedRisk > equity * 0.10) continue;
      if (sum(sameSide.map((r) => r.plannedRisk)) + plannedRisk > equity * 0.065) continue;
      const at = { ...t, equityAtOpen: equity, notional, plannedRisk, netPnl: notional * t.netReturnRate };
      open.push(at); accepted.push(at);
    }
  }
  settle(Infinity); return { trades: accepted, endEquity: equity, maxDrawdown };
}

function metrics(account, start, end) {
  const rows = account.trades.filter((t) => t.openedAt >= start && t.openedAt < end);
  const g = rows.filter((t) => t.netPnl > 0), l = rows.filter((t) => t.netPnl <= 0);
  const monthly = signalRaw.months.flatMap((m) => {
    const s = monthStart(m), e = Date.UTC(Number(m.slice(0, 4)), Number(m.slice(4, 6)), 1);
    if (s < start || e > end) return [];
    const xs = rows.filter((t) => t.openedAt >= s && t.openedAt < e);
    return [{ month: m, trades: xs.length, pnl: sum(xs.map((t) => t.netPnl)) }];
  });
  let eq = 1000, pk = eq, dd = 0;
  for (const t of [...rows].sort((a, b) => a.closedAt - b.closedAt)) { eq += t.netPnl; pk = Math.max(pk, eq); dd = Math.max(dd, (pk - eq) / pk); }
  const bySymbol = Object.fromEntries([...new Set(rows.map((t) => t.symbol))].map((sym) => [sym, sum(rows.filter((t) => t.symbol === sym).map((t) => t.netPnl))]));
  const pos = Object.values(bySymbol).filter((v) => v > 0), pt = sum(pos);
  const byState = Object.fromEntries([...new Set(rows.map((t) => t.anomalyState))].map((s) => [s, { trades: rows.filter((t) => t.anomalyState === s).length, pnl: sum(rows.filter((t) => t.anomalyState === s).map((t) => t.netPnl)) }]));
  return {
    trades: rows.length, tradesPerDay: rows.length / Math.max(1, (end - start) / 86400000), netPnl: sum(rows.map((t) => t.netPnl)),
    profitFactor: l.length ? sum(g.map((t) => t.netPnl)) / Math.abs(sum(l.map((t) => t.netPnl))) : g.length ? 99 : 0,
    maxDrawdown: dd, activeMonths: monthly.filter((x) => x.trades).length, positiveMonths: monthly.filter((x) => x.pnl > 0).length,
    largestPositiveSymbolShare: pt ? Math.max(...pos) / pt : 1, bySymbol, byState, monthly,
  };
}
const compact = (m) => ({ trades: m.trades, tradesPerDay: m.tradesPerDay, netPnl: m.netPnl, profitFactor: m.profitFactor, maxDrawdown: m.maxDrawdown, activeMonths: m.activeMonths, positiveMonths: m.positiveMonths, largestPositiveSymbolShare: m.largestPositiveSymbolShare, byState: m.byState });
const folds = (account) => [[0, 10], [10, 20], [20, 30]].map(([a, b]) => metrics(account, monthStart(signalRaw.months[a]), monthStart(signalRaw.months[b])));
function audit(config) {
  const base = portfolio(rawTrades(config), [config]);
  const stress = portfolio(rawTrades(config, STRESS_FRICTION), [config]);
  const adverse = portfolio(rawTrades(config, FRICTION, ENTRY_SLIPPAGE * 2), [config]);
  const d = metrics(base, fromMs, discoveryEnd), v = metrics(base, discoveryEnd, validationEnd), e = metrics(base, validationEnd, toMs), fs = folds(base);
  const discoveryQualified = d.trades >= 250 && d.netPnl > 0 && d.profitFactor >= 1.08 && d.activeMonths >= 18 && d.positiveMonths >= Math.ceil(d.activeMonths * 0.55) && d.largestPositiveSymbolShare <= 0.45 && fs.filter((x) => x.netPnl > 0).length >= 2 && fs.at(-1).netPnl > 0;
  const sv = metrics(stress, discoveryEnd, validationEnd), se = metrics(stress, validationEnd, toMs), av = metrics(adverse, discoveryEnd, validationEnd), ae = metrics(adverse, validationEnd, toMs);
  const later = (x, y, z, min) => x.trades >= min && x.netPnl > 0 && x.profitFactor >= 1.03 && y.trades >= min && y.netPnl > 0 && y.profitFactor >= 1 && z.trades >= min && z.netPnl > 0 && z.profitFactor >= 1;
  return { config, discovery: compact(d), validation: compact(v), evaluation: compact(e), stressValidation: compact(sv), stressEvaluation: compact(se), adverseValidation: compact(av), adverseEvaluation: compact(ae), discoveryFolds: fs.map(compact), discoveryQualified, validationPass: later(v, sv, av, 50), evaluationPass: later(e, se, ae, 30) };
}

const audits = CONFIGS.map(audit);
const accepted = audits.filter((a) => a.discoveryQualified && a.validationPass && a.evaluationPass);
const decision = accepted.length ? 'FORWARD_CANDIDATE' : 'NO_RELEASE';
const result = {
  research: 'cross-market-anomaly-engine',
  premise: 'select the most cross-sectionally unusual coins first; trade direction is decided only by whether their relative anomaly expands, stalls, fails, or diverges from the market',
  canonical: { signalSha256: signalRaw.sha256, executionSha256: executionRaw.sha256, months: signalRaw.months.length, symbols: signalRaw.symbols },
  thresholds: { special: PREDECLARED_SPECIAL, stateRules: { relativeFail: -0.001, marketSame: 0.0005, marketOpposite: -0.0005, expandPressure: 0.0015, expandDelta: 0.001, decelPrevious: 0.002, decelRatio: 0.5 } },
  contextHours: contexts.length, candidateEvents: events.length,
  stateStudy: { discovery: studyRows(fromMs, discoveryEnd), validation: studyRows(discoveryEnd, validationEnd), evaluation: studyRows(validationEnd, toMs) },
  audits, accepted: accepted.map((a) => a.config.id), decision,
  protocolNote: 'State definitions and trade mappings are fixed before held-out validation/evaluation inspection. No recent-PnL switch, shadow promotion, or production mutation is used.',
};
writeFileSync(OUTPUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ decision, contextHours: contexts.length, candidateEvents: events.length, accepted: result.accepted, audits: audits.map((a) => ({ id: a.config.id, discoveryQualified: a.discoveryQualified, validationPass: a.validationPass, evaluationPass: a.evaluationPass, discovery: a.discovery, validation: a.validation, evaluation: a.evaluation })), stateStudy: result.stateStudy }, null, 2));
