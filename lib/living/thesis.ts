/**
 * C2 step 2 — the market judgement. Basket direction/structure/crowding plus step 1's rewards → one thesis object with
 * the playbooks it allows, a one-line sentence, a validity and its invalidation. Debounced: changes only after the same
 * candidate on 2 consecutive 5m closes, except when the fast lane fires. Self-check: each thesis predicts the next 4h;
 * a kind whose 7-day hit rate is not above its base rate gets half weight (and then fails layer 2).
 */
import {STEPS} from "./config.ts";
import type {MidBar} from "./tape.ts";
import {type ProbeId,type ProbeScore,efficiency,PROBE_META} from "./probes.ts";
import {median,mean,quantile,r6,r4,pct} from "./util.ts";

export type Structure="TREND"|"RANGE"|"CHOP"|"BURST";
export type Playbook="trend-pullback"|"breakout"|"range-revert"|"extension-fade"|"crowding-fade"|"leaders"|"laggards"|"btc-lead"|"momentum"|IntentPlaybook;
/** v2 playbooks chosen by the intent layer (intent.ts); the v1 ones above stay as computed/logged context. */
export type IntentPlaybook="follow"|"squeeze-fade"|"flush-rebound"|"crowd-fade"|"crowd-break"|"absorb-revert";
export const PLAYBOOK_PROBE:Record<Playbook,ProbeId>={"trend-pullback":"P5",breakout:"P1","range-revert":"P2","extension-fade":"P6",
  "crowding-fade":"P7",leaders:"P3",laggards:"P4","btc-lead":"P9",momentum:"MOM",
  follow:"P5","squeeze-fade":"P6","flush-rebound":"P6","crowd-fade":"P7","crowd-break":"P1","absorb-revert":"P2"};
export const PLAYBOOK_LABEL:Record<Playbook,string>={"trend-pullback":"趋势回调","breakout":"突破延续","range-revert":"区间回归",
  "extension-fade":"过度延伸反转","crowding-fade":"拥挤反转",leaders:"领涨延续",laggards:"落后补涨","btc-lead":"BTC 带动",momentum:"动量",
  follow:"顺着真资金（回调跟进）","squeeze-fade":"逼空衰竭反做","flush-rebound":"恐慌出尽抄反弹","crowd-fade":"贪婪拥挤失败反做",
  "crowd-break":"安逸拥挤破位反做","absorb-revert":"区间边缘被吸收回归"};
export type Side="LONG"|"SHORT";
export type ThesisInputs={b1h:number;b4h:number;b24h:number;breadth:number;volPct:number|null;dispersion:number;btcEff:number;ethEff:number;
  funding:number|null;oi1h:number|null;members:number};
export type Thesis={id:string;at:number;since:number;side:Side|null;strength:number;structure:Structure;crowded:Side|null;
  playbooks:{pb:Playbook;probe:ProbeId;score:number;t:number;n:number;persistence:ProbeScore["persistence"]}[];
  sentence:string;validUntil:number;invalidation:{basketLevel:number|null;probes:ProbeId[]};inputs:ThesisInputs;
  dirTag:"U"|"D"|"F";weightHalved:boolean;kind:string};
type Prediction={at:number;kind:string;until:number;start:number;hi:number;lo:number;outcome:boolean|null};
export type ThesisState={v:1;current:Thesis|null;pending:{key:string;bars:number}|null;history:Omit<Thesis,"inputs">[];
  predictions:Prediction[];baseline:Prediction[];index:[number,number][];volHist:[number,number][];lastBarAt:number};
export function initialThesis():ThesisState{return{v:1,current:null,pending:null,history:[],predictions:[],baseline:[],index:[],volHist:[],lastBarAt:0};}
export function normalizeThesis(raw:unknown):ThesisState{const v=raw as ThesisState|undefined;return v?.v===1&&Array.isArray(v.history)?{...initialThesis(),...v}:initialThesis();}

