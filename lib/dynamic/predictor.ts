/**
 * dynamic-v1.2 cycle predictor (pure). Per playbook (each playbook has one side):
 *  1. phase sequence on an hourly line: rolling 72 h net of its shadow trades → GOOD (> +0.3%) / BAD (< −0.3%) / keeps the
 *     previous label in between (hysteresis), unknown when the window has no trade; phases = runs (start, end, hours, depth = net
 *     of the trades closed inside, trades);
 *  2. learners, recomputed from the whole line at each analysis (history arrives newest first, so past hours can still change):
 *     (a) timing — hazard of BAD→GOOD (and GOOD→BAD) per hour of elapsed phase time, shrunk to the pool's hazard; periodicity of
 *         daily P&L (autocorrelation); session / hour / weekday profile (shrunk means);
 *     (b) BTC/ETH relation — per BTC/ETH state feature bin: how often the playbook is in a good phase, and how often a good phase
 *         starts (onset rate during bad phases), both with Beta shrinkage to its own base rate; plus a tiny online logistic model
 *         per horizon (6 / 24 / 72 h) streamed over the hours in time order (predict, score, then update — its prequential Brier
 *         is the in-history track record);
 *  3. forecast now: current phase + elapsed time, P(good at +6 / +24 / +72 h) = hazard estimate blended with the logistic model
 *     (weight by its sample and its prequential skill), the most likely trigger in plain words (a BTC/ETH state change with a
 *     high onset lift, else "in ~N hours" from the hazard), and an evidence label (数据少 / 数据一般 / 数据较足).
 * Scoring of logged forecasts (after the horizon passed) and the track records live here too.
 */
import {Series,ema,atr,efficiency,rollMax,corr} from "./series.ts";
import type {TradeLite} from "./cycles.ts";
import {sampleOf,sampleLabel} from "./cycles.ts";
const H=3600;
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
export const PRED={windowH:72,goodAbove:.003,badBelow:-.003,minWindowTrades:2,maxHours:180*24,horizons:[6,24,72] as const,
  hazEdges:[0,6,12,24,48,96,Infinity],hazPriorH:48,condPriorH:48,onsetPriorH:96,lr:.01,l2:1e-3,triggerLift:1.25,triggerMinOnsets:2} as const;
