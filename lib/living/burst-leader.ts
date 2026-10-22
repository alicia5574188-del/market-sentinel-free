/**
 * burst-leader-v1 (2026-10-22): trade only market-wide bursts, pick the 1–3 leaders, size big, stop wide, hold the move.
 *
 * Why (real records, price %, never ROE; research in /workspace/living_research/spec3):
 *  - export 10-21 03:55 → 10-22 13:12 BJ: 53 closed living trades, median stop 0.69%, median |exit move| 0.61%, 19% of exits
 *    inside ±0.12% (fees ≈ 0.14% round trip), net −115U of which fees 69.5U. DYN_LOCK winners kept ~48% of the in-hold best move
 *    while the coins went on to 2.4% (median) — exits were too small, not entries too few.
 *  - OKX 1m, 63 coins, 10-15 → 10-22 (6.5 days): a "sudden" burst = basket-median 3-minute move ≥ 4σ (σ of the previous 6h of
 *    3-minute basket moves), ≥ 80% of coins on that side, and no |z| ≥ 3 in the 45 minutes before (6 events). Relative strength since the
 *    burst origin, read 2 minutes after detection, was the best entry-time predictor of the 60-minute leader (rank IC 0.26, 7/8 bursts
 *    positive); OI, volume and liquidity were not (liquidity negative). Burst-hold exits on the top 3: 18 trades, mean +0.73%, median
 *    +0.94%, 83% ≥ cost, worst −2.24% (estimate, small sample; without the quiet rule 23 events, mean +0.16%).
 *
 * Pure helpers only; the engine owns state and logging. Nothing here sends a request.
 */
import type {MidBar} from "./tape.ts";
type Side="LONG"|"SHORT";
export const LEADER={
  pb:"burst-leader",
  win:3,zMin:4,breadth:.8,quietZ:3,quietMin:45,sigmaMin:360,sigmaSamples:120,minCoins:30,sameSideMs:3*3_600_000,
  enterAfterMin:2,rsMax:.025,liqQuantile:.3,top:3,maxOpen:3,
  stopBuf:.003,stopMin:.01,stopMax:.025,riskRate:.015,episodeCap:.05,
  // hold: breakeven + fees after +0.8%, trail from +1.5% keeping 70%, 4-hour cap; nothing smaller than costs
  beArm:.008,beLock:.0019,trailArm:.015,keep:.70,maxHoldMin:240,guardStep:.0005,
} as const;
export type BurstVerdict="WARMING"|"NONE"|"BREADTH"|"NOT_QUIET"|"COOLDOWN"|"BUSY"|"TRIGGER";
export type BurstCheck={bar:number;n:number;b3:number|null;breadth:number|null;sigma:number|null;z:number|null;side:Side|null;
  hotBar:number|null;verdict:BurstVerdict;why:string};
const p2=(x:number)=>`${x>=0?"+":""}${(x*100).toFixed(2)}%`;
function med(xs:number[]){const a=[...xs].sort((x,y)=>x-y),m=a.length>>1;return a.length?a.length%2?a[m]!:(a[m-1]!+a[m]!)/2:NaN;}
function sd(xs:number[]){const n=xs.length;if(n<2)return NaN;const m=xs.reduce((a,b)=>a+b,0)/n;return Math.sqrt(xs.reduce((a,b)=>a+(b-m)**2,0)/(n-1));}
/** close by bar time (seconds) for each symbol, from closed 1m mid bars */
export type Closes=Map<string,Map<number,number>>;
export function closesOf(rows:(s:string)=>MidBar[],syms:string[],sinceBar:number):Closes{
  const out:Closes=new Map();
  for(const s of syms){const m=new Map<number,number>();for(const r of rows(s))if(r.time>=sinceBar&&r.close>0)m.set(r.time,r.close);out.set(s,m);}
  return out;
}
/** basket-median 3-minute move and breadth at bar `t` (bar open time, seconds) */
export function basketAt(c:Closes,alts:string[],t:number){
  const rs:number[]=[];
  for(const s of alts){const m=c.get(s),a=m?.get(t),b=m?.get(t-LEADER.win*60);if(a&&b)rs.push(a/b-1);}
  if(rs.length<LEADER.minCoins)return{n:rs.length,b3:null,breadth:null};
  return{n:rs.length,b3:med(rs),breadth:rs.filter(x=>x>0).length/rs.length};
}
/**
 * One special-condition check on the last closed bar `bar`. `lastSide` = bar time of the last trigger per side (3-hour lockout).
 * TRIGGER only on a sudden synchronized burst: |z| ≥ 4, breadth ≥ 80% on that side, quiet (no |z| ≥ 3) for the 45 minutes before.
 */
