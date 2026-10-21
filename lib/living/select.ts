/**
 * C3 step 3 — pick the coins that best express the thesis. Each playbook scores its candidates (coins whose probe fired on
 * one of the last 3 closes) on a few factors, hard filters liquidity / spread / maintenance rate, keeps one coin per
 * correlation group and returns the top 3. Self-check: selected vs all triggered coins of the same observation (selection
 * excess); when the last 30 are ≤ 0 the factor weights move toward each factor's live predictive power (0.5x-1.5x).
 */
import {FAST,STEPS} from "./config.ts";
import type {MidBar} from "./tape.ts";
import type {Trigger,CompletedObs,ProbeId} from "./probes.ts";
import {atr,efficiency} from "./probes.ts";
import type {Playbook,Side} from "./thesis.ts";
import {PLAYBOOK_PROBE} from "./thesis.ts";
import {mean,corr,clamp,r4} from "./util.ts";

export const FACTORS=["eff","fit","early","funding","edge"] as const;
export type Factor=typeof FACTORS[number];
export type Candidate={symbol:string;side:Side;playbook:Playbook;probe:ProbeId;score:number;rank:number;factors:Record<Factor,number>;
  trigger:Trigger;reject:string|null};
export type SelectState={v:1;weights:Record<Factor,number>;picks:{obsPrefix:string;probe:ProbeId;at:number;symbols:string[];factors:Record<string,Record<Factor,number>>}[];
  excess:number[];rows:[number,number,number,number,number,number][];reweightedAt:number};
export function initialSelect():SelectState{
  return {v:1,weights:{eff:1,fit:1,early:1,funding:1,edge:1},picks:[],excess:[],rows:[],reweightedAt:0};
}
export function normalizeSelect(raw:unknown):SelectState{const v=raw as SelectState|undefined;return v?.v===1&&v.weights?{...initialSelect(),...v}:initialSelect();}
function fitR2(rows:MidBar[]){
  const ys=rows.map(r=>Math.log(r.close)),xs=ys.map((_,i)=>i);const c=corr(xs,ys);return Number.isFinite(c)?c*c:0;
}
export type Market={bars:(s:string)=>MidBar[];spread:(s:string)=>number|null;volume:(s:string)=>number;mmr:(s:string)=>number|null;
  funding:(s:string)=>number|null};
