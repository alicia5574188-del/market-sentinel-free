import { readFileSync, writeFileSync } from "node:fs";

const INPUT = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-residual-44m.json";
const OUTPUT = process.env.RESEARCH_OUTPUT ?? "/tmp/residual-response-44m.json";
const FRICTION = Number(process.env.RESEARCH_FRICTION ?? 0.0014);
const ENTRY_SLIPPAGE = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);
const raw = JSON.parse(readFileSync(INPUT, "utf8"));
if (raw.interval !== "5m" || raw.months.length < 39) throw new Error("requires long-horizon 5m dataset");
const datasets = raw.datasets;
const STEP = 300;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const median = (values) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b); const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
};
const monthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1) / 1_000;
const nextMonth = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)), 1) / 1_000;
const from = monthStart(raw.months[0]); const to = nextMonth(raw.months.at(-1));
const discoveryEnd = monthStart(raw.months[30]); const validationEnd = monthStart(raw.months[38]);
const indexBySymbol = new Map(datasets.map(({ symbol, rows }) => [symbol, { rows, pointer: 0 }]));
const anchor = datasets.find((row) => row.symbol === "BTC_USDT") ?? datasets[0];

const configs = [];
for (const mode of ["FADE", "FOLLOW"]) for (const lookbackBars of [6, 12]) for (const zMin of [1.8, 2.3]) for (const confirmUnits of [0, .25]) {
  configs.push({ id: `${mode.toLowerCase()}-${lookbackBars}-${zMin}-${confirmUnits}`, mode, lookbackBars, zMin, confirmUnits,
    minResidual: lookbackBars === 6 ? .004 : .006, marketCap: lookbackBars === 6 ? .006 : .010,
    rewardRisk: mode === "FADE" ? 1.4 : 1.6, maxHoldBars: lookbackBars === 6 ? 12 : 18,
    stopPadUnits: .25, maxEntriesPerBar: 2, cooldownSeconds: 1_800 });
}
const state = new Map(configs.map((config) => [config.id, { config, trades: [], nextAllowed: new Map() }]));

function continuous(rows, index, back) {
  return index >= back && rows[index].time - rows[index - back].time === back * STEP;
}
function localUnit(rows, index) {
  if (!continuous(rows, index, 36)) return null;
  return median(rows.slice(index - 35, index + 1).map((row) => (row.high - row.low) / Math.max(row.close, 1e-12)));
}
function resolve(feature, side, config) {
  const { rows, index, unit } = feature; const next = rows[index + 1];
  if (!next || next.time !== rows[index].time + STEP) return null;
  const sign = side === "LONG" ? 1 : -1;
  const entry = next.open * (1 + sign * ENTRY_SLIPPAGE);
  const recent = rows.slice(index - 5, index + 1);
  const extreme = side === "LONG" ? Math.min(...recent.map((row) => row.low)) : Math.max(...recent.map((row) => row.high));
  const stop = side === "LONG" ? extreme - entry * unit * config.stopPadUnits : extreme + entry * unit * config.stopPadUnits;
  const risk = Math.abs(entry - stop); const riskRate = risk / Math.max(entry, 1e-12);
  if (!(risk > 0) || riskRate < .0015 || riskRate > .05) return null;
  const target = entry + sign * risk * config.rewardRisk;
  let exit = null; let closedAt = null; let reason = "MAX_HOLD";
  let lastTime = next.time;
  for (let offset = 1; offset <= config.maxHoldBars; offset += 1) {
    const row = rows[index + offset]; if (!row || row.time !== lastTime) return null;
    const hitStop = side === "LONG" ? row.low <= stop : row.high >= stop;
    const hitTarget = side === "LONG" ? row.high >= target : row.low <= target;
    if (hitStop || hitTarget) {
      exit = hitStop ? stop : target; reason = hitStop ? "STOP" : "TARGET"; closedAt = row.time; break;
    }
    lastTime += STEP;
  }
  if (exit == null) {
    const row = rows[index + config.maxHoldBars]; if (!row || row.time !== lastTime) return null;
    exit = row.close; closedAt = row.time;
  }
  const gross = sign * (exit / entry - 1); const netReturnRate = gross - FRICTION;
  return { symbol: feature.symbol, side, openedAt: next.time, closedAt, entry, exit, stop, target, reason,
    netReturnRate, grossReturnRate: gross, residual: feature.residual, robustZ: feature.robustZ,
    marketReturn: feature.marketReturn, unit, lookbackBars: config.lookbackBars };
}