export type Lab=1|-1|0;
// ------------------------------------------------------------------ 1) phase line
export type Line={t0:number;n:number;lab:Int8Array;elapsed:Int32Array;cum:Float64Array;cnt:Int32Array};
/** hourly label line ending at the last full hour ≤ nowSec (t0 = end time of hour 0; hour i ends at t0 + i·H) */
export function labelLine(trades:readonly TradeLite[],nowSec:number):Line|null{
  const ts=[...trades].sort((a,b)=>a.xt-b.xt);if(!ts.length)return null;
  const end=Math.floor(nowSec/H)*H,t0=Math.max(Math.floor(ts[0]!.xt/H)*H+H,end-(PRED.maxHours-1)*H);if(t0>end)return null;
  const n=(end-t0)/H+1,lab=new Int8Array(n),elapsed=new Int32Array(n),cum=new Float64Array(n),cnt=new Int32Array(n);
  let lo=0,hi=0,sum=0,c=0,tot=0,prev:Lab=0,pre=0;while(pre<ts.length&&ts[pre]!.xt<=t0-H*PRED.windowH)pre++;lo=pre;hi=pre;
  for(let k=0;k<pre;k++)tot+=ts[k]!.net;
  for(let i=0;i<n;i++){const e=t0+i*H;
    while(hi<ts.length&&ts[hi]!.xt<=e){sum+=ts[hi]!.net;tot+=ts[hi]!.net;hi++;c++;}
    while(lo<hi&&ts[lo]!.xt<=e-PRED.windowH*H){sum-=ts[lo]!.net;lo++;c--;}
    let l:Lab=c===0?0:prev;if(c>=PRED.minWindowTrades){if(sum>PRED.goodAbove)l=1;else if(sum<PRED.badBelow)l=-1;}
    lab[i]=l;elapsed[i]=l!==0&&i>0&&lab[i-1]===l?elapsed[i-1]!+1:l!==0?1:0;cum[i]=tot;cnt[i]=c;prev=l;}
  return {t0,n,lab,elapsed,cum,cnt};
}
export type PhaseRec={label:"GOOD"|"BAD";start:number;end:number;hours:number;depth:number;trades:number;open:boolean;next:Lab};
export function phasesOfLine(L:Line,trades:readonly TradeLite[]):PhaseRec[]{
  const out:PhaseRec[]=[];let i=0;const xs=[...trades].map(t=>t.xt).sort((a,b)=>a-b);
  const count=(a:number,b:number)=>{let lo=0,hi=xs.length;while(lo<hi){const m=(lo+hi)>>1;if(xs[m]!<=a)lo=m+1;else hi=m;}let k=lo;while(k<xs.length&&xs[k]!<=b)k++;return k-lo;};
  while(i<L.n){const l=L.lab[i]!;if(!l){i++;continue;}let j=i;while(j+1<L.n&&L.lab[j+1]===l)j++;
    const s=L.t0+i*H,e=L.t0+j*H,before=i>0?L.cum[i-1]!:L.cum[i]!-0;
    out.push({label:l===1?"GOOD":"BAD",start:s,end:e,hours:j-i+1,depth:L.cum[j]!-(i>0?before:0),trades:count(s-H,e),open:j===L.n-1,next:j+1<L.n?L.lab[j+1] as Lab:0});i=j+1;}
  return out;
}
// ------------------------------------------------------------------ 2a) timing
export type Hazard={events:number[];exposure:number[]};
const binOf=(j:number)=>{const E=PRED.hazEdges;for(let b=0;b<E.length-1;b++)if(j>=E[b]!&&j<E[b+1]!)return b;return E.length-2;};
/** raw hazard counts of phases with this label: an event = the phase ended by turning into the opposite label */
export function hazardCounts(phases:readonly PhaseRec[],label:"GOOD"|"BAD"):Hazard{
  const nb=PRED.hazEdges.length-1,ev=Array(nb).fill(0),ex=Array(nb).fill(0);
  for(const p of phases){if(p.label!==label)continue;for(let j=0;j<p.hours;j++)ex[binOf(j)]++;
    if(!p.open&&p.next===(label==="GOOD"?-1:1))ev[binOf(p.hours-1)]++;}
  return {events:ev,exposure:ex};
}
export const addHazard=(a:Hazard,b:Hazard):Hazard=>({events:a.events.map((x,i)=>x+b.events[i]!),exposure:a.exposure.map((x,i)=>x+b.exposure[i]!)});
/** per-hour switch rate per elapsed-time bin, shrunk to the pool's (Beta prior worth hazPriorH hours) */
export function hazardRates(own:Hazard,pool:Hazard):number[]{
  return own.events.map((e,b)=>{const pr=pool.exposure[b]!>0?pool.events[b]!/pool.exposure[b]!:.02;return (e+PRED.hazPriorH*pr)/(own.exposure[b]!+PRED.hazPriorH);});
}
/** P(the phase is still running h hours later | it has run `elapsed` hours) */
export function survive(rates:readonly number[],elapsed:number,h:number){const E=PRED.hazEdges;let s=1,j=elapsed;const end=elapsed+h;
  while(j<end){const b=binOf(j),stop=Math.min(end,E[b+1]!);s*=Math.pow(1-Math.min(.999,rates[b]!),stop-j);j=stop;}return s;}