export function burstCheck(c:Closes,alts:string[],bar:number,lastSide:{LONG:number;SHORT:number}):BurstCheck{
  const need=LEADER.sigmaMin+LEADER.quietMin+1,series:(number|null)[]=[];
  for(let k=need-1;k>=0;k--)series.push(basketAt(c,alts,bar-k*60).b3);
  const zAt=(i:number)=>{const v=series[i];if(v==null)return null;
    const w=series.slice(Math.max(0,i-LEADER.sigmaMin),i).filter((x):x is number=>x!=null);
    if(w.length<LEADER.sigmaSamples)return null;const s=sd(w);return s>0?v/s:null;};
  const last=series.length-1,now=basketAt(c,alts,bar),z=zAt(last);
  const sigma=(()=>{const w=series.slice(Math.max(0,last-LEADER.sigmaMin),last).filter((x):x is number=>x!=null);return w.length>=LEADER.sigmaSamples?sd(w):null;})();
  const base={bar,n:now.n,b3:now.b3,breadth:now.breadth,sigma,z,side:null as Side|null,hotBar:null as number|null};
  if(now.b3==null||z==null)return{...base,verdict:"WARMING",why:`数据不够：${now.n} 个币有 3 分钟涨跌，6 小时基准 ${sigma==null?"没攒够":"ok"}`};
  if(Math.abs(z)<LEADER.zMin)return{...base,verdict:"NONE",why:`普通行情：一篮子 3 分钟 ${p2(now.b3)}，${z.toFixed(1)}σ（要 ≥${LEADER.zMin}σ）`};
  const side:Side=z>0?"LONG":"SHORT",br=side==="LONG"?now.breadth!:1-now.breadth!;
  if(br<LEADER.breadth)return{...base,side,verdict:"BREADTH",why:`一篮子 ${z.toFixed(1)}σ，但只有 ${(br*100).toFixed(0)}% 的币同向（要 ≥${LEADER.breadth*100}%）`};
  for(let i=last-1;i>=last-LEADER.quietMin;i--){const zi=zAt(i);
    if(zi!=null&&Math.abs(zi)>=LEADER.quietZ)return{...base,side,hotBar:bar-(last-i)*60,verdict:"NOT_QUIET",
      why:`一篮子 ${z.toFixed(1)}σ，但 ${last-i} 分钟前已经有 ${zi.toFixed(1)}σ 的异动：不是从平静里突然爆发，不追`};}
  if(bar*1000-lastSide[side]*1000<LEADER.sameSideMs&&lastSide[side]>0)
    return{...base,side,verdict:"COOLDOWN",why:`同方向 3 小时内已经做过一段爆发（${new Date(lastSide[side]*1000).toISOString().slice(11,16)}Z），不追第二段`};
  return{...base,side,verdict:"TRIGGER",why:`全市场突然${side==="LONG"?"暴涨":"暴跌"}：一篮子 3 分钟 ${p2(now.b3)}，${z.toFixed(1)}σ，${(br*100).toFixed(0)}% 的币同向，之前 45 分钟平静`};
}
export type LeaderRow={sym:string;rs:number|null;vol6:number|null;liq:number;score:number|null;ok:boolean;why:string;rank:number|null};
/** volatility of 1m closes over the 6 hours before `bar` */
export function vol6Of(rows:MidBar[],bar:number){
  const xs:number[]=[];let prev:MidBar|null=null;
  for(const r of rows){if(r.time>bar)break;if(r.time<bar-LEADER.sigmaMin*60){prev=r;continue;}if(prev&&r.time-prev.time===60)xs.push(r.close/prev.close-1);prev=r;}
  return xs.length>=LEADER.sigmaSamples?sd(xs):null;
}
/**
 * Rank the basket 2 minutes after the trigger: relative strength since the burst origin (close 3 minutes before the trigger bar)
 * minus the basket median, plus the coin's own 6-hour volatility (rank sum). Eligible: moved with the burst (rs > 0) but not a lone
 * spike (rs ≤ 2.5%), 24h volume in the top 70% of the basket, and the hard filter (volume / spread / MMR) passes.
 */
