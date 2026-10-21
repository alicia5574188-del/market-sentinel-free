/**
 * Living v3 environment read (2026-10-21): per coin, every minute, from the tape's own 5-minute bars (no new data source):
 * trend up / trend down / chop / quiet / spike / flush, plus the volatility level against the coin's own recent level;
 * and a market environment from the basket (majority env, breadth, BTC lead, basket 15-min return autocorrelation, 24h
 * direction). The coin env picks the playbook family; the market env decides whether that side is allowed and how big
 * (0.5–1×, from clarity — never a sample count). Pure functions only; all moves are price %, never ROE.
 */
import type {MidBar} from "./tape.ts";
import type {IntentPlaybook} from "./thesis.ts";
import {clamp,median,pct} from "./util.ts";

type Side="LONG"|"SHORT";
export type CoinEnvState="TREND_UP"|"TREND_DOWN"|"CHOP"|"QUIET"|"SPIKE"|"FLUSH"|"UNCLEAR"|"WARMING";
export type MarketEnvState=CoinEnvState|"MIXED";
export type CoinEnvEv={er:number|null;hh:number|null;ll:number|null;flips:number|null;wick:number|null;range4h:number|null;atr:number|null;
  vol:number|null;p60:number|null;pos:number|null;net:number|null};
export type CoinEnv={state:CoinEnvState;side:Side|null;clarity:number;sentence:string;ev:CoinEnvEv};
export type MarketEnv={at:number;state:MarketEnvState;side:Side|null;clarity:number;sentence:string;
  ev:{n:number;shares:Record<string,number>;breadth:number|null;btc:CoinEnvState|null;ac15:number|null;dir24:number|null}};

/** Thresholds (fractions; price %). */
export const REGIME={bars:48,minBars:24,refBars:288,refMin:60,
  spikeP60:.02,spikeAtr:6,
  trendEr:.3,trendStruct:.6,trendNetAtr:4,trendPosUp:.6,trendPosDn:.4,
  chopEr:.25,chopFlips:.45,chopWick:.5,chopRangeAtr:3,
  quietVol:.7,
  impulseAtr:1.5,impulseBars:6,sweepBars:6,sweepAtr:.25,
  market:{min:10,spike:.25,trend:.3,trendLead:.2,chop:.35,quiet:.45,against:.5}} as const;

export const ENV_LABEL:Record<MarketEnvState,string>={TREND_UP:"上升趋势",TREND_DOWN:"下降趋势",CHOP:"来回震荡",QUIET:"安静窄幅",SPIKE:"急拉",FLUSH:"急杀",
  UNCLEAR:"看不清",WARMING:"暖机中",MIXED:"分歧"};
/** Which playbooks each coin env takes (side null = both sides). */
export const ENV_PLAYBOOKS:Record<CoinEnvState,{pb:IntentPlaybook;side:Side|null}[]>={
  TREND_UP:[{pb:"follow",side:"LONG"},{pb:"impulse-retest",side:"LONG"},{pb:"flush-rebound",side:"LONG"},{pb:"absorb-revert",side:"LONG"}],
  TREND_DOWN:[{pb:"follow",side:"SHORT"},{pb:"impulse-retest",side:"SHORT"},{pb:"squeeze-fade",side:"SHORT"},{pb:"absorb-revert",side:"SHORT"}],
  CHOP:[{pb:"sweep-reclaim",side:null},{pb:"absorb-revert",side:null},{pb:"crowd-fade",side:null}],
  SPIKE:[{pb:"squeeze-fade",side:"SHORT"},{pb:"crowd-fade",side:"SHORT"}],
  FLUSH:[{pb:"flush-rebound",side:"LONG"},{pb:"crowd-fade",side:"LONG"}],
  QUIET:[{pb:"impulse-retest",side:null},{pb:"crowd-break",side:null}],
  UNCLEAR:[],WARMING:[]};
/** With-trend playbooks: blocked when the market env is clearly the other way. */
const WITH_TREND=new Set<IntentPlaybook>(["follow","impulse-retest","crowd-break"]);
const sideCn=(s:Side)=>s==="LONG"?"多":"空";
const f2=(v:number|null|undefined)=>v==null?"—":v.toFixed(2);
const pa=(v:number)=>`${(v*100).toFixed(2)}%`;

