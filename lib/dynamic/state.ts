/**
 * dynamic-v1 BTC/ETH state monitor (pure): per closed daily bar — trend direction / strength, volatility (ATR14% and its
 * 1-year percentile), drawdown from the 90-day high, 20-day efficiency, alts vs BTC (median 20-day return of the universe minus
 * BTC's), cross-coin correlation (mean 30-day correlation of daily returns with BTC). Funding is live only (no history).
 * The bucket used for conditional statistics is coarse on purpose: trend (UP / DOWN / MIX) × volatility (LOW / MID / HIGH) — 9 cells,
 * so cells fill with trades; alts-vs-BTC is a second, separate split (ALT / BTC).
 */
import {Series,ema,sma,atr,efficiency,corr} from "./series.ts";
export type Trend="UP"|"DOWN"|"MIX";export type Vol="LOW"|"MID"|"HIGH";export type Lead="ALT"|"BTC";
export type DayState={t:number;btc:number;trend:Trend;strength:number;atrPct:number;volPct:number;vol:Vol;dd90:number;eff20:number;
  eth:{trend:Trend;strength:number}|null;altVsBtc:number|null;lead:Lead|null;corr30:number|null;bucket:string};
const ok=Number.isFinite;
function trendOf(s:Series,i:number,m100:Float64Array,e20:Float64Array,e50:Float64Array):{trend:Trend;strength:number}{
  const c=s.c[i]!,m=m100[i]!;if(!ok(m))return {trend:"MIX",strength:0};
  const up=c>m&&e20[i]!>e50[i]!,dn=c<m&&e20[i]!<e50[i]!;
  return {trend:up?"UP":dn?"DOWN":"MIX",strength:c/m-1};
}
/** state for every closed BTC daily bar (t = bar open, state known at its close) */
export function dailyStates(btc:Series,eth:Series|null,alts:readonly Series[]):DayState[]{
  const n=btc.n,out:DayState[]=[];if(n<120)return out;
  const m100=sma(btc.c,100,n),e20=ema(btc.c,20,n),e50=ema(btc.c,50,n),a14=atr(btc,14),ef=efficiency(btc.c,20,n);
  const em=eth&&eth.n>=120?{m:sma(eth.c,100,eth.n),f:ema(eth.c,20,eth.n),w:ema(eth.c,50,eth.n)}:null;
  const atrp=new Float64Array(n).fill(NaN);for(let i=0;i<n;i++)atrp[i]=a14[i]!/btc.c[i]!;
  // index maps per alt (time → index)
  const altIdx=alts.map(a=>{const m=new Map<number,number>();for(let i=0;i<a.n;i++)m.set(a.t[i]!,i);return m;});
  for(let i=119;i<n;i++){
    const t=btc.t[i]!,tr=trendOf(btc,i,m100,e20,e50),ap=atrp[i]!;
    let below=0,eq=0,cnt=0;for(let j=Math.max(0,i-364);j<=i;j++){const v=atrp[j]!;if(ok(v)){cnt++;if(Math.abs(v-ap)<=1e-6*ap)eq++;else if(v<ap)below++;}}
    const volPct=cnt?(below+eq/2)/cnt:.5,vol:Vol=volPct<1/3?"LOW":volPct>2/3?"HIGH":"MID";
    let hi=0;for(let j=Math.max(0,i-89);j<=i;j++)hi=Math.max(hi,btc.h[j]!);
    let eth_:DayState["eth"]=null;
    if(eth&&em){const k=eth.indexAtOrBefore(t);if(k>=0&&eth.t[k]===t)eth_=trendOf(eth,k,em.m,em.f,em.w);}
    // alts vs BTC (20d) and correlation (30d)
    const b20=i>=20?btc.c[i]!/btc.c[i-20]!-1:NaN,rets:number[]=[],cors:number[]=[];
    const br:number[]=[];for(let j=i-29;j<=i;j++)br.push(btc.c[j]!/btc.c[j-1]!-1);
    alts.forEach((a,ai)=>{const k=altIdx[ai]!.get(t);if(k==null||k<30)return;const k20=altIdx[ai]!.get(btc.t[i-20]!);
      if(k20!=null)rets.push(a.c[k]!/a.c[k20]!-1);
      if(a.t[k-29]===btc.t[i-29]){const ar:number[]=[];for(let j=k-29;j<=k;j++)ar.push(a.c[j]!/a.c[j-1]!-1);const r=corr(ar,br);if(ok(r))cors.push(r);}});
    rets.sort((x,y)=>x-y);
    const med=rets.length>=5?rets[rets.length>>1]!:null,alt=med!=null&&ok(b20)?med-b20:null;
    out.push({t,btc:btc.c[i]!,trend:tr.trend,strength:tr.strength,atrPct:ap,volPct,vol,dd90:btc.c[i]!/hi-1,eff20:ef[i]!,eth:eth_,
      altVsBtc:alt,lead:alt==null?null:alt>0?"ALT":"BTC",corr30:cors.length>=5?cors.reduce((x,y)=>x+y,0)/cors.length:null,bucket:`${tr.trend}/${vol}`});
  }
  return out;
}
/** the state known at time tSec (the last daily bar that closed at or before it) */
export function stateAt(states:readonly DayState[],tSec:number):DayState|null{
  let lo=0,hi=states.length-1,ans=-1;while(lo<=hi){const m=(lo+hi)>>1;if(states[m]!.t+86_400<=tSec){ans=m;lo=m+1;}else hi=m-1;}
  return ans<0?null:states[ans]!;
}
export const TREND_LABEL:Record<Trend,string>={UP:"上涨趋势",DOWN:"下跌趋势",MIX:"震荡/不明"};
export const VOL_LABEL:Record<Vol,string>={LOW:"低波动",MID:"中波动",HIGH:"高波动"};
export const bucketLabel=(b:string)=>{const [t,v]=b.split("/") as [Trend,Vol];return `${TREND_LABEL[t]??t}·${VOL_LABEL[v]??v}`;};
export type StateChange={t:number;from:string|null;to:string;why:string};
/** bucket changes along the timeline (for the log): only when the new bucket held 2 consecutive days (no one-day flicker) */
export function stateChanges(states:readonly DayState[]):StateChange[]{
  const out:StateChange[]=[];let cur:string|null=null;
  for(let i=1;i<states.length;i++){const a=states[i-1]!,b=states[i]!;
    if(b.bucket!==cur&&a.bucket===b.bucket){out.push({t:b.t,from:cur,to:b.bucket,why:`BTC ${b.btc} ${TREND_LABEL[b.trend]}（距 100 日均线 ${(b.strength*100).toFixed(1)}%），ATR ${(b.atrPct*100).toFixed(1)}%（1 年分位 ${Math.round(b.volPct*100)}%）`});cur=b.bucket;}}
  return out;
}