/** hours until the switch probability reaches 50% (≤ 14 days), or null */
export function medianWait(rates:readonly number[],elapsed:number){let s=1;for(let k=0;k<336;k++){s*=1-Math.min(.999,rates[binOf(elapsed+k)]!);if(s<=.5)return k+1;}return null;}
/** strongest autocorrelation of daily P&L at lags 2–14 days (needs ≥ 21 days) */
export function periodicity(trades:readonly TradeLite[]):{lag:number;acf:number}|null{
  if(!trades.length)return null;const d0=Math.floor(Math.min(...trades.map(t=>t.xt))/86_400),d1=Math.floor(Math.max(...trades.map(t=>t.xt))/86_400),n=d1-d0+1;if(n<21)return null;
  const x=new Float64Array(n);for(const t of trades)x[Math.floor(t.xt/86_400)-d0]+=t.net;let m=0;for(const v of x)m+=v;m/=n;let v0=0;for(const v of x)v0+=(v-m)**2;if(!(v0>0))return null;
  let best:{lag:number;acf:number}|null=null;
  for(let lag=2;lag<=14&&lag<n/2;lag++){let c=0;for(let i=lag;i<n;i++)c+=(x[i]!-m)*(x[i-lag]!-m);const a=c/v0;if(a>=.25&&(!best||a>best.acf))best={lag,acf:a};}
  return best;
}
export type Profile={session:Record<string,number>;hour:number[];weekday:number[];best:{session:string|null;weekday:number|null}};
const SESS=["ASIA","EU","US","LATE"] as const;
export const sessOfHour=(h:number)=>h<7?"ASIA":h<13?"EU":h<21?"US":"LATE";
export function profileOf(trades:readonly TradeLite[],k=10):Profile{
  const all=trades.reduce((a,t)=>a+t.net,0)/Math.max(1,trades.length);
  const agg=(key:(t:TradeLite)=>string|number)=>{const m=new Map<string|number,[number,number]>();for(const t of trades){const q=key(t),x=m.get(q)??[0,0];x[0]+=t.net;x[1]++;m.set(q,x);}return (q:string|number)=>{const x=m.get(q)??[0,0];return (x[0]+k*all)/(x[1]+k);};};
  const se=agg(t=>sessOfHour(Math.floor((t.et%86_400)/H))),ho=agg(t=>Math.floor((t.et%86_400)/H)),wd=agg(t=>new Date(t.et*1000).getUTCDay());
  const session=Object.fromEntries(SESS.map(s=>[s,se(s)])),hour=Array.from({length:24},(_,h)=>ho(h)),weekday=Array.from({length:7},(_,d)=>wd(d));
  const bs=trades.length>=20?SESS.reduce((a,b)=>session[b]!>session[a]!?b:a,"ASIA" as string):null,bw=trades.length>=40?weekday.indexOf(Math.max(...weekday)):null;
  return {session,hour,weekday,best:{session:bs,weekday:bw}};
}
// ------------------------------------------------------------------ 2b) BTC / ETH state features
export const FEATS=[
  {k:"b4h",name:"BTC 4 小时趋势",bins:["SUP","UP","FLAT","DOWN","SDOWN"],text:{SUP:"BTC 4 小时强势上涨",UP:"BTC 4 小时转涨",FLAT:"BTC 4 小时走平",DOWN:"BTC 4 小时转跌",SDOWN:"BTC 4 小时急跌"}},
  {k:"b1h",name:"BTC 1 小时趋势",bins:["UP","FLAT","DOWN"],text:{UP:"BTC 1 小时转涨",FLAT:"BTC 1 小时走平",DOWN:"BTC 1 小时转跌"}},
  {k:"vol",name:"BTC 波动水平",bins:["LOW","MID","HIGH"],text:{LOW:"波动变低",MID:"波动回到中等",HIGH:"波动变高"}},
  {k:"dvol",name:"BTC 波动变化",bins:["UP","STEADY","DOWN"],text:{UP:"波动放大",STEADY:"波动稳定",DOWN:"波动收缩"}},
  {k:"eff",name:"BTC 走势（单边/震荡）",bins:["TREND","MIXED","CHOP"],text:{TREND:"BTC 走成单边",MIXED:"BTC 半单边半震荡",CHOP:"BTC 来回震荡"}},
  {k:"dd",name:"BTC 离一周高点",bins:["HIGH","PULL","DEEP"],text:{HIGH:"BTC 回到一周高点附近",PULL:"BTC 从高点回撤 2–6%",DEEP:"BTC 深度回撤超过 6%"}},
  {k:"alt",name:"山寨相对 BTC",bins:["ALT","EVEN","BTC"],text:{ALT:"山寨强于 BTC",EVEN:"山寨和 BTC 同步",BTC:"BTC 强于山寨"}},
  {k:"corr",name:"币种相关性",bins:["HIGH","MID","LOW"],text:{HIGH:"币种同涨同跌",MID:"币种相关性中等",LOW:"币种各走各的"}},
  {k:"eth",name:"ETH 1 小时趋势",bins:["UP","FLAT","DOWN"],text:{UP:"ETH 1 小时转涨",FLAT:"ETH 1 小时走平",DOWN:"ETH 1 小时转跌"}},
  {k:"sess",name:"时段",bins:["ASIA","EU","US","LATE"],text:{ASIA:"进入亚洲盘",EU:"进入欧洲盘",US:"进入美国盘",LATE:"进入美盘尾段"}},
] as const;
export type FeatKey=typeof FEATS[number]["k"];
/** one-hot layout: every bin of every feature, then phase inputs (in good, in bad, log elapsed), then bias */
const OFF:number[]=[];let D_=0;for(const f of FEATS){OFF.push(D_);D_+=f.bins.length;}
export const DIM=D_+5;
/** index of the hazard-logit input; its weight starts at 2 so a fresh model says exactly what the hazard says */
export const HAZ_IN=D_+3;
export type FeatRow={t:number;b:(number|-1)[]};// t = hour end (the BTC 1h bar that closed then); b[f] = bin index or −1 (unknown)
export type FeatTable={rows:FeatRow[];at:Map<number,number>};
/** BTC/ETH state per closed BTC 1h bar (and alts' 1h for alt-vs-BTC / correlation where they exist). No request. */
export function btcFeatures(btc:Series,eth:Series|null,alts:readonly Series[]):FeatTable{
  const n=btc.n,rows:FeatRow[]=[],at=new Map<number,number>();if(n<130)return {rows,at};
  const c=btc.c,e20=ema(c,20,n),e50=ema(c,50,n),e80=ema(c,80,n),a24=atr(btc,24),ef=efficiency(c,24,n),hi=rollMax(btc.h,168,n);
  const ap=new Float64Array(n);for(let i=0;i<n;i++)ap[i]=a24[i]!/c[i]!;
  const ee=eth&&eth.n>60?{f:ema(eth.c,20,eth.n),w:ema(eth.c,50,eth.n),at:new Map(Array.from(eth.t.subarray(0,eth.n),(t,i)=>[t,i]))}:null;
  const am=alts.map(a=>({s:a,at:new Map(Array.from(a.t.subarray(0,a.n),(t,i)=>[t,i]))}));
  const dir=(x:number,th:number)=>x>th?0:x<-th?2:1;
  for(let i=120;i<n;i++){const t=btc.t[i]!,b:(number|-1)[]=[];
    const s4=c[i]!/e80[i]!-1;b.push(s4>.02?0:s4>.005?1:s4<-.02?4:s4<-.005?3:2);
    b.push(dir((e20[i]!-e50[i]!)/c[i]!,.002));
    let below=0,cnt=0;for(let j=Math.max(0,i-719);j<=i;j+=3){const v=ap[j]!;if(Number.isFinite(v)){cnt++;if(v<ap[i]!)below++;}}const vp=cnt?below/cnt:.5;b.push(vp<1/3?0:vp>2/3?2:1);
    const dv=i>=24?ap[i]!/ap[i-24]!-1:NaN;b.push(!Number.isFinite(dv)?-1:dv>.15?0:dv<-.15?2:1);
    const e=ef[i]!;b.push(!Number.isFinite(e)?-1:e>.35?0:e<.15?2:1);
    const dd=c[i]!/hi[i]!-1;b.push(!Number.isFinite(dd)?-1:dd>-.02?0:dd>-.06?1:2);
    // alts vs BTC (24 h) and correlation (48 h of 1h returns)
    const r24=i>=24?c[i]!/c[i-24]!-1:NaN,rs:number[]=[],cs:number[]=[];
    for(const a of am){const k=a.at.get(t);if(k==null||k<48)continue;const k24=a.at.get(btc.t[i-24]!);if(k24!=null)rs.push(a.s.c[k]!/a.s.c[k24]!-1);
      if(a.s.t[k-48]===btc.t[i-48]){const x:number[]=[],y:number[]=[];for(let j=1;j<=48;j++){x.push(a.s.c[k-48+j]!/a.s.c[k-49+j]!-1);y.push(c[i-48+j]!/c[i-49+j]!-1);}const r=corr(x,y);if(Number.isFinite(r))cs.push(r);}}
    rs.sort((x,y)=>x-y);const md=rs.length>=5?rs[rs.length>>1]!-r24:NaN;b.push(!Number.isFinite(md)?-1:md>.01?0:md<-.01?2:1);
    const mc=cs.length>=5?cs.reduce((x,y)=>x+y,0)/cs.length:NaN;b.push(!Number.isFinite(mc)?-1:mc>.6?0:mc<.35?2:1);
    let eb:number|-1=-1;if(ee){const k=ee.at.get(t);if(k!=null&&Number.isFinite(ee.w[k]!))eb=dir((ee.f[k]!-ee.w[k]!)/eth!.c[k]!,.002);}b.push(eb);
    const he=Math.floor(((t+H)%86_400)/H);b.push(SESS.indexOf(sessOfHour(he%24) as typeof SESS[number]));
    at.set(t+H,rows.length);rows.push({t:t+H,b});}
  return {rows,at};
}
/** inputs: one-hot BTC/ETH state, in-good, in-bad, log elapsed, the hazard estimate's logit (so the model learns corrections to it), bias */
export function encode(row:FeatRow,lab:Lab,elapsed:number,out=new Float64Array(DIM),pHaz=.5){out.fill(0);
  row.b.forEach((v,f)=>{if(v>=0)out[OFF[f]!+v]=1;});out[D_]=lab===1?1:0;out[D_+1]=lab===-1?1:0;out[D_+2]=Math.log1p(elapsed)/5;
  const q=clamp(pHaz,.02,.98);out[D_+3]=Math.log(q/(1-q))/2;out[D_+4]=1;return out;}
