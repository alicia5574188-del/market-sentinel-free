import {readFileSync,writeFileSync} from "node:fs";

const BASES=["https://api.gateio.ws/api/v4","https://fx-api.gateio.ws/api/v4"];
const INPUT=process.env.PREDICTIVE_DATASET??"/tmp/gate-predictive-12m.json";
const OUTPUT=process.env.PREDICTIVE_ANCILLARY??"/tmp/gate-predictive-ancillary.json";
const raw=JSON.parse(readFileSync(INPUT,"utf8"));
const symbols=raw.symbols??raw.datasets?.map(x=>x.symbol)??[],from=Number(raw.from),to=Number(raw.now);
if(!symbols.length||!(from>0&&to>from))throw new Error("predictive ancillary input invalid");
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function get(path){
  let last;
  for(const base of BASES){
    try{
      const response=await fetch(base+path,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(8_000)});
      if(!response.ok){await response.body?.cancel().catch(()=>undefined);throw new Error("Gate "+response.status);}
      return await response.json();
    }catch(error){last=error;}
  }
  throw last??new Error("Gate ancillary fetch failed");
}
async function stats(symbol){
  const out=[];let cursor=from,guard=0;
  while(cursor<to&&guard++<32){
    const rows=await get("/futures/usdt/contract_stats?contract="+encodeURIComponent(symbol)+"&from="+Math.floor(cursor)+"&interval=1h&limit=1000");
    const clean=(Array.isArray(rows)?rows:[]).filter(x=>Number(x.time)>0).sort((a,b)=>Number(a.time)-Number(b.time));
    if(!clean.length)break;
    for(const x of clean)if(Number(x.time)>=from&&Number(x.time)<to)out.push({
      time:Number(x.time),openInterest:Number(x.open_interest??0),openInterestUsd:Number(x.open_interest_usd??0),
      longLiqUsd:Number(x.long_liq_usd_new??x.long_liq_usd??0),shortLiqUsd:Number(x.short_liq_usd_new??x.short_liq_usd??0),
      lsrTaker:Number(x.lsr_taker??0),lsrAccount:Number(x.lsr_account??0),topLsrSize:Number(x.top_lsr_size??0)
    });
    const next=Number(clean.at(-1).time)+3600;if(next<=cursor)break;cursor=next;await pause(80);
  }
  return [...new Map(out.map(x=>[x.time,x])).values()].sort((a,b)=>a.time-b.time);
}
async function funding(symbol){
  const out=[];let cursor=from;
  while(cursor<to){
    const end=Math.min(to,cursor+150*86_400);
    const rows=await get("/futures/usdt/funding_rate?contract="+encodeURIComponent(symbol)+"&from="+Math.floor(cursor)+"&to="+Math.floor(end)+"&limit=1000");
    for(const x of Array.isArray(rows)?rows:[])if(Number(x.t)>=from&&Number(x.t)<to)out.push({time:Number(x.t),rate:Number(x.r??0)});
    cursor=end;await pause(60);
  }
  return [...new Map(out.map(x=>[x.time,x])).values()].sort((a,b)=>a.time-b.time);
}
async function premium(symbol){
  const out=[];let cursor=from;
  while(cursor<to){
    const end=Math.min(to,cursor+30*86_400);
    const rows=await get("/futures/usdt/premium_index?contract="+encodeURIComponent(symbol)+"&from="+Math.floor(cursor)+"&to="+Math.floor(end)+"&interval=1h");
    for(const x of Array.isArray(rows)?rows:[])if(Number(x.t)>=from&&Number(x.t)<to)out.push({time:Number(x.t),close:Number(x.c??0)});
    cursor=end;await pause(60);
  }
  return [...new Map(out.map(x=>[x.time,x])).values()].sort((a,b)=>a.time-b.time);
}
const datasets={};let cursor=0;
async function worker(){
  while(cursor<symbols.length){
    const symbol=symbols[cursor++];try{
      const [s,f,p]=await Promise.all([stats(symbol),funding(symbol),premium(symbol)]);
      datasets[symbol]={stats:s,funding:f,premium:p};
      console.log(symbol+" stats="+s.length+" funding="+f.length+" premium="+p.length);
    }catch(error){datasets[symbol]={stats:[],funding:[],premium:[],error:String(error?.message??error)};console.log(symbol+" failed "+String(error?.message??error));}
  }
}
await Promise.all(Array.from({length:Math.min(4,symbols.length)},worker));
const good=symbols.filter(s=>datasets[s]?.stats?.length>100&&datasets[s]?.funding?.length>20&&datasets[s]?.premium?.length>100);
if(good.length<Math.min(8,symbols.length))throw new Error("insufficient ancillary history: "+good.length+"/"+symbols.length);
writeFileSync(OUTPUT,JSON.stringify({version:"predictive-gate-ancillary-v1",source:"gate-public-futures-stats-funding-premium",from,to,symbols,good,datasets})+"\n");
console.log(JSON.stringify({output:OUTPUT,good:good.length,total:symbols.length},null,2));
