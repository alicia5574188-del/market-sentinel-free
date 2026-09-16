import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const DATASET = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-v13-funding.json";
const raw = JSON.parse(readFileSync(DATASET, "utf8"));
const datasets = raw.datasets ?? [];
const symbols = datasets.map((row) => row.symbol);
const months = raw.months ?? [];
if (symbols.length < 8 || months.length < 9) throw new Error("insufficient candle universe");

const BASE_COST = 0.00165;
const STRESS_COST = 0.0027;
const SIDE_GROSS = 5 / 12; // three settlement windows/day => ~5x two-way turnover/day
const minMarkets = Math.max(8, Math.ceil(symbols.length * 0.7));
const candleMaps = new Map(datasets.map((dataset) => [dataset.symbol,
  new Map(dataset.rows.map((row) => [Number(row.time), Number(row.open)]))]));
const normalizeSeconds = (time) => time > 1e12 ? time / 1000 : time;
const fundingSlot = (time) => Math.round(normalizeSeconds(time) / 300) * 300;

async function fetchFunding(symbol, month) {
  const url = `https://download.gatedata.org/futures_usdt/funding_applies/${month}/${symbol}-${month}.csv.gz`;
  const response = await fetch(url, { headers: { Accept: "application/octet-stream" } });
  if (!response.ok) throw new Error(`${symbol} ${month} funding HTTP ${response.status}`);
  const text = gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8").trim();
  if (!text) return [];
  return text.split("\n").flatMap((line) => {
    const [timeRaw, rateRaw] = line.trim().split(",");
    const rawTime = Number(timeRaw); const rate = Number(rateRaw);
    return Number.isFinite(rawTime) && Number.isFinite(rate) ? [{ time: fundingSlot(rawTime), rate }] : [];
  });
}

const fundingByTime = new Map();
for (const symbol of symbols) {
  for (const month of months) {
    try {
      const rows = await fetchFunding(symbol, month);
      for (const row of rows) {
        const bySymbol = fundingByTime.get(row.time) ?? new Map();
        bySymbol.set(symbol, row.rate); fundingByTime.set(row.time, bySymbol);
      }
      console.log(`funding ${symbol} ${month} ${rows.length}`);
    } catch (error) {
      console.log(`funding ${symbol} ${month} skip ${error.message ?? error}`);
    }
  }
}

const events = [...fundingByTime.entries()]
  .filter(([, rates]) => rates.size >= minMarkets)
  .sort((a, b) => a[0] - b[0]);
if (events.length < 100) throw new Error(`only ${events.length} synchronized funding events`);

const splits = {
  discovery: new Set(months.slice(0, 6)),
  validation: new Set(months.slice(6, 9)),
  evaluation: new Set(months.slice(9)),
  full: new Set(months),
};
const monthKey = (time) => new Date(time * 1000).toISOString().slice(0, 7).replace("-", "");
const openAt = (symbol, time) => candleMaps.get(symbol)?.get(time) ?? NaN;
const eventsByMonth = Object.fromEntries(months.map((month) => [month, events.filter(([time]) => monthKey(time) === month).length]));

function simulate(config, selectedMonths, cost) {
  let equity = 1000; let peak = equity; let maxDD = 0; let wins = 0;
  let grossWin = 0; let grossLoss = 0; let trades = 0; let turnover = 0;
  let fundingComponent = 0; let priceComponent = 0; let costComponent = 0; let missingCandleEvents = 0;
  const monthly = new Map();
  const scopedEvents = events.filter(([t]) => selectedMonths.has(monthKey(t)));
  const firstTime = scopedEvents[0]?.[0]; const lastTime = scopedEvents.at(-1)?.[0];
  for (const [time, ratesMap] of scopedEvents) {
    const mk = monthKey(time);
    const ranked = [...ratesMap.entries()].sort((a, b) => a[1] - b[1]);
    if (ranked.length < config.depth * 2) continue;
    const lows = ranked.slice(0, config.depth);
    const highs = ranked.slice(-config.depth).reverse();
    const lowMean = lows.reduce((s, x) => s + x[1], 0) / lows.length;
    const highMean = highs.reduce((s, x) => s + x[1], 0) / highs.length;
    if ((highMean - lowMean) * 10_000 < config.minSpreadBp) continue;
    // Funding timestamps can contain exchange-side second offsets. Archive rows are
    // clustered to the nearest completed 5m settlement slot above, so these are
    // genuine candle opens before/after that settlement slot.
    const entryTime = time - config.preMinutes * 60;
    const exitTime = time + config.postMinutes * 60;
    const legs = [
      ...lows.map(([symbol, rate]) => ({ symbol, rate, side: "LONG" })),
      ...highs.map(([symbol, rate]) => ({ symbol, rate, side: "SHORT" })),
    ];
    const weight = SIDE_GROSS / config.depth;
    let eventReturn = 0; let eventFunding = 0; let eventPrice = 0; let valid = true;
    for (const leg of legs) {
      const entry = openAt(leg.symbol, entryTime); const exit = openAt(leg.symbol, exitTime);
      if (!(entry > 0 && exit > 0)) { valid = false; break; }
      const priceRet = leg.side === "LONG" ? exit / entry - 1 : 1 - exit / entry;
      const fundingRet = leg.side === "LONG" ? -leg.rate : leg.rate;
      eventPrice += weight * priceRet;
      eventFunding += weight * fundingRet;
      eventReturn += weight * (priceRet + fundingRet - cost);
    }
    if (!valid) { missingCandleEvents += 1; continue; }
    const before = equity; const pnl = before * eventReturn; equity += pnl;
    trades += 1; turnover += 4 * SIDE_GROSS;
    fundingComponent += eventFunding; priceComponent += eventPrice; costComponent += 2 * SIDE_GROSS * cost;
    if (pnl > 0) { wins += 1; grossWin += pnl; } else grossLoss += -pnl;
    peak = Math.max(peak, equity); maxDD = Math.max(maxDD, (peak - equity) / Math.max(peak, 1e-9));
    const row = monthly.get(mk) ?? { start: before, end: before, trades: 0, turnover: 0 };
    row.end = equity; row.trades += 1; row.turnover += 4 * SIDE_GROSS; monthly.set(mk, row);
  }
  const days = firstTime && lastTime ? Math.max(1, (lastTime - firstTime) / 86_400 + 1) : 1;
  const monthRows = [...monthly.entries()].map(([month, row]) => ({ month, return: row.end / row.start - 1, trades: row.trades,
    turnoverPerDay: row.turnover / Math.max(1, Number(new Date(Date.UTC(Number(month.slice(0,4)), Number(month.slice(4,6)), 0)).getUTCDate())) }));
  const avgMonth = monthRows.length ? monthRows.reduce((s, x) => s + x.return, 0) / monthRows.length : -1;
  return { trades, missingCandleEvents, days: Number(days.toFixed(2)), eventsPerDay: Number((trades / days).toFixed(3)),
    turnoverPerDay: Number((turnover / days).toFixed(3)), returnPct: Number(((equity / 1000 - 1) * 100).toFixed(3)),
    avgMonthPct: Number((avgMonth * 100).toFixed(3)), positiveMonths: monthRows.filter((x) => x.return > 0).length,
    months: monthRows.length, winRatePct: trades ? Number((wins / trades * 100).toFixed(2)) : 0,
    profitFactor: Number((grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0).toFixed(3)),
    maxDrawdownPct: Number((maxDD * 100).toFixed(3)),
    fundingComponentPct: Number((fundingComponent * 100).toFixed(3)), priceComponentPct: Number((priceComponent * 100).toFixed(3)),
    costComponentPct: Number((costComponent * 100).toFixed(3)), monthly: monthRows };
}