// ------------------------------------------------------------------ tiny online logistic model
export class OnlineLogit{
  w:Float64Array;n=0;hits=0;brier=0;brierBase=0;yMean=.5;lr:number;l2:number;
  constructor(dim=DIM,lr:number=PRED.lr,l2:number=PRED.l2,prior?:{i:number;w:number}){this.w=new Float64Array(dim);this.lr=lr;this.l2=l2;if(prior)this.w[prior.i]=prior.w;this.w0=prior??null;}
  w0:{i:number;w:number}|null;
  predict(x:Float64Array){let z=0;for(let i=0;i<x.length;i++)z+=this.w[i]!*x[i]!;return 1/(1+Math.exp(-Math.max(-30,Math.min(30,z))));}
  /** one SGD step on a sample whose answer is now known; p = the prediction that was made for it back then (prequential score:
   *  the forecast is scored only after its horizon passed, so nothing it is scored on was learned before it was made) */
  learn(x:Float64Array,y:0|1,p=this.predict(x)){if((p>=.5?1:0)===y)this.hits++;this.brier+=(p-y)**2;this.brierBase+=(this.yMean-y)**2;this.n++;this.yMean+=(y-this.yMean)/Math.min(this.n+1,200);
    const q=this.predict(x),g=q-y,lr=this.lr/Math.sqrt(1+this.n/500);for(let i=0;i<x.length;i++){const c=this.w0&&this.w0.i===i?this.w0.w:0;this.w[i]=this.w[i]!-lr*(g*x[i]!+this.l2*(this.w[i]!-c));}return p;}
  /** immediate-feedback variant (tests / online use when the answer arrives at once) */
  update(x:Float64Array,y:0|1){return this.learn(x,y);}
  /** Brier skill vs the running base rate (> 0 = better than always guessing the base rate) */
  get skill(){return this.n&&this.brierBase>0?1-this.brier/this.brierBase:0;}
}
// ------------------------------------------------------------------ 3) forecast
export type CondStat={bin:number;n:number;good:number;p:number;onsets:number;exposure:number;rate:number;lift:number};
export type Trigger={kind:"btc"|"time"|"none";text:string;lift?:number;hours?:number};
export type PbForecast={pb:string;t:number;cur:"GOOD"|"BAD"|null;elapsedH:number;p:Record<"6"|"24"|"72",number>;pHaz:Record<"6"|"24"|"72",number>;pLog:Record<"6"|"24"|"72",number>|null;
  wLog:number;trigger:Trigger;sample:number;label:"数据少"|"数据一般"|"数据较足";phases:{good:number;bad:number;meanGoodH:number;meanBadH:number;last:PhaseRec[]};
  trades:number;period:{lag:number;acf:number}|null;profile:Profile["best"];hist:{n:number;hit:number;brier:number;skill:number;hazBrier:number};base:number;cond:Record<string,CondStat[]>};
