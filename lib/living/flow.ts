/**
 * Capital-flow tape for the living layer (v2). Fed ONLY from payloads the program already receives:
 *  - external hub bulk tickers every ~2s (Bybit linear tickers carry openInterest / fundingRate / markPrice / indexPrice /
 *    turnover24h; every venue's last-vs-bid/ask gives an aggressor proxy),
 *  - the Gate bulk radar every 15s (total_size open interest, funding_rate, mark/index price),
 *  - the worker's existing 15-minute Gate OI snapshots (lib/oi-anchor.ts) for the warm-up after a restart.
 * No request of its own. Keeps 1-minute flow bars for 3 hours in memory; the last 90 minutes are paged into own keys.
 */
import {LIVING_KEY_PREFIX,LIVING_MAX_VALUE_BYTES} from "./config.ts";
import {bytesOf,median,clamp,finite} from "./util.ts";

export type FlowSource="B"|"G";
/** One per-symbol flow observation. `oi` is in the source's own unit (only % changes are used). */
export type FlowPoint={symbol:string;at:number;src:FlowSource;oi?:number|null;funding?:number|null;basis?:number|null;
  /** aggressor proxy in [-1,1]: +1 = last trade printed at the ask (buyers lifting) */taker?:number|null;
  /** estimated traded USD since the previous point of this source */volUsd?:number|null};
/** 1-minute flow bar: [time(sec), oiB, oiG, funding, basis, takerSum, takerN, volUsd] (null = not seen). */
export type FlowBar=[number,number|null,number|null,number|null,number|null,number,number,number];
const KEEP_MIN=180,PAGE_MIN=90;
export const FLOW_PAGE_PREFIX=`${LIVING_KEY_PREFIX}flow:`;
export const FLOW_PAGES=3;

