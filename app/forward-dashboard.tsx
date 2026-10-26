"use client";
import {realizedNetPnl,initialTradeNotional,remainingTradeFraction} from "../lib/trade-realization.ts";

import {useCallback,useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from "react";
import {BEIJING_TIME_ZONE} from "../lib/beijing-time.ts";
import {type Trade,type forwardSummary} from "../lib/forward-relations.ts";
import {purgeEquityBrowserCache} from "../lib/equity-browser-purge.ts";
import MarketIntelligenceExecution from "./market-intelligence-execution.tsx";
import LivingPanel from "./living-panel.tsx";
import type {AuthSession} from "../lib/operator-ui.ts";
import RunLogStatus from "./run-log-status.tsx";
import PanelStamp from "./panel-stamp.tsx";
import {readPanel,writePanel,type PanelEntry} from "../lib/panel-cache.ts";
import {PANEL_KEYS} from "../lib/system-panels.ts";
import {paperAccountView} from "../lib/paper-account-view.ts";

export const PAGE_CLOCK_MS=15_000;
type SystemSnap={healthy:boolean;status:string;feedAt:number|null;live:string;engine:string|null;storageOk:boolean|null};
import "./account-first.css";
import "./paid-fee.css";
import "./pages.css";
import {tradePaidNetPnl,pairedPaidView,type PaidPair} from "../lib/paid-fee-view.ts";
import type {ThesisPublic} from "../lib/thesis-view.ts";
import {OrderCard,exitShort,exitPlain,priceText,livingPlaybookLabel,type OrderFact} from "./order-card.tsx";
import {isLivingTrade,livingBoard,livingDetail,livingWhy} from "../lib/living-trade-view.ts";

type View=ReturnType<typeof forwardSummary>;
type Desk=NonNullable<View["forwardDesk"]>;
type Tab="execution"|"brain"|"paper"|"live"|"settings";
const fmt=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?v.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}):"—";
const signed=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?`${v>=0?"+":""}${fmt(v,d)}`:"—";
const time=(v?:number|null)=>v?new Date(v).toLocaleString("zh-CN",{timeZone:BEIJING_TIME_ZONE,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}):"—";
const duration=(start:number,end:number|null|undefined,now:number)=>{const m=Math.floor(Math.max(0,(end??now)-start)/60000);return m<1?"<1分钟":m>=60?`${Math.floor(m/60)}小时${m%60}分`:`${m}分钟`;};
const modeName=(mode:string)=>({RELATIVE:"相对异类",REVERSAL:"结构转变",CONTINUATION:"市场延续",SWING:"旧峰谷兼容",TREND_PULLBACK:"旧回调兼容",IMPULSE:"旧推进兼容",RELATION:"旧关系兼容",BREAKOUT:"旧突破兼容",RETEST:"旧回踩兼容",FAILED_BREAKOUT:"旧失败突破兼容",RANGE:"旧区域兼容",SHOCK:"旧突变兼容"}[mode]??mode);
const stageName=(stage?:string|null)=>stage==="SHOCK"?"同步爆发":stage==="TREND"?"趋势":stage==="ROTATION"?"轮动":stage==="TRANSITION"?"过渡":"没记下";
const afterEntryName=(state?:string|null)=>state==="CONFIRMED"?"已经走出成本":state==="FAILED"?"进场后没站住":"还没走出成本";
const peakGivebackName=(t:Trade)=>{
  const arm=t.exitAudit?.evidence?.armRate;
  if(arm===.05)return"浮盈到5%后吐回0.8个点";
  if(arm===.1)return"浮盈到10%后吐回1.5个点";
  return"浮盈回吐到线就走";
};
function entryFacts(t:Trade){
  const ctx=t.entryContext;
  if(!ctx||t.inverseCopy)return [];
  const lines:string[]=[];
  const note=ctx.stageNote,board=note?.liveStage??ctx.environment;
  const bits:string[]=[];
  if(note?.priorStage)bits.push(`上一阶段是${stageName(note.priorStage)}`);
  if(typeof note?.stageAgeMin==="number")bits.push(`这一阶段已经 ${Math.round(note.stageAgeMin)} 分钟`);
  lines.push(`开仓时盘面：${stageName(board)}${bits.length?`。${bits.join("，")}`:""}。只有同步爆发或趋势才会真正开仓。`);
  if(typeof ctx.sizeMultiple==="number"&&ctx.sizeMultiple>1)lines.push(`仓位：按原计算的 ${ctx.sizeMultiple} 倍开（同步爆发和趋势都是 5 倍；10-19 之前同步爆发是 10 倍）。`);
  if(ctx.environment&&note?.liveStage&&ctx.environment!==note.liveStage)
    lines.push(`这个机会出现时标成${stageName(ctx.environment)}，那是更早的标记。开仓那一刻盘面已经是${stageName(note.liveStage)}，所以开了。`);
  const path=ctx.coinPath;
  if(path?.label)lines.push(`开仓走势：${path.label}`);
  else lines.push("开仓走势：这笔开的时候还没记下。");
  const read=ctx.entryRead;
  if(read){
    const prior:string[]=[];
    if(read.withTrend===true)prior.push("顺着当时的全市场方向");
    else if(read.withTrend===false)prior.push("逆着当时的全市场方向");
    if(typeof read.move30==="number")prior.push(`开仓前 30 分钟，这笔方向已经走过 ${signed(read.move30*100)}%`);
    if(prior.length)lines.push(`开仓前：${prior.join("。")}。`);
  }
  if(ctx.strategyVersion==="market-intelligence-v1"){
    const extra=ctx.environment==="SHOCK"||ctx.environment==="TREND"||note?.liveStage==="SHOCK"||note?.liveStage==="TREND";
    lines.push(extra
      ?"额外出场：浮盈到过 5% 还没到 10%，从高点吐回 0.8 个点就走。到过 10%，改成吐回 1.5 个点才走。没碰到仍走原来的结构。"
      :"额外出场：开仓时盘面不是爆发或趋势，不使用 5% 和 10% 那两条，仍走原来的结构。");
  }
  return lines;
}
const exitName=(reason:string|null)=>reason?({LIQUIDATION:"爆仓",LIVING_STOP:"打到止损价",LIVING_FALLBACK_TIMEOUT:"大脑暂停期间到时间，兜底平仓",S1_TP:"S1 止盈 6%",S1_SL:"S1 止损",S1_TIME_6H:"S1 满 6 小时",S1_TIME_24H:"S1 满 24 小时",SHADOW_SOURCE_EXIT:"提案平仓",AFTER_PROFIT_LOSS:"浮盈后亏到0.6%就走",PEAK_GIVEBACK:"浮盈回吐到线就走",RHYTHM_BREAK:"自己的推进节奏断了",EXPECTANCY_EXIT:"到了这段行情的期望幅度就走",INVERSE_SOFT_LOSS_EXIT:"浮亏到线，提前平仓",DESK_SWEEP_EXIT:"打穿确认位",DESK_NO_PROGRESS_EXIT:"30分钟没走出成本",DESK_GIVEBACK_EXIT:"利润回吐一半",DESK_HORIZON_EXIT:"满90分钟",WINNER_STRUCTURE_EXIT:"有效结构保护",WINNER_THESIS_EXIT:"持续推动失效",RANGE_CENTER_EXIT:"回归目标兑现",STRUCTURE_STOP:"结构止损",PROFIT_GIVEBACK:"利润保护",THESIS_INVALIDATED:"交易假设失效",RELATIVE_EDGE_GONE:"相对优势消失",NO_POSITIVE_FEEDBACK:"长时间未获得正向反馈",MAX_HOLD:"最大持仓时间",ENTRY_FEEDBACK_FAILED:"旧入场反馈失败",OPPOSITE_EXTREMUM:"旧相反峰谷",TREND_DEATH:"旧趋势死亡",EXTREMUM_PROFIT_EXIT:"旧极值退出",NO_PROGRESS:"旧无进展",MARKET_FLIP:"旧市场翻转",RELATION_DEGRADED:"旧关系降级",SAMPLE_PATH_DIVERGED:"旧样本路径失配",SAMPLE_EDGE_EXHAUSTED:"旧样本优势耗尽",SAMPLE_MAX_HOLD:"旧样本最大持仓",TIME_DECAY:"旧持仓超时",OPPORTUNITY_REPLACED:"更优机会替换",STRUCTURAL_INTERRUPT_REVERSAL:"旧极端结构反转",SHOCK_REENTRY:"旧突变重新回区",FAST_STRUCTURE_FAILURE:"旧强结构快速失效",ACCOUNT_RESET:"手动重置",STRETCH_WRONG_EXIT:"反向到了 0.5%",STRETCH_GIVEBACK_EXIT:"利润吐回一半",STRETCH_TIME_EXIT:"满两小时",LSR_TP_EXIT:"止盈 0.30%",LSR_SL_EXIT:"止损 0.20%",LSR_BE_EXIT:"回到成本",LSR_TIME_EXIT:"满十五分钟",LSR_REVERSE_EXIT:"出现反向信号"}[reason]??reason):"—";
const exitLabel=(t:Trade)=>t.exitReason==="PEAK_GIVEBACK"?peakGivebackName(t):exitName(t.exitReason);
const stanceName=(stance?:string)=>stance==="REVERSE"?"反向":stance==="FLAT"?"先停":"正向";
const sessionName=(session?:string)=>session==="ASIA"?"亚盘":session==="EUROPE"?"欧盘":session==="US"?"美盘":"—";
const claimName=(kind?:string)=>kind==="CONTINUE"?"延续":kind==="SUSPECT"?"可疑":"不投票";

