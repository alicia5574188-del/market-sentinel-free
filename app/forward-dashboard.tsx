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
type Tab="overview"|"execution"|"paper"|"live"|"journal"|"settings";
const fmt=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?v.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}):"—";
const signed=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?`${v>=0?"+":""}${fmt(v,d)}`:"—";
const time=(v?:number|null)=>v?new Date(v).toLocaleString("zh-CN",{timeZone:BEIJING_TIME_ZONE,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}):"—";
const duration=(start:number,end:number|null|undefined,now:number)=>{const m=Math.floor(Math.max(0,(end??now)-start)/60000);return m<1?"<1分钟":m>=60?`${Math.floor(m/60)}小时${m%60}分`:`${m}分钟`;};
const modeName=(mode:string)=>({RELATIVE:"相对异类",REVERSAL:"结构转变",CONTINUATION:"市场延续",SWING:"旧峰谷兼容",TREND_PULLBACK:"旧回调兼容",IMPULSE:"旧推进兼容",RELATION:"旧关系兼容",BREAKOUT:"旧突破兼容",RETEST:"旧回踩兼容",FAILED_BREAKOUT:"旧失败突破兼容",RANGE:"旧区域兼容",SHOCK:"旧突变兼容"}[mode]??mode);
const exitName=(reason:string|null)=>reason?({SHADOW_SOURCE_EXIT:"跟随影子退出",WINNER_STRUCTURE_EXIT:"有效结构保护",WINNER_THESIS_EXIT:"持续推动失效",RANGE_CENTER_EXIT:"回归目标兑现",STRUCTURE_STOP:"结构止损",PROFIT_GIVEBACK:"利润保护",THESIS_INVALIDATED:"交易假设失效",RELATIVE_EDGE_GONE:"相对优势消失",NO_POSITIVE_FEEDBACK:"长时间未获得正向反馈",MAX_HOLD:"最大持仓时间",ENTRY_FEEDBACK_FAILED:"旧入场反馈失败",OPPOSITE_EXTREMUM:"旧相反峰谷",TREND_DEATH:"旧趋势死亡",EXTREMUM_PROFIT_EXIT:"旧极值退出",NO_PROGRESS:"旧无进展",MARKET_FLIP:"旧市场翻转",RELATION_DEGRADED:"旧关系降级",SAMPLE_PATH_DIVERGED:"旧样本路径失配",SAMPLE_EDGE_EXHAUSTED:"旧样本优势耗尽",SAMPLE_MAX_HOLD:"旧样本最大持仓",TIME_DECAY:"旧持仓超时",OPPORTUNITY_REPLACED:"更优机会替换",STRUCTURAL_INTERRUPT_REVERSAL:"旧极端结构反转",SHOCK_REENTRY:"旧突变重新回区",FAST_STRUCTURE_FAILURE:"旧强结构快速失效",ACCOUNT_RESET:"手动重置"}[reason]??reason):"—";

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
  const [paperLedger,setPaperLedger]=useState<"inverse"|"source">("inverse");
  const scroll=useRef<Record<Tab,number>>({overview:0,execution:0,paper:0,live:0,journal:0,settings:0}),fontControl=useRef<HTMLElement|null>(null);
  useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id);},[]);
  useLayoutEffect(()=>{window.scrollTo({top:tab==="live"?0:scroll.current[tab],behavior:"auto"});},[tab]);
  const select=(next:Tab,ledger=paperLedger)=>{scroll.current[tab]=window.scrollY;if(next==="live"||(next==="paper"&&ledger==="inverse"&&liveEnabled))setLiveMounted(true);setTab(next);};
  const selectLedger=(ledger:"inverse"|"source")=>{setPaperLedger(ledger);setPaperTab("account");setPaperPage(0);select("paper",ledger);scroll.current.paper=0;window.scrollTo({top:0,behavior:"auto"});};
  const fontVars:Record<string,string>={};for(let px=10;px<=64;px++)fontVars[`--fr-fs${px}`]=`${(px*fontScale/100).toFixed(2)}px`;
  const exportSnapshot=async()=>{if(exporting)return;setExporting(true);setExportStatus(null);try{
    const snapshot=await collectReviewSnapshot(fetch,(n,total)=>setExportStatus(`正在读取订单 ${n}/${total}`));
    const blob=new Blob([JSON.stringify(snapshot)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`market-intelligence-review-${beijingDayKey()}.json`;
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);setExportStatus(snapshot.version==="market-intelligence-review-v2"&&(!snapshot.coverage.complete||snapshot.liveReview?.coverage.error||snapshot.liveReview?.coverage.limitReached||snapshot.runtime.liveReviewError)?"已导出；缺失或未核对的数据已在快照中标明。":"已开始下载。");
  }catch{setExportStatus("导出失败，请重试。");}finally{setExporting(false);}};

  const positions=data?.positions??[],opportunities=[...(data?.opportunities??[])].sort((a,b)=>Number(b.eligible)-Number(a.eligible)||Number(b.premium)-Number(a.premium)||b.score-a.score);
  const eligible=opportunities.filter(o=>o.eligible&&(!now||o.expiresAt>now));
  const pulse=data?.marketPulse,records=recordWindows(data?.history??[],t=>t.closedAt??0),archive=archivePage(records.archive,paperPage);
  const paidRows=data?.shadowInverse?.paidCost?.rows??[];
  const paperMargin=positions.reduce((n,t)=>n+t.margin,0),paperFloating=positions.reduce((n,t)=>n+(t.status==="OPEN"?remainingPaidNetPnl(t,paidRows.find(r=>r.tradeId===t.id)?.inverse.price??t.lastPrice):0),0),plannedRisk=positions.reduce((n,t)=>n+Math.max(t.plannedRisk,(t.entryContext?.portfolioRiskCharge??((t.forecast?.sizingEquity??0)*(t.entryContext?.reserve===true?.003:.006)))*remainingTradeFraction(t)),0),riskUse=data?.equity?plannedRisk/data.equity:0,elapsed=data&&now?Math.max(0,(now-data.startedAt)/3600000):null;
  const systemStatus=statusLabel==="后台运行中"?"正常":statusLabel?.startsWith("后台运行中 · ")?statusLabel.slice(8):statusLabel??(healthy?"正常":"行情恢复中");
  const actual=liveOverview?.accountMark,accountEquity=liveEnabled?liveOverview?.equity:data?.equity,
    accountPnl=liveEnabled?actual?.tradingPnl:data?.netPnl,
    accountBase=liveEnabled?actual?.initialEquity:data?.initialEquity;
  const nav:[Tab,string,string][]=[["overview","◉","总览"],["execution","⌘","执行"],["paper","⇄","模拟"],["live","◈","实盘"],["journal","≋","记录"],["settings","⊙","系统"]];
  return <main className="fr-app" style={fontVars as CSSProperties} data-ui-version="market-intelligence-v1">
    <header className="fr-compact-header"><b>哨兵 · 市场智能系统</b><span className={healthy?"fr-positive":""} role="status">{systemStatus}</span><span>实盘{liveEnabled?liveOverview?.operational?"运行中":"核对中":"关闭"}{memberName?` · ${memberName}`:""}</span></header>

    {tab==="overview"&&<>
      <section className="fr-equity fr-overview-equity" data-testid="overview-equity-first" aria-label={liveEnabled?"实盘账户权益":"模拟账户权益"}>
        <small>{liveEnabled?"实盘账户权益 · 模拟同步实盘":"模拟账户权益"} · USDT</small><strong>{fmt(accountEquity)}</strong>
        <div className={(accountPnl??0)>=0?"fr-positive":"fr-negative"}>{signed(accountPnl)} <span>U · {signed(accountPnl!=null&&accountBase?accountPnl/accountBase*100:null)}%{liveEnabled?" · 观察期交易盈亏":""}</span></div>
        <footer><span>{liveEnabled?"实盘观察基准":"起点"} {fmt(accountBase,liveEnabled?2:0)}</span><span>{liveEnabled?"观察期回撤":"最大回撤"} {fmt(liveEnabled?(actual?actual.maxDrawdown*100:null):data?data.maxDrawdown*100:null)}%</span></footer>
        <p>更新 {time(liveEnabled?liveOverview?.lastSyncAt:data?.updatedAt)}{liveEnabled&&(!liveOverview?.lastSyncAt||now-liveOverview.lastSyncAt>30000)?" · 实盘数据待更新":!liveEnabled&&data?.stalePositions?" · 持仓估值待更新":""}</p>
        {liveEnabled&&<p>基准 {time(actual?.startedAt)} · 全合约账户，含手工持仓；交易盈亏待交易所流水字段齐全后确认。净值变化 {signed(actual?.capitalChange)} U（含出入金）。</p>}
      </section>
      <section className="fr-stats">
        <Stat label="当前持仓" value={liveEnabled?`${actual?.positionCount??liveOverview?.positionCount??"—"} 笔`:data?`${positions.length} 笔`:"—"} note={`保证金 ${fmt(liveEnabled?actual?.margin:data?paperMargin:null)} U`}/>
        <Stat label="浮动盈亏" value={`${signed(liveEnabled?actual?.floating:data?paperFloating:null)} U`} note={liveEnabled?"Gate实际未实现盈亏":`计划风险 ${fmt(data?riskUse*100:null,1)}%`}/>
        <Stat label="可参与机会" value={data?`${eligible.length} 个`:"—"} note={pulse?.bias==="UP"?"市场偏多":pulse?.bias==="DOWN"?"市场偏空":pulse?"市场分化":"等待行情"}/>
        <Stat label={liveEnabled?"可用保证金":"已扣手续费"} value={`${fmt(liveEnabled?liveOverview?.available:data?.fees)} U`} note={liveEnabled?"Gate实际可用余额":`模拟成交额 ${fmt(data?.turnover)} U`}/>
      </section>
      {liveEnabled?<section className="fr-section"><div className="fr-section-head"><h2>实盘复制</h2><button className="fr-text-button" onClick={()=>selectLedger("inverse")}>查看同步账户 →</button></div>
        <p>已复制 {liveOverview?.copied??"—"} / 应复制 {liveOverview?.eligible??"—"} · 未跟上 {liveOverview?.missing??"—"}。模拟页与实盘页共用真实成交、持仓和结算记录；未成交不产生模拟利润。</p><button className="fr-text-button" onClick={()=>selectLedger("source")}>查看全部影子订单 →</button></section>:<InversePanel data={data} onSelect={selectLedger}/>}
      <PaperEquitySection data={data} healthy={healthy} cache={equityCache} cacheScope={cacheScope}/>
      {liveEnabled&&<LiveEquityCurve head={liveOverview?.equityCurve} mark={actual} enabled={liveEnabled} sessionAt={liveOverview?.sessionAt??0} cacheScope={cacheScope} now={now}/>}
      <section className="fr-section"><div className="fr-section-head"><h2>{data?.unifiedExecution?"参考机会 · 实际分支待确认":data?.shadowInverse?"影子机会 · 模拟反向":"当前最优机会"}</h2><span>{eligible.length} 个可参与</span></div>
        <OpportunityGrid rows={opportunities.slice(0,6)} inverse={!!data?.shadowInverse&&!data?.unifiedExecution}/></section>
    </>}

    {tab==="execution"&&<MarketIntelligenceExecution data={data} now={now} liveEnabled={liveEnabled} liveOverview={liveOverview}/>}

    {tab==="paper"&&<><PageTitle title={paperLedger==="source"?"影子订单":liveEnabled?"模拟账户 · 同步实盘":data?.unifiedExecution?"策略模拟账户":"反向模拟账户"}/>
      {data?.shadowInverse&&<nav className="fr-live-tabs fr-ledger-tabs" aria-label="订单账户"><button aria-pressed={paperLedger==="inverse"} className={paperLedger==="inverse"?"selected":""} onClick={()=>selectLedger("inverse")}>{data?.unifiedExecution?'策略模拟':'反向模拟'}{liveEnabled?" · 同步实盘":""}</button><button aria-pressed={paperLedger==="source"} className={paperLedger==="source"?"selected":""} onClick={()=>selectLedger("source")}>影子订单</button></nav>}
    </>}
    {tab==="paper"&&paperLedger==="source"&&<ShadowOrdersPanel data={data}/>}
    {tab==="paper"&&paperLedger==="inverse"&&liveEnabled&&<section className="fr-section" data-testid="paper-live-mirror"><p>本账户实盘成交、持仓和结算记录。</p></section>}
    {tab==="paper"&&paperLedger==="inverse"&&!liveEnabled&&<>
      <nav className="fr-live-tabs fr-paper-tabs">{([["account","账户"],["positions","持仓"],["history","记录"],["archive","归档"]] as const).map(([id,label])=><button key={id} className={paperTab===id?"selected":""} onClick={()=>setPaperTab(id)}>{label}</button>)}</nav>
      {paperTab==="account"&&<><section className="fr-stats fr-paper-summary"><Stat label="模拟权益" value={`${fmt(data?.equity)} U`} note={`起始 ${fmt(data?.initialEquity)} U`}/><Stat label="保证金占用" value={`${fmt(paperMargin)} U`} note={`${positions.length} 笔持仓`}/><Stat label="浮动盈亏" value={`${signed(data?paperFloating:null)} U`}/><Stat label="累计成交额" value={`${fmt(data?.turnover)} U`} note={`已完成 ${fmt(data?.resolved,0)} 笔`}/></section>
        <TradeList trades={positions} paidRows={paidRows} now={now} empty="当前没有模拟持仓"/></>}
      {paperTab==="positions"&&<TradeList trades={positions} paidRows={paidRows} now={now} empty="当前没有模拟持仓"/>}
      {(paperTab==="history"||paperTab==="archive")&&<section className="fr-section"><div className="fr-section-head"><h2>{paperTab==="history"?"最近记录":"归档记录"}</h2><span>{paperTab==="history"?"最新10条":"更早记录"}</span></div>
        <TradeList trades={paperTab==="history"?records.recent:archive.items} paidRows={paidRows} now={now} empty="暂无已平仓记录" compact/>
        {paperTab==="archive"&&<ArchivePagination page={archive.page} pages={archive.pages} onPage={setPaperPage}/>}</section>}
    </>}

    {tab==="journal"&&<><section className="fr-section"><div className="fr-section-head"><h2>研究快照</h2></div>
      <button className="fr-button" onClick={exportSnapshot} disabled={exporting}>{exporting?"正在导出…":"导出研究快照 ↗"}</button>{exportStatus&&<p className="fr-note">{exportStatus}</p>}</section>
      <section className="fr-section"><div className="fr-section-head"><h2>运行记录</h2><span>{data?.events.length??0} 条</span></div>
        {(data?.events.length??0)>0?<div className="fr-journal">{data!.events.slice(0,80).map(e=><article key={e.id}><time>{time(e.at)}</time><div><b>{e.kind}</b><p>{e.reason}</p></div></article>)}</div>:<Empty title="暂无运行记录"/>}</section></>}

    {tab==="settings"&&<><PageTitle title="系统"/>
      {accountPanel}{liveSystemPanel}
      <section ref={fontControl} className="fr-section fr-font-control"><div className="fr-section-head"><h2>界面字号</h2><b>{fontScale}%</b></div>
        <div className="fr-font-options">{[70,80,90,100,110].map(value=><button key={value} className={fontScale===value?"selected":""} onClick={()=>{setFontScale(value);try{localStorage.setItem("sentinel-ui-font-scale-v1",String(value));}catch{}}}>{value}%</button>)}</div></section>
    </>}

    {(liveMounted||(tab==="paper"&&paperLedger==="inverse"&&liveEnabled))&&<div className="fr-live-panel-host" hidden={tab!=="live"&&!(tab==="paper"&&paperLedger==="inverse"&&liveEnabled)}>{livePanel}</div>}
    {(error||data?.storage.error)&&<aside className="fr-error" role="alert"><b>运行提示</b><p>{data?.storage.error??error}</p></aside>}
    <footer className="fr-footer"><span>行情更新 {time(feedAt)} · 运行 {elapsed==null?"—":fmt(elapsed,1)} 小时</span><span>{data?.engineVersion??data?.version??"—"} · 北京时间</span></footer>
    <nav className="fr-nav">{nav.map(([id,icon,label])=><button key={id} className={id===tab?"selected":""} onClick={()=>select(id)}><span>{icon}</span><b>{label}</b>{id==="paper"&&(liveEnabled?(liveOverview?.positionCount??0):positions.length)>0&&<i>{liveEnabled?liveOverview?.positionCount:positions.length}</i>}</button>)}</nav>
  </main>;
}

