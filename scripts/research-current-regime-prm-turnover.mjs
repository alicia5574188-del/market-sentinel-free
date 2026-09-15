import { readFileSync, writeFileSync } from 'node:fs';
import {
  advanceRegimePortfolio,
  evaluateRegimePortfolio,
  initialRegimePortfolio,
  REGIME_EXECUTION_UNIVERSE,
  REGIME_SYSTEMS,
} from '../lib/regime-portfolio.ts';

const FIVE = JSON.parse(readFileSync(process.env.RESEARCH_5M_DATASET ?? '/tmp/gate-5m-13m.json', 'utf8'));
const HOURLY = JSON.parse(readFileSync(process.env.RESEARCH_1H_DATASET ?? '/tmp/gate-1h-13m.json', 'utf8'));
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/current-regime-prm-turnover.json';
if (FIVE.interval !== '5m' || HOURLY.interval !== '1h') throw new Error('Need matching 5m and 1h Gate datasets');

const HOUR = 3600;
const DAY = 86400;
const BASE_COST = 0.0014;
const STRESS_COST = 0.0022;
const EXTRA_ADVERSE_ENTRY = 0.00025;
const TRAIN_FROM = Date.UTC(2025, 8, 1) / 1000;
const TRAIN_TO = Date.UTC(2026, 5, 1) / 1000;
const EVAL_TO = Date.UTC(2026, 8, 1) / 1000;
const PRM_WINDOW = 336;
const PRM_MIN_CORR = 0.50;
const PRM_ENTRY_Z = 2.0;
const PRM_PERSIST = 24;
const PRM_HOLD = 24;
const PRM_STEP = 6;

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const sideSign = (side) => side === 'LONG' ? 1 : -1;
const monthKey = (t) => {
  const d = new Date(t * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

const fiveBySymbol = new Map(FIVE.datasets.map((d) => [d.symbol, d.rows]));
const fiveMap = new Map(FIVE.datasets.map((d) => [d.symbol, new Map(d.rows.map((r) => [r.time, r]))]));
const hourlyBySymbol = new Map(HOURLY.datasets.map((d) => [d.symbol, d.rows]));
const hourlyMap = new Map(HOURLY.datasets.map((d) => [d.symbol, new Map(d.rows.map((r) => [r.time, r]))]));
for (const symbol of REGIME_EXECUTION_UNIVERSE) {
  if (!fiveBySymbol.has(symbol) || !hourlyBySymbol.has(symbol)) throw new Error(`Missing production symbol ${symbol}`);
}

const histories = Object.fromEntries(REGIME_EXECUTION_UNIVERSE.map((symbol) => [
  symbol,
  hourlyBySymbol.get(symbol).filter((r) => r.time < TRAIN_FROM),
]));
const contracts = Object.fromEntries(REGIME_EXECUTION_UNIVERSE.map((symbol) => [symbol, {
  quantoMultiplier: 1e-8,
  maintenanceRate: 0.005,
  leverageMax: 50,
  fundingRate: 0,
  volume24hUsd: 1_000_000_000,
}]));

let regimeState = initialRegimePortfolio(TRAIN_FROM * 1000);
const regimeRecords = new Map();
const seenClosed = new Set();

function quoteRow(symbol, candleTime, nowMs) {
  const row = fiveMap.get(symbol)?.get(candleTime);
  if (!row) return null;
  const price = row.close;
  return {
    symbol,
    bestBid: price,
    bestAsk: price,
    fresh: true,
    observedAt: nowMs,
    completedMinuteAt: nowMs,
  };
}

function captureRegime(state) {
  for (const system of REGIME_SYSTEMS) {
    const account = state.accounts[system];
    for (const trade of Object.values(account.open)) {
      if (regimeRecords.has(trade.id)) continue;
      const fraction = trade.notional / Math.max(trade.accountEquityAtOpen, 1e-12);
      regimeRecords.set(trade.id, {
        id: trade.id,
        system,
        symbol: trade.symbol,
        side: trade.side,
        openedAt: trade.openedAt / 1000,
        closedAt: null,
        fraction,
        satellite: trade.symbol === 'SUI_USDT' || trade.symbol === 'UNI_USDT',
        stressRate: null,
        adverseRate: null,
      });
    }
    for (const trade of account.recent) {
      if (trade.status !== 'CLOSED' || seenClosed.has(trade.id)) continue;
      seenClosed.add(trade.id);
      const fraction = trade.notional / Math.max(trade.accountEquityAtOpen, 1e-12);
      const row = regimeRecords.get(trade.id) ?? {
        id: trade.id,
        system,
        symbol: trade.symbol,
        side: trade.side,
        openedAt: trade.openedAt / 1000,
        fraction,
        satellite: trade.symbol === 'SUI_USDT' || trade.symbol === 'UNI_USDT',
      };
      row.closedAt = trade.closedAt / 1000;
      row.stressRate = (trade.grossReturnRate ?? 0) - STRESS_COST;
      row.adverseRate = (trade.grossReturnRate ?? 0) - BASE_COST - EXTRA_ADVERSE_ENTRY;
      regimeRecords.set(trade.id, row);
    }
  }
}

const ref5 = fiveBySymbol.get('BTC_USDT').filter((r) => r.time >= TRAIN_FROM && r.time < EVAL_TO);
for (const bar of ref5) {
  const nowSec = bar.time + 300;
  const nowMs = nowSec * 1000;
  const quotes = {};
  for (const symbol of REGIME_EXECUTION_UNIVERSE) {
    const quote = quoteRow(symbol, bar.time, nowMs);
    if (quote) quotes[symbol] = quote;
  }
  if (nowSec % HOUR === 0) {
    const completedHour = nowSec - HOUR;
    for (const symbol of REGIME_EXECUTION_UNIVERSE) {
      const row = hourlyMap.get(symbol)?.get(completedHour);
      if (row && histories[symbol].at(-1)?.time !== row.time) histories[symbol].push(row);
    }
    regimeState = evaluateRegimePortfolio({
      state: regimeState,
      hourly: histories,
      quotes,
      contracts,
      now: nowMs,
    });
  } else {
    regimeState = advanceRegimePortfolio({ state: regimeState, quotes, now: nowMs });
  }
  captureRegime(regimeState);
}

const regimeTrades = [...regimeRecords.values()].sort((a, b) => a.openedAt - b.openedAt || a.id.localeCompare(b.id));

function intervalResidual(a, b, t, hours, beta) {
  if (!hours) return 0;
  const am = hourlyMap.get(a); const bm = hourlyMap.get(b);
  const a0 = am.get(t - hours * HOUR)?.close; const a1 = am.get(t)?.close;
  const b0 = bm.get(t - hours * HOUR)?.close; const b1 = bm.get(t)?.close;
  if (![a0, a1, b0, b1].every((v) => Number.isFinite(v) && v > 0)) return null;
  return Math.log(a1 / a0) - beta * Math.log(b1 / b0);
}

function pairFeature(a, b, t) {
  const am = hourlyMap.get(a); const bm = hourlyMap.get(b);
  let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
  for (let k = PRM_WINDOW; k >= 1; k -= 1) {
    const a0 = am.get(t - k * HOUR)?.close; const a1 = am.get(t - (k - 1) * HOUR)?.close;
    const b0 = bm.get(t - k * HOUR)?.close; const b1 = bm.get(t - (k - 1) * HOUR)?.close;
    if (![a0, a1, b0, b1].every((v) => Number.isFinite(v) && v > 0)) return null;
    const x = Math.log(a1 / a0); const y = Math.log(b1 / b0);
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  const n = PRM_WINDOW; const mx = sx / n; const my = sy / n;
  const vx = Math.max(0, sxx / n - mx * mx); const vy = Math.max(0, syy / n - my * my);
  const cov = sxy / n - mx * my;
  if (!(vx > 1e-12) || !(vy > 1e-12)) return null;
  const corr = cov / Math.sqrt(vx * vy); const beta = cov / vy;
  if (!Number.isFinite(corr) || !Number.isFinite(beta) || beta < 0.25 || beta > 4) return null;
  const residualVar = Math.max(1e-12, vx + beta * beta * vy - 2 * beta * cov);
  const z = (sx - beta * sy) / Math.sqrt(residualVar * n);
  const r24 = intervalResidual(a, b, t, PRM_PERSIST, beta);
  if (!Number.isFinite(z) || !Number.isFinite(r24)) return null;
  return { a, b, signalAt: t, corr, beta, z, absZ: Math.abs(z), r24 };
}

function legReturn(symbol, direction, entryAt, exitAt, slip) {
  const rm = hourlyMap.get(symbol);
  const e0 = rm.get(entryAt)?.open; const x0 = rm.get(exitAt)?.open;
  if (![e0, x0].every((v) => Number.isFinite(v) && v > 0)) return null;
  const entry = direction > 0 ? e0 * (1 + slip) : e0 * (1 - slip);
  return direction > 0 ? x0 / entry - 1 : 1 - x0 / entry;
}

const allSymbols = FIVE.datasets.map((d) => d.symbol);
const ref1 = hourlyBySymbol.get('BTC_USDT');
const prmEvents = [];
const prmBusy = new Map();
for (const row of ref1) {
  const t = row.time;
  if (t < TRAIN_FROM || t >= EVAL_TO) continue;
  if (new Date(t * 1000).getUTCHours() % PRM_STEP !== 0) continue;
  if (t < FIVE.from + PRM_WINDOW * HOUR) continue;
  const entryAt = t + HOUR;
  const exitAt = entryAt + PRM_HOLD * HOUR;
  if (exitAt > EVAL_TO) continue;
  const eligible = [];
  for (let i = 0; i < allSymbols.length; i += 1) {
    for (let j = i + 1; j < allSymbols.length; j += 1) {
      const f = pairFeature(allSymbols[i], allSymbols[j], t);
      if (!f || f.corr < PRM_MIN_CORR || f.absZ < PRM_ENTRY_Z) continue;
      if (Math.sign(f.r24) !== Math.sign(f.z) || Math.abs(f.r24) <= 1e-6) continue;
      eligible.push(f);
    }
  }
  eligible.sort((x, y) => y.absZ - x.absZ || y.corr - x.corr);
  for (const f of eligible) {
    if ((prmBusy.get(f.a) ?? 0) > entryAt || (prmBusy.get(f.b) ?? 0) > entryAt) continue;
    const dirA = f.z > 0 ? 1 : -1; const dirB = -dirA;
    const betaAbs = Math.abs(f.beta); const wA = 1 / (1 + betaAbs); const wB = betaAbs / (1 + betaAbs);
    const aBase = legReturn(f.a, dirA, entryAt, exitAt, 0.00025);
    const bBase = legReturn(f.b, dirB, entryAt, exitAt, 0.00025);
    const aAdv = legReturn(f.a, dirA, entryAt, exitAt, 0.00050);
    const bAdv = legReturn(f.b, dirB, entryAt, exitAt, 0.00050);
    if (![aBase, bBase, aAdv, bAdv].every(Number.isFinite)) continue;
    const gross = wA * aBase + wB * bBase;
    const adverseGross = wA * aAdv + wB * bAdv;
    prmEvents.push({
      id: `PRM753:${f.a}:${f.b}:${entryAt}`,
      a: f.a, b: f.b, entryAt, exitAt, dirA, dirB, wA, wB,
      stressRate: gross - STRESS_COST,
      adverseRate: adverseGross - BASE_COST,
    });
    prmBusy.set(f.a, exitAt); prmBusy.set(f.b, exitAt);
    break;
  }
}

function regimeChanges() {
  const out = [];
  for (const t of regimeTrades) {
    const sign = sideSign(t.side);
    out.push({ time: t.openedAt, symbol: t.symbol, delta: sign * t.fraction, component: 'REGIME', id: t.id });
    if (t.closedAt != null) out.push({ time: t.closedAt, symbol: t.symbol, delta: -sign * t.fraction, component: 'REGIME', id: t.id });
  }
  return out;
}

function prmChanges(scale) {
  const out = [];
  for (const e of prmEvents) {
    out.push({ time: e.entryAt, symbol: e.a, delta: e.dirA * e.wA * scale, component: 'PRM753', id: e.id });
    out.push({ time: e.entryAt, symbol: e.b, delta: e.dirB * e.wB * scale, component: 'PRM753', id: e.id });
    out.push({ time: e.exitAt, symbol: e.a, delta: -e.dirA * e.wA * scale, component: 'PRM753', id: e.id });
    out.push({ time: e.exitAt, symbol: e.b, delta: -e.dirB * e.wB * scale, component: 'PRM753', id: e.id });
  }
  return out;
}

const baseRegimeChanges = regimeChanges();

function groupedChanges(scale) {
  const all = [...baseRegimeChanges, ...prmChanges(scale)];
  const buckets = new Map();
  for (const x of all) {
    const key = `${x.time}:${x.symbol}`;
    buckets.set(key, (buckets.get(key) ?? 0) + x.delta);
  }
  const rows = [...buckets.entries()].map(([key, delta]) => {
    const p = key.indexOf(':');
    return { time: Number(key.slice(0, p)), symbol: key.slice(p + 1), delta };
  }).sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
  return rows;
}

function turnoverStats(scale, from, to) {
  const rows = groupedChanges(scale).filter((x) => x.time >= from && x.time < to);
  const actual = sum(rows.map((x) => Math.abs(x.delta)));
  const logical = sum([...baseRegimeChanges, ...prmChanges(scale)]
    .filter((x) => x.time >= from && x.time < to).map((x) => Math.abs(x.delta)));
  const days = (to - from) / DAY;
  return {
    turnoverPerDay: actual / days,
    logicalTurnoverPerDay: logical / days,
    nettingRetention: logical ? actual / logical : 1,
  };
}

function maxGross(scale, from, to) {
  const rows = groupedChanges(scale);
  const positions = new Map();
  for (const x of rows) {
    if (x.time >= from) break;
    positions.set(x.symbol, (positions.get(x.symbol) ?? 0) + x.delta);
  }
  let max = sum([...positions.values()].map(Math.abs));
  for (const x of rows) {
    if (x.time < from) continue;
    if (x.time >= to) break;
    positions.set(x.symbol, (positions.get(x.symbol) ?? 0) + x.delta);
    max = Math.max(max, sum([...positions.values()].map(Math.abs)));
  }
  return max;
}

function lifecycle(scale, field) {
  const rows = [];
  for (const t of regimeTrades) {
    rows.push({ time: t.openedAt, kind: 'OPEN', id: `R:${t.id}`, fraction: t.fraction, rate: null });
    if (t.closedAt != null && Number.isFinite(t[field])) {
      rows.push({ time: t.closedAt, kind: 'CLOSE', id: `R:${t.id}`, fraction: t.fraction, rate: t[field] });
    }
  }
  for (const e of prmEvents) {
    rows.push({ time: e.entryAt, kind: 'OPEN', id: `P:${e.id}`, fraction: scale, rate: null });
    rows.push({ time: e.exitAt, kind: 'CLOSE', id: `P:${e.id}`, fraction: scale, rate: e[field] });
  }
  return rows.sort((a, b) => a.time - b.time || (a.kind === 'CLOSE' ? -1 : 1));
}

function pathStats(scale, field) {
  const rows = lifecycle(scale, field);
  const byTime = new Map();
  for (const x of rows) {
    const bucket = byTime.get(x.time) ?? { closes: [], opens: [] };
    (x.kind === 'CLOSE' ? bucket.closes : bucket.opens).push(x);
    byTime.set(x.time, bucket);
  }
  let equity = 1;
  const open = new Map();
  const points = [{ time: TRAIN_FROM, equity }];
  for (const [time, bucket] of [...byTime.entries()].sort((a, b) => a[0] - b[0])) {
    if (time < TRAIN_FROM || time >= EVAL_TO) continue;
    for (const x of bucket.closes) {
      const opened = open.get(x.id);
      if (!opened) continue;
      equity += opened.equityAtOpen * x.fraction * x.rate;
      open.delete(x.id);
    }
    const snapshot = equity;
    for (const x of bucket.opens) open.set(x.id, { equityAtOpen: snapshot });
    points.push({ time, equity });
  }
  const segment = (from, to) => {
    const prior = [...points].filter((p) => p.time < from).at(-1)?.equity ?? 1;
    let peak = prior; let min = prior; let end = prior; let dd = 0;
    for (const p of points) {
      if (p.time < from || p.time >= to) continue;
      end = p.equity; peak = Math.max(peak, end); min = Math.min(min, end);
      dd = Math.max(dd, (peak - end) / Math.max(peak, 1e-12));
    }
    return { startEquity: prior, endEquity: end, net: end - prior, minEquity: min, maxDrawdown: dd, survived: min > 0 };
  };
  return {
    train: segment(TRAIN_FROM, TRAIN_TO),
    evaluation: segment(TRAIN_TO, EVAL_TO),
    full: segment(TRAIN_FROM, EVAL_TO),
  };
}

function summaryForScale(scale) {
  const stress = pathStats(scale, 'stressRate');
  const adverse = pathStats(scale, 'adverseRate');
  return {
    prmScale: scale,
    train: {
      turnover: turnoverStats(scale, TRAIN_FROM, TRAIN_TO),
      maxGross: maxGross(scale, TRAIN_FROM, TRAIN_TO),
      stress: stress.train,
      adverse: adverse.train,
    },
    evaluation: {
      turnover: turnoverStats(scale, TRAIN_TO, EVAL_TO),
      maxGross: maxGross(scale, TRAIN_TO, EVAL_TO),
      stress: stress.evaluation,
      adverse: adverse.evaluation,
    },
    full: {
      turnover: turnoverStats(scale, TRAIN_FROM, EVAL_TO),
      maxGross: maxGross(scale, TRAIN_FROM, EVAL_TO),
      stress: stress.full,
      adverse: adverse.full,
    },
  };
}

const scales = Array.from({ length: 51 }, (_, i) => Number((i * 0.05).toFixed(2)));
const frontier = scales.map(summaryForScale);
const trainFloor = frontier.filter((x) => x.train.stress.net >= 0 && x.train.adverse.net >= 0
  && x.train.stress.survived && x.train.adverse.survived);
const target5 = trainFloor.filter((x) => x.train.turnover.turnoverPerDay >= 5);
const frozenTarget = target5.sort((a, b) => a.prmScale - b.prmScale)[0] ?? null;
const bestUnder = (cap) => [...trainFloor].filter((x) => x.train.stress.maxDrawdown <= cap)
  .sort((a, b) => b.train.turnover.turnoverPerDay - a.train.turnover.turnoverPerDay)[0] ?? null;

const regimeOnly = summaryForScale(0);
const prmOne = {
  events: prmEvents.length,
  trainEvents: prmEvents.filter((e) => e.entryAt >= TRAIN_FROM && e.exitAt <= TRAIN_TO).length,
  evaluationEvents: prmEvents.filter((e) => e.entryAt >= TRAIN_TO && e.exitAt <= EVAL_TO).length,
  trainTurnover1xPerDay: 2 * prmEvents.filter((e) => e.entryAt >= TRAIN_FROM && e.exitAt <= TRAIN_TO).length / ((TRAIN_TO - TRAIN_FROM) / DAY),
  evaluationTurnover1xPerDay: 2 * prmEvents.filter((e) => e.entryAt >= TRAIN_TO && e.exitAt <= EVAL_TO).length / ((EVAL_TO - TRAIN_TO) / DAY),
  trainStressNet1x: sum(prmEvents.filter((e) => e.entryAt >= TRAIN_FROM && e.exitAt <= TRAIN_TO).map((e) => e.stressRate)),
  evaluationStressNet1x: sum(prmEvents.filter((e) => e.entryAt >= TRAIN_TO && e.exitAt <= EVAL_TO).map((e) => e.stressRate)),
};

const regimeInventory = {
  trades: regimeTrades.length,
  closedTrades: regimeTrades.filter((t) => t.closedAt != null).length,
  coreTrades: regimeTrades.filter((t) => !t.satellite).length,
  satelliteTrades: regimeTrades.filter((t) => t.satellite).length,
  bySystem: Object.fromEntries(REGIME_SYSTEMS.map((system) => [system, regimeTrades.filter((t) => t.system === system).length])),
  byMonth: Object.fromEntries([...new Set(regimeTrades.map((t) => monthKey(t.openedAt)))].sort().map((m) => [m,
    regimeTrades.filter((t) => monthKey(t.openedAt) === m).length])),
};

const output = {
  research: 'current-regime-prm-turnover-v1',
  objective: 'measure normalized genuine exchange turnover of the current five-regime V1.1 source orders, then add frozen PRM-753 without inventing turnover or retuning either signal',
  data: { fiveMinuteSha256: FIVE.sha256, hourlySha256: HOURLY.sha256, months: FIVE.months, symbols: FIVE.symbols },
  protocol: {
    productionReplay: 'imports current lib/regime-portfolio.ts; 11 core symbols define context, SUI/UNI are satellite execution only; source accounts remain 1000U and use current production risk caps',
    canonicalNormalization: 'each source order contributes notional/source-equity-at-open, exactly matching canonical SOURCE_EQUITY_FRACTION sizing; live turnover is measured after signed same-symbol changes are netted by timestamp',
    historicalExecutionApproximation: 'production logic is advanced on each completed 5m close with zero synthetic spread; contract multiplier is set tiny only to remove lot-rounding noise from the normalized turnover fraction',
    prm: 'frozen PRM-753 only: 336h pair window, corr>=0.50, |z|>=2, 24h residual-sign persistence, 24h hold, depth1, next-hour entry',
    costs: { baseRoundTrip: BASE_COST, stressRoundTrip: STRESS_COST, adverseEntryExtraVsBase: EXTRA_ADVERSE_ENTRY },
    scaleSelection: 'PRM gross scale is searched only on 2025-09..2026-05 to measure how much PRM would be required to approach 5x/day; the selected scale is then reported unchanged on 2026-06..08',
  },
  periods: { train: [TRAIN_FROM, TRAIN_TO], evaluation: [TRAIN_TO, EVAL_TO] },
  regimeInventory,
  regimeOnly,
  prmOne,
  search: {
    variants: frontier.length,
    trainFloorCount: trainFloor.length,
    trainTarget5Count: target5.length,
    frozenTarget5FromTrain: frozenTarget,
    bestUnder20pctTrainDd: bestUnder(0.20),
    bestUnder30pctTrainDd: bestUnder(0.30),
    bestUnder50pctTrainDd: bestUnder(0.50),
  },
  limitations: [
    'The live exchange sees intra-5m prices while this replay advances the production manager on completed 5m closes; turnover sizing is exact in normalized risk-fraction terms, while individual exit timestamps can differ from tick-level live execution.',
    'PRM-753 still lacks the earlier frozen backward-OOS stage; this experiment measures portfolio capacity, not final production authorization.',
    'Drawdown is a normalized canonical logical-leg stress path; Gate single-position netting can change realized live PnL when independent logical legs offset.',
  ],
};

writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(`CURRENT_REGIME_PRM_TURNOVER=${JSON.stringify({
  regimeInventory,
  regimeOnly,
  prmOne,
  search: output.search,
  limitations: output.limitations,
})}`);
