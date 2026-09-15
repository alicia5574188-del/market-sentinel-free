import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const sourcePath = process.env.V12_SOURCE ?? "scripts/research-v12.mjs";
const generatedPath = "scripts/.research-v12-frozen-generated.mjs";
const outputPath = process.env.RESEARCH_OUTPUT ?? "/tmp/v12-frozen-audit.json";
const friction = Number(process.env.RESEARCH_FRICTION ?? 0.0014);
const entrySlippage = Number(process.env.RESEARCH_ENTRY_SLIPPAGE ?? 0.00025);
const minContextMarkets = Number(process.env.RESEARCH_MIN_CONTEXT_MARKETS ?? 12);

let source = readFileSync(sourcePath, "utf8");
source = source.replace("const FRICTION = 0.0014;", `const FRICTION = ${JSON.stringify(friction)};`)
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
const frozenTrades = coverageTrades.filter((row) => frozenIds.has(row.strategyId));
const monthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1);
const nextMonth = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)), 1);
const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7).replace("-", "");
const sum = (values) => values.reduce((total, value) => total + value, 0);
function details(rows) {
  const gain = sum(rows.filter((row) => row.netReturnRate > 0).map((row) => row.netReturnRate));
  const loss = Math.abs(sum(rows.filter((row) => row.netReturnRate <= 0).map((row) => row.netReturnRate)));
  const monthly = new Map(); const bySymbol = new Map(); const bySide = new Map();
  for (const row of rows) {
    const month = monthKey(row.openedAt);
    monthly.set(month, (monthly.get(month) ?? 0) + row.netReturnRate);
    bySymbol.set(row.symbol, (bySymbol.get(row.symbol) ?? 0) + row.netReturnRate);
    bySide.set(row.side, (bySide.get(row.side) ?? 0) + row.netReturnRate);
  }
  return { trades: rows.length, winRate: rows.length ? rows.filter((row) => row.netReturnRate > 0).length / rows.length : 0,
    netReturnSum: sum(rows.map((row) => row.netReturnRate)), profitFactor: loss ? gain / loss : gain ? 99 : 0,
    activeMonths: monthly.size, positiveMonths: [...monthly.values()].filter((value) => value > 0).length,
    monthly: Object.fromEntries([...monthly].sort()), bySymbol: Object.fromEntries([...bySymbol].sort()),
    bySide: Object.fromEntries([...bySide].sort()) };
}
const from = monthStart(raw.months[0]); const to = nextMonth(raw.months.at(-1));
const discoveryEnd = raw.months.length >= 39 ? monthStart(raw.months[30]) : from + (to - from) * .5;
const validationEnd = raw.months.length >= 39 ? monthStart(raw.months[38]) : from + (to - from) * .75;
const periods = { full: [from, to], discovery: [from, discoveryEnd], validation: [discoveryEnd, validationEnd], evaluation: [validationEnd, to] };
const summarize = (rows) => Object.fromEntries(Object.entries(periods).map(([key, [start, end]]) =>
  [key, details(rows.filter((row) => row.openedAt >= start && row.openedAt < end))]));
const byFamily = Object.fromEntries([...frozenIds].map((id) => [id, summarize(frozenTrades.filter((row) => row.strategyId === id))]));
const combined = summarize(frozenTrades);
const eventGroups = new Map();
for (const row of frozenTrades) {
  const key = row.symbol + ":" + row.side + ":" + row.openedAt;
  const ids = eventGroups.get(key) ?? new Set(); ids.add(row.strategyId); eventGroups.set(key, ids);
}
const report = { generatedAt: new Date().toISOString(), dataset: { source: raw.source, sha256: raw.sha256,
  months: raw.months, symbols: raw.symbols, rows: raw.datasets.reduce((total, row) => total + row.rows.length, 0),
  minContextMarkets: ${JSON.stringify(minContextMarkets)} }, scenario: { friction: FRICTION, entrySlippage: ENTRY_SLIPPAGE },
  frozenStrategyIds: [...frozenIds], byFamily, combined,
  exactCrossFamilyOverlapEvents: [...eventGroups.values()].filter((ids) => ids.size > 1).length,
  uniqueEventIdentities: eventGroups.size,
  tradesPerDayFull: frozenTrades.length / ((to - from) / 86400000),
  tradesPerDayEvaluation: frozenTrades.filter((row) => row.openedAt >= validationEnd).length / ((to - validationEnd) / 86400000) };
writeFileSync(process.env.RESEARCH_OUTPUT ?? "/tmp/v12-frozen-audit.json", JSON.stringify(report, null, 2) + "\\n");
console.log("V12_FROZEN_AUDIT=" + JSON.stringify(report));
`;
writeFileSync(generatedPath, source);
const result = spawnSync(process.execPath, ["--experimental-strip-types", generatedPath], {
  cwd: process.cwd(), env: { ...process.env, RESEARCH_OUTPUT: outputPath }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
if (result.status !== 0) process.exit(result.status ?? 1);
