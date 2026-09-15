import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const OUTPUT = process.env.RESEARCH_OUTPUT ?? '/tmp/binance-cross-venue-data-audit.json';
const DATA_DIR = process.env.RESEARCH_DATA_DIR ?? '/tmp/binance-cross-venue-data-audit';
const BASE = 'https://data.binance.vision/data/futures/um';
const SYMBOLS = ['BTCUSDT', 'SOLUSDT', 'SUIUSDT'];
const START_MONTH = '2023-09';
const END_MONTH = '2026-08';
const SAMPLE_DATE = '2025-10-15';
const SAMPLE_HOUR_UTC = 12;
const MAX_SAMPLE_P95_GAP_MS = 2_000;
const MIN_SAMPLE_HOUR_EVENTS = 100;

mkdirSync(DATA_DIR, { recursive: true });

function monthsBetween(start, end) {
  const out = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m === 13) { y += 1; m = 1; }
  }
  return out;
}
function percentile(values, q) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.max(0, Math.floor((a.length - 1) * q)))];
}
async function fetchRetry(url, opts = {}, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const r = await fetch(url, {
        ...opts,
        headers: { 'User-Agent': 'market-sentinel-research', ...(opts.headers ?? {}) },
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return r;
    } catch (error) {
      last = error;
      if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 300 * (i + 1)));
    }
  }
  throw last;
}
async function fetchChecksum(url) {
  const r = await fetchRetry(`${url}.CHECKSUM`);
  const text = (await r.text()).trim();
  const m = text.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
  if (!m) throw new Error(`invalid checksum sidecar ${url}.CHECKSUM: ${text.slice(0, 120)}`);
  return { sha256: m[1].toLowerCase(), filename: m[2].trim(), text };
}
async function withConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); }
      catch (error) { out[i] = { ...items[i], ok: false, error: String(error?.message ?? error) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function download(url, path) {
  const r = await fetchRetry(url);
  if (!r.body) throw new Error(`empty body ${url}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(path));
  return statSync(path).size;
}
function normalizeTimestamp(raw) {
  if (!Number.isFinite(raw)) return null;
  if (raw > 1e17) return { ms: raw / 1e6, unit: 'ns' };
  if (raw > 1e14) return { ms: raw / 1e3, unit: 'us' };
  if (raw > 1e11) return { ms: raw, unit: 'ms' };
  return { ms: raw * 1000, unit: 's' };
}
async function inspectZipCsv(path, symbol) {
  const child = spawn('unzip', ['-p', path], { stdio: ['ignore', 'pipe', 'inherit'] });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const startMs = Date.parse(`${SAMPLE_DATE}T${String(SAMPLE_HOUR_UTC).padStart(2, '0')}:00:00Z`);
  const endMs = startMs + 60 * 60 * 1000;
  let rows = 0;
  let firstMs = null;
  let lastMs = null;
  let rawUnit = null;
  let subsecondRows = 0;
  let hourEvents = 0;
  let lastHourTs = null;
  const hourGaps = [];
  let malformed = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const p = line.split(',');
    if (p.length < 6) { malformed += 1; continue; }
    const rawTs = Number(p[5]);
    const norm = normalizeTimestamp(rawTs);
    if (!norm) continue; // possible header row
    rows += 1;
    rawUnit ??= norm.unit;
    firstMs ??= norm.ms;
    lastMs = norm.ms;
    if (Math.round(norm.ms) % 1000 !== 0) subsecondRows += 1;
    if (norm.ms >= startMs && norm.ms < endMs) {
      hourEvents += 1;
      if (lastHourTs != null && norm.ms >= lastHourTs) hourGaps.push(norm.ms - lastHourTs);
      lastHourTs = norm.ms;
    }
  }
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) throw new Error(`unzip exited ${code} for ${path}`);
  return {
    symbol,
    rows,
    malformed,
    timestampUnit: rawUnit,
    firstTimestampMs: firstMs,
    lastTimestampMs: lastMs,
    subsecondRows,
    subsecondShare: rows ? subsecondRows / rows : 0,
    sampleHourUtc: `${SAMPLE_DATE} ${String(SAMPLE_HOUR_UTC).padStart(2, '0')}:00`,
    sampleHourEvents: hourEvents,
    sampleHourGapMs: {
      p50: percentile(hourGaps, 0.5),
      p90: percentile(hourGaps, 0.9),
      p95: percentile(hourGaps, 0.95),
      p99: percentile(hourGaps, 0.99),
      max: hourGaps.length ? Math.max(...hourGaps) : null,
    },
  };
}

const months = monthsBetween(START_MONTH, END_MONTH);
const monthlyChecks = [];
for (const symbol of SYMBOLS) {
  for (const month of months) {
    const url = `${BASE}/monthly/aggTrades/${symbol}/${symbol}-aggTrades-${month}.zip`;
    monthlyChecks.push({ symbol, month, url });
  }
}
const monthlyResults = await withConcurrency(monthlyChecks, 8, async (item) => {
  const checksum = await fetchChecksum(item.url);
  const expectedName = item.url.split('/').at(-1);
  return { ...item, ok: checksum.filename === expectedName, checksumSha256: checksum.sha256, checksumFilename: checksum.filename };
});

const sampleResults = [];
for (const symbol of SYMBOLS) {
  const url = `${BASE}/daily/aggTrades/${symbol}/${symbol}-aggTrades-${SAMPLE_DATE}.zip`;
  const path = `${DATA_DIR}/${symbol}-${SAMPLE_DATE}.zip`;
  try {
    const checksum = await fetchChecksum(url);
    const bytes = await download(url, path);
    const actualSha256 = await hashFile(path);
    const inspection = await inspectZipCsv(path, symbol);
    sampleResults.push({
      symbol, url, ok: actualSha256 === checksum.sha256,
      bytes, expectedSha256: checksum.sha256, actualSha256,
      checksumMatch: actualSha256 === checksum.sha256,
      ...inspection,
    });
  } catch (error) {
    sampleResults.push({ symbol, url, ok: false, error: String(error?.stack ?? error) });
  }
}

const coverageBySymbol = Object.fromEntries(SYMBOLS.map((symbol) => {
  const rows = monthlyResults.filter((x) => x.symbol === symbol);
  const ok = rows.filter((x) => x.ok).length;
  return [symbol, { expectedMonths: months.length, availableMonths: ok, coverage: rows.length ? ok / rows.length : 0, missingMonths: rows.filter((x) => !x.ok).map((x) => x.month) }];
}));
const fullMonthlyCoverage = monthlyResults.length === SYMBOLS.length * months.length && monthlyResults.every((x) => x.ok);
const timestampAndDensityPass = sampleResults.length === SYMBOLS.length && sampleResults.every((x) => x.ok && x.timestampUnit === 'ms' && x.subsecondRows > 0 && x.sampleHourEvents >= MIN_SAMPLE_HOUR_EVENTS && x.sampleHourGapMs?.p95 != null && x.sampleHourGapMs.p95 <= MAX_SAMPLE_P95_GAP_MS);
const decision = fullMonthlyCoverage && timestampAndDensityPass
  ? 'BINANCE_CROSS_VENUE_DATA_USABLE'
  : 'BINANCE_CROSS_VENUE_DATA_INSUFFICIENT';

const outputCore = {
  research: 'binance-cross-venue-data-audit-v1',
  objective: 'audit whether Binance USD-M perpetual aggregate trades can provide a causal external same-asset fair-value stream for Gate passive-liquidity research without fabricating subsecond history',
  decision,
  protocol: {
    externalVenue: 'Binance USD-M perpetual futures',
    externalArchive: 'official data.binance.vision aggTrades archive',
    officialSchema: 'aggregate trade id, price, quantity, first trade id, last trade id, timestamp, buyer-maker flag; futures timestamp documented in milliseconds',
    symbols: SYMBOLS,
    monthlyCoverageRange: [START_MONTH, END_MONTH],
    monthlyCoverageMonthsPerSymbol: months.length,
    coverageMethod: 'verify official monthly ZIP CHECKSUM sidecar for every symbol-month; no missing month allowed',
    sampleDay: SAMPLE_DATE,
    sampleHourUtc: SAMPLE_HOUR_UTC,
    sampleIntegrity: 'download one official daily aggTrades ZIP per symbol, verify SHA256 against CHECKSUM, parse full file, measure timestamp granularity and event gaps in the aligned 12:00-13:00 UTC hour',
    densityGate: { minEventsInSampleHour: MIN_SAMPLE_HOUR_EVENTS, maxP95GapMs: MAX_SAMPLE_P95_GAP_MS },
    GateSideAlreadyAudited: '#252 established usable 100ms Gate historical orderbook data with per-hour quality gating and current production control cadence ~2000ms',
  },
  counts: {
    expectedMonthlyObjects: SYMBOLS.length * months.length,
    monthlyObjectsAvailable: monthlyResults.filter((x) => x.ok).length,
    monthlyObjectsMissing: monthlyResults.filter((x) => !x.ok).length,
    sampleFilesPassed: sampleResults.filter((x) => x.ok).length,
  },
  fullMonthlyCoverage,
  timestampAndDensityPass,
  coverageBySymbol,
  sampleResults,
  missingMonthlyObjects: monthlyResults.filter((x) => !x.ok),
};
const sha256 = createHash('sha256').update(JSON.stringify(outputCore)).digest('hex');
const output = { ...outputCore, sha256, generatedAt: new Date().toISOString() };
writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(`BINANCE_CROSS_VENUE_AUDIT=${JSON.stringify({ decision, counts: output.counts, fullMonthlyCoverage, timestampAndDensityPass, coverageBySymbol, sampleResults: sampleResults.map((x) => ({ symbol: x.symbol, ok: x.ok, bytes: x.bytes, timestampUnit: x.timestampUnit, rows: x.rows, subsecondShare: x.subsecondShare, sampleHourEvents: x.sampleHourEvents, sampleHourGapMs: x.sampleHourGapMs })), sha256 })}`);
