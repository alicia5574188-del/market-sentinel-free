import { readFileSync, writeFileSync } from "node:fs";

const paths = {
  v5: process.env.V5_AUDIT ?? "/tmp/phase-specialist-v5-audit.json",
  v4: process.env.V4_AUDIT ?? "/tmp/v4-12m-final.json",
  macro: process.env.MACRO_AUDIT ?? "/tmp/macro-cache-parity.json",
  compression: process.env.COMPRESSION_AUDIT ?? "/tmp/compression-3-1.5.json",
  panic: process.env.PANIC_AUDIT ?? "/tmp/panic-reversal-grid.json",
  output: process.env.RESEARCH_OUTPUT ?? "research-results/phase-specialist-portfolio-2026-09-13.json",
};
const load = (path) => JSON.parse(readFileSync(path, "utf8"));
const [v5, v4, macro, compression, panic] = [paths.v5, paths.v4, paths.macro, paths.compression, paths.panic].map(load);
const compactPeriod = (value) => ({ trades: value.trades, netPnlU: value.netPnl,
  profitFactor: value.profitFactor, maxDrawdown: value.maxDrawdown,
  positiveActiveMonths: `${value.positiveMonths}/${value.activeMonths
    ?? value.monthlyPnls?.filter((row) => row.pnl !== 0).length ?? 0}` });
const v4Result = v4.results[0]; const macroFinal = macro.final; const compressionFinal = compression.final;
const monthMap = (rows) => new Map(rows.map((row) => [row.month, row.pnl]));
const macroMonths = monthMap(macroFinal.full.monthlyPnls); const compressionMonths = monthMap(compressionFinal.full.monthlyPnls);
const recentMonths = v5.split.discovery.concat(v5.split.validation, v5.split.evaluation);
const shadowMonthly = recentMonths.map((month) => ({ month,
  macroTrendU: macroMonths.get(month) ?? 0, compressionBreakU: compressionMonths.get(month) ?? 0,
  combinedU: (macroMonths.get(month) ?? 0) + (compressionMonths.get(month) ?? 0) }));
const sum = (values) => values.reduce((total, value) => total + value, 0);
const pearson = (left, right) => {
  const leftMean = sum(left) / left.length; const rightMean = sum(right) / right.length;
  const covariance = sum(left.map((value, index) => (value - leftMean) * (right[index] - rightMean)));
  const denominator = Math.sqrt(sum(left.map((value) => (value - leftMean) ** 2))
    * sum(right.map((value) => (value - rightMean) ** 2)));
  return denominator ? covariance / denominator : 0;
};
const candidateSummary = (value) => ({ config: value.config.id, discovery: compactPeriod(value.discovery),
  validation: compactPeriod(value.validation), finalEvaluation: compactPeriod(value.blind), full: compactPeriod(value.full),
  stressGates: { higherCost: value.gates.higherCost, doubledAdverseEntry: value.gates.doubledAdverseEntry },
  concentration: value.full.largestPositiveSymbolShare });

