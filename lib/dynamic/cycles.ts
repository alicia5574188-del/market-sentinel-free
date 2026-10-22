/**
 * dynamic-v1 cycle analyzer (pure). Per playbook (each playbook has one side):
 *  - rolling 2 / 4 / 8-week net % (sum over trades closed in the window) and net % per trade, now;
 *  - weekly phase line: each week-end, the rolling 4-week net % → GOOD (> +0.5%) / BAD (< −0.5%) / keeps the previous phase
 *    in between (hysteresis), needing ≥ 3 trades in the window to count; phases = runs of the same label;
 *  - persistence: P(the next 4 weeks' label = this 4 weeks' label) — > 0.5 means good/bad stretches last;
 *  - conditional performance: trades split by the BTC/ETH state bucket at entry (and by ALT/BTC lead).
 * A pattern is declared only after ≥ 3 GOOD and ≥ 3 BAD phases and ≥ 40 trades.
 * Short-term playbooks (tier "short") cycle faster: the phase line steps daily on a rolling 7-day window (persistence at lag 7
 * days, non-overlapping), rolling 1 / 2 / 4 weeks and the last 50 / 100 / 200 trades are reported, and the conditional split
 * uses the intraday BTC state (1h trend × volatility) and the UTC session. Significance is clustered by day (trades of one day
 * are not independent): t_day = mean of daily sums / their standard error.
 */
import {stateAt,intraAt,sessionOf,type DayState,type IntraState} from "./state.ts";
export const CYCLE={weeks:[2,4,8] as const,phaseWeeks:4,goodAbove:.005,badBelow:-.005,minWindowTrades:3,minPhases:3,minTrades:40,
  bucketMinTrades:20,bucketMinMean:.002,bucketMinT:1.5,persistMin:.6} as const;
const WEEK=7*86_400;
export type TradeLite={pb:string;sym:string;et:number;xt:number;net:number};
export type Stat={n:number;sum:number;mean:number;win:number;t:number;days?:number;tDay?:number};
export const SHORT_CYCLE={stepSec:86_400,windowSec:7*86_400,rolling:[["1w",7],["2w",14],["4w",28]] as [string,number][],counts:[50,100,200],
  goodAbove:.005,badBelow:-.005,minWindowTrades:5} as const;
/** stat plus day clustering: et grouped by UTC day, t_day over daily sums */
export function statDay(ts:readonly {et:number;net:number}[]):Stat{
  const s=stat(ts.map(t=>t.net)),by=new Map<number,number>();for(const t of ts){const d=Math.floor(t.et/86_400);by.set(d,(by.get(d)??0)+t.net);}
  const ds=[...by.values()],n=ds.length;if(n<2)return {...s,days:n,tDay:0};
  const m=ds.reduce((a,b)=>a+b,0)/n;let v=0;for(const x of ds)v+=(x-m)**2;const sd=Math.sqrt(v/(n-1));
  return {...s,days:n,tDay:sd>0?m/(sd/Math.sqrt(n)):0};
}
export function stat(xs:readonly number[]):Stat{
  const n=xs.length;if(!n)return {n:0,sum:0,mean:0,win:0,t:0};
  let s=0,w=0;for(const x of xs){s+=x;if(x>0)w++;}const m=s/n;let v=0;for(const x of xs)v+=(x-m)**2;
  const sd=n>1?Math.sqrt(v/(n-1)):0;return {n,sum:s,mean:m,win:w/n,t:sd>0?m/(sd/Math.sqrt(n)):0};
}
export type Phase={label:"GOOD"|"BAD";from:number;to:number;weeks:number;net:number};
export type PlaybookCycle={pb:string;trades:number;first:number|null;last:number|null;all:Stat;
  rolling:Record<string,{net:number;n:number;perTrade:number}>;
  phases:Phase[];good:number;bad:number;meanGoodWeeks:number;meanBadWeeks:number;persistence:number|null;
  current:{label:"GOOD"|"BAD"|null;weeks:number;since:number|null};pattern:boolean;patternWhy:string;
  byBucket:Record<string,Stat>;byLead:Record<string,Stat>;
  /** short tier: phases step in days (else weeks); bySession; last-N-trades windows */
  unit?:"day"|"week";bySession?:Record<string,Stat>;counts?:Record<string,{net:number;n:number;perTrade:number}>;
  /** none → early (≥ 1 good and ≥ 1 bad phase, ≥ 15 trades: forecasts and small allocations) → confirmed (the full rule) */
  stage?:"none"|"early"|"confirmed";
  /** how much evidence there is, 0–1 (min(good, bad) / 3 × trades / 40, capped): scales forecast confidence and size */
  sample?:number;forecast?:Forecast|null};
