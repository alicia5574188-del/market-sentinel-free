import { readFileSync, writeFileSync } from 'node:fs';

const EXEC_PATH = process.env.RESEARCH_EXECUTION_DATASET ?? '/tmp/gate-history-44m-5m.json';
const SIGNAL_1H_PATH = process.env.RESEARCH_SIGNAL_1H_DATASET ?? '/tmp/gate-history-44m-from5m-1h.json';
const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/robust-mother-phase-ensemble.json';
const BASE_FRICTION = 0.0014;
const STRESS_FRICTION = 0.0022;
const ENTRY_SLIPPAGE = 0.00025;
const INITIAL_EQUITY = 1_000;
const DAY_MS = 86_400_000;
const HOUR = 3600;

const execRaw = JSON.parse(readFileSync(EXEC_PATH, 'utf8'));
const signal1hRaw = JSON.parse(readFileSync(SIGNAL_1H_PATH, 'utf8'));
const EXPECTED_EXEC_SHA = '9e5fd7d06eeee420d60318bee72de3b16e7e877247102a2b505453ab0b8a4522';
const EXPECTED_SIGNAL_SHA = '185bd97b968f96373bef6a174c8258d8ad5606a0d1ed824eaa2cc1ace1efa053';
if (execRaw.interval !== '5m' || signal1hRaw.interval !== '1h') throw new Error('expected exact 5m execution + 1h signal datasets');
if (execRaw.sha256 !== EXPECTED_EXEC_SHA || signal1hRaw.sha256 !== EXPECTED_SIGNAL_SHA) throw new Error('dataset hash mismatch');
if (execRaw.months.length !== 44 || execRaw.months.join() !== signal1hRaw.months.join()) throw new Error('44m month mismatch');
if (execRaw.symbols.join() !== signal1hRaw.symbols.join()) throw new Error('symbol mismatch');

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const sign = (x) => x > 0 ? 1 : x < 0 ? -1 : 0;
const median = (xs) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};
const monthStart = (m) => Date.UTC(Number(m.slice(0,4)), Number(m.slice(4,6)) - 1, 1);
const fromMs = execRaw.from * 1000;
const discoveryEnd = monthStart(execRaw.months[30]);
const validationEnd = monthStart(execRaw.months[38]);
const toMs = execRaw.now * 1000;
const executionBySymbol = new Map(execRaw.datasets.map((d) => [d.symbol, d.rows]));

function aggregateOffset(rows, offsetSeconds) {
  const complete = [];
  let bucket = null;
  for (const row of rows) {
    const time = Math.floor((Number(row.time) - offsetSeconds) / HOUR) * HOUR + offsetSeconds;
    if (!bucket || bucket.time !== time) {
      if (bucket?.samples >= 10) complete.push(bucket);
      bucket = { time, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume), samples: 1 };
    } else {
      bucket.high = Math.max(bucket.high, Number(row.high));
      bucket.low = Math.min(bucket.low, Number(row.low));
      bucket.close = Number(row.close);
      bucket.volume += Number(row.volume);
      bucket.samples += 1;
    }
  }
  if (bucket?.samples >= 10) complete.push(bucket);
  const filled = [];
  for (const row of complete) {
    const previous = filled.at(-1);
    const missing = previous ? (row.time - previous.time) / HOUR - 1 : 0;
    if (previous && missing > 0 && missing <= 3) {
      for (let k = 1; k <= missing; k += 1) filled.push({ time: previous.time + k * HOUR,
        open: previous.close, high: previous.close, low: previous.close, close: previous.close, volume: 0, samples: 0, synthetic: true });
    }
    filled.push(row);
  }
  return filled;
}

const specs = [
  { id: 'PHASE_00', offsetSeconds: 0 },
  { id: 'PHASE_15', offsetSeconds: 900 },
  { id: 'PHASE_30', offsetSeconds: 1800 },
  { id: 'PHASE_45', offsetSeconds: 2700 },
];
const signalDatasets = new Map();
signalDatasets.set('PHASE_00', signal1hRaw.datasets.map((d) => ({ symbol: d.symbol, rows: d.rows })));
for (const spec of specs.filter((s) => s.offsetSeconds)) signalDatasets.set(spec.id,
  execRaw.datasets.map((d) => ({ symbol: d.symbol, rows: aggregateOffset(d.rows, spec.offsetSeconds) })));

