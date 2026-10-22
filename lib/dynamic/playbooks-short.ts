/**
 * dynamic-v1 short-term pool: small pure rules on closed 5m / 15m / 1h bars, holds from minutes to ≤ 24 h. Every stop is at
 * least max(0.8%, 1 × ATR15m-equivalent) from the entry (so the 0.19% round-trip fee is small against it); targets are R
 * multiples of that stop or a structural level ≥ 0.5% away; every rule has a time limit. Sessions are UTC (US open follows US
 * daylight saving). Cross-asset rules read BTC bars of the same interval (ctx.btc). No request, no state.
 */
import {Series,ema,sma,atr,priorMax,priorMin,rollMin,rollMax,stdev,rsi,sessionVwap,returns,efficiency,IV_SEC,Memo,type Iv} from "./series.ts";
import type {Playbook,Entry,Ctx,Side} from "./playbooks.ts";
type X=Record<string,Float64Array>;
const ok=Number.isFinite;
export const MIN_STOP=.008;
/** ATR14 of this interval → ATR of 15m bars (√time) */
const TO_15M:Partial<Record<Iv,number>>={"5m":Math.sqrt(3),"15m":1,"1h":.5};
const memo=(ctx:Ctx)=>ctx.memo??new Memo();
const key=(s:Series,k:string)=>`${s.sym}|${s.iv}|${s.n}|${s.last}|${k}`;
function base(s:Series,ctx:Ctx):X{const m=memo(ctx);return {a:m.get(key(s,"atr14"),()=>atr(s,14))};}
/** the entry: stop widened to the minimum distance, target as R multiple (or a structural target ≥ 0.5% away) */
function entry(side:Side,s:Series,i:number,x:X,stop:number,o:{R?:number;target?:number|null;maxBars:number;why:string}):Entry|null{
  const c=s.c[i]!,d=side==="LONG"?1:-1,a=x.a![i]!*(TO_15M[s.iv]??1);if(!ok(stop)||!ok(c))return null;
  const minDist=Math.max(MIN_STOP*c,ok(a)?a:0);let dist=d*(c-stop);if(!(dist>0))dist=minDist;dist=Math.max(dist,minDist);
  const st=c-d*dist;let tg:number|null=null;
  if(o.target!=null){if(!ok(o.target)||d*(o.target-c)<.005*c)return null;tg=o.target;}else if(o.R)tg=c+d*o.R*dist;
  return {stop:st,target:tg,maxBars:o.maxBars,why:o.why};
}
const pct=(x:number)=>`${(x*100).toFixed(2)}%`;
const L_=(side:Side)=>side==="LONG";
const sideTag=(side:Side)=>side==="LONG"?"long":"short",sideCn=(side:Side)=>side==="LONG"?"做多":"做空";
function pb(o:Omit<Playbook,"tier"|"minStop">&{tier?:never}):Playbook{return {...o,tier:"short",minStop:MIN_STOP};}
/** bars of interval `iv` per hour */
const perH=(iv:Iv)=>3600/IV_SEC[iv];
// -------------------------------------------------------------- time helpers (UTC)
const DAY=86_400;
/** US cash open in UTC minutes of the day: 13:30 during US daylight time, else 14:30 */
export function usOpenMin(daySec:number){const d=new Date(daySec*1000),y=d.getUTCFullYear();
  const nth=(m:number,n:number)=>{const f=new Date(Date.UTC(y,m,1)).getUTCDay();return Date.UTC(y,m,1+((7-f)%7)+7*(n-1))/1000;};
  const start=nth(2,2)+7*3600,end=nth(10,1)+6*3600;return daySec>=start&&daySec<end?13*60+30:14*60+30;}
const SESSIONS={asia:{label:"亚洲",start:(_d:number)=>0},eu:{label:"欧洲",start:(_d:number)=>7*60},us:{label:"美国",start:(d:number)=>usOpenMin(d)}} as const;
export type SessionId=keyof typeof SESSIONS;
/** index of the bar with open time t (searching back at most `back` bars), or -1 */
function idxAt(s:Series,i:number,t:number,back:number){for(let j=i;j>=Math.max(0,i-back);j--){if(s.t[j]===t)return j;if(s.t[j]!<t)return -1;}return -1;}
// -------------------------------------------------------------- 1 box breakout follow (5m / 15m)
function box(iv:"5m"|"15m",side:Side):Playbook{const L=L_(side),maxW=iv==="5m"?.025:.045,mb=iv==="5m"?36:32;
  return pb({id:`box${iv}-${sideTag(side)}`,label:`${iv}箱体${L?"上破":"下破"}跟随${sideCn(side)}`,iv,side,warm:60,family:"box-break",familyLabel:"箱体突破跟随",
  rule:`前 48 根 ${iv} K 线高低差 0.6%–${maxW*100}%（箱体），第一次收盘${L?"突破箱顶":"跌破箱底"} → ${sideCn(side)}；止损箱体中线（至少 0.8%/1 倍 15 分钟波动），目标 2R，最多 ${mb*IV_SEC[iv]/3600} 小时`,
  prep:(s,c)=>({...base(s,c),hi:memo(c).get(key(s,"pmax48h"),()=>priorMax(s.h,48,s.n)),lo:memo(c).get(key(s,"pmin48l"),()=>priorMin(s.l,48,s.n))}),
  enter:(x,s,i)=>{const h=x.hi![i]!,l=x.lo![i]!,c=s.c[i]!,w=(h-l)/c;if(!ok(h)||!ok(l)||w>maxW||w<.006)return null;
    const first=L?c>h&&s.c[i-1]!<=x.hi![i-1]!:c<l&&s.c[i-1]!>=x.lo![i-1]!;if(!first)return null;
    return entry(side,s,i,x,(h+l)/2,{R:2,maxBars:mb,why:`箱体 ${pct(w)} ${L?"上破":"下破"}`});}});}
