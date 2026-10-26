"use client";

import {memo} from "react";
import {type forwardSummary} from "../lib/forward-relations.ts";
import {BRAIN_EXIT,pct,plain,type BrainMode,type BrainStatus} from "../lib/brain-view.ts";
import {Coin,safePnl,held,signed,tone,stamp} from "./market-intelligence-execution.tsx";
import PanelStamp from "./panel-stamp.tsx";
import "./market-brain.css";

type View=ReturnType<typeof forwardSummary>;
type Trade=View["positions"][number];
type LiveOverview={operational:boolean;lastSyncAt:number|null;positionCount:number};

/** Price move of the coin, not ROE. */
function pxMove(side:string,entry:number|null|undefined,px:number|null|undefined){
  if(!(entry!=null&&entry>0)||px==null||!Number.isFinite(px))return null;
  return side==="SHORT"?(entry-px)/entry:(px-entry)/entry;
}
function exitText(t:Trade){
  const c=t.exitReason;if(!c)return "已平";
  return BRAIN_EXIT[c]??(c.includes("REV")?"反向止盈":c.includes("STOP")||c.includes("LIQ")?"打到止损":"已平");
}

/** Owner home. Paper only; the live switch is never touched here. The research read is not polled. */
type LivingProps={auth:AuthSession|null;scope?:string;data?:View|null;now?:number;liveEnabled?:boolean;liveOverview?:LiveOverview;
  healthy?:boolean;systemStatus?:string;feedAt?:number|null;floating?:number|null;onOpenOrders?:()=>void};
type AuthSession={authenticated?:boolean;username?:string;memberId?:string|null;role?:string};
const tradeKey=(t:Trade)=>`${t.id}|${t.status}|${t.lastPrice}|${t.quantity}|${t.netPnl}|${t.closedAt}|${t.stopPrice}|${t.exitReason}`;
export function sameLivingProps(a:LivingProps,b:LivingProps){
  if(a.auth!==b.auth||a.scope!==b.scope||a.liveEnabled!==b.liveEnabled||a.healthy!==b.healthy||a.systemStatus!==b.systemStatus
    ||a.floating!==b.floating||Math.floor((a.feedAt??0)/60_000)!==Math.floor((b.feedAt??0)/60_000)
    ||Math.floor((a.now??0)/60_000)!==Math.floor((b.now??0)/60_000))return false;
  const lo=(o?:LiveOverview)=>o?`${o.operational}|${o.positionCount}|${o.lastSyncAt}`:"";
  if(lo(a.liveOverview)!==lo(b.liveOverview))return false;
  if(!!a.data!==!!b.data)return false;
  const rows=(d?:View|null)=>d?`${(d.positions??[]).map(tradeKey).join(";")}#${(d.history??[]).length}:${(d.history??[]).slice(-1).concat((d.history??[]).slice(0,1)).map(tradeKey).join(";")}`:"";
  return rows(a.data)===rows(b.data);
}
export default memo(LivingPanel,sameLivingProps);
function LivingPanel({auth,scope="owner",data=null,now=0,liveEnabled=false,liveOverview,healthy,systemStatus,feedAt,floating,onOpenOrders}:{
  auth:AuthSession|null;scope?:string;data?:View|null;now?:number;liveEnabled?:boolean;liveOverview?:LiveOverview;
  healthy?:boolean;systemStatus?:string;feedAt?:number|null;floating?:number|null;onOpenOrders?:()=>void;
}){
  const owner=Boolean(auth?.authenticated&&auth.username==="owner"&&!auth.memberId&&auth.role!=="member");
  if(!owner)return null;
  void scope;void onOpenOrders;
  return <BrainBody s={null} data={data} now={now} liveEnabled={liveEnabled} liveOverview={liveOverview} healthy={healthy} systemStatus={systemStatus}
    feedAt={feedAt} floating={floating} busy={false} error={null} stamp={{at:data?.updatedAt??feedAt??null,refreshing:false,failed:false}}
    setMode={()=>{}} setItem={()=>{}}/>;
}
type BodyProps={s:BrainStatus|null|undefined;data?:View|null;now?:number;liveEnabled?:boolean;liveOverview?:LiveOverview;healthy?:boolean;systemStatus?:string;
  feedAt?:number|null;floating?:number|null;onOpenOrders?:()=>void;busy:boolean;error:string|null;stamp:{at:number|null;refreshing:boolean;failed:boolean};
  setMode:(m:BrainMode)=>void;setItem:(key:string,on:boolean)=>void};
