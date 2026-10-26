"use client";
/** 运行日志存储进度 + 上次导出 + 最晚导出时间。只读 /api/forward/log-status，不参与任何交易。长期归档已去掉，只留最近 1200 条。 */
import {useEffect,useRef} from "react";
import {BEIJING_TIME_ZONE} from "../lib/beijing-time.ts";
import type {RunLogCapacity} from "../lib/run-log-capacity.ts";
import {usePanel} from "../lib/panel-cache.ts";
import {PANEL_KEYS,fetchLogStatus,persistLogStatus} from "../lib/system-panels.ts";
import PanelStamp from "./panel-stamp.tsx";
import "./run-log-status.css";

export type ArchiveInfo={healthy:boolean;error:string|null;loaded:boolean;backfillDone:boolean;pending:number;schemaReady?:boolean;
  stats:{records:number;bytes:number;firstOpenedAt:number|null;lastOpenedAt:number|null};lastExport:{at:number;mode:string;rows:number}|null;
  lastOkAt:number|null;pendingExport?:number|null;segmentSize?:number;rowWritesToday?:number;budgetPerDay?:number};
type Status=RunLogCapacity&{pathsReady?:boolean;archive?:ArchiveInfo};
const when=(v:number|null|undefined)=>{
  if(!v)return "—";
  const p=Object.fromEntries(new Intl.DateTimeFormat("zh-CN",{timeZone:BEIJING_TIME_ZONE,month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false})
    .formatToParts(new Date(v)).map(x=>[x.type,x.value]));
  return `${p.month}月${p.day}日 ${p.hour}:${p.minute}`;
};
const hours=(h:number)=>h<1?"不到 1 小时":h<48?`约 ${Math.round(h)} 小时`:`约 ${Math.floor(h/24)} 天 ${Math.round(h%24)} 小时`;
const mb=(b:number)=>(b/1024/1024).toFixed(1);

export function RunLogStatusView({status,scope,stamp}:{status:Status|null;scope?:string;stamp?:React.ReactNode}){
  void scope;
  if(!status)return <div className="rl-status" aria-busy="true"><p className="rl-muted">正在读取存储进度…</p></div>;
  const p=status.primary,b=status.binding,exported=status.lastExportAt!=null;
  // After an export the book stays full (oldest go first); what matters is how much room the rows since the export use.
  const used=p?(exported?p.sinceBase:p.stored):0,usedPct=p?(exported?p.pendingPct:p.usedPct):0;
  const level=usedPct>=90||status.overdue?"is-bad":usedPct>=70?"is-warn":"is-ok";
  const deadlineText=status.deadline==null?"最近几乎没有新记录，暂时不用导出"
    :status.overdue?"现在就导出（已经开始挤掉旧记录）":`${when(status.deadline)} · 还剩${hours(status.hoursLeft??0)}`;
  const safeText=status.deadline==null||status.overdue?null:status.safeAt!=null&&status.safeAt<=status.now+60_000?"现在导出":`${when(status.safeAt)} 前`;
  const others=status.classes.filter(c=>c.key!==p?.key&&c.kind==="count"&&c.usedPct>=50);
  return <div className="rl-status" data-testid="run-log-status">
    {p&&<div className="rl-meter">
      <div className="rl-meter-head"><span>存储进度</span><b>{exported?"导出后新增":"已存"} {used.toLocaleString("en-US")} / {p.cap.toLocaleString("en-US")} 条 · {usedPct.toFixed(0)}%</b></div>
      <div className={`rl-bar ${level}`} role="progressbar" aria-valuemin={0} aria-valuemax={p.cap} aria-valuenow={used}><i style={{width:`${Math.min(100,usedPct)}%`}}/></div>
      {exported&&<small className="rl-muted rl-sub">现在共存 {p.stored.toLocaleString("en-US")} 条，满 {p.cap.toLocaleString("en-US")} 条后从最早的挤掉</small>}
    </div>}
    <dl className="rl-kv">
      <div><dt>上次导出</dt><dd>{status.lastExportAt?<>{when(status.lastExportAt)}{status.lastExportRows!=null&&<small> · {status.lastExportRows} 条</small>}</>:<span className="rl-muted">还没有导出记录</span>}</dd></div>
      <div><dt>最晚导出</dt><dd className={status.overdue?"rl-bad":undefined}>{deadlineText}</dd></div>
      {safeText&&<div><dt>建议导出</dt><dd className="rl-good">{safeText}</dd></div>}
    </dl>
    <p className="rl-muted rl-foot">
      {b?.ratePerHour!=null&&b.kind==="count"?`按最近每小时约 ${b.ratePerHour} 条估算；`:""}
      {b?`最先到上限的是「${b.label}」${b.kind==="window"?`（只带最近 ${b.cap} 天）`:""}。`:""}
      {status.lastExportAt?"从上次导出之后新写的记录算。":"还没导出过，从现在存着的最早一条算。"}
      {others.map(c=>` ${c.label} ${c.stored}/${c.cap}。`).join("")}
      {status.hot?` 账户热存储 ${mb(status.hot.rawBytes)} / ${mb(status.hot.budgetBytes)} MB（满了会停写，不会删记录）。`:""}
    </p>
    {stamp}
  </div>;
}

export default function RunLogStatus({refreshKey,scope="owner"}:{refreshKey:number;scope?:string}){
  const panel=usePanel<Status>(scope,PANEL_KEYS.logStatus,fetchLogStatus<Status>,{persist:persistLogStatus,every:60_000});
  // An export just finished: read the new progress now instead of waiting for the minute tick.
  const seen=useRef(refreshKey),refresh=panel.refresh;
  useEffect(()=>{if(seen.current===refreshKey)return;seen.current=refreshKey;void refresh().catch(()=>undefined);},[refreshKey,refresh]);
  if(panel.failed&&!panel.value)return <div className="rl-status"><p className="rl-muted">存储进度暂时读不到，不影响导出。</p></div>;
  return <RunLogStatusView status={panel.value} scope={scope}
    stamp={<PanelStamp at={panel.at} refreshing={panel.refreshing} failed={panel.failed}/>}/>;
}