const rng=(r:MidBar)=>r.high-r.low;
/** Per-coin env from closed 5-minute bars (oldest first). */
export function coinEnv(rows5:MidBar[]):CoinEnv{
  const w=rows5.slice(-REGIME.bars),n=w.length;
  const empty:CoinEnvEv={er:null,hh:null,ll:null,flips:null,wick:null,range4h:null,atr:null,vol:null,p60:null,pos:null,net:null};
  if(n<REGIME.minBars)return{state:"WARMING",side:null,clarity:0,sentence:"币环境：5 分钟线还不够 2 小时，暖机中",ev:empty};
  const last=w[n-1]!.close,first=w[0]!.open;if(!(last>0)||!(first>0))return{state:"WARMING",side:null,clarity:0,sentence:"币环境：价格无效",ev:empty};
  let path=0;for(let i=1;i<n;i++)path+=Math.abs(w[i]!.close-w[i-1]!.close);path+=Math.abs(w[0]!.close-first);
  const netAbs=w[n-1]!.close-first,er=path>0?Math.abs(netAbs)/path:0,net=last/first-1;
  const atr=median(w.slice(-14).map(rng))/last;
  const ref=rows5.slice(-REGIME.refBars),vol=ref.length>=REGIME.refMin?(()=>{const m=median(ref.map(r=>rng(r)/r.close));return m>0?median(w.map(r=>rng(r)/r.close))/m:null;})():null;
  // structure: 12-bar chunks, higher highs + higher lows (or lower lows + lower highs)
  const k=Math.floor(n/12),ch:{h:number;l:number}[]=[];
  for(let i=0;i<k;i++){const c=w.slice(n-(k-i)*12,n-(k-i-1)*12);ch.push({h:Math.max(...c.map(r=>r.high)),l:Math.min(...c.map(r=>r.low))});}
  let up=0,dn=0;for(let i=1;i<ch.length;i++){if(ch[i]!.h>ch[i-1]!.h&&ch[i]!.l>ch[i-1]!.l)up++;if(ch[i]!.h<ch[i-1]!.h&&ch[i]!.l<ch[i-1]!.l)dn++;}
  const hh=ch.length>1?up/(ch.length-1):0,ll=ch.length>1?dn/(ch.length-1):0;
  // 15-min return sign flips
  const c15:number[]=[];for(let i=n-1;i>=0;i-=3)c15.unshift(w[i]!.close);
  const r15=c15.slice(1).map((c,i)=>c/c15[i]!-1).filter(x=>x!==0);let fl=0;for(let i=1;i<r15.length;i++)if(Math.sign(r15[i]!)!==Math.sign(r15[i-1]!))fl++;
  const flips=r15.length>1?fl/(r15.length-1):0;
  const wk=w.filter(r=>rng(r)>0),wick=wk.length?wk.reduce((s,r)=>s+1-Math.abs(r.close-r.open)/rng(r),0)/wk.length:0;
  const hi=Math.max(...w.map(r=>r.high)),lo=Math.min(...w.map(r=>r.low)),range4h=(hi-lo)/last,pos=hi>lo?(last-lo)/(hi-lo):.5;
  const p60=n>12?last/w[n-13]!.close-1:null;
  const ev:CoinEnvEv={er:r(er),hh:r(hh),ll:r(ll),flips:r(flips),wick:r(wick),range4h:r(range4h,5),atr:r(atr,5),vol:vol==null?null:r(vol),p60:p60==null?null:r(p60,5),pos:r(pos),net:r(net,5)};
  const refAtr=vol!=null&&vol>0?atr/vol:atr;// the coin's own usual 5m range
  const volTxt=vol==null?"":`，波动是自己平时的 ${vol.toFixed(1)} 倍`;
  const tail=`（效率 ${f2(er)}，4 小时区间 ${pa(range4h)}，5 分钟波动 ${pa(atr)}${volTxt}）`;
  const spikeLine=Math.max(REGIME.spikeP60,REGIME.spikeAtr*refAtr);
  if(p60!=null&&Math.abs(p60)>=spikeLine){
    const s:CoinEnvState=p60>0?"SPIKE":"FLUSH",c=clamp((Math.abs(p60)/spikeLine-1)/1+.5,0,1);
    return{state:s,side:p60>0?"LONG":"SHORT",clarity:r(c),ev,sentence:`币环境：${ENV_LABEL[s]}，1 小时 ${pct(p60)}（线 ${pa(spikeLine)}）→ 等${s==="SPIKE"?"拉升力竭反做空":"杀跌出尽抄反弹"}${tail}`};
  }
  const trendBase=er>=REGIME.trendEr&&Math.abs(net)>=REGIME.trendNetAtr*atr;
  if(trendBase&&net>0&&hh>=REGIME.trendStruct&&pos>=REGIME.trendPosUp){
    const c=clamp(.4*(er-REGIME.trendEr)/.3+.3*hh+.3*(pos-.5)/.5,0,1);
    return{state:"TREND_UP",side:"LONG",clarity:r(c),ev,sentence:`币环境：上升趋势，4 小时 ${pct(net)}，高点低点一路抬高（${up}/${ch.length-1}），位置在区间 ${Math.round(pos*100)}% → 只做回调守住的多${tail}`};
  }
  if(trendBase&&net<0&&ll>=REGIME.trendStruct&&pos<=REGIME.trendPosDn){
    const c=clamp(.4*(er-REGIME.trendEr)/.3+.3*ll+.3*(.5-pos)/.5,0,1);
    return{state:"TREND_DOWN",side:"SHORT",clarity:r(c),ev,sentence:`币环境：下降趋势，4 小时 ${pct(net)}，高点低点一路降低（${dn}/${ch.length-1}），位置在区间 ${Math.round(pos*100)}% → 只做反弹失败的空${tail}`};
  }
  if(vol!=null&&vol<=REGIME.quietVol){
    const c=clamp((REGIME.quietVol-vol)/.4+.4,0,1);
    return{state:"QUIET",side:null,clarity:r(c),ev,sentence:`币环境：安静窄幅，波动只有平时的 ${vol.toFixed(2)} 倍 → 等第一根快速冲出区间的 K 线再回踩${tail}`};
  }
  if(er<=REGIME.chopEr&&(flips>=REGIME.chopFlips||wick>=REGIME.chopWick)&&range4h>=REGIME.chopRangeAtr*atr){
    const c=clamp(.4*(REGIME.chopEr-er)/REGIME.chopEr+.3*flips+.3*wick,0,1);
    return{state:"CHOP",side:null,clarity:r(c),ev,sentence:`币环境：来回震荡，15 分钟方向翻转 ${Math.round(flips*100)}%，影线占 ${Math.round(wick*100)}% → 不追突破，只做扫过边缘又收回的假突破，目标区间中部${tail}`};
  }
  return{state:"UNCLEAR",side:null,clarity:0,ev,sentence:`币环境：看不清（不是趋势、震荡或安静）→ 不按环境开${tail}`};
}
function r(v:number,k=2){return Math.round(v*10**k)/10**k;}

