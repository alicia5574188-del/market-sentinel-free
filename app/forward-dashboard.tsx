"use client";
import {realizedNetPnl,initialTradeNotional,remainingTradeFraction} from "../lib/trade-realization.ts";

import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from "react";
import {BEIJING_TIME_ZONE,beijingDayKey} from "../lib/beijing-time.ts";
import {type Trade,type forwardSummary} from "../lib/forward-relations.ts";
import {recordWindows,archivePage} from "../lib/record-view.ts";
import {ArchivePagination} from "./record-controls.tsx";
import EquityCurve from "./equity-curve.tsx";
import LiveEquityCurve from "./live-equity-curve.tsx";
import {EquityHistoryCache} from "../lib/equity-cache.ts";
import MarketIntelligenceExecution from "./market-intelligence-execution.tsx";
import "./account-first.css";
import "./paid-fee.css";
import {remainingPaidNetPnl,tradePaidNetPnl,pairedPaidView,type PaidPair} from "../lib/paid-fee-view.ts";
import {collectReviewSnapshot} from "../lib/research-snapshot.ts";

type View=ReturnType<typeof forwardSummary>;
type Desk=NonNullable<View["forwardDesk"]>;
type Tab="overview"|"research"|"decision"|"paper"|"live"|"settings";
const fmt=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?v.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}):"—";
const signed=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?`${v>=0?"+":""}${fmt(v,d)}`:"—";
const time=(v?:number|null)=>v?new Date(v).toLocaleString("zh-CN",{timeZone:BEIJING_TIME_ZONE,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}):"—";
const duration=(start:number,end:number|null|undefined,now:number)=>{const m=Math.floor(Math.max(0,(end??now)-start)/60000);return m<1?"<1分钟":m>=60?`${Math.floor(m/60)}小时${m%60}分`:`${m}分钟`;};
const modeName=(mode:string)=>({RELATIVE:"相对异类",REVERSAL:"结构转变",CONTINUATION:"市场延续",SWING:"旧峰谷兼容",TREND_PULLBACK:"旧回调兼容",IMPULSE:"旧推进兼容",RELATION:"旧关系兼容",BREAKOUT:"旧突破兼容",RETEST:"旧回踩兼容",FAILED_BREAKOUT:"旧失败突破兼容",RANGE:"旧区域兼容",SHOCK:"旧突变兼容"}[mode]??mode);
const exitName=(reason:string|null)=>reason?({SHADOW_SOURCE_EXIT:"研究层出场",INVERSE_SOFT_LOSS_EXIT:"浮亏到线，提前平仓",WINNER_STRUCTURE_EXIT:"有效结构保护",WINNER_THESIS_EXIT:"持续推动失效",RANGE_CENTER_EXIT:"回归目标兑现",STRUCTURE_STOP:"结构止损",PROFIT_GIVEBACK:"利润保护",THESIS_INVALIDATED:"交易假设失效",RELATIVE_EDGE_GONE:"相对优势消失",NO_POSITIVE_FEEDBACK:"长时间未获得正向反馈",MAX_HOLD:"最大持仓时间",ENTRY_FEEDBACK_FAILED:"旧入场反馈失败",OPPOSITE_EXTREMUM:"旧相反峰谷",TREND_DEATH:"旧趋势死亡",EXTREMUM_PROFIT_EXIT:"旧极值退出",NO_PROGRESS:"旧无进展",MARKET_FLIP:"旧市场翻转",RELATION_DEGRADED:"旧关系降级",SAMPLE_PATH_DIVERGED:"旧样本路径失配",SAMPLE_EDGE_EXHAUSTED:"旧样本优势耗尽",SAMPLE_MAX_HOLD:"旧样本最大持仓",TIME_DECAY:"旧持仓超时",OPPORTUNITY_REPLACED:"更优机会替换",STRUCTURAL_INTERRUPT_REVERSAL:"旧极端结构反转",SHOCK_REENTRY:"旧突变重新回区",FAST_STRUCTURE_FAILURE:"旧强结构快速失效",ACCOUNT_RESET:"手动重置"}[reason]??reason):"—";

