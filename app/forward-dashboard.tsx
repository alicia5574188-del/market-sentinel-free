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

type View=ReturnType<typeof forwardSummary>;
type Desk=NonNullable<View["forwardDesk"]>;
type Tab="overview"|"research"|"decision"|"paper"|"live"|"settings";
const fmt=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?v.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}):"—";
const signed=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?`${v>=0?"+":""}${fmt(v,d)}`:"—";
const time=(v?:number|null)=>v?new Date(v).toLocaleString("zh-CN",{timeZone:BEIJING_TIME_ZONE,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}):"—";
const duration=(start:number,end:number|null|undefined,now:number)=>{const m=Math.floor(Math.max(0,(end??now)-start)/60000);return m<1?"<1分钟":m>=60?`${Math.floor(m/60)}小时${m%60}分`:`${m}分钟`;};
const modeName=(mode:string)=>({RELATIVE:"相对异类",REVERSAL:"结构转变",CONTINUATION:"市场延续",SWING:"旧峰谷兼容",TREND_PULLBACK:"旧回调兼容",IMPULSE:"旧推进兼容",RELATION:"旧关系兼容",BREAKOUT:"旧突破兼容",RETEST:"旧回踩兼容",FAILED_BREAKOUT:"旧失败突破兼容",RANGE:"旧区域兼容",SHOCK:"旧突变兼容"}[mode]??mode);
const exitName=(reason:string|null)=>reason?({SHADOW_SOURCE_EXIT:"提案平仓",INVERSE_SOFT_LOSS_EXIT:"浮亏到线，提前平仓",DESK_SWEEP_EXIT:"打穿确认位",DESK_NO_PROGRESS_EXIT:"30分钟没走出成本",DESK_GIVEBACK_EXIT:"利润回吐一半",DESK_HORIZON_EXIT:"满90分钟",WINNER_STRUCTURE_EXIT:"有效结构保护",WINNER_THESIS_EXIT:"持续推动失效",RANGE_CENTER_EXIT:"回归目标兑现",STRUCTURE_STOP:"结构止损",PROFIT_GIVEBACK:"利润保护",THESIS_INVALIDATED:"交易假设失效",RELATIVE_EDGE_GONE:"相对优势消失",NO_POSITIVE_FEEDBACK:"长时间未获得正向反馈",MAX_HOLD:"最大持仓时间",ENTRY_FEEDBACK_FAILED:"旧入场反馈失败",OPPOSITE_EXTREMUM:"旧相反峰谷",TREND_DEATH:"旧趋势死亡",EXTREMUM_PROFIT_EXIT:"旧极值退出",NO_PROGRESS:"旧无进展",MARKET_FLIP:"旧市场翻转",RELATION_DEGRADED:"旧关系降级",SAMPLE_PATH_DIVERGED:"旧样本路径失配",SAMPLE_EDGE_EXHAUSTED:"旧样本优势耗尽",SAMPLE_MAX_HOLD:"旧样本最大持仓",TIME_DECAY:"旧持仓超时",OPPORTUNITY_REPLACED:"更优机会替换",STRUCTURAL_INTERRUPT_REVERSAL:"旧极端结构反转",SHOCK_REENTRY:"旧突变重新回区",FAST_STRUCTURE_FAILURE:"旧强结构快速失效",ACCOUNT_RESET:"手动重置",STRETCH_WRONG_EXIT:"反向到了 0.5%",STRETCH_GIVEBACK_EXIT:"利润吐回一半",STRETCH_TIME_EXIT:"满两小时",LSR_TP_EXIT:"止盈 0.30%",LSR_SL_EXIT:"止损 0.20%",LSR_BE_EXIT:"回到成本",LSR_TIME_EXIT:"满十五分钟",LSR_REVERSE_EXIT:"出现反向信号"}[reason]??reason):"—";
const stanceName=(stance?:string)=>stance==="REVERSE"?"反向":stance==="FLAT"?"先停":"正向";
const sessionName=(session?:string)=>session==="ASIA"?"亚盘":session==="EUROPE"?"欧盘":session==="US"?"美盘":"—";
const claimName=(kind?:string)=>kind==="CONTINUE"?"延续":kind==="SUSPECT"?"可疑":"不投票";

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
    const response=await fetch("/api/forward/export?kind=log",{cache:"no-store",credentials:"same-origin"});
    if(!response.ok)throw new Error("log");
    const log=await response.json() as {version?:string;funnel?:{scans?:number;signals?:number;filled?:number;trend?:number;exhaustion?:number;stale?:number};breakdown?:{verdict?:string}};
    const blob=new Blob([JSON.stringify(log,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`lsr-run-log-${beijingDayKey()}.json`;
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    const f=log.funnel;
    setExportStatus(log.version==="lsr-run-log-v1"?`已开始下载。${log.breakdown?.verdict??""}。扫描 ${f?.scans??0} 次，信号 ${f?.signals??0}，成交 ${f?.filled??0}，没走出趋势 ${f?.trend??0}，数据过期 ${f?.stale??0}。`:"已开始下载。");
  }catch{setExportStatus("导出失败，请重试。");}finally{setExporting(false);}};

  const desk=data?.forwardDesk??null,positions=data?.positions??[];
  const usingDesk=!!desk&&!liveEnabled;
  const stanceLabel=desk?.book==="lsr-v1"?"衰竭":desk?.book==="stretch-v1"?"新账":desk?.book==="reverse-v1"?"反向":desk?.book==="needle-v1"||desk?.book==="brain-v1"||desk?.book==="score-v1"||desk?.book==="read-v1"?"账户":stanceName(desk?.stance);
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
      <section className="fr-equity fr-overview-equity" data-testid="overview-equity-first" aria-label={liveEnabled?"实盘账户权益":usingDesk?`${stanceLabel}权益`:"模拟账户权益"}>
        <small>{liveEnabled?"实盘账户权益":usingDesk?`${stanceLabel}权益`:"模拟账户权益"} · USDT</small><strong>{fmt(accountEquity)}</strong>
        <div className={(accountPnl??0)>=0?"fr-positive":"fr-negative"}>{signed(accountPnl)} <span>U · {signed(accountPnl!=null&&accountBase?accountPnl/accountBase*100:null)}%{liveEnabled?" · 观察期交易盈亏":""}</span></div>
        <footer><span>{liveEnabled?"实盘观察基准":"起点"} {fmt(accountBase,liveEnabled?2:0)}</span><span>{liveEnabled?"观察期回撤":"最大回撤"} {fmt(drawdown)}%</span></footer>
        <p>更新 {time(liveEnabled?liveOverview?.lastSyncAt:data?.updatedAt)}{liveEnabled&&(!liveOverview?.lastSyncAt||now-liveOverview.lastSyncAt>30000)?" · 实盘数据待更新":!liveEnabled&&(usingDesk?desk.stale:data?.stalePositions)?" · 持仓估值待更新":""}</p>
        {liveEnabled&&<p>基准 {time(actual?.startedAt)} · 全合约账户，含手工持仓；交易盈亏待交易所流水字段齐全后确认。净值变化 {signed(actual?.capitalChange)} U（含出入金）。</p>}
      </section>
      <section className="fr-stats">
        <Stat label="当前持仓" value={liveEnabled?`${actual?.positionCount??liveOverview?.positionCount??"—"} 笔`:data?`${held} 笔`:"—"} note={liveEnabled?`保证金 ${fmt(actual?.margin)} U`:usingDesk?`已平 ${fmt(desk.resolved,0)} 笔`:`保证金 ${fmt(positions.reduce((n,t)=>n+t.margin,0))} U`}/>
        <Stat label="浮动盈亏" value={`${signed(liveEnabled?actual?.floating:data?paperFloating:null)} U`} note={liveEnabled?"Gate实际未实现盈亏":usingDesk?"持仓浮动":`计划风险 ${fmt(data?.equity?positions.reduce((n,t)=>n+t.plannedRisk,0)/data.equity*100:null,1)}%`}/>
        <Stat label="已完成" value={usingDesk?`${fmt(desk.resolved,0)} 笔`:data?`${fmt(data.resolved,0)} 笔`:"—"} note={usingDesk?`赢 ${fmt(desk.wins,0)} 笔`:"订单记录"}/>
        <Stat label={liveEnabled?"可用保证金":"已扣手续费"} value={`${fmt(liveEnabled?liveOverview?.available:usingDesk?desk.fees:data?.fees)} U`} note={liveEnabled?"Gate实际可用余额":usingDesk?"决策账户成交费用":`成交额 ${fmt(data?.turnover)} U`}/>
      </section>
      {liveEnabled&&<section className="fr-section"><div className="fr-section-head"><h2>实盘复制</h2></div>
        <p>已复制 {liveOverview?.copied??"—"} / 应复制 {liveOverview?.eligible??"—"} · 未跟上 {liveOverview?.missing??"—"}。成交和持仓以实盘页为准。</p></section>}
      {desk?.book==="lsr-v1"&&<LsrPulse note={desk.lsrNote} board={desk.lsrBoard} net={desk.netPnl} floating={desk.floating}/>}
      {desk?<ForwardCurve desk={desk}/>:<PaperEquitySection data={data} healthy={healthy} cache={equityCache} cacheScope={cacheScope}/>}
      {liveEnabled&&<LiveEquityCurve head={liveOverview?.equityCurve} mark={actual} enabled={liveEnabled} sessionAt={liveOverview?.sessionAt??0} cacheScope={cacheScope} now={now}/>}
      {desk&&<ForwardOrders desk={desk} now={now}/>}
    </>}

    {tab==="research"&&desk?.book==="lsr-v1"&&<LsrResearch desk={desk}/>}
    {tab==="research"&&(desk?.book==="read-v1"||desk?.book==="brain-v1"||desk?.book==="stretch-v1")&&<WorkResearch work={desk.work} note={desk.book==="stretch-v1"?desk.stretchNote:desk.book==="brain-v1"?desk.brainNote:desk.readNote} ideas={desk.book==="brain-v1"?desk.brainIdeas:[ ]}/>}
    {tab==="research"&&desk?.book==="score-v1"&&<section className="fr-section" data-testid="research-claims"><div className="fr-section-head"><h2>研究</h2></div>
      <p>{desk.scoreNote||"还没有记下半小时。"}</p>
      <p className="fr-note">每一窗半小时。看哪些币比大多数币偏了至少 0.5%。这些币合成一个结果，不把每个币当成一条证据。前二十窗选止损、目标和方向，后二十窗扣完费用仍赚钱，才交给决策。够格的币中位数不到 6 个，不做。</p>
    </section>}
    {tab==="research"&&desk?.book==="needle-v1"&&<section className="fr-section" data-testid="research-claims"><div className="fr-section-head"><h2>研究</h2></div>
      <p>只看最近 30 根 1 分钟线，和当前买一卖一。一根线冲出这 30 分钟的高点或低点，收盘又回到里面，就记成一根针。研究只记这件事，不开单。</p>
    </section>}
    {tab==="research"&&desk?.book==="reverse-v1"&&<section className="fr-section" data-testid="research-claims"><div className="fr-section-head"><h2>这套在做什么</h2></div>
      <p>不研究行情，也不给提案打分。提案那边每开一笔，这里就开一笔相反的。金额和提案一样。</p>
      <p className="fr-note">出场沿用上次那套：打穿确认位、30 分钟没走出成本、利润回吐一半、满 90 分钟、提案自己平仓，或者浮亏到 10U。不会因为样本不够改回跟提案同一边。</p>
    </section>}
    {tab==="research"&&desk?.book!=="needle-v1"&&desk?.book!=="brain-v1"&&desk?.book!=="score-v1"&&desk?.book!=="read-v1"&&desk?.book!=="reverse-v1"&&desk?.book!=="stretch-v1"&&desk?.book!=="lsr-v1"&&<>
      <section className="fr-section" data-testid="research-claims"><div className="fr-section-head"><h2>研究裁决</h2><span>{desk?.research?`${desk.research.unsettled} 笔未到期`:"等待提案"}</span></div>
        <p>每笔提案先记下读法。过 30 分钟，用价格判断对错，不看这笔后来怎么平的。</p>
        <p className="fr-note">慢方向和这一拍同向，并且和提案同向，记成延续。两边打架，或者都和提案相反，记成可疑。有一边没方向，就不投票。</p>
        {desk?.research&&desk.research.claims.length>0?<div className="fr-study-list">{desk.research.claims.map(c=>{
          const verdict=!c.settled?"未到期":c.kind==="SKIP"?"不投票":c.correct?"对了":"错了";
          return <p key={c.id}><span>{c.symbol.replace("_"," / ")} · {c.engineSide==="LONG"?"多":"空"} · {claimName(c.kind)} · {sessionName(c.session)}</span><b>{verdict}{c.swept?" · 已打穿确认位":""}</b></p>;
        })}</div>:<p className="fr-note">还没有记下提案。</p>}
      </section>
      <section className="fr-section"><div className="fr-section-head"><h2>行情状态</h2><span>不决定正反</span></div>
        <p className="fr-note">{tape?.sentence??"这一拍的原数还没有。"}</p>
        {(tape?.lines??[]).map(line=><p key={line} className="fr-note">{line}</p>)}
      </section>
      <MarketIntelligenceExecution data={data} now={now} liveEnabled={liveEnabled} liveOverview={liveOverview}/>
    </>}

    {tab==="decision"&&<DecisionPage data={data} now={now}/>}

    {tab==="paper"&&liveEnabled&&<section className="fr-section" data-testid="paper-live-mirror"><p>本账户实盘成交、持仓和结算记录。</p></section>}
    {tab==="paper"&&!liveEnabled&&<section className="fr-section"><div className="fr-section-head"><h2>订单</h2></div>
      <nav className="fr-live-tabs fr-paper-tabs">{([["account","账户"],["positions","持仓"],["history","记录"],["archive","归档"]] as const).map(([id,label])=><button key={id} className={paperTab===id?"selected":""} onClick={()=>setPaperTab(id)}>{label}</button>)}</nav>
      <TradeList trades={paperTab==="history"||paperTab==="archive"?[]:positions} now={now} empty="当前没有持仓"/>
      {(paperTab==="history"||paperTab==="archive")&&<ArchivePagination page={archivePage(recordWindows(data?.history??[],t=>t.closedAt??0).archive,paperPage).page} pages={1} onPage={setPaperPage}/>}
    </section>}

    {tab==="settings"&&<>
      {accountPanel}{liveSystemPanel}
      <section className="fr-section"><div className="fr-section-head"><h2>运行日志</h2></div>
        <p className="fr-note">一个文件。没做单看策略计数，挂了没成交看 EXEC，行情断了看 DATA。策略和运行分开记。</p>
        <button className="fr-button" onClick={exportSnapshot} disabled={exporting}>{exporting?"正在导出…":"导出运行日志 ↗"}</button>{exportStatus&&<p className="fr-note">{exportStatus}</p>}</section>
      <section className="fr-section fr-font-control"><div className="fr-section-head"><h2>界面字号</h2><b>{fontScale}%</b></div>
        <div className="fr-font-options">{[70,80,90,100,110].map(value=><button key={value} className={fontScale===value?"selected":""} onClick={()=>{setFontScale(value);try{localStorage.setItem("sentinel-ui-font-scale-v1",String(value));}catch{}}}>{value}%</button>)}</div></section>
    </>}

    {(liveMounted||(tab==="paper"&&liveEnabled))&&<div className="fr-live-panel-host" hidden={tab!=="live"&&!(tab==="paper"&&liveEnabled)}>{livePanel}</div>}
    {(error||data?.storage.error)&&<aside className="fr-error" role="alert"><b>运行提示</b><p>{data?.storage.error??error}</p></aside>}
    <footer className="fr-footer"><span>行情更新 {time(feedAt)}</span><span>{data?.engineVersion??data?.version??"—"} · 北京时间</span></footer>
    <nav className="fr-nav">{nav.map(([id,icon,label])=><button key={id} className={id===tab?"selected":""} onClick={()=>select(id)}><span>{icon}</span><b>{label}</b>{id==="overview"&&(liveEnabled?(liveOverview?.positionCount??0):held)>0&&<i>{liveEnabled?liveOverview?.positionCount:held}</i>}</button>)}</nav>
  </main>;
}