const ret=(r:MidBar[],n:number)=>r.length>n?r.at(-1)!.close/r[r.length-1-n]!.close-1:NaN;
export function thesisInputs(members:string[],bars:(s:string)=>MidBar[],change24h:Record<string,number>,funding:Record<string,number>,
  oi1h:Record<string,number|null>,state:ThesisState):ThesisInputs{
  const r1:number[]=[],r4s:number[]=[],above:number[]=[],c24:number[]=[],fs:number[]=[],ois:number[]=[];
  for(const s of members){
    const r=bars(s);
    if(r.length>12)r1.push(ret(r,12));
    if(r.length>48){r4s.push(ret(r,48));const m=mean(r.slice(-48).map(x=>x.close));above.push(r.at(-1)!.close>m?1:0);}
    if(Number.isFinite(change24h[s]))c24.push(change24h[s]!);
    if(Number.isFinite(funding[s]))fs.push(funding[s]!);
    const o=oi1h[s];if(o!=null&&Number.isFinite(o))ois.push(o);
  }
  const b1h=r1.length>=10?median(r1):0,b4h=r4s.length>=10?median(r4s):b1h;
  const disp=r1.length>=10?Math.sqrt(mean(r1.map(x=>(x-b1h)**2))):0;
  const vols=state.volHist.map(x=>x[1]),idx=state.index.slice(-13),rs:number[]=[];
  for(let i=1;i<idx.length;i++)rs.push(idx[i]![1]/idx[i-1]![1]-1);
  const vol=rs.length>=6?Math.sqrt(mean(rs.map(x=>x*x))):NaN;
  const volPct=Number.isFinite(vol)&&vols.length>=24?vols.filter(v=>v<=vol).length/vols.length:null;
  const eff=(s:string)=>{const r=bars(s);return r.length>=48?efficiency(r.slice(-48)):0;};
  return {b1h:r6(b1h),b4h:r6(b4h),b24h:r6(c24.length?median(c24):0),breadth:r4(above.length?mean(above):.5),volPct:volPct==null?null:r4(volPct),
    dispersion:r6(disp),btcEff:r4(eff("BTC_USDT")),ethEff:r4(eff("ETH_USDT")),funding:fs.length?r6(median(fs)):null,
    oi1h:ois.length?r6(median(ois)):null,members:r1.length};
}
/** Append the basket index (median 5m return chained) and hourly realized vol; used for predictions and vol percentile. */
export function noteBasketIndex(state:ThesisState,members:string[],bars:(s:string)=>MidBar[],at:number){
  const rs:number[]=[];for(const s of members){const r=bars(s);if(r.length>=2&&(r.at(-1)!.time+300)*1000===at)rs.push(r.at(-1)!.close/r.at(-2)!.close-1);}
  if(rs.length<10)return;
  const prev=state.index.at(-1)?.[1]??1;state.index.push([at,r6(prev*(1+median(rs)))]);if(state.index.length>600)state.index.splice(0,state.index.length-600);
  if(at%3_600_000===0){const idx=state.index.slice(-13),xs:number[]=[];for(let i=1;i<idx.length;i++)xs.push(idx[i]![1]/idx[i-1]![1]-1);
    if(xs.length>=6){state.volHist.push([at,r6(Math.sqrt(mean(xs.map(x=>x*x))))]);state.volHist=state.volHist.filter(x=>at-x[0]<=7*86_400_000);}}
}
const dirTagOf=(b4h:number):"U"|"D"|"F"=>b4h>.005?"U":b4h<-.005?"D":"F";
/** Pure: the candidate thesis for this bar. */
export function judge(inputs:ThesisInputs,scores:Record<ProbeId,ProbeScore>,burst:{side:Side}|null,at:number,state:ThesisState):Thesis{
  const eff=(inputs.btcEff+inputs.ethEff)/2,abs4=Math.abs(inputs.b4h),up=inputs.b4h>0;
  const breadthDir=up?inputs.breadth:1-inputs.breadth;
  const structure:Structure=burst?"BURST":abs4>=.008&&eff>=.4&&breadthDir>=.6?"TREND":abs4<.005&&eff<.3?"RANGE":"CHOP";
  const side:Side|null=burst?burst.side:abs4>=.005&&breadthDir>=.55?(up?"LONG":"SHORT"):null;
  const crowded:Side|null=inputs.funding!=null&&inputs.oi1h!=null&&inputs.oi1h>=.03?(inputs.funding>=.0003?"LONG":inputs.funding<=-.0002?"SHORT":null):null;
  const allowed:Playbook[]=["extension-fade"];
  if(crowded)allowed.push("crowding-fade");
  if(side)allowed.push("leaders","laggards","btc-lead");
  if(structure==="TREND")allowed.push("trend-pullback","breakout","momentum");
  if(structure==="BURST")allowed.push("momentum","breakout");
  if(structure==="RANGE")allowed.push("range-revert");
  const playbooks=[...new Set(allowed)].map(pb=>{const s=scores[PLAYBOOK_PROBE[pb]];return{pb,probe:PLAYBOOK_PROBE[pb],score:s.score,t:s.t,n:s.n,persistence:s.persistence,rewarded:s.rewarded};})
    .filter(x=>x.rewarded).sort((a,b)=>b.score*b.t-a.score*a.t).map(({rewarded:_r,...x})=>{void _r;return x;});
  const kind=structure==="TREND"&&side?`TREND_${side}`:structure==="RANGE"?"RANGE":structure;
  const weightHalved=halved(state,kind,at);
  const dirWord=side==="LONG"?"普涨":side==="SHORT"?"普跌":"方向不明";
  const structWord={TREND:"趋势",RANGE:"区间",CHOP:"震荡",BURST:"集体异动"}[structure];
  const best=playbooks[0];
  const sentence=`一篮子${dirWord}（4 小时 ${pct(inputs.b4h)}，站上 4 小时均价的币 ${(inputs.breadth*100).toFixed(0)}%），结构${structWord}`
    +(crowded?`，${crowded==="LONG"?"多头":"空头"}拥挤`:"")
    +(best?`；${PROBE_META[best.probe].label}有奖励（奖励分 ${pct(best.score)}，t ${best.t.toFixed(1)}，样本 ${best.n}）→ 做${PLAYBOOK_LABEL[best.pb]}`
      :"；哪种做法都没被奖励 → 现在市场不给钱，不开新单");
  return {id:`th-${Math.floor(at/1000).toString(36)}`,at,since:at,side,strength:r4(Math.min(1,abs4/.01)*Math.max(.2,eff)),structure,crowded,playbooks,
    sentence,validUntil:at+30*60_000,invalidation:{basketLevel:side?r6(inputs.b4h-(side==="LONG"?.005:-.005)):null,probes:playbooks.map(p=>p.probe)},
    inputs,dirTag:dirTagOf(inputs.b4h),weightHalved,kind};
}
const keyOf=(t:Thesis)=>`${t.structure}|${t.side}|${t.crowded}|${t.playbooks.map(p=>p.pb).join(",")}`;
/** Debounced update (2 bars), immediate on a fast-lane burst. Returns true when the thesis changed. */
export function advanceThesis(state:ThesisState,cand:Thesis,at:number){
  state.lastBarAt=at;
  const cur=state.current;
  if(cur&&keyOf(cur)===keyOf(cand)){state.current={...cand,id:cur.id,since:cur.since};state.pending=null;return false;}
  const key=keyOf(cand);
  if(cand.structure!=="BURST"&&cur){
    state.pending=state.pending?.key===key?{key,bars:state.pending.bars+1}:{key,bars:1};
    if(state.pending.bars<STEPS.thesisDebounceBars){state.current={...cur,validUntil:at+30*60_000};return false;}
  }
  state.pending=null;state.current=cand;
  const {inputs:_i,...slim}=cand;void _i;state.history.push(slim);if(state.history.length>100)state.history.splice(0,state.history.length-100);
  return true;
}
/** Hourly predictions and their check (C2 self-check). */
export function notePredictions(state:ThesisState,at:number){
  if(at%3_600_000!==0||state.index.length<49)return;
  const idx=state.index,last=idx.at(-1)![1],w=idx.slice(-49).map(x=>x[1]),hi=Math.max(...w),lo=Math.min(...w);
  const mk=(kind:string):Prediction=>({at,kind,until:at+STEPS.thesisPredictMs,start:last,hi,lo,outcome:null});
  if(state.current)state.predictions.push(mk(state.current.kind));
  for(const k of ["TREND_LONG","TREND_SHORT","RANGE"])state.baseline.push(mk(k));
  const level=(t:number)=>{let best:number|null=null;for(const x of idx)if(x[0]<=t)best=x[1];return best;};
  for(const p of [...state.predictions,...state.baseline]){
    if(p.outcome!=null||p.until>at)continue;
    const end=level(p.until);if(end==null){p.outcome=false;continue;}
    const path=idx.filter(x=>x[0]>=p.at&&x[0]<=p.until).map(x=>x[1]);
    let moves=0;for(let i=1;i<path.length;i++)moves+=Math.abs(path[i]!-path[i-1]!);
    const effv=moves>0?Math.abs(end-p.start)/moves:0;
    p.outcome=p.kind==="TREND_LONG"?end>p.start&&effv>=.3:p.kind==="TREND_SHORT"?end<p.start&&effv>=.3
      :p.kind==="RANGE"?Math.max(...path)<=p.hi*1.0025&&Math.min(...path)>=p.lo*.9975:true;
  }
  const keep=(xs:Prediction[])=>xs.filter(p=>at-p.at<=7*86_400_000);state.predictions=keep(state.predictions);state.baseline=keep(state.baseline);
}
function halved(state:ThesisState,kind:string,at:number){
  const own=state.predictions.filter(p=>p.kind===kind&&p.outcome!=null&&at-p.at<=7*86_400_000),base=state.baseline.filter(p=>p.kind===kind&&p.outcome!=null);
  if(own.length<10||base.length<10)return false;
  const hit=own.filter(p=>p.outcome).length/own.length,rate=base.filter(p=>p.outcome).length/base.length;
  return hit<=rate;
}
export function thesisSupports(t:Thesis|null,pb:Playbook,side:Side){
  if(!t)return false;const listed=t.playbooks.some(p=>p.pb===pb);if(!listed)return false;
  const directional=pb==="trend-pullback"||pb==="breakout"||pb==="momentum"||pb==="leaders"||pb==="laggards"||pb==="btc-lead";
  return !directional||t.side===side;
}
export {quantile};