export default function ForwardDashboard({data,healthy,statusLabel,feedAt,error,livePanel,liveSystemPanel,liveEnabled,liveOverview,accountPanel,memberName,cacheScope="owner"}:{
  data:View|null;healthy:boolean;statusLabel?:string;feedAt:number|null;error:string|null;livePanel:ReactNode;liveSystemPanel?:ReactNode;
  liveEnabled:boolean;liveOverview?:{equity:number|null;available:number|null;positionCount:number;operational:boolean;lastSyncAt:number|null;copied:number|null;eligible:number|null;missing:number|null;accountMark?:import('../lib/live-account-view.ts').LiveAccountMark|null;
    equityCurve?:import('../lib/live-equity.ts').LiveEquityHead|null;sessionAt?:number};
  accountPanel?:ReactNode;memberName?:string;cacheScope?:string;
}){
  const [equityCache]=useState(()=>new EquityHistoryCache());
  useEffect(()=>()=>equityCache.cancel(),[equityCache]);
  const [tab,setTab]=useState<Tab>("overview"),[now,setNow]=useState(0),[liveMounted,setLiveMounted]=useState(false);
  const [fontScale,setFontScale]=useState(()=>{if(typeof window==="undefined")return 92;try{const saved=Number(localStorage.getItem("sentinel-ui-font-scale-v1"));return saved>=70&&saved<=110?saved:92;}catch{return 92;}}),
    [paperTab,setPaperTab]=useState<"account"|"positions"|"history"|"archive">("account"),[paperPage,setPaperPage]=useState(0);
  const [exporting,setExporting]=useState(false),[exportStatus,setExportStatus]=useState<string|null>(null);
  const scroll=useRef<Record<Tab,number>>({overview:0,research:0,decision:0,paper:0,live:0,settings:0});
  useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id);},[]);
  useLayoutEffect(()=>{window.scrollTo({top:tab==="live"?0:scroll.current[tab]??0,behavior:"auto"});},[tab]);
  const select=(next:Tab)=>{scroll.current[tab]=window.scrollY;if(next==="live"||(next==="paper"&&liveEnabled))setLiveMounted(true);setTab(next);};
  const fontVars:Record<string,string>={};for(let px=10;px<=64;px++)fontVars[`--fr-fs${px}`]=`${(px*fontScale/100).toFixed(2)}px`;
  const exportSnapshot=async()=>{if(exporting)return;setExporting(true);setExportStatus(null);try{
    const snapshot=await collectReviewSnapshot(fetch,(n,total)=>setExportStatus(`正在读取订单 ${n}/${total}`));
    const blob=new Blob([JSON.stringify(snapshot)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`market-intelligence-review-${beijingDayKey()}.json`;
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);setExportStatus(snapshot.version==="market-intelligence-review-v2"&&(!snapshot.coverage.complete||snapshot.liveReview?.coverage.error||snapshot.liveReview?.coverage.limitReached||snapshot.runtime.liveReviewError)?"已导出；缺失或未核对的数据已在快照中标明。":"已开始下载。");
  }catch{setExportStatus("导出失败，请重试。");}finally{setExporting(false);}};

  const desk=data?.forwardDesk??null,positions=data?.positions??[];
  const usingDesk=!!desk&&!liveEnabled;
  const paperFloating=usingDesk?desk.floating:positions.reduce((n,t)=>n+(t.status==="OPEN"?remainingPaidNetPnl(t,t.lastPrice):0),0);
  const held=usingDesk?desk.openCount:positions.length;
  const systemStatus=statusLabel==="后台运行中"?"正常":statusLabel?.startsWith("后台运行中 · ")?statusLabel.slice(8):statusLabel??(healthy?"正常":"行情恢复中");
  const actual=liveOverview?.accountMark,accountEquity=liveEnabled?liveOverview?.equity:usingDesk?desk.equity:data?.equity,
    accountPnl=liveEnabled?actual?.tradingPnl:usingDesk?desk.netPnl:data?.netPnl,
    accountBase=liveEnabled?actual?.initialEquity:usingDesk?desk.initialEquity:data?.initialEquity;
  const drawdown=liveEnabled?(actual?actual.maxDrawdown*100:null):usingDesk?(desk.maxDrawdown==null?null:desk.maxDrawdown*100):data?data.maxDrawdown*100:null;
  const tape=(data as {observationTape?:{sentence?:string;lines?:string[]}}|null)?.observationTape;
  const nav:[Tab,string,string][]=[["overview","⇄","订单"],["research","⌘","研究"],["decision","◉","决策"],["live","◈","实盘"],["settings","⊙","系统"]];
  return <main className="fr-app" style={fontVars as CSSProperties} data-ui-version="market-intelligence-v1">
    <header className="fr-compact-header"><b>哨兵 · 市场智能系统</b><span className={healthy?"fr-positive":""} role="status">{systemStatus}</span><span>实盘{liveEnabled?liveOverview?.operational?"运行中":"核对中":"关闭"}{memberName?` · ${memberName}`:""}</span></header>

    {tab==="overview"&&<>
      <section className="fr-equity fr-overview-equity" data-testid="overview-equity-first" aria-label={liveEnabled?"实盘账户权益":usingDesk?"正向权益":"模拟账户权益"}>
        <small>{liveEnabled?"实盘账户权益":usingDesk?"正向权益":"模拟账户权益"} · USDT</small><strong>{fmt(accountEquity)}</strong>
        <div className={(accountPnl??0)>=0?"fr-positive":"fr-negative"}>{signed(accountPnl)} <span>U · {signed(accountPnl!=null&&accountBase?accountPnl/accountBase*100:null)}%{liveEnabled?" · 观察期交易盈亏":""}</span></div>
        <footer><span>{liveEnabled?"实盘观察基准":"起点"} {fmt(accountBase,liveEnabled?2:0)}</span><span>{liveEnabled?"观察期回撤":"最大回撤"} {fmt(drawdown)}%</span></footer>
        <p>更新 {time(liveEnabled?liveOverview?.lastSyncAt:data?.updatedAt)}{liveEnabled&&(!liveOverview?.lastSyncAt||now-liveOverview.lastSyncAt>30000)?" · 实盘数据待更新":!liveEnabled&&(usingDesk?desk.stale:data?.stalePositions)?" · 持仓估值待更新":""}</p>
        {liveEnabled&&<p>基准 {time(actual?.startedAt)} · 全合约账户，含手工持仓；交易盈亏待交易所流水字段齐全后确认。净值变化 {signed(actual?.capitalChange)} U（含出入金）。</p>}
      </section>
      <section className="fr-stats">
        <Stat label="当前持仓" value={liveEnabled?`${actual?.positionCount??liveOverview?.positionCount??"—"} 笔`:data?`${held} 笔`:"—"} note={liveEnabled?`保证金 ${fmt(actual?.margin)} U`:usingDesk?`已平 ${fmt(desk.resolved,0)} 笔`:`保证金 ${fmt(positions.reduce((n,t)=>n+t.margin,0))} U`}/>
        <Stat label="浮动盈亏" value={`${signed(liveEnabled?actual?.floating:data?paperFloating:null)} U`} note={liveEnabled?"Gate实际未实现盈亏":usingDesk?"正向持仓浮动":`计划风险 ${fmt(data?.equity?positions.reduce((n,t)=>n+t.plannedRisk,0)/data.equity*100:null,1)}%`}/>
        <Stat label={usingDesk?"已记下样本":"已完成"} value={usingDesk?`${desk.study.recorded} 笔`:data?`${fmt(data.resolved,0)} 笔`:"—"} note={usingDesk?`赢 ${desk.study.recordedWins} 笔`:"订单记录"}/>
        <Stat label={liveEnabled?"可用保证金":"已扣手续费"} value={`${fmt(liveEnabled?liveOverview?.available:usingDesk?desk.fees:data?.fees)} U`} note={liveEnabled?"Gate实际可用余额":usingDesk?"正向成交费用":`成交额 ${fmt(data?.turnover)} U`}/>
      </section>
      {liveEnabled&&<section className="fr-section"><div className="fr-section-head"><h2>实盘复制</h2></div>
        <p>已复制 {liveOverview?.copied??"—"} / 应复制 {liveOverview?.eligible??"—"} · 未跟上 {liveOverview?.missing??"—"}。成交和持仓以实盘页为准。</p></section>}
      {desk?<ForwardCurve desk={desk}/>:<PaperEquitySection data={data} healthy={healthy} cache={equityCache} cacheScope={cacheScope}/>}
      {liveEnabled&&<LiveEquityCurve head={liveOverview?.equityCurve} mark={actual} enabled={liveEnabled} sessionAt={liveOverview?.sessionAt??0} cacheScope={cacheScope} now={now}/>}
      {desk&&<ForwardOrders desk={desk} now={now}/>}
    </>}

    {tab==="research"&&<>
      <section className="fr-section"><div className="fr-section-head"><h2>市场原数</h2></div>
        <p className="fr-note">{tape?.sentence??"这一拍的原数还没有。"}</p>
        {(tape?.lines??[]).map(line=><p key={line} className="fr-note">{line}</p>)}
      </section>
      <MarketIntelligenceExecution data={data} now={now} liveEnabled={liveEnabled} liveOverview={liveOverview}/>
    </>}

    {tab==="decision"&&<DecisionPage data={data}/>}

    {tab==="paper"&&liveEnabled&&<section className="fr-section" data-testid="paper-live-mirror"><p>本账户实盘成交、持仓和结算记录。</p></section>}
    {tab==="paper"&&!liveEnabled&&<section className="fr-section"><div className="fr-section-head"><h2>订单</h2></div>
      <nav className="fr-live-tabs fr-paper-tabs">{([["account","账户"],["positions","持仓"],["history","记录"],["archive","归档"]] as const).map(([id,label])=><button key={id} className={paperTab===id?"selected":""} onClick={()=>setPaperTab(id)}>{label}</button>)}</nav>
      <TradeList trades={paperTab==="history"||paperTab==="archive"?[]:positions} now={now} empty="当前没有持仓"/>
      {(paperTab==="history"||paperTab==="archive")&&<ArchivePagination page={archivePage(recordWindows(data?.history??[],t=>t.closedAt??0).archive,paperPage).page} pages={1} onPage={setPaperPage}/>}
    </section>}

    {tab==="settings"&&<>
      {accountPanel}{liveSystemPanel}
      <section className="fr-section"><div className="fr-section-head"><h2>研究快照</h2></div>
        <button className="fr-button" onClick={exportSnapshot} disabled={exporting}>{exporting?"正在导出…":"导出研究快照 ↗"}</button>{exportStatus&&<p className="fr-note">{exportStatus}</p>}</section>
      <section className="fr-section fr-font-control"><div className="fr-section-head"><h2>界面字号</h2><b>{fontScale}%</b></div>
        <div className="fr-font-options">{[70,80,90,100,110].map(value=><button key={value} className={fontScale===value?"selected":""} onClick={()=>{setFontScale(value);try{localStorage.setItem("sentinel-ui-font-scale-v1",String(value));}catch{}}}>{value}%</button>)}</div></section>
    </>}

    {(liveMounted||(tab==="paper"&&liveEnabled))&&<div className="fr-live-panel-host" hidden={tab!=="live"&&!(tab==="paper"&&liveEnabled)}>{livePanel}</div>}
    {(error||data?.storage.error)&&<aside className="fr-error" role="alert"><b>运行提示</b><p>{data?.storage.error??error}</p></aside>}
    <footer className="fr-footer"><span>行情更新 {time(feedAt)}</span><span>{data?.engineVersion??data?.version??"—"} · 北京时间</span></footer>
    <nav className="fr-nav">{nav.map(([id,icon,label])=><button key={id} className={id===tab?"selected":""} onClick={()=>select(id)}><span>{icon}</span><b>{label}</b>{id==="overview"&&(liveEnabled?(liveOverview?.positionCount??0):held)>0&&<i>{liveEnabled?liveOverview?.positionCount:held}</i>}</button>)}</nav>
  </main>;
}

