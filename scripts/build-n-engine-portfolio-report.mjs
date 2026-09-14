import { readFileSync, writeFileSync } from "node:fs";

const OUTPUT = process.env.RESEARCH_OUTPUT ?? "research-results/n-engine-phase-portfolio-2026-09-14.json";
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const sum = (values) => values.reduce((total, value) => total + value, 0);
const correlation = (left, right) => {
  const leftMean = sum(left) / left.length; const rightMean = sum(right) / right.length;
  const numerator = sum(left.map((value, index) => (value - leftMean) * (right[index] - rightMean)));
  const denominator = Math.sqrt(sum(left.map((value) => (value - leftMean) ** 2))
    * sum(right.map((value) => (value - rightMean) ** 2)));
  return denominator ? numerator / denominator : 0;
};
const compact = (report) => ({ config: report.final.config, accepted: report.final.accepted,
  gates: report.final.gates, discovery: report.final.discovery, validation: report.final.validation,
  blind: report.final.blind, full: report.final.full, higherCost: report.final.higherCost,
  doubledAdverseEntry: report.final.doubledAdverseEntry });

const relative = read("/tmp/specialist-relative-short.json");
const orderly = read("/tmp/specialist-orderly-short-v2.json");
const bull = read("/tmp/specialist-bull-leader.json");
const currentRelative = read("/tmp/crosscheck-relative-short-12m.json");
const currentOrderly = read("/tmp/crosscheck-orderly-short-12m.json");
const currentBull = read("/tmp/crosscheck-bull-leader-12m.json");
const longHorizonComponents = [relative, orderly];
const months = relative.dataset.months;
const monthly = months.map((month) => {
  const systems = Object.fromEntries(longHorizonComponents.map((report) => [report.final.config.id,
    report.final.full.monthlyPnls.find((row) => row.month === month)?.pnl ?? 0]));
  return { month, systems, pnl: sum(Object.values(systems)) };
});
const closed = longHorizonComponents.flatMap((report) => report.final.trades.map((trade) => ({
  closedAt: trade.closedAt, pnl: trade.netPnl }))).sort((left, right) => left.closedAt - right.closedAt);
let equity = 2_000; let peak = equity; let maxDrawdown = 0;
for (const trade of closed) {
  equity += trade.pnl; peak = Math.max(peak, equity);
  maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
}
const relativeMonthly = monthly.map((row) => row.systems[relative.final.config.id]);
const orderlyMonthly = monthly.map((row) => row.systems[orderly.final.config.id]);

const report = {
  generatedAt: new Date().toISOString(), decision: "NO_RELEASE", architectureTarget: "UNBOUNDED_PHASE_ENGINE_REGISTRY",
  conclusion: "No engine portfolio is qualified across both the 44-month hybrid replay and the current 12-month universe.",
  data: {
    longHorizon: { signalSource: relative.dataset.source, executionSource: "gate-official-monthly-futures-usdt-candlesticks-5m-v1",
      months: relative.dataset.months, symbols: relative.dataset.symbols, candles5m: 4_202_208,
      executionSha256: "9e5fd7d06eeee420d60318bee72de3b16e7e877247102a2b505453ab0b8a4522" },
    currentUniverse: { signalSource: currentRelative.dataset.source, executionSource: "gate-official-monthly-futures-usdt-candlesticks-5m-v1",
      months: currentRelative.dataset.months, symbols: currentRelative.dataset.symbols },
  },
  ledgerContract: { perEngineHypotheticalEquityU: 1_000, decisionsSizingRiskAndLifecycle: "independent",
    canonicalPaper: "copies every authorized engine order without capital gating",
    sameSymbolAcrossEngines: "allowed", live: "owner controlled; unchanged by research" },
  thresholds: { release: "strict per-engine stability plus split, cost, slippage, drawdown and concentration gates",
    portfolioComponent: "phase-specialist discovery floors plus positive validation/blind and stress tests",
    samples: "frequency-class floors scaled by split duration", crossUniverse: "required" },
  longHorizonCandidates: {
    relativePullbackShort: compact(relative), orderlyBearRelativeShort: compact(orderly),
    bullLeaderTrail: compact(bull),
  },
  illustrativeLongHorizonTwoShortPortfolio: {
    releaseQualified: false, reason: "Both components fail the current-universe cross-check.",
    startEquityU: 2_000, endEquityU: equity, netPnlU: equity - 2_000,
    averageMonthlyPnlU: (equity - 2_000) / months.length, maxDrawdown,
    positiveMonths: monthly.filter((row) => row.pnl > 0).length,
    activeMonths: monthly.filter((row) => row.pnl !== 0).length,
    monthlyCorrelation: correlation(relativeMonthly, orderlyMonthly), monthly,
  },
  currentUniverseCrossChecks: {
    relativePullbackShort: compact(currentRelative), orderlyBearRelativeShort: compact(currentOrderly),
    bullLeaderTrail: compact(currentBull),
  },
  familyDecisions: {
    keepForShadowResearch: ["RELATIVE_PULLBACK_RESUME_SHORT", "ORDERLY_TREND_RELATIVE_SHORT", "BULL_LEADER_TRAIL_LONG"],
    rejected: ["V4_CURRENT", "V5_CURRENT", "COMPRESSION_BREAK", "MACRO_TREND", "EXPANSION_CONTINUATION",
      "RANGE_EDGE_REVERSION", "FAILED_BREAKOUT_REVERSAL", "IDIOSYNCRATIC_REVERSAL",
      "PANIC_REVERSAL", "BULL_DIP_RESUME", "TIME_SERIES_MOMENTUM_TRAIL"],
    uncovered: ["validated bull trend", "balanced range", "compression release", "panic reversal", "regime transition"],
  },
  productionRecommendation: {
    v4v5FreshEntryAuthority: "DRAIN_AND_DISABLE",
    existingPositions: "continue their own lifecycle to close",
    replacementEngines: "SHADOW_ONLY_UNTIL_CROSS_UNIVERSE_QUALIFIED",
    deployNow: false,
  },
  limitations: [
    "The long-horizon universe contains eleven contracts with sufficient historical 5m coverage, not the full live top 30.",
    "Short signal gaps of at most three hours are flat-filled only in the hourly signal layer; execution uses unfilled official 5m candles.",
    "Funding and historical order-book depth are unavailable and are represented by conservative friction stress.",
    "The evaluation period has been inspected during iterative research and is no longer pristine blind data.",
  ],
};

writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: OUTPUT, decision: report.decision,
  illustrativePortfolio: report.illustrativeLongHorizonTwoShortPortfolio,
  currentUniverse: Object.fromEntries(Object.entries(report.currentUniverseCrossChecks)
    .map(([key, value]) => [key, { accepted: value.accepted, netPnlU: value.full.netPnl }])) }, null, 2));