export type PredictorInput={pb:string;trades:readonly TradeLite[];feats:FeatTable;nowSec:number;pool:{GOOD:Hazard;BAD:Hazard}};
/** the phases of one playbook (cheap; used first for the pooled hazard) */
export function phaseInfo(trades:readonly TradeLite[],nowSec:number){const L=labelLine(trades,nowSec);return {L,phases:L?phasesOfLine(L,trades):[]};}
export function predictPlaybook(x:PredictorInput,pre?:{L:Line|null;phases:PhaseRec[]}):PbForecast{
  const {L,phases}=pre??phaseInfo(x.trades,x.nowSec),t=Math.floor(x.nowSec/H)*H;
  const good=phases.filter(p=>p.label==="GOOD"),bad=phases.filter(p=>p.label==="BAD"),sample=sampleOf(good.length,bad.length,x.trades.length);
  const mean=(ps:PhaseRec[])=>ps.length?ps.reduce((a,p)=>a+p.hours,0)/ps.length:0;
  const curP=phases.at(-1)?.open?phases.at(-1)!:null,cur=curP?.label??null,el=curP?.hours??0;
  const rG=hazardRates(hazardCounts(phases,"GOOD"),x.pool.GOOD),rB=hazardRates(hazardCounts(phases,"BAD"),x.pool.BAD);
  let base=.5;if(L){let g=0,k=0;for(let i=0;i<L.n;i++)if(L.lab[i]){k++;if(L.lab[i]===1)g++;}base=(g+24)/(k+48);}
  const pHaz={} as PbForecast["pHaz"];
  for(const h of PRED.horizons){const k=String(h) as "6";pHaz[k]=cur==="GOOD"?survive(rG,el,h):cur==="BAD"?1-survive(rB,el,h):base;}
  // conditional frequencies per feature bin + the logistic models, one pass over the line
  const cond:Record<string,CondStat[]>={};let pLog:PbForecast["pLog"]=null,wLog=0;const hist={n:0,hit:0,brier:0,skill:0,hazBrier:0};
  if(L){const FN=FEATS.length,pres=FEATS.map(f=>f.bins.map(()=>[0,0])),ons=FEATS.map(f=>f.bins.map(()=>[0,0]));let O=0,E=0;
    const models=PRED.horizons.map(()=>new OnlineLogit(DIM,PRED.lr,PRED.l2,{i:HAZ_IN,w:2})),RING=80,ring=PRED.horizons.map(()=>new Array<{i:number;x:Float64Array;p:number;ph:number}|undefined>(RING));let hzB=0;
    for(let i=0;i<L.n;i++){const e=L.t0+i*H,ri=x.feats.at.get(e);if(ri==null)continue;const row=x.feats.rows[ri]!,l=L.lab[i] as Lab;
      if(l!==0)for(let f=0;f<FN;f++){const v=row.b[f]!;if(v<0)continue;pres[f]![v]![1]++;if(l===1)pres[f]![v]![0]++;}
      if(l===-1&&i+1<L.n){E++;const on=L.lab[i+1]===1?1:0;O+=on;for(let f=0;f<FN;f++){const v=row.b[f]!;if(v<0)continue;ons[f]![v]![1]++;ons[f]![v]![0]+=on;}}
      // delayed learning: the sample made h hours ago gets its answer now (label at this hour)
      PRED.horizons.forEach((h,m)=>{const j=i-h;if(j<0||L.lab[i]===0)return;const q=ring[m]![j%RING];if(!q||q.i!==j)return;const y=L.lab[i]===1?1:0;
        models[m]!.learn(q.x,y,q.p);if(m===1)hzB+=(q.ph-y)**2;});
      const slot=i%RING;
      PRED.horizons.forEach((h,m)=>{const ph=l===1?survive(rG,L.elapsed[i]!,h):l===-1?1-survive(rB,L.elapsed[i]!,h):base,xi=encode(row,l,L.elapsed[i]!,new Float64Array(DIM),ph);
        ring[m]![slot]={i,x:xi,p:models[m]!.predict(xi),ph};});}
    const r0=E?(O+1)/(E+48):.02;
    FEATS.forEach((f,fi)=>{cond[f.k]=f.bins.map((_,v)=>{const [g,n]=pres[fi]![v]!,[o,ex]=ons[fi]![v]!,p=(g+PRED.condPriorH*base)/(n+PRED.condPriorH),rate=(o+PRED.onsetPriorH*r0)/(ex+PRED.onsetPriorH);
      return {bin:v,n,good:g,p,onsets:o,exposure:ex,rate,lift:rate/r0};});});
    const m0=models[1]!;hist.n=m0.n;hist.hit=m0.n?m0.hits/m0.n:0;hist.brier=m0.n?m0.brier/m0.n:0;hist.skill=m0.skill;
    const last=x.feats.rows.at(-1);
    if(last&&x.nowSec-last.t<=3*H&&m0.n>=50){pLog={} as NonNullable<typeof pLog>;
      PRED.horizons.forEach((h,m)=>{const k=String(h) as "6";pLog![k]=models[m]!.predict(encode(last,cur==="GOOD"?1:cur==="BAD"?-1:0,el,undefined,pHaz[k]));});
      // blend weight: only as much as the model earned against the hazard estimate on the same past hours
      const lb=m0.brier/m0.n,hb=hzB/m0.n;wLog=m0.skill<=0?0:lb<hb?Math.min(.6,m0.n/(m0.n+1500))*Math.min(1,(hb-lb)/(.1*hb)):.1*Math.min(1,m0.n/1500);}
    hist.hazBrier=m0.n?hzB/m0.n:0;}
  const p={} as PbForecast["p"];for(const h of PRED.horizons){const k=String(h) as "6";p[k]=clamp((1-wLog)*pHaz[k]+wLog*(pLog?.[k]??pHaz[k]),.02,.98);}
  const trigger=triggerOf(cur,el,cond,x.feats,x.nowSec,cur==="BAD"?rB:rG);
  return {pb:x.pb,t,cur,elapsedH:el,p,pHaz,pLog,wLog,trigger,sample,label:sampleLabel(sample),
    phases:{good:good.length,bad:bad.length,meanGoodH:mean(good),meanBadH:mean(bad),last:phases.slice(-6)},trades:x.trades.length,
    period:periodicity(x.trades),profile:profileOf(x.trades).best,hist,base,cond};
}
/** the most likely trigger: a BTC/ETH state the playbook's good phases tend to start in (bad now) or end in (good now — the onset
 * table of the opposite switch is not kept, so the bins where it is least often good), that is not the current state; else time */