export class FlowBook{
  readonly m1=new Map<string,FlowBar[]>();
  /** 24h-average USD per minute per symbol (volume baseline) */
  readonly base=new Map<string,number>();
  private turnover=new Map<string,{at:number;v:number}>();
  lastAt=0;points=0;
  /** Hub (Bybit and others) payload already received; turnover24h is converted to traded USD per interval. */
  feed(points:FlowPoint[],now:number){
    for(const p of points){
      if(!p.symbol||!(p.at>0))continue;
      const t=Math.floor(p.at/60_000)*60;let rows=this.m1.get(p.symbol);if(!rows){rows=[];this.m1.set(p.symbol,rows);}
      let bar=rows.at(-1);
      if(!bar||bar[0]<t){bar=[t,bar?.[1]??null,bar?.[2]??null,bar?.[3]??null,bar?.[4]??null,0,0,0];
        // carry levels forward (a level unseen this minute is still the last known level), flows start at zero
        if(rows.length&&rows.at(-1)![0]<t-600){bar[1]=null;bar[2]=null;}
        rows.push(bar);if(rows.length>KEEP_MIN)rows.splice(0,rows.length-KEEP_MIN);}
      else if(bar[0]>t)continue;
      if(finite(p.oi)&&p.oi>0){if(p.src==="B")bar[1]=p.oi;else bar[2]=p.oi;}
      if(finite(p.funding))bar[3]=p.funding;
      if(finite(p.basis))bar[4]=p.basis;
      if(finite(p.taker)){bar[5]+=clamp(p.taker,-1,1);bar[6]++;}
      if(finite(p.volUsd)&&p.volUsd>0)bar[7]+=p.volUsd;
      this.points++;
    }
    this.lastAt=now;
  }
  /** turnover24h (USD) → traded USD since the last reading: Δturnover + the 24h-average rate × Δt (the part rolling off). */
  volFromTurnover(symbol:string,at:number,turnover24h:number){
    if(!(turnover24h>0))return null;
    this.base.set(symbol,turnover24h/1440);
    const prev=this.turnover.get(symbol);this.turnover.set(symbol,{at,v:turnover24h});
    if(!prev||at<=prev.at||at-prev.at>60_000)return null;
    const dt=at-prev.at,inc=turnover24h-prev.v+turnover24h*dt/86_400_000;
    return inc>0?inc:0;
  }
  setBaseline(symbol:string,usdPerMinute:number){if(usdPerMinute>0)this.base.set(symbol,usdPerMinute);}
  /** Seed Gate OI levels from the existing 15-minute snapshots (warm-up only; never overwrites a live value). */
  seedOi(ring:readonly {at:number;oi:Record<string,number>}[]){
    let n=0;
    for(const snap of ring)for(const [s,v] of Object.entries(snap.oi)){
      if(!(v>0))continue;const t=Math.floor(snap.at/60_000)*60;let rows=this.m1.get(s);if(!rows){rows=[];this.m1.set(s,rows);}
      if(rows.some(r=>r[0]===t))continue;if(rows.length&&rows[0]![0]<t)continue;// only older than what we have
      rows.unshift([t,null,v,null,null,0,0,0]);rows.sort((a,b)=>a[0]-b[0]);n++;
    }
    return n;
  }
  bars(symbol:string){return this.m1.get(symbol)??[];}
  /** Level of a field at or before `at` (searching back ≤ `tolMin` minutes). */
  private levelAt(rows:FlowBar[],i:1|2|3|4,at:number,tolMin=6){
    const t=Math.floor(at/60_000)*60;
    for(let k=rows.length-1;k>=0;k--){const r=rows[k]!;if(r[0]>t)continue;if(t-r[0]>tolMin*60)return null;const v=r[i];if(v!=null)return v;}
    return null;
  }
  /** OI % change over `min` minutes, averaged over the sources that have both ends (Bybit 2s, Gate 15s). */
  oiChange(symbol:string,now:number,min:number){
    const rows=this.bars(symbol);if(!rows.length)return null;const xs:number[]=[];
    for(const i of [1,2] as const){
      const a=this.levelAt(rows,i,now,3),b=this.levelAt(rows,i,now-min*60_000,Math.max(6,min/4));
      if(a!=null&&b!=null&&b>0)xs.push(a/b-1);
    }
    return xs.length?xs.reduce((x,y)=>x+y,0)/xs.length:null;
  }
  funding(symbol:string,now:number){return this.levelAt(this.bars(symbol),3,now,30);}
  fundingChange(symbol:string,now:number,min:number){
    const a=this.funding(symbol,now),b=this.levelAt(this.bars(symbol),3,now-min*60_000,30);return a!=null&&b!=null?a-b:null;
  }
  basis(symbol:string,now:number){return this.levelAt(this.bars(symbol),4,now,10);}
  /** Mean aggressor proxy over the last `min` minutes (null when < 3 samples). */
  taker(symbol:string,now:number,min:number){
    const rows=this.bars(symbol),t0=Math.floor(now/60_000)*60-(min-1)*60;let s=0,n=0;
    for(let k=rows.length-1;k>=0&&rows[k]![0]>=t0;k--){s+=rows[k]![5];n+=rows[k]![6];}
    return n>=3?s/n:null;
  }
  /** Traded USD over the last `min` minutes vs the 24h-average pace (null when unknown). The open minute counts pro rata. */
  volRatio(symbol:string,now:number,min:number){
    const base=this.base.get(symbol);if(!(base&&base>0))return null;
    const rows=this.bars(symbol),cur=Math.floor(now/60_000)*60,t0=cur-(min-1)*60;let v=0,seen=0;
    for(let k=rows.length-1;k>=0&&rows[k]![0]>=t0;k--){v+=rows[k]![7];if(rows[k]![7]>0)seen++;}
    if(!seen)return null;
    const span=(min-1)+Math.max(.1,(now/1000-cur)/60);
    return v/(base*span);
  }
  /** Basket aggregate: median of per-coin values (needs ≥ `minN`). */
  aggregate(symbols:string[],f:(s:string)=>number|null,minN=8){
    const xs:number[]=[];for(const s of symbols){const v=f(s);if(v!=null&&Number.isFinite(v))xs.push(v);}
    return xs.length>=minN?{v:median(xs),n:xs.length}:{v:null,n:xs.length};
  }
  has(symbol:string){return this.m1.has(symbol);}
  /** Own-key pages: the last 90 one-minute bars per symbol, split over FLOW_PAGES keys, each ≤ 96KB. */
  pages(symbols:string[]):Record<string,unknown>{
    const out:Record<string,unknown>={},syms=[...new Set(symbols)].filter(s=>this.m1.has(s)).sort();
    for(let p=0;p<FLOW_PAGES;p++){
      const part=syms.filter((_,i)=>i%FLOW_PAGES===p);let keep=PAGE_MIN;
      const build=()=>({v:1,s:Object.fromEntries(part.map(s=>[s,this.m1.get(s)!.slice(-keep).map(r=>r.map(x=>x==null?null:typeof x==="number"?Math.round(x*1e8)/1e8:x))]))});
      let value=build();while(bytesOf(value)>LIVING_MAX_VALUE_BYTES-512&&keep>10){keep=Math.floor(keep*.8);value=build();}
      out[`${FLOW_PAGE_PREFIX}${p}`]=value;
    }
    return out;
  }
  restore(values:unknown[]){
    let n=0;
    for(const v of values){const page=v as {v?:number;s?:Record<string,FlowBar[]>}|undefined;if(page?.v!==1||!page.s)continue;
      for(const [s,rows] of Object.entries(page.s)){if(!Array.isArray(rows)||this.m1.has(s))continue;
        this.m1.set(s,rows.filter(r=>Array.isArray(r)&&r.length===8).slice(-KEEP_MIN) as FlowBar[]);n++;}}
    return n;
  }
}
/** Aggressor proxy of one venue quote: where the last print sits inside the spread (+1 at/above ask, −1 at/below bid). */
export function aggressor(last:number,bid:number,ask:number){
  if(!(last>0&&bid>0&&ask>bid))return null;const mid=(bid+ask)/2,half=(ask-bid)/2;return clamp((last-mid)/half,-1,1);
}