function gapPrefix(rows) {
  const p = [0];
  for (let i = 1; i < rows.length; i += 1) p.push(p.at(-1) + Number(rows[i].time !== rows[i - 1].time + HOUR));
  return p;
}
const ret = (rows, i, bars) => rows[i].close / rows[i - bars].close - 1;
const rangeRate = (row) => (row.high - row.low) / Math.max(row.close, 1e-12);
function classify(context) {
  const aligned24 = Math.max(context.breadth24, 1 - context.breadth24);
  if (Math.abs(context.median24) >= 0.04 || (Math.abs(context.median24) >= 0.02 && aligned24 >= 0.82)) return 'SHOCK_TRANSITION';
  if (context.compression <= 0.68 && Math.abs(context.median24) < 0.025) return 'COMPRESSION';
  if ((context.median30 >= 0.08 && context.median7 >= 0.015 && context.breadth30 >= 0.60)
    || (context.median30 <= -0.08 && context.median7 <= -0.015 && context.breadth30 <= 0.40)) return 'DIRECTIONAL_TREND';
  if (Math.abs(context.median24) >= 0.018 || aligned24 >= 0.75) return 'NON_TREND_EXPANSION';
  return 'BALANCED_ROTATION';
}

const observationCache = new Map();
function observations(spec) {
  if (observationCache.has(spec.id)) return observationCache.get(spec.id);
  const byTime = new Map();
  for (const { symbol, rows } of signalDatasets.get(spec.id)) {
    const gaps = gapPrefix(rows);
    for (let index = 720; index < rows.length - 1; index += 1) {
      const current = rows[index];
      if (gaps[index] !== gaps[index - 720] || rows[index + 1].time !== current.time + HOUR) continue;
      const ranges = rows.slice(index - 5, index + 1).map(rangeRate);
      const baseline = rows.slice(index - 168, index - 6).map(rangeRate);
      const f = { symbol, rows, index, current,
        r6: ret(rows,index,6), r24: ret(rows,index,24), r7d: ret(rows,index,168), r30d: ret(rows,index,720),
        atr6: median(ranges), compression: median(ranges) / Math.max(median(baseline), 1e-9) };
      const a = byTime.get(current.time) ?? []; a.push(f); byTime.set(current.time, a);
    }
  }
  const out = [];
  for (const [time, rows] of byTime) {
    if (rows.length < Math.max(8, execRaw.symbols.length - 2)) continue;
    const vals = (k) => rows.map((r) => r[k]);
    const context = { median24: median(vals('r24')), median7: median(vals('r7d')), median30: median(vals('r30d')),
      breadth24: rows.filter((r) => r.r24 > 0).length / rows.length,
      breadth7: rows.filter((r) => r.r7d > 0).length / rows.length,
      breadth30: rows.filter((r) => r.r30d > 0).length / rows.length,
      compression: median(vals('compression')), markets: rows.length };
    const system = classify(context);
    for (const f of rows) out.push({ ...f, time, context, system, relative7: f.r7d - context.median7 });
  }
  observationCache.set(spec.id, out);
  return out;
}

