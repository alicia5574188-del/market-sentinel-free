import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const BASE = "https://api.gateio.ws/api/v4/futures/usdt";
const OUTPUT = process.env.FLOW_DATASET ?? "/tmp/gate-flow-5m-202604-202608.json";
const START = Number(process.env.FLOW_FROM ?? Date.UTC(2026, 3, 1) / 1000);
const END = Number(process.env.FLOW_TO ?? Date.UTC(2026, 8, 1) / 1000);
const INTERVAL = process.env.FLOW_INTERVAL ?? "5m";
const STEP = INTERVAL === "5m" ? 300 : INTERVAL === "15m" ? 900 : INTERVAL === "30m" ? 1800 : INTERVAL === "1h" ? 3600 : 0;
if (!STEP) throw new Error(`unsupported interval ${INTERVAL}`);
const LIMIT = Number(process.env.FLOW_PAGE_LIMIT ?? 2000);
const CONCURRENCY = Number(process.env.FLOW_CONCURRENCY ?? 3);
const SYMBOLS = (process.env.RESEARCH_SYMBOLS ?? "BTC_USDT,ETH_USDT,SOL_USDT,XRP_USDT,BNB_USDT,DOGE_USDT,ADA_USDT,LINK_USDT,LTC_USDT,AVAX_USDT,BCH_USDT,SUI_USDT,UNI_USDT,AAVE_USDT,FIL_USDT,ARB_USDT,PEPE_USDT,APT_USDT")
  .split(",").map(s=>s.trim()).filter(Boolean);

const sleep = (ms) => new Promise(r=>setTimeout(r,ms));
async function getJson(path, params, attempt=0) {
  const url = new URL(`${BASE}${path}`);
  for (const [k,v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) {
    if ((response.status === 429 || response.status >= 500) && attempt < 6) {
      await sleep(500 * 2 ** attempt + Math.floor(Math.random()*250));
      return getJson(path, params, attempt+1);
    }
    throw new Error(`${response.status} ${url}: ${text.slice(0,500)}`);
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`unexpected response ${url}`);
  return parsed;
}

async function fetchSymbol(symbol) {
  const byTime = new Map();
  let cursor = START;
  let pages = 0;
  while (cursor < END) {
    const rows = await getJson("/contract_stats", { contract: symbol, from: cursor, interval: INTERVAL, limit: LIMIT });
    pages += 1;
    if (!rows.length) break;
    let last = cursor - STEP;
    for (const row of rows) {
      const time = Number(row.time);
      if (!Number.isFinite(time)) continue;
      last = Math.max(last, time);
      if (time < START || time >= END) continue;
      byTime.set(time, [
        time,
        Number(row.open_interest_usd ?? 0),
        Number(row.open_interest ?? 0),
        Number(row.long_taker_size ?? 0),
        Number(row.short_taker_size ?? 0),
        Number(row.long_liq_usd_new ?? row.long_liq_usd ?? 0),
        Number(row.short_liq_usd_new ?? row.short_liq_usd ?? 0),
        Number(row.lsr_taker ?? 0),
        Number(row.lsr_account ?? 0),
        Number(row.top_lsr_size ?? 0),
        Number(row.top_lsr_account ?? 0),
        Number(row.mark_price ?? 0),
      ]);
    }
    if (last < cursor) break;
    cursor = last + STEP;
    if (rows.at(-1)?.time >= END || cursor >= END) break;
    await sleep(40);
  }
  const fundingRaw = await getJson("/funding_rate", { contract: symbol, from: START, to: END, limit: 1000 });
  const funding = fundingRaw.map(row=>[Number(row.t), Number(row.r)]).filter(row=>Number.isFinite(row[0])&&Number.isFinite(row[1])).sort((a,b)=>a[0]-b[0]);
  const rows = [...byTime.values()].sort((a,b)=>a[0]-b[0]);
  const expected = Math.floor((END-START)/STEP);
  const coverage = rows.length / Math.max(expected,1);
  console.log(`flow ${symbol}: ${rows.length}/${expected} ${(coverage*100).toFixed(2)}% pages=${pages} funding=${funding.length}`);
  return { symbol, rows, funding, pages, coverage };
}

const datasets = new Array(SYMBOLS.length);
let cursor=0;
async function worker() {
  while (true) {
    const index=cursor++; if(index>=SYMBOLS.length) return;
    datasets[index] = await fetchSymbol(SYMBOLS[index]);
  }
}
await Promise.all(Array.from({length:Math.min(CONCURRENCY,SYMBOLS.length)}, worker));
const failures = datasets.filter(d=>!d || d.coverage < .95).map(d=>d?.symbol ?? "missing");
if (failures.length) throw new Error(`flow coverage below 95%: ${failures.join(",")}`);
const source = `gate-public-contract-stats-${INTERVAL}-v1`;
const canonical = JSON.stringify({source,interval:INTERVAL,stepSeconds:STEP,from:START,to:END,symbols:SYMBOLS,datasets});
const sha256=createHash("sha256").update(canonical).digest("hex");
writeFileSync(OUTPUT, JSON.stringify({source,interval:INTERVAL,stepSeconds:STEP,from:START,to:END,symbols:SYMBOLS,sha256,datasets})+"\n");
console.log(JSON.stringify({output:OUTPUT,from:START,to:END,symbols:SYMBOLS.length,sha256,
  coverage:Object.fromEntries(datasets.map(d=>[d.symbol,d.coverage])),funding:Object.fromEntries(datasets.map(d=>[d.symbol,d.funding.length]))},null,2));
