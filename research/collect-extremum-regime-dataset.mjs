import { writeFile } from "node:fs/promises";

const SOURCES=["GATE","BYBIT","OKX","KUCOIN","BITGET","BINANCE"];
const SYMBOLS=(process.env.SYMBOLS??"BROCCOLI,PUMP,BTW,NIL,ONE,ONDO,BTC,ETH,SOL,NEAR,SAGA,AKE,ENA,XLM,XPL,ZEC,VIRTUAL,FET,ADA,FIL,LSK,BR,LIT,XRP,XAI")
  .split(",").map(x=>x.trim().toUpperCase()).filter(Boolean);
const LIMITS={"5m":Number(process.env.LIMIT_5M??1000),"1m":Number(process.env.LIMIT_1M??1000)};
const collectedAt=Date.now();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getJson(url){
  const res=await fetch(url,{headers:{accept:"application/json","user-agent":"market-sentinel-extremum-lab/1.4"},signal:AbortSignal.timeout(5000)});
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
  const i=interval==="1m"?"1":"5",seconds=interval==="1m"?60:300,n=Math.min(1000,limit);
  const body=await getJson(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${base}USDT&interval=${i}&limit=${n}`);
  if(body.retCode!==0||!Array.isArray(body.result?.list))throw new Error("Bybit payload");
  return normalize(body.result.list.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])})),seconds,limit);
}
async function okx(base,interval,limit){
  const seconds=interval==="1m"?60:300,inst=`${base}-USDT-SWAP`;
  let rows=[],after=null,guard=0;
  while(rows.length<limit&&guard++<8){
    const n=Math.min(300,limit-rows.length);
    const endpoint=rows.length?"history-candles":"candles";
    const cursor=after==null?"":`&after=${after}`;
    const body=await getJson(`https://www.okx.com/api/v5/market/${endpoint}?instId=${encodeURIComponent(inst)}&bar=${interval}&limit=${n}${cursor}`);
    if(body.code!=="0"||!Array.isArray(body.data)||!body.data.length)break;
    const page=normalize(body.data.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])})),seconds,n+5);
    if(!page.length)break;
    rows=[...page,...rows];
    const oldest=page[0].time*1000;
    if(after===oldest)break;
    after=oldest;
    if(page.length<n&&rows.length<limit)break;
    await sleep(60);
  }
  rows=normalize(rows,seconds,limit);
  if(rows.length<Math.min(30,limit))throw new Error("OKX payload");
  return rows;
}
async function kucoin(base,interval,limit){
  const seconds=interval==="1m"?60:300,symbol=(base==="BTC"?"XBT":base)+"USDTM",end=Date.now(),start=end-(limit+6)*seconds*1000;
  const body=await getJson(`https://api-futures.kucoin.com/api/v1/kline/query?symbol=${symbol}&granularity=${seconds}&from=${start}&to=${end}`);
  if(body.code!=="200000"||!Array.isArray(body.data))throw new Error("KuCoin payload");
  return normalize(body.data.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])})),seconds,limit);
}
async function gate(base,interval,limit){
  const seconds=interval==="1m"?60:300,n=Math.min(2000,limit);
  const body=await getJson(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${base}_USDT&interval=${interval}&limit=${n}`);
  if(!Array.isArray(body))throw new Error("Gate payload");
  return normalize(body.map(r=>({time:Number(r.t),open:Number(r.o),high:Number(r.h),low:Number(r.l),close:Number(r.c),volume:Number(r.v)})),seconds,limit);
}
async function binance(base,interval,limit){
  const seconds=interval==="1m"?60:300,n=Math.min(1500,limit);
  const body=await getJson(`https://fapi.binance.com/fapi/v1/klines?symbol=${base}USDT&interval=${interval}&limit=${n}`);
  if(!Array.isArray(body))throw new Error("Binance payload");
  return normalize(body.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])})),seconds,limit);
}
async function bitget(base,interval,limit){
  const seconds=interval==="1m"?60:300,n=Math.min(1000,limit);
  const body=await getJson(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${base}USDT&productType=USDT-FUTURES&granularity=${interval}&limit=${n}`);
  if(body.code!=="00000"||!Array.isArray(body.data))throw new Error("Bitget payload");
  return normalize(body.data.map(r=>({time:Number(r[0])/1000,open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])})),seconds,limit);
}
async function fetchSource(source,base,interval,limit){
  if(source==="GATE")return gate(base,interval,limit);
  if(source==="BYBIT")return bybit(base,interval,limit);
  if(source==="OKX")return okx(base,interval,limit);
  if(source==="KUCOIN")return kucoin(base,interval,limit);
  if(source==="BINANCE")return binance(base,interval,limit);
  return bitget(base,interval,limit);
}

const candles=Object.fromEntries(SYMBOLS.map(s=>[s,{"5m":{},"1m":{}}])),errors=[];
for(const interval of ["5m","1m"]){
  const limit=LIMITS[interval];
  for(let offset=0;offset<SYMBOLS.length;offset+=5){
    const batch=SYMBOLS.slice(offset,offset+5),tasks=[];
    for(const base of batch)for(const source of SOURCES)tasks.push({base,source,p:fetchSource(source,base,interval,limit)});
    const settled=await Promise.allSettled(tasks.map(x=>x.p));
    settled.forEach((result,i)=>{
      const {base,source}=tasks[i];
      if(result.status==="fulfilled"&&result.value.length>=30)candles[base][interval][source]=result.value;
      else errors.push({base,interval,source,error:result.status==="rejected"?String(result.reason?.message??result.reason):"too few rows"});
    });
    await sleep(180);
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
const dataset={version:"extremum-regime-dataset-v1.4",collectedAt,generatedAt:Date.now(),symbols:SYMBOLS,sources:SOURCES,limits:LIMITS,coverage,errors,candles};
await writeFile("extremum-regime-dataset.json",JSON.stringify(dataset));
console.log(JSON.stringify({version:dataset.version,collectedAt,symbols:SYMBOLS.length,errors:errors.length,coverage},null,2));