function lowerBound(rows, time) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].time < time) lo = mid + 1; else hi = mid; }
  return lo;
}
const rawCache = new Map();
function rawTrades(spec, friction, slippage) {
  const key = `${spec.id}|${friction}|${slippage}`;
  if (rawCache.has(key)) return rawCache.get(key);
  const trades = [];
  for (const f of observations(spec)) {
    if (f.system !== 'DIRECTIONAL_TREND' || f.time * 1000 >= toMs) continue;
    const marketDirection = sign(f.context.median30); const direction = -marketDirection;
    if (!direction || direction * f.relative7 < 0.03 || direction * f.r6 < 0.004) continue;
    const strength = direction * f.relative7 + direction * f.r6;
    const rows = executionBySymbol.get(f.symbol); const entryTime = f.rows[f.index + 1].time;
    const index = lowerBound(rows, entryTime); if (rows[index]?.time !== entryTime) continue;
    const entry = rows[index].open * (1 + direction * slippage);
    const stopRate = Math.min(0.20, Math.max(0.03, 5 * f.atr6));
    const targetRate = Math.max(stopRate * 2.2, friction * 2.2);
    const stop = entry * (1 - direction * stopRate); const target = entry * (1 + direction * targetRate);
    let exit = entry, closedAt = rows[index].time * 1000, outcome = 'DATA_GAP';
    for (let offset = 0; offset < 72 * 12 && index + offset < rows.length; offset += 1) {
      const candle = rows[index + offset];
      if (offset && candle.time !== rows[index + offset - 1].time + 300) {
        exit = rows[index + offset - 1].close; closedAt = rows[index + offset - 1].time * 1000; break;
      }
      const stopped = direction > 0 ? candle.low <= stop : candle.high >= stop;
      const targeted = direction > 0 ? candle.high >= target : candle.low <= target;
      if (stopped || targeted) { exit = stopped ? stop : target; closedAt = candle.time * 1000; outcome = stopped ? 'STOP' : 'TARGET'; break; }
      exit = candle.close; closedAt = candle.time * 1000; outcome = offset === 72 * 12 - 1 ? 'TIMEOUT' : outcome;
    }
    const grossReturnRate = direction * (exit - entry) / entry;
    trades.push({ strategyId: spec.id, symbol: f.symbol, side: direction > 0 ? 'LONG' : 'SHORT', openedAt: rows[index].time * 1000,
      closedAt, stopRate, friction, strength, outcome, grossReturnRate, netReturnRate: grossReturnRate - friction });
  }
  trades.sort((a,b) => a.openedAt - b.openedAt || b.strength - a.strength || a.strategyId.localeCompare(b.strategyId));
  rawCache.set(key, trades); return trades;
}

function portfolio(trades) {
  let equity = INITIAL_EQUITY, peak = equity, maxDrawdown = 0;
  const open = [], accepted = [], cooldown = new Map();
  const settle = (time) => {
    for (const trade of open.filter((t) => t.closedAt <= time).sort((a,b) => a.closedAt - b.closedAt)) {
      equity += trade.netPnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak,1e-12));
      open.splice(open.indexOf(trade),1); cooldown.set(`${trade.strategyId}|${trade.symbol}`, trade.closedAt + 24 * HOUR * 1000);
    }
  };
  for (let i = 0; i < trades.length;) {
    const openedAt = trades[i].openedAt; settle(openedAt); const simultaneous = [];
    while (i < trades.length && trades[i].openedAt === openedAt) simultaneous.push(trades[i++]);
    for (const trade of simultaneous.sort((a,b) => b.strength - a.strength || a.strategyId.localeCompare(b.strategyId))) {
      if (equity <= 100 || open.some((x) => x.symbol === trade.symbol)
        || (cooldown.get(`${trade.strategyId}|${trade.symbol}`) ?? 0) > trade.openedAt) continue;
      const sameSide = open.filter((x) => x.side === trade.side);
      const multiple = Math.min(0.5, 0.015 / Math.max(trade.stopRate + trade.friction,1e-9));
      if (multiple < 0.05) continue;
      const notional = equity * multiple; const plannedRisk = notional * (trade.stopRate + trade.friction);
      if (sum(open.map((x) => x.plannedRisk)) + plannedRisk > equity * 0.10
        || sum(sameSide.map((x) => x.plannedRisk)) + plannedRisk > equity * 0.065) continue;
      const acceptedTrade = { ...trade, equityAtOpen: equity, notional, plannedRisk, netPnl: notional * trade.netReturnRate };
      open.push(acceptedTrade); accepted.push(acceptedTrade);
    }
  }
  settle(Infinity); return { trades: accepted, endEquity: equity, maxDrawdown };
}

