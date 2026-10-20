/** Test-only: drive the tape + fast lane from fixture 1m klines (2s mids interpolated inside each minute). */
import {LivingTape,selectBasket,type Basket} from "../../lib/living/tape.ts";
import {initialFast,stepFast,type FastState,type FastEvent,type FastSample} from "../../lib/living/fast-lane.ts";
import {livingFixture,segmentAt,priceAt} from "./fixture.ts";

export function fixtureBasket(at:number):Basket{
  const fx=livingFixture(),seg=segmentAt(at);
  return selectBasket(fx.volumeRank.filter(s=>seg.bars[s]).map((s,i)=>({symbol:s,volume24hUsd:1e9-i,sources:3,gate:true})),at);
}
export function feedTape(tape:LivingTape,symbols:string[],at:number){
  const seg=segmentAt(at);
  tape.feed(symbols.flatMap(s=>{const p=priceAt(seg.bars[s]!,at,true);return p?[{symbol:s,mid:p,at:at-200,spread:.0002,disagreement:.0005,sources:3,volume24hUsd:5e7}]:[];}),at);
}
/** Warm 6h at 10s, then 2s steps through [from,to). */
export function runFast(opts:{from:number;to:number;warmMs?:number;onStep?:(r:{state:FastState;sample:FastSample;events:FastEvent[]},tape:LivingTape)=>void}){
  const basket=fixtureBasket(opts.from),symbols=[...basket.members,"BTC_USDT","ETH_USDT"],tape=new LivingTape();
  let state=initialFast();const events:FastEvent[]=[];
  const start=opts.from-(opts.warmMs??6*3_600_000);
  for(let at=start;at<opts.to;at+=at<opts.from-15*60_000?10_000:2_000){
    feedTape(tape,symbols,at);
    const r=stepFast(state,tape,basket,at);state=r.state;
    if(at>=opts.from){events.push(...r.events);opts.onStep?.(r,tape);}
  }
  return {state,events,tape,basket};
}