// -------------------------------------------------------------- 2 box false-break fade (15m)
function boxFade(side:Side):Playbook{const L=L_(side);
  return pb({id:`boxfade15m-${sideTag(side)}`,label:`15m箱体假${L?"跌破":"突破"}反打${sideCn(side)}`,iv:"15m",side,warm:60,family:"box-fade",familyLabel:"箱体假突破反打",
  rule:`15 分钟箱体（前 48 根，≤4.5%），K 线影线${L?"刺破箱底":"刺破箱顶"}但收回箱内 → ${sideCn(side)}；止损影线外 0.25ATR，目标箱体中线，最多 4 小时`,
  prep:(s,c)=>({...base(s,c),hi:memo(c).get(key(s,"pmax48h"),()=>priorMax(s.h,48,s.n)),lo:memo(c).get(key(s,"pmin48l"),()=>priorMin(s.l,48,s.n))}),
  enter:(x,s,i)=>{const h=x.hi![i]!,l=x.lo![i]!,c=s.c[i]!,a=x.a![i]!,mid=(h+l)/2;if(!ok(h)||!ok(l)||(h-l)/c>.045||(h-l)/c<.008)return null;
    if(L&&s.l[i]!<l&&c>l&&c<mid)return entry(side,s,i,x,s.l[i]!-.25*a,{target:mid,maxBars:16,why:"假跌破收回箱内"});
    if(!L&&s.h[i]!>h&&c<h&&c>mid)return entry(side,s,i,x,s.h[i]!+.25*a,{target:mid,maxBars:16,why:"假突破收回箱内"});return null;}});}
// -------------------------------------------------------------- 3 opening-range breakout (5m), per session
function orb(sess:SessionId,side:Side):Playbook{const L=L_(side),S=SESSIONS[sess];
  return pb({id:`orb5m-${sess}-${sideTag(side)}`,label:`${S.label}开盘区间${L?"上破":"下破"}${sideCn(side)}`,iv:"5m",side,warm:30,family:`orb-${sess}`,familyLabel:"开盘区间突破",
  rule:`${S.label}时段开盘前 30 分钟的高低点为区间；开盘后 3 小时内第一次收盘${L?"高于区间顶":"低于区间底"} → ${sideCn(side)}；止损区间中线（至少 0.8%），目标 2R，开盘 6 小时后离场`,
  prep:(s,c)=>base(s,c),
  enter:(x,s,i)=>{const t=s.t[i]!,day=Math.floor(t/DAY)*DAY,st=day+S.start(day)*60,end=t+300;
    if(end<st+1800+300||end>st+3*3600)return null;
    const j0=idxAt(s,i,st,60);if(j0<0)return null;let hi=-Infinity,lo=Infinity;
    for(let j=j0;j<j0+6;j++){if(s.t[j]!==st+(j-j0)*300)return null;hi=Math.max(hi,s.h[j]!);lo=Math.min(lo,s.l[j]!);}
    const c=s.c[i]!;if(L?!(c>hi):!(c<lo))return null;
    for(let j=j0+6;j<i;j++)if(L?s.c[j]!>hi:s.c[j]!<lo)return null;// only the first break
    const left=Math.max(1,Math.round((st+6*3600-end)/300));
    return entry(side,s,i,x,(hi+lo)/2,{R:2,maxBars:left,why:`${S.label}开盘区间 ${pct((hi-lo)/c)} ${L?"上破":"下破"}`});}});}
// -------------------------------------------------------------- 4 NY first-90-minute momentum (BTC/ETH, 5m)
function ny90(side:Side):Playbook{const L=L_(side);
  return pb({id:`ny90-${sideTag(side)}`,label:`美股开盘90分钟动量${sideCn(side)}`,iv:"5m",side,warm:30,only:"majors",family:"ny90",familyLabel:"美股开盘动量",
  rule:`BTC/ETH：美股开盘后 90 分钟${L?"涨":"跌"}超 0.6% → 顺势${sideCn(side)}，拿到美股收盘（开盘后 6.5 小时）；止损 1 倍 15 分钟波动（至少 0.8%）`,
  prep:(s,c)=>base(s,c),
  enter:(x,s,i)=>{const t=s.t[i]!,day=Math.floor(t/DAY)*DAY,op=day+usOpenMin(day)*60;if(t+300!==op+5400)return null;
    const j=idxAt(s,i,op,30);if(j<0)return null;const r=s.c[i]!/s.o[j]!-1;if(L?r<.006:r>-.006)return null;
    const c=s.c[i]!;return entry(side,s,i,x,c,{maxBars:Math.round((390-90)*60/300),why:`开盘 90 分钟 ${pct(r)}`});}});}