/** next window's phase: P(current phase continues), shrunk towards 50/50 by the sample */
export type Forecast={next:"GOOD"|"BAD";prob:number;raw:number;sample:number;label:"数据少"|"数据一般"|"数据较足";why:string};
export const EARLY={minPhases:1,minTrades:15} as const;
export const sampleOf=(good:number,bad:number,trades:number)=>Math.max(0,Math.min(1,Math.min(good,bad)/CYCLE.minPhases)*Math.min(1,trades/CYCLE.minTrades));
export const sampleLabel=(x:number):Forecast["label"]=>x<1/3?"数据少":x<.75?"数据一般":"数据较足";
function withForecast(c:PlaybookCycle):PlaybookCycle{
  const sample=sampleOf(c.good,c.bad,c.trades);
  const stage=c.pattern?"confirmed":c.good>=EARLY.minPhases&&c.bad>=EARLY.minPhases&&c.trades>=EARLY.minTrades?"early":"none";
  const cur=c.current.label;let forecast:Forecast|null=null;
  if(cur){const L=cur==="GOOD"?c.meanGoodWeeks:c.meanBadWeeks,u=c.unit==="day"?"天":"周";
    const raw=c.persistence!=null?c.persistence:L>1?Math.min(.95,1-1/L):.5,p=.5+(raw-.5)*sample;
    const next=p>=.5?cur:cur==="GOOD"?"BAD":"GOOD",prob=Math.max(p,1-p);
    forecast={next,prob,raw,sample,label:sampleLabel(sample),
      why:`现在${cur==="GOOD"?"赚钱段":"亏钱段"}第 ${c.current.weeks} ${u}；${c.persistence!=null?`好坏段延续概率 ${Math.round(raw*100)}%`:L>0?`这种段平均 ${L.toFixed(1)} ${u}`:"只见过这一段"}；证据 ${Math.round(sample*100)}%（${c.good} 段赚 / ${c.bad} 段亏 / ${c.trades} 笔）`};}
  return {...c,stage,sample,forecast};
}
/** trades must be of one playbook */
export function analyzePlaybook(pb:string,trades:readonly TradeLite[],states:readonly DayState[],nowSec:number,opts:{tier?:"short"|"long";intra?:readonly IntraState[]}={}):PlaybookCycle{
  if(opts.tier==="short")return withForecast(analyzeShort(pb,trades,opts.intra??[],nowSec));
  return withForecast(analyzeLong(pb,trades,states,nowSec));
}
function analyzeLong(pb:string,trades:readonly TradeLite[],states:readonly DayState[],nowSec:number):PlaybookCycle{
  const ts=[...trades].sort((a,b)=>a.xt-b.xt),all=stat(ts.map(t=>t.net));
  const rolling:PlaybookCycle["rolling"]={};
  for(const w of CYCLE.weeks){const xs=ts.filter(t=>t.xt>nowSec-w*WEEK&&t.xt<=nowSec).map(t=>t.net),s=xs.reduce((a,b)=>a+b,0);
    rolling[`${w}w`]={net:s,n:xs.length,perTrade:xs.length?s/xs.length:0};}
  // weekly labels
  const labels:{t:number;label:"GOOD"|"BAD"|null;net:number}[]=[];
  if(ts.length){const start=Math.floor(ts[0]!.xt/WEEK)*WEEK+CYCLE.phaseWeeks*WEEK;let prev:"GOOD"|"BAD"|null=null,lo=0,hi=0,sum=0;
    for(let e=start;e<=nowSec;e+=WEEK){
      while(hi<ts.length&&ts[hi]!.xt<=e){sum+=ts[hi]!.net;hi++;}
      while(lo<hi&&ts[lo]!.xt<=e-CYCLE.phaseWeeks*WEEK){sum-=ts[lo]!.net;lo++;}
      const cnt=hi-lo;let lab:"GOOD"|"BAD"|null=prev;
      if(cnt>=CYCLE.minWindowTrades){if(sum>CYCLE.goodAbove)lab="GOOD";else if(sum<CYCLE.badBelow)lab="BAD";}
      labels.push({t:e,label:lab,net:sum});prev=lab;}}
  const phases:Phase[]=[];
  for(const l of labels){if(!l.label)continue;const last=phases.at(-1);
    if(last&&last.label===l.label){last.to=l.t;last.weeks++;last.net=l.net;}else phases.push({label:l.label,from:l.t,to:l.t,weeks:1,net:l.net});}
  // persistence on non-overlapping windows: this 4-week label vs the next 4 weeks' label (overlapping windows would agree by construction)
  let same=0,pairs=0;const L=CYCLE.phaseWeeks;for(let i=L;i<labels.length;i++){const a=labels[i-L]!.label,b=labels[i]!.label;if(a&&b){pairs++;if(a===b)same++;}}
  const good=phases.filter(p=>p.label==="GOOD"),bad=phases.filter(p=>p.label==="BAD");
  const mean=(xs:Phase[])=>xs.length?xs.reduce((a,p)=>a+p.weeks,0)/xs.length:0;
  const cur=phases.at(-1),persistence=pairs>=10?same/pairs:null;
  const pattern=good.length>=CYCLE.minPhases&&bad.length>=CYCLE.minPhases&&ts.length>=CYCLE.minTrades;
  const patternWhy=pattern?`${good.length} 段赚钱 / ${bad.length} 段亏钱，共 ${ts.length} 笔`:
    `还不够：${good.length}/${CYCLE.minPhases} 段赚钱，${bad.length}/${CYCLE.minPhases} 段亏钱，${ts.length}/${CYCLE.minTrades} 笔`;
  const byBucket:Record<string,number[]>={},byLead:Record<string,number[]>={};
  for(const t of ts){const s=stateAt(states,t.et);if(!s)continue;(byBucket[s.bucket]??=[]).push(t.net);if(s.lead)(byLead[s.lead]??=[]).push(t.net);}
  const st=(m:Record<string,number[]>)=>Object.fromEntries(Object.entries(m).map(([k,v])=>[k,stat(v)]));
  return {pb,trades:ts.length,first:ts[0]?.et??null,last:ts.at(-1)?.xt??null,all,rolling,phases:phases.slice(-24),good:good.length,bad:bad.length,
    meanGoodWeeks:mean(good),meanBadWeeks:mean(bad),persistence,
    current:{label:cur?.label??null,weeks:cur?.weeks??0,since:cur?.from??null},pattern,patternWhy,byBucket:st(byBucket),byLead:st(byLead)};
}
export function phaseChanges(prev:Record<string,PlaybookCycle>|null,next:Record<string,PlaybookCycle>){
  const out:{pb:string;from:string|null;to:string|null;pattern:boolean}[]=[];
  for(const [pb,c] of Object.entries(next)){const p=prev?.[pb];if(!p||p.current.label!==c.current.label||p.pattern!==c.pattern)out.push({pb,from:p?.current.label??null,to:c.current.label,pattern:c.pattern});}
  return out;
}