for (let ai = 36; ai < anchor.rows.length - 20; ai += 1) {
  const time = anchor.rows[ai].time; const all = [];
  for (const [symbol, holder] of indexBySymbol) {
    const rows = holder.rows; let p = holder.pointer;
    while (p < rows.length && rows[p].time < time) p += 1; holder.pointer = p;
    if (p >= rows.length || rows[p].time !== time || !continuous(rows, p, 36) || !rows[p + 1] || rows[p + 1].time !== time + STEP) continue;
    const unit = localUnit(rows, p); if (!(unit > 0)) continue;
    const r1 = rows[p].close / rows[p - 1].close - 1;
    const f = { symbol, rows, index: p, unit, r1, returns: {} };
    for (const lookback of [6, 12]) if (continuous(rows, p, lookback)) f.returns[lookback] = rows[p].close / rows[p - lookback].close - 1;
    all.push(f);
  }
  if (all.length < 9) continue;
  const contexts = new Map();
  for (const lookback of [6, 12]) {
    const valid = all.filter((row) => Number.isFinite(row.returns[lookback])); if (valid.length < 9) continue;
    const marketReturn = median(valid.map((row) => row.returns[lookback]));
    const residuals = valid.map((row) => row.returns[lookback] - marketReturn);
    const sigma = Math.max(median(residuals.map((value) => Math.abs(value))) * 1.4826, 0.0005);
    contexts.set(lookback, valid.map((row) => ({ ...row, marketReturn, residual: row.returns[lookback] - marketReturn,
      robustZ: Math.abs(row.returns[lookback] - marketReturn) / sigma })));
  }
  for (const config of configs) {
    const rows = contexts.get(config.lookbackBars); if (!rows?.length) continue;
    if (Math.abs(rows[0].marketReturn) > config.marketCap) continue;
    const candidates = rows.flatMap((feature) => {
      const direction = Math.sign(feature.residual); if (!direction || Math.abs(feature.residual) < config.minResidual || feature.robustZ < config.zMin) return [];
      const alignedLatest = direction * feature.r1 / Math.max(feature.unit, 1e-9);
      if (config.mode === "FADE" ? alignedLatest > -config.confirmUnits : alignedLatest < config.confirmUnits) return [];
      const side = config.mode === "FADE" ? (direction > 0 ? "SHORT" : "LONG") : (direction > 0 ? "LONG" : "SHORT");
      return [{ feature, side, score: feature.robustZ }];
    }).sort((a, b) => b.score - a.score).slice(0, config.maxEntriesPerBar);
    const holder = state.get(config.id);
    for (const candidate of candidates) {
      if (time < (holder.nextAllowed.get(candidate.feature.symbol) ?? 0)) continue;
      const trade = resolve(candidate.feature, candidate.side, config); if (!trade) continue;
      holder.trades.push(trade); holder.nextAllowed.set(candidate.feature.symbol, trade.closedAt + config.cooldownSeconds);
    }
  }
}