/** Lag-1 autocorrelation of the equal-weight basket 15-minute return (> 0 follow-through, < 0 back-and-forth). */
export function basketAutocorr(rows:MidBar[][],slots=96):number|null{
  const sum=new Map<number,{s:number;n:number}>();
  for(const rs of rows){
    const last=new Map<number,number>();for(const b of rs.slice(-(slots+1)*3))last.set(Math.floor(b.time/900),b.close);
    const keys=[...last.keys()].sort((a,b)=>a-b);
    for(let i=1;i<keys.length;i++){if(keys[i]!-keys[i-1]!!==1)continue;const x=last.get(keys[i]!)!/last.get(keys[i-1]!)!-1;
      const e=sum.get(keys[i]!)??{s:0,n:0};e.s+=x;e.n++;sum.set(keys[i]!,e);}
  }
  const ks=[...sum.keys()].sort((a,b)=>a-b).slice(-slots),xs=ks.map(k=>sum.get(k)!).filter(e=>e.n>=3).map(e=>e.s/e.n);
  if(xs.length<16)return null;
  const m=xs.reduce((s,x)=>s+x,0)/xs.length;let num=0,den=0;
  for(let i=0;i<xs.length;i++){den+=(xs[i]!-m)**2;if(i>0)num+=(xs[i]!-m)*(xs[i-1]!-m);}
  return den>0?r(num/den):null;
}
/** Median 24h price change of the basket from the tape's own bars (≥ 20h of bars needed). */
export function basketDir24(rows:MidBar[][]):number|null{
  const xs=rows.filter(rs=>rs.length>=240).map(rs=>{const a=rs[Math.max(0,rs.length-289)]!.close,b=rs.at(-1)!.close;return a>0?b/a-1:null;}).filter((x):x is number=>x!=null);
  return xs.length>=10?r(median(xs),5):null;
}

