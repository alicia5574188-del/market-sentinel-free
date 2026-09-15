import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const OUTPUT = process.env.RESEARCH_OUTPUT ?? "/tmp/gate-anchor-data-audit.json";
const API = "https://api.gateio.ws/api/v4";
const ARCHIVE = "https://download.gatedata.org/futures_usdt/mark_prices";
const SYMBOLS = ["BTC_USDT", "SOL_USDT", "SUI_USDT"];
const WINDOWS = ["2023-09-15", "2024-09-15", "2025-09-15", "2026-06-15"];
const MONTHS = ["202309", "202409", "202509", "202606"];
const STEP = 300, EXPECTED = 288;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const epoch = (date) => Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);

function pct(values, q) { const a = values.filter(Number.isFinite).sort((x,y)=>x-y); return a.length ? a[Math.floor((a.length-1)*q)] : null; }
function bps(a,b) { return Math.abs((a / b - 1) * 10_000); }
function mapClose(rows) { return new Map(rows.map((r)=>[Number(r.t),Number(r.c)]).filter(([,v])=>Number.isFinite(v))); }
function gaps(rows, step=STEP) { const t=rows.map((r)=>Number(r.t)).filter(Number.isFinite).sort((a,b)=>a-b); let n=0; for(let i=1;i<t.length;i+=1) if(t[i]!==t[i-1]+step)n+=1; return n; }