// -------------------------------------------------------------- 5 session-range sweep & reclaim (15m, 8h blocks)
function sweep(side:Side):Playbook{const L=L_(side);
  return pb({id:`sweep15m-${sideTag(side)}`,label:`上一时段${L?"低点":"高点"}扫单收回${sideCn(side)}`,iv:"15m",side,warm:40,family:"sweep",familyLabel:"时段高低点扫单收回",
  rule:`上一个 8 小时时段的${L?"最低点":"最高点"}被刺破、K 线又收回 → ${sideCn(side)}；止损影线外 0.25ATR，目标上一时段中线，最多 4 小时`,
  prep:(s,c)=>base(s,c),
  enter:(x,s,i)=>{const t=s.t[i]!,blk=Math.floor(t/28800)*28800,prev=blk-28800;let hi=-Infinity,lo=Infinity,n=0;
    for(let j=i-1;j>=Math.max(0,i-70);j--){const tj=s.t[j]!;if(tj<prev)break;if(tj<blk){hi=Math.max(hi,s.h[j]!);lo=Math.min(lo,s.l[j]!);n++;}}
    if(n<28)return null;const c=s.c[i]!,a=x.a![i]!,mid=(hi+lo)/2;
    if(L&&s.l[i]!<lo&&c>lo)return entry(side,s,i,x,s.l[i]!-.25*a,{target:mid,maxBars:16,why:"扫上一时段低点后收回"});
    if(!L&&s.h[i]!>hi&&c<hi)return entry(side,s,i,x,s.h[i]!+.25*a,{target:mid,maxBars:16,why:"扫上一时段高点后收回"});return null;}});}
// -------------------------------------------------------------- 6 session VWAP reclaim / reject (15m)
function vwap(side:Side):Playbook{const L=L_(side);
  return pb({id:`vwap15m-${sideTag(side)}`,label:`日内均价线${L?"收复":"跌回"}${sideCn(side)}`,iv:"15m",side,warm:30,family:"vwap",familyLabel:"日内均价线（VWAP）",
  rule:`当天成交均价线（VWAP）：连续 8 根在${L?"下方":"上方"}后收盘${L?"站上":"跌破"} → ${sideCn(side)}；止损 1.2ATR（至少 0.8%），目标 2R，最多 6 小时`,
  prep:(s,c)=>({...base(s,c),vw:memo(c).get(key(s,"vwap"),()=>sessionVwap(s))}),
  enter:(x,s,i)=>{const t=s.t[i]!;if((t%DAY)/900<12)return null;const v=x.vw!,c=s.c[i]!;
    if(L?!(c>v[i]!):!(c<v[i]!))return null;for(let j=i-8;j<i;j++)if(L?!(s.c[j]!<v[j]!):!(s.c[j]!>v[j]!))return null;
    return entry(side,s,i,x,c-(L?1:-1)*1.2*x.a![i]!,{R:2,maxBars:24,why:`${L?"站上":"跌破"}日内均价 ${v[i]!.toPrecision(6)}`});}});}
// -------------------------------------------------------------- 7 EMA9/21 pullback in trend (15m)
function emaPull(side:Side):Playbook{const L=L_(side);
  return pb({id:`emapull15m-${sideTag(side)}`,label:`15m均线回踩${sideCn(side)}`,iv:"15m",side,warm:70,family:"ema-pull",familyLabel:"顺势均线回踩",
  rule:`15 分钟 EMA21 ${L?"在":"在"} EMA55 ${L?"上方且向上":"下方且向下"}，K 线${L?"回踩":"反抽"} EMA21 后收${L?"上":"下"} EMA9 → ${sideCn(side)}；止损 K 线${L?"低点下":"高点上"} 0.5ATR（至少 0.8%），目标 2R，最多 8 小时`,
  prep:(s,c)=>{const m=memo(c);return {...base(s,c),e9:m.get(key(s,"e9"),()=>ema(s.c,9,s.n)),e21:m.get(key(s,"e21"),()=>ema(s.c,21,s.n)),e55:m.get(key(s,"e55"),()=>ema(s.c,55,s.n))};},
  enter:(x,s,i)=>{const e9=x.e9![i]!,e21=x.e21![i]!,e55=x.e55![i]!,e55p=x.e55![i-8]!,c=s.c[i]!,a=x.a![i]!;if(!ok(e55p))return null;
    if(L&&e21>e55&&e55>e55p&&s.l[i]!<=e21&&c>e9&&c>s.o[i]!)return entry(side,s,i,x,s.l[i]!-.5*a,{R:2,maxBars:32,why:"上升趋势回踩 EMA21"});
    if(!L&&e21<e55&&e55<e55p&&s.h[i]!>=e21&&c<e9&&c<s.o[i]!)return entry(side,s,i,x,s.h[i]!+.5*a,{R:2,maxBars:32,why:"下降趋势反抽 EMA21"});return null;}});}
// -------------------------------------------------------------- 8 Bollinger squeeze breakout / 9 Bollinger reversion in range (15m)
function bb(s:Series,c:Ctx){const m=memo(c),mid=m.get(key(s,"sma20"),()=>sma(s.c,20,s.n)),sd=m.get(key(s,"sd20"),()=>stdev(s.c,20,s.n));
  const bw=m.get(key(s,"bw"),()=>{const o=new Float64Array(s.n).fill(NaN);for(let i=0;i<s.n;i++)o[i]=4*sd[i]!/mid[i]!;return o;});
  return {mid,sd,bw,bwMin:m.get(key(s,"bwmin"),()=>rollMin(bw,120,s.n))};}
function squeeze(side:Side):Playbook{const L=L_(side);
  return pb({id:`squeeze15m-${sideTag(side)}`,label:`布林收口后${L?"向上":"向下"}突破${sideCn(side)}`,iv:"15m",side,warm:150,family:"bb-squeeze",familyLabel:"布林带收口突破",
  rule:`15 分钟布林带宽度到近 120 根最窄附近（收口），收盘${L?"突破上轨":"跌破下轨"} → ${sideCn(side)}；止损中轨（至少 0.8%），目标 2.5R，最多 8 小时`,
  prep:(s,c)=>({...base(s,c),...bb(s,c)}),
  enter:(x,s,i)=>{const mid=x.mid![i]!,sd=x.sd![i]!,c=s.c[i]!;let tight=false;for(let j=i-5;j<i;j++)if(x.bw![j]!<=1.1*x.bwMin![i-1]!)tight=true;
    if(!tight||!ok(mid))return null;if(L?!(c>mid+2*sd):!(c<mid-2*sd))return null;
    return entry(side,s,i,x,mid,{R:2.5,maxBars:32,why:`收口（带宽 ${pct(x.bw![i]!)}）后${L?"上破":"下破"}`});}});}