export default function ForwardDashboard({data,healthy,statusLabel,feedAt,error,livePanel,liveSystemPanel,liveEnabled,liveOverview,accountPanel,brainAuth,memberName,cacheScope="owner",cachedAt=null,onTabChange}:{
  data:View|null;healthy:boolean;statusLabel?:string;feedAt:number|null;error:string|null;livePanel:ReactNode;liveSystemPanel?:ReactNode;
  liveEnabled:boolean;liveOverview?:{equity:number|null;available:number|null;positionCount:number;operational:boolean;lastSyncAt:number|null;copied:number|null;eligible:number|null;missing:number|null;accountMark?:import('../lib/live-account-view.ts').LiveAccountMark|null;};
  accountPanel?:ReactNode;
  /** Owner only: the 大脑 tab replaces 执行 as the home tab. */
  brainAuth?:AuthSession|null;memberName?:string;cacheScope?:string;
  /** Set while the page shows the device snapshot (not yet a fresh read). */
  cachedAt?:number|null;
  /** Tells the page which tab is shown (it sets the home refresh cadence). */
  onTabChange?:(tab:Tab)=>void;
}){
  // The equity chart is gone; free the space its old browser copies still take on the phone.
  useEffect(()=>{purgeEquityBrowserCache();},[]);
  const brainHome=!!brainAuth;
  const [tab,setTab]=useState<Tab>(brainHome?"brain":"execution"),[now,setNow]=useState(0),[liveMounted,setLiveMounted]=useState(false);
  const [fontScale,setFontScale]=useState(()=>{if(typeof window==="undefined")return 92;try{const saved=Number(localStorage.getItem("sentinel-ui-font-scale-v1"));return saved>=70&&saved<=110?saved:92;}catch{return 92;}});
  const [exporting,setExporting]=useState(false),[exportStatus,setExportStatus]=useState<string|null>(null),[exportCount,setExportCount]=useState(0);
  const [historyShown,setHistoryShown]=useState(10);
  const scroll=useRef<Record<Tab,number>>({execution:0,brain:0,paper:0,live:0,settings:0});
  // Page clock: held times are shown in minutes, so a 15s tick is enough; second-level labels run their own timer.
  useEffect(()=>{const first=setTimeout(()=>setNow(Date.now()),0),id=setInterval(()=>setNow(Date.now()),PAGE_CLOCK_MS);return()=>{clearTimeout(first);clearInterval(id);};},[]);
  useLayoutEffect(()=>{window.scrollTo({top:tab==="live"?0:scroll.current[tab]??0,behavior:"auto"});},[tab]);
  useEffect(()=>{onTabChange?.(tab);},[tab,onTabChange]);
  const select=(next:Tab)=>{scroll.current[tab]=window.scrollY;if(next==="live")setLiveMounted(true);setTab(next);};
  const selectRef=useRef(select);
  useLayoutEffect(()=>{selectRef.current=select;});
  const openOrders=useCallback(()=>selectRef.current("paper"),[]);
  const fontVars:Record<string,string>={};for(let px=10;px<=64;px++)fontVars[`--fr-fs${px}`]=`${(px*fontScale/100).toFixed(2)}px`;
  const exportSnapshot=async()=>{if(exporting)return;setExporting(true);setExportStatus(null);try{
    const response=await fetch(`/api/forward/export?kind=log&t=${Date.now()}`,{cache:"no-store",credentials:"same-origin"});
    if(!response.ok)throw new Error("log");
    const log=await response.json() as {version?:string;exportedAt?:number;positions?:{opened_at?:number}[];cases?:unknown[];timeline?:unknown[];orders_from?:number|null;orders_to?:number|null;orders_archive_error?:string|null};
    const at=log.exportedAt??Date.now();
    const stamp=new Date(at+8*60*60*1000).toISOString().replace(/[-:]/g,"").slice(0,15);
    const blob=new Blob([JSON.stringify(log)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`living-run-log-${stamp}.json`;
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    const n=log.positions?.length??0,cases=log.cases?.length??0,rows=log.timeline?.length??0;
    const bj=(ms:number)=>{const d=new Date(ms+8*60*60*1000);return `${d.getUTCMonth()+1}月${d.getUTCDate()}日 ${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}`;};
    const span=log.orders_from!=null&&log.orders_to!=null?`，从 ${bj(log.orders_from)} 到 ${bj(log.orders_to)}（北京）`:"";
    const warn=log.orders_archive_error?"长期库这次没读到，这份只有手里还在的单。":"";
    setExportStatus(`已开始下载 ${a.download}。里面 ${n} 笔单${span}。${warn}${cases} 个研究案例、${rows} 段时间线（每段 10 分钟）。`);setExportCount(c=>c+1);
  }catch{setExportStatus("导出失败，请重试。");}finally{setExporting(false);}};

  const desk=data?.forwardDesk??null,positions=data?.positions??[],history=[...(data?.history??[])].sort((a,b)=>(b.closedAt??0)-(a.closedAt??0));
  const paperView=paperAccountView(desk,positions,liveEnabled),usingDesk=paperView.usingDesk&&!!desk;
  const stanceLabel=desk?.book==="lsr-v1"?"实验":desk?.book==="stretch-v1"?"新账":desk?.book==="reverse-v1"?"反向":desk?.book==="needle-v1"||desk?.book==="brain-v1"||desk?.book==="score-v1"||desk?.book==="read-v1"?"账户":stanceName(desk?.stance);
  const paperFloating=paperView.floating;
  const held=paperView.openCount;
  const paperHeld=positions.filter(t=>!t.inverseCopy).length;
  const liveHeld=liveOverview?.positionCount??0;
  const systemStatus=statusLabel==="后台运行中"?"正常":statusLabel?.startsWith("后台运行中 · ")?statusLabel.slice(8):statusLabel??(healthy?"正常":"行情恢复中");
  const accountEquity=usingDesk?desk.equity:data?.equity,
    accountPnl=usingDesk?desk.netPnl:data?.netPnl,
    accountBase=usingDesk?desk.initialEquity:data?.initialEquity;
  const drawdown=usingDesk?(desk.maxDrawdown==null?null:desk.maxDrawdown*100):data?data.maxDrawdown*100:null;
  const liveText=liveEnabled?liveOverview?.operational?"运行中":"核对中":"关闭";
  // System card: the last good values are kept on the device so a fresh app open shows them before the first runtime read.
  const [systemSnap]=useState<PanelEntry<SystemSnap>|null>(()=>readPanel<SystemSnap>(cacheScope,PANEL_KEYS.systemStatus));
  const engine=data?.engineVersion??data?.version??null,storageOk=data?!data.storage?.error:null,feedMinute=feedAt==null?null:Math.floor(feedAt/60_000);
  useEffect(()=>{
    if(!data||cachedAt)return;
    writePanel<SystemSnap>(cacheScope,PANEL_KEYS.systemStatus,{healthy,status:systemStatus,feedAt,live:liveText,engine,storageOk},v=>v);
  // Written once a minute or on any status change, not on every 10s feed tick.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[cacheScope,!!data,healthy,systemStatus,liveText,engine,storageOk,feedMinute,cachedAt]);
  const card:SystemSnap&{cached:boolean}=data||!systemSnap?{healthy,status:systemStatus,feedAt,live:liveText,engine,storageOk,cached:false}
    :{...systemSnap.value,cached:true};
  const nav:[Tab,string,string][]=[brainHome?["brain","◉","大脑"]:["execution","◉","执行"],["paper","⇄","模拟"],["live","◈","实盘"],["settings","⊙","系统"]];
  return <main className="fr-app" style={fontVars as CSSProperties} data-ui-version="market-intelligence-v1">
    <header className="fr-compact-header pg-head"><b>哨兵 · 市场智能系统</b><span>
      <i className={`pg-pill ${healthy?"is-ok":"is-warn"}`} role="status">{systemStatus}</i>
      <i className={`pg-pill ${liveEnabled?liveOverview?.operational?"is-ok":"is-warn":"is-off"}`}>实盘{liveText}</i>
      {memberName&&<i className="pg-pill is-plain">{memberName}</i>}</span></header>

    {tab==="brain"&&brainHome&&<LivingPanel auth={brainAuth??null} scope={cacheScope} data={data} now={now} liveEnabled={liveEnabled} liveOverview={liveOverview}
      healthy={healthy} systemStatus={systemStatus} feedAt={feedAt} floating={data?paperFloating:null} onOpenOrders={openOrders}/>}
    {tab==="execution"&&!brainHome&&<MarketIntelligenceExecution data={data} now={now} liveEnabled={liveEnabled} liveOverview={liveOverview}
      healthy={healthy} systemStatus={systemStatus} feedAt={feedAt} floating={data?paperFloating:null} onOpenOrders={()=>select("paper")}/>}

    {tab==="paper"&&<div className="pg-paper">
      <section className="fr-equity fr-overview-equity" data-testid="overview-equity-first" aria-label={usingDesk?`${stanceLabel}权益`:"模拟账户权益"}>
        <small>{usingDesk?`${stanceLabel}权益`:"模拟账户权益"} · USDT</small><strong>{fmt(accountEquity)}</strong>
        <div className={(accountPnl??0)>=0?"fr-positive":"fr-negative"}>{signed(accountPnl)} <span>U · {signed(accountPnl!=null&&accountBase?accountPnl/accountBase*100:null)}%</span></div>
        <footer><span>起点 {fmt(accountBase,0)} U</span><span>最大回撤 {fmt(drawdown)}%</span></footer>
        <p>更新 {time(data?.updatedAt)}{(usingDesk?desk.stale:data?.stalePositions)?" · 持仓估值待更新":""}</p>
      </section>
      <section className="fr-stats">
        <Stat label="当前持仓" value={data?`${held} 笔`:"—"} note={usingDesk?`已平 ${fmt(desk.resolved,0)} 笔`:`保证金 ${fmt(positions.reduce((n,t)=>n+t.margin,0),0)} U`}/>
        <Stat label="浮动盈亏" value={`${signed(data?paperFloating:null)} U`} note="已扣开仓费"/>
        <Stat label="已完成" value={usingDesk?`${fmt(desk.resolved,0)} 笔`:data?`${fmt(data.resolved,0)} 笔`:"—"} note={winNote(usingDesk?desk.wins:data?.wins,usingDesk?desk.resolved:data?.resolved)}/>
        <Stat label="已扣手续费" value={`${fmt(usingDesk?desk.fees:data?.fees)} U`} note={usingDesk?"决策账户成交费用":`成交额 ${fmt(data?.turnover,0)} U`}/>
      </section>
      {desk?.book==="lsr-v1"&&<LsrPulse desk={desk}/>}
      {usingDesk?<ForwardOrders desk={desk} now={now}/>:<><section className="fr-section" data-testid="forward-orders"><div className="fr-section-head"><h2>持仓</h2><span>{positions.length} 笔</span></div><TradeList trades={positions} now={now} empty="当前没有持仓。"/></section>
      <section className="fr-section" data-testid="forward-history"><div className="fr-section-head"><h2>历史订单</h2><span>{history.length} 笔</span></div><TradeList trades={history.slice(0,historyShown)} now={now} empty="还没有已平订单。"/>
        {history.length>historyShown&&<button type="button" className="pg-link" onClick={()=>setHistoryShown(n=>n+20)}>再显示 {Math.min(20,history.length-historyShown)} 笔（还有 {history.length-historyShown} 笔）</button>}</section></>}
    </div>}

    {tab==="settings"&&<div className="pg-system">
      <section className="pg-card" data-testid="system-status">
        <header><small>系统状态</small><i className={`pg-pill ${card.healthy?"is-ok":"is-warn"}`}>{card.status}</i></header>
        <dl className="pg-kv">
          <div><dt>行情更新</dt><dd>{time(card.feedAt)}</dd></div>
          <div><dt>实盘</dt><dd>{card.live}</dd></div>
          <div><dt>策略版本</dt><dd>{card.engine??"—"}</dd></div>
          <div><dt>数据保存</dt><dd className={card.storageOk===false?"fr-negative":card.storageOk?"fr-positive":undefined}>{card.storageOk==null?"—":card.storageOk?"正常":"异常"}</dd></div>
        </dl>
        {card.cached&&systemSnap&&<PanelStamp at={systemSnap.at} refreshing={true} failed={false}/>}
      </section>
      <section className="fr-section"><div className="fr-section-head"><h2>运行日志</h2></div>
        <p className="fr-note">开仓、没开仓的候选、行情和执行记录都在这一个文件里，复盘就用它。</p>
        <RunLogStatus refreshKey={exportCount} scope={cacheScope}/>
        <button className="fr-button" onClick={exportSnapshot} disabled={exporting}>{exporting?"正在导出…":"导出运行日志 ↗"}</button>{exportStatus&&<p className="fr-note">{exportStatus}</p>}</section>
      {liveSystemPanel}
      {accountPanel}
      <section className="fr-section fr-font-control"><div className="fr-section-head"><h2>界面字号</h2><b>{fontScale}%</b></div>
        <div className="fr-font-options">{[70,80,90,100,110].map(value=><button key={value} className={fontScale===value?"selected":""} onClick={()=>{setFontScale(value);try{localStorage.setItem("sentinel-ui-font-scale-v1",String(value));}catch{}}}>{value}%</button>)}</div></section>
    </div>}

    {liveMounted&&<div className="fr-live-panel-host" hidden={tab!=="live"}>{livePanel}</div>}
    {(error||data?.storage.error)&&<aside className="fr-error" role="alert"><b>运行提示</b><p>{data?.storage.error??error}</p></aside>}
    <nav className="fr-nav">{nav.map(([id,icon,label])=><button key={id} className={id===tab?"selected":""} onClick={()=>select(id)}><span>{icon}</span><b>{label}</b>{id==="paper"&&paperHeld>0&&<i>{paperHeld}</i>}{id==="live"&&liveHeld>0&&<i>{liveHeld}</i>}</button>)}</nav>
  </main>;
}

function LsrPulse({desk}:{desk:Desk}){
  const exp=desk.liveResearch?.experiment;
  return <section className="fr-section lsr-pulse" data-testid="lsr-pulse">
    <div className="fr-section-head"><h2>实验</h2><span>{exp?.running?"在跑":exp?"已停止":"还没开始"}</span></div>
    <b>{exp?.status??"实验还没记上第一笔。"}</b>
    <p className="fr-note">决策 {exp?.decisions??0} 次，开成 {exp?.opened??0} 笔，6 秒没成交 {exp?.cancelled??0} 笔，还在场上 {exp?.stillOpen??0} 笔。</p>
    <p className="fr-note">费用合计 {fmt(exp?.fees.total,4)} U。开仓手续费 {fmt(exp?.fees.openFee,4)}，平仓手续费 {fmt(exp?.fees.closeFee,4)}，滑点 {fmt(exp?.fees.slippage,4)}，资金费 {fmt(exp?.fees.funding,4)}。</p>
  </section>;
}
/** The only per-second label: its own 1s timer, so the rest of the page is not redrawn every second. */
function SecondsLeft({at}:{at:number}){
  const [t,setT]=useState(()=>Date.now());
  useEffect(()=>{const id=setInterval(()=>setT(Date.now()),1000);return()=>clearInterval(id);},[]);
  return <>{Math.max(0,Math.ceil((at-t)/1000))}</>;
}
function LsrResearch({desk}:{desk:Desk;now?:number}){
  const live=desk.liveResearch,a=live?.context,d=live?.decision,g=live?.analogy;
  const coin=(symbol?:string)=>symbol?symbol.replace("_"," / "):"";
  const side=(value?:"LONG"|"SHORT"|null)=>value==="LONG"?"做多":value==="SHORT"?"做空":"还没定";
  if(!live)return <section className="fr-section" data-testid="research-claims"><div className="fr-section-head"><h2>研究</h2></div><p>这一拍还没有扫完。</p></section>;
  return <>
    <section className="fr-section" data-testid="research-claims">
      <div className="fr-section-head"><h2>研究层正在运行</h2></div>
      <p>现在：{live.status}</p>
      <p>上一轮 {time(live.ts)}。扫了 {live.scanned} 个币，其中 {live.found} 个明显异常。</p>
      <p>下一轮 {time(live.nextAt)}，还差 <SecondsLeft at={live.nextAt}/> 秒。</p>
      <p>今天扫了 {live.today?.scans??0} 次，看过 {live.today?.symbols??0} 个异动币。做多 {live.today?.long??0} 次，做空 {live.today?.short??0} 次，观望 {live.today?.watch??0} 次。</p>
      <p className="fr-note">这些话都写在研究页上，不会下单。</p>
    </section>
    <section className="fr-section">
      <div className="fr-section-head"><h2>全市场最异常的 5 个</h2></div>
      {live.candidates.length?live.candidates.map(c=><p key={c.symbol}><b>{c.rank}. {coin(c.symbol)}</b><br/>{c.priceWords}<br/>{c.volumeWords}<br/>现价 {fmt(c.last,6)}</p>):<p>还没有排出来。</p>}
    </section>
    <section className="fr-section">
      <div className="fr-section-head"><h2>{a?`${coin(a.symbol)} 现在什么处境`:"现在什么处境"}</h2></div>
      {a?a.sections.map(section=><p key={section.title}><b>{section.title}</b><br/>{section.body}<br/>{section.conclusion}</p>):<p>还没有。</p>}
    </section>
    <section className="fr-section">
      <div className="fr-section-head"><h2>历史上类似的情况</h2><span>{g?.enough?`${g.count} 个`:"不够"}</span></div>
      {g?<>
        <p>{g.story}</p>
        {g.count>0&&<>
          <p>之后 1 小时：涨 {g.up} 次（{g.count?(g.up/g.count*100).toFixed(0):0}%），横着 {g.flat} 次（{g.count?(g.flat/g.count*100).toFixed(0):0}%），跌 {g.down} 次（{(g.downPct*100).toFixed(0)}%）。</p>
          <p>{g.lean}</p>
          {g.refs.slice(0,3).map((row,i)=><p key={`${row.symbol}-${row.similarity}-${row.o1h}`} className="fr-note">{i+1}. {coin(row.symbol)} 相似度 {(row.similarity*100).toFixed(0)}%，之后 1 小时 {row.o1h>=0?"涨":"跌"}了 {Math.abs(row.o1h*100).toFixed(2)}%</p>)}
          {g.caution&&<p>{g.caution}</p>}
          <p className="fr-note">最高相似度 {fmt(g.maxSim,2)}，最低 {fmt(g.minSim,2)}。低于 {fmt(g.threshold,2)} 的不算。{g.minSim>=0.95?"最低也很高，标准偏松。":g.minSim>0&&g.minSim<0.85?"最低贴着门槛。":""}</p>
        </>}
      </>:<p>还没有。</p>}
    </section>
    <section className="fr-section">
      <div className="fr-section-head"><h2>研究判断</h2><span>{d?d.level:"还没有"}</span></div>
      {d?<>
        <p><b>{d.headline}</b></p>
        {d.why.map(line=><p key={line}>{line}</p>)}
        <p><b>{d.level==="明确信号"?"打算这样做":"如果非要做，会是这样"}</b></p>
        <p>方向：{side(d.planSide)}</p>
        <p>进场价 {fmt(d.entry,6)}</p>
        <p>止损价 {fmt(d.stop,6)}（-{(d.stopPct*100).toFixed(2)}%）</p>
        <p>第一目标 {fmt(d.tp1,6)}（+{(d.tp1Pct*100).toFixed(2)}%）</p>
        <p>第二目标 {fmt(d.tp2,6)}（+{(d.tp2Pct*100).toFixed(2)}%）</p>
        <p>最长持仓 {d.holdText}</p>
        <p>{d.stopWhy}</p>
        <p>什么情况算看错：{d.invalidate.join("；")}。</p>
        {d.level==="观望"&&d.waitFor.length>0&&<>
          <p><b>等什么才动手</b></p>
          {d.waitFor.map(line=><p key={line}>{line}</p>)}
        </>}
        <p className="fr-note">上面是研究层的打算，不会下单。</p>
      </>:<p>还没有判断。</p>}
    </section>
    <section className="fr-section">
      <div className="fr-section-head"><h2>判断记录</h2><span>最多留 300 条</span></div>
      {live.log?.length?live.log.map(row=>{
        const later=!row.verdict?"1 小时后：等数据"
          :row.verdict==="当时没给方向"?"1 小时后：当时没给方向"
          :`1 小时后：实际${typeof row.laterRet==="number"?`${row.laterRet>=0?"涨":"跌"}了 ${Math.abs(row.laterRet*100).toFixed(2)}%`:""} ｜ 判断${row.verdict==="对"?"对":row.verdict==="错"?"错":"不明确"}`;
        return <p key={row.at} className="fr-note">{time(row.at)} {coin(row.symbol)} {row.level==="计划"?"明确信号":row.level}。{later}</p>;
      }):<p className="fr-note">刚开始记。同一币、同一个结论，5 分钟内不重复记。</p>}
    </section>
    <section className="fr-section" data-testid="research-experiment">
      <div className="fr-section-head"><h2>实验</h2><span>{!live.experiment?'还没开始':live.experiment.running?'在跑':'已停止'}</span></div>
      {!live.experiment?<p>正向实验还没记上第一笔。</p>:<>
        <p>{live.experiment.status}</p>
        <p>决策 {live.experiment.decisions} 次，开成 {live.experiment.opened} 笔，开单率 {(live.experiment.openRate*100).toFixed(0)}%。6 秒没成交 {live.experiment.cancelled} 笔。还在场上 {live.experiment.stillOpen} 笔。</p>
        <p>做多做空：{live.experiment.bySide.length?live.experiment.bySide.map(row=>`${row.side} ${row.n} 笔，赢 ${row.wins} 笔${row.rate==null?'':`，胜率 ${(row.rate*100).toFixed(0)}%`}`).join('。'):'还没有平仓。'}</p>
        <p>出场：{live.experiment.exits.map(row=>`${row.reason} ${row.n}`).join('，')}。</p>
        <p>按把握分档：{live.experiment.byConfidence.filter(row=>row.n>0).map(row=>`${row.bucket} ${row.n} 笔，胜率 ${row.rate==null?'—':`${(row.rate*100).toFixed(0)}%`}`).join('。')||'还没有平仓。'}</p>
        <p>费用：开仓手续费 {fmt(live.experiment.fees.openFee,4)} U，平仓手续费 {fmt(live.experiment.fees.closeFee,4)} U，滑点 {fmt(live.experiment.fees.slippage,4)} U，资金费 {fmt(live.experiment.fees.funding,4)} U。合计 {fmt(live.experiment.fees.total,4)} U{live.experiment.fees.share==null?'':`，占成交额 ${(live.experiment.fees.share*100).toFixed(3)}%`}。</p>
        {live.experiment.path.length>0&&<p className="fr-note">权益：{live.experiment.path.map(row=>`${time(row.at)} ${fmt(row.equity,2)}`).join(' → ')}</p>}
        {live.experiment.recent.map(row=><p key={`${row.at}-${row.symbol}-${row.status}`} className="fr-note">{time(row.at)} {row.symbol.replace('_',' / ')} {row.side} {row.status}{row.reason?` ${row.reason}`:''}{row.net==null?'':` ${row.net>=0?'+':''}${fmt(row.net,2)} U`}</p>)}
      </>}
    </section>
  </>;
}
function LsrDecision({desk,now}:{desk:Desk;now:number}){
  const live=desk.liveResearch,d=live?.decision,exp=live?.experiment;
  const pending=exp?.recent.filter(row=>row.status==="挂着")??[];
  const side=d?.planSide==="LONG"?"做多":d?.planSide==="SHORT"?"做空":"";
  return <section className="fr-section" data-testid="decision-stance">
    <div className="fr-section-head"><h2>现在在等</h2></div>
    <p>{exp&&!exp.running?exp.status:pending.length?`挂着 ${pending.length} 笔，等 6 秒内打到买卖中间价。打不到就撤。`:"等下一次研究。研究给出方向，就按 500U 挂出去。老的四关已经不用了。"}</p>
    {pending.map(row=><p key={`${row.at}-${row.symbol}`}>{row.symbol.replace("_"," / ")} {row.side}，挂着，等成交。</p>)}
    <div className="fr-section-head"><h2>这一拍准备做</h2></div>
    {d?<p>{d.headline} 这一拍按研究层，准备 {d.symbol.replace("_"," / ")} {side}，大约 500U。止损 {fmt(d.stop,6)}，第一目标 {fmt(d.tp1,6)}，第二目标 {fmt(d.tp2,6)}。</p>:<p>研究这一拍还没有方向。</p>}
    <div className="fr-section-head"><h2>持仓在等什么出场</h2><span>{desk.open.length} 笔</span></div>
    {desk.open.length?desk.open.map(order=><article className="lsr-hold" key={order.id}>
      <header><b>{order.symbol.replace("_"," / ")} {order.side==="LONG"?"多":"空"}</b><b className={(order.net??0)>=0?"fr-positive":"fr-negative"}>{signed(order.net)} U</b></header>
      <p>已拿 {duration(order.openedAt,null,now)}。进场 {fmt(order.entryPrice,6)}，现价 {fmt(order.price,6)}。</p>
      <div className="lsr-exit">
        <span>第一目标 {order.target==null?"还没写":fmt(order.target,6)}</span>
        <span>止损 {order.stop==null?"还没写":fmt(order.stop,6)}</span>
        <span>{order.plan==="研究"?"按研究层的时间出场":"旧单，按原来的 15 分钟"}</span>
      </div>
      {order.waiting&&<p>{order.waiting}</p>}
    </article>):<p className="fr-note">没有持仓。成交以后等五件事：第一目标、第二目标、止损、研究层给的持仓时间，或者 30 秒检查发现看错了。</p>}
  </section>;
}
function WorkResearch({work,note,ideas}:{work:Desk["work"];note?:string;ideas?:Desk["brainIdeas"]}){
  return <section className="fr-section" data-testid="research-claims">
    <div className="fr-section-head"><h2>在研究什么</h2></div>
    <p>{work?.subject??note??"这一拍的步骤还没有写出来。"}</p>
    {work&&<><div className="fr-section-head"><h2>用的方法</h2></div><p>{work.method}</p>
      <div className="fr-section-head"><h2>这一拍的步骤</h2><span>{work.lines.length} 步</span></div>
      {work.lines.map(line=><p key={line.name}><span>{line.name}</span><b>{line.data}</b><b>{line.said}</b></p>)}
    </>}
    {!!ideas?.length&&<><div className="fr-section-head"><h2>写出的思路</h2><span>{ideas.length} 条</span></div>
      {ideas.map(idea=><p key={`${idea.symbol}-${idea.kind}`}><span>{idea.symbol.replace("_"," / ")} · {idea.side==="LONG"?"多":"空"} · {idea.kind==="FADE"?"单币失败":idea.kind==="LEAD"?"领头":"掉队"}</span><b>{idea.why}想错了：{idea.wrong}</b></p>)}
    </>}
  </section>;
}
function ThesisPanel({thesis}:{thesis:ThesisPublic}){
  const stateName=(state:string)=>state==="ALIVE"?"存活":state==="WEAKENING"?"转弱":state==="DYING"?"濒死":state==="DEAD"?"死亡":state;
  return <section className="fr-section" data-testid="decision-stance">
    <div className="fr-section-head"><h2>策略已接上</h2><span>假突破 / 慢层</span></div>
    <p>{thesis.note}</p>
    <p className="fr-note">权益 {fmt(thesis.equity)} U · 已实现 {signed(thesis.closedPnl)} U · 浮动 {signed(thesis.unrealized)} U · 恒等误差 {Math.abs(thesis.identityError)<0.5?"0":fmt(thesis.identityError,4)}</p>
    <p className="fr-note">扫描 {thesis.scans} · 信号 {thesis.signals} · 成交 {thesis.filled} · 已平 {thesis.closed} · 赢 {thesis.wins}</p>
    {thesis.rows.length?thesis.rows.map(row=><p key={row.symbol}><span>{row.symbol.replace("_"," / ")} · {row.action} · {stateName(row.state)}</span><b>{row.detail}</b></p>):<p className="fr-note">这一拍还没有可判的合约。</p>}
    {thesis.open.map(order=><p key={`${order.symbol}-${order.entry}`}><span>{order.symbol.replace("_"," / ")} · {order.side==="LONG"?"多":"空"} · {order.thesis}</span><b>进场 {fmt(order.entry,6)} · 浮动 {signed(order.upl)} U</b></p>)}
  </section>;
}
function DecisionPage({data,now,thesis}:{data:View|null;now:number;thesis:ThesisPublic|null}){
  const desk=data?.forwardDesk??null,research=desk?.research,stance=stanceName(desk?.stance);
  if(!desk?.book&&!desk?.open?.length){
    const eligible=data?.opportunities.filter(row=>row.eligible&&row.expiresAt>now).length??0;
    return <section className="fr-section" data-testid="decision-stance">
      <div className="fr-section-head"><h2>市场智能</h2><span>{eligible} 个可参与</span></div>
      <p>可参与机会 {eligible} 个。实盘关闭，这里只记模拟。门槛不过就不下单，不会改用旧策略。</p>
      {thesis&&<p className="fr-note">{thesis.note}</p>}
    </section>;
  }
  if(desk?.book==="lsr-v1")return <LsrDecision desk={desk} now={now}/>;
  if((desk?.book==="read-v1"||desk?.book==="brain-v1"||desk?.book==="stretch-v1")&&desk.work)return <section className="fr-section" data-testid="decision-stance">
    <div className="fr-section-head"><h2>现在在等</h2></div>
    <p>{desk.work.waiting}</p>
    <div className="fr-section-head"><h2>准备做</h2></div>
    <p>{desk.work.preparing}</p>
  </section>;
  if(desk?.book==="read-v1")return <section className="fr-section" data-testid="decision-stance">
    <div className="fr-section-head"><h2>当前决策</h2><span>一拨</span></div>
    <p>研究说接下来有方向，价差吃得起，价格也没追出去，才做这一拨。刚跟上的才做，已经冲远的不追。拿住，直到这段判断结束。</p>
    <p className="fr-note">不拆成频繁的小碎单。小波动不平。方向还在就拿着。这段结束了，下一笔可以开，不因为平了一笔就把新仓停住。打到 1.2% 才当止损。整本亏的是方向、手续费却很小，就把这个判断反过来。亏的和手续费差不多，就停，不反。</p>
  </section>;
  if(desk?.book==="score-v1")return <section className="fr-section" data-testid="decision-stance">
    <div className="fr-section-head"><h2>当前决策</h2><span>核对通过才做</span></div>
    <p>研究没核对通过，就不开。通过了，这一窗开始时按偏离从大到小开，单笔大约 400U。同一币不叠仓。保证金到权益一半就停，大约十二笔。</p>
    <p className="fr-note">价差超过 0.04% 不开。现价比这一窗写下的价劣了超过 0.15% 不开。到止损、到目标、或者满三十分钟，就走。同一根一分钟里两边都碰到，按止损走。</p>
  </section>;
  if(desk?.book==="brain-v1")return <section className="fr-section" data-testid="decision-stance">
    <div className="fr-section-head"><h2>当前决策</h2><span>做不做</span></div>
    <p>思路还新鲜、价差吃得起、这个币还没有仓，就做。价格已经跑远就放弃，不追。</p>
    <p className="fr-note">不设最多几个仓。同一币不叠第二笔。保证金用到权益的一半，就暂停新开。</p>
    <p className="fr-note">进场用当时的买一卖一。想错了马上走。想对了就拿着，刚赚到一点噪音不卖。走出一截以后吐回一半，或者思路被破坏，再走。没有 5 分钟砍盈利，也没有固定 90 分钟。</p>
  </section>;
  if(desk?.book==="reverse-v1")return <section className="fr-section" data-testid="decision-stance">
    <div className="fr-section-head"><h2>当前决策</h2><span>反向</span></div>
    <p>每一笔新提案都反着做。提案做多，这里做空。提案做空，这里做多。金额和提案一样。</p>
    <p className="fr-note">打穿进场确认位、30 分钟没走出成本、利润回吐一半、满 90 分钟、提案自己平仓，谁先到听谁。浮亏到 10U 也走。已经开着的单不改方向。这套不再看 20 笔样本，也不会改回正向。</p>
  </section>;
  if(desk?.book==="needle-v1")return <section className="fr-section" data-testid="decision-stance">
    <div className="fr-section-head"><h2>当前决策</h2><span>针</span></div>
    <p>不跟提案开仓。向上的针做空，向下的针做多。</p>
    <p className="fr-note">针尖离进场价不到 0.25%，或超过 0.6%，不开。这个币半小时内刚止损过，不开。同时最多 3 笔。</p>
    <p className="fr-note">不顺的单短拿：打穿针尖就走，5 分钟没走出 0.15% 就走，浮亏到 4U 也走。顺的单长拿：不到 0.8% 不因小赚离场。到了以后吐回一半再走。最长 90 分钟。</p>
  </section>;
  const headline=desk?.stance==="REVERSE"?"新单跟提案反着做。":desk?.stance==="FLAT"?"这一时段先不开新单。":"新单跟提案同一边。";
  return <section className="fr-section" data-testid="decision-stance">
    <div className="fr-section-head"><h2>当前决策</h2><span>{stance}</span></div>
    <p>{headline}</p>
    <p className="fr-note">同一时段里，延续和可疑都够 20 笔才改方向。延续大多打错，而且可疑反着读大多对，才保持反向。两种读法都在亏，就先停开。样本不够时保持现在这个方向。已经开着的单不改。</p>
    {research&&<div className="fr-three"><div><small>这一时段</small><b>{sessionName(research.session)}</b></div><div><small>延续打错</small><b>{research.continueN<20?`${research.continueN}/20`:`${research.continueWrong}/20`}</b></div><div><small>可疑反着读对</small><b>{research.suspectN<20?`${research.suspectN}/20`:`${research.suspectRight}/20`}</b></div></div>}
    {research?.note&&<p className="fr-note">{research.note}</p>}
    <p className="fr-note">新单和提案一样大。先停的时候不开新单，也不把后面的单加大。出场看确认位、30 分钟、利润回吐、90 分钟和提案自己平仓，谁先到听谁。浮亏到 10U 也走。旧账本和旧订单不带进这一轮。</p>
  </section>;
}
function ForwardOrders({desk,now}:{desk:Desk;now:number}){
  if(!desk.book&&desk.open.length===0)return <section className="fr-section" data-testid="forward-orders">
    <div className="fr-section-head"><h2>订单</h2><span>0 笔</span></div>
    <p className="fr-note">没有策略，所以没有订单。</p>
  </section>;
  const live=desk.liveResearch,rows=live?.experiment?.rows??[];
  if(desk.book==="lsr-v1")return <section className="fr-section" data-testid="forward-orders">
    <div className="fr-section-head"><h2>实验订单</h2><span>{rows.length} 笔</span></div>
    <p className="fr-note">研究层给方向就挂 500U。这里能看到挂单、没成交、持仓和已平，以及手续费、滑点和资金费。</p>
    {rows.length?rows.map(row=><article className="fr-order" key={row.id}>
      <header><div><b>{row.symbol.replace("_"," / ")}</b><small>{row.side} · {row.status}{row.reason?` · ${row.reason}`:""} · 把握 {(row.confidence*100).toFixed(0)}%</small></div><b className={(row.net??0)>=0?"fr-positive":"fr-negative"}>{row.net==null?"—":`${signed(row.net)} U`}</b></header>
      <small>{time(row.at)}{row.holdSec==null?"":` · 拿了 ${Math.round(row.holdSec/60)} 分钟`}</small>
      <p>挂单价 {fmt(row.limit,6)}{row.entry==null?"":` · 成交 ${fmt(row.entry,6)}`}{row.exit==null?"":` · 出场 ${fmt(row.exit,6)}`} · 名义 {fmt(row.notional,2)} U · 数量 {fmt(row.qty,4)}</p>
      <p>止损 {fmt(row.stop,6)} · 第一目标 {fmt(row.tp1,6)} · 第二目标 {fmt(row.tp2,6)}</p>
      <p className="fr-note">{row.openFee==null?"还没成交，手续费还没记。":`开仓手续费 ${fmt(row.openFee,4)} U · 开仓滑点 ${fmt(row.openSlippage,4)} U${row.closeFee==null?" · 平仓费用等出场再记。":` · 平仓手续费 ${fmt(row.closeFee,4)} U · 平仓滑点 ${fmt(row.closeSlippage,4)} U · 资金费 ${fmt(row.fundingFee,4)} U · 费用合计 ${fmt(row.totalCost,4)} U`}`}</p>
      {row.gross!=null&&<p>毛利 {signed(row.gross)} U · 扣完费用 {signed(row.net)} U</p>}
    </article>):<Empty title="还没有实验订单"/>}
    {desk.open.some(o=>o.plan!=="研究")&&<>
      <div className="fr-section-head"><h2>老策略还没走完的单</h2><span>{desk.open.filter(o=>o.plan!=="研究").length} 笔</span></div>
      {desk.open.filter(o=>o.plan!=="研究").map(o=><article className="fr-order" key={o.id}><header><div><b>{o.symbol.replace("_"," / ")}</b><small>{o.side==="LONG"?"多":"空"} · 已拿 {duration(o.openedAt,null,now)}</small></div><b className={(o.net??0)>=0?"fr-positive":"fr-negative"}>{signed(o.net)} U</b></header>
        <small>入场 {fmt(o.entryPrice,6)} · 现价 {fmt(o.price,6)}</small>
        {o.waiting&&<p className="fr-note">{o.waiting}</p>}
      </article>)}
    </>}
  </section>;
  const label=desk.book==="stretch-v1"?"新账":desk.book==="reverse-v1"?"反向":desk.book==="needle-v1"||desk.book==="brain-v1"||desk.book==="score-v1"||desk.book==="read-v1"?"账户":stanceName(desk.stance);
  return <section className="fr-section" data-testid="forward-orders">
    <div className="fr-section-head"><h2>{label}持仓</h2><span>{desk.open.length} 笔</span></div>
    {!desk.work&&desk.book!=="brain-v1"&&desk.book!=="read-v1"&&<p className="fr-note">{desk.book==="score-v1"?"核对通过才开。单笔大约 400U。同一币不叠仓。保证金到权益一半就停。到止损、到目标或满三十分钟就走。":desk.book==="needle-v1"?"只做收回来的针。向上做空，向下做多。":"新单跟当前决策，一笔提案一笔单，金额不变。先停才不开，也不把后面的单加大。已经开着的单不改方向。"}</p>}
    {desk.open.length?desk.open.map(o=><article className="fr-order" key={o.id}><header><div><b>{o.symbol.replace("_"," / ")}</b><small>{o.side==="LONG"?"多":"空"}{o.plan?` · ${o.plan}`:""} · {fmt(o.leverage,0)}× · {duration(o.openedAt,null,now)}</small></div><b className={(o.net??0)>=0?"fr-positive":"fr-negative"}>{signed(o.net)} U</b></header>
      <small>入场 {fmt(o.entryPrice,6)} · 现价 {fmt(o.price,6)} · {time(o.openedAt)}</small>
      {o.waiting&&<p className="fr-note">出场在等：{o.waiting}</p>}
      </article>):<Empty title="当前没有持仓"/>}
    {desk.recent.length>0&&<><div className="fr-section-head"><h2>最近平仓</h2><span>{desk.recent.length} 笔</span></div>
      {desk.recent.map(o=><article className="fr-order" key={o.id}><header><div><b>{o.symbol.replace("_"," / ")}</b><small>{o.side==="LONG"?"多":"空"}{o.plan?` · ${o.plan}`:""}</small></div><b className={(o.net??0)>=0?"fr-positive":"fr-negative"}>{signed(o.net)} U</b></header>
        <small>{time(o.openedAt)} → {time(o.closedAt)}{o.exit?` · ${exitName(o.exit)}`:""}</small></article>)}</>}
  </section>;
}
function TradeList({trades,now,empty}:{trades:Trade[];now:number;empty:string}){
  return trades.length?<div className="oc-list">{trades.map(t=><TradeCard key={t.id} trade={t} now={now}/>)}</div>:<Empty title={empty}/>;
}
function openTradeNetPnl(t:Trade,px=t.lastPrice){return tradePaidNetPnl(t,px);}
const shortTime=(v?:number|null)=>v?new Date(v).toLocaleString("zh-CN",{timeZone:BEIJING_TIME_ZONE,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}):"—";
/** One plain line: which way, what kind of move, what the board was. The full research text stays in the fold. */
function openReason(t:Trade){
  const ctx=t.entryContext;
  if(t.inverseCopy)return t.inverseCopy.alignment==="WITH_SOURCE"?"跟着提案同方向开。":"跟提案反着开。";
  if(!ctx)return null;
  // 研究层的单：说研究层自己的打法和资金意图，不说旧系统的盘面阶段。
  if(ctx.living)return livingWhy(t,livingPlaybookLabel(ctx.living.pb));
  const trend=ctx.entryRead?.withTrend===true?"顺着大盘方向":ctx.entryRead?.withTrend===false?"逆着大盘方向":"";
  const plan=ctx.winnerPlan?(ctx.winnerPlan.intent==="TREND"?"做这个币自己的趋势":"做回到区间"):`${ctx.reserve?"低风险 · ":""}${modeName(ctx.mode)}`;
  const board=ctx.stageNote?.liveStage??ctx.environment;
  return `${trend}${t.side==="LONG"?"做多":"做空"}，${plan}${board?`；开仓时盘面是${stageName(board)}`:""}。`;
}
/** S1 tag on the card (legacy, read-only: S1 was withdrawn 10-19): 顺势, or 反向 with original→new side. */
function s1Tag(t:Trade):{tag?:string;tagTitle?:string}{
  const n=t.entryContext?.s1;if(!n?.branch||(n.signal!=="LONG"&&n.signal!=="SHORT")||(n.side!=="LONG"&&n.side!=="SHORT"))return {};
  const later=s1LegacyExit(t);
  const name=(side:"LONG"|"SHORT")=>side==="LONG"?"多":"空";
  const btc=typeof n.btc==="number"?`BTC 1小时顺向 ${n.btc>=0?"+":""}${n.btc.toFixed(2)}%`:"";
  if(n.branch==="follow")return {tag:"顺势",tagTitle:`S1 顺势：${btc}（≥0.57%），止盈 6%、止损 1%${later}`};
  return {tag:`反向 ${name(n.signal)}→${name(n.side)}`,tagTitle:`S1 反向：${btc}（<0.57%），原信号${name(n.signal)}，改做${name(n.side)}，自身止损 ${typeof n.stop==="number"?n.stop.toFixed(2):"—"}%，6 小时到点出${later}`};
}
/** S1 was withdrawn: an S1 trade still open, or closed by a non-S1 code, is (was) managed by the earlier exits. */
function s1LegacyExit(t:Trade){
  if(t.status==="OPEN")return "。S1 已退回旧规则，这单改按旧出场规则平，止损只收紧不放宽";
  return t.exitReason&&!t.exitReason.startsWith("S1_")&&t.exitReason!=="LIQUIDATION"?"。S1 已退回旧规则，这单按旧出场规则平的":"";
}
function closeReason(t:Trade){
  if(t.status==="OPEN"||!t.exitReason)return null;
  if(t.exitReason==="PEAK_GIVEBACK")return `${peakGivebackName(t)}，平仓留住利润。`;
  return exitPlain(t.exitReason,exitLabel(t));
}
const labelled=(line:string)=>{const i=line.indexOf("：");return i>0&&i<8?<p key={line}><b>{line.slice(0,i)}</b>：{line.slice(i+1)}</p>:<p key={line}>{line}</p>;};
export function TradeCard({trade:t,now,paid}:{trade:Trade;now:number;paid?:PaidPair}){
  const open=t.status==="OPEN";
  const pair=t.inverseCopy?(paid?.status===t.status?paid:pairedPaidView(t,undefined,now||t.lastQuoteAt)):null;
  const px=pair?pair.inverse.price:open?t.lastPrice:t.exitPrice??t.lastPrice;
  const pnl=pair?pair.inverse.netPnl:open?openTradeNetPnl(t,px??t.lastPrice):t.netPnl,rate=pnl!==null&&initialTradeNotional(t)>0?pnl/initialTradeNotional(t):null,ctx=t.entryContext;
  const board=ctx?.stageNote?.liveStage??ctx?.environment,living=!t.inverseCopy&&isLivingTrade(t);
  const state=t.inverseCopy?(open?"持仓中":"已跟随出场"):open?"持仓中":t.exitReason==="PEAK_GIVEBACK"?"浮盈回吐":exitShort(t.exitReason,exitLabel(t));
  const fees=pair?pair.inverse.fees:(t.entryFee??0)+(open?0:t.exitFee??0);
  const facts:OrderFact[]=[
    {label:"开仓价",value:priceText(t.entryPrice)},{label:open?"现价":"平仓价",value:priceText(px)},
    {label:"开仓时间",value:shortTime(t.openedAt)},{label:"平仓时间",value:open?"还在持仓":shortTime(t.closedAt)},
    {label:"最高浮盈",value:`${fmt(t.favorable*100,2)}%`,tone:t.favorable>0?1:null},{label:"最大浮亏",value:`${fmt(t.adverse*100,2)}%`,tone:t.adverse>0?-1:null},
    {label:"锁住的利润",value:`${fmt((t.profitFloorRate??0)*100,2)}%`},{label:open?"已扣手续费":"手续费",value:`${fmt(fees,pair?4:2)} U`},
    {label:"名义金额",value:`${fmt(t.notional)} U`},{label:"保证金",value:`${fmt(t.margin)} U`},
    {label:t.inverseCopy?"出场参考":"止损位",value:priceText(t.inverseCopy?.sourceStopPrice??t.stopPrice)},
    ...(typeof t.liquidationPrice==="number"&&!t.inverseCopy?[{label:"强平价（逐仓）",value:priceText(t.liquidationPrice),tone:t.exitReason==="LIQUIDATION"?-1:null}]:[]),
    living&&ctx?.living?{label:"开仓时市场意图",value:livingBoard(ctx.living)}:{label:"开仓盘面",value:t.inverseCopy?"跟随提案":board?stageName(board):"没记下"},
  ];
  const facts2=living?livingDetail(t,livingPlaybookLabel(ctx?.living?.pb)):entryFacts(t);
  const score=t.inverseCopy?null:ctx?(ctx.strategyVersion==="market-intelligence-v1"?`入场评分 ${fmt(ctx.entryScore,0)} · 同组 ${(ctx.clusterId?.replace(/^corr:/,"")??"—").replace(/_USDT$/,"")} · ${afterEntryName(ctx.postEntryState)}`:`入场评分 ${fmt(ctx.entryScore,0)} · 旧关系 ${ctx.relationStatus??"—"} ${fmt((ctx.relationHealth??0)*100,0)} · 首次浮赢 ${t.firstProfitAt?time(t.firstProfitAt):"尚未"}`):"历史兼容持仓";
  const detail=living?<>
    {facts2.map(labelled)}
    {t.exitReason&&<p><b>退出依据</b>：{exitLabel(t)}</p>}
    <p><b>持有时长</b>：计划 {fmt(t.expectedHoldMinutes,0)} 分钟 · 实际 {duration(t.openedAt,t.closedAt,now)}</p>
    <p><b>精确时间</b>：开仓 {time(t.openedAt)} · 平仓 {open?"尚未平仓":time(t.closedAt)}</p>
  </>:<>
    {open&&!t.inverseCopy&&<p><b>持仓评分</b>：{fmt(t.holdScore,0)}</p>}
    {score&&<p><b>评分</b>：{score}</p>}
    {ctx&&<p><b>入场依据</b>：{ctx.reason}</p>}
    {facts2.map(labelled)}
    {t.winnerManagement&&<p><b>持仓计划</b>：{t.winnerManagement.reason}</p>}
    {t.exitReason&&<p><b>退出依据</b>：{exitLabel(t)}</p>}
    <p><b>风险与时长</b>：计划风险 {fmt(t.plannedRisk)} U · 杠杆 {fmt(t.leverage,0)}× · 预计持有 {fmt(t.expectedHoldMinutes,0)} 分钟 · 实际 {duration(t.openedAt,t.closedAt,now)}</p>
    <p><b>精确时间</b>：开仓 {time(t.openedAt)} · 平仓 {open?"尚未平仓":time(t.closedAt)}</p>
    {t.inverseCopy&&<p>只扣已经发生的费用。</p>}
  </>;
  return <OrderCard className={t.inverseCopy?`fr-inverse-row${t.inverseCopy.alignment==="WITH_SOURCE"?" is-with":""}`:undefined}
    symbol={t.symbol} side={t.side} leverage={t.leverage} liquidated={t.exitReason==="LIQUIDATION"} {...s1Tag(t)} pnl={pnl} rate={rate} state={state} held={duration(t.openedAt,t.closedAt,now)}
    extra={pair?<span>已扣手续费 {fmt(pair.inverse.fees,4)} U{!pair.quoteFresh?" · 估值待更新":""}</span>:undefined}
    facts={facts} why={openReason(t)} out={closeReason(t)}
    notes={t.realization&&<p className="oc-note">{t.inverseCopy?"已减仓":"已部分兑现"} {t.realization.sequence} 次 · 已实现净额 {signed(realizedNetPnl(t))} U · 剩余 {fmt(open?remainingTradeFraction(t)*100:0,0)}%</p>}
    detail={detail}/>;
}
const winNote=(wins?:number|null,total?:number|null)=>typeof wins==="number"&&typeof total==="number"&&total>0?`赢 ${fmt(wins,0)} 笔 · 胜率 ${fmt(wins/total*100,0)}%`:"还没有平仓";
function Stat({label,value,note}:{label:string;value:string;note?:string}){return <article><small>{label}</small><strong>{value}</strong>{note&&<p>{note}</p>}</article>;}
function Empty({title}:{title:string}){return <div className="fr-empty"><h3>{title}</h3></div>;}