async function getJson(path) {
  let last;
  for (let attempt=0; attempt<2; attempt+=1) {
    try {
      const r=await fetch(`${API}${path}`, { headers:{Accept:"application/json","User-Agent":"market-sentinel-research"}, signal:AbortSignal.timeout(5_000) });
      const text=await r.text();
      if(!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0,180)}`);
      const value=JSON.parse(text); if(!Array.isArray(value)) throw new Error(`Expected array`); return value;
    } catch(error) { last=error; await sleep(250*(attempt+1)); }
  }
  throw last;
}
async function fetchSeries(kind,symbol,from,to,interval) {
  if(kind==="premium") return getJson(`/futures/usdt/premium_index?contract=${symbol}&from=${from}&to=${to}&interval=${interval}`);
  const contract=kind==="trade"?symbol:`${kind}_${symbol}`;
  return getJson(`/futures/usdt/candlesticks?contract=${contract}&from=${from}&to=${to}&interval=${interval}`);
}
async function apiProbe(date,symbol) {
  const from=epoch(date), to=from+86_400-STEP, kinds=["trade","mark","index","premium"];
  const settled=await Promise.allSettled(kinds.map((kind)=>fetchSeries(kind,symbol,from,to,"5m")));
  const data={}, errors={}, out={date,symbol,expected:EXPECTED,errors};
  for(const [i,kind] of kinds.entries()) { if(settled[i].status==="fulfilled") data[kind]=settled[i].value; else {data[kind]=[]; errors[kind]=String(settled[i].reason?.message??settled[i].reason);} }
  for(const kind of kinds) { out[`${kind}Count`]=data[kind].length; out[`${kind}Coverage`]=data[kind].length/EXPECTED; out[`${kind}Gaps`]=gaps(data[kind]); }
  const m=Object.fromEntries(kinds.map((k)=>[k,mapClose(data[k])])), tri=[...m.trade.keys()].filter((t)=>m.mark.has(t)&&m.index.has(t)), quad=tri.filter((t)=>m.premium.has(t));
  out.anchorAligned=tri.length; out.anchorAlignment=tri.length/EXPECTED; out.premiumAligned=quad.length; out.premiumAlignment=quad.length/EXPECTED;
  const tm=tri.map((t)=>bps(m.trade.get(t),m.mark.get(t))), mi=tri.map((t)=>bps(m.mark.get(t),m.index.get(t))), pr=quad.map((t)=>Math.abs(m.premium.get(t))*10_000);
  out.tradeVsMarkAbsBps={p50:pct(tm,.5),p95:pct(tm,.95),max:tm.length?Math.max(...tm):null};
  out.markVsIndexAbsBps={p50:pct(mi,.5),p95:pct(mi,.95),max:mi.length?Math.max(...mi):null};
  out.premiumAbsBps={p50:pct(pr,.5),p95:pct(pr,.95),max:pr.length?Math.max(...pr):null};
  out.anchorCorePass=out.tradeCoverage>=.98&&out.markCoverage>=.98&&out.indexCoverage>=.98&&out.anchorAlignment>=.98;
  out.premiumPass=out.premiumCoverage>=.98&&out.premiumAlignment>=.98;
  return out;
}
async function archiveProbe(month,symbol) {
  const url=`${ARCHIVE}/${month}/${symbol}-${month}.csv.gz`;
  try {
    const r=await fetch(url,{method:"HEAD",headers:{"User-Agent":"market-sentinel-research"},signal:AbortSignal.timeout(8_000)});
    return {month,symbol,url,status:r.status,contentLength:Number(r.headers.get("content-length")??0),contentType:r.headers.get("content-type"),exists:r.ok};
  } catch(error) { return {month,symbol,url,status:null,contentLength:0,exists:false,error:String(error?.message??error)}; }
}

const apiProbes=[];
for(const date of WINDOWS) for(const symbol of SYMBOLS) { apiProbes.push(await apiProbe(date,symbol)); await sleep(80); }

const minuteProbes=[];
for(const date of ["2023-09-15","2026-06-15"]) for(const symbol of ["BTC_USDT","ETH_USDT"]) {
  const from=epoch(date),to=from+3_600-60,kinds=["trade","mark","index","premium"],settled=await Promise.allSettled(kinds.map((k)=>fetchSeries(k,symbol,from,to,"1m"))),rec={date,symbol,expected:60};
  for(const [i,kind] of kinds.entries()) { if(settled[i].status==="fulfilled") rec[`${kind}Count`]=settled[i].value.length; else {rec[`${kind}Count`]=0;rec[`${kind}Error`]=String(settled[i].reason?.message??settled[i].reason);} }
  rec.pass=kinds.every((k)=>rec[`${k}Count`]>=59); minuteProbes.push(rec);
}

const archiveProbes=[];
for(const month of MONTHS) for(const symbol of SYMBOLS) { archiveProbes.push(await archiveProbe(month,symbol)); await sleep(80); }

const apiAnchorPasses=apiProbes.filter((r)=>r.anchorCorePass).length, apiPremiumPasses=apiProbes.filter((r)=>r.premiumPass).length, minutePasses=minuteProbes.filter((r)=>r.pass).length, archivePasses=archiveProbes.filter((r)=>r.exists).length;
const archiveUsable=archivePasses===archiveProbes.length;
const raw={generatedAt:new Date().toISOString(),symbols:SYMBOLS,windows:WINDOWS,months:MONTHS,apiProbes,minuteProbes,archiveProbes};
const sha256=createHash("sha256").update(JSON.stringify(raw)).digest("hex");
const output={
  research:"gate-anchor-data-audit-v1",
  objective:"verify whether Gate has a sufficiently long official trade/index/mark data foundation for anchored convergence research, using REST where possible and official monthly mark_prices archives otherwise",
  officialArchiveSchema:"futures_usdt mark_prices: timestamp,index_price,mark_price,last_price",
  decision:archiveUsable?"ARCHIVE_ANCHOR_DATA_USABLE":"ANCHOR_DATA_INSUFFICIENT",
  restDecision:apiAnchorPasses===apiProbes.length&&minutePasses===minuteProbes.length?"REST_USABLE":"REST_RECENT_ONLY",
  premiumDecision:apiPremiumPasses===apiProbes.length&&minutePasses===minuteProbes.length?"PREMIUM_REST_USABLE":"PREMIUM_REST_RECENT_ONLY",
  diagnostics:{apiProbes:apiProbes.length,apiAnchorPasses,apiPremiumPasses,minuteProbes:minuteProbes.length,minutePasses,archiveProbes:archiveProbes.length,archivePasses},
  sha256,...raw,
};
writeFileSync(OUTPUT,`${JSON.stringify(output,null,2)}\n`);
console.log(`GATE_ANCHOR_DATA_AUDIT=${JSON.stringify(output)}`);