function bbRevert(side:Side):Playbook{const L=L_(side);
  return pb({id:`bbrev15m-${sideTag(side)}`,label:`震荡中布林${L?"下轨":"上轨"}回归${sideCn(side)}`,iv:"15m",side,warm:40,family:"bb-revert",familyLabel:"布林带区间回归",
  rule:`走势效率低（震荡，20 根效率 <0.3），收盘跌出${L?"下轨":"上轨"}后又收回 → ${sideCn(side)}，目标中轨；止损极值外 0.5ATR，最多 4 小时`,
  prep:(s,c)=>({...base(s,c),...bb(s,c),ef:memo(c).get(key(s,"eff20"),()=>efficiency(s.c,20,s.n))}),
  enter:(x,s,i)=>{const mid=x.mid![i]!,sd=x.sd![i]!,mp=x.mid![i-1]!,sp=x.sd![i-1]!,c=s.c[i]!,a=x.a![i]!;if(!(x.ef![i]!<.3))return null;
    if(L&&s.c[i-1]!<mp-2*sp&&c>mid-2*sd)return entry(side,s,i,x,Math.min(s.l[i]!,s.l[i-1]!)-.5*a,{target:mid,maxBars:16,why:"跌出下轨后收回"});
    if(!L&&s.c[i-1]!>mp+2*sp&&c<mid+2*sd)return entry(side,s,i,x,Math.max(s.h[i]!,s.h[i-1]!)+.5*a,{target:mid,maxBars:16,why:"冲出上轨后收回"});return null;}});}
// -------------------------------------------------------------- 10 RSI divergence reversal (15m)
function rsiDiv(side:Side):Playbook{const L=L_(side);
  return pb({id:`rsidiv15m-${sideTag(side)}`,label:`RSI${L?"底":"顶"}背离反转${sideCn(side)}`,iv:"15m",side,warm:40,family:"rsi-div",familyLabel:"RSI 背离反转",
  rule:`价格创近 20 根新${L?"低":"高"}，但 RSI 比上一个${L?"低":"高"}点${L?"高":"低"} 5 以上（背离，前一个 RSI ${L?"<30":">70"}），K 线收${L?"阳":"阴"} → ${sideCn(side)}；止损极值外 0.5ATR，目标 2R，最多 6 小时`,
  prep:(s,c)=>({...base(s,c),r:memo(c).get(key(s,"rsi14"),()=>rsi(s.c,14,s.n))}),
  enter:(x,s,i)=>{const r=x.r!,a=x.a![i]!;let j=-1;
    for(let k=i-20;k<=i-5;k++){if(k<1)continue;if(j<0||(L?s.l[k]!<s.l[j]!:s.h[k]!>s.h[j]!))j=k;}if(j<0)return null;
    if(L&&s.l[i]!<=s.l[j]!*1.002&&r[j]!<30&&r[i]!>r[j]!+5&&s.c[i]!>s.o[i]!)return entry(side,s,i,x,s.l[i]!-.5*a,{R:2,maxBars:24,why:`底背离 RSI ${r[j]!.toFixed(0)}→${r[i]!.toFixed(0)}`});
    if(!L&&s.h[i]!>=s.h[j]!*.998&&r[j]!>70&&r[i]!<r[j]!-5&&s.c[i]!<s.o[i]!)return entry(side,s,i,x,s.h[i]!+.5*a,{R:2,maxBars:24,why:`顶背离 RSI ${r[j]!.toFixed(0)}→${r[i]!.toFixed(0)}`});return null;}});}
// -------------------------------------------------------------- 11 burst follow / fade (5m)
const volMean=(s:Series,c:Ctx)=>memo(c).get(key(s,"vsma20"),()=>sma(s.v,20,s.n));
function burstDir(x:X,s:Series,i:number,k=3,vk=4){const a=x.a![i-1]!,vm=x.vm![i-1]!,b=s.c[i]!-s.o[i]!;return ok(a)&&ok(vm)&&a>0&&vm>0&&Math.abs(b)>=k*a&&s.v[i]!>=vk*vm?(b>0?1:-1):0;}
function burst5(kind:"follow"|"fade",side:Side):Playbook{const L=L_(side),f=kind==="follow";
  return pb({id:`${f?"burst":"fade"}5m-${sideTag(side)}`,label:`5m爆发${f?"跟随":"反打"}${sideCn(side)}`,iv:"5m",side,warm:25,family:f?"burst5-follow":"burst5-fade",familyLabel:f?"爆发跟随":"爆发反打",
  rule:f?`5 分钟 K 线实体 ≥3 倍波动、成交量 ≥4 倍均量，${L?"向上":"向下"} → 跟随；止损该 K 线${L?"低点":"高点"}（至少 0.8%），目标 2R，最多 1 小时`
    :`5 分钟 K 线实体 ≥3 倍波动、成交量 ≥4 倍均量，${L?"向下":"向上"} → 反向${sideCn(side)}，目标回到开盘价；止损极值外 0.5ATR，最多 1 小时`,
  prep:(s,c)=>({...base(s,c),vm:volMean(s,c)}),
  enter:(x,s,i)=>{const b=burstDir(x,s,i),a=x.a![i]!;
    if(f)return b===(L?1:-1)?entry(side,s,i,x,L?s.l[i]!:s.h[i]!,{R:2,maxBars:12,why:"爆发 K 线跟随"}):null;
    return b===(L?-1:1)?entry(side,s,i,x,L?s.l[i]!-.5*a:s.h[i]!+.5*a,{target:s.o[i]!,maxBars:12,why:"爆发 K 线反打"}):null;}});}
