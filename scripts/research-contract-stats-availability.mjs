const dates=['202508','202601','202604','202608','202609'];
const symbols=['BTC_USDT','ETH_USDT','SOL_USDT'];
const ts=m=>Date.UTC(+m.slice(0,4),+m.slice(4,6)-1,1)/1000;
async function get(url){for(let i=0;i<4;i++){const r=await fetch(url,{headers:{Accept:'application/json'}});if(r.ok)return await r.json();if(r.status===429||r.status>=500){await new Promise(x=>setTimeout(x,500*(i+1)));continue}return {error:r.status,text:await r.text()}}return {error:'retry_exhausted'}}
const out=[];
for(const month of dates)for(const symbol of symbols)for(const interval of ['1h','5m']){
 const from=ts(month),url=`https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${encodeURIComponent(symbol)}&from=${from}&interval=${interval}&limit=1000`,a=await get(url);
 if(Array.isArray(a)){const times=a.map(x=>Number(x.time)).filter(Number.isFinite).sort((x,y)=>x-y);out.push({month,symbol,interval,count:a.length,minTime:times[0]??null,maxTime:times.at(-1)??null,first:a[0]??null,last:a.at(-1)??null})}else out.push({month,symbol,interval,response:a});
}
console.log(JSON.stringify(out,null,2));