export function rankLeaders(i:{side:Side;alts:string[];c:Closes;originBar:number;nowBar:number;vol6:(s:string)=>number|null;volume:(s:string)=>number;
  filter:(s:string)=>string|null;skip:(s:string)=>string|null;top:number}):{rows:LeaderRow[];picks:LeaderRow[];basket:number|null}{
  const s=i.side==="LONG"?1:-1,mv=new Map<string,number>();
  for(const x of i.alts){const m=i.c.get(x),a=m?.get(i.nowBar),b=m?.get(i.originBar);if(a&&b)mv.set(x,s*(a/b-1));}
  const basket=mv.size?med([...mv.values()]):null;
  const vols=i.alts.map(x=>i.volume(x)).filter(v=>v>0).sort((a,b)=>a-b);
  const liqFloor=vols.length?vols[Math.floor(LEADER.liqQuantile*(vols.length-1))]!:0;
  const rows:LeaderRow[]=i.alts.map(x=>{
    const m=mv.get(x),rs=m==null||basket==null?null:m-basket,vol=i.vol6(x),liq=i.volume(x);
    const why=rs==null?"没有这段的分钟价":rs<=0?`跑输一篮子（${p2(rs)}）`:rs>LEADER.rsMax?`单独暴冲 ${p2(rs)}>${p2(LEADER.rsMax)}，像单币消息，不追`
      :liq<liqFloor?`成交额 ${(liq/1e6).toFixed(0)}M 在一篮子后 30%`:vol==null?"6 小时波动算不出":i.filter(x)??i.skip(x)??"";
    return{sym:x,rs,vol6:vol,liq,score:null,ok:why==="",why,rank:null};
  });
  // ascending ranks, ties share their average rank
  const ok=rows.filter(r=>r.ok),rk=(k:"rs"|"vol6")=>{const a=[...ok].sort((x,y)=>(x[k] as number)-(y[k] as number)),m=new Map<string,number>();
    for(let j=0;j<a.length;){let e=j;while(e+1<a.length&&a[e+1]![k]===a[j]![k])e++;for(let q=j;q<=e;q++)m.set(a[q]!.sym,(j+e)/2+1);j=e+1;}return m;};
  const a=rk("rs"),b=rk("vol6");for(const r of ok)r.score=a.get(r.sym)!+b.get(r.sym)!;
  ok.sort((x,y)=>y.score!-x.score!||y.rs!-x.rs!);ok.forEach((r,j)=>{r.rank=j+1;});
  rows.sort((x,y)=>(x.rank??1e9)-(y.rank??1e9)||(y.rs??-1)-(x.rs??-1));
  return{rows,picks:ok.slice(0,Math.max(0,i.top)),basket};
}
/** structure stop: beyond the burst origin plus a buffer, clamped to 1%–2.5% */
export function leaderStop(side:Side,price:number,origin:number){
  const s=side==="LONG"?1:-1,rate=Math.min(LEADER.stopMax,Math.max(LEADER.stopMin,Math.abs(price/origin-1)+LEADER.stopBuf));
  return{rate,stop:price*(1-s*rate)};
}
export type LeaderVerdict={act:"HOLD"|"EXIT"|"GUARD";code:string;why:string;stop?:number};
/**
 * Burst hold. `peak` = best favorable price move so far (0.012 = +1.2%), `stop` = current effective stop. No fake / exhaust /
 * intent / dyn exits: only the stop, breakeven + fees after +0.8%, a trail from +1.5% keeping 70% of the best move, and 4 hours.
 */
