import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const OUTPUT = process.env.RESEARCH_OUTPUT ?? "/tmp/gate-anchor-data-audit.json";
const BASE = "https://api.gateio.ws/api/v4";
const SYMBOLS = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "DOGE_USDT", "SUI_USDT", "UNI_USDT"];
const WINDOWS = ["2023-09-15", "2024-09-15", "2025-09-15", "2026-06-15"];
const INTERVAL = "5m";
const STEP = 300;
const EXPECTED = 288;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function epoch(date) { return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000); }
function pct(values, q) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.max(0, Math.floor((a.length - 1) * q)))];
}
function bps(a, b) { return Math.abs((a / b - 1) * 10_000); }
function gaps(rows) {
  const t = rows.map((r) => Number(r.t)).filter(Number.isFinite).sort((a,b)=>a-b);
  let n = 0;
  for (let i = 1; i < t.length; i += 1) if (t[i] !== t[i - 1] + STEP) n += 1;
  return n;
}
async function getJson(path) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const r = await fetch(`${BASE}${path}`, {
        headers: { Accept: "application/json", "User-Agent": "market-sentinel-research" },
        signal: AbortSignal.timeout(8_000),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 240)}`);
      const value = JSON.parse(text);
      if (!Array.isArray(value)) throw new Error(`Expected array: ${text.slice(0, 240)}`);
      return value;
    } catch (error) {
      last = error;
      await sleep(300 * (attempt + 1));
    }
  }
  throw last;
}
async function series(kind, symbol, from, to, interval = INTERVAL) {
  if (kind === "premium") return getJson(`/futures/usdt/premium_index?contract=${symbol}&from=${from}&to=${to}&interval=${interval}`);
  const contract = kind === "trade" ? symbol : `${kind}_${symbol}`;
  return getJson(`/futures/usdt/candlesticks?contract=${contract}&from=${from}&to=${to}&interval=${interval}`);
}
function mapClose(rows) { return new Map(rows.map((r) => [Number(r.t), Number(r.c)]).filter(([, c]) => Number.isFinite(c))); }

const probes = [];
for (const date of WINDOWS) {
  const from = epoch(date);
  const to = from + 86_400 - STEP;
  for (const symbol of SYMBOLS) {
    const row = { date, symbol, from, to, interval: INTERVAL, expected: EXPECTED, errors: {} };
    const data = {};
    const settled = await Promise.allSettled(["trade", "mark", "index", "premium"].map((kind) => series(kind, symbol, from, to)));
    for (const [i, kind] of ["trade", "mark", "index", "premium"].entries()) {
      if (settled[i].status === "fulfilled") data[kind] = settled[i].value;
      else { data[kind] = []; row.errors[kind] = String(settled[i].reason?.message ?? settled[i].reason); }
    }
    for (const kind of ["trade", "mark", "index", "premium"]) {
      row[`${kind}Count`] = data[kind].length;
      row[`${kind}Coverage`] = data[kind].length / EXPECTED;
      row[`${kind}Gaps`] = gaps(data[kind]);
      row[`${kind}First`] = data[kind].length ? Number(data[kind][0].t) : null;
      row[`${kind}Last`] = data[kind].length ? Number(data[kind].at(-1).t) : null;
    }
    const maps = Object.fromEntries(["trade", "mark", "index", "premium"].map((k) => [k, mapClose(data[k])]));
    const tri = [...maps.trade.keys()].filter((t) => maps.mark.has(t) && maps.index.has(t));
    const quad = tri.filter((t) => maps.premium.has(t));
    row.anchorAligned = tri.length;
    row.anchorAlignment = tri.length / EXPECTED;
    row.premiumAligned = quad.length;
    row.premiumAlignment = quad.length / EXPECTED;
    const tradeMark = tri.map((t) => bps(maps.trade.get(t), maps.mark.get(t)));
    const markIndex = tri.map((t) => bps(maps.mark.get(t), maps.index.get(t)));
    const premiumAbsBps = quad.map((t) => Math.abs(maps.premium.get(t)) * 10_000);
    row.tradeVsMarkAbsBps = { p50: pct(tradeMark, .5), p95: pct(tradeMark, .95), max: tradeMark.length ? Math.max(...tradeMark) : null };
    row.markVsIndexAbsBps = { p50: pct(markIndex, .5), p95: pct(markIndex, .95), max: markIndex.length ? Math.max(...markIndex) : null };
    row.premiumAbsBps = { p50: pct(premiumAbsBps, .5), p95: pct(premiumAbsBps, .95), max: premiumAbsBps.length ? Math.max(...premiumAbsBps) : null };
    row.anchorCorePass = row.tradeCoverage >= .98 && row.markCoverage >= .98 && row.indexCoverage >= .98 && row.anchorAlignment >= .98;
    row.premiumPass = row.premiumCoverage >= .98 && row.premiumAlignment >= .98;
    probes.push(row);
    await sleep(100);
  }
}

const minuteProbes = [];
for (const date of ["2023-09-15", "2026-06-15"]) {
  const from = epoch(date), to = from + 3_600 - 60;
  for (const symbol of ["BTC_USDT", "ETH_USDT"]) {
    const rec = { date, symbol, expected: 60 };
    const settled = await Promise.allSettled(["trade", "mark", "index", "premium"].map((kind) => series(kind, symbol, from, to, "1m")));
    for (const [i, kind] of ["trade", "mark", "index", "premium"].entries()) {
      if (settled[i].status === "fulfilled") rec[`${kind}Count`] = settled[i].value.length;
      else { rec[`${kind}Count`] = 0; rec[`${kind}Error`] = String(settled[i].reason?.message ?? settled[i].reason); }
    }
    rec.pass = ["trade","mark","index","premium"].every((k) => rec[`${k}Count`] >= 59);
    minuteProbes.push(rec);
  }
}

const anchorPasses = probes.filter((r) => r.anchorCorePass).length;
const premiumPasses = probes.filter((r) => r.premiumPass).length;
const allAnchor = anchorPasses === probes.length;
const allPremium = premiumPasses === probes.length;
const allMinute = minuteProbes.every((r) => r.pass);
const raw = { source: "Gate REST API v4", generatedAt: new Date().toISOString(), interval: INTERVAL, symbols: SYMBOLS, windows: WINDOWS, probes, minuteProbes };
const sha256 = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
const output = {
  research: "gate-anchor-data-audit-v1",
  objective: "verify whether Gate trade/mark/index/premium historical data are sufficiently long, aligned, and granular for an anchored convergence research family",
  docsBasis: {
    candlesticks: "GET /futures/{settle}/candlesticks with mark_ / index_ contract prefixes; 1m and 5m supported",
    premiumIndex: "GET /futures/{settle}/premium_index; 1m and 5m supported",
  },
  decision: allAnchor && allMinute ? "ANCHOR_DATA_USABLE" : "ANCHOR_DATA_INSUFFICIENT",
  premiumDecision: allPremium && allMinute ? "PREMIUM_DATA_USABLE" : "PREMIUM_DATA_PARTIAL_OR_INSUFFICIENT",
  diagnostics: { probes: probes.length, anchorPasses, premiumPasses, minuteProbes: minuteProbes.length, minutePasses: minuteProbes.filter((r)=>r.pass).length },
  sha256,
  ...raw,
};
writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(`GATE_ANCHOR_DATA_AUDIT=${JSON.stringify({ decision: output.decision, premiumDecision: output.premiumDecision, diagnostics: output.diagnostics, sha256, probes, minuteProbes })}`);