// -------------------------------------------------------------- 12 liquidation-cascade fade (5m)
function cascade(side:Side):Playbook{const L=L_(side);
  return pb({id:`cascade5m-${sideTag(side)}`,label:`连环${L?"爆多":"爆空"}力竭反打${sideCn(side)}`,iv:"5m",side,warm:25,family:"cascade",familyLabel:"爆仓潮力竭反打",
  rule:`1 小时内${L?"跌":"涨"}超 2.5%，出现 ≥4 倍成交量、长${L?"下":"上"}影线（≥ 半根）且收在 K 线${L?"上":"下"}半部的 5 分钟 K 线 → 反向${sideCn(side)}；止损影线外 0.25ATR，目标 2R，最多 2 小时`,
  prep:(s,c)=>({...base(s,c),vm:volMean(s,c)}),
  enter:(x,s,i)=>{if(i<12)return null;const r=s.c[i]!/s.c[i-12]!-1,vm=x.vm![i-1]!,o=s.o[i]!,c=s.c[i]!,h=s.h[i]!,l=s.l[i]!,rg=h-l,a=x.a![i]!;
    if(!(rg>0)||!(s.v[i]!>=4*vm))return null;
    if(L&&r<=-.025&&Math.min(o,c)-l>=.5*rg&&c>=l+.5*rg)return entry(side,s,i,x,l-.25*a,{R:2,maxBars:24,why:`1 小时 ${pct(r)} 后放量长下影`});
    if(!L&&r>=.025&&h-Math.max(o,c)>=.5*rg&&c<=l+.5*rg)return entry(side,s,i,x,h+.25*a,{R:2,maxBars:24,why:`1 小时 ${pct(r)} 后放量长上影`});return null;}});}
// -------------------------------------------------------------- cross-asset helpers (BTC aligned by time)
function btcAligned(s:Series,c:Ctx){const b=c.btc;return memo(c).get(key(s,`btc|${b?.n??0}|${b?.last??0}`),()=>{const o=new Float64Array(s.n).fill(NaN);if(!b)return o;
  let j=0;for(let i=0;i<s.n;i++){while(j<b.n&&b.t[j]!<s.t[i]!)j++;if(j<b.n&&b.t[j]===s.t[i])o[i]=b.c[j]!;}return o;});}
// -------------------------------------------------------------- 13 single-coin pump / dump fade (1h, alts)
function pumpFade(side:Side):Playbook{const L=L_(side);
  return pb({id:`pump1h-${sideTag(side)}`,label:`单币${L?"暴跌反弹":"暴涨回落"}${sideCn(side)}`,iv:"1h",side,warm:10,only:"alts",family:"pump-fade",familyLabel:"单币异动回落",
  rule:`山寨 3 小时${L?"跌":"涨"}超 8% 而 BTC 同期不到 1%，之后第一根收${L?"阳":"阴"}的 1 小时 K 线 → ${sideCn(side)}；止损 3 小时极值外 0.25ATR，目标回吐一半，最多 12 小时`,
  prep:(s,c)=>({...base(s,c),b:btcAligned(s,c)}),
  enter:(x,s,i)=>{if(i<5)return null;const r=s.c[i-1]!/s.c[i-4]!-1,b=x.b!,br=b[i-1]!/b[i-4]!-1,a=x.a![i]!,c=s.c[i]!;if(!ok(br)||Math.abs(br)>=.01)return null;
    let hi=-Infinity,lo=Infinity;for(let j=i-4;j<=i;j++){hi=Math.max(hi,s.h[j]!);lo=Math.min(lo,s.l[j]!);}
    if(!L&&r>=.08&&c<s.o[i]!)return entry(side,s,i,x,hi+.25*a,{target:c-(hi-s.c[i-4]!)*.5,maxBars:12,why:`3 小时 ${pct(r)}（BTC ${pct(br)}）后转阴`});
    if(L&&r<=-.08&&c>s.o[i]!)return entry(side,s,i,x,lo-.25*a,{target:c+(s.c[i-4]!-lo)*.5,maxBars:12,why:`3 小时 ${pct(r)}（BTC ${pct(br)}）后转阳`});return null;}});}
// -------------------------------------------------------------- 14 alt laggard catch-up after a BTC move (15m, alts)
function laggard(side:Side):Playbook{const L=L_(side);
  return pb({id:`laggard15m-${sideTag(side)}`,label:`BTC${L?"拉升":"下跌"}后山寨补${L?"涨":"跌"}${sideCn(side)}`,iv:"15m",side,warm:20,only:"alts",family:"laggard",familyLabel:"山寨补涨/补跌",
  rule:`BTC 1 小时${L?"涨":"跌"}超 1%，这个山寨同期只动了不到 BTC 的 30% → ${sideCn(side)}等它补；止损 1.5ATR（至少 0.8%），目标 2R，最多 4 小时`,
  prep:(s,c)=>({...base(s,c),b:btcAligned(s,c)}),
  enter:(x,s,i)=>{const b=x.b!,br=b[i]!/b[i-4]!-1,ar=s.c[i]!/s.c[i-4]!-1;if(!ok(br))return null;
    if(L?!(br>=.01&&ar<.3*br):!(br<=-.01&&ar>.3*br))return null;const pr=b[i-1]!/b[i-5]!-1;if(L?pr>=.01:pr<=-.01)return null;// first bar of the move only
    return entry(side,s,i,x,s.c[i]!-(L?1:-1)*1.5*x.a![i]!,{R:2,maxBars:16,why:`BTC ${pct(br)}，它 ${pct(ar)}`});}});}
