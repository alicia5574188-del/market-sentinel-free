import type {RangeEvent,RangeDiscovery} from './anomaly-range.ts';
import type {QuoteLike} from './market-intelligence-engine.ts';
export type RangeRank={symbol:string;rank:number;score:number;reason:string;selected:boolean};
export function rangePriority(e:RangeEvent,q:QuoteLike|undefined,now:number){
  const usable=!!q?.fresh&&q.observedAt<=now&&now-q.observedAt<=10000&&q.priceSource===e.source&&(q.sourceCount??0)>=2&&(q.disagreementRate??0)<=.008,
    proof=e.proof&&now-e.proof.at<=120000&&e.proof.at<=now&&Math.abs(e.price-e.proof.price)<=e.n5?e.proof:undefined,
    aligned=e.direction==='UP'?e.own>0:e.direction==='DOWN'?e.own<0:false;
  if(e.phase==='EXECUTING')return{score:10000,reason:'已提交，保留执行'};
  const band=Math.max(e.E,e.n5);
  if(e.price>e.L+band&&e.price<e.H-band)return{score:15,reason:'价格在区间中间，让出优先席位'};
  if(usable&&e.active&&proof)return{score:900+(proof.kind==='INTERNAL_TREND'&&aligned?30:proof.kind==='EDGE_BREAKOUT'?20:10),reason:proof.kind==='INTERNAL_TREND'?'内部同向证明完成':proof.kind==='EDGE_BREAKOUT'?'突破证明完成':'边缘回归证明完成'};
  const strength=Math.min(30,Math.max(0,e.score-60));
  if(!usable)return{score:strength,reason:'分析报价暂不可执行'};
  if(!e.active)return{score:40+strength,reason:'近期成交不足，轮换观察'};
  if(e.setup?.kind==='INTERNAL_TREND'&&aligned)return{score:500+strength,reason:'内部趋势同向，等待小线完成'};
  if(e.setup?.kind==='EDGE_BREAKOUT')return{score:450+strength,reason:'完整5分钟已越过边缘'};
  if(e.setup?.kind==='EDGE_RETURN')return{score:400+strength,reason:'边缘拒绝，等待向内确认'};
  if(aligned&&e.price>e.L+e.E&&e.price<e.H-e.E)return{score:250+strength,reason:'内部趋势与异动同向'};
  return{score:100+strength,reason:'尚无位置证明，轮换观察'};
}
const hash=(symbol:string)=>[...symbol].reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,0);
/** Eight merit seats plus two rotating checks; fresh actionable proofs win all seats. */
export function selectRangePlans(events:RangeEvent[],quotes:Record<string,QuoteLike>,now:number,limit=10){
  const ranked=events.map(e=>({e,...rangePriority(e,quotes[e.symbol],now)}))
    .sort((a,b)=>b.score-a.score||b.e.detectedAt-a.e.detectedAt||a.e.symbol.localeCompare(b.e.symbol));
  const protectedRows=ranked.filter(r=>r.score>=900),ordinary=ranked.filter(r=>r.score<900),
    remaining=Math.max(0,limit-protectedRows.length),merit=ordinary.slice(0,Math.max(0,remaining-2)),
    tail=ordinary.slice(merit.length).sort((a,b)=>hash(a.e.symbol)-hash(b.e.symbol)),
    offset=tail.length?Math.floor(now/60000)*Math.min(2,remaining)%tail.length:0,
    rotating=[...tail.slice(offset),...tail.slice(0,offset)].slice(0,remaining-merit.length),
    selected=new Set([...protectedRows.slice(0,limit),...merit,...rotating].map(r=>r.e.symbol));
  const ranking:RangeRank[]=ranked.map((r,i)=>({symbol:r.e.symbol,rank:i+1,score:r.score,reason:r.reason,selected:selected.has(r.e.symbol)}));
  return{selected,ranking};
}
/** Fair access to the deep candle pool, independent of first detection order. */
export function rankRangeDiscovery(anomalies:RangeDiscovery['anomalies'],now:number,limit=30){
  const ranked=[...anomalies].sort((a,b)=>Number(b.sourceCount>=2)-Number(a.sourceCount>=2)||b.score-a.score||b.detectedAt-a.detectedAt),
    merit=ranked.slice(0,Math.max(0,limit-4)),tail=ranked.slice(merit.length).sort((a,b)=>hash(a.symbol)-hash(b.symbol)),
    offset=tail.length?Math.floor(now/60000)*Math.min(4,limit)%tail.length:0;
  return[...merit,...tail.slice(offset),...tail.slice(0,offset)].slice(0,limit);
}