function LsrPulse({note,board,net,floating}:{note?:string;board?:Desk["lsrBoard"];net:number|null;floating:number|null}){
  const prior=board?.priorNet??0;
  const closed=board?.closedNet??(net!=null&&floating!=null?net-floating-prior:null);
  const openMark=net!=null&&closed!=null?net-prior-closed:floating;
  return <section className="fr-section lsr-pulse" data-testid="lsr-pulse">
    <div className="fr-section-head"><h2>这一拍</h2></div>
    <b>{board?.verdict??note??"还没有记下一拍。"}</b>
    <p className="fr-note">{note??"扫描还没写出结果。"}</p>
    <p className="fr-note">账户盈亏 {signed(net)} U = 旧账 {signed(prior)} U + 已平净利 {signed(closed)} U + 还没平的 {signed(openMark)} U。旧账只计一次，不算进已平，也不算赢了几笔。已平净利扣了开仓和平仓各 0.02%。</p>
    <div className="lsr-counts">
      <div><small>扫描</small><b>{fmt(board?.scans??0,0)}</b></div>
      <div><small>出信号</small><b>{fmt(board?.signals??0,0)}</b></div>
      <div><small>成交</small><b>{fmt(board?.filled??0,0)}</b></div>
      <div><small>挂了没打到</small><b>{fmt(board?.cancelled??0,0)}</b></div>
    </div>
  </section>;
}
function LsrResearch({desk}:{desk:Desk}){
  const live=desk.liveResearch,a=live?.context,d=live?.decision,g=live?.analogy;
  const pct=(v?:number|null)=>typeof v==="number"?`${v>=0?"+":""}${(v*100).toFixed(2)}%`:"—";
  if(!live)return <section className="fr-section" data-testid="research-claims"><div className="fr-section-head"><h2>研究</h2></div><p>这一拍还没有扫完。</p></section>;
  return <>
    <section className="fr-section" data-testid="research-claims">
      <div className="fr-section-head"><h2>研究层</h2><span>{live.library} 个历史场面</span></div>
      <p>{live.status}</p>
      <p className="fr-note">每 30 秒扫一次。用的是已经收下的 5 分钟K线，大约 {live.windowHours} 小时，不是 30 天。最近扫描 {time(live.ts)}。</p>
    </section>
    <section className="fr-section">
      <div className="fr-section-head"><h2>全市场最异的 5 个</h2></div>
      {live.candidates.length?live.candidates.map(c=><p key={c.symbol}><b>{c.rank}. {c.symbol.replace("_"," / ")}</b> 评分 {fmt(c.score,2)}，5 分钟 z {fmt(c.retZ5m,2)}，量 z {fmt(c.volZ5m,2)}，现价 {fmt(c.last,6)}</p>):<p>还没有排出来。</p>}
    </section>
    <section className="fr-section">
      <div className="fr-section-head"><h2>{a?`${a.symbol.replace("_"," / ")} 的上下文`:"上下文"}</h2></div>
      {a?<>
        <p>大盘：BTC 近 1 小时 {pct(a.btc1h)}，这段K线 {pct(a.btcWindow)}。主流币近 1 小时 {pct(a.majors1h)}。现在看成{a.regime}。</p>
        <p>和 BTC：近 1 小时 {fmt(a.corr1h,2)}，更长一段 {fmt(a.corrWindow,2)}。{a.decoupled?"已经和原来的关系脱开。":"没有脱开。"}</p>
        <p>自己：15 分钟 {pct(a.ret15m)}，1 小时 {pct(a.ret1h)}。波动在这段K线里排到 {(a.volRank*100).toFixed(0)}%。</p>
        <p>盘口买/卖 {fmt(a.depthRatio,2)}，价差 {fmt(a.spreadBps,2)} bps，资金费率 {fmt(a.funding*100,4)}%。</p>
        <p className="fr-note">{a.trades}</p>
        <p>支撑 {a.support.length?a.support.map(p=>fmt(p,6)).join(" / "):"还看不出"}。压力 {a.resistance.length?a.resistance.map(p=>fmt(p,6)).join(" / "):"还看不出"}。</p>
      </>:<p>还没有上下文。</p>}
    </section>
    <section className="fr-section">
      <div className="fr-section-head"><h2>像现在的老场面</h2><span>{g?`${g.count} 个`:"不够"}</span></div>
      {g?<>
        <p>之后 1 小时继续跌 {g.down} 个（{(g.downPct*100).toFixed(0)}%），往上涨 {g.up} 个，横着 {g.flat} 个。</p>
        <p>平均最多顺涨 {pct(g.mfe1h)}，最多回落 {pct(g.mae1h)}。往后这段最好 {pct(g.best4h)}，最差 {pct(g.worst4h)}。</p>
        {g.refs.map(row=><p key={`${row.symbol}-${row.o1h}`} className="fr-note">{row.symbol.replace("_"," / ")} 相似度 {fmt(row.similarity,2)}，1 小时后 {pct(row.o1h)}</p>)}
      </>:<p>相似场面不到 20 个。K线只有最近这段，类比先空着。</p>}
    </section>
    <section className="fr-section">
      <div className="fr-section-head"><h2>研究判断</h2><span>{d?`${d.direction==="LONG"?"做多":"做空"} ${(d.confidence*100).toFixed(0)}%`:"还没有"}</span></div>
      {d?<>
        {d.reasoning.map(line=><p key={line}>{line}</p>)}
        <p>参考进场 {fmt(d.entry,6)}。止损 {fmt(d.stop,6)}。第一目标 {fmt(d.tp1,6)}。第二目标 {fmt(d.tp2,6)}。</p>
        <p>什么情况算看错：{d.invalidate.join("；")}。</p>
        <p className="fr-note">这是研究页上的判断，不会下单。</p>
      </>:<p>还没有判断。</p>}
    </section>
  </>;
}
function LsrDecision({desk,now}:{desk:Desk;now:number}){
  const work=desk.work,board=desk.lsrBoard;
  return <section className="fr-section" data-testid="decision-stance">
    <div className="fr-section-head"><h2>现在在等</h2></div>
    <p>{work?.waiting??"在等四关都过。"}</p>
    {!!board?.resting.length&&<div className="lsr-rest">{board.resting.map(order=><p key={`${order.symbol}-${order.side}`}>挂着 {order.symbol.replace("_"," / ")} {order.side==="LONG"?"多":"空"}，价 {fmt(order.price,6)}。下一次扫描打到这个价才成交。</p>)}</div>}
    <div className="fr-section-head"><h2>这一拍准备做</h2></div>
    <p>{work?.preparing??"这一拍没有开仓。"}</p>
    <div className="fr-section-head"><h2>持仓在等什么出场</h2><span>{desk.open.length} 笔</span></div>
    {desk.open.length?desk.open.map(order=><article className="lsr-hold" key={order.id}>
      <header><b>{order.symbol.replace("_"," / ")} {order.side==="LONG"?"多":"空"}</b><b className={(order.net??0)>=0?"fr-positive":"fr-negative"}>{signed(order.net)} U</b></header>
      <p>已拿 {duration(order.openedAt,null,now)}。进场 {fmt(order.entryPrice,6)}，现价 {fmt(order.price,6)}。</p>
      <div className="lsr-exit">
        <span>止盈 {fmt(order.target,6)}</span>
        <span>止损 {fmt(order.stop,6)}</span>
        <span>最长 15 分钟</span>
      </div>
    </article>):<p className="fr-note">没有持仓。开了以后只等三件事：涨到止盈 0.30%，打到止损 0.20%，或者拿满 15 分钟。</p>}
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
function DecisionPage({data,now}:{data:View|null;now:number}){
  const desk=data?.forwardDesk??null,research=desk?.research,stance=stanceName(desk?.stance);
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
function ForwardCurve({desk}:{desk:Desk}){
  const label=desk.book==="lsr-v1"?"衰竭净值":desk.book==="stretch-v1"?"新账净值":desk.book==="reverse-v1"?"反向净值":desk.book==="needle-v1"||desk.book==="brain-v1"||desk.book==="score-v1"||desk.book==="read-v1"?"账户净值":stanceName(desk.stance)==="反向"?"反向净值":desk.stance==="FLAT"?"账户净值":"正向净值";
  const points=desk.curve.length?desk.curve:[{at:0,equity:desk.initialEquity}];
  const lo=Math.min(desk.initialEquity,...points.map(p=>p.equity)),hi=Math.max(desk.initialEquity,...points.map(p=>p.equity));
  const range=Math.max(1e-6,hi-lo),first=points[0]!.at,last=Math.max(first+1,points.at(-1)!.at);
  const x=(at:number)=>12+(at-first)/(last-first)*376,y=(n:number)=>164-(n-lo)/range*140;
  return <section className="fr-section" data-testid="forward-equity-curve" aria-label={label}>
    <div className="fr-section-head"><h2>{label}</h2><span>{points.length} 点</span></div>
    <svg viewBox="0 0 400 185" width="100%" role="img" aria-label={label}>
      <polyline fill="none" className="eq-curve" points={points.map(p=>`${x(p.at)},${y(p.equity)}`).join(" ")}/>
      <text x="12" y="14" fill="currentColor" fontSize="10">{fmt(hi)} U</text><text x="12" y="180" fill="currentColor" fontSize="10">{fmt(lo)} U</text>
    </svg>
    <div className="fr-three"><div><small>已扣手续费</small><b>{fmt(desk.fees)} U</b></div><div><small>浮动盈亏</small><b>{signed(desk.floating)} U</b></div><div><small>已平仓</small><b>{fmt(desk.resolved,0)}</b></div></div>
  </section>;
}
function ForwardOrders({desk,now}:{desk:Desk;now:number}){
  const label=desk.book==="lsr-v1"?"衰竭":desk.book==="stretch-v1"?"新账":desk.book==="reverse-v1"?"反向":desk.book==="needle-v1"||desk.book==="brain-v1"||desk.book==="score-v1"||desk.book==="read-v1"?"账户":stanceName(desk.stance);
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