function metrics(account,start,end) {
  const rows = account.trades.filter((t) => t.openedAt >= start && t.openedAt < end);
  const gains = rows.filter((t) => t.netPnl > 0), losses = rows.filter((t) => t.netPnl <= 0);
  let equity = INITIAL_EQUITY, peak = equity, dd = 0;
  for (const t of [...rows].sort((a,b) => a.closedAt - b.closedAt)) { equity += t.netPnl; peak = Math.max(peak,equity); dd = Math.max(dd,(peak-equity)/Math.max(peak,1e-12)); }
  return { trades: rows.length, netPnl: sum(rows.map((t) => t.netPnl)),
    profitFactor: losses.length ? sum(gains.map((t) => t.netPnl)) / Math.abs(sum(losses.map((t) => t.netPnl))) : gains.length ? 99 : 0,
    maxDrawdown: dd };
}
function exposure(account,start,end) {
  const changes=[];
  for (const t of account.trades) {
    const f=t.notional/Math.max(t.equityAtOpen,1e-12), d=t.side==='LONG'?1:-1;
    if(t.openedAt>=start&&t.openedAt<end)changes.push({time:t.openedAt,symbol:t.symbol,delta:d*f});
    if(t.closedAt>=start&&t.closedAt<end)changes.push({time:t.closedAt,symbol:t.symbol,delta:-d*f});
  }
  const g=new Map(); for(const x of changes){const k=`${x.time}|${x.symbol}`;g.set(k,(g.get(k)??0)+x.delta);}
  const days=(end-start)/DAY_MS;
  return { turnoverPerDay:sum([...g.values()].map(Math.abs))/days,
    entriesPerDay:account.trades.filter((t)=>t.openedAt>=start&&t.openedAt<end).length/days };
}
const periods={discovery:[fromMs,discoveryEnd],validation:[discoveryEnd,validationEnd],evaluation:[validationEnd,toMs],full:[fromMs,toMs]};
function summarize(account){return {endEquity:account.endEquity,maxDrawdown:account.maxDrawdown,
  periods:Object.fromEntries(Object.entries(periods).map(([k,[a,b]])=>[k,{...metrics(account,a,b),...exposure(account,a,b)}]))};}
function evaluateTradeSet(tradesByPath){return Object.fromEntries(Object.entries(tradesByPath).map(([name,trades])=>[name,summarize(portfolio(trades))]));}
function evaluateSpec(spec){
  const paths=evaluateTradeSet({base:rawTrades(spec,BASE_FRICTION,ENTRY_SLIPPAGE),stress:rawTrades(spec,STRESS_FRICTION,ENTRY_SLIPPAGE),adverse:rawTrades(spec,BASE_FRICTION,ENTRY_SLIPPAGE*2)});
  const s=paths.stress.periods,a=paths.adverse.periods;
  const trainQualified=s.discovery.trades>=40&&s.validation.trades>=15&&s.discovery.netPnl>0&&s.validation.netPnl>0
    &&s.discovery.profitFactor>=1&&s.validation.profitFactor>=1&&a.discovery.netPnl>0&&a.validation.netPnl>0;
  const evaluationSurvivor=trainQualified&&s.evaluation.netPnl>0&&s.evaluation.profitFactor>=1&&a.evaluation.netPnl>0;
  return {spec,trainQualified,evaluationSurvivor,paths};
}

const standalone=specs.map(evaluateSpec);
const baseline=standalone[0];
const expected={discovery:{trades:405,netPnl:51.32916758231005,profitFactor:1.0272665070296876},validation:{trades:110,netPnl:63.98045967877867,profitFactor:1.0966418747416167},evaluation:{trades:45,netPnl:238.7399157602952,profitFactor:2.771265720593711}};
const close=(a,b,t=1e-6)=>Math.abs(a-b)<=t;
const parity=Object.fromEntries(Object.keys(expected).map((p)=>[p,{trades:baseline.paths.stress.periods[p].trades===expected[p].trades,
  netPnl:close(baseline.paths.stress.periods[p].netPnl,expected[p].netPnl,1e-5),profitFactor:close(baseline.paths.stress.periods[p].profitFactor,expected[p].profitFactor,1e-8),actual:baseline.paths.stress.periods[p],expected:expected[p]}]));
