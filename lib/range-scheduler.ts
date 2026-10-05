import type {RangeEvent,RangeDiscovery} from './anomaly-range.ts';
import type {QuoteLike} from './market-intelligence-engine.ts';
export type RangeRank={symbol:string;rank:number;score:number;reason:string;selected:boolean};
/** 0 when the relevant 5-minute bar just closed; otherwise milliseconds until the next close. */
export function msUntilFiveClose(now:number,anchor=now){
  const barEnd=Math.floor(anchor/300000)*300000+300000;
  if(now>=barEnd&&now-barEnd<=120000)return 0;
  return Math.floor(now/300000)*300000+300000-now;
}
export function rangePriority(e:RangeEvent,q:QuoteLike|undefined,now:number){
  const usable=!!q?.fresh&&q.observedAt<=now&&now-q.observedAt<=10000&&q.priceSource===e.source&&(q.sourceCount??0)>=2&&(q.disagreementRate??0)<=.008,
    proof=e.proof&&now-e.proof.at<=120000&&e.proof.at<=now&&Math.abs(e.price-e.proof.price)<=e.n5?e.proof:undefined;
  if(e.phase==='EXECUTING')return{score:10000,reason:'已提交，保留执行'};
  if(usable&&e.active&&proof?.kind==='WICK')return{score:925,reason:'影线已经收完'};
  if(usable&&e.active&&proof)return{score:900,reason:'证明已完成'};
  if(usable&&e.active)return{score:800-Math.min(300,Math.round(msUntilFiveClose(now,e.lastAt||e.detectedAt)/1000)),reason:'等待这根5分钟收完'};
  const strength=Math.min(30,Math.max(0,e.score-60));
  if(!usable)return{score:strength,reason:'分析报价暂不可执行'};
  if(!e.active)return{score:40+strength,reason:'近期成交不足，轮换观察'};
  return{score:100+strength,reason:'等待这根5分钟收完'};
}
const hash=(symbol:string)=>[...symbol].reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,0);
/** Eight merit seats plus two rotating checks; fresh actionable proofs win all seats. */
export function selectRangePlans(events:RangeEvent[],quotes:Record<string,QuoteLike>,now:number,limit=10){
  const ranked=events.map(e=>({e,...rangePriority(e,quotes[e.symbol],now)}))
    .sort((a,b)=>b.score-a.score||msUntilFiveClose(now,a.e.lastAt||a.e.detectedAt)-msUntilFiveClose(now,b.e.lastAt||b.e.detectedAt)||a.e.detectedAt-b.e.detectedAt||a.e.symbol.localeCompare(b.e.symbol));
  const protectedRows=ranked.filter(r=>r.score>=900),ordinary=ranked.filter(r=>r.score<900),
    remaining=Math.max(0,limit-protectedRows.length),merit=ordinary.slice(0,Math.max(0,remaining-2)),
    tail=ordinary.slice(merit.length).sort((a,b)=>hash(a.e.symbol)-hash(b.e.symbol)),
    offset=tail.length?Math.floor(now/60000)*Math.min(2,remaining)%tail.length:0,
    rotating=[...tail.slice(offset),...tail.slice(0,offset)].slice(0,remaining-merit.length),
    selected=new Set([...protectedRows.slice(0,limit),...merit,...rotating].map(r=>r.e.symbol));
  const ranking:RangeRank[]=ranked.map((r,i)=>({symbol:r.e.symbol,rank:i+1,score:r.score,reason:r.reason,selected:selected.has(r.e.symbol)}));
  return{selected,ranking};
}
/** Bars about to close are loaded before bars that still have several minutes left. */
export function rankRangeDiscovery(anomalies:RangeDiscovery['anomalies'],now:number,limit=30){
  const remain=(detectedAt:number)=>msUntilFiveClose(now,detectedAt);
  const ranked=[...anomalies].sort((a,b)=>Number(b.sourceCount>=2)-Number(a.sourceCount>=2)||remain(a.detectedAt)-remain(b.detectedAt)||b.score-a.score||a.detectedAt-b.detectedAt),
    merit=ranked.slice(0,Math.max(0,limit-4)),tail=ranked.slice(merit.length).sort((a,b)=>hash(a.symbol)-hash(b.symbol)),
    offset=tail.length?Math.floor(now/60000)*Math.min(4,limit)%tail.length:0;
  return[...merit,...tail.slice(offset),...tail.slice(0,offset)].slice(0,limit);
}