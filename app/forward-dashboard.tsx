"use client";
import {realizedNetPnl,initialTradeNotional,remainingTradeFraction} from "../lib/trade-realization.ts";

import {useCallback,useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from "react";
import {BEIJING_TIME_ZONE} from "../lib/beijing-time.ts";
import {type Trade,type forwardSummary} from "../lib/forward-relations.ts";
import {purgeEquityBrowserCache} from "../lib/equity-browser-purge.ts";
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
import {OrderCard,exitShort,exitPlain,priceText,livingPlaybookLabel,type OrderFact} from "./order-card.tsx";
import {isLivingTrade,livingBoard,livingDetail,livingWhy} from "../lib/living-trade-view.ts";

type View=ReturnType<typeof forwardSummary>;
type Tab="paper"|"live"|"settings";
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

export default function ForwardDashboard({data,healthy,statusLabel,feedAt,error,livePanel,liveSystemPanel,liveEnabled,liveOverview,accountPanel,memberName,cacheScope="owner",cachedAt=null,onTabChange}:{
  data:View|null;healthy:boolean;statusLabel?:string;feedAt:number|null;error:string|null;livePanel:ReactNode;liveSystemPanel?:ReactNode;
  liveEnabled:boolean;liveOverview?:{equity:number|null;available:number|null;positionCount:number;operational:boolean;lastSyncAt:number|null;copied:number|null;eligible:number|null;missing:number|null;accountMark?:import('../lib/live-account-view.ts').LiveAccountMark|null;};
  accountPanel?:ReactNode;
  memberName?:string;cacheScope?:string;
  /** Set while the page shows the device snapshot (not yet a fresh read). */
  cachedAt?:number|null;
  /** Tells the page which tab is shown (it sets the home refresh cadence). */
  onTabChange?:(tab:Tab)=>void;
}){
  // The equity chart is gone; free the space its old browser copies still take on the phone.
  useEffect(()=>{purgeEquityBrowserCache();},[]);
  const [tab,setTab]=useState<Tab>("paper"),[now,setNow]=useState(0),[liveMounted,setLiveMounted]=useState(false);
  const [fontScale,setFontScale]=useState(()=>{if(typeof window==="undefined")return 92;try{const saved=Number(localStorage.getItem("sentinel-ui-font-scale-v1"));return saved>=70&&saved<=110?saved:92;}catch{return 92;}});
  const [exporting,setExporting]=useState(false),[exportStatus,setExportStatus]=useState<string|null>(null),[exportCount,setExportCount]=useState(0);
  const [historyShown,setHistoryShown]=useState(10);
  const scroll=useRef<Record<Tab,number>>({paper:0,live:0,settings:0});
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
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    // The server streams the file; keep it as a Blob (no parse + re-stringify, which tripled memory on phones). Counts come in a header.
    let meta:{at?:number;positions?:number;cases?:number;timeline?:number;from?:number|null;to?:number|null;archiveError?:boolean}={};
    try{meta=JSON.parse(response.headers.get("x-export-meta")??"{}");}catch{meta={};}
    const blob=await response.blob();
    const log={exportedAt:meta.at,positions:{length:meta.positions??0},cases:{length:meta.cases??0},timeline:{length:meta.timeline??0},orders_from:meta.from??null,orders_to:meta.to??null,orders_archive_error:meta.archiveError?"1":null};
    const at=log.exportedAt??Date.now();
    const stamp=new Date(at+8*60*60*1000).toISOString().replace(/[-:]/g,"").slice(0,15);
    const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`living-run-log-${stamp}.json`;
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    const n=log.positions.length,cases=log.cases.length,rows=log.timeline.length;
    const bj=(ms:number)=>{const d=new Date(ms+8*60*60*1000);return `${d.getUTCMonth()+1}月${d.getUTCDate()}日 ${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}`;};
    const span=log.orders_from!=null&&log.orders_to!=null?`，从 ${bj(log.orders_from)} 到 ${bj(log.orders_to)}（北京）`:"";
    const warn=log.orders_archive_error?"长期库这次没读到，这份只有手里还在的单。":"";
    setExportStatus(`已开始下载 ${a.download}。里面 ${n} 笔单${span}。${warn}${cases} 个研究案例、${rows} 段时间线（每段 10 分钟）。`);setExportCount(c=>c+1);
  }catch(error){setExportStatus(`导出失败，请重试。（${error instanceof Error?error.message:"网络中断"}）`);}finally{setExporting(false);}};

  const positions=data?.positions??[],history=[...(data?.history??[])].sort((a,b)=>(b.closedAt??0)-(a.closedAt??0));
  const paperView=paperAccountView(positions);
  const paperFloating=paperView.floating;
  const held=paperView.openCount;
  const paperHeld=positions.filter(t=>!t.inverseCopy).length;
  const liveHeld=liveOverview?.positionCount??0;
  const systemStatus=statusLabel==="后台运行中"?"正常":statusLabel?.startsWith("后台运行中 · ")?statusLabel.slice(8):statusLabel??(healthy?"正常":"行情恢复中");
  const accountEquity=data?.equity,
    accountPnl=data?.netPnl,
    accountBase=data?.initialEquity;
  const drawdown=data?data.maxDrawdown*100:null;
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
  const nav:[Tab,string,string][]=[["paper","⇄","模拟"],["live","◈","实盘"],["settings","⊙","系统"]];
  return <main className="fr-app" style={fontVars as CSSProperties} data-ui-version="market-intelligence-v1">
    <header className="fr-compact-header pg-head"><b>哨兵 · 交易核心</b><span>
      <i className={`pg-pill ${healthy?"is-ok":"is-warn"}`} role="status">{systemStatus}</i>
      <i className={`pg-pill ${liveEnabled?liveOverview?.operational?"is-ok":"is-warn":"is-off"}`}>实盘{liveText}</i>
      {memberName&&<i className="pg-pill is-plain">{memberName}</i>}</span></header>

    {tab==="paper"&&<div className="pg-paper">
      <section className="fr-equity fr-overview-equity" data-testid="overview-equity-first" aria-label="模拟账户权益">
        <small>模拟账户权益 · USDT</small><strong>{fmt(accountEquity)}</strong>
        <div className={(accountPnl??0)>=0?"fr-positive":"fr-negative"}>{signed(accountPnl)} <span>U · {signed(accountPnl!=null&&accountBase?accountPnl/accountBase*100:null)}%</span></div>
        <footer><span>起点 {fmt(accountBase,0)} U</span><span>最大回撤 {fmt(drawdown)}%</span></footer>
        <p>更新 {time(data?.updatedAt)}{data?.stalePositions?" · 持仓估值待更新":""}</p>
      </section>
      <section className="fr-stats">
        <Stat label="当前持仓" value={data?`${held} 笔`:"—"} note={`保证金 ${fmt(positions.reduce((n,t)=>n+t.margin,0),0)} U`}/>
        <Stat label="浮动盈亏" value={`${signed(data?paperFloating:null)} U`} note="已扣开仓费"/>
        <Stat label="已完成" value={data?`${fmt(data.resolved,0)} 笔`:"—"} note={winNote(data?.wins,data?.resolved)}/>
        <Stat label="已扣手续费" value={`${fmt(data?.fees)} U`} note={`成交额 ${fmt(data?.turnover,0)} U`}/>
      </section>
      <section className="fr-section" data-testid="forward-orders"><div className="fr-section-head"><h2>持仓</h2><span>{positions.length} 笔</span></div><TradeList trades={positions} now={now} empty="当前没有持仓。"/></section>
      <section className="fr-section" data-testid="forward-history"><div className="fr-section-head"><h2>历史订单</h2><span>{history.length} 笔</span></div><TradeList trades={history.slice(0,historyShown)} now={now} empty="还没有已平订单。"/>
        {history.length>historyShown&&<button type="button" className="pg-link" onClick={()=>setHistoryShown(n=>n+20)}>再显示 {Math.min(20,history.length-historyShown)} 笔（还有 {history.length-historyShown} 笔）</button>}</section>
    </div>}

    {tab==="settings"&&<div className="pg-system">
      <section className="pg-card" data-testid="system-status">
        <header><small>系统状态</small><i className={`pg-pill ${card.healthy?"is-ok":"is-warn"}`}>{card.status}</i></header>
        <dl className="pg-kv">
          <div><dt>行情更新</dt><dd>{time(card.feedAt)}</dd></div>
          <div><dt>实盘</dt><dd>{card.live}</dd></div>
          <div><dt>引擎版本</dt><dd>{card.engine??"—"}</dd></div>
          <div><dt>数据保存</dt><dd className={card.storageOk===false?"fr-negative":card.storageOk?"fr-positive":undefined}>{card.storageOk==null?"—":card.storageOk?"正常":"异常"}</dd></div>
        </dl>
        {card.cached&&systemSnap&&<PanelStamp at={systemSnap.at} refreshing={true} failed={false}/>}
      </section>
      <section className="fr-section"><div className="fr-section-head"><h2>运行日志</h2></div>
        <p className="fr-note">订单、净值曲线和执行记录都在这一个文件里，复盘就用它。</p>
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
