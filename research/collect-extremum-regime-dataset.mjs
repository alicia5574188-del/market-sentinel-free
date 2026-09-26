import { writeFile } from "node:fs/promises";

const SOURCES=["BYBIT","OKX","KUCOIN","BITGET"];
const SYMBOLS=(process.env.SYMBOLS??"BTC,ETH,SOL,XRP,DOGE,ADA,LINK,BCH").split(",").map(x=>x.trim().toUpperCase()).filter(Boolean);
const LIMIT=Number(process.env.LIMIT??120);
const collectedAt=Date.now();

async function getJson(url){
  const res=await fetch(url,{headers:{accept:"application/json","user-agent":"market-sentinel-extremum-lab/1.1"},signal:AbortSignal.timeout(3500)});
  if(!res.ok)throw new Error(`HTTP ${res.status}`);
  return res.json();
}
function normalize(rows,seconds,limit){
  const completed=Math.floor(Date.now()/1000/seconds)*seconds;
  const valid=rows.filter(r=>r&&Number.isFinite(r.time)&&r.time>0&&[r.open,r.high,r.low,r.close,r.volume].every(Number.isFinite)
    &&r.open>0&&r.close>0&&r.low>0&&r.high>=Math.max(r.open,r.close)&&r.low<=Math.min(r.open,r.close)&&r.time+seconds<=completed)
    .sort((a,b)=>a.time-b.time);
  return [...new Map(valid.map(r=>[r.time,r])).values()].slice(-limit);
}
async function bybit(base,interval,limit){
  const i=interval==="1m"?"1":"5",seconds=interval==="1m"?60:300;
  const body=await getJson(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${base}USDT&interval=${i}&limit=${limit}`);
  if(body.retCode!==0||!Array.isArray(body.result?.list))throw new Error("Bybit payload");
  return normalize(body.result.list.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])})),seconds,limit);
}
async function okx(base,interval,limit){
  const seconds=interval==="1m"?60:300;
  const body=await getJson(`https://www.okx.com/api/v5/market/candles?instId=${base}-USDT-SWAP&bar=${interval}&limit=${limit}`);
  if(body.code!=="0"||!Array.isArray(body.data))throw new Error("OKX payload");
  return normalize(body.data.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])})),seconds,limit);
}
async function kucoin(base,interval,limit){
  const seconds=interval==="1m"?60:300,symbol=(base==="BTC"?"XBT":base)+"USDTM",end=Date.now(),start=end-(limit+6)*seconds*1000;
  const body=await getJson(`https://api-futures.kucoin.com/api/v1/kline/query?symbol=${symbol}&granularity=${seconds}&from=${start}&to=${end}`);
  if(body.code!=="200000"||!Array.isArray(body.data))throw new Error("KuCoin payload");
  return normalize(body.data.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])})),seconds,limit);
}
async function bitget(base,interval,limit){
  const seconds=interval==="1m"?60:300;
  const body=await getJson(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}USDT&productType=USDT-FUTURES&granularity=${interval}&limit=${limit}`);
  if(body.code!=="00000"||!Array.isArray(body.data))throw new Error("Bitget payload");
  return normalize(body.data.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])})),seconds,limit);
}
async function fetchSource(source,base,interval,limit){
  if(source==="BYBIT")return bybit(base,interval,limit);
  if(source==="OKX")return okx(base,interval,limit);
  if(source==="KUCOIN")return kucoin(base,interval,limit);
  return bitget(base,interval,limit);
}

const candles=Object.fromEntries(SYMBOLS.map(s=>[s,{"5m":{},"1m":{}}])),errors=[];
for(const interval of ["5m","1m"]){
  const tasks=[];
  for(const base of SYMBOLS)for(const source of SOURCES)tasks.push({base,source,p:fetchSource(source,base,interval,LIMIT)});
  const settled=await Promise.allSettled(tasks.map(x=>x.p));
  settled.forEach((result,i)=>{
    const {base,source}=tasks[i];
    if(result.status==="fulfilled"&&result.value.length>=30)candles[base][interval][source]=result.value;
    else errors.push({base,interval,source,error:result.status==="rejected"?String(result.reason?.message??result.reason):"too few rows"});
  });
}
const coverage={};
for(const base of SYMBOLS){
  coverage[base]={};
  for(const interval of ["5m","1m"]){
    const src=Object.keys(candles[base][interval]);
    coverage[base][interval]={sources:src,sourceCount:src.length,rows:Object.fromEntries(src.map(s=>[s,candles[base][interval][s].length]))};
  }
}
const dataset={version:"extremum-regime-dataset-v1.1",collectedAt,generatedAt:Date.now(),symbols:SYMBOLS,sources:SOURCES,limit:LIMIT,coverage,errors,candles};
await writeFile("extremum-regime-dataset.json",JSON.stringify(dataset));
console.log(JSON.stringify({version:dataset.version,collectedAt,symbols:SYMBOLS.length,errors:errors.length,coverage},null,2));