export function leaderHold(i:{side:Side;entry:number;price:number;peak:number;ageMin:number;stop:number}):LeaderVerdict{
  const s=i.side==="LONG"?1:-1,cur=s*(i.price/i.entry-1),peak=Math.max(0,i.peak,cur);
  if(i.ageMin>=LEADER.maxHoldMin)return{act:"EXIT",code:"LIVING_BURST_MAXHOLD",why:`爆发单：拿满 ${LEADER.maxHoldMin/60} 小时，当前 ${p2(cur)}`};
  const lock=peak>=LEADER.trailArm?peak*LEADER.keep:peak>=LEADER.beArm?LEADER.beLock:null;
  if(lock==null)return{act:"HOLD",code:"",why:""};
  const trail=peak>=LEADER.trailArm;
  if(cur<=lock)return{act:"EXIT",code:trail?"LIVING_BURST_TRAIL":"LIVING_BURST_BREAKEVEN",
    why:trail?`爆发单：最好 ${p2(peak)}，回到 ${p2(cur)}（留 ${LEADER.keep*100}% = ${p2(lock)}），锁利离场`:`爆发单：浮盈到过 ${p2(peak)}，回到保本加手续费 ${p2(lock)}，离场`};
  const next=i.entry*(1+s*lock);
  if(s*(next-i.stop)>LEADER.guardStep*i.entry&&s*(i.price-next)>0)
    return{act:"GUARD",code:trail?"LIVING_BURST_TRAIL":"LIVING_BURST_BREAKEVEN",stop:next,
      why:trail?`爆发单：最好 ${p2(peak)}，止损跟到 ${p2(lock)}`:`爆发单：浮盈到过 ${p2(peak)}，止损拉到保本加手续费（${p2(lock)}）`};
  return{act:"HOLD",code:"",why:""};
}
// ------------------------------------------------------------------ dynamic-v1.3: burst-leader as a pool playbook
/** pool-scheme risk cap of a burst order (its own size logic, scaled by the predictor gate's confidence, never above this) */
export const BURST_POOL_MAX_RISK=.0075;
export const SHADOW_FEE=.0019;
/** a shadow burst trade: every pick of every ranking (sent or not) is followed with the same burst-hold rules on closed 1m bars */
export type BurstShadow={id:string;sym:string;side:Side;ep:number;stop:number;at:number;peak:number;lastBar:number;px?:number};
export type BurstShadowDone={pb:string;sym:string;side:Side;et:number;xt:number;net:number;ep:number;xp:number;exit:string};
/**
 * Advance one shadow over the closed 1m bars after its entry: stop touch (bar low / high) → out at the stop; else the best move so
 * far and the burst hold (breakeven, 70% trail, 4 hours) on the close; a GUARD tightens the stop. Returns the closed trade (net of
 * 0.19% fees) or null while it is still open. Mutates `sh` (peak, stop, lastBar). A shadow with no bars for 2 hours past its hold
 * limit is closed at its last processed price (data gap).
 */
export function shadowStep(sh:BurstShadow,bars:readonly MidBar[],now:number):BurstShadowDone|null{
  const s=sh.side==="LONG"?1:-1,first=Math.ceil(sh.at/60_000)*60;
  const done=(xp:number,xt:number,exit:string):BurstShadowDone=>({pb:LEADER.pb,sym:sh.sym,side:sh.side,et:Math.floor(sh.at/1000),xt,net:s*(xp/sh.ep-1)-SHADOW_FEE,ep:sh.ep,xp,exit});
  for(const b of bars){if(b.time<first||b.time<=sh.lastBar)continue;sh.lastBar=b.time;sh.px=b.close;
    if(s>0?b.low<=sh.stop:b.high>=sh.stop)return done(sh.stop,b.time+60,"止损");
    sh.peak=Math.max(sh.peak,s*((s>0?b.high:b.low)/sh.ep-1));
    const v=leaderHold({side:sh.side,entry:sh.ep,price:b.close,peak:sh.peak,ageMin:((b.time+60)*1000-sh.at)/60_000,stop:sh.stop});
    if(v.act==="EXIT")return done(b.close,b.time+60,v.code.replace("LIVING_BURST_","").toLowerCase());
    if(v.act==="GUARD"&&v.stop!=null)sh.stop=v.stop;}
  if(now-sh.at>(LEADER.maxHoldMin+120)*60_000)return done(sh.px??sh.ep,Math.floor(now/1000),"数据断了");
  return null;
}