/** Market env from the basket's coin envs. */
export function marketEnv(envs:CoinEnv[],btc:CoinEnv|null,ac15:number|null,dir24:number|null,now:number):MarketEnv{
  const live=envs.filter(e=>e.state!=="WARMING"),n=live.length,M=REGIME.market;
  const shares:Record<string,number>={};for(const e of live)shares[e.state]=(shares[e.state]??0)+1;for(const k in shares)shares[k]=r(shares[k]!/Math.max(1,n));
  const sh=(k:CoinEnvState)=>shares[k]??0;
  const p60s=live.map(e=>e.ev.p60).filter((x):x is number=>x!=null),upN=p60s.filter(x=>x>0).length;
  const breadth=p60s.length?r(Math.max(upN,p60s.length-upN)/p60s.length):null;
  const ev={n,shares,breadth,btc:btc?.state??null,ac15,dir24};
  const mk=(state:MarketEnvState,side:Side|null,clarity:number,sentence:string):MarketEnv=>({at:now,state,side,clarity:r(clamp(clarity,0,1)),sentence,ev});
  if(n<M.min)return mk("WARMING",null,0,`市场环境：只有 ${n} 个币读得出环境，暖机中`);
  const tail=`（篮子 ${n} 个：趋势上 ${Math.round(sh("TREND_UP")*100)}%/下 ${Math.round(sh("TREND_DOWN")*100)}%，震荡 ${Math.round(sh("CHOP")*100)}%，安静 ${Math.round(sh("QUIET")*100)}%；`+
    `BTC ${btc?ENV_LABEL[btc.state]:"—"}；15 分钟自相关 ${ac15==null?"—":ac15.toFixed(2)}；24 小时 ${dir24==null?"—":pct(dir24)}）`;
  if(sh("FLUSH")>=M.spike&&sh("FLUSH")>=sh("SPIKE"))return mk("FLUSH","SHORT",.5+sh("FLUSH"),`市场环境：集体急杀 ${Math.round(sh("FLUSH")*100)}% 的币 → 不追空，等出尽抄反弹${tail}`);
  if(sh("SPIKE")>=M.spike)return mk("SPIKE","LONG",.5+sh("SPIKE"),`市场环境：集体急拉 ${Math.round(sh("SPIKE")*100)}% 的币 → 不追多，等力竭反做${tail}`);
  const lead=(s:CoinEnvState)=>btc?.state===s?.15:0,d24=(sg:number)=>dir24!=null&&sg*dir24>=.01?.1:0,ac=ac15!=null&&ac15>0?.05:0;
  const upS=sh("TREND_UP")+.5*sh("SPIKE")-sh("TREND_DOWN")-.5*sh("FLUSH")+lead("TREND_UP")-lead("TREND_DOWN")+d24(1)-d24(-1);
  if(sh("TREND_UP")>=M.trend&&upS>=M.trendLead)return mk("TREND_UP","LONG",.3+upS+ac,`市场环境：上升趋势占多数 → 做多回调，不做空${tail}`);
  if(sh("TREND_DOWN")>=M.trend&&-upS>=M.trendLead)return mk("TREND_DOWN","SHORT",.3-upS+ac,`市场环境：下降趋势占多数 → 做空反弹失败，不抄底追多${tail}`);
  if(sh("CHOP")>=M.chop||(ac15!=null&&ac15<=-.15&&sh("CHOP")+sh("QUIET")>=.5))
    return mk("CHOP",null,.3+sh("CHOP")+(ac15!=null&&ac15<0?Math.min(.2,-ac15):0),`市场环境：来回震荡为主 → 只做假突破回到区间中部，不追突破${tail}`);
  if(sh("QUIET")>=M.quiet)return mk("QUIET",null,.3+sh("QUIET"),`市场环境：普遍安静 → 等个别币第一根快速冲出区间再回踩${tail}`);
  return mk("MIXED",null,.2,`市场环境：分歧，没有占多数的环境 → 只做币自己环境清楚的打法（小仓）${tail}`);
}

