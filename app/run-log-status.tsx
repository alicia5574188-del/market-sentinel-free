"use client";
/** 运行日志存储进度 + 上次导出 + 最晚导出时间 + 长期归档导出。只读 /api/forward/log-status 和 /api/forward/archive-export，不参与任何交易。 */
import {useEffect,useState} from "react";
import {BEIJING_TIME_ZONE} from "../lib/beijing-time.ts";
import type {RunLogCapacity} from "../lib/run-log-capacity.ts";
import "./run-log-status.css";

export type ArchiveInfo={healthy:boolean;error:string|null;loaded:boolean;backfillDone:boolean;pending:number;schemaReady?:boolean;
  stats:{records:number;bytes:number;firstOpenedAt:number|null;lastOpenedAt:number|null};lastExport:{at:number;mode:string;rows:number}|null;
  lastOkAt:number|null;pendingExport?:number|null;segmentSize?:number;rowWritesToday?:number;budgetPerDay?:number};
type Status=RunLogCapacity&{pathsReady?:boolean;archive?:ArchiveInfo};
type Mode="since"|"range"|"all";
type Plan={total:number;segments:number};
const MODE_LABEL:Record<Mode,string>={since:"接着上次导",range:"按时间段",all:"全部"};
const BJ=8*60*60_000;
/** datetime-local 里填的是北京时间 */
export const beijingInputToMs=(v:string)=>{const t=Date.parse(`${v}:00Z`);return Number.isFinite(t)?t-BJ:null;};
const msToBeijingInput=(ms:number)=>new Date(ms+BJ).toISOString().slice(0,16);
const archiveState=(a:ArchiveInfo)=>a.healthy?{cls:"is-ok",text:"正常"}:a.error?{cls:"is-bad",text:"出错"}
  :!a.loaded?{cls:"is-warn",text:"准备中"}:{cls:"is-warn",text:a.backfillDone?"落后":"补存中"};
const when=(v:number|null|undefined)=>{
  if(!v)return "—";
  const p=Object.fromEntries(new Intl.DateTimeFormat("zh-CN",{timeZone:BEIJING_TIME_ZONE,month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false})
    .formatToParts(new Date(v)).map(x=>[x.type,x.value]));
  return `${p.month}月${p.day}日 ${p.hour}:${p.minute}`;
};
const hours=(h:number)=>h<1?"不到 1 小时":h<48?`约 ${Math.round(h)} 小时`:`约 ${Math.floor(h/24)} 天 ${Math.round(h%24)} 小时`;
const mb=(b:number)=>(b/1024/1024).toFixed(1);

export function RunLogStatusView({status}:{status:Status|null}){
  if(!status)return <div className="rl-status" aria-busy="true"><p className="rl-muted">正在读取存储进度…</p></div>;
  const p=status.primary,b=status.binding,exported=status.lastExportAt!=null;
  // After an export the book stays full (oldest go first); what matters is how much room the rows since the export use.
  const used=p?(exported?p.sinceBase:p.stored):0,usedPct=p?(exported?p.pendingPct:p.usedPct):0;
  const level=usedPct>=90||status.overdue?"is-bad":usedPct>=70?"is-warn":"is-ok";
  const deadlineText=status.deadline==null?"最近几乎没有新记录，暂时不用导出"
    :status.overdue?"现在就导出（已经开始挤掉旧记录）":`${when(status.deadline)} · 还剩${hours(status.hoursLeft??0)}`;
  const safeText=status.deadline==null||status.overdue?null:status.safeAt!=null&&status.safeAt<=status.now+60_000?"现在导出":`${when(status.safeAt)} 前`;
  const archive=status.archive,archiveOk=!!archive?.healthy;
  const others=status.classes.filter(c=>c.key!==p?.key&&c.kind==="count"&&c.usedPct>=50);
  return <div className="rl-status" data-testid="run-log-status">
    {p&&<div className="rl-meter">
      <div className="rl-meter-head"><span>存储进度</span><b>{exported?"导出后新增":"已存"} {used.toLocaleString("en-US")} / {p.cap.toLocaleString("en-US")} 条 · {usedPct.toFixed(0)}%</b></div>
      <div className={`rl-bar ${level}`} role="progressbar" aria-valuemin={0} aria-valuemax={p.cap} aria-valuenow={used}><i style={{width:`${Math.min(100,usedPct)}%`}}/></div>
      {exported&&<small className="rl-muted rl-sub">现在共存 {p.stored.toLocaleString("en-US")} 条，满 {p.cap.toLocaleString("en-US")} 条后从最早的挤掉</small>}
    </div>}
    <dl className="rl-kv">
      <div><dt>上次导出</dt><dd>{status.lastExportAt?<>{when(status.lastExportAt)}{status.lastExportRows!=null&&<small> · {status.lastExportRows} 条</small>}</>:<span className="rl-muted">还没有导出记录</span>}</dd></div>
      {archiveOk
        ?<div><dt>最晚导出</dt><dd className="rl-good">不用赶了 · 已自动存进长期归档</dd></div>
        :<>
          <div><dt>最晚导出</dt><dd className={status.overdue?"rl-bad":undefined}>{deadlineText}</dd></div>
          {safeText&&<div><dt>建议导出</dt><dd className="rl-good">{safeText}</dd></div>}
          {archive&&<div><dt>长期归档</dt><dd className={archive.error?"rl-bad":"rl-warn"}>{archive.error?`出错，没在存：${archive.error.slice(0,80)}`
            :!archive.loaded?"还没开始，先按上面的时间导出":`还有 ${archive.pending} 条没存进去，先按上面的时间导出`}</dd></div>}
        </>}
    </dl>
    <p className="rl-muted rl-foot">
      {b?.ratePerHour!=null&&b.kind==="count"?`按最近每小时约 ${b.ratePerHour} 条估算；`:""}
      {b?`最先到上限的是「${b.label}」${b.kind==="window"?`（只带最近 ${b.cap} 天）`:""}。`:""}
      {status.lastExportAt?"从上次导出之后新写的记录算。":"还没导出过，从现在存着的最早一条算。"}
      {others.map(c=>` ${c.label} ${c.stored}/${c.cap}。`).join("")}
      {status.hot?` 账户热存储 ${mb(status.hot.rawBytes)} / ${mb(status.hot.budgetBytes)} MB（满了会停写，不会删记录）。`:""}
    </p>
    {archive&&<RunLogArchiveView archive={archive}/>}
  </div>;
}