// -------------------------------------------------------------- 15 alt independent breakout vs BTC (residual, 1h, alts)
function residual(side:Side):Playbook{const L=L_(side);
  return pb({id:`resid1h-${sideTag(side)}`,label:`山寨独立${L?"走强":"走弱"}${sideCn(side)}`,iv:"1h",side,warm:80,only:"alts",family:"residual",familyLabel:"独立于 BTC 的突破",
  rule:`扣掉 BTC 涨跌后的“自身走势”创 48 小时新${L?"高":"低"}，而 BTC 24 小时波动 <2%（独立行情） → ${sideCn(side)}；止损 1.5ATR，目标 2R，最多 24 小时`,
  prep:(s,c)=>{const b=btcAligned(s,c),ra=returns(s.c,s.n),rb=returns(b,s.n),res=new Float64Array(s.n).fill(NaN);let acc=0;
    for(let i=1;i<s.n;i++){const d=ra[i]!-rb[i]!;if(ok(d))acc+=d;res[i]=acc;}
    return {...base(s,c),b,res,mx:priorMax(res,48,s.n),mn:priorMin(res,48,s.n)};},
  enter:(x,s,i)=>{const b=x.b!,br=b[i]!/b[i-24]!-1,r=x.res![i]!;if(!ok(br)||Math.abs(br)>=.02)return null;
    const first=L?r>x.mx![i]!&&!(x.res![i-1]!>x.mx![i-1]!):r<x.mn![i]!&&!(x.res![i-1]!<x.mn![i-1]!);if(!first)return null;
    return entry(side,s,i,x,s.c[i]!-(L?1:-1)*1.5*x.a![i]!,{R:2,maxBars:24,why:`自身走势 48 小时新${L?"高":"低"}（BTC 24h ${pct(br)}）`});}});}
// -------------------------------------------------------------- 16 BTC-lead alt follow (5m, alts)
function btcLead(side:Side):Playbook{const L=L_(side);
  return pb({id:`btclead5m-${sideTag(side)}`,label:`BTC领${L?"涨":"跌"}山寨跟${sideCn(side)}`,iv:"5m",side,warm:20,only:"alts",family:"btc-lead",familyLabel:"BTC 领跑山寨跟随",
  rule:`BTC 一根 5 分钟 K 线${L?"涨":"跌"}超 0.4% 且是 2 倍波动以上，这个山寨同一根只动了不到一半 → 跟${sideCn(side)}；止损 0.8%，目标 1.5R，最多 30 分钟`,
  prep:(s,c)=>{const b=btcAligned(s,c),rb=returns(b,s.n),sdb=stdev(rb,48,s.n);return {...base(s,c),rb,sdb,ra:returns(s.c,s.n)};},
  enter:(x,s,i)=>{const rb=x.rb![i]!,sd=x.sdb![i-1]!,ra=x.ra![i]!;if(!ok(rb)||!ok(sd)||!(sd>0))return null;
    if(L?!(rb>=.004&&rb>=2*sd&&ra<.5*rb):!(rb<=-.004&&-rb>=2*sd&&ra>.5*rb))return null;
    return entry(side,s,i,x,s.c[i]!,{R:1.5,maxBars:6,why:`BTC 5 分钟 ${pct(rb)}，它 ${pct(ra)}`});}});}
// -------------------------------------------------------------- 17 N-sigma 15m move reversion
function nsigma(side:Side):Playbook{const L=L_(side);
  return pb({id:`nsigma15m-${sideTag(side)}`,label:`15m极端${L?"下跌":"上涨"}回归${sideCn(side)}`,iv:"15m",side,warm:100,family:"n-sigma",familyLabel:"极端波动回归",
  rule:`一根 15 分钟 K 线${L?"跌":"涨"}幅达到近 24 小时波动的 3.5 倍以上 → 反向${sideCn(side)}，目标回吐这根的一半；止损极值外 1ATR，最多 2 小时`,
  prep:(s,c)=>{const r=returns(s.c,s.n);return {...base(s,c),r,sd:stdev(r,96,s.n)};},
  enter:(x,s,i)=>{const r=x.r![i]!,sd=x.sd![i-1]!,a=x.a![i]!,c=s.c[i]!,o=s.o[i]!;if(!ok(r)||!(sd>0))return null;const z=r/sd;
    if(L&&z<=-3.5)return entry(side,s,i,x,s.l[i]!-a,{target:c+.5*(o-c),maxBars:8,why:`${z.toFixed(1)} 倍标准差下跌`});
    if(!L&&z>=3.5)return entry(side,s,i,x,s.h[i]!+a,{target:c-.5*(c-o),maxBars:8,why:`${z.toFixed(1)} 倍标准差上涨`});return null;}});}
// -------------------------------------------------------------- 18 15m structure break (HL / LH)
function pivots(s:Series,c:Ctx){return memo(c).get(key(s,"piv"),()=>{const o=new Float64Array(s.n).fill(0);// +1 pivot high, -1 pivot low (known 3 bars later)
  for(let i=3;i<s.n-3;i++){let ph=true,pl=true;for(let k=1;k<=3;k++){if(!(s.h[i]!>s.h[i-k]!&&s.h[i]!>s.h[i+k]!))ph=false;if(!(s.l[i]!<s.l[i-k]!&&s.l[i]!<s.l[i+k]!))pl=false;}o[i]=ph?1:pl?-1:0;}return o;});}
