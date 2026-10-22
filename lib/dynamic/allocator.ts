/**
 * dynamic-v1 allocator (pure). For each playbook, in the current BTC/ETH state bucket, a live paper entry is allowed only when:
 *  1. a pattern is established (≥ 3 good and ≥ 3 bad phases, ≥ 40 trades — cycles.ts);
 *  2. in this state bucket the playbook has ≥ 20 shadow trades, a mean ≥ +0.2%/trade net and a t-value ≥ 1.5;
 *  3. it is not inside a BAD phase when its phases persist (persistence ≥ 0.6: a bad stretch tends to continue).
 * Size = the playbook's base risk × confidence, confidence 0.5–1.0 from the bucket t-value (1.5 → 0.5, ≥ 3 → 1.0). Every existing
 * risk cap of the forward core still applies on top. burst-leader is not in the pool and is not gated here.
 * Short-term pool (the core): the bucket is the intraday BTC state (1h trend × volatility) and the bucket edge must also hold
 * clustered by day (t_day ≥ 2 over ≥ 10 days). Daily / 4h playbooks are record-only (except the daily breakout htf-donch20,
 * which follows the allocator like any pool member).
 * Early stage (learning starts with whatever data exists): from ≥ 1 good and ≥ 1 bad phase and ≥ 15 trades a playbook may already
 * be allowed, with half the bucket sample (≥ 10 trades, short tier ≥ 5 days) and its size scaled by the evidence
 * (0.25 + 0.75 × sample, sample = min(good, bad)/3 × trades/40): small while there is little data, full once confirmed.
 * A forecast of a BAD next window with ≥ 60% blocks it.
 * dynamic-v1.2: with the cycle predictor running, `allocatePred` replaces the bucket mean / t gate for the short tier and
 * htf-donch20 (see below); `allocate` stays the fallback while the predictor has not produced forecasts yet.
 */
import {CYCLE,sampleOf,sampleLabel,type PlaybookCycle} from "./cycles.ts";
import {bucketLabel,type DayState,type IntraState} from "./state.ts";
import {POOL_BY_ID,tierOf} from "./playbooks.ts";
import {trackView,type PbForecast,type Track} from "./predictor.ts";
export const ALLOC={baseRisk:.0075,shortRisk:.005,minConf:.5,maxPoolOpen:8,maxPerPlaybook:4,minTDay:2,minDays:10,longAllowed:["htf-donch20"] as readonly string[]} as const;
export type Gate={pb:string;ok:boolean;conf:number;risk:number;why:string;bucket:string|null;n:number;mean:number;t:number};
export function allocate(cycles:Record<string,PlaybookCycle>,state:DayState|null,intra:IntraState|null=null):Record<string,Gate>{
  const out:Record<string,Gate>={};
  for(const pb of Object.keys(POOL_BY_ID)){
    const short=tierOf(POOL_BY_ID[pb]!)==="short",st=short?intra:state;
    const c=cycles[pb],b=st?.bucket??null,s=b?c?.byBucket[b]:undefined,base={pb,bucket:b,n:s?.n??0,mean:s?.mean??0,t:s?.t??0};
    const no=(why:string):Gate=>({...base,ok:false,conf:0,risk:0,why});
    if(!short&&!ALLOC.longAllowed.includes(pb)){out[pb]=no("日线/4小时打法：只记录（短线为主，不参与分配）");continue;}
    if(!st){out[pb]=no(short?"BTC/ETH 日内状态还算不出（1 小时历史不够或数据断了）":"BTC/ETH 状态还算不出（日线历史不够）");continue;}
    if(!c||!c.trades){out[pb]=no("还没有影子交易");continue;}
    const early=!c.pattern;
    if(early&&c.stage!=="early"){out[pb]=no(`数据少，还看不出周期：${c.patternWhy}（要先见到 ≥1 段赚钱和 ≥1 段亏钱、≥15 笔）`);continue;}
    const minN=early?Math.ceil(CYCLE.bucketMinTrades/2):CYCLE.bucketMinTrades,minDays=early?Math.ceil(ALLOC.minDays/2):ALLOC.minDays;
    if(!s||s.n<minN){out[pb]=no(`当前状态「${bucketLabel(b!)}」样本 ${s?.n??0}/${minN} 笔不够`);continue;}
    if(s.mean<CYCLE.bucketMinMean||s.t<CYCLE.bucketMinT){out[pb]=no(`当前状态「${bucketLabel(b!)}」不赚钱：${s.n} 笔，平均 ${(s.mean*100).toFixed(2)}%/笔，t=${s.t.toFixed(1)}`);continue;}
    if(short&&((s.days??0)<minDays||(s.tDay??0)<ALLOC.minTDay)){out[pb]=no(`当前状态「${bucketLabel(b!)}」按天算不够显著：${s.days??0} 天，t(按天)=${(s.tDay??0).toFixed(1)}（要 ≥${minDays} 天且 ≥${ALLOC.minTDay}）`);continue;}
    const unit=c.unit==="day"?"天":"周";
    if(c.current.label==="BAD"&&(c.persistence??0)>=CYCLE.persistMin){out[pb]=no(`正处在亏钱段（第 ${c.current.weeks} ${unit}），这套打法好坏段会延续（持续性 ${Math.round((c.persistence??0)*100)}%）`);continue;}
    if(c.forecast&&c.forecast.next==="BAD"&&c.forecast.prob>=.6){out[pb]=no(`预测下一段亏钱（${Math.round(c.forecast.prob*100)}%，${c.forecast.label}）：${c.forecast.why}`);continue;}
    const tt=short?Math.min(s.t,(s.tDay??0)+.5):s.t,sample=c.sample??sampleOf(c.good,c.bad,c.trades),scale=.25+.75*sample;
    const conf=Math.max(ALLOC.minConf,Math.min(1,.5+(tt-1.5)/3))*scale,br=short?ALLOC.shortRisk:ALLOC.baseRisk;
    out[pb]={...base,ok:true,conf,risk:br*conf,
      why:`${short?"日内":""}状态「${bucketLabel(b!)}」${s.n} 笔${short?`/${s.days} 天`:""}，平均 ${(s.mean*100).toFixed(2)}%/笔，胜率 ${Math.round(s.win*100)}%，t=${s.t.toFixed(1)}${short?`，t(按天)=${(s.tDay??0).toFixed(1)}`:""}；${c.current.label==="GOOD"?`赚钱段第 ${c.current.weeks} ${unit}`:"不在亏钱段"}${early?`；早期（${sampleLabel(sample)}，证据 ${Math.round(sample*100)}%，仓位 ×${scale.toFixed(2)}）`:""} → 风险 ${(br*conf*100).toFixed(2)}%`};
  }
  return out;
}
// ------------------------------------------------------------------ dynamic-v1.2: predictor gate (short tier + htf-donch20)
/** tunable constants of the predictor gate */
export const PRED_ALLOC={pMin:.58,pFull:.8,riskMin:.0025,riskMax:.005,trackMinN:10,trackMinHit:.5,trackMaxBrier:.27,trackFewW:.25,
  contraFirst:3,contraLast:5,cutHours:12} as const;