function PaperEquitySection({data,healthy,cache,cacheScope}:{data:View|null;healthy:boolean;cache:EquityHistoryCache;cacheScope:string}){
  return <section className="fr-section" data-testid="paper-equity-curve" aria-label="原模拟账户净值">
    <div className="fr-section-head"><h2>模拟净值</h2><span>原模拟账本</span></div>
    <EquityCurve data={data} healthy={healthy} cache={cache} cacheScope={cacheScope}/>
    <div className="fr-three"><div><small>模拟累计成交额</small><b>{fmt(data?.turnover)} U</b></div><div><small>模拟已扣手续费</small><b>{fmt(data?.fees)} U</b></div><div><small>模拟完成订单</small><b>{fmt(data?.resolved,0)}</b></div></div>
  </section>;
}

function OpportunityGrid({rows,details=false,inverse=false}:{rows:NonNullable<View["opportunities"]>;details?:boolean;inverse?:boolean}){
  if(!rows.length)return <Empty title="暂无已确认机会"/>;
  return <div className="fr-scoreboard">{rows.map((o,index)=><details className={`fr-score-row ${o.eligible?"is-eligible":""}`} key={o.id} open={false}>
    <summary><span className="fr-score-rank">#{index+1}</span><span className="fr-score-value">{fmt(o.score,0)}</span><span className="fr-score-symbol"><b>{o.symbol.replace("_"," / ")}</b><small>{inverse?`影子${o.side==="LONG"?"多 → 模拟空":"空 → 模拟多"}`:o.side==="LONG"?"做多":"做空"} · {modeName(o.mode)}</small></span>
      <span><small>方向</small><b>{fmt(o.directionStrength,0)}</b></span><span><small>净空间</small><b>{fmt(o.netRemainingSpaceRate*100,2)}%</b></span><span><small>空间/回调</small><b>{fmt(o.edgeRatio,2)}×</b></span><em>{o.eligible?(o.premium?"高级":o.reserve?"补位":"主机会"):"观察"}</em></summary>
    {details&&<div className="fr-score-details"><div><h3>质量</h3><div className="fr-score-detail-grid"><Metric label="路径效率" value={fmt(o.pathEfficiency,0)}/><Metric label="动量持续" value={fmt(o.momentumPersistence,0)}/><Metric label="位置" value={fmt(o.positionScore,0)}/><Metric label="盘口" value={fmt(o.executionScore,0)}/></div></div>
      <div><h3>空间与风险</h3><div className="fr-score-detail-grid"><Metric label="总剩余空间" value={`${fmt(o.grossRemainingSpaceRate*100,2)}%`}/><Metric label="回调风险" value={`${fmt(o.pullbackRiskRate*100,2)}%`}/><Metric label="预计持有" value={`${fmt(o.expectedHoldMinutes,0)} 分钟`}/><Metric label="市场适配" value={fmt(o.marketFit,0)}/></div></div><p>{o.reason}</p></div>}
  </details>)}</div>;
}
function TradeList({trades,now,empty,compact=false,paidRows=[]}:{trades:Trade[];now:number;empty:string;compact?:boolean;paidRows?:PaidPair[]}){
  return <section className={compact?"":"fr-section fr-live-holdings"}>{!compact&&<div className="fr-section-head"><h2>当前持仓</h2><span>{trades.length} 笔</span></div>}
    {trades.length?<div className="fr-position-list">{trades.map(t=><TradeCard key={t.id} trade={t} now={now} paid={paidRows.find(r=>r.tradeId===t.id)}/>)}</div>:<Empty title={empty}/>}</section>;
}
function openTradeNetPnl(t:Trade,px=t.lastPrice){
  return tradePaidNetPnl(t,px);
}
export function TradeCard({trade:t,now,paid}:{trade:Trade;now:number;paid?:PaidPair}){
  const open=t.status==="OPEN";
  const pair=t.inverseCopy?(paid?.status===t.status?paid:pairedPaidView(t,undefined,now||t.lastQuoteAt)):null;
  const px=pair?pair.inverse.price:open?t.lastPrice:t.exitPrice??t.lastPrice;
  const pnl=pair?pair.inverse.netPnl:open?openTradeNetPnl(t,px??t.lastPrice):t.netPnl,rate=pnl!==null&&initialTradeNotional(t)>0?pnl/initialTradeNotional(t):null,ctx=t.entryContext;
  return <details className={`fr-position-row${t.inverseCopy?" fr-inverse-row":""}`}><summary><span className="fr-position-primary"><b>{t.symbol.replace("_"," / ")}</b><small>{t.side==="LONG"?"多单":"空单"} · {t.unified?(t.unified.branch==='RETURN'?'回退':'延续'):t.inverseCopy?"影子反向":ctx?.winnerPlan?(ctx.winnerPlan.intent==="TREND"?"独立趋势":"边缘回归"):ctx?(ctx.reserve?"低风险 · ":"")+modeName(ctx.mode):"兼容持仓"}{ctx?.strategyVersion==="market-intelligence-v1"?` · ${ctx.regime??"—"}`:ctx?.relationHorizon?` · ${ctx.relationHorizon}m旧关系`:""} · {fmt(t.leverage,0)}×</small>
    <b className={(pnl??0)>=0?"fr-positive":"fr-negative"}>{signed(pnl)} U</b><small>{signed(rate===null?null:rate*100,3)}% · {duration(t.openedAt,t.closedAt,now)}</small>{pair&&<small>已扣手续费 {fmt(pair.inverse.fees,4)} U{!pair.quoteFresh?" · 估值待更新":""}</small>}</span>
    <span className="fr-position-entry"><b>{t.unified?`${t.unified.branch==='RETURN'?'回退':'延续'} · ${open?'持仓中':'已退出'}`:t.inverseCopy?(open?"仅跟随影子":"跟随影子退出"):open?`持仓评分 ${fmt(t.holdScore,0)}`:exitName(t.exitReason)}</b><small>MFE {fmt(t.favorable*100,2)}% · MAE {fmt(t.adverse*100,2)}% · 锁利 {fmt((t.profitFloorRate??0)*100,2)}%</small>
      <small>{t.inverseCopy?"反向模拟 · 仅扣已发生费用":ctx?(ctx.strategyVersion==="market-intelligence-v1"?`入场评分 ${fmt(ctx.entryScore,0)} · 相关组 ${ctx.clusterId?.replace("corr:","")??"—"} · 假设 ${ctx.postEntryState??"PENDING"}`:`入场评分 ${fmt(ctx.entryScore,0)} · 旧关系 ${ctx.relationStatus??"—"} ${fmt((ctx.relationHealth??0)*100,0)} · 首次浮赢 ${t.firstProfitAt?time(t.firstProfitAt):"尚未"}`):"历史兼容持仓"}</small></span></summary>
    <article className="fr-trade fr-trade-unified"><dl><div><dt>入场价</dt><dd>{fmt(t.entryPrice,6)}</dd></div><div><dt>{open?"当前价":"出场价"}</dt><dd>{fmt(px,6)}</dd></div><div><dt>{t.unified?.branch==='RETURN'?"原退出事件参考":t.inverseCopy?"源单退出参考":"当前防守"}</dt><dd>{fmt(t.inverseCopy?.sourceStopPrice??t.stopPrice,6)}</dd></div>
      <div><dt>名义金额</dt><dd>{fmt(t.notional)} U</dd></div><div><dt>保证金 / 杠杆</dt><dd>{fmt(t.margin)} U / {fmt(t.leverage,0)}×</dd></div><div><dt>{t.inverseCopy?"源单风险参考":"计划风险"}</dt><dd>{fmt(t.plannedRisk)} U</dd></div>
      <div><dt>进场时间</dt><dd>{time(t.openedAt)}</dd></div><div><dt>平仓时间</dt><dd>{open?"尚未平仓":time(t.closedAt)}</dd></div><div><dt>持仓时长</dt><dd>{duration(t.openedAt,t.closedAt,now)}</dd></div><div><dt>预计持有</dt><dd>{fmt(t.expectedHoldMinutes,0)} 分钟</dd></div></dl>
      {t.realization&&<p className="fr-trade-reason">{t.inverseCopy?"已跟随减仓":"已部分兑现"} {t.realization.sequence} 次 · 已实现净额 {signed(realizedNetPnl(t))} U · 剩余 {fmt(open?remainingTradeFraction(t)*100:0,0)}%</p>}
      {t.unified&&<p className="fr-trade-reason">进场：{t.unified.entryReason}<br/>持仓：{t.unified.holdReason}<br/>退出：{open?t.unified.exitCondition:t.exitAudit?.detail??t.exitReason}</p>}
      {t.inverseCopy&&<p className="fr-trade-reason">影子单 {t.inverseCopy.sourceId} · {t.inverseCopy.fills.length} 次成交配对 · {t.inverseCopy.sourceExitReason??"影子尚未退出"}</p>}{t.winnerManagement&&<p className="fr-trade-reason">持仓计划：{t.winnerManagement.reason}</p>}
      {ctx&&<p className="fr-trade-reason">入场依据：{ctx.reason}</p>}{t.exitReason&&<p className="fr-trade-reason">退出依据：{exitName(t.exitReason)}</p>}</article></details>;
}
export function ShadowOrdersPanel({data}:{data:View|null}){
  const v=data?.shadowInverse,paid=v?.paidCost,trades=data?.unifiedExecution?data.unifiedExecution.baseline.retainedTrades:[...(data?.positions??[]),...(data?.history??[])],
    rows=[...(paid?.rows??[]),...trades.filter(t=>t.status==='CLOSED').flatMap(t=>{const pair=t.inverseCopy?pairedPaidView(t,undefined,data?.updatedAt):null;return pair?[pair]:[];})];
  const tradeById=new Map(trades.map(t=>[t.id,t]));
  return <section className="fr-section" data-testid="shadow-orders-panel" aria-label="全部影子配对订单">
    <div className="fr-section-head"><h2>原策略影子</h2><span>持仓 {rows.filter(r=>r.status==="OPEN").length} · 当前已平仓记录 {rows.filter(r=>r.status==="CLOSED").length}</span></div>
    <p className="fr-paid-note">以下为切换后的影子配对订单，使用影子方向、成交价和已扣费用。与当前实盘账户分别统计；不含切换前旧单，记录范围以当前账本为准。</p>
    <div className="fr-three"><div><small>影子配对净额</small><b className={(paid?.source.netPnl??0)>=0?"fr-positive":"fr-negative"}>{signed(paid?.source.netPnl)} U</b></div><div><small>影子已扣手续费</small><b>{fmt(v?.sourceFees,4)} U</b></div><div><small>已配对订单</small><b>{v?.pairedOpened??"—"}</b></div></div>
    {rows.length?<div className="fr-position-list">{[...rows].sort((a,b)=>Number(b.status==="OPEN")-Number(a.status==="OPEN")||(tradeById.get(b.tradeId)?.openedAt??0)-(tradeById.get(a.tradeId)?.openedAt??0)).map(pair=>{
      const t=tradeById.get(pair.tradeId),leg=pair.source;
      return <article className="fr-shadow-order" key={pair.sourceId} data-source-id={pair.sourceId}>
        <div className="fr-section-head"><h3>{t?.symbol.replace("_"," / ")??pair.sourceId}</h3><b className={(leg.netPnl??0)>=0?"fr-positive":"fr-negative"}>{signed(leg.netPnl)} U</b></div>
        <p>{leg.side==="LONG"?"多单":"空单"} · {pair.status==="OPEN"?"持仓中":"已平仓"}{!pair.quoteFresh?" · 估值待更新":""}</p>
        <div className="fr-shadow-metrics"><Metric label="影子入场价" value={fmt(leg.entryPrice,6)}/><Metric label={pair.status==="OPEN"?"当前价":"出场价"} value={fmt(leg.price,6)}/><Metric label="毛盈亏" value={`${signed(leg.grossPnl,4)} U`}/><Metric label="已扣手续费" value={`${fmt(leg.fees,4)} U`}/></div>
        <small>开仓 {time(t?.openedAt)}{pair.status==="CLOSED"?` · 平仓 ${time(t?.closedAt)}`:""}{pair.exitFills?` · ${pair.exitFills} 次退出成交`:""}</small>
      </article>;
    })}</div>:<Empty title="暂无影子配对订单"/>}
  </section>;
}
function InversePanel({data,onSelect}:{data:View|null;onSelect:(ledger:"inverse"|"source")=>void}){
  const v=data?.shadowInverse;if(!v)return null;
  const actual=data?.unifiedExecution?data.netPnl:v.paidCost?.inverse.netPnl,actualFees=data?.unifiedExecution?data.fees:v.inverseFees;
  const points=[...v.curve,{at:data!.updatedAt,source:v.sourceEquity,inverse:v.inverseEquity,theoretical:v.theoreticalSamePriceEquity}],
    lo=Math.min(v.initialEquity,...points.flatMap(p=>[p.source,p.inverse])),hi=Math.max(v.initialEquity,...points.flatMap(p=>[p.source,p.inverse])),
    range=Math.max(1,hi-lo),first=points[0]?.at??v.cutoverAt,last=Math.max(first+1,points.at(-1)!.at),
    x=(at:number)=>12+(at-first)/(last-first)*376,y=(n:number)=>164-(n-lo)/range*140,
    segments:(typeof points)[]=[];
  for(const p of points){const segment=segments.at(-1);if(!segment||p.at-segment.at(-1)!.at>15*60_000)segments.push([p]);else segment.push(p);}
  return <section className="fr-section" data-testid="shadow-inverse-comparison"><div className="fr-section-head"><h2>{data?.unifiedExecution?'策略模拟 / 影子':'反向模拟 / 影子'}</h2><span>{data?.unifiedExecution?'独立对照':'配对订单'}</span></div>
    <div className="fr-paid-summary" data-testid="paired-paid-summary"><button onClick={()=>onSelect("inverse")}><small>{data?.unifiedExecution?'策略账户净额':'反向模拟净额'}</small><b className={(actual??0)>=0?"fr-positive":"fr-negative"}>{signed(actual)} U</b><small>已扣手续费 {fmt(actualFees,4)} U</small></button>
      <button onClick={()=>onSelect("source")}><small>原策略影子净额</small><b className={(v.paidCost?.source.netPnl??0)>=0?"fr-positive":"fr-negative"}>{signed(v.paidCost?.source.netPnl)} U</b><small>已扣手续费 {fmt(v.sourceFees,4)} U · 查看全部订单 →</small></button></div>
    {data?.unifiedExecution&&<p className="fr-paid-note">原反向基准净额 {signed(data.unifiedExecution.baseline.netPnl)} U · 独立运行，供研究比较。</p>}
    <p className="fr-paid-note">净额只扣已发生费用，未平仓部分含浮动盈亏；已配对 / 已完成 {v.pairedOpened} / {v.pairedClosed}。</p>
    {!!v.paidCost?.stalePairs&&<p className="fr-paid-note">{v.paidCost.stalePairs} 组报价待更新，净额使用各自最后记录；缺失价格显示 —。</p>}
    <details><summary>同价镜像对照曲线</summary><p>虚线：影子 · 实线：反向模拟 · 同一成交价、同一当前价，只反方向；净额只扣已发生手续费。共同起点 {fmt(v.initialEquity)} U</p>
      {v.paidCost&&<p className="fr-paid-note">毛盈亏镜像校验 {fmt(v.paidCost.reconciliation.grossMirrorResidual,6)} U（应为 0） · 两边净额合计 {fmt(v.paidCost.reconciliation.netSum,4)} U ＝ −已扣手续费合计 {fmt(v.paidCost.reconciliation.paidFees,4)} U</p>}
      <p>切换 {time(v.cutoverAt)} · 旧持仓 {v.legacyOpen} 笔单独收尾</p>
      <svg viewBox="0 0 400 185" width="100%" role="img" aria-label="切换后配对订单的影子与反向模拟对照，缺失处断开">
        {segments.map((rows,k)=><g key={k}><polyline fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="5 4" points={rows.map(p=>`${x(p.at)},${y(p.source)}`).join(' ')}/>
          <polyline fill="none" className="eq-curve" points={rows.map(p=>`${x(p.at)},${y(p.inverse)}`).join(' ')}/></g>)}
        <text x="12" y="14" fill="currentColor" fontSize="10">{fmt(hi)} U</text><text x="12" y="180" fill="currentColor" fontSize="10">{fmt(lo)} U</text>
      </svg><p>各自已扣手续费：影子 {fmt(v.sourceFees)} U / 反向 {fmt(v.inverseFees)} U</p>
      <p>仅统计新配对订单；原账户总曲线保留在下方。{v.stalePositions?"当前报价不齐，估值待更新。":""}</p>
    </details></section>;
}
function Metric({label,value}:{label:string;value:string}){return <span><small>{label}</small><b>{value}</b></span>;}
function Stat({label,value,note}:{label:string;value:string;note?:string}){return <article><small>{label}</small><strong>{value}</strong>{note&&<p>{note}</p>}</article>;}
function Empty({title}:{title:string}){return <div className="fr-empty"><h3>{title}</h3></div>;}
function PageTitle({title}:{title:string}){return <section className="fr-compact-title"><h1>{title}</h1></section>;}