function triggerOf(cur:"GOOD"|"BAD"|null,el:number,cond:Record<string,CondStat[]>,feats:FeatTable,nowSec:number,rates:number[]):Trigger{
  const last=feats.rows.at(-1),fresh=last&&nowSec-last.t<=3*H?last:null;
  if(cur==="BAD"){const cs:{text:string;lift:number}[]=[];
    FEATS.forEach((f,fi)=>{const now=fresh?.b[fi]??-1;let best:CondStat|null=null;// one bin per feature: the state change with the biggest lift
      for(const c of cond[f.k]??[]){if(c.bin===now||c.onsets<PRED.triggerMinOnsets||c.lift<PRED.triggerLift||f.k==="sess")continue;if(!best||c.lift>best.lift)best=c;}
      if(best)cs.push({text:(f.text as Record<string,string>)[f.bins[best.bin]!]!,lift:best.lift});});
    cs.sort((a,b)=>b.lift-a.lift);
    if(cs.length)return {kind:"btc",text:cs.slice(0,2).map(c=>c.text).join("、"),lift:cs[0]!.lift};
    const w=medianWait(rates,el);return w!=null?{kind:"time",text:`约 ${fmtH(w)}后`,hours:w}:{kind:"none",text:"还看不出什么时候"};}
  if(cur==="GOOD"){const cs:{text:string;p:number}[]=[];
    FEATS.forEach((f,fi)=>{const now=fresh?.b[fi]??-1;for(const c of cond[f.k]??[]){if(c.bin===now||c.n<24||f.k==="sess")continue;cs.push({text:(f.text as Record<string,string>)[f.bins[c.bin]!]!,p:c.p});}});
    cs.sort((a,b)=>a.p-b.p);const w=medianWait(rates,el);
    if(cs.length&&cs[0]!.p<.4)return {kind:"btc",text:cs[0]!.text,hours:w??undefined};
    return w!=null?{kind:"time",text:`约 ${fmtH(w)}后`,hours:w}:{kind:"none",text:"还看不出什么时候"};}
  return {kind:"none",text:"还看不出"};
}
export const fmtH=(h:number)=>h>=48?`${Math.round(h/24)} 天`:`${Math.round(h)} 小时`;
// ------------------------------------------------------------------ 4) forecast log, scoring, track record
/** one row per hour: every playbook's P(good) at +6 / +24 / +72 h and, once scored, the outcomes (1 good, 0 not, −1 unknown) */
export type FcRow={t:number;f:Record<string,[number,number,number]>;y:Record<string,[number|null,number|null,number|null]>};
export type Track={n:number;hits:number;brier:number;bins:[number,number,number][]};// bins: [count, Σy, Σp] per 0.1 of p
export const emptyTrack=():Track=>({n:0,hits:0,brier:0,bins:Array.from({length:10},()=>[0,0,0] as [number,number,number])});
export function addScore(tr:Track,p:number,y:0|1){tr.n++;if((p>=.5?1:0)===y)tr.hits++;tr.brier+=(p-y)**2;const b=tr.bins[Math.min(9,Math.floor(p*10))]!;b[0]++;b[1]+=y;b[2]+=p;}
/** score every due forecast in the rows (label at t + h known from the line); returns the rows that changed */
export function scoreRows(rows:FcRow[],labelAt:(pb:string,tSec:number)=>Lab|null,nowSec:number,track:Record<string,Track>,
  onScore?:(x:{t:number;pb:string;h:number;p:number;y:0|1})=>void):FcRow[]{
  const changed:FcRow[]=[];
  for(const r of rows){let ch=false;
    for(const [pb,ps] of Object.entries(r.f)){const ys=(r.y[pb]??=[null,null,null]);
      PRED.horizons.forEach((h,m)=>{if(ys[m]!=null)return;const at=r.t+h*H;if(at+H>nowSec)return;const l=labelAt(pb,at);
        if(l==null||l===0){if(nowSec-at>3*86_400){ys[m]=-1;ch=true;}return;}// never known (no trades) → dropped after 3 days
        const y=l===1?1:0;ys[m]=y;addScore(track[pb]??=emptyTrack(),ps[m]!,y);onScore?.({t:r.t,pb,h,p:ps[m]!,y});ch=true;});}
    if(ch)changed.push(r);}
  return changed;
}
export const trackView=(t:Track|undefined)=>t&&t.n?{n:t.n,hit:t.hits/t.n,brier:t.brier/t.n,calib:t.bins.map(b=>b[0]?{n:b[0],p:b[2]/b[0],y:b[1]/b[0]}:null)}:{n:0,hit:0,brier:0,calib:[]};
// ------------------------------------------------------------------ 6) dashboard text
export function forecastLine(f:PbForecast,track:Track|undefined):string{
  const el=f.elapsedH?fmtH(f.elapsedH):"",p24=Math.round(f.p["24"]*100),tag=`【${f.label}】`;
  const tv=trackView(track),tr=tv.n?`预测命中率 ${Math.round(tv.hit*100)}%（${tv.n} 次）`:`预测还没到期评分${f.hist.n>=50?`（历史回放命中率 ${Math.round(f.hist.hit*100)}%）`:""}`;
  if(f.cur==="BAD"){const when=f.trigger.kind==="btc"?`${f.trigger.text}时开始赚钱`:f.trigger.kind==="time"?`${f.trigger.text}开始赚钱（按以往亏钱期长度）`:"什么时候转好还看不出";
    return `现在：亏钱期（已 ${el}）。预计：${when}，24 小时内概率 ${p24}%${tag}。${tr}`;}
  if(f.cur==="GOOD"){const end=f.trigger.kind==="btc"?`；${f.trigger.text}时可能结束`:f.trigger.kind==="time"?`；${f.trigger.text}可能结束`:"";
    return `现在：赚钱期（已 ${el}）。预计：24 小时后仍在赚钱期的概率 ${p24}%${end}${tag}。${tr}`;}
  return `现在：还看不出（影子交易 ${f.trades} 笔）。24 小时后处在赚钱期的概率 ${p24}%${tag}。${tr}`;
}