function metrics(rows, start, end) {
  const trades = rows.filter((row) => row.openedAt >= start && row.openedAt < end).sort((a, b) => a.openedAt - b.openedAt);
  const gains = trades.filter((row) => row.netReturnRate > 0); const losses = trades.filter((row) => row.netReturnRate <= 0);
  const gain = sum(gains.map((row) => row.netReturnRate)); const loss = Math.abs(sum(losses.map((row) => row.netReturnRate)));
  const byMonth = new Map(); const bySymbol = new Map(); let equity = 1; let peak = 1; let maxDrawdown = 0;
  for (const trade of trades) {
    const month = new Date(trade.openedAt * 1000).toISOString().slice(0, 7).replace("-", "");
    byMonth.set(month, (byMonth.get(month) ?? 0) + trade.netReturnRate);
    bySymbol.set(trade.symbol, (bySymbol.get(trade.symbol) ?? 0) + trade.netReturnRate);
    equity += trade.netReturnRate; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / Math.max(peak, 1e-9));
  }
  const positiveSymbolPnls = [...bySymbol.values()].filter((value) => value > 0); const positiveTotal = sum(positiveSymbolPnls);
  return { trades: trades.length, netReturnSum: sum(trades.map((row) => row.netReturnRate)), profitFactor: loss ? gain / loss : gain ? 99 : 0,
    winRate: trades.length ? gains.length / trades.length : 0, activeMonths: byMonth.size,
    positiveMonths: [...byMonth.values()].filter((value) => value > 0).length, monthly: Object.fromEntries([...byMonth].sort()),
    largestPositiveSymbolShare: positiveTotal ? Math.max(...positiveSymbolPnls, 0) / positiveTotal : 0, maxDrawdown };
}
const blockStarts = [0, 6, 12, 18, 24].map((index) => monthStart(raw.months[index]));
const blockEnds = [6, 12, 18, 24, 30].map((index) => monthStart(raw.months[index]));
const rows = [...state.values()].map(({ config, trades }) => {
  const discovery = metrics(trades, from, discoveryEnd); const validation = metrics(trades, discoveryEnd, validationEnd);
  const evaluation = metrics(trades, validationEnd, to); const full = metrics(trades, from, to);
  const discoveryBlocks = blockStarts.map((start, index) => metrics(trades, start, blockEnds[index]));
  const positiveBlocks = discoveryBlocks.filter((row) => row.netReturnSum > 0 && row.profitFactor >= 1).length;
  const discoveryQualified = discovery.trades >= 300 && discovery.netReturnSum > 0 && discovery.profitFactor >= 1.08
    && discovery.positiveMonths >= Math.ceil(discovery.activeMonths * .55) && positiveBlocks >= 3
    && discovery.largestPositiveSymbolShare <= .5 && discovery.maxDrawdown <= .35;
  return { config, discoveryQualified, positiveDiscoverySixMonthBlocks: positiveBlocks,
    discovery, validation, evaluation, full, discoveryBlocks };
}).sort((a, b) => (b.discovery.profitFactor - 1) * Math.sqrt(b.discovery.trades) - (a.discovery.profitFactor - 1) * Math.sqrt(a.discovery.trades));
const selected = rows.find((row) => row.discoveryQualified) ?? null;
const decision = selected && selected.validation.trades >= 80 && selected.validation.netReturnSum > 0 && selected.validation.profitFactor >= 1
  && selected.evaluation.trades >= 60 && selected.evaluation.netReturnSum > 0 && selected.evaluation.profitFactor >= 1 ? "FORWARD_CANDIDATE" : "NO_RELEASE";
const report = { generatedAt: new Date().toISOString(), data: { source: raw.source, sha256: raw.sha256, months: raw.months,
  symbols: raw.symbols, rows: sum(raw.datasets.map((row) => row.rows.length)) }, scenario: { friction: FRICTION, entrySlippage: ENTRY_SLIPPAGE },
  architecture: "CROSS_SECTIONAL_RESIDUAL_RESPONSE", configsTested: configs.length, decision,
  selected, leaderboard: rows.slice(0, 16) };
writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output: OUTPUT, decision, selected: selected && { id: selected.config.id, discovery: selected.discovery,
  validation: selected.validation, evaluation: selected.evaluation }, leaderboard: report.leaderboard.map((row) => ({ id: row.config.id,
  dq: row.discoveryQualified, dN: row.discovery.trades, dPF: row.discovery.profitFactor, dNet: row.discovery.netReturnSum,
  vN: row.validation.trades, vPF: row.validation.profitFactor, vNet: row.validation.netReturnSum,
  eN: row.evaluation.trades, ePF: row.evaluation.profitFactor, eNet: row.evaluation.netReturnSum })) }, null, 2));