function structure(side:Side):Playbook{const L=L_(side);
  return pb({id:`struct15m-${sideTag(side)}`,label:`15m结构${L?"转强":"转弱"}${sideCn(side)}`,iv:"15m",side,warm:40,family:"structure",familyLabel:"结构突破（高低点）",
  rule:`15 分钟出现更${L?"高的低点":"低的高点"}后，收盘${L?"突破上一个高点":"跌破上一个低点"} → ${sideCn(side)}；止损那个${L?"低点":"高点"}外 0.25ATR（至少 0.8%），目标 2R，最多 8 小时`,
  prep:(s,c)=>({...base(s,c),pv:pivots(s,c)}),
  enter:(x,s,i)=>{const pv=x.pv!,a=x.a![i]!;const hs:number[]=[],ls:number[]=[];
    for(let j=i-4;j>=Math.max(3,i-80)&&(hs.length<1||ls.length<2);j--){if(pv[j]===1&&hs.length<1)hs.push(j);if(pv[j]===-1&&ls.length<2)ls.push(j);}
    const hs2:number[]=[];for(let j=i-4;j>=Math.max(3,i-80)&&hs2.length<2;j--)if(pv[j]===1)hs2.push(j);
    const c=s.c[i]!;
    if(L&&hs.length&&ls.length===2){const ph=s.h[hs[0]!]!,l1=s.l[ls[0]!]!,l2=s.l[ls[1]!]!;if(l1>l2&&c>ph&&s.c[i-1]!<=ph)return entry(side,s,i,x,l1-.25*a,{R:2,maxBars:32,why:"更高低点后突破前高"});}
    if(!L&&hs2.length===2){const lsx=ls.length?ls[0]!:-1;if(lsx<0)return null;const pl=s.l[lsx]!,h1=s.h[hs2[0]!]!,h2=s.h[hs2[1]!]!;
      if(h1<h2&&c<pl&&s.c[i-1]!>=pl)return entry(side,s,i,x,h1+.25*a,{R:2,maxBars:32,why:"更低高点后跌破前低"});}
    return null;}});}
// -------------------------------------------------------------- 19 NR7 inside-bar breakout (15m / 1h)
function nr7(iv:"15m"|"1h",side:Side):Playbook{const L=L_(side),mb=iv==="15m"?16:12;
  return pb({id:`nr7${iv}-${sideTag(side)}`,label:`${iv}窄幅内包${L?"上破":"下破"}${sideCn(side)}`,iv,side,warm:20,family:"nr7",familyLabel:"窄幅内包线突破",
  rule:`上一根 ${iv} K 线是近 7 根最窄、且被前一根完全包住（内包），这根收盘${L?"突破它的高点":"跌破它的低点"} → ${sideCn(side)}；止损它的另一端（至少 0.8%），目标 2R，最多 ${mb*IV_SEC[iv]/3600} 小时`,
  prep:(s,c)=>base(s,c),
  enter:(x,s,i)=>{const k=i-1,r=s.h[k]!-s.l[k]!;if(k<8)return null;for(let j=k-6;j<k;j++)if(s.h[j]!-s.l[j]!<=r)return null;
    if(!(s.h[k]!<=s.h[k-1]!&&s.l[k]!>=s.l[k-1]!))return null;const c=s.c[i]!;
    if(L&&c>s.h[k]!)return entry(side,s,i,x,s.l[k]!,{R:2,maxBars:mb,why:"窄幅内包线上破"});
    if(!L&&c<s.l[k]!)return entry(side,s,i,x,s.h[k]!,{R:2,maxBars:mb,why:"窄幅内包线下破"});return null;}});}
// -------------------------------------------------------------- 20 trend-day continuation (15m)
function trendDay(side:Side):Playbook{const L=L_(side);
  return pb({id:`trendday15m-${sideTag(side)}`,label:`单边${L?"上涨":"下跌"}日延续${sideCn(side)}`,iv:"15m",side,warm:100,family:"trend-day",familyLabel:"单边日延续",
  rule:`到 UTC 16:00 当天已${L?"涨":"跌"}超 2.5% 且收在当天区间的${L?"最上":"最下"} 20% → 顺势${sideCn(side)}到当天收盘；止损当天区间中线（至少 0.8%）`,
  prep:(s,c)=>base(s,c),
  enter:(x,s,i)=>{const t=s.t[i]!,day=Math.floor(t/DAY)*DAY;if(t+900!==day+16*3600)return null;const j0=idxAt(s,i,day,70);if(j0<0)return null;
    let hi=-Infinity,lo=Infinity;for(let j=j0;j<=i;j++){hi=Math.max(hi,s.h[j]!);lo=Math.min(lo,s.l[j]!);}
    const c=s.c[i]!,mv=c/s.o[j0]!-1,pos=(c-lo)/(hi-lo);if(!(hi>lo))return null;
    if(L?!(mv>=.025&&pos>=.8):!(mv<=-.025&&pos<=.2))return null;
    return entry(side,s,i,x,(hi+lo)/2,{maxBars:32,why:`当天 ${pct(mv)}，收在区间 ${Math.round(pos*100)}%`});}});}
