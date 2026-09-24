import { writeFileSync } from "node:fs";

const BASE="https://api.gateio.ws/api/v4";
const OUTPUT=process.env.STATS_DATASET??"/tmp/gate-contract-stats-4h.json";
const SYMBOLS=(process.env.STATS_SYMBOLS??"BTC_USDT,ETH_USDT,SOL_USDT,XRP_USDT,BNB_USDT,DOGE_USDT,ADA_USDT,LINK_USDT,LTC_USDT,AVAX_USDT,BCH_USDT,SUI_USDT,UNI_USDT,AAVE_USDT,FIL_USDT,ARB_USDT,PEPE_USDT,APT_USDT").split(",").filter(Boolean);
const FROM=Math.floor(Date.UTC(2026,2,20)/1000),TO=Math.floor(Date.UTC(2026,8,1)/1000),STEP=4*3600;
const expected=Math.floor((TO-FROM)/STEP);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(path){for(let attempt=0;attempt<5;attempt++){const res=await fetch(BASE+path,{headers:{Accept:"application/json"}});if(res.ok)return res.json();const text=await res.text();if(res.status===429||res.status>=500){await sleep(400*(attempt+1));continue;}throw new Error(`${path} -> ${res.status} ${text}`);}throw new Error(`${path} exhausted retries`);}
const num=(v)=>{const x=Number(v);return Number.isFinite(x)?x:0;};
async function fetchStats(symbol){const rows=await get(`/futures/usdt/contract_stats?contract=${encodeURIComponent(symbol)}&from=${FROM}&interval=4h&limit=1000`);const by=new Map();for(const r of Array.isArray(rows)?rows:[]){const time=num(r.time);if(time<FROM||time>=TO)continue;by.set(time,{time,mark_price:num(r.mark_price),open_interest:num(r.open_interest),open_interest_usd:num(r.open_interest_usd),lsr_taker:num(r.lsr_taker),lsr_account:num(r.lsr_account),top_lsr_size:num(r.top_lsr_size),top_lsr_account:num(r.top_lsr_account),long_taker_size:num(r.long_taker_size),short_taker_size:num(r.short_taker_size),long_liq_usd:num(r.long_liq_usd_new??r.long_liq_usd),short_liq_usd:num(r.short_liq_usd_new??r.short_liq_usd),long_users:num(r.long_users),short_users:num(r.short_users),last_funding_rate:num(r.last_funding_rate)});}return [...by.values()].sort((a,b)=>a.time-b.time);}
const datasets=[];
for(const symbol of SYMBOLS){try{const rows=await fetchStats(symbol),coverage=rows.length/expected;datasets.push({symbol,rows,coverage,first:rows[0]?.time??null,last:rows.at(-1)?.time??null});console.log(JSON.stringify({symbol,rows:rows.length,coverage,first:rows[0]?.time,last:rows.at(-1)?.time}));}catch(e){datasets.push({symbol,rows:[],coverage:0,error:e.message});console.log(JSON.stringify({symbol,error:e.message}));}await sleep(120);}
const usable=datasets.filter(d=>d.coverage>=.90);
const report={source:"gate-public-contract-stats-v4",generatedAt:new Date().toISOString(),from:FROM,to:TO,interval:"4h",stepSeconds:STEP,expectedPoints:expected,symbols:SYMBOLS,usableSymbols:usable.map(d=>d.symbol),datasets};
writeFileSync(OUTPUT,JSON.stringify(report)+"\n");
console.log("CONTRACT_STATS_DATASET_RESULT="+JSON.stringify({output:OUTPUT,expected,usable:usable.map(d=>({symbol:d.symbol,coverage:d.coverage,rows:d.rows.length}))},null,2));