export function candidateFactors(m:Market,t:Trigger):Record<Factor,number>{
  const r=m.bars(t.symbol),w=r.slice(-48),A=atr(r);
  const d=t.side==="LONG"?1:-1,eff=w.length>=12?efficiency(w):0,fit=w.length>=12?fitR2(w):0;
  const r10=r.length>=121?r.at(-1)!.close/r[r.length-121]!.close-1:r.length>12?r.at(-1)!.close/r[0]!.close-1:0;
  const rs:number[]=[];for(let i=Math.max(1,r.length-120);i<r.length;i++)rs.push(r[i]!.close/r[i-1]!.close-1);
  const daily=rs.length?Math.sqrt(mean(rs.map(x=>x*x)))*Math.sqrt(288):0,ext=daily>0?Math.abs(r10)/daily:0;
  const f=m.funding(t.symbol)??0;
  // "early": over-extension is a penalty for with-trend playbooks (10h move vs outcome corr −0.19), a plus for fades.
  const fade=t.probe==="P6"||t.probe==="P7";
  const early=fade?clamp(ext/3,0,1):clamp(1-Math.max(0,ext-1)/1.5,0,1);
  const funding=fade?clamp(Math.abs(f)/.001,0,1):clamp(1-Math.max(0,d*f)/.0005,0,1);
  let edge=.5;
  if(t.probe==="P2"&&w.length>=24){const hi=Math.max(...w.map(x=>x.high)),lo=Math.min(...w.map(x=>x.low)),W=hi-lo;
    const top=w.filter(x=>x.high>=hi-.1*W).length,bot=w.filter(x=>x.low<=lo+.1*W).length,ratio=A>0?W/A:0;
    edge=(top>=2&&bot>=2?.6:.1)+(ratio>=3&&ratio<=6?.4:0);}
  else if(A>0&&t.ref!=null){edge=clamp(1-Math.abs(r.at(-1)!.close-t.ref)/(3*A),0,1);}
  return {eff:r4(t.probe==="P2"?1-eff:eff),fit:r4(t.probe==="P2"?1-fit:fit),early:r4(early),funding:r4(funding),edge:r4(edge)};
}
function returns(rows:MidBar[],n=24){const xs:number[]=[];for(let i=Math.max(1,rows.length-n);i<rows.length;i++)xs.push(rows[i]!.close/rows[i-1]!.close-1);return xs;}
/** Top-3 candidates for a playbook. `side` = thesis side for directional playbooks (null keeps the trigger's own side). */
export function selectCandidates(m:Market,state:SelectState,pb:Playbook,triggers:Trigger[],side:Side|null,liqSafety:boolean):Candidate[]{
  const probe=PLAYBOOK_PROBE[pb],seen=new Set<string>(),out:Candidate[]=[];
  const pool=triggers.filter(t=>t.probe===probe&&(!side||t.side===side)).filter(t=>{if(seen.has(t.symbol))return false;seen.add(t.symbol);return true;});
  for(const t of pool){
    const f=candidateFactors(m,t),wsum=FACTORS.reduce((n,k)=>n+state.weights[k],0);
    const score=FACTORS.reduce((n,k)=>n+state.weights[k]*f[k],0)/wsum;
    const spread=m.spread(t.symbol),vol=m.volume(t.symbol),mmr=m.mmr(t.symbol);
    const reject=vol<STEPS.selectVolume?`24小时成交额 ${(vol/1e6).toFixed(1)}M<20M`:spread==null||spread>STEPS.selectSpread?`价差 ${spread==null?"未知":(spread*1e4).toFixed(1)+"bp"}>${(STEPS.selectSpread*1e4).toFixed(0)}bp`
      :liqSafety&&(mmr==null||mmr>STEPS.selectMmr)?`维持保证金率 ${mmr==null?"未知":(mmr*100).toFixed(1)+"%"}>2%`:score<STEPS.selectMin?`选币分 ${score.toFixed(2)}<${STEPS.selectMin}`:null;
    out.push({symbol:t.symbol,side:t.side,playbook:pb,probe,score:r4(score),rank:0,factors:f,trigger:t,reject});
  }
  out.sort((a,b)=>(a.reject?1:0)-(b.reject?1:0)||b.score-a.score);
  // one per correlation group (5m returns, 2h)
  const chosen:Candidate[]=[];
  for(const c of out){
    if(c.reject){chosen.push(c);continue;}
    const rc=returns(m.bars(c.symbol));
    const dup=chosen.find(x=>!x.reject&&x.rank>0&&corr(returns(m.bars(x.symbol)),rc)>=.8);
    if(dup){c.reject=`与 ${dup.symbol} 同一相关组`;chosen.push(c);continue;}
    const ok=chosen.filter(x=>!x.reject).length;
    if(ok<STEPS.selectTop)c.rank=ok+1;else c.reject=`排在前 ${STEPS.selectTop} 之外`;
    chosen.push(c);
  }
  return chosen;
}
export function notePick(state:SelectState,probe:ProbeId,at:number,picked:Candidate[]){
  const ok=picked.filter(c=>!c.reject);if(!ok.length)return;
  state.picks.push({obsPrefix:`${probe}-${Math.floor(at/1000).toString(36)}`,probe,at,symbols:ok.map(c=>c.symbol),
    factors:Object.fromEntries(picked.map(c=>[c.symbol,c.factors]))});
  if(state.picks.length>200)state.picks.splice(0,state.picks.length-200);
}
/** When an observation matures: selection excess and factor/payoff rows; reweight when the last 30 excess are ≤ 0. */
export function learnSelection(state:SelectState,done:CompletedObs[],now:number){
  let changed=false;
  for(const o of done){
    const i=state.picks.findIndex(p=>p.obsPrefix===o.id);if(i<0)continue;const p=state.picks[i]!;state.picks.splice(i,1);
    const sel=o.members.filter(m=>p.symbols.includes(m.s)).map(m=>m.v),all=o.members.map(m=>m.v);
    if(sel.length&&all.length){state.excess.push(r4((mean(sel)-mean(all))*1e4)/1e4);if(state.excess.length>60)state.excess.shift();changed=true;}
    for(const m of o.members){const f=p.factors[m.s];if(f)state.rows.push([r4(m.v),f.eff,f.fit,f.early,f.funding,f.edge]);}
    if(state.rows.length>300)state.rows.splice(0,state.rows.length-300);
  }
  const last=state.excess.slice(-30);
  if(last.length>=30&&mean(last)<=0&&now-state.reweightedAt>=6*3_600_000&&state.rows.length>=60){
    const pay=state.rows.map(r=>r[0]);
    FACTORS.forEach((k,j)=>{const c=corr(state.rows.map(r=>r[j+1]!),pay);state.weights[k]=r4(clamp(1+(Number.isFinite(c)?c:0)*2,.5,1.5));});
    state.reweightedAt=now;changed=true;
  }
  return changed;
}
export const followFilters={mmr:FAST.followMmr,spread:FAST.followSpread,volume:FAST.followVolume};