/** 长期归档：统计 + 三种导出方式 + 分段下载。 */
export function RunLogArchiveView({archive,initialMode="since",initialPlan=null,initialDone=[]}:{archive:ArchiveInfo;initialMode?:Mode;initialPlan?:Plan|null;initialDone?:number[]}){
  const [mode,setModeRaw]=useState<Mode>(initialMode);
  const [from,setFromRaw]=useState(()=>msToBeijingInput(Date.now()-7*24*60*60_000)),[to,setToRaw]=useState(()=>msToBeijingInput(Date.now()));
  const [plan,setPlan]=useState<Plan|null>(initialPlan),[done,setDone]=useState<number[]>(initialDone);
  const [busy,setBusy]=useState<number|null>(null),[msg,setMsg]=useState<string|null>(null);
  // A new mode or time range starts from a clean plan (done in the change handlers, not in the effect).
  const resetFor=(nextMode:Mode)=>{if(initialPlan&&nextMode===initialMode)return;setPlan(null);setDone([]);setMsg(null);};
  const setMode=(m:Mode)=>{if(m===mode)return;resetFor(m);setModeRaw(m);};
  const setFrom=(v:string)=>{if(v===from)return;resetFor(mode);setFromRaw(v);};
  const setTo=(v:string)=>{if(v===to)return;resetFor(mode);setToRaw(v);};
  const range=mode==="range"?{from:beijingInputToMs(from),to:beijingInputToMs(to)}:null;
  const badRange=!!range&&(range.from==null||range.to==null||range.to<=range.from);
  const query=()=>{const q=new URLSearchParams({mode});if(range&&!badRange){q.set("from",String(range.from));q.set("to",String(range.to));}return q;};
  useEffect(()=>{
    if(initialPlan&&mode===initialMode)return;
    if(badRange)return;
    let alive=true;
    const q=query();q.set("count","1");q.set("t",String(Date.now()));
    fetch(`/api/forward/archive-export?${q}`,{cache:"no-store",credentials:"same-origin"})
      .then(async r=>{const body=await r.json() as Plan&{error?:string};if(!r.ok)throw new Error(body.error??"读取失败");if(alive)setPlan({total:body.total,segments:body.segments});})
      .catch(e=>{if(alive)setMsg(`读不到归档：${e instanceof Error?e.message:"未知错误"}`);});
    return()=>{alive=false;};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[mode,from,to]);
  const download=async(k:number)=>{
    if(!plan)return;setBusy(k);setMsg(null);
    try{
      const q=query();if(mode==="since")q.set("label",`${k}/${plan.segments}`);else q.set("segment",String(k));
      const r=await fetch(`/api/forward/archive-export?${q}`,{cache:"no-store",credentials:"same-origin"});
      const body=await r.json() as {error?:string;archive?:{file_name?:string;cursor_advanced?:boolean;segment_rows?:number}};
      if(!r.ok)throw new Error(body.error??"导出失败");
      const blob=new Blob([JSON.stringify(body,null,2)],{type:"application/json"}),href=URL.createObjectURL(blob),a=document.createElement("a");
      a.href=href;a.download=body.archive?.file_name??`lsr-run-log-archive-${mode}-seg${k}.json`;document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(href),5_000);
      setDone(d=>[...d,k]);
      if(mode==="since"&&body.archive?.cursor_advanced===false)setMsg("文件已下载，但没登录，起点没有往后挪。");
    }catch(e){setMsg(`第 ${k} 段没导出成功：${e instanceof Error?e.message:"未知错误"}${mode==="since"?"（起点没动，可以重试）":""}`);}
    finally{setBusy(null);}
  };
  const st=archiveState(archive),s=archive.stats,size=archive.segmentSize??500;
  const nextSince=mode==="since"&&plan?Array.from({length:plan.segments},(_,i)=>i+1).find(k=>!done.includes(k))??null:null;
  return <section className="rl-archive" data-testid="run-log-archive">
    <div className="rl-archive-head"><b>长期归档</b><small className="rl-muted">不限条数，和账户存储分开</small><span className={`rl-pill ${st.cls}`}>{st.text}</span></div>
    <dl className="rl-kv">
      <div><dt>已存</dt><dd>{s.records.toLocaleString("en-US")} 条<small> · 约 {mb(s.bytes)} MB</small></dd></div>
      <div><dt>时间范围</dt><dd>{s.firstOpenedAt?<>{when(s.firstOpenedAt)} — {when(s.lastOpenedAt)}</>:<span className="rl-muted">还没有记录</span>}</dd></div>
      <div><dt>上次归档导出</dt><dd>{archive.lastExport?<>{when(archive.lastExport.at)}<small> · {MODE_LABEL[archive.lastExport.mode as Mode]??archive.lastExport.mode} · {archive.lastExport.rows} 条</small></>:<span className="rl-muted">还没有</span>}</dd></div>
      {archive.pendingExport!=null&&<div><dt>没导出过</dt><dd>{archive.pendingExport.toLocaleString("en-US")} 条</dd></div>}
    </dl>
    <div className="rl-seg" role="tablist">
      {(Object.keys(MODE_LABEL) as Mode[]).map(m=><button key={m} type="button" role="tab" aria-selected={mode===m} className={mode===m?"is-on":undefined} onClick={()=>setMode(m)}>{MODE_LABEL[m]}</button>)}
    </div>
    {mode==="range"&&<div className="rl-range">
      <label>从<input type="datetime-local" value={from} onChange={e=>setFrom(e.target.value)}/></label>
      <label>到<input type="datetime-local" value={to} onChange={e=>setTo(e.target.value)}/></label>
      <small className="rl-muted">北京时间，按开仓/信号时间筛</small>
    </div>}
    <p className="rl-plan">{badRange?<span className="rl-bad">结束时间要晚于开始时间</span>
      :!plan?<span className="rl-muted">{msg?"":"正在算条数…"}</span>
      :plan.total===0?<span className="rl-muted">{mode==="since"?"上次之后没有新记录":"这段时间没有记录"}</span>
      :<>共 <b>{plan.total.toLocaleString("en-US")}</b> 条，分 {plan.segments} 段（每段最多 {size} 条）</>}</p>
    {plan&&plan.segments>0&&<div className="rl-parts">
      {Array.from({length:plan.segments},(_,i)=>i+1).map(k=>{
        const isDone=done.includes(k),locked=mode==="since"&&k!==nextSince;
        return <button key={k} type="button" className={isDone?"is-done":undefined} disabled={busy!=null||locked} onClick={()=>void download(k)}>
          {busy===k?"导出中…":`第 ${k} / ${plan.segments} 段`}{isDone?" ✓":""}</button>;
      })}
    </div>}
    {msg&&<p className="rl-bad rl-msg">{msg}</p>}
    <p className="rl-muted rl-foot">{mode==="since"?"按顺序一段一段导；每段成功下载后起点才往后挪，失败了起点不动。"
      :mode==="range"?"每段是一个完整文件，字段和上面的导出一样，可以按 id 合并。":"把归档里所有记录按开仓时间分段导出。"}</p>
  </section>;
}

export default function RunLogStatus({refreshKey}:{refreshKey:number}){
  const [status,setStatus]=useState<Status|null>(null),[failed,setFailed]=useState(false);
  useEffect(()=>{
    let alive=true;
    const load=async()=>{try{
      const r=await fetch(`/api/forward/log-status?t=${Date.now()}`,{cache:"no-store",credentials:"same-origin"});
      if(!r.ok)throw new Error("status");const next=await r.json() as Status;if(alive){setStatus(next);setFailed(false);}
    }catch{if(alive)setFailed(true);}};
    void load();const id=setInterval(load,60_000);
    return()=>{alive=false;clearInterval(id);};
  },[refreshKey]);
  if(failed&&!status)return <div className="rl-status"><p className="rl-muted">存储进度暂时读不到，不影响导出。</p></div>;
  return <RunLogStatusView status={status}/>;
}
