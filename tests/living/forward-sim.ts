/** Test-only causal replay of advanceForward over the fixture: worker-like 5m data-cycle rule, closed bars only, Gate-like quotes. */
import {advanceForward,initialForward,type ForwardState,type Candle,type Quote,type Contract} from "../../lib/forward-relations.ts";
import {livingFixture,fixtureContracts,segmentAt,priceAt,sha,type Bar} from "./fixture.ts";

export const GOLDEN_SYMBOLS=["BTC_USDT","ETH_USDT","SOL_USDT","XRP_USDT","DOGE_USDT","BNB_USDT","SUI_USDT","HYPE_USDT","NEAR_USDT","DOT_USDT",
  "ENA_USDT","ZRO_USDT","LIT_USDT","STRK_USDT","WLD_USDT","FIL_USDT","ZEC_USDT","AVAX_USDT","LTC_USDT","BCH_USDT","UNI_USDT","ARB_USDT",
  "OP_USDT","APT_USDT","TAO_USDT","TIA_USDT","PEPE_USDT","WLFI_USDT","ONDO_USDT","CRV_USDT"];

export function fiveMinute(rows:Bar[],until:number){
  const out:Candle[]=[];
  for(const r of rows){
    if((r.time+60)*1000>until)break;
    const t=Math.floor(r.time/300)*300,last=out.at(-1);
    if(last&&last.time===t){last.high=Math.max(last.high,r.high);last.low=Math.min(last.low,r.low);last.close=r.close;last.volume+=r.volume;}
    else out.push({time:t,open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume});
  }
  // only completed 5m bars, visible 8s after the close (worker fetch grace)
  while(out.length&&(out.at(-1)!.time+300)*1000>until-8_000)out.pop();
  return out.slice(-120);
}
export function quoteOf(price:number,prior:number|null,now:number):Quote{
  const half=.0001,move=prior&&prior>0?price/prior-1:0;
  return {bestBid:price*(1-half),bestAsk:price*(1+half),observedAt:now-300,fresh:true,entryReady:true,sourceCount:4,disagreementRate:.0005,
    sourceBreadth:Math.sign(move),directionalAgreement:move?0.8:0.5,medianShortMove:move,spreadRate:2*half,bookImbalance:0,
    bidLiquidityChange:0,askLiquidityChange:0,liquiditySourceCount:3};
}
export type SimInputs={now:number;paths:Record<string,Candle[]>;minutePaths:Record<string,Candle[]>;quotes:Record<string,Quote>;
  contracts:Record<string,Contract>;allowDataCycle:boolean;btc1hPct:number|null;mids:Record<string,number>};
export function simInputs(state:ForwardState,now:number,symbols:string[],cache:{paths?:Record<string,Candle[]>;pathsAt?:number}={}):SimInputs{
  const seg=segmentAt(now),contracts=fixtureContracts();
  const minuteKey=Math.floor(now/60_000);
  if(cache.pathsAt!==minuteKey||!cache.paths){
    cache.paths=Object.fromEntries(symbols.map(s=>[s,fiveMinute(seg.bars[s]!,now)]));cache.pathsAt=minuteKey;
  }
  const paths:Record<string,Candle[]>={};
  for(const s of symbols){const rows=cache.paths![s]!.filter(r=>(r.time+300)*1000<=now-8_000);paths[s]=rows;}
  const minutePaths:Record<string,Candle[]>={},quotes:Record<string,Quote>={},mids:Record<string,number>={};
  for(const s of symbols){
    const rows=seg.bars[s]!,end=Math.floor(now/60_000)*60,i=Math.max(0,(end-rows[0]!.time)/60);
    minutePaths[s]=rows.slice(Math.max(0,i-90),i).map(r=>({...r}));
    const px=priceAt(rows,now),prior=priceAt(rows,now-4_000);
    if(px!=null){quotes[s]=quoteOf(px,prior,now);mids[s]=px;}
  }
  const btc=priceAt(seg.bars.BTC_USDT!,now),btc1h=priceAt(seg.bars.BTC_USDT!,now-3_600_000);
  const dataDue=!state.lastCycleAt||Math.floor((now-90_000)/300_000)>Math.floor((state.lastCycleAt-90_000)/300_000);
  return {now,paths,minutePaths,quotes,contracts:Object.fromEntries(symbols.map(s=>[s,contracts[s]!])),allowDataCycle:dataDue,
    btc1hPct:btc&&btc1h?(btc/btc1h-1)*100:null,mids};
}
/** Runs ticks [from,to) every stepMs. `extra` lets a test add input fields (e.g. a living directive). */
export function runForward(opts:{from:number;to:number;stepMs:number;symbols?:string[];digestEvery?:number;
  extra?:(state:ForwardState,inputs:SimInputs)=>Record<string,unknown>|undefined;onTick?:(state:ForwardState,inputs:SimInputs)=>void}){
  livingFixture();
  const symbols=opts.symbols??GOLDEN_SYMBOLS,cache={};
  let state=initialForward(opts.from-600_000);const digests:string[]=[];let i=0;
  for(let now=opts.from;now<opts.to;now+=opts.stepMs,i++){
    const inp=simInputs(state,now,symbols,cache);
    const extra=opts.extra?.(state,inp)??{};
    state=advanceForward({state,now,paths:inp.paths,minutePaths:inp.minutePaths,quotes:inp.quotes,analysisQuotes:inp.quotes,
      contracts:inp.contracts,entrySymbols:symbols,allowDataCycle:inp.allowDataCycle,btc1hPct:inp.btc1hPct,
      referenceMids:{BTC_USDT:inp.mids.BTC_USDT??null,ETH_USDT:inp.mids.ETH_USDT??null},...extra}).state;
    opts.onTick?.(state,inp);
    if(opts.digestEvery&&i%opts.digestEvery===0)digests.push(sha(state).slice(0,16));
  }
  return {state,digests,final:sha(state)};
}
