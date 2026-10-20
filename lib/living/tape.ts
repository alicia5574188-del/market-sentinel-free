/**
 * B1 data layer. Fed only from quotes the program already fetched (MarketDataHub bulk tickers every ~1.5-2s, Gate radar
 * every 15s). No request of its own. Keeps 2s mids for ~11 minutes and 1m/5m mid bars for 26 hours in memory; the 5m bars
 * are paged into own keys so a restart can warm up (2s points / 1m bars rebuild in ~10 minutes).
 */
import {FAST,LIVING_KEY_PREFIX,LIVING_MAX_VALUE_BYTES} from "./config.ts";
import {bytesOf} from "./util.ts";

export type MidBar={time:number;open:number;high:number;low:number;close:number};
export type TapeMeta={spread:number;disagreement:number;sources:number;volume24hUsd:number;change24h:number;imbalance:number;at:number};
export type TapePoint={symbol:string;mid:number;at:number;spread?:number;disagreement?:number;sources?:number;volume24hUsd?:number;
  change24h?:number;imbalance?:number};
const RING=Math.ceil(FAST.ringMs/1_000)+16;// one slot per second at most
const KEEP_1M=26*60,KEEP_5M=26*12;
export const BAR_PAGE_PREFIX=`${LIVING_KEY_PREFIX}bars5m:`;
export const BAR_PAGES=6;
/** 1m bars of the last M1_PAGE_MIN minutes (basket + majors + followed coins) so a restart resumes the intent read at once. */
export const M1_PAGE_PREFIX=`${LIVING_KEY_PREFIX}bars1m:`;
export const M1_PAGES=3;
export const M1_PAGE_MIN=75;

class Ring{t=new Float64Array(RING);p=new Float64Array(RING);n=0;head=0;
  push(at:number,mid:number){
    const last=this.n?this.t[(this.head-1+RING)%RING]!:-Infinity;if(at<=last)return false;
    this.t[this.head]=at;this.p[this.head]=mid;this.head=(this.head+1)%RING;this.n=Math.min(RING,this.n+1);return true;}
  last(){return this.n?{at:this.t[(this.head-1+RING)%RING]!,mid:this.p[(this.head-1+RING)%RING]!}:null;}
  oldest(){return this.n?this.t[(this.head-this.n+RING)%RING]!:null;}
  /** Latest point at or before `at`. */
  at(at:number){
    let lo=0,hi=this.n-1,best=-1;
    while(lo<=hi){const m=(lo+hi)>>1,i=(this.head-this.n+m+RING)%RING;if(this.t[i]!<=at){best=i;lo=m+1;}else hi=m-1;}
    return best<0?null:{at:this.t[best]!,mid:this.p[best]!};
  }
}
export class LivingTape{
  private rings=new Map<string,Ring>();
  readonly m1=new Map<string,MidBar[]>();
  readonly m5=new Map<string,MidBar[]>();
  readonly meta=new Map<string,TapeMeta>();
  lastFeedAt=0;feeds=0;

