"use client";

import {useState} from "react";
import {operatorRequest, type AuthSession, type OperatorRuntime} from "../lib/operator-ui.ts";

type ResetResult={ok:boolean;equity:number;forward?:{startedAt:number;initialEquity:number}};

export default function PaperAccountReset({auth,runtime,onReset}:{auth:AuthSession|null;runtime:OperatorRuntime|null;onReset:()=>void}){
  const owner=Boolean(auth?.authenticated&&auth.username==="owner"&&!auth.memberId&&auth.role!=="member");
  const [confirming,setConfirming]=useState(false),[busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  if(!owner)return null;

  const live=runtime?.live;
  const openLive=Object.values(live?.positions??{}).filter(p=>p?.status==="OPEN").length;
  const pendingLive=Object.values(live?.entries??{}).filter(e=>e&&!["FILLED","CANCELLED","FINISHED","REJECTED"].includes(e.status)).length;
  const blocked=!runtime||Boolean(runtime.liveMode.requestedEnabled||runtime.liveMode.operational||openLive||pendingLive);

  const reset=async()=>{
    if(busy||blocked)return;
    setBusy(true);setError(null);setNotice(null);
    try{
      const result=await operatorRequest<ResetResult>("/api/paper/reset","POST",{confirm:"RESET_PAPER"});
      if(!result.ok||result.equity!==1000)throw new Error("服务器没有确认新的1000U模拟账户，未发布重置结果。");
      setConfirming(false);
      setNotice("模拟账户已原子重置为1000U；策略、扫描范围、实盘API和LIVE开关均未改变。");
      onReset();
    }catch(e){setError(e instanceof Error?e.message:"模拟账户重置失败");}
    finally{setBusy(false);}
  };

  return <section className="fr-section" data-testid="owner-paper-reset">
    <div className="fr-section-head"><div><small>主账户专属</small><h2>模拟账户重置</h2></div><b>{runtime?.forward?.initialEquity===1000?"1000U基准":"账户维护"}</b></div>
    <p className="fr-note">只重置当前主模拟账户。已有模拟持仓会先按新鲜可执行盘口归档，然后建立新的1000U账户纪元；旧账户历史仍保留在归档存储中，但不会接到新账户净值曲线。</p>
    <p className="fr-note">不会修改交易策略、30市场扫描、Gate API、会员账户或LIVE开关。服务器只在实盘关闭且没有本系统实盘持仓/待成交订单时允许执行。</p>
    {error&&<div className="fr-error" role="alert"><b>重置未完成</b><p>{error}</p></div>}
    {notice&&<div className="fr-notice" role="status">{notice}</div>}
    {!confirming?<button className="fr-button" type="button" disabled={busy} onClick={()=>{setError(null);setNotice(null);setConfirming(true);}}>重置模拟账户</button>
      :<div className="fr-form">
        <p className="fr-error"><b>确认重置？</b><br/>当前模拟账户的余额、持仓和本轮交易记录会结束，新账户从1000U重新开始。该操作不能撤销。</p>
        {blocked&&<p className="fr-note">当前不能重置：请先关闭实盘，并确认没有本系统实盘持仓或待成交订单。</p>}
        <div className="fr-owner-session">
          <button className="fr-button" type="button" disabled={busy||blocked} onClick={()=>void reset()}>{busy?"正在原子重置…":"确认重置为1000U"}</button>
          <button className="fr-text-button" type="button" disabled={busy} onClick={()=>setConfirming(false)}>取消</button>
        </div>
      </div>}
  </section>;
}
