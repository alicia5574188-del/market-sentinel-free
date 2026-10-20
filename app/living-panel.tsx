"use client";

import {useCallback,useEffect,useRef,useState} from "react";
import {operatorRequest, type AuthSession} from "../lib/operator-ui.ts";

type Mode="off"|"compute-only"|"paper-enabled";
type Status={version:string;mode:Mode;configured:Mode;acting:boolean;fallback:{at:number;until:number;reason:string}|null;
  items:{key:string;label:string;on:boolean}[];
  thesis:{sentence:string;structure:string;side:string|null;since:number;playbooks:string[]}|null;
  rewarded:{probe:string;label:string;score:number;t:number;n:number;persistence:string}[];
  fast:{state:string;side:string|null;reason:string|null;adjustZ:number;episodes:number;last:{id:string;side:string;end:string;alertAt:number}[]};
  watches:{symbol:string;side:string;pb:string;expiresAt:number;reason:string|null}[];
  basket:number;lastFeedAt:number;cpu:{planMs:number;maxPlanMs:number;hubMs:number};writesToday:number;lastError:string|null};
const MODE_LABEL:Record<Mode,string>={"off":"关闭","compute-only":"只计算","paper-enabled":"作用于模拟盘"};
const bj=(ms:number)=>ms?new Date(ms+8*3_600_000).toISOString().slice(5,16).replace("T"," "):"—";
const pct=(v:number)=>`${v>=0?"+":""}${(v*100).toFixed(2)}%`;

/** Owner-only, System tab: minimal living research layer summary and the mode switch (paper only; live is never touched). */
export default function LivingPanel({auth}:{auth:AuthSession|null}){
  const owner=Boolean(auth?.authenticated&&auth.username==="owner"&&!auth.memberId&&auth.role!=="member");
  const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const submitting=useRef(false);
  const load=useCallback(async()=>{
    try{setStatus(await operatorRequest<Status>("/api/living/status"));setError(null);}catch(e){setError(e instanceof Error?e.message:"读取失败");}
  },[]);
  useEffect(()=>{if(!owner)return;const first=setTimeout(()=>void load(),0);const id=setInterval(()=>void load(),30_000);return()=>{clearTimeout(first);clearInterval(id);};},[owner,load]);
  if(!owner)return null;
  const setMode=async(mode:Mode)=>{
    if(submitting.current||busy)return;submitting.current=true;setBusy(true);
    try{setStatus(await operatorRequest<Status>("/api/living/mode","POST",{mode}));setError(null);}
    catch(e){setError(e instanceof Error?e.message:"切换失败");}
    finally{submitting.current=false;setBusy(false);}
  };
  return <section className="fr-section" data-testid="owner-living-research">
    <div className="fr-section-head"><h2>研究层（living-v1）</h2><b>{status?MODE_LABEL[status.mode]:"读取中"}</b></div>
    {error&&<div className="fr-error" role="alert"><p>{error}</p></div>}
    {status&&<div className="fr-form">
      {status.fallback&&<p className="fr-note"><b>自动降级为只计算</b>（到 {bj(status.fallback.until)}）：{status.fallback.reason}</p>}
      <p className="fr-note"><b>市场判断：</b>{status.thesis?.sentence??"还在攒数据"}</p>
      <p className="fr-note"><b>被市场奖励的做法：</b>{status.rewarded.length?status.rewarded.map(r=>`${r.label} ${pct(r.score)} t${r.t.toFixed(1)} n${r.n}${r.persistence==="ok"?"":"（持续性未验证）"}`).join("；"):"暂无（现在市场不给钱，不开新单）"}</p>
      <p className="fr-note"><b>快速通道：</b>{status.fast.state==="CALM"?"平静":`${status.fast.state} ${status.fast.side==="LONG"?"普涨":"普跌"}`}{status.fast.reason?`（${status.fast.reason}）`:""}；已记录 {status.fast.episodes} 段</p>
      <p className="fr-note"><b>等位置：</b>{status.watches.length?status.watches.map(w=>`${w.symbol} ${w.side==="LONG"?"多":"空"} ${w.pb}`).join("，"):"无"}</p>
      <p className="fr-note"><b>开关：</b>{status.items.map(i=>`${i.label}${i.on?"✓":"✗"}`).join("　")}</p>
      <p className="fr-note">一篮子 {status.basket} 个币 · 最近报价 {bj(status.lastFeedAt)} · 每轮 {status.cpu.planMs}ms（峰值 {status.cpu.maxPlanMs}ms）· 今天写入 {status.writesToday} 次{status.lastError?` · 最近错误：${status.lastError.slice(0,80)}`:""}</p>
      <div className="fr-owner-session">
        {(["off","compute-only","paper-enabled"] as Mode[]).map(m=><button key={m} className={m===status.configured?"fr-button":"fr-text-button"} type="button"
          disabled={busy||m===status.configured} onClick={()=>void setMode(m)}>{MODE_LABEL[m]}</button>)}
      </div>
      <p className="fr-note">只作用于模拟账户；实盘开关不受这里影响。</p>
    </div>}
  </section>;
}