/** Env decision for one candidate: does the coin env take this playbook, does the market env allow the side, and how big. */
export type EnvDecision={ok:boolean;mult:number;why:string;layer:"ENV_PICK"|"ENV_MISMATCH"|"L1_MARKET"};
export function envDecide(coin:CoinEnv|null,market:MarketEnv|null,pb:IntentPlaybook,side:Side):EnvDecision{
  if(!coin)return{ok:false,mult:0,layer:"ENV_MISMATCH",why:"环境：这个币还没有环境读数"};
  const fits=ENV_PLAYBOOKS[coin.state].some(x=>x.pb===pb&&(x.side==null||x.side===side));
  if(!fits)return{ok:false,mult:0,layer:"ENV_MISMATCH",why:`环境不对：这个币是「${ENV_LABEL[coin.state]}」，不做「${pb} ${sideCn(side)}」`};
  if(coin.state==="TREND_DOWN"&&WITH_TREND.has(pb)&&!(market&&market.side==="SHORT"&&(market.state==="TREND_DOWN"||market.state==="FLUSH")))
    return{ok:false,mult:0,layer:"ENV_MISMATCH",why:`环境：币在下降趋势，但市场环境不是向下（${market?ENV_LABEL[market.state]:"—"}），顺势空不做`};
  if(market&&market.side&&market.side!==side&&market.clarity>=REGIME.market.against){
    const exhaust=(pb==="flush-rebound"&&market.state==="FLUSH")||(pb==="squeeze-fade"&&market.state==="SPIKE");
    if(!exhaust)return{ok:false,mult:0,layer:"L1_MARKET",why:`市场环境明确反向：${ENV_LABEL[market.state]}（清晰度 ${market.clarity.toFixed(2)}），不做${sideCn(side)}`};
  }
  const aligned=!!market&&(market.side===side||market.state===coin.state);
  const mc=!market||market.state==="WARMING"||market.state==="MIXED"?0:aligned?market.clarity:.4*market.clarity;
  const mult=r(clamp(.5+.5*(.6*coin.clarity+.4*mc),.5,1));
  return{ok:true,mult,layer:"ENV_PICK",why:`环境：币「${ENV_LABEL[coin.state]}」（清晰度 ${coin.clarity.toFixed(2)}）+ 市场「${market?ENV_LABEL[market.state]:"—"}」→ 做「${pb} ${sideCn(side)}」，仓位 ${mult}×`};
}

/** Env-native setups (when the intent read has no action that fits): sweep-and-reclaim in chop, first impulse + retest in
 * quiet / trend, and a pullback follow in a trend. Strength comes from env clarity (≥ 0.45 so it passes layer 2). */
export type EnvSetup={pb:IntentPlaybook;side:Side;strength:number;why:string};
export function envSetup(env:CoinEnv,rows5:MidBar[],capital:string|null):EnvSetup|null{
  const w=rows5.slice(-REGIME.bars),n=w.length;if(n<REGIME.minBars||env.ev.atr==null)return null;
  const last=w[n-1]!.close,A=env.ev.atr*last,st=.45+.3*env.clarity;
  if(env.state==="CHOP"){
    const sw=sweepReclaim(w,A);if(!sw)return null;
    return{pb:"sweep-reclaim",side:sw.side,strength:r(st+((sw.side==="LONG"?capital==="ABSORB_BID":capital==="ABSORB_ASK")?.1:0)),
      why:`${envHead(env.sentence)}；扫过区间${sw.side==="LONG"?"下沿":"上沿"} ${sw.level.toPrecision(6)} 到 ${sw.ext.toPrecision(6)} 又收回 → 假突破，做回区间中部 ${sw.mid.toPrecision(6)}`};
  }
  if(env.state==="QUIET"||env.state==="TREND_UP"||env.state==="TREND_DOWN"){
    const im=impulse(w,A,env.state==="QUIET"?null:env.state==="TREND_UP"?"LONG":"SHORT",env.state==="QUIET");
    if(im)return{pb:"impulse-retest",side:im.side,strength:r(st),why:`${envHead(env.sentence)}；一根 5 分钟 K 线冲了 ${(im.size/A).toFixed(1)} 倍波动（从 ${im.start.toPrecision(6)}），等回踩守住起点再走`};
    if(env.state!=="QUIET"){const side:Side=env.state==="TREND_UP"?"LONG":"SHORT",against=side==="LONG"?["SUPPLY","FLUSH_DOWN"]:["DEMAND","SQUEEZE_UP"];
      if(capital&&against.includes(capital))return null;
      return{pb:"follow",side,strength:r(st),why:`${envHead(env.sentence)}；等回调守住再顺势${sideCn(side)}`};}
  }
  return null;
}
/** Last ≤ 6 bars swept beyond the prior 4h range edge by ≥ 0.25 ATR and the last close is back inside. */
export function sweepReclaim(w:MidBar[],A:number){
  const k=REGIME.sweepBars,prior=w.slice(0,-k),recent=w.slice(-k);if(prior.length<12||!(A>0))return null;
  const hi=Math.max(...prior.map(x=>x.high)),lo=Math.min(...prior.map(x=>x.low)),mid=(hi+lo)/2,last=w.at(-1)!.close;
  const rl=Math.min(...recent.map(x=>x.low)),rh=Math.max(...recent.map(x=>x.high));
  if(rl<=lo-REGIME.sweepAtr*A&&last>lo&&last<mid)return{side:"LONG" as Side,level:lo,ext:rl,mid,hi,lo};
  if(rh>=hi+REGIME.sweepAtr*A&&last<hi&&last>mid)return{side:"SHORT" as Side,level:hi,ext:rh,mid,hi,lo};
  return null;
}
/** A single 5-minute bar in the last 6 with range ≥ 1.5 ATR and body ≥ 60% of it, in `dir` (or either); price still holds above
 * the bar's start. `outOfRange`: the bar must close beyond the range of the bars before it (QUIET breakout). */
