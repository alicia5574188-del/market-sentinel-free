/**
 * dynamic-v1 cycle analyzer (pure). Per playbook (each playbook has one side):
 *  - rolling 2 / 4 / 8-week net % (sum over trades closed in the window) and net % per trade, now;
 *  - weekly phase line: each week-end, the rolling 4-week net % → GOOD (> +0.5%) / BAD (< −0.5%) / keeps the previous phase
 *    in between (hysteresis), needing ≥ 3 trades in the window to count; phases = runs of the same label;
 *  - persistence: P(the next 4 weeks' label = this 4 weeks' label) — > 0.5 means good/bad stretches last;
 *  - conditional performance: trades split by the BTC/ETH state bucket at entry (and by ALT/BTC lead).
 * A pattern is declared only after ≥ 3 GOOD and ≥ 3 BAD phases and ≥ 40 trades.
 */
import {stateAt,type DayState} from "./state.ts";
export const CYCLE={weeks:[2,4,8] as const,phaseWeeks:4,goodAbove:.005,badBelow:-.005,minWindowTrades:3,minPhases:3,minTrades:40,
  bucketMinTrades:20,bucketMinMean:.002,bucketMinT:1.5,persistMin:.6} as const;
const WEEK=7*86_400;
export type TradeLite={pb:string;sym:string;et:number;xt:number;net:number};
export type Stat={n:number;sum:number;mean:number;win:number;t:number};
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
  byBucket:Record<string,Stat>;byLead:Record<string,Stat>};
/** trades must be of one playbook */
export function analyzePlaybook(pb:string,trades:readonly TradeLite[],states:readonly DayState[],nowSec:number):PlaybookCycle{
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