const report = {
  generatedAt: new Date().toISOString(), decision: "NO_PRODUCTION_CUTOVER_FORWARD_SHADOW_REQUIRED",
  objective: "Maximize defensible monthly after-cost profit by adding independent phase-specialist engines; uncovered phases remain WAIT.",
  executionContract: {
    engineLedger: "Every engine owns an independent hypothetical 1000U account, decisions, risk, positions and lifecycle.",
    canonicalPaper: "Copy 100% of every approved engine order; do not resize or reject based on canonical account equity.",
    sameSymbol: "Different engines may hold the same contract simultaneously and retain separate legs.",
    live: "Owner-controlled Gate LIVE remains an execution sink with exchange-level safety only; no transfers.",
  },
  productionAudit: {
    v5: { status: v5.status, dataset: v5.datasetSha256, candidates: v5.candidates,
      acceptedStrategyPhases: v5.acceptedStrategyPhases.map((row) => row.key),
      independent1000U: { endEquity: v5.unrestrictedPortfolio.endEquity,
        netPnlU: v5.unrestrictedPortfolio.netPnlU, profitFactor: v5.unrestrictedPortfolio.profitFactor,
        maxDrawdown: v5.unrestrictedPortfolio.maxDrawdown,
        positiveActiveMonths: `${v5.unrestrictedPortfolio.positiveMonths}/${v5.unrestrictedPortfolio.activeMonths}` },
      conclusion: "No V5 strategy/phase pair was positive in discovery, validation and evaluation; V5 owns no fixed phase." },
    v4: { status: "FAILED_TWELVE_MONTH_PRODUCTION_PARITY",
      independent1000U: compactPeriod(v4Result.full), stress: compactPeriod(v4Result.stress),
      segments: { discovery: compactPeriod(v4Result.discovery), validation: compactPeriod(v4Result.validation),
        finalEvaluation: compactPeriod(v4Result.blind) },
      conclusion: "The current V4 authority profile is recent-regime positive but negative over the full twelve months." },
  },
  phaseRegistry: [
    { phase: "MACRO_DIRECTIONAL_BREAKOUT", owner: "macro-six-hourly", status: "FORWARD_SHADOW_ONLY",
      evidence: candidateSummary(macroFinal), blockers: ["Only 23/41 active months positive.",
        "Final evaluation has only 2/5 positive active months.", "Later-period cost gates fail.",
        "The later periods are no longer an untouched blind set."] },
    { phase: "POST_COMPRESSION_VOLUME_BREAKOUT", owner: "compression-hourly", status: "FORWARD_SHADOW_ONLY",
      evidence: candidateSummary(compressionFinal), blockers: [
        `Largest positive-symbol share ${(compressionFinal.full.largestPositiveSymbolShare * 100).toFixed(1)}% exceeds the 35% cap.`,
        "The later periods are no longer an untouched blind set."] },
    { phase: "PANIC_REVERSAL", owner: null, status: "WAIT", evidence: panic.final ? candidateSummary(panic.final) : null,
      blockers: ["Selected discovery candidate lost money in final evaluation.", "Higher-cost and adverse-entry later gates fail."] },
    { phase: "MACRO_TREND_PULLBACK", owner: null, status: "WAIT", blockers: ["No discovery configuration passed."] },
    { phase: "BALANCED_RANGE_REVERSION", owner: null, status: "WAIT", blockers: ["No discovery configuration passed."] },
    { phase: "VOLATILITY_EXPANSION_CONTINUATION", owner: null, status: "WAIT", blockers: ["No discovery configuration passed."] },
    { phase: "TRANSITION_OR_UNCERTAIN", owner: null, status: "WAIT", blockers: ["No causal stable edge; capital preservation is the strategy."] },
  ],
  shadowPortfolioIllustration: {
    warning: "Illustration only: both candidates were selected after later-period inspection and are not release-qualified.",
    hypotheticalAccounts: 2, startingCapitalU: 2_000,
    recentTwelveMonthNetPnlU: sum(shadowMonthly.map((row) => row.combinedU)),
    averageMonthlyNetPnlU: sum(shadowMonthly.map((row) => row.combinedU)) / shadowMonthly.length,
    positiveMonths: shadowMonthly.filter((row) => row.combinedU > 0).length,
    monthlyPnlCorrelation: pearson(shadowMonthly.map((row) => row.macroTrendU), shadowMonthly.map((row) => row.compressionBreakU)),
    monthly: shadowMonthly,
  },
  admissionPolicy: {
    discovery: "Minimum sample, positive net, PF >= 1.15, bounded drawdown, majority positive active months and broad symbol support.",
    laterSegments: "Positive after costs in validation and final evaluation, including higher friction and doubled adverse entry.",
    incrementalPortfolio: "Must add net profit or reduce drawdown/return correlation without changing another engine's ledger.",
    release: "Freeze parameters, then pass prospective forward shadow because all available historical later periods have been viewed.",
    gaps: "A gap is WAIT, never a forced order.",
  },
  productionChanged: false,
};
writeFileSync(paths.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: paths.output, decision: report.decision,
  v5: report.productionAudit.v5.independent1000U, v4: report.productionAudit.v4.independent1000U,
  phaseStatuses: report.phaseRegistry.map(({ phase, owner, status }) => ({ phase, owner, status })),
  shadowPortfolioIllustration: report.shadowPortfolioIllustration }, null, 2));