function DecisionPage({data}:{data:View|null}){
  const study=data?.forwardDesk?.study;
  return <>
    <section className="fr-section" data-testid="decision-stance">
      <div className="fr-section-head"><h2>当前决策</h2><span>正向</span></div>
      <p>研究层定方向，订单跟同一边做。</p>
      <p className="fr-note">反向账在后台单独记，这页不看。现在不自动切换。</p>
    </section>
    <section className="fr-section" data-testid="forward-study">
      <div className="fr-section-head"><h2>正向样本</h2><span>{study?`${study.recorded} 笔`:"0 笔"}</span></div>
      {study&&study.recorded>0?<>
        <div className="fr-three"><div><small>已记下</small><b>{study.recorded} 笔</b></div><div><small>赢面</small><b>{study.recorded?`${Math.round(study.recordedWins/study.recorded*100)}%`:"—"}</b></div><div><small>净额</small><b className={study.recordedNet>=0?"fr-positive":"fr-negative"}>{signed(study.recordedNet)} U</b></div></div>
        <p className="fr-note">{study.note}</p>
        <p className="fr-note">{study.coverage}</p>
        <div className="fr-study-list">{study.groups.map(g=><p key={g.label}><span>{g.label}</span><b>{g.n} 笔 · 赢 {g.wins} · {signed(g.net)} U</b></p>)}</div>
        {study.recent.length>0&&<div className="fr-study-list">{study.recent.slice(0,5).map(row=><p key={row.id}><span>{row.symbol.replace("_"," / ")} · {row.side==="LONG"?"多":"空"} · {row.tag}</span><b className={row.net>=0?"fr-positive":"fr-negative"}>{signed(row.net)} U</b></p>)}</div>}
      </>: <p className="fr-note">正向样本还没记下。记账跑过一轮就会出现。</p>}
    </section>
  </>;
}
function ForwardCurve({desk}:{desk:Desk}){
  const points=desk.curve.length?desk.curve:[{at:0,equity:desk.initialEquity}];
  const lo=Math.min(desk.initialEquity,...points.map(p=>p.equity)),hi=Math.max(desk.initialEquity,...points.map(p=>p.equity));
  const range=Math.max(1e-6,hi-lo),first=points[0]!.at,last=Math.max(first+1,points.at(-1)!.at);
  const x=(at:number)=>12+(at-first)/(last-first)*376,y=(n:number)=>164-(n-lo)/range*140;
  return <section className="fr-section" data-testid="forward-equity-curve" aria-label="正向净值">
    <div className="fr-section-head"><h2>正向净值</h2><span>{points.length} 点</span></div>
    <svg viewBox="0 0 400 185" width="100%" role="img" aria-label="正向净值曲线">
      <polyline fill="none" className="eq-curve" points={points.map(p=>`${x(p.at)},${y(p.equity)}`).join(" ")}/>
      <text x="12" y="14" fill="currentColor" fontSize="10">{fmt(hi)} U</text><text x="12" y="180" fill="currentColor" fontSize="10">{fmt(lo)} U</text>
    </svg>
    <div className="fr-three"><div><small>已扣手续费</small><b>{fmt(desk.fees)} U</b></div><div><small>浮动盈亏</small><b>{signed(desk.floating)} U</b></div><div><small>研究层平仓</small><b>{fmt(desk.resolved,0)}</b></div></div>
  </section>;
}
function ForwardOrders({desk,now}:{desk:Desk;now:number}){
  return <section className="fr-section" data-testid="forward-orders">
    <div className="fr-section-head"><h2>正向持仓</h2><span>{desk.open.length} 笔</span></div>
    {desk.open.length?desk.open.map(o=><article className="fr-order" key={o.id}><header><div><b>{o.symbol.replace("_"," / ")}</b><small>{o.side==="LONG"?"多":"空"}{o.plan?` · ${o.plan}`:""} · {fmt(o.leverage,0)}× · {duration(o.openedAt,null,now)}</small></div><b className={(o.net??0)>=0?"fr-positive":"fr-negative"}>{signed(o.net)} U</b></header>
      <small>入场 {fmt(o.entryPrice,6)} · 现价 {fmt(o.price,6)} · {time(o.openedAt)}</small></article>):<Empty title="当前没有持仓"/>}
    {desk.recent.length>0&&<><div className="fr-section-head"><h2>最近平仓</h2><span>{desk.recent.length} 笔</span></div>
      {desk.recent.map(o=><article className="fr-order" key={o.id}><header><div><b>{o.symbol.replace("_"," / ")}</b><small>{o.side==="LONG"?"多":"空"}{o.plan?` · ${o.plan}`:""}</small></div><b className={(o.net??0)>=0?"fr-positive":"fr-negative"}>{signed(o.net)} U</b></header>
        <small>{time(o.openedAt)} → {time(o.closedAt)}</small></article>)}</>}
  </section>;
}
function PaperEquitySection({data,healthy,cache,cacheScope}:{data:View|null;healthy:boolean;cache:EquityHistoryCache;cacheScope:string}){
  return <section className="fr-section" data-testid="paper-equity-curve" aria-label="原模拟账户净值">
    <div className="fr-section-head"><h2>模拟净值</h2><span>账户曲线</span></div>
    <EquityCurve data={data} healthy={healthy} cache={cache} cacheScope={cacheScope}/>
    <div className="fr-three"><div><small>模拟累计成交额</small><b>{fmt(data?.turnover)} U</b></div><div><small>模拟已扣手续费</small><b>{fmt(data?.fees)} U</b></div><div><small>模拟完成订单</small><b>{fmt(data?.resolved,0)}</b></div></div>
  </section>;
}
function TradeList({trades,now,empty}:{trades:Trade[];now:number;empty:string}){
  return <section className="fr-section fr-live-holdings">{trades.length?<div className="fr-position-list">{trades.map(t=><TradeCard key={t.id} trade={t} now={now}/>)}</div>:<Empty title={empty}/>}</section>;
}
function openTradeNetPnl(t:Trade,px=t.lastPrice){return tradePaidNetPnl(t,px);}
export function TradeCard({trade:t,now,paid}:{trade:Trade;now:number;paid?:PaidPair}){
  const open=t.status==="OPEN";
  const pair=t.inverseCopy?(paid?.status===t.status?paid:pairedPaidView(t,undefined,now||t.lastQuoteAt)):null;
  const px=pair?pair.inverse.price:open?t.lastPrice:t.exitPrice??t.lastPrice;
  const pnl=pair?pair.inverse.netPnl:open?openTradeNetPnl(t,px??t.lastPrice):t.netPnl,rate=pnl!==null&&initialTradeNotional(t)>0?pnl/initialTradeNotional(t):null,ctx=t.entryContext;
  return <details className={`fr-position-row${t.inverseCopy?" fr-inverse-row":""}${t.inverseCopy?.alignment==="WITH_SOURCE"?" is-with":""}`}><summary><span className="fr-position-primary"><b>{t.symbol.replace("_"," / ")}</b><small>{t.side==="LONG"?"多单":"空单"} · {t.inverseCopy?.alignment==="WITH_SOURCE"?"正向":t.inverseCopy?"反向":ctx?.winnerPlan?(ctx.winnerPlan.intent==="TREND"?"独立趋势":"边缘回归"):ctx?(ctx.reserve?"低风险 · ":"")+modeName(ctx.mode):"兼容持仓"}{ctx?.strategyVersion==="market-intelligence-v1"?` · ${ctx.regime??"—"}`:ctx?.relationHorizon?` · ${ctx.relationHorizon}m旧关系`:""} · {fmt(t.leverage,0)}×</small>
    <b className={(pnl??0)>=0?"fr-positive":"fr-negative"}>{signed(pnl)} U</b><small>{signed(rate===null?null:rate*100,3)}% · {duration(t.openedAt,t.closedAt,now)}</small>{pair&&<small>已扣手续费 {fmt(pair.inverse.fees,4)} U{!pair.quoteFresh?" · 估值待更新":""}</small>}</span>
    <span className="fr-position-entry"><b>{t.inverseCopy?(open?"持仓中":"已跟随出场"):open?`持仓评分 ${fmt(t.holdScore,0)}`:exitName(t.exitReason)}</b><small>MFE {fmt(t.favorable*100,2)}% · MAE {fmt(t.adverse*100,2)}% · 锁利 {fmt((t.profitFloorRate??0)*100,2)}%</small>
      <small>{t.inverseCopy?"只扣已经发生的费用":ctx?(ctx.strategyVersion==="market-intelligence-v1"?`入场评分 ${fmt(ctx.entryScore,0)} · 相关组 ${ctx.clusterId?.replace("corr:","")??"—"} · 假设 ${ctx.postEntryState??"PENDING"}`:`入场评分 ${fmt(ctx.entryScore,0)} · 旧关系 ${ctx.relationStatus??"—"} ${fmt((ctx.relationHealth??0)*100,0)} · 首次浮赢 ${t.firstProfitAt?time(t.firstProfitAt):"尚未"}`):"历史兼容持仓"}</small></span></summary>
    <article className="fr-trade fr-trade-unified"><dl><div><dt>入场价</dt><dd>{fmt(t.entryPrice,6)}</dd></div><div><dt>{open?"当前价":"出场价"}</dt><dd>{fmt(px,6)}</dd></div><div><dt>{t.inverseCopy?"出场参考":"当前防守"}</dt><dd>{fmt(t.inverseCopy?.sourceStopPrice??t.stopPrice,6)}</dd></div>
      <div><dt>名义金额</dt><dd>{fmt(t.notional)} U</dd></div><div><dt>保证金 / 杠杆</dt><dd>{fmt(t.margin)} U / {fmt(t.leverage,0)}×</dd></div><div><dt>计划风险</dt><dd>{fmt(t.plannedRisk)} U</dd></div>
      <div><dt>进场时间</dt><dd>{time(t.openedAt)}</dd></div><div><dt>平仓时间</dt><dd>{open?"尚未平仓":time(t.closedAt)}</dd></div><div><dt>持仓时长</dt><dd>{duration(t.openedAt,t.closedAt,now)}</dd></div><div><dt>预计持有</dt><dd>{fmt(t.expectedHoldMinutes,0)} 分钟</dd></div></dl>
      {t.realization&&<p className="fr-trade-reason">{t.inverseCopy?"已减仓":"已部分兑现"} {t.realization.sequence} 次 · 已实现净额 {signed(realizedNetPnl(t))} U · 剩余 {fmt(open?remainingTradeFraction(t)*100:0,0)}%</p>}
      {t.winnerManagement&&<p className="fr-trade-reason">持仓计划：{t.winnerManagement.reason}</p>}
      {ctx&&<p className="fr-trade-reason">入场依据：{ctx.reason}</p>}{t.exitReason&&<p className="fr-trade-reason">退出依据：{exitName(t.exitReason)}</p>}</article></details>;
}
function Stat({label,value,note}:{label:string;value:string;note?:string}){return <article><small>{label}</small><strong>{value}</strong>{note&&<p>{note}</p>}</article>;}
function Empty({title}:{title:string}){return <div className="fr-empty"><h3>{title}</h3></div>;}
