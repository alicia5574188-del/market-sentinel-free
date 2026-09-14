import { writeFileSync } from "node:fs";

const BASE="https://api.gateio.ws/api/v4";
const OUTPUT=process.env.PREMIUM_DATASET??"/tmp/gate-premium-8h-12m.json";
const SYMBOLS=(process.env.PREMIUM_SYMBOLS??"BTC_USDT,ETH_USDT,SOL_USDT,XRP_USDT,BNB_USDT,DOGE_USDT,ADA_USDT,LINK_USDT,LTC_USDT,AVAX_USDT,BCH_USDT,SUI_USDT,UNI_USDT,AAVE_USDT,FIL_USDT,ARB_USDT,PEPE_USDT,APT_USDT").split(",").filter(Boolean);
const FROM=Math.floor(Date.UTC(2025,8,1)/1000),TO=Math.floor(Date.UTC(2026,8,1)/1000),INTERVAL=8*3600;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(path){for(let attempt=0;attempt<5;attempt++){const res=await fetch(BASE+path,{headers:{Accept:"application/json"}});if(res.ok)return res.json();const text=await res.text();if(res.status===429||res.status>=500){await sleep(500*(attempt+1));continue;}throw new Error(`${path} -> ${res.status} ${text}`);}throw new Error(`${path} exhausted retries`);}
async function fetchPremium(symbol){const all=[],chunk=INTERVAL*850;for(let a=FROM;a<TO;a+=chunk){const b=Math.min(TO-1,a+chunk-1);const rows=await get(`/futures/usdt/premium_index?contract=${encodeURIComponent(symbol)}&from=${a}&to=${b}&interval=8h`);if(Array.isArray(rows))all.push(...rows);await sleep(120);}const by=new Map();for(const r of all){const t=Number(r.t);if(t>=FROM&&t<TO)by.set(t,{t,o:Number(r.o),h:Number(r.h),l:Number(r.l),c:Number(r.c)});}return [...by.values()].sort((a,b)=>a.t-b.t);}
async function fetchFunding(symbol){try{const rows=await get(`/futures/usdt/funding_rate?contract=${encodeURIComponent(symbol)}&limit=1000`);return (Array.isArray(rows)?rows:[]).map(r=>({t:Number(r.t),r:Number(r.r)})).filter(r=>Number.isFinite(r.t)&&Number.isFinite(r.r)).sort((a,b)=>a.t-b.t);}catch{return [];}}
const expected=Math.floor((TO-FROM)/INTERVAL),datasets=[];
for(const symbol of SYMBOLS){const premium=await fetchPremium(symbol);await sleep(150);const funding=await fetchFunding(symbol);await sleep(150);const coverage=premium.length/expected;datasets.push({symbol,premium,funding,coverage,first:premium[0]?.t??null,last:premium.at(-1)?.t??null});console.log(JSON.stringify({symbol,premium:premium.length,coverage,funding:funding.length,first:premium[0]?.t,last:premium.at(-1)?.t}));}
const usable=datasets.filter(d=>d.coverage>=.95);
const report={source:"gate-public-api-v4",generatedAt:new Date().toISOString(),from:FROM,to:TO,interval:"8h",expectedPoints:expected,symbols:SYMBOLS,usableSymbols:usable.map(d=>d.symbol),datasets};
writeFileSync(OUTPUT,JSON.stringify(report)+"\n");
console.log("PREMIUM_DATASET_RESULT="+JSON.stringify({output:OUTPUT,expected,usable:usable.map(d=>({symbol:d.symbol,coverage:d.coverage,premium:d.premium.length,funding:d.funding.length}))},null,2));