"use client";

import {useRef,useState} from "react";
import {operatorRequest, type AuthSession, type OperatorRuntime} from "../lib/operator-ui.ts";

type ResetResult={ok:boolean;status?:"DONE"|"PENDING"|"ALREADY_PENDING";open?:number;equity:number;
  pending?:{requestedAt:number}|null;forward?:{startedAt:number;initialEquity:number}};
type CancelResult={ok:boolean;cancelled:boolean};

export default function PaperAccountReset({auth,runtime,onReset}:{auth:AuthSession|null;runtime:OperatorRuntime|null;onReset:()=>void}){
  const owner=Boolean(auth?.authenticated&&auth.username==="owner"&&!auth.memberId&&auth.role!=="member");
  const submitting=useRef(false);
  const [confirming,setConfirming]=useState(false),[busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  if(!owner)return null;

  const live=runtime?.live;
  const openLive=Object.values(live?.positions??{}).filter(p=>p?.status==="OPEN").length;
  const pendingLive=Object.values(live?.entries??{}).filter(e=>e&&!["FILLED","CANCELLED","FINISHED","REJECTED"].includes(e.status)).length;
  const blocked=!runtime||Boolean(runtime.liveMode.requestedEnabled||runtime.liveMode.operational||openLive||pendingLive);
  const openPaper=runtime?.forward?.positions?.length??0;
  const pending=runtime?.forward?.pendingFundsReset??null;

  const refresh=()=>{
    // Server confirmation is authoritative. A Safari/UI refresh problem after
    // success must never be misreported as a failed financial reset.
    try{onReset();}catch{/* periodic runtime refresh will reconcile the page */}
  };
  const reset=async()=>{
    if(submitting.current||busy||blocked)return;
    submitting.current=true;setBusy(true);setError(null);setNotice(null);
    try{
      const result=await operatorRequest<ResetResult>("/api/paper/reset","POST",{confirm:"RESET_PAPER"});
      if(!result.ok)throw new Error("服务器没有确认资金重置。");
      if(result.status==="PENDING"||result.status==="ALREADY_PENDING"){
        setConfirming(false);
        setNotice(`重置已预约：等到没有持仓时自动执行（当前 ${result.open??openPaper} 单）。期间照常开平仓，不会强平。`);
      }else{
        if(result.equity!==1000)throw new Error("服务器没有确认新的1000U资金，未发布重置结果。");
        setConfirming(false);
        setNotice("模拟账户资金已重置为1000U；页面权益曲线和开单记录从现在重新开始。运行日志只留最近 1200 条，价格路径、阶段时间线和导出进度都保留。");
      }
      refresh();
    }catch(e){setError(e instanceof Error?e.message:"模拟账户重置失败");}
    finally{submitting.current=false;setBusy(false);}
  };
  const cancel=async()=>{
    if(submitting.current||busy)return;
    submitting.current=true;setBusy(true);setError(null);setNotice(null);
    try{
      const result=await operatorRequest<CancelResult>("/api/paper/reset/cancel","POST",{confirm:"CANCEL_PAPER_RESET"});
      if(!result.ok)throw new Error("服务器没有确认取消。");
      setNotice(result.cancelled?"已取消预约的资金重置。":"没有待执行的资金重置。");
      refresh();
    }catch(e){setError(e instanceof Error?e.message:"取消失败");}
    finally{submitting.current=false;setBusy(false);}
  };

  return <section className="fr-section" data-testid="owner-paper-reset">
    <div className="fr-section-head"><h2>模拟账户重置</h2><b>{pending?"已预约":runtime?.forward?.initialEquity===1000?"1000U基准":"账户维护"}</b></div>
    {error&&<div className="fr-error" role="alert"><b>重置未完成</b><p>{error}</p></div>}
    {notice&&<div className="fr-notice" role="status">{notice}</div>}
    {pending?<div className="fr-form" data-testid="paper-reset-pending">
        <p className="fr-note"><b>重置已预约：等到没有持仓时自动执行（当前 {openPaper} 单）</b><br/>期间照常开平仓，不会强平；最后一单平掉、账户空仓的那一刻资金回到1000U。</p>
        <div className="fr-owner-session">
          <button className="fr-text-button" type="button" disabled={busy} onClick={()=>void cancel()}>{busy?"正在取消…":"取消预约"}</button>
        </div>
      </div>
      :!confirming?<button className="fr-button" type="button" disabled={busy} onClick={()=>{setError(null);setNotice(null);setConfirming(true);}}>重置模拟账户资金</button>
      :<div className="fr-form">
        <p className="fr-error"><b>确认重置？</b><br/>只重置页面上的三样：资金回到1000U、权益曲线从这里重新画、开单记录从这里重新记。系统不停，运行日志只留最近 1200 条（已开、没开、价格路径），阶段时间线和导出进度都保留。{openPaper?`现在有 ${openPaper} 单模拟持仓：不会强平，重置先预约，等到没有持仓时自动执行，期间照常开平仓。`:"现在没有持仓，会立刻执行。"}该操作不能撤销。</p>
        {blocked&&<p className="fr-note">当前不能重置：请先关闭实盘，并确认没有本系统实盘持仓或待成交订单。</p>}
        <div className="fr-owner-session">
          <button className="fr-button" type="button" disabled={busy||blocked} onClick={()=>void reset()}>{busy?"正在提交…":openPaper?"确认预约重置":"确认重置为1000U"}</button>
          <button className="fr-text-button" type="button" disabled={busy} onClick={()=>setConfirming(false)}>取消</button>
        </div>
      </div>}
  </section>;
}