const configs = [];
for (const preMinutes of [15, 30, 60]) for (const postMinutes of [5, 15]) for (const depth of [1, 2, 3])
  for (const minSpreadBp of [0, 2, 5, 10, 20, 40]) configs.push({ preMinutes, postMinutes, depth, minSpreadBp });

const rows = configs.map((config) => {
  const discovery = simulate(config, splits.discovery, BASE_COST);
  const discoveryStress = simulate(config, splits.discovery, STRESS_COST);
  const eligible = discoveryStress.turnoverPerDay >= 4 && discoveryStress.turnoverPerDay <= 6
    && discoveryStress.avgMonthPct >= 5 && discoveryStress.profitFactor >= 1
    && discoveryStress.positiveMonths >= Math.max(3, Math.floor(discoveryStress.months * 0.6));
  const score = discoveryStress.avgMonthPct - Math.abs(discoveryStress.turnoverPerDay - 5) * 2 - discoveryStress.maxDrawdownPct * 0.1;
  return { config, discovery, discoveryStress, eligible, score };
}).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);

const selected = rows[0];
const validation = simulate(selected.config, splits.validation, BASE_COST);
const validationStress = simulate(selected.config, splits.validation, STRESS_COST);
const evaluation = simulate(selected.config, splits.evaluation, BASE_COST);
const evaluationStress = simulate(selected.config, splits.evaluation, STRESS_COST);
const full = simulate(selected.config, splits.full, BASE_COST);
const fullStress = simulate(selected.config, splits.full, STRESS_COST);
const passes = Boolean(selected.eligible && validationStress.avgMonthPct >= 5 && evaluationStress.avgMonthPct >= 5
  && validationStress.turnoverPerDay >= 4 && evaluationStress.turnoverPerDay >= 4
  && validationStress.returnPct > 0 && evaluationStress.returnPct > 0);

const result = {
  research: "V13_FUNDING_CARRY_ORACLE_UPPER_BOUND",
  importantBias: "Uses the ACTUAL funding rate applied at settlement to choose the long/short pair before settlement. This is intentionally impossible foresight and therefore an optimistic economic upper bound, not a causal strategy.",
  source: { candles: raw.source, candleSha256: raw.sha256, funding: "Gate official futures_usdt/funding_applies monthly archive" },
  symbols, months, synchronizedFundingEvents: events.length, eventsByMonth,
  assumptions: { sideGrossFraction: SIDE_GROSS, grossExposureDuringWindow: 2 * SIDE_GROSS,
    twoWayTurnoverPerFundingEvent: 4 * SIDE_GROSS, baseRoundTripCostPerLeg: BASE_COST,
    stressRoundTripCostPerLeg: STRESS_COST, targetTurnoverPerDay: 5 },
  search: { configs: configs.length, discoveryEligible: rows.filter((x) => x.eligible).length, top: rows.slice(0, 10) },
  selected: { ...selected, validation, validationStress, evaluation, evaluationStress, full, fullStress },
  decision: passes ? "ORACLE_CARRY_ECONOMIC_CEILING_PASSES_CAUSAL_FORECAST_REQUIRED" : "FUNDING_CARRY_CEILING_REJECTED",
  passes,
};
console.log(`V13_FUNDING_CARRY_JSON=${JSON.stringify(result)}`);