const parityValid=Object.values(parity).every((x)=>x.trades&&x.netPnl&&x.profitFactor); if(!parityValid)throw new Error(`baseline parity failed ${JSON.stringify(parity)}`);
const trainingPhases=standalone.filter((x)=>x.spec.id!=='PHASE_00'&&x.trainQualified).map((x)=>x.spec.id);
const selectedIds=['PHASE_00',...trainingPhases];
const selectedSpecs=specs.filter((s)=>selectedIds.includes(s.id));
const combined=evaluateTradeSet({
  base:selectedSpecs.flatMap((s)=>rawTrades(s,BASE_FRICTION,ENTRY_SLIPPAGE)).sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength),
  stress:selectedSpecs.flatMap((s)=>rawTrades(s,STRESS_FRICTION,ENTRY_SLIPPAGE)).sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength),
  adverse:selectedSpecs.flatMap((s)=>rawTrades(s,BASE_FRICTION,ENTRY_SLIPPAGE*2)).sort((a,b)=>a.openedAt-b.openedAt||b.strength-a.strength),
});
const combinedTrainOk=combined.stress.periods.discovery.netPnl>0&&combined.stress.periods.validation.netPnl>0
  &&combined.adverse.periods.discovery.netPnl>0&&combined.adverse.periods.validation.netPnl>0;
const combinedEvalOk=combinedTrainOk&&combined.stress.periods.evaluation.netPnl>0&&combined.adverse.periods.evaluation.netPnl>0;
const baseTurnover=baseline.paths.stress.periods.full.turnoverPerDay;
const combinedGain=combined.stress.periods.full.turnoverPerDay/Math.max(baseTurnover,1e-12);
const decision=trainingPhases.length&&combinedEvalOk&&combinedGain>1.25?'PHASE_ENSEMBLE_SURVIVOR':'PHASE_ENSEMBLE_REJECTED';

const report={research:'robust-positive-mother-hourly-phase-ensemble-v1',authority:'RESEARCH_ONLY_NO_DEPLOYMENT',decision,
  hypothesis:'preserve the proven 1h economic horizon and thresholds, but evaluate four predeclared 1h bar phases (00/15/30/45 minutes) to add genuinely distinct observation times without shrinking the strategy timescale',
  mother:{id:'directional_trend-defensive_relative-5',system:'DIRECTIONAL_TREND',tactic:'DEFENSIVE_RELATIVE'},
  data:{months:execRaw.months,symbols:execRaw.symbols,executionSha256:execRaw.sha256,signal1hSha256:signal1hRaw.sha256},
  split:{discovery:execRaw.months.slice(0,30),validation:execRaw.months.slice(30,38),evaluation:execRaw.months.slice(38),note:'historical gated evaluation; not project-wide pristine blind OOS'},
  protocol:{phasesMinutes:[0,15,30,45],horizons:'all phases retain true 1h bars and the frozen 720/168/24/6-bar horizons, 72h max hold, 24h cooldown',
    execution:'completed 1h phase bar -> next phase-bar open, resolved on exact Gate 5m path',costs:{baseRoundTrip:BASE_FRICTION,stressRoundTrip:STRESS_FRICTION,adverseEntryExtra:ENTRY_SLIPPAGE},
    selection:'nonzero phases selected using discovery+validation stress and doubled-entry-adverse results only; evaluation never selects a phase',
    combinedPortfolio:'one account, one live position per symbol, 10% aggregate planned-risk and 6.5% same-side caps; overlapping phase orders are naturally blocked/netted, not double-counted',
    turnover:'signed entry/exit fractions netted by symbol+timestamp before absolute genuine turnover is counted'},
  baselineParity:{valid:parityValid,detail:parity},standalone,trainingSelectedPhases:trainingPhases,combined:{selectedIds,trainOk:combinedTrainOk,evaluationOk:combinedEvalOk,turnoverGainVsBaseline:combinedGain,paths:combined},
  nextStep:decision==='PHASE_ENSEMBLE_SURVIVOR'?'repeat the frozen phase test on one structurally independent robust mother, then combine only training-qualified phase families with exact netting':'do not tune phase offsets; move to a different already-robust mother mechanism rather than mining this one'};
writeFileSync(OUTPUT,`${JSON.stringify(report,null,2)}\n`);
console.log(`ROBUST_MOTHER_PHASE=${JSON.stringify({decision,parityValid,trainingPhases,combinedGain,
  standalone:standalone.map((x)=>({id:x.spec.id,trainQualified:x.trainQualified,survivor:x.evaluationSurvivor,stress:x.paths.stress.periods,adverse:x.paths.adverse.periods})),combined:{selectedIds,trainOk:combinedTrainOk,evaluationOk:combinedEvalOk,stress:combined.stress.periods,adverse:combined.adverse.periods}})}`);
