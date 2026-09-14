import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const INPUT = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-44m-5m.json";
const OUTPUT = process.env.RESEARCH_OUTPUT ?? "/tmp/gate-history-44m-from5m-1h.json";
const MAX_FILL_HOURS = Number(process.env.RESEARCH_MAX_FILL_HOURS ?? 3);
const raw = JSON.parse(readFileSync(INPUT, "utf8"));
if (raw.interval !== "5m" || (raw.stepSeconds ?? 300) !== 300) throw new Error("Expected Gate 5m research dataset");

function aggregate(rows) {
  const result = [];
  let bucket = null;
  for (const row of rows) {
    const time = Math.floor(row.time / 3_600) * 3_600;
    if (!bucket || bucket.time !== time) {
      if (bucket?.samples >= 10) result.push(bucket);
      bucket = { time, open: row.open, high: row.high, low: row.low, close: row.close,
        volume: row.volume, samples: 1 };
    } else {
      bucket.high = Math.max(bucket.high, row.high);
      bucket.low = Math.min(bucket.low, row.low);
      bucket.close = row.close;
      bucket.volume += row.volume;
      bucket.samples += 1;
    }
  }
  if (bucket?.samples >= 10) result.push(bucket);
  const filled = [];
  for (const row of result) {
    const previous = filled.at(-1);
    const missing = previous ? (row.time - previous.time) / 3_600 - 1 : 0;
    if (previous && missing > 0 && missing <= MAX_FILL_HOURS) {
      for (let offset = 1; offset <= missing; offset += 1) filled.push({
        time: previous.time + offset * 3_600, open: previous.close, high: previous.close,
        low: previous.close, close: previous.close, volume: 0, samples: 0, synthetic: true });
    }
    filled.push(row);
  }
  return filled;
}

const datasets = raw.datasets.map(({ symbol, rows }) => {
  const aggregated = aggregate(rows); let gaps = 0;
  for (let index = 1; index < aggregated.length; index += 1) {
    gaps += Number(aggregated[index].time !== aggregated[index - 1].time + 3_600);
  }
  return { symbol, rows: aggregated, gaps, syntheticHours: aggregated.filter((row) => row.synthetic).length,
    coverage: aggregated.length / ((raw.now - raw.from) / 3_600) };
});
const source = "gate-official-monthly-futures-usdt-candlesticks-5m-aggregated-1h-v1";
const canonical = JSON.stringify({ source, months: raw.months, from: raw.from, now: raw.now,
  symbols: raw.symbols, datasets });
const sha256 = createHash("sha256").update(canonical).digest("hex");
writeFileSync(OUTPUT, `${JSON.stringify({ ...raw, source, sourceDatasetSha256: raw.sha256,
  interval: "1h", stepSeconds: 3_600, maximumFilledGapHours: MAX_FILL_HOURS, sha256, datasets })}\n`);
console.log(JSON.stringify({ output: OUTPUT, sourceDatasetSha256: raw.sha256, sha256,
  symbols: datasets.length, rows: datasets.reduce((total, item) => total + item.rows.length, 0),
  maximumFilledGapHours: MAX_FILL_HOURS,
  coverage: datasets.map(({ symbol, coverage, gaps, syntheticHours }) => ({ symbol, coverage, gaps, syntheticHours })) }, null, 2));