/** shared: phases from a label line; persistence at lag L steps */
function phasesOf(labels:{t:number;label:"GOOD"|"BAD"|null;net:number}[],lag:number){
  const phases:Phase[]=[];
  for(const l of labels){if(!l.label)continue;const last=phases.at(-1);
    if(last&&last.label===l.label){last.to=l.t;last.weeks++;last.net=l.net;}else phases.push({label:l.label,from:l.t,to:l.t,weeks:1,net:l.net});}
  let same=0,pairs=0;for(let i=lag;i<labels.length;i+=1){const a=labels[i-lag]!.label,b=labels[i]!.label;if(a&&b){pairs++;if(a===b)same++;}}
  // pairs overlap by step but the two windows compared never do (lag = window); count only every lag-th pair as independent evidence
  return {phases,persistence:pairs>=20?same/pairs:null};
}
function analyzeShort(pb:string,trades:readonly TradeLite[],intra:readonly IntraState[],nowSec:number):PlaybookCycle{
  const C=SHORT_CYCLE,ts=[...trades].sort((a,b)=>a.xt-b.xt),all=statDay(ts);
  const win=(xs:readonly TradeLite[])=>{const s=xs.reduce((a,t)=>a+t.net,0);return {net:s,n:xs.length,perTrade:xs.length?s/xs.length:0};};
  const rolling:PlaybookCycle["rolling"]={};for(const [k,d] of C.rolling)rolling[k]=win(ts.filter(t=>t.xt>nowSec-d*86_400&&t.xt<=nowSec));
  const counts:NonNullable<PlaybookCycle["counts"]>={};for(const n of C.counts)if(ts.length>=n)counts[`${n}`]=win(ts.slice(-n));
  const labels:{t:number;label:"GOOD"|"BAD"|null;net:number}[]=[];
  if(ts.length){const start=Math.floor(ts[0]!.xt/C.stepSec)*C.stepSec+C.windowSec;let prev:"GOOD"|"BAD"|null=null,lo=0,hi=0,sum=0;
    for(let e=start;e<=nowSec;e+=C.stepSec){
      while(hi<ts.length&&ts[hi]!.xt<=e){sum+=ts[hi]!.net;hi++;}
      while(lo<hi&&ts[lo]!.xt<=e-C.windowSec){sum-=ts[lo]!.net;lo++;}
      let lab:"GOOD"|"BAD"|null=prev;if(hi-lo>=C.minWindowTrades){if(sum>C.goodAbove)lab="GOOD";else if(sum<C.badBelow)lab="BAD";}
      labels.push({t:e,label:lab,net:sum});prev=lab;}}
  const {phases,persistence}=phasesOf(labels,Math.round(C.windowSec/C.stepSec));
  const good=phases.filter(p=>p.label==="GOOD"),bad=phases.filter(p=>p.label==="BAD");
  const mean=(xs:Phase[])=>xs.length?xs.reduce((a,p)=>a+p.weeks,0)/xs.length:0;const cur=phases.at(-1);
  const pattern=good.length>=CYCLE.minPhases&&bad.length>=CYCLE.minPhases&&ts.length>=CYCLE.minTrades;
  const patternWhy=pattern?`${good.length} 段赚钱 / ${bad.length} 段亏钱，共 ${ts.length} 笔（${all.days} 天）`:
    `还不够：${good.length}/${CYCLE.minPhases} 段赚钱，${bad.length}/${CYCLE.minPhases} 段亏钱，${ts.length}/${CYCLE.minTrades} 笔`;
  const byB:Record<string,TradeLite[]>={},byS:Record<string,TradeLite[]>={};
  for(const t of ts){(byS[sessionOf(t.et)]??=[]).push(t);const s=intraAt(intra,t.et);if(s)(byB[s.bucket]??=[]).push(t);}
  const st=(m:Record<string,TradeLite[]>)=>Object.fromEntries(Object.entries(m).map(([k,v])=>[k,statDay(v)]));
  return {pb,trades:ts.length,first:ts[0]?.et??null,last:ts.at(-1)?.xt??null,all,rolling,phases:phases.slice(-24),good:good.length,bad:bad.length,
    meanGoodWeeks:mean(good),meanBadWeeks:mean(bad),persistence,current:{label:cur?.label??null,weeks:cur?.weeks??0,since:cur?.from??null},
    pattern,patternWhy,byBucket:st(byB),byLead:{},unit:"day",bySession:st(byS),counts};
}
