import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const sourcePath = "scripts/research-v12.mjs";
const generatedPath = "scripts/.research-v12-microcell-generated.mjs";
const outputPath = process.env.RESEARCH_OUTPUT ?? "/tmp/v12-microcell-discovery.json";
const friction = Number(process.env.RESEARCH_FRICTION ?? 0.0014);
const entrySlippage = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);
const minContextMarkets = Number(process.env.RESEARCH_MIN_CONTEXT_MARKETS ?? 9);

let source = readFileSync(sourcePath, "utf8");
source = source.replace('import { readFileSync } from "node:fs";', 'import { readFileSync, writeFileSync } from "node:fs";')
  .replace('import { buildStrategyCoverageReport, deriveMarketStateFeatures } from "../lib/strategy-coverage.ts";',
    'import { buildStrategyCoverageReport, classifyMarketState, deriveMarketStateFeatures } from "../lib/strategy-coverage.ts";')
  .replace("const FRICTION = 0.0014;", `const FRICTION = ${JSON.stringify(friction)};`)
  .replace("const ENTRY_SLIPPAGE = 0.00025;", `const ENTRY_SLIPPAGE = ${JSON.stringify(entrySlippage)};`)
  .replace("for (const { rows } of datasets) for (let index = 6; index < rows.length; index += 1) {",
    `for (const { rows } of datasets) for (let index = 6; index < rows.length; index += 1) {\n  if (rows[index].time - rows[index - 6].time !== 1_800) continue;`)
  .replace("for (let index = 120; index < rows.length - 1; index += 1) {",
    `for (let index = 120; index < rows.length - 1; index += 1) {\n      if (rows[index].time - rows[index - 119].time !== 35_700 || rows[index + 1].time !== rows[index].time + 300) continue;`)
  .replace("const row = rows[index + offset];",
    `const row = rows[index + offset];\n    if (row.time !== rows[index + offset - 1].time + 300) return null;`)
  .replace("if (!context || context.markets < 12) continue;",
    `if (!context || context.markets < ${JSON.stringify(minContextMarkets)}) continue;`)
  .replace("const results = variants.map((config, index) => {", `const frozenIndex = ({\"潮接\":2,\"潮补\":2,\"静移\":2,\"冲衡\":0})[name];\n  if (frozenIndex == null) return [];\n  const results = variants.map((config, index) => ({ config, index })).filter((row) => row.index === frozenIndex).map(({ config, index }) => {`);