  feed(points:TapePoint[],now:number){
    let n=0;
    for(const q of points){
      if(!(q.mid>0)||!Number.isFinite(q.mid)||!(q.at>0))continue;
      let ring=this.rings.get(q.symbol);if(!ring){ring=new Ring();this.rings.set(q.symbol,ring);}
      if(!ring.push(q.at,q.mid))continue;n++;
      this.bar(this.m1,q.symbol,q.at,q.mid,60,KEEP_1M);this.bar(this.m5,q.symbol,q.at,q.mid,300,KEEP_5M);
      this.meta.set(q.symbol,{spread:q.spread??0,disagreement:q.disagreement??0,sources:q.sources??1,volume24hUsd:q.volume24hUsd??0,
        change24h:q.change24h??0,imbalance:q.imbalance??0,at:q.at});
    }
    if(n){this.lastFeedAt=now;this.feeds++;}
    return n;
  }
  private bar(map:Map<string,MidBar[]>,symbol:string,at:number,mid:number,sec:number,keep:number){
    const t=Math.floor(at/1000/sec)*sec;let rows=map.get(symbol);if(!rows){rows=[];map.set(symbol,rows);}
    const last=rows.at(-1);
    if(last&&last.time===t){if(mid>last.high)last.high=mid;if(mid<last.low)last.low=mid;last.close=mid;return;}
    if(last&&last.time>t)return;
    rows.push({time:t,open:mid,high:mid,low:mid,close:mid});if(rows.length>keep)rows.splice(0,rows.length-keep);
  }
  symbols(){return[...this.rings.keys()];}
  last(symbol:string){return this.rings.get(symbol)?.last()??null;}
  /** Mid at or before `at` within the ring. */
  midAt(symbol:string,at:number){return this.rings.get(symbol)?.at(at)??null;}
  coverageMs(symbol:string,now:number){const o=this.rings.get(symbol)?.oldest();return o==null?0:now-o;}
  fresh(symbol:string,now:number){const l=this.last(symbol);return !!l&&now-l.at<=FAST.freshMs;}
  /** r(Δ): latest fresh mid vs the mid Δ seconds earlier. Null when either side is missing. */
  ret(symbol:string,now:number,sec:number){
    const ring=this.rings.get(symbol);if(!ring)return null;const a=ring.last();if(!a||now-a.at>FAST.freshMs)return null;
    const b=ring.at(a.at-sec*1000);if(!b||a.at-b.at>sec*1000+FAST.freshMs)return null;
    return a.mid/b.mid-1;
  }
  /** Completed 5m bars (bar end <= now). */
  closed5(symbol:string,now:number){const rows=this.m5.get(symbol)??[];return rows.filter(r=>(r.time+300)*1000<=now);}
  closed1(symbol:string,now:number){const rows=this.m1.get(symbol)??[];return rows.filter(r=>(r.time+60)*1000<=now);}
  /** Warm-up: merge older 5m bars (e.g. the program's existing strategyCandles) without overwriting own bars. */
  seed5(symbol:string,bars:{time:number;open:number;high:number;low:number;close:number}[]){
    const own=this.m5.get(symbol)??[],first=own[0]?.time??Infinity,known=new Set(own.map(r=>r.time));
    const add=bars.filter(r=>r.time<first&&!known.has(r.time)&&r.close>0).map(r=>({time:r.time,open:r.open,high:r.high,low:r.low,close:r.close}));
    if(!add.length)return 0;
    const rows=[...add,...own].sort((a,b)=>a.time-b.time).slice(-KEEP_5M);this.m5.set(symbol,rows);return add.length;
  }
  /** Own-key pages of the 5m bars: symbols split across BAR_PAGES keys, each value ≤ 96KB (oldest bars dropped first). */
  pages():Record<string,unknown>{
    const syms=[...this.m5.keys()].sort(),out:Record<string,unknown>={};
    for(let p=0;p<BAR_PAGES;p++){
      const part=syms.filter((_,i)=>i%BAR_PAGES===p),value:{v:1;s:Record<string,[number,number,number[]]>}={v:1,s:{}};
      for(const s of part){const rows=this.m5.get(s)!;if(rows.length)value.s[s]=encodeBars(rows);}
      let keep=KEEP_5M;
      while(bytesOf(value)>LIVING_MAX_VALUE_BYTES-512&&keep>12){keep=Math.floor(keep*.85);
        for(const s of part){const rows=this.m5.get(s)!.slice(-keep);if(rows.length)value.s[s]=encodeBars(rows);}}
      out[`${BAR_PAGE_PREFIX}${p}`]=value;
    }
    return out;
  }
  /** Own-key pages of recent 1m bars (newest M1_PAGE_MIN minutes), symbols split across M1_PAGES keys, each ≤ 96KB. */
  pages1(symbols:string[]):Record<string,unknown>{
    const syms=[...new Set(symbols)].filter(s=>this.m1.has(s)).sort(),out:Record<string,unknown>={};
    for(let p=0;p<M1_PAGES;p++){
      const part=syms.filter((_,i)=>i%M1_PAGES===p);let keep=M1_PAGE_MIN;
      const build=()=>{const value:{v:1;step:60;s:Record<string,[number,number,number[]]>}={v:1,step:60,s:{}};
        for(const s of part){const rows=this.m1.get(s)!.slice(-keep);if(rows.length)value.s[s]=encodeBars(rows,60);}return value;};
      let value=build();
      while(bytesOf(value)>LIVING_MAX_VALUE_BYTES-512&&keep>15){keep=Math.floor(keep*.85);value=build();}
      out[`${M1_PAGE_PREFIX}${p}`]=value;
    }
    return out;
  }
  /** Restart: merge saved 1m bars (never over live ones), then rebuild the 5m bars the hourly 5m pages did not have yet. */
  restore1(values:unknown[],now:number){
    let n=0;
    for(const v of values){const page=v as {v?:number;step?:number;s?:Record<string,[number,number,number[]]>}|undefined;if(page?.v!==1||page.step!==60||!page.s)continue;
      for(const [s,enc] of Object.entries(page.s)){
        const rows=decodeBars(enc,60).filter(r=>(r.time+60)*1000<=now);if(!rows.length)continue;
        const own=this.m1.get(s)??[],first=own[0]?.time??Infinity,add=rows.filter(r=>r.time<first);
        this.m1.set(s,[...add,...own].slice(-KEEP_1M));n++;
        const m5=this.m5.get(s)??[],last5=m5.at(-1)?.time??-Infinity,built:MidBar[]=[];
        for(const r of add){const t=Math.floor(r.time/300)*300;if(t<=last5)continue;const b=built.at(-1);
          if(b&&b.time===t){b.high=Math.max(b.high,r.high);b.low=Math.min(b.low,r.low);b.close=r.close;}else built.push({time:t,open:r.open,high:r.high,low:r.low,close:r.close});}
        if(built.length)this.m5.set(s,[...m5,...built].slice(-KEEP_5M));
      }
    }
    return n;
  }
  restore(values:unknown[]){
    let n=0;
    for(const v of values){const page=v as {v?:number;s?:Record<string,[number,number,number[]]>}|undefined;if(page?.v!==1||!page.s)continue;
      for(const [s,enc] of Object.entries(page.s)){const rows=decodeBars(enc);if(rows.length){this.seed5(s,rows);n++;}}}
    return n;
  }
}
/** [firstTime, p0, flat int deltas o,h,l,c vs previous close in 1e-5 of p0]. Bars are contiguous 5m with gaps encoded by time jumps. */
export function encodeBars(rows:MidBar[],step=300):[number,number,number[]]{
  const p0=rows[0]!.open,d:number[]=[];let prev=p0,t=rows[0]!.time;
  for(const r of rows){
    const gap=Math.round((r.time-t)/step);if(gap>0)d.push(1e9+gap);// gap marker
    t=r.time+step;
    const q=(x:number)=>Math.round((x-prev)/p0*1e5);
    d.push(q(r.open),q(r.high),q(r.low),q(r.close));prev=prev+q(r.close)*p0/1e5;
  }
  return [rows[0]!.time,p0,d];
}
export function decodeBars([time,p0,d]:[number,number,number[]],step=300):MidBar[]{
  const out:MidBar[]=[];let prev=p0,t=time;
  for(let i=0;i<d.length;){
    if(d[i]!>=1e9){t+=(d[i]!-1e9)*step;i++;continue;}
    if(i+3>=d.length)break;
    const at=(q:number)=>prev+q*p0/1e5,o=at(d[i]!),h=at(d[i+1]!),l=at(d[i+2]!),c=at(d[i+3]!);
    out.push({time:t,open:o,high:Math.max(h,o,c),low:Math.min(l,o,c),close:c});prev=c;t+=step;i+=4;
  }
  return out;
}

