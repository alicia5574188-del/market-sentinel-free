import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const INTERVAL = process.env.RESEARCH_INTERVAL ?? "5m";
const STEP = INTERVAL === "5m" ? 300 : INTERVAL === "1h" ? 3_600 : 0;
if (!STEP) throw new Error(`Unsupported research interval: ${INTERVAL}`);
const BASE = `https://download.gatedata.org/futures_usdt/candlesticks_${INTERVAL}`;
const OUTPUT = process.env.RESEARCH_DATASET ?? "/tmp/gate-history-12m.json";
const MONTHS = (process.env.RESEARCH_MONTHS ?? "202509,202510,202511,202512,202601,202602,202603,202604,202605,202606,202607,202608")
  .split(",").map((value) => value.trim()).filter(Boolean);
const SYMBOLS = (process.env.RESEARCH_SYMBOLS
  ?? "BTC_USDT,ETH_USDT,SOL_USDT,XRP_USDT,BNB_USDT,DOGE_USDT,ADA_USDT,SUI_USDT,UNI_USDT,LINK_USDT,LTC_USDT,AVAX_USDT,DOT_USDT,BCH_USDT,ZEC_USDT,STORJ_USDT,LSK_USDT")
  .split(",").map((value) => value.trim()).filter(Boolean);
const CONCURRENCY = Number(process.env.RESEARCH_CONCURRENCY ?? 6);
const MIN_CONTRACTS = Number(process.env.RESEARCH_MIN_CONTRACTS ?? 12);
const MIN_MONTH_COVERAGE = Number(process.env.RESEARCH_MIN_MONTH_COVERAGE ?? 0.98);
const CACHE = `/tmp/gate-history-archive-${INTERVAL}`;
mkdirSync(CACHE, { recursive: true });

const monthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1) / 1_000;
const nextMonth = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)), 1) / 1_000;
const expectedRows = (month) => (nextMonth(month) - monthStart(month)) / STEP;
const parse = (buffer) => gunzipSync(buffer).toString("utf8").trim().split("\n").flatMap((line) => {
  const [time, volume, close, high, low, open] = line.split(",").map(Number);
  if (!(time > 0 && open > 0 && low > 0 && high >= low
    && [volume, close, high, low, open].every(Number.isFinite))) return [];
  return [{ time, volume, close, high, low, open }];
});

async function download(symbol, month) {
  const url = `${BASE}/${month}/${symbol}-${month}.csv.gz`;
  const cachePath = `${CACHE}/${symbol}-${month}.csv.gz`;
  let compressed;
  if (existsSync(cachePath)) compressed = readFileSync(cachePath);
  else {
    const response = await fetch(url, { headers: { Accept: "application/octet-stream" } });
    if (!response.ok) throw new Error(`${symbol} ${month}: HTTP ${response.status}`);
    compressed = Buffer.from(await response.arrayBuffer());
    writeFileSync(cachePath, compressed);
  }
  const rows = parse(compressed);
  const expected = expectedRows(month);
  if (rows.length < expected * MIN_MONTH_COVERAGE || rows[0]?.time > monthStart(month) + 21_600
    || rows.at(-1)?.time < nextMonth(month) - 21_900) {
    throw new Error(`${symbol} ${month}: incomplete ${rows.length}/${expected}`);
  }
  return rows;
}

const tasks = SYMBOLS.flatMap((symbol) => MONTHS.map((month) => ({ symbol, month })));
const results = new Map(SYMBOLS.map((symbol) => [symbol, []]));
const unavailable = new Map();
let cursor = 0;
async function worker() {
  while (cursor < tasks.length) {
    const task = tasks[cursor]; cursor += 1;
    try {
      const rows = await download(task.symbol, task.month);
      results.get(task.symbol).push({ month: task.month, rows });
      console.log(`loaded ${task.symbol} ${task.month} (${rows.length})`);
    } catch (error) {
      const failures = unavailable.get(task.symbol) ?? [];
      failures.push(String(error.message ?? error)); unavailable.set(task.symbol, failures);
      console.log(`skipped ${task.symbol} ${task.month}: ${error.message ?? error}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));

const datasets = SYMBOLS.flatMap((symbol) => {
  const months = results.get(symbol).sort((left, right) => left.month.localeCompare(right.month));
  if (months.length !== MONTHS.length) return [];
  const rows = months.flatMap((item) => item.rows);
  let gaps = 0;
  for (let index = 1; index < rows.length; index += 1) {
    gaps += Number(rows[index].time !== rows[index - 1].time + STEP);
  }
  return [{ symbol, rows, gaps,
    coverage: rows.length / MONTHS.reduce((total, month) => total + expectedRows(month), 0) }];
});
if (datasets.length < MIN_CONTRACTS) {
  throw new Error(`Only ${datasets.length} contracts have all ${MONTHS.length} complete months; need ${MIN_CONTRACTS}`);
}
const from = monthStart(MONTHS[0]);
const now = nextMonth(MONTHS.at(-1));
const source = `gate-official-monthly-futures-usdt-candlesticks-${INTERVAL}-v1`;
const canonical = JSON.stringify({ source,
  months: MONTHS, from, now, symbols: datasets.map((item) => item.symbol), datasets });
const sha256 = createHash("sha256").update(canonical).digest("hex");
writeFileSync(OUTPUT, `${JSON.stringify({ source,
  interval: INTERVAL, stepSeconds: STEP, months: MONTHS, days: (now - from) / 86_400, from, now,
  symbols: datasets.map((item) => item.symbol), requestedSymbols: SYMBOLS,
  symbolLimit: datasets.length, universePolicy: "continuous-current-liquid-gate-contracts-v1",
  minimumMonthlyCoverage: MIN_MONTH_COVERAGE,
  unavailable: Object.fromEntries(unavailable), sha256, datasets })}\n`);
console.log(JSON.stringify({ output: OUTPUT, months: MONTHS.length, symbols: datasets.length,
  included: datasets.map((item) => item.symbol), excluded: [...unavailable.keys()],
  rowsPerSymbol: datasets[0].rows.length, sha256 }, null, 2));
