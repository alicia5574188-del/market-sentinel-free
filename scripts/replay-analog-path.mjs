// Bounded read-only replay of public completed candles; no keys, orders or parameter fitting.
import {buildAnalogCandidate,evaluateAnalogPosition} from '../lib/analog-path-strategy.ts';
import {buildHistoricalForecast,cleanAnalogCandles} from '../lib/historical-forecast.ts';
import {resolveScalpExit} from '../lib/scalp-strategy.ts';
const coins=['BTC_USDT','ETH_USDT','SOL_USDT','BNB_USDT','XRP_USDT','DOGE_USDT'];
const base='https://api.gateio.ws/api/v4';
async function get(path){const r=await fetch(base+path,{signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error(`行情读取 HTTP ${r.status}`);return r.json();}
const reports=[];let tickers;
try{tickers=await get('/futures/usdt/tickers');}catch(e){console.log(JSON.stringify({check:'analog_path_replay',available:false,reason:e.message}));process.exit(0);}
let btc=[];
for(const symbol of coins){
 try{
  const payload=await get(`/futures/usdt/candlesticks?contract=${symbol}&interval=5m&limit=1000`);
  const parse=payload=>cleanAnalogCandles(payload.map(c=>Array.isArray(c)?{time:+c[0],volume:+c[1],close:+c[2],high:+c[3],low:+c[4],open:+c[5]}:{time:+c.t,volume:+c.v,close:+c.c,high:+c.h,low:+c.l,open:+c.o}),Date.now());
  let rows=parse(payload);
  if(rows.length<200)throw new Error('完整历史不足200根');
  for(let page=0;page<10&&rows[0].time*1000>Date.now()-30*86400000;page++){
    const to=rows[0].time-1,from=to-72*3600;
    await new Promise(r=>setTimeout(r,1100));
    const older=parse(await get(`/futures/usdt/candlesticks?contract=${symbol}&interval=5m&from=${from}&to=${to}`));
    if(!older.length)break;
    const first=rows[0].time;rows=cleanAnalogCandles([...older,...rows],Date.now());if(rows[0].time>=first)break;
  }
  if(symbol==='BTC_USDT')btc=rows;
  const ticker=tickers.find(t=>t.contract===symbol),volumeUsd=Number(ticker?.volume_24h_usd??ticker?.volume_24h_quote??0);
  let position=null,intent=undefined,lastExit=0,signals=0,closed=0,wins=0,netR=0;const blockers={},trades=[];let minSamples=Infinity,maxSamples=0,readyForecasts=0;
  const start=Math.max(100,rows.length-144);
  for(let i=start;i<rows.length;i++){
   const bar=rows[i],now=bar.time*1000+300000,history=rows.slice(0,i+1);
   if(position){const p=position,decision=evaluateAnalogPosition({...p,currentPrice:bar.close,observedAt:now,candles:history});
    const exit=resolveScalpExit({side:p.side,stop:p.currentStopPrice,target:p.target,price:bar.close,open:bar.open,high:bar.high,low:bar.low,timeout:now>=p.expiresAt,decision});
    if(exit){const net=(p.side==='LONG'?1:-1)*(exit.price-p.entryPrice)-p.entryPrice*.0012,tradeR=net/p.risk;netR+=tradeR;closed++;wins+=Number(net>0);trades.push({side:p.side,entryAt:p.entryAt,minutes:(now-p.entryAt)/60000,exit:exit.code,netR:+tradeR.toFixed(3),stopPct:+(Math.abs(p.entryPrice-p.initialStopPrice)/p.entryPrice*100).toFixed(3),targetPct:+(Math.abs(p.target-p.entryPrice)/p.entryPrice*100).toFixed(3),expectedNetR:+p.expectedNetR.toFixed(2),takeProfitPct:+p.takeProfitPct.toFixed(0),lossPct:+p.lossPct.toFixed(0),mode:p.mode});position=null;lastExit=now;}
    else if(decision.proposedStopPrice!=null)p.currentStopPrice=p.side==='LONG'?Math.max(p.currentStopPrice,decision.proposedStopPrice):Math.min(p.currentStopPrice,decision.proposedStopPrice);
   }
   const forecast=buildHistoricalForecast({candles:history,now,costBps:12,stopPct:.3});
   minSamples=Math.min(minSamples,forecast.sampleCount);maxSamples=Math.max(maxSamples,forecast.sampleCount);readyForecasts+=Number(forecast.state==='READY');
   const c=buildAnalogCandidate({symbol,candles:history,btcCandles:btc.filter(b=>b.time<=bar.time),now,price:bar.close,volumeUsd,volumeRank:1,costBps:12,forecast,intent});
   intent=c.analogIntent;
   if(c.decision==='WAIT'){for(const b of c.checks.filter(b=>!b.passed))blockers[b.label]=(blockers[b.label]??0)+1;continue;}
   signals++;if(position||now-lastExit<300000||c.scalp.structureAt<=lastExit)continue;
   position={side:c.decision,entryPrice:bar.close,initialStopPrice:c.invalidationPrice,currentStopPrice:c.invalidationPrice,entryAt:now,roundTripCostBps:12,confirmationPrice:c.scalp.confirmationPrice,target:c.targets[1],expiresAt:now+c.maxHoldingMinutes*60000,risk:Math.abs(bar.close-c.invalidationPrice)+bar.close*.0012,expectedNetR:c.analogIntent.expectedNetR,takeProfitPct:c.analogIntent.takeProfitPct,lossPct:c.analogIntent.lossPct,mode:c.analogIntent.mode};
  }
  reports.push({symbol,available:true,bars:rows.length,from:rows[start].time*1000,to:rows.at(-1).time*1000+300000,signals,closed,wins,netR:+netR.toFixed(3),stillOpen:!!position,minSamples,maxSamples,readyForecasts,historyFrom:rows[0].time*1000,blockers,trades});
 }catch(e){reports.push({symbol,available:false,reason:e.message});}
 await new Promise(r=>setTimeout(r,1100));
}
console.log(JSON.stringify({check:'analog_path_replay',assumptions:'最近12小时，收盘入场、同根止损优先、往返成本12基点；现时24h成交额仅作筛选代理，未模拟组合资金/日亏/滑点/网络延迟，不是可实盘收益承诺',reports}));