/** B1 basket: Gate contract + ≥2 external venues + top 60 by 24h volume, no stablecoins; fixed for the UTC day. */
const STABLE=/^(USDC|USDT|USDE|FDUSD|DAI|TUSD|USD1|PYUSD|USDD|BUSD|EURC|USDP|FRAX|RLUSD|USTC|XAUT|PAXG)_USDT$/;
export type Basket={day:string;at:number;members:string[];majors:["BTC_USDT","ETH_USDT"];top10:string[]};
export function selectBasket(rows:{symbol:string;volume24hUsd:number;sources:number;gate:boolean}[],now:number):Basket{
  const day=new Date(now).toISOString().slice(0,10);
  const ok=rows.filter(r=>r.gate&&r.sources>=2&&!STABLE.test(r.symbol)&&r.symbol!=="BTC_USDT"&&r.symbol!=="ETH_USDT"&&r.volume24hUsd>0)
    .sort((a,b)=>b.volume24hUsd-a.volume24hUsd||a.symbol.localeCompare(b.symbol)).slice(0,FAST.basketSize).map(r=>r.symbol);
  return {day,at:now,members:ok,majors:["BTC_USDT","ETH_USDT"],top10:ok.slice(0,10)};
}
export function basketDue(b:Basket|null,now:number){return !b||b.day!==new Date(now).toISOString().slice(0,10)||b.members.length<10;}
/** Mid-day delisting: drop, never refill. */
export function pruneBasket(b:Basket,listed:(s:string)=>boolean):Basket{
  const members=b.members.filter(listed);return members.length===b.members.length?b:{...b,members,top10:b.top10.filter(listed)};
}
