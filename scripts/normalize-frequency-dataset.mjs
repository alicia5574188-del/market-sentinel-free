import { readFileSync, writeFileSync } from "node:fs";

const INPUT = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-frequency-12m.json";
const OUTPUT = process.env.NORMALIZED_RESEARCH_DATASET ?? "/tmp/gate-history-frequency-aligned-12m.json";
const raw = JSON.parse(readFileSync(INPUT, "utf8"));
if (raw.interval !== "5m" || raw.stepSeconds !== 300) throw new Error("Expected Gate 5m research dataset");
const expected = Math.round((raw.now - raw.from) / 300);
const diagnostics = {};
const datasets = raw.datasets.map(item => {
  const byTime = new Map(item.rows.map(row => [row.time, row]));
  const rows = new Array(expected);
  let previous = null, synthetic = 0, longestGap = 0, currentGap = 0;
  for (let index = 0; index < expected; index += 1) {
    const time = raw.from + index * 300;
    const real = byTime.get(time);
    if (real) { rows[index] = { ...real, synthetic: false }; previous = real.close; currentGap = 0; continue; }
    synthetic += 1; currentGap += 1; longestGap = Math.max(longestGap, currentGap);
    if (!(previous > 0)) {
      let next = index + 1;
      while (next < expected && !byTime.has(raw.from + next * 300)) next += 1;
      previous = byTime.get(raw.from + next * 300)?.open;
    }
    if (!(previous > 0)) throw new Error(`${item.symbol}: cannot anchor missing interval at ${time}`);
    rows[index] = { time, open: previous, high: previous, low: previous, close: previous, volume: 0, synthetic: true };
  }
  diagnostics[item.symbol] = { realRows: item.rows.length, syntheticRows: synthetic,
    syntheticRate: synthetic / expected, longestSyntheticGapMinutes: longestGap * 5 };
  return { ...item, rows, gaps: 0, aligned: true, syntheticRows: synthetic, syntheticRate: synthetic / expected };
});
const normalized = { ...raw, source: `${raw.source}-aligned-high-coverage-v1`, datasets,
  symbols: datasets.map(item => item.symbol), symbolLimit: datasets.length, alignment: {
    policy: "missing 5m intervals within >=98%-covered monthly archives are filled flat at the last known close with zero volume",
    expectedRowsPerSymbol: expected, diagnostics,
  } };
writeFileSync(OUTPUT, JSON.stringify(normalized) + "\n");
console.log(JSON.stringify({ output: OUTPUT, symbols: datasets.length,
  worstSyntheticRate: Math.max(...Object.values(diagnostics).map(row => row.syntheticRate)),
  worstGapMinutes: Math.max(...Object.values(diagnostics).map(row => row.longestSyntheticGapMinutes)), diagnostics }, null, 2));