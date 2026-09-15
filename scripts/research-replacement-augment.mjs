import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "scripts/research-regime-system-portfolios.mjs";
const TEMP = "/tmp/research-regime-replacement-injected.mjs";
const REPLACEMENT_OUTPUT = process.env.REPLACEMENT_OUTPUT ?? "/tmp/replacement-augment.json";

const source = readFileSync(SOURCE, "utf8");
const marker = "const report = { generatedAt: new Date().toISOString(),";
if (!source.includes(marker)) throw new Error("research-regime-system-portfolios marker changed");

const injection = String.raw`
// ---- research-only replacement augmentation scan ----
const replacementOutput = process.env.REPLACEMENT_OUTPUT ?? "/tmp/replacement-augment.json";
const selectedTacticsBySystem = new Map(SYSTEMS.map((system) => [system,
  new Set((selectedBySystem.get(system)?.configs ?? []).map((config) => config.tactic))]));
const extraMinimumTrades = (system) => ["SHOCK_TRANSITION", "COMPRESSION"].includes(system) ? 15 : 24;
const discoveryExtraRows = [];
for (const config of activeConfigs) {
  if (selectedTacticsBySystem.get(config.system)?.has(config.tactic)) continue;
  const account = portfolio(rawTrades(config, toMs), configById);
  const stressAccount = portfolio(rawTrades(config, toMs, STRESS_FRICTION), configById);
  const discovery = metrics(account, fromMs, discoveryEnd);
  const stressDiscovery = metrics(stressAccount, fromMs, discoveryEnd);
  const folds = discoveryFoldMetrics(account);
  const stressFolds = discoveryFoldMetrics(stressAccount);
  const minTrades = extraMinimumTrades(config.system);
  const passes = discovery.trades >= minTrades
    && discovery.netPnl > 0 && discovery.profitFactor >= 1.08 && discovery.maxDrawdown <= 0.18
    && discovery.positiveMonths >= Math.ceil(discovery.activeMonths * 0.50)
    && discovery.largestPositiveSymbolShare <= 0.55
    && folds.filter((fold) => fold.netPnl > 0).length >= 2 && folds.at(-1).netPnl > 0
    && stressDiscovery.netPnl > 0 && stressDiscovery.profitFactor >= 1.03
    && stressDiscovery.positiveMonths >= Math.ceil(stressDiscovery.activeMonths * 0.45)
    && stressFolds.filter((fold) => fold.netPnl > 0).length >= 2 && stressFolds.at(-1).netPnl > 0;
  if (!passes) continue;
  const validation = metrics(account, discoveryEnd, validationEnd);
  const evaluation = metrics(account, validationEnd, toMs);
  const stressValidation = metrics(stressAccount, discoveryEnd, validationEnd);
  const stressEvaluation = metrics(stressAccount, validationEnd, toMs);
  discoveryExtraRows.push({ config, account, stressAccount, discovery, stressDiscovery, folds, stressFolds,
    validation, evaluation, stressValidation, stressEvaluation,
    discoveryScore: Math.min(discovery.netPnl, stressDiscovery.netPnl)
      + Math.min(discovery.positiveMonths, stressDiscovery.positiveMonths) * 8
      - Math.max(discovery.maxDrawdown, stressDiscovery.maxDrawdown) * 500 });
}

const extraRepresentatives = [];
for (const system of SYSTEMS) {
  const tactics = [...new Set(discoveryExtraRows.filter((row) => row.config.system === system).map((row) => row.config.tactic))];
  for (const tactic of tactics) {
    const winner = discoveryExtraRows.filter((row) => row.config.system === system && row.config.tactic === tactic)
      .sort((a, b) => b.discoveryScore - a.discoveryScore)[0];
    if (winner) extraRepresentatives.push(winner);
  }
}

function compactReplacementMetric(value) {
  return { trades: value.trades, netPnl: value.netPnl, profitFactor: value.profitFactor,
    maxDrawdown: value.maxDrawdown, activeMonths: value.activeMonths, positiveMonths: value.positiveMonths,
    largestPositiveSymbolShare: value.largestPositiveSymbolShare };
}
function discoveryPortfolioMetric(configs, friction = FRICTION, slippage = ENTRY_SLIPPAGE) {
  const account = portfolio(configs.flatMap((config) => rawTrades(config, discoveryEnd, friction, slippage))
    .sort((a, b) => a.openedAt - b.openedAt || b.strength - a.strength), configById);
  return metrics(account, fromMs, discoveryEnd);
}

const augmentedSelections = new Map();
const systemSearch = [];
for (const system of SYSTEMS) {
  const baselineSelection = selectedBySystem.get(system);
  const baselineConfigs = baselineSelection?.configs ?? [];
  const baselineBase = discoveryPortfolioMetric(baselineConfigs);
  const baselineStress = discoveryPortfolioMetric(baselineConfigs, STRESS_FRICTION);
  const candidates = extraRepresentatives.filter((row) => row.config.system === system)
    .sort((a, b) => b.discoveryScore - a.discoveryScore).slice(0, 10);
  let best = { configs: baselineConfigs, extras: [], base: baselineBase, stress: baselineStress,
    score: baselineBase.trades + baselineBase.netPnl * 0.15 + baselineBase.positiveMonths * 4 - baselineBase.maxDrawdown * 250 };
  const maxMask = 1 << candidates.length;
  for (let mask = 1; mask < maxMask; mask += 1) {
    const extras = candidates.filter((_, index) => mask & (1 << index));
    if (extras.length > 4) continue;
    const configs = [...baselineConfigs, ...extras.map((row) => row.config)];
    const base = discoveryPortfolioMetric(configs);
    const stress = discoveryPortfolioMetric(configs, STRESS_FRICTION);
    const tradeGain = base.trades - baselineBase.trades;
    if (tradeGain < Math.max(6, baselineBase.trades * 0.05)) continue;
    if (base.netPnl < baselineBase.netPnl * 0.90 || stress.netPnl < baselineStress.netPnl * 0.85) continue;
    if (base.profitFactor < Math.max(1.08, baselineBase.profitFactor * 0.88)
      || stress.profitFactor < Math.max(1.03, baselineStress.profitFactor * 0.86)) continue;
    if (base.maxDrawdown > Math.min(0.20, baselineBase.maxDrawdown + 0.035)
      || stress.maxDrawdown > Math.min(0.20, baselineStress.maxDrawdown + 0.04)) continue;
    if (base.positiveMonths < baselineBase.positiveMonths - 1 || base.largestPositiveSymbolShare > 0.55) continue;
    const score = tradeGain * 3 + base.netPnl * 0.12 + stress.netPnl * 0.08
      + base.positiveMonths * 5 - base.maxDrawdown * 300;
    if (score > best.score) best = { configs, extras, base, stress, score };
  }
  augmentedSelections.set(system, { mode: "DISCOVERY_FREQUENCY_AUGMENT", configs: best.configs });
  systemSearch.push({ system,
    baseline: { strategyIds: baselineConfigs.map((row) => row.id), base: compactReplacementMetric(baselineBase),
      stress: compactReplacementMetric(baselineStress) },
    discoverySelectedExtras: best.extras.map((row) => ({ id: row.config.id, tactic: row.config.tactic,
      discovery: compactReplacementMetric(row.discovery), stressDiscovery: compactReplacementMetric(row.stressDiscovery),
      validation: compactReplacementMetric(row.validation), evaluation: compactReplacementMetric(row.evaluation),
      stressValidation: compactReplacementMetric(row.stressValidation), stressEvaluation: compactReplacementMetric(row.stressEvaluation) })),
    augmentedDiscovery: compactReplacementMetric(best.base), augmentedStressDiscovery: compactReplacementMetric(best.stress) });
}

const augmentedSystems = SYSTEMS.map((system) => evaluateSystem(system, augmentedSelections.get(system)));
const augmentedCombined = {
  base: combinedResult(augmentedSystems.filter((row) => row.account), "account", "full"),
  higherCost: combinedResult(augmentedSystems.filter((row) => row.account), "stressAccount", "higherCost"),
  doubledAdverseEntry: combinedResult(augmentedSystems.filter((row) => row.account), "adverseAccount", "doubledAdverseEntry"),
};
function combinedTradeStats(rows, accountKey, start, end) {
  const trades = rows.flatMap((row) => row[accountKey]?.trades ?? [])
    .filter((trade) => trade.openedAt >= start && trade.openedAt < end);
  const wins = trades.filter((row) => row.netPnl > 0); const losses = trades.filter((row) => row.netPnl <= 0);
  const gain = sum(wins.map((row) => row.netPnl)); const loss = Math.abs(sum(losses.map((row) => row.netPnl)));
  return { trades: trades.length, netPnl: sum(trades.map((row) => row.netPnl)),
    winRate: trades.length ? wins.length / trades.length : 0, profitFactor: loss ? gain / loss : gain ? 99 : 0 };
}
const baselineStats = {
  discovery: combinedTradeStats(candidateSystems, "account", fromMs, discoveryEnd),
  validation: combinedTradeStats(candidateSystems, "account", discoveryEnd, validationEnd),
  evaluation: combinedTradeStats(candidateSystems, "account", validationEnd, toMs),
};
const augmentedStats = {
  discovery: combinedTradeStats(augmentedSystems, "account", fromMs, discoveryEnd),
  validation: combinedTradeStats(augmentedSystems, "account", discoveryEnd, validationEnd),
  evaluation: combinedTradeStats(augmentedSystems, "account", validationEnd, toMs),
  stressEvaluation: combinedTradeStats(augmentedSystems, "stressAccount", validationEnd, toMs),
  adverseEvaluation: combinedTradeStats(augmentedSystems, "adverseAccount", validationEnd, toMs),
};
const evaluationDays = (toMs - validationEnd) / 86_400_000;
const baseEvaluationPerDay = baselineStats.evaluation.trades / evaluationDays;
const augmentedEvaluationPerDay = augmentedStats.evaluation.trades / evaluationDays;
const replacementGates = {
  allFiveSystemsPassOriginalHeldoutGates: augmentedSystems.every((row) => row.accepted),
  evaluationFrequencyImproves25pct: augmentedStats.evaluation.trades >= baselineStats.evaluation.trades * 1.25,
  evaluationProfitPositive: augmentedStats.evaluation.netPnl > 0,
  evaluationProfitFactor: augmentedStats.evaluation.profitFactor >= 1.10,
  stressedEvaluationPositive: augmentedStats.stressEvaluation.netPnl > 0 && augmentedStats.stressEvaluation.profitFactor >= 1.05,
  adverseEvaluationPositive: augmentedStats.adverseEvaluation.netPnl > 0 && augmentedStats.adverseEvaluation.profitFactor >= 1.05,
  chronologicalCombinedPositive: augmentedCombined.base.discovery.netPnl > 0
    && augmentedCombined.base.validation.netPnl > 0 && augmentedCombined.base.evaluation.netPnl > 0,
  combinedDrawdownUnder8pct: augmentedCombined.base.maxDrawdown <= 0.08,
};
const replacementResearch = {
  generatedAt: new Date().toISOString(),
  selectionRule: "Extras selected strictly from first 30 discovery months using three discovery folds and higher-cost stress; validation/evaluation are reported only after selection.",
  baseline: { stats: baselineStats, evaluationTradesPerDay: baseEvaluationPerDay,
    combined: candidateCombined.base },
  discoveryQualifiedExtraTacticRepresentatives: extraRepresentatives.map((row) => ({
    id: row.config.id, system: row.config.system, tactic: row.config.tactic,
    discovery: compactReplacementMetric(row.discovery), stressDiscovery: compactReplacementMetric(row.stressDiscovery),
    validation: compactReplacementMetric(row.validation), evaluation: compactReplacementMetric(row.evaluation) })),
  systemSearch,
  augmentedSystems: augmentedSystems.map((row) => ({ system: row.system, accepted: row.accepted,
    strategyIds: row.selectedStrategies?.map((config) => config.id) ?? [], gates: row.gates,
    discovery: row.discovery && compactReplacementMetric(row.discovery),
    validation: row.validation && compactReplacementMetric(row.validation),
    evaluation: row.evaluation && compactReplacementMetric(row.evaluation),
    full: row.full && compactReplacementMetric(row.full) })),
  augmented: { stats: augmentedStats, evaluationTradesPerDay: augmentedEvaluationPerDay,
    combined: augmentedCombined },
  replacementGates,
  replacementCandidate: Object.values(replacementGates).every(Boolean),
};
writeFileSync(replacementOutput, JSON.stringify(replacementResearch, null, 2) + "\n");
console.log("REPLACEMENT_RESEARCH=" + JSON.stringify({
  replacementCandidate: replacementResearch.replacementCandidate,
  baselineEvaluation: baselineStats.evaluation,
  augmentedEvaluation: augmentedStats.evaluation,
  baselineEvaluationPerDay: baseEvaluationPerDay,
  augmentedEvaluationPerDay,
  gates: replacementGates,
  extras: systemSearch.map((row) => ({ system: row.system,
    extras: row.discoverySelectedExtras.map((extra) => extra.id) })),
}));
// ---- end research-only replacement augmentation scan ----
`;

writeFileSync(TEMP, source.replace(marker, `${injection}\n${marker}`));
process.env.REPLACEMENT_OUTPUT = REPLACEMENT_OUTPUT;
await import(`file://${TEMP}?ts=${Date.now()}`);
