import { readFileSync, writeFileSync } from "node:fs";

const INPUT = process.env.RESEARCH_INPUT ?? "/tmp/v4-final-base.json";
const ADVERSE_INPUT = process.env.RESEARCH_ADVERSE_INPUT ?? "/tmp/v4-final-adverse.json";
const OUTPUT = process.env.RESEARCH_OUTPUT ?? "/tmp/v4-final-stability.json";
const BOOTSTRAP_SAMPLES = 10_000;
const BLOCK_DAYS = 3;

const report = JSON.parse(readFileSync(INPUT, "utf8"));
const adverse = JSON.parse(readFileSync(ADVERSE_INPUT, "utf8"));
const result = report.results[0];
const adverseResult = adverse.results[0];
const trades = result.trades;
const start = (report.dataset.now - report.dataset.days * 86_400) * 1_000;
const dayMs = 86_400_000;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const quantile = (values, fraction) => {
  const ordered = [...values].sort((left, right) => left - right);
  const index = (ordered.length - 1) * fraction;
  const lower = Math.floor(index); const upper = Math.ceil(index);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower);
};

const days = Array.from({ length: report.dataset.days }, (_, index) => {
  const from = start + index * dayMs; const to = from + dayMs;
  const rows = trades.filter((trade) => trade.closedAt >= from && trade.closedAt < to);
  return { date: new Date(from).toISOString().slice(0, 10), trades: rows.length,
    pnl: sum(rows.map((trade) => trade.netPnl)),
    approximateReturnRate: sum(rows.map((trade) => trade.netPnl / Math.max(trade.accountEquityAtOpen, 1e-12))) };
});
const activeDays = days.filter((day) => day.trades > 0);
const rolling = (width) => Array.from({ length: days.length - width + 1 }, (_, index) => ({
  from: days[index].date, to: days[index + width - 1].date,
  pnl: sum(days.slice(index, index + width).map((day) => day.pnl)) }));

let seed = 0x5f3759df;
const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
const blocks = Array.from({ length: days.length - BLOCK_DAYS + 1 }, (_, index) =>
  days.slice(index, index + BLOCK_DAYS).map((day) => day.approximateReturnRate));
const simulations = [];
for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample += 1) {
  const returns = [];
  while (returns.length < days.length) returns.push(...blocks[Math.floor(random() * blocks.length)]);
  let equity = 1_000; let peak = equity; let maxDrawdown = 0;
  for (const rate of returns.slice(0, days.length)) {
    equity *= Math.max(0.01, 1 + rate); peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  simulations.push({ netPnl: equity - 1_000, maxDrawdown });
}

const netPnls = simulations.map((row) => row.netPnl);
const drawdowns = simulations.map((row) => row.maxDrawdown);
const analysis = {
  generatedAt: new Date().toISOString(), candidate: result.config,
  observed: { days, activeDays: activeDays.length,
    positiveActiveDays: activeDays.filter((day) => day.pnl > 0).length,
    positiveActiveDayRate: activeDays.length ? activeDays.filter((day) => day.pnl > 0).length / activeDays.length : 0,
    averageActiveDayPnl: activeDays.length ? sum(activeDays.map((day) => day.pnl)) / activeDays.length : 0,
    medianActiveDayPnl: activeDays.length ? quantile(activeDays.map((day) => day.pnl), 0.5) : 0,
    worstDayPnl: Math.min(...days.map((day) => day.pnl)), bestDayPnl: Math.max(...days.map((day) => day.pnl)),
    rollingFiveDay: rolling(5), rollingTenDay: rolling(10) },
  bootstrap: { samples: BOOTSTRAP_SAMPLES, blockDays: BLOCK_DAYS,
    positiveMonthProbability: simulations.filter((row) => row.netPnl > 0).length / simulations.length,
    monthlyPnlP10: quantile(netPnls, 0.10), monthlyPnlMedian: quantile(netPnls, 0.50),
    monthlyPnlP90: quantile(netPnls, 0.90), drawdownMedian: quantile(drawdowns, 0.50),
    drawdownP90: quantile(drawdowns, 0.90) },
  gates: { discoveryPositive: result.discovery.netPnl > 0 && result.discovery.profitFactor >= 1.2,
    heldoutPositive: result.heldout.netPnl > 0 && result.heldout.profitFactor >= 1.1,
    majorityFiveDayPositive: result.discovery.positiveBuckets >= 2 && result.heldout.positiveBuckets >= 2,
    drawdownBounded: result.full.maxDrawdown <= 0.10 && result.heldout.maxDrawdown <= 0.10,
    stressPositive: result.stress.netPnl > 0 && result.stress.profitFactor >= 1.1,
    adverseEntryPositive: adverseResult.full.netPnl > 0 && adverseResult.full.profitFactor >= 1.1
      && adverseResult.full.maxDrawdown <= 0.15,
    concentrationBounded: result.full.largestPositiveSymbolShare <= 0.35,
    positiveDayBreadth: activeDays.filter((day) => day.pnl > 0).length / Math.max(activeDays.length, 1) >= 0.55,
    allRollingTenDayPositive: rolling(10).every((row) => row.pnl > 0) },
  base: { discovery: result.discovery, heldout: result.heldout, full: result.full, stress: result.stress },
  adverseEntry: adverseResult.full,
};
analysis.accepted = Object.values(analysis.gates).every(Boolean);
writeFileSync(OUTPUT, `${JSON.stringify(analysis, null, 2)}\n`);
console.log(JSON.stringify({ candidate: analysis.candidate.id, observed: analysis.observed,
  bootstrap: analysis.bootstrap, gates: analysis.gates, accepted: analysis.accepted }, null, 2));