/** Fixed reverse hold. Positions and the last closes only — no playbook board, no history download, no mode switches. */
export function BrainBody({data=null,now=0,liveEnabled=false,liveOverview,healthy,systemStatus,feedAt,floating,error,stamp:st}:BodyProps){
  const positions=[...(data?.positions??[])].filter(t=>!t.inverseCopy);
  const recent=[...(data?.history??[])].filter(t=>!t.inverseCopy).sort((a,b)=>(b.closedAt??0)-(a.closedAt??0)).slice(0,8);
  const clockNow=now||data?.updatedAt||0;
  const liveText=!liveEnabled?"关闭":liveOverview?.operational?"运行中":"核对中";
  return <div className="mb pg-exec bs" data-testid="owner-living-research">
    <section className="pg-card bs-scheme" data-testid="brain-scheme">
      <strong className="pg-title">{data||st.at?"反向持仓":st.failed?"读取失败":"读取中"}</strong>
      <p className="mb-hint">新单走信号的反方向。止盈和止损都放在原来那个止损距离上，到一边就平。实盘关着。历史不再下载，打法不再重算。</p>
    </section>
    {error&&<p className="mb-hint mb-warn" role="alert">{error}</p>}
    <PanelStamp at={st.at} refreshing={st.refreshing} failed={st.failed}/>

    <div className="pg-tiles" data-testid="execution-status">
      <div><small>实盘</small><b className={liveEnabled&&liveOverview?.operational?"fr-positive":undefined}>{liveText}</b><p>{!liveEnabled?"只跑模拟，不下单":`实盘持仓 ${liveOverview?.positionCount??0} 笔`}</p></div>
      <div><small>模拟持仓</small><b>{data?`${positions.length} 笔`:"—"}</b><p className={tone(floating)}>{positions.length?`浮动 ${signed(floating)} U`:"空仓"}</p></div>
      <div><small>系统</small><b className={healthy?"fr-positive":healthy===false?"fr-negative":undefined}>{systemStatus??"—"}</b><p>行情 {feedAt?new Date(feedAt).toLocaleTimeString("zh-CN",{hour12:false,timeZone:"Asia/Shanghai"}):"—"}</p></div>
    </div>

    <section className="pg-section" data-testid="execution-positions">
      <h2>正在持仓<small>{positions.length} 笔</small></h2>
      {positions.length?<div className="pg-list">{positions.map(t=>{const u=safePnl(t),mv=pxMove(t.side,t.entryPrice,t.lastPrice);return <article className="pg-row" key={t.id}>
        <div className="oc-line"><Coin symbol={t.symbol} side={t.side}/><b className={`oc-pnl ${tone(mv)}`}>价格 {pct(mv)}</b></div>
        <div className="oc-line oc-sub"><span className={tone(u)}>{signed(u)} U</span><span>止损 {plain(t.stopPrice)} · 已拿 {held(t.openedAt,clockNow)||"—"}</span></div>
      </article>;})}</div>:<div className="pg-empty">现在空仓。有信号就按反向持仓开模拟单。</div>}
    </section>

    <section className="pg-section" data-testid="brain-recent">
      <h2>最近平仓<small>{recent.length} 笔</small></h2>
      {recent.length?<div className="pg-recent">{recent.map(t=>{const mv=pxMove(t.side,t.entryPrice,t.exitPrice);return <div key={t.id}>
        <span><Coin symbol={t.symbol} side={t.side}/><small>{exitText(t)} · 价格 {pct(mv)} · {stamp(t.closedAt)}</small></span>
        <strong className={tone(t.netPnl)}>{signed(t.netPnl)} U<small>{held(t.openedAt,t.closedAt)}</small></strong>
      </div>;})}</div>:<p className="mb-hint">还没有平仓。</p>}
    </section>
  </div>;
}
