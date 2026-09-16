const H=3600,DAY=86400;
const end=Math.floor(Date.now()/1000/300)*300;
const start=end-2*DAY;
const symbols=['BTC_USDT','ETH_USDT','SOL_USDT'];
const out={interval:'5m',start,end,results:{}};
for(const symbol of symbols){
  const url=`https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${encodeURIComponent(symbol)}&from=${start}&to=${end-1}&interval=5m&limit=1000`;
  const r=await fetch(url,{headers:{Accept:'application/json'}});
  const text=await r.text();
  if(!r.ok){out.results[symbol]={ok:false,status:r.status,body:text.slice(0,500)};continue;}
  let a;try{a=JSON.parse(text);}catch{a=[];}
  const times=Array.isArray(a)?a.map(x=>Number(x.time)).filter(Number.isFinite).sort((x,y)=>x-y):[];
  const sample=Array.isArray(a)&&a.length?a[Math.floor(a.length/2)]:null;
  out.results[symbol]={ok:Array.isArray(a)&&a.length>0,status:r.status,count:Array.isArray(a)?a.length:0,first:times[0]??null,last:times.at(-1)??null,spacing:times.length>1?times[1]-times[0]:null,keys:sample?Object.keys(sample).sort():[],sample:sample?{
    time:sample.time,mark_price:sample.mark_price,open_interest:sample.open_interest,open_interest_usd:sample.open_interest_usd,
    long_taker_size:sample.long_taker_size,short_taker_size:sample.short_taker_size,long_liq_usd:sample.long_liq_usd,long_liq_usd_new:sample.long_liq_usd_new,
    short_liq_usd:sample.short_liq_usd,short_liq_usd_new:sample.short_liq_usd_new,lsr_account:sample.lsr_account,lsr_taker:sample.lsr_taker,top_lsr_account:sample.top_lsr_account,top_lsr_size:sample.top_lsr_size
  }:null};
}
const usable=Object.values(out.results).every(x=>x.ok&&x.count>=500&&x.spacing===300);
out.decision=usable?'GATE_5M_STATS_HISTORY_USABLE':'GATE_5M_STATS_HISTORY_NOT_USABLE';
console.log(JSON.stringify(out,null,2));