const tailAt = source.indexOf("const acceptedPhase =");
if (tailAt < 0) throw new Error("Unable to locate V12 research tail");
source = source.slice(0, tailAt);
source += `
const frozenIds = new Set(["tide_relay:2", "tide_catchup:2", "quiet_drift:2", "impulse_recoil:0"]);
const rawTrades = coverageTrades.filter((row) => frozenIds.has(row.strategyId));
const monthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1);
const nextMonth = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)), 1);
const from = monthStart(raw.months[0]); const to = nextMonth(raw.months.at(-1));
const discoveryEnd = monthStart(raw.months[30]); const validationEnd = monthStart(raw.months[38]);
const sum = (values) => values.reduce((total, value) => total + value, 0);
const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7).replace("-", "");
function metric(rows) {
  const gain = sum(rows.filter((row) => row.netReturnRate > 0).map((row) => row.netReturnRate));
  const loss = Math.abs(sum(rows.filter((row) => row.netReturnRate <= 0).map((row) => row.netReturnRate)));
  const byMonth = new Map(); const bySymbol = new Map();
  for (const row of rows) {
    const month = monthKey(row.openedAt); byMonth.set(month, (byMonth.get(month) ?? 0) + row.netReturnRate);
    bySymbol.set(row.symbol, (bySymbol.get(row.symbol) ?? 0) + row.netReturnRate);
  }
  const positives = [...bySymbol.values()].filter((value) => value > 0); const totalPositive = sum(positives);
  const largestPositiveSymbolShare = totalPositive > 0 ? Math.max(...positives, 0) / totalPositive : 0;
  const net = sum(rows.map((row) => row.netReturnRate));
  return { trades: rows.length, netReturnSum: net, profitFactor: loss ? gain / loss : gain ? 99 : 0,
    winRate: rows.length ? rows.filter((row) => row.netReturnRate > 0).length / rows.length : 0,
    activeMonths: byMonth.size, positiveMonths: [...byMonth.values()].filter((value) => value > 0).length,
    largestPositiveSymbolShare };
}
const compact = (value) => ({ trades: value.trades, netReturnSum: value.netReturnSum, profitFactor: value.profitFactor,
  winRate: value.winRate, activeMonths: value.activeMonths, positiveMonths: value.positiveMonths,
  largestPositiveSymbolShare: value.largestPositiveSymbolShare });
function moveBand(value) { const x = Math.abs(value); return x < .0012 ? "QUIET" : x < .003 ? "MILD" : x < .006 ? "STRONG" : "EXTREME"; }
function breadthBand(value) { return value <= .25 ? "VERY_DOWN" : value <= .38 ? "DOWN" : value < .62 ? "MIXED" : value < .75 ? "UP" : "VERY_UP"; }
function efficiencyBand(value) { return value < .2 ? "E0" : value < .4 ? "E1" : value < .6 ? "E2" : "E3"; }
function volatilityBand(value) { return value < .6 ? "V0" : value < .9 ? "V1" : value < 1.2 ? "V2" : value < 1.6 ? "V3" : "V4"; }
function session(ms) { const h = new Date(ms).getUTCHours(); return h < 6 ? "S00_05" : h < 12 ? "S06_11" : h < 18 ? "S12_17" : "S18_23"; }
function weekPart(ms) { const day = new Date(ms).getUTCDay(); return day === 0 || day === 6 ? "WEEKEND" : "WEEKDAY"; }
const groups = new Map();
function add(kind, key, row) { const id = kind + "|" + key; const item = groups.get(id) ?? { id, kind, key, trades: [] }; item.trades.push(row); groups.set(id, item); }
for (const row of rawTrades) {
  const state = classifyMarketState(row.state); const family = row.strategyId;
  const base = family + "|" + state.key;
  add("FAMILY_STATE", base, row);
  add("FAMILY_STATE_SIDE", base + "|" + row.side, row);
  add("FAMILY_STATE_SESSION", base + "|" + session(row.openedAt), row);
  add("FAMILY_STATE_WEEKPART", base + "|" + weekPart(row.openedAt), row);
  add("FAMILY_STATE_MOVE", base + "|" + moveBand(row.state.marketMedianMove), row);
  add("FAMILY_STATE_BREADTH", base + "|" + breadthBand(row.state.marketBreadth), row);
  add("FAMILY_STATE_EFF", base + "|" + efficiencyBand(row.state.trendEfficiency), row);
  add("FAMILY_STATE_VOL", base + "|" + volatilityBand(row.state.volatilityRatio), row);
}
const blockStarts = [0, 6, 12, 18, 24].map((offset) => monthStart(raw.months[offset]));
const blockEnds = [6, 12, 18, 24, 30].map((offset) => monthStart(raw.months[offset]));
const audit = [...groups.values()].map((group) => {
  const discoveryRows = group.trades.filter((row) => row.openedAt >= from && row.openedAt < discoveryEnd);
  const validationRows = group.trades.filter((row) => row.openedAt >= discoveryEnd && row.openedAt < validationEnd);
  const evaluationRows = group.trades.filter((row) => row.openedAt >= validationEnd && row.openedAt < to);
  const discovery = metric(discoveryRows); const validation = metric(validationRows); const evaluation = metric(evaluationRows);
  const sixMonthBlocks = blockStarts.map((start, index) => metric(discoveryRows.filter((row) => row.openedAt >= start && row.openedAt < blockEnds[index])));
  const positiveSixMonthBlocks = sixMonthBlocks.filter((row) => row.netReturnSum > 0 && row.profitFactor >= 1).length;
  const discoveryQualified = discovery.trades >= 120 && discovery.netReturnSum > 0 && discovery.profitFactor >= 1.08
    && discovery.activeMonths >= 12 && discovery.positiveMonths >= Math.ceil(discovery.activeMonths * .5)
    && positiveSixMonthBlocks >= 3 && discovery.largestPositiveSymbolShare <= .5;
  const validationPass = validation.trades >= 30 && validation.netReturnSum > 0 && validation.profitFactor >= 1;
  const evaluationPass = evaluation.trades >= 20 && evaluation.netReturnSum > 0 && evaluation.profitFactor >= 1;
  return { id: group.id, kind: group.kind, key: group.key, discoveryQualified, validationPass, evaluationPass,
    positiveSixMonthBlocks, discovery: compact(discovery), validation: compact(validation), evaluation: compact(evaluation),
    discoverySixMonth: sixMonthBlocks.map(compact) };
});
const discoveryQualified = audit.filter((row) => row.discoveryQualified).sort((a, b) =>
  (b.discovery.profitFactor - 1) * Math.sqrt(b.discovery.trades) - (a.discovery.profitFactor - 1) * Math.sqrt(a.discovery.trades));
const triplePass = discoveryQualified.filter((row) => row.validationPass && row.evaluationPass);
const report = { generatedAt: new Date().toISOString(), dataset: { source: raw.source, sha256: raw.sha256,
  months: raw.months, symbols: raw.symbols, rows: raw.datasets.reduce((total, row) => total + row.rows.length, 0), minContextMarkets: ${JSON.stringify(minContextMarkets)} },
  scenario: { friction: FRICTION, entrySlippage: ENTRY_SLIPPAGE }, rawTradeCount: rawTrades.length,
  segmentKinds: ["FAMILY_STATE", "FAMILY_STATE_SIDE", "FAMILY_STATE_SESSION", "FAMILY_STATE_WEEKPART", "FAMILY_STATE_MOVE", "FAMILY_STATE_BREADTH", "FAMILY_STATE_EFF", "FAMILY_STATE_VOL"],
  gates: { discoveryTrades: 120, discoveryProfitFactor: 1.08, discoveryActiveMonths: 12, discoveryPositiveMonthShare: .5,
    discoveryPositiveSixMonthBlocks: 3, discoveryMaxPositiveSymbolShare: .5, validationTrades: 30, evaluationTrades: 20 },
  segmentsTested: audit.length, discoveryQualifiedCount: discoveryQualified.length, triplePassCount: triplePass.length,
  triplePass, discoveryQualified: discoveryQualified.slice(0, 100) };
writeFileSync(process.env.RESEARCH_OUTPUT ?? "/tmp/v12-microcell-discovery.json", JSON.stringify(report, null, 2) + "\\n");
console.log("V12_MICROCELL=" + JSON.stringify({ rawTradeCount: report.rawTradeCount, segmentsTested: report.segmentsTested,
  discoveryQualifiedCount: report.discoveryQualifiedCount, triplePassCount: report.triplePassCount,
  triplePass: report.triplePass.map((row) => ({ id: row.id, d: row.discovery, v: row.validation, e: row.evaluation })) }));
`;
writeFileSync(generatedPath, source);
const result = spawnSync(process.execPath, ["--experimental-strip-types", generatedPath], {
  cwd: process.cwd(), env: { ...process.env, RESEARCH_OUTPUT: outputPath }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
if (result.status !== 0) process.exit(result.status ?? 1);