// -------------------------------------------------------------- 21 prior-day high/low break & reject (15m)
function priorDay(s:Series,i:number){const t=s.t[i]!,day=Math.floor(t/DAY)*DAY;let hi=-Infinity,lo=Infinity,n=0,first=-1;
  for(let j=i-1;j>=Math.max(0,i-200);j--){const tj=s.t[j]!;if(tj>=day){first=j;continue;}if(tj<day-DAY)break;hi=Math.max(hi,s.h[j]!);lo=Math.min(lo,s.l[j]!);n++;}
  return {hi,lo,n,first:first<0?i:first};}
function pdBreak(side:Side):Playbook{const L=L_(side);
  return pb({id:`pdbreak15m-${sideTag(side)}`,label:`突破前一天${L?"高点":"低点"}${sideCn(side)}`,iv:"15m",side,warm:100,family:"pd-break",familyLabel:"前一天高低点突破",
  rule:`当天第一次收盘${L?"高于前一天最高点":"低于前一天最低点"} → ${sideCn(side)}；止损那条线${L?"下":"上"} 1ATR（至少 0.8%），目标 2R，最多 6 小时`,
  prep:(s,c)=>base(s,c),
  enter:(x,s,i)=>{const p=priorDay(s,i);if(p.n<80)return null;const lvl=L?p.hi:p.lo,c=s.c[i]!;if(L?!(c>lvl):!(c<lvl))return null;
    for(let j=p.first;j<i;j++)if(L?s.c[j]!>lvl:s.c[j]!<lvl)return null;
    return entry(side,s,i,x,lvl-(L?1:-1)*x.a![i]!,{R:2,maxBars:24,why:`收盘${L?"突破前日高":"跌破前日低"} ${lvl.toPrecision(6)}`});}});}
function pdReject(side:Side):Playbook{const L=L_(side);
  return pb({id:`pdreject15m-${sideTag(side)}`,label:`前一天${L?"低点":"高点"}假突破回落${sideCn(side)}`,iv:"15m",side,warm:100,family:"pd-reject",familyLabel:"前一天高低点假突破",
  rule:`影线${L?"刺破前一天最低点":"刺破前一天最高点"}但收回、开盘也在线内 → 反向${sideCn(side)}；止损影线外 0.25ATR，目标前一天中线（或 2R），最多 4 小时`,
  prep:(s,c)=>base(s,c),
  enter:(x,s,i)=>{const p=priorDay(s,i);if(p.n<80)return null;const c=s.c[i]!,o=s.o[i]!,a=x.a![i]!,mid=(p.hi+p.lo)/2;
    if(L&&s.l[i]!<p.lo&&c>p.lo&&o>p.lo)return entry(side,s,i,x,s.l[i]!-.25*a,{target:Math.max(mid,c*1.005),maxBars:16,why:"刺破前日低后收回"});
    if(!L&&s.h[i]!>p.hi&&c<p.hi&&o<p.hi)return entry(side,s,i,x,s.h[i]!+.25*a,{target:Math.min(mid,c*.995),maxBars:16,why:"刺破前日高后收回"});return null;}});}
// -------------------------------------------------------------- 22 round-number reaction (BTC / ETH, 15m)
const ROUND:Record<string,number>={BTC_USDT:1000,ETH_USDT:100};
function roundNum(side:Side):Playbook{const L=L_(side);
  return pb({id:`round15m-${sideTag(side)}`,label:`整数关口${L?"跌破收回":"突破回落"}${sideCn(side)}`,iv:"15m",side,warm:20,only:"majors",family:"round",familyLabel:"整数关口反应",
  rule:`BTC 每 1000、ETH 每 100 的整数关口：影线${L?"跌破":"冲过"}关口但收回、开盘也在关口${L?"上":"下"}方 → ${sideCn(side)}；止损影线外 0.25ATR（至少 0.8%），目标 1.5R，最多 4 小时`,
  prep:(s,c)=>base(s,c),
  enter:(x,s,i)=>{const step=ROUND[s.sym];if(!step)return null;const o=s.o[i]!,c=s.c[i]!,h=s.h[i]!,l=s.l[i]!,a=x.a![i]!;
    if(L){const lv=Math.floor(Math.min(o,c)/step)*step;if(l<lv&&c>lv&&o>lv)return entry(side,s,i,x,l-.25*a,{R:1.5,maxBars:16,why:`${lv} 下方扫单收回`});}
    else{const lv=Math.ceil(Math.max(o,c)/step)*step;if(h>lv&&c<lv&&o<lv)return entry(side,s,i,x,h+.25*a,{R:1.5,maxBars:16,why:`${lv} 上方冲过回落`});}
    return null;}});}
const BOTH:Side[]=["LONG","SHORT"];
export const SHORT_POOL:readonly Playbook[]=[
  ...BOTH.flatMap(sd=>[box("5m",sd),box("15m",sd)]),...BOTH.map(boxFade),
  ...(["asia","eu","us"] as SessionId[]).flatMap(se=>BOTH.map(sd=>orb(se,sd))),...BOTH.map(ny90),...BOTH.map(sweep),...BOTH.map(vwap),...BOTH.map(emaPull),
  ...BOTH.map(squeeze),...BOTH.map(bbRevert),...BOTH.map(rsiDiv),...BOTH.flatMap(sd=>[burst5("follow",sd),burst5("fade",sd)]),...BOTH.map(cascade),
  ...BOTH.map(pumpFade),...BOTH.map(laggard),...BOTH.map(residual),...BOTH.map(btcLead),...BOTH.map(nsigma),...BOTH.map(structure),
  ...BOTH.flatMap(sd=>[nr7("15m",sd),nr7("1h",sd)]),...BOTH.map(trendDay),...BOTH.map(pdBreak),...BOTH.map(pdReject),...BOTH.map(roundNum)];
void rollMax;void perH;
