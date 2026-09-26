import { writeFile } from "node:fs/promises";

const SOURCES = ["BYBIT","OKX","KUCOIN","BITGET"];
const SYMBOLS = (process.env.SYMBOLS ?? "BTC,ETH,SOL,XRP,DOGE,ADA,LINK,BCH,LTC,AVAX,DOT,NEAR")
  .split(",").map(x=>x.trim().toUpperCase()).filter(Boolean);
const LIMIT = Number(process.env.LIMIT ?? 300);
const collectedAt = Date.now();

const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function getJson(url, attempts=3){
  let last;
  for(let i=0;i<attempts;i++){
    try{
      const res = await fetch(url,{headers:{accept:"application/json","user-agent":"market-sentinel-extremum-lab/1.0"},signal:AbortSignal.timeout(12000)});
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }catch(err){
      last = err;
      if(i+1<attempts) await sleep(400*(i+1));
    }
  }
  throw last;
}

function normalize(rows, seconds, limit){
  const completed = Math.floor(Date.now()/1000/seconds)*seconds;
  const valid = rows.filter(r=>r && Number.isFinite(r.time) && r.time>0 &&
      [r.open,r.high,r.low,r.close,r.volume].every(Number.isFinite) &&
      r.open>0 && r.close>0 && r.low>0 && r.high>=Math.max(r.open,r.close) &&
      r.low<=Math.min(r.open,r.close) && r.time+seconds<=completed)
    .sort((a,b)=>a.time-b.time);
  const unique = [...new Map(valid.map(r=>[r.time,r])).values()];
  return unique.slice(-limit);
}

async function bybit(base, interval, limit){
  const i = interval==="1m" ? "1" : "5";
  const body = await getJson(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${base}USDT&interval=${i}&limit=${Math.min(1000,limit)}`);
  if(body.retCode!==0 || !Array.isArray(body.result?.list)) throw new Error("Bybit payload");
  const seconds=interval==="1m"?60:300;
  return normalize(body.result.list.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])})),seconds,limit);
}

async function okx(base, interval, limit){
  const body = await getJson(`https://www.okx.com/api/v5/market/candles?instId=${base}-USDT-SWAP&bar=${interval}&limit=${Math.min(300,limit)}`);
  if(body.code!=="0" || !Array.isArray(body.data)) throw new Error("OKX payload");
  const seconds=interval==="1m"?60:300;
  return normalize(body.data.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])})),seconds,limit);
}

async function bitget(base, interval, limit){
  const body = await getJson(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}USDT&productType=USDT-FUTURES&granularity=${interval}&limit=${Math.min(1000,limit)}`);
  if(body.code!=="00000" || !Array.isArray(body.data)) throw new Error("Bitget payload");
  const seconds=interval==="1m"?60:300;
  return normalize(body.data.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])})),seconds,limit);
}

async function kucoin(base, interval, limit){
  const seconds=interval==="1m"?60:300;
  const symbol=(base==="BTC"?"XBT":base)+"USDTM";
  let end=Date.now(), out=[];
  while(out.length<limit){
    const need=Math.min(120,limit-out.length);
    const start=end-(need+4)*seconds*1000;
    const body=await getJson(`https://api-futures.kucoin.com/api/v1/kline/query?symbol=${symbol}&granularity=${seconds}&from=${start}&to=${end}`);
    if(body.code!=="200000" || !Array.isArray(body.data)) throw new Error("KuCoin payload");
    const page=normalize(body.data.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])})),seconds,need+4);
    if(!page.length) break;
    out=[...page,...out];
    end=page[0].time*1000-1;
    await sleep(120);
  }
  return normalize(out,seconds,limit);
}

async function fetchSource(source, base, interval, limit){
  if(source==="BYBIT") return bybit(base,interval,limit);
  if(source==="OKX") return okx(base,interval,limit);
  if(source==="KUCOIN") return kucoin(base,interval,limit);
  return bitget(base,interval,limit);
}

const candles={}, errors=[];
for(const base of SYMBOLS){
  candles[base]={};
  for(const interval of ["5m","1m"]){
    candles[base][interval]={};
    const settled=await Promise.allSettled(SOURCES.map(async source=>{
      const rows=await fetchSource(source,base,interval,LIMIT);
      return {source,rows};
    }));
    for(let i=0;i<settled.length;i++){
      const source=SOURCES[i];
      const result=settled[i];
      if(result.status==="fulfilled" && result.value.rows.length>=30){
        candles[base][interval][source]=result.value.rows;
      }else{
        errors.push({base,interval,source,error:result.status==="rejected"?String(result.reason?.message??result.reason):"too few rows"});
      }
    }
    await sleep(250);
  }
}

const coverage={};
for(const base of SYMBOLS){
  coverage[base]={};
  for(const interval of ["5m","1m"]){
    const src=Object.keys(candles[base][interval]);
    coverage[base][interval]={sources:src,sourceCount:src.length,rows:Object.fromEntries(src.map(s=>[s,candles[base][interval][s].length]))};
  }
}

const dataset={
  version:"extremum-regime-dataset-v1",
  collectedAt,
  generatedAt:Date.now(),
  symbols:SYMBOLS,
  sources:SOURCES,
  limit:LIMIT,
  coverage,
  errors,
  candles
};
await writeFile("extremum-regime-dataset.json",JSON.stringify(dataset));
console.log(JSON.stringify({version:dataset.version,collectedAt,symbols:SYMBOLS.length,errors:errors.length,coverage},null,2));