/** shadow results since the gate opened (for the immediate cut) */
export type LiveCheck={since:number|null;cutUntil:number;results:readonly number[]};
export type PredInput={forecasts:Record<string,PbForecast>;track:Record<string,Track>;live:Record<string,LiveCheck>;nowSec:number};
/** contradiction: the first `contraFirst` shadow trades after the gate opened all lost, or the last `contraLast` all lost */
export function contradicted(results:readonly number[]){const F=PRED_ALLOC.contraFirst,L=PRED_ALLOC.contraLast;
  if(results.length>=F&&results.slice(0,F).every(x=>x<=0))return `开闸后前 ${F} 笔影子交易全亏`;
  if(results.length>=L&&results.slice(-L).every(x=>x<=0))return `最近 ${L} 笔影子交易全亏`;return null;}
/** the predictor gate: open small paper trades when P(good in the next 6 h) ≥ pMin and the forecast track record is not bad.
 * size = (0.25% … 0.5% by the probability edge) × track-record weight × evidence scale. Long tier stays record-only. */
export function allocatePred(cycles:Record<string,PlaybookCycle>,state:DayState|null,intra:IntraState|null,pred:PredInput):Record<string,Gate>{
  const out=allocate(cycles,state,intra),A=PRED_ALLOC;
  for(const pb of Object.keys(POOL_BY_ID)){
    const short=tierOf(POOL_BY_ID[pb]!)==="short";if(!short&&!ALLOC.longAllowed.includes(pb))continue;
    const f=pred.forecasts[pb],g0=out[pb]!,base={pb,bucket:g0.bucket,n:g0.n,mean:g0.mean,t:g0.t};
    const no=(why:string):Gate=>({...base,ok:false,conf:0,risk:0,why});
    if(!f){out[pb]=no(cycles[pb]?.trades?"预测器还没算出这套打法（等下一次分析）":"还没有影子交易");continue;}
    const p=f.p["6"],tv=trackView(pred.track[pb]),lv=pred.live[pb];
    if(f.sample<=0){out[pb]=no(`数据少：还没见到一段赚钱和一段亏钱（${f.phases.good} 段赚 / ${f.phases.bad} 段亏，${f.trades} 笔），只记录`);continue;}
    if(lv&&lv.cutUntil>pred.nowSec){out[pb]=no(`影子交易和预测相反，暂停到 ${new Date(lv.cutUntil*1000).toISOString().slice(5,16).replace("T"," ")} UTC`);continue;}
    if(p<A.pMin){out[pb]=no(`未来 6 小时处在赚钱期的概率 ${Math.round(p*100)}%（要 ≥${Math.round(A.pMin*100)}%）【${f.label}】`);continue;}
    let tw:number=A.trackFewW,tWhy=`预测才评过 ${tv.n} 次（<${A.trackMinN}），用最小仓位`;
    if(tv.n>=A.trackMinN){
      if(tv.hit<A.trackMinHit||tv.brier>A.trackMaxBrier){out[pb]=no(`概率 ${Math.round(p*100)}% 够，但这套打法的预测记录不好：命中率 ${Math.round(tv.hit*100)}%（${tv.n} 次），Brier ${tv.brier.toFixed(2)}`);continue;}
      tw=Math.max(A.trackFewW,Math.min(1,(tv.hit-A.trackMinHit)/.25));tWhy=`预测命中率 ${Math.round(tv.hit*100)}%（${tv.n} 次）→ ×${tw.toFixed(2)}`;}
    const edge=Math.max(0,Math.min(1,(p-A.pMin)/(A.pFull-A.pMin))),scale=.25+.75*f.sample,r=(A.riskMin+(A.riskMax-A.riskMin)*edge)*tw*scale;
    out[pb]={...base,ok:true,conf:r/A.riskMax,risk:r,
      why:`预测：未来 6 小时在赚钱期的概率 ${Math.round(p*100)}%（${f.cur==="GOOD"?`赚钱期第 ${Math.round(f.elapsedH)} 小时`:f.cur==="BAD"?`亏钱期第 ${Math.round(f.elapsedH)} 小时`:"阶段不明"}）【${f.label}】；${tWhy}；证据 ×${scale.toFixed(2)} → 风险 ${(r*100).toFixed(2)}%`};
  }
  return out;
}