export function impulse(w:MidBar[],A:number,dir:Side|null,outOfRange:boolean){
  const k=REGIME.impulseBars,last=w.at(-1)!.close;
  for(let i=w.length-1;i>=Math.max(1,w.length-k);i--){
    const b=w[i]!,size=b.high-b.low,body=b.close-b.open;if(!(size>=REGIME.impulseAtr*A)||Math.abs(body)<.6*size)continue;
    const side:Side=body>0?"LONG":"SHORT";if(dir&&side!==dir)continue;
    const before=w.slice(Math.max(0,i-24),i);
    if(outOfRange&&before.length&&(side==="LONG"?b.close<=Math.max(...before.map(x=>x.high)):b.close>=Math.min(...before.map(x=>x.low))))continue;
    const start=side==="LONG"?b.low:b.high,ext=Math.max(...w.slice(i).map(x=>side==="LONG"?x.high:-x.low))*(side==="LONG"?1:-1);
    if(side==="LONG"?last<=start:last>=start)continue;
    return{side,start,ext,size,at:b.time};
  }
  return null;
}
/** Zone + invalidation for the env-native playbooks (planIntent delegates here). */
export function envPlan(pb:"sweep-reclaim"|"impulse-retest",side:Side,rows5:MidBar[],A:number):{lo:number;hi:number;inv:number;target:number|null;ref:number|null;hold:number}|null{
  const w=rows5.slice(-REGIME.bars);if(w.length<REGIME.minBars||!(A>0))return null;
  if(pb==="sweep-reclaim"){
    const sw=sweepReclaim(w,A);if(!sw||sw.side!==side)return null;
    return side==="LONG"?{lo:sw.level,hi:Math.min(sw.level+.6*A,sw.mid),inv:sw.ext-.3*A,target:sw.mid,ref:sw.level,hold:120}
      :{lo:Math.max(sw.level-.6*A,sw.mid),hi:sw.level,inv:sw.ext+.3*A,target:sw.mid,ref:sw.level,hold:120};
  }
  const im=impulse(w,A,side,false);if(!im)return null;
  const leg=Math.abs(im.ext-im.start),s=side==="LONG"?1:-1,a=im.start+s*.25*leg,b=im.start+s*.55*leg;
  return{lo:Math.min(a,b),hi:Math.max(a,b),inv:im.start-s*.3*A,target:im.ext,ref:im.start,hold:120};
}
/** The env sentence without its trailing evidence bracket (for notes). */
export const envHead=(s:string|null|undefined)=>(s??"").replace(/（(效率|篮子).*$/,"");
/** Compact env tag for logs: "CHOP|M:TREND_UP". */
export const envTag=(c:CoinEnv|null|undefined,m:MarketEnv|null|undefined)=>`${c?.state??"-"}|M:${m?.state??"-"}`;
