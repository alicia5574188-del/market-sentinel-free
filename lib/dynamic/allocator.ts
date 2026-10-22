/**
 * dynamic-v1 allocator (pure). For each playbook, in the current BTC/ETH state bucket, a live paper entry is allowed only when:
 *  1. a pattern is established (≥ 3 good and ≥ 3 bad phases, ≥ 40 trades — cycles.ts);
 *  2. in this state bucket the playbook has ≥ 20 shadow trades, a mean ≥ +0.2%/trade net and a t-value ≥ 1.5;
 *  3. it is not inside a BAD phase when its phases persist (persistence ≥ 0.6: a bad stretch tends to continue).
 * Size = the playbook's base risk × confidence, confidence 0.5–1.0 from the bucket t-value (1.5 → 0.5, ≥ 3 → 1.0). Every existing
 * risk cap of the forward core still applies on top. burst-leader is not in the pool and is not gated here.
 */
import {CYCLE,type PlaybookCycle} from "./cycles.ts";
import {bucketLabel,type DayState} from "./state.ts";
import {POOL_BY_ID} from "./playbooks.ts";
export const ALLOC={baseRisk:.0075,minConf:.5,maxPoolOpen:8,maxPerPlaybook:4} as const;
export type Gate={pb:string;ok:boolean;conf:number;risk:number;why:string;bucket:string|null;n:number;mean:number;t:number};
export function allocate(cycles:Record<string,PlaybookCycle>,state:DayState|null):Record<string,Gate>{
  const out:Record<string,Gate>={};
  for(const pb of Object.keys(POOL_BY_ID)){
    const c=cycles[pb],b=state?.bucket??null,s=b?c?.byBucket[b]:undefined,base={pb,bucket:b,n:s?.n??0,mean:s?.mean??0,t:s?.t??0};
    const no=(why:string):Gate=>({...base,ok:false,conf:0,risk:0,why});
    if(!state){out[pb]=no("BTC/ETH 状态还算不出（日线历史不够）");continue;}
    if(!c||!c.trades){out[pb]=no("还没有影子交易");continue;}
    if(!c.pattern){out[pb]=no(`规律未确认：${c.patternWhy}`);continue;}
    if(!s||s.n<CYCLE.bucketMinTrades){out[pb]=no(`当前状态「${bucketLabel(b!)}」样本 ${s?.n??0}/${CYCLE.bucketMinTrades} 笔不够`);continue;}
    if(s.mean<CYCLE.bucketMinMean||s.t<CYCLE.bucketMinT){out[pb]=no(`当前状态「${bucketLabel(b!)}」不赚钱：${s.n} 笔，平均 ${(s.mean*100).toFixed(2)}%/笔，t=${s.t.toFixed(1)}`);continue;}
    if(c.current.label==="BAD"&&(c.persistence??0)>=CYCLE.persistMin){out[pb]=no(`正处在亏钱段（第 ${c.current.weeks} 周），这套打法好坏段会延续（持续性 ${Math.round((c.persistence??0)*100)}%）`);continue;}
    const conf=Math.max(ALLOC.minConf,Math.min(1,.5+(s.t-1.5)/3));
    out[pb]={...base,ok:true,conf,risk:ALLOC.baseRisk*conf,
      why:`当前状态「${bucketLabel(b!)}」${s.n} 笔，平均 ${(s.mean*100).toFixed(2)}%/笔，胜率 ${Math.round(s.win*100)}%，t=${s.t.toFixed(1)}；${c.current.label==="GOOD"?`赚钱段第 ${c.current.weeks} 周`:"不在亏钱段"} → 风险 ${(ALLOC.baseRisk*conf*100).toFixed(2)}%`};
  }
  return out;
}
