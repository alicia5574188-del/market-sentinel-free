"use client";

import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from "react";
import {ADAPTIVE_TARGET_POSITIONS,type Trade,type forwardSummary} from "../lib/forward-relations.ts";
import {recordWindows,archivePage} from "../lib/record-view.ts";
import {ArchivePagination} from "./record-controls.tsx";
import EquityCurve from "./equity-curve.tsx";
import {EquityHistoryCache} from "../lib/equity-cache.ts";

type View=ReturnType<typeof forwardSummary>;
type Tab="overview"|"execution"|"paper"|"live"|"journal"|"settings";
const fmt=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?v.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}):"—";
const signed=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?`${v>=0?"+":""}${fmt(v,d)}`:"—";
const time=(v?:number|null)=>v?new Date(v).toLocaleString("zh-CN",{timeZone:"Asia/Vientiane",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}):"—";
const duration=(start:number,end:number|null|undefined,now:number)=>{const m=Math.floor(Math.max(0,(end??now)-start)/60000);return m<1?"<1分钟":m>=60?`${Math.floor(m/60)}小时${m%60}分`:`${m}分钟`;};
const modeName=(mode:string)=>({FLOW:"方向—空间",BREAKOUT:"爆发突破",RETEST:"回踩重启",FAILED_BREAKOUT:"假突破反向",RANGE:"区域内部"}[mode]??mode);
const exitName=(reason:string|null)=>reason?({STRUCTURE_STOP:"结构止损",PROFIT_GIVEBACK:"利润保护",MARKET_FLIP:"市场转向",NO_POSITIVE_FEEDBACK:"无正向反馈",TIME_DECAY:"持仓超时",OPPORTUNITY_REPLACED:"更优机会替换",ACCOUNT_RESET:"手动重置"}[reason]??reason):"—";

export default function ForwardDashboard({data,healthy,statusLabel,feedAt,error,livePanel,liveSystemPanel,liveEnabled,liveOverview,accountPanel,memberName,cacheScope="owner"}:{
  data:View|null;healthy:boolean;statusLabel?:string;feedAt:number|null;error:string|null;livePanel:ReactNode;liveSystemPanel?:ReactNode;
  liveEnabled:boolean;liveOverview?:{equity:number|null;available:number|null;positionCount:number;operational:boolean;lastSyncAt:number|null;copied:number|null;eligible:number|null;missing:number|null};
  accountPanel?:ReactNode;memberName?:string;cacheScope?:string;
}){
  const [equityCache]=useState(()=>new EquityHistoryCache());
  useEffect(()=>()=>equityCache.cancel(),[equityCache]);
  const [tab,setTab]=useState<Tab>("overview"),[now,setNow]=useState(0),[liveMounted,setLiveMounted]=useState(false);
  const [fontScale,setFontScale]=useState(()=>{if(typeof window==="undefined")return 92;try{const saved=Number(localStorage.getItem("sentinel-ui-font-scale-v1"));return saved>=70&&saved<=110?saved:92;}catch{return 92;}}),
    [paperTab,setPaperTab]=useState<"account"|"positions"|"history"|"archive">("account"),[paperPage,setPaperPage]=useState(0);
  const [exporting,setExporting]=useState(false),[exportStatus,setExportStatus]=useState<string|null>(null);
  const scroll=useRef<Record<Tab,number>>({overview:0,execution:0,paper:0,live:0,journal:0,settings:0}),fontControl=useRef<HTMLElement|null>(null);
  useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id);},[]);
  useLayoutEffect(()=>{window.scrollTo({top:tab==="live"?0:scroll.current[tab],behavior:"auto"});},[tab]);
  const select=(next:Tab)=>{scroll.current[tab]=window.scrollY;if(next==="live")setLiveMounted(true);setTab(next);};
  const fontVars:Record<string,string>={};for(let px=10;px<=64;px++)fontVars[`--fr-fs${px}`]=`${(px*fontScale/100).toFixed(2)}px`;
  const exportSnapshot=async()=>{if(exporting)return;setExporting(true);setExportStatus(null);try{
    const r=await fetch("/api/forward/export",{cache:"no-store",credentials:"same-origin"});if(!r.ok)throw new Error();
    const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`adaptive-ten-snapshot-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);setExportStatus("已开始下载。");
  }catch{setExportStatus("导出失败，请重试。");}finally{setExporting(false);}};

  const positions=data?.positions??[],opportunities=[...(data?.opportunities??[])].sort((a,b)=>Number(b.eligible)-Number(a.eligible)||Number(b.premium)-Number(a.premium)||b.score-a.score);
  const eligible=opportunities.filter(o=>o.eligible&&(!now||o.expiresAt>now)),premium=eligible.filter(o=>o.premium),
    reserve=eligible.filter(o=>o.reserve),ordinary=eligible.filter(o=>!o.premium&&!o.reserve);
  const blockers=Object.entries(data?.entryDiagnostics?.reasons??{}).sort((a,b)=>b[1]-a[1]),mainBlocker=blockers[0]?.[0]??"当前没有额外阻塞";
  const pulse=data?.marketPulse,records=recordWindows(data?.history??[],t=>t.closedAt??0),archive=archivePage(records.archive,paperPage);
  const paperMargin=positions.reduce((n,t)=>n+t.margin,0),elapsed=data&&now?Math.max(0,(now-data.startedAt)/3600000):null;
  const systemStatus=statusLabel==="后台运行中"?"正常":statusLabel?.startsWith("后台运行中 · ")?statusLabel.slice(8):statusLabel??(healthy?"正常":"行情恢复中");
  const nav:[Tab,string,string][]=[["overview","◉","总览"],["execution","⌘","执行"],["paper","⇄","模拟"],["live","◈","实盘"],["journal","≋","记录"],["settings","⊙","系统"]];
  return <main className="fr-app" style={fontVars as CSSProperties} data-ui-version="adaptive-ten-slim-v1">
    <header className="fr-header"><div className="fr-brand"><span className="fr-emblem">↗</span><div><b>哨兵 · Adaptive 10</b><small>5M CORE · 1M CONFIRM · TEN COMPETING SEATS</small></div></div><span className={`fr-status ${healthy?"is-on":""}`}><i/>{healthy?"真实行情在线":"连接中"}</span></header>
    <div className="fr-subhead"><span>Gate USDT 永续 · 30市场扫描 · 目标10仓 · 11实时槽</span><span>实盘{liveEnabled?"已请求开启":"关闭"} · 所有者控制</span></div>
    {memberName&&<p className="fr-note">{memberName} · 共用同一策略事件源，实盘账户与API完全独立。</p>}

    {tab==="overview"&&<>
      <section className="fr-hero"><div className="fr-hero-copy"><span className="fr-kicker">ADAPTIVE TEN</span><h1>{systemStatus==="正常"?"系统正在正常运行":`系统状态：${systemStatus}`}</h1>
        <p>{data?.latestReason??"正在读取交易核心。"}</p>
        <div className="fr-hero-tags"><span>连续运行 {elapsed==null?"—":fmt(elapsed,1)} 小时</span><span>5m唯一主周期</span><span>1m只做确认</span><span>10席位持续竞争</span><span>市场转向即时重评</span><span>实盘同源事件</span></div></div>
        <div className="fr-equity"><small>模拟账户权益 · USDT</small><strong>{fmt(data?.equity)}</strong><div className={(data?.netPnl??0)>=0?"fr-positive":"fr-negative"}>{signed(data?.netPnl)} <span>U · {signed(data?data.netPnl/data.initialEquity*100:null)}%</span></div>
          <footer><span>起点 {fmt(data?.initialEquity,0)}</span><span>最大回撤 {fmt(data?data.maxDrawdown*100:null)}%</span></footer></div></section>
      <section className="fr-stats">
        <Stat label="当前席位" value={data?`${positions.length} / ${ADAPTIVE_TARGET_POSITIONS}`:"—"} note={positions.length>=ADAPTIVE_TARGET_POSITIONS?"满席仍持续扫描换仓":`还可补 ${Math.max(0,ADAPTIVE_TARGET_POSITIONS-positions.length)} 席`}/>
        <Stat label="可参与机会" value={data?`${eligible.length} 个`:"—"} note={`主机会 ${ordinary.length} · 补位 ${reserve.length} · 高级 ${premium.length}`}/>
        <Stat label="市场状态" value={pulse?.bias==="UP"?"偏多":pulse?.bias==="DOWN"?"偏空":pulse?"分化":"—"} note={pulse?`上涨 ${pulse.up} · 下跌 ${pulse.down} · 中性 ${pulse.neutral}`:"等待5m数据"}/>
        <Stat label="实盘账户" value={`${fmt(liveOverview?.equity)} U`} note={`${liveOverview?.positionCount??"—"} 笔持仓 · 可用 ${fmt(liveOverview?.available)} U`}/>
      </section>
      <div className="fr-two">
        <section className="fr-section"><div className="fr-section-head"><div><small>模拟账户</small><h2>净值变化</h2></div><span>含模型成本</span></div><EquityCurve data={data} healthy={healthy} cache={equityCache} cacheScope={cacheScope}/>
          <div className="fr-three"><div><small>累计成交额</small><b>{fmt(data?.turnover)} U</b></div><div><small>已扣费用</small><b>{fmt(data?.fees)} U</b></div><div><small>完成订单</small><b>{fmt(data?.resolved,0)}</b></div></div></section>
        <section className="fr-section fr-now-card"><div className="fr-section-head"><div><small>现在</small><h2>系统正在做什么</h2></div><span>{time(data?.updatedAt)}</span></div>
          <div className="fr-three"><div><small>席位</small><b>{positions.length}/{ADAPTIVE_TARGET_POSITIONS}</b></div><div><small>候选</small><b>{eligible.length}</b></div><div><small>高级机会</small><b>{premium.length}</b></div></div>
          <div className="fr-insight"><span className="fr-dot"/><p>{data?.latestReason??"等待运行状态。"}</p></div>
          <button className="fr-button" onClick={()=>select("execution")}>查看实时执行 →</button></section>
      </div>
      <section className="fr-section"><div className="fr-section-head"><div><small>TOP OPPORTUNITIES</small><h2>当前最优机会</h2></div><span>{eligible.length} 个可参与</span></div>
        <OpportunityGrid rows={opportunities.slice(0,6)}/></section>
    </>}

    {tab==="execution"&&<>
      <PageTitle eyebrow="ONE CLOSED LOOP" title="执行" text="只有一套交易核心：5分钟判断正在发生的方向、位置与剩余空间；成熟区域产生更优机会；1分钟只负责精确确认；所有候选和持仓持续争夺约10个席位。"/>
      <section className="fr-section fr-exec-flow-section"><div className="fr-section-head"><div><small>当前执行层</small><h2>Adaptive 10 闭环</h2></div><span>{time(data?.updatedAt)}</span></div>
        <div className="fr-exec-flow">
          <ExecStep index="01" title="30市场扫描" status={(data?.marketCount??0)>0?"运行中":"等待5m"} text={`当前维护 ${fmt(data?.marketCount,0)} 个5分钟市场；不依赖15m/1h/4h才能交易。`}/>
          <ExecStep index="02" title="方向—空间" status={opportunities.length?"持续评分":"等待"} text={`方向、路径效率、剩余空间、回调风险和当前位置统一评分；当前主机会 ${ordinary.length} 个，低风险空席补位 ${reserve.length} 个。`}/>
          <ExecStep index="03" title="成熟区域高级机会" status={premium.length?"已发现":"持续观察"} text={`爆发突破、回踩重启、假突破反向、区域内部交易共用同一成熟区结构；当前 ${premium.length} 个高级机会。`}/>
          <ExecStep index="04" title="1分钟精确确认" status={premium.length?"按需启用":"无需占用"} text="1m不决定大方向，只在强突破/回踩等高级机会里确认小回调结束、重新启动或连续突破。"/>
          <ExecStep index="05" title="10席位竞争" status={positions.length>=ADAPTIVE_TARGET_POSITIONS?"满席竞争":"正在补仓"} text={`当前 ${positions.length}/${ADAPTIVE_TARGET_POSITIONS} 席；主机会优先，空席可用半风险补位；满席后补位机会没有换仓权限，只有更强主机会才能替换弱仓。`}/>
          <ExecStep index="06" title="入场后反馈" status={positions.length?"持续重评":"等待持仓"} text="快速浮赢提高持仓价值；长期围绕成本或很快浮亏会降级，但不会靠停止全部开仓来规避亏损。"/>
          <ExecStep index="07" title="退出与锁利" status={positions.length?"持续保护":"等待持仓"} text="结构止损、市场转向、时间失败、机会替换和MFE保护统一管理；约2R以后优先保留接近80%的峰值利润。"/>
        </div></section>
      <section className="fr-stats">
        <Stat label="市场广度" value={pulse?`${pulse.up}↑ / ${pulse.down}↓`:"—"} note={pulse?`强度 ${fmt(pulse.strength*100,0)}% · 波动扩张 ${fmt(pulse.expansion*100,0)}%`:"等待数据"}/>
        <Stat label="候选总数" value={data?`${opportunities.length}`:"—"} note={`${eligible.length} 个当前可参与`}/>
        <Stat label="本轮新开" value={fmt(data?.entryDiagnostics?.opened,0)} note={`匹配 ${fmt(data?.entryDiagnostics?.matched,0)}`}/>
        <Stat label="主要阻塞" value={mainBlocker} note={blockers[0]?`${blockers[0][1]} 次`:"没有额外阻塞"}/>
      </section>
      <section className="fr-section fr-scoreboard-section"><div className="fr-section-head"><div><small>LIVE RANKING</small><h2>机会排名</h2><p>这里就是实际开仓排名，不是研究影子列表。</p></div><span>{eligible.length} 可参与</span></div>
        <OpportunityGrid rows={opportunities.slice(0,16)} details/></section>
      {blockers.length>0&&<section className="fr-section"><div className="fr-section-head"><h2>本轮未开仓原因</h2><span>真实阻塞统计</span></div>
        <div className="fr-rule-grid">{blockers.slice(0,8).map(([reason,count])=><article className="fr-setting" key={reason}><div><h3>{reason}</h3><p>只有当前轮实际经过开仓检查才会计入。</p></div><b>{count}</b></article>)}</div></section>}
    </>}

    {tab==="paper"&&<>
      <PageTitle eyebrow="REAL-FEED PAPER" title="模拟账户" text="模拟和实盘读取同一个持久化交易事件；模拟成交计入手续费、滑点和资金费占位，实盘仍以Gate真实成交为准。"/>
      <nav className="fr-live-tabs fr-paper-tabs">{([["account","账户"],["positions","持仓"],["history","记录"],["archive","归档"]] as const).map(([id,label])=><button key={id} className={paperTab===id?"selected":""} onClick={()=>setPaperTab(id)}>{label}</button>)}</nav>
      {paperTab==="account"&&<><section className="fr-stats fr-paper-summary"><Stat label="模拟权益" value={`${fmt(data?.equity)} U`} note={`起始 ${fmt(data?.initialEquity)} U`}/><Stat label="保证金占用" value={`${fmt(paperMargin)} U`} note={`${positions.length} / ${ADAPTIVE_TARGET_POSITIONS} 席`}/><Stat label="浮动盈亏" value={`${signed(data?.floating)} U`} note="按当前可执行价估值"/><Stat label="累计成交额" value={`${fmt(data?.turnover)} U`} note={`已完成 ${fmt(data?.resolved,0)} 笔`}/></section>
        <TradeList trades={positions} now={now} empty="当前没有模拟持仓"/></>}
      {paperTab==="positions"&&<TradeList trades={positions} now={now} empty="当前没有模拟持仓"/>}
      {(paperTab==="history"||paperTab==="archive")&&<section className="fr-section"><div className="fr-section-head"><h2>{paperTab==="history"?"最近记录":"归档记录"}</h2><span>{paperTab==="history"?"最新10条":"更早记录"}</span></div>
        <TradeList trades={paperTab==="history"?records.recent:archive.items} now={now} empty="暂无已平仓记录" compact/>
        {paperTab==="archive"&&<ArchivePagination page={archive.page} pages={archive.pages} onPage={setPaperPage}/>}</section>}
    </>}

    {tab==="journal"&&<><section className="fr-section"><h2>研究快照</h2><p className="fr-note">导出每笔入场原因、MFE/MAE、持仓反馈、退出原因、当前候选和账户状态。</p>
      <button className="fr-button" onClick={exportSnapshot} disabled={exporting}>{exporting?"正在导出…":"导出当前研究快照 ↗"}</button>{exportStatus&&<p className="fr-note">{exportStatus}</p>}</section>
      <section className="fr-section"><div className="fr-section-head"><h2>运行记录</h2><span>{data?.events.length??0} 条</span></div>
        {(data?.events.length??0)>0?<div className="fr-journal">{data!.events.slice(0,80).map(e=><article key={e.id}><time>{time(e.at)}</time><div><b>{e.kind}</b><p>{e.reason}</p></div></article>)}</div>:<Empty title="暂无运行记录" text="成交、退出、换仓和保护更新会显示在这里。"/>}</section></>}

    {tab==="settings"&&<><PageTitle eyebrow="SYSTEM & ACCESS" title="系统" text="交易规则已经收敛为单一核心；这里保留账户权限、实盘API和显示设置。"/>
      {accountPanel}{liveSystemPanel}
      <section ref={fontControl} className="fr-section fr-font-control"><div className="fr-section-head"><div><small>界面显示</small><h2>界面字号</h2></div><b>{fontScale}%</b></div>
        <div className="fr-font-options">{[70,80,90,100,110].map(value=><button key={value} className={fontScale===value?"selected":""} onClick={()=>{setFontScale(value);try{localStorage.setItem("sentinel-ui-font-scale-v1",String(value));}catch{}}}>{value}%</button>)}</div></section>
      <section className="fr-section"><div className="fr-section-head"><h2>当前系统边界</h2><span>adaptive-ten-slim-v1</span></div>
        <Setting title="主周期" value="5m + 按需1m" text="5m负责结构、方向、空间和普通参与；1m只为高级机会做精确执行确认。"/>
        <Setting title="组合" value="约10个持仓" text="主机会优先；空席可用约半风险的方向—空间补位单维持样本与参与度。补位单不能替换正常仓；高级机会可临时使用第11实时席。"/>
        <Setting title="市场变化" value="实时优先" text="历史样本只做小幅评分修正，不能用旧胜率阻止当前方向切换。"/>
        <Setting title="风险" value="10%组合 / 6.5%同向" text={data?.boundaries.risk??"读取中"}/>
        <Setting title="实盘" value="同一持久化事件" text="模拟事件提交成功后立即唤醒event-driven LIVE；过期事件不补开，Gate是成交与账户唯一真相。"/>
        <Setting title="账户连续性" value="原地升级" text="策略版本变化不自动重置模拟账户、不改startedAt、不清历史；只有所有者重置按钮可以重置。"/>
      </section></>}

    {liveMounted&&<div className="fr-live-panel-host" hidden={tab!=="live"}>{livePanel}</div>}
    {(error||data?.storage.error)&&<aside className="fr-error"><b>运行提示</b><p>{data?.storage.error??error}</p><small>提示不会伪装成交；已有保护继续独立运行。</small></aside>}
    <footer className="fr-footer"><span>行情心跳 {time(feedAt)}</span><span>{data?.engineVersion??data?.version??"ADAPTIVE"} · Asia/Vientiane</span></footer>
    <nav className="fr-nav">{nav.map(([id,icon,label])=><button key={id} className={id===tab?"selected":""} onClick={()=>select(id)}><span>{icon}</span><b>{label}</b>{id==="paper"&&positions.length>0&&<i>{positions.length}</i>}</button>)}</nav>
  </main>;
}

function OpportunityGrid({rows,details=false}:{rows:NonNullable<View["opportunities"]>;details?:boolean}){
  if(!rows.length)return <Empty title="当前没有有效5分钟候选" text="系统继续扫描30个市场；这不会停止已有持仓保护。"/>;
  return <div className="fr-scoreboard">{rows.map((o,index)=><details className={`fr-score-row ${o.eligible?"is-eligible":""}`} key={o.id} open={false}>
    <summary><span className="fr-score-rank">#{index+1}</span><span className="fr-score-value">{fmt(o.score,0)}</span><span className="fr-score-symbol"><b>{o.symbol.replace("_"," / ")}</b><small>{o.side==="LONG"?"做多":"做空"} · {modeName(o.mode)}</small></span>
      <span><small>方向</small><b>{fmt(o.directionStrength,0)}</b></span><span><small>净空间</small><b>{fmt(o.netRemainingSpaceRate*100,2)}%</b></span><span><small>空间/回调</small><b>{fmt(o.edgeRatio,2)}×</b></span><em>{o.eligible?(o.premium?"高级":o.reserve?"补位":"主机会"):"观察"}</em></summary>
    {details&&<div className="fr-score-details"><div><h3>质量</h3><div className="fr-score-detail-grid"><Metric label="路径效率" value={fmt(o.pathEfficiency,0)}/><Metric label="动量持续" value={fmt(o.momentumPersistence,0)}/><Metric label="位置" value={fmt(o.positionScore,0)}/><Metric label="盘口" value={fmt(o.executionScore,0)}/></div></div>
      <div><h3>空间与风险</h3><div className="fr-score-detail-grid"><Metric label="总剩余空间" value={`${fmt(o.grossRemainingSpaceRate*100,2)}%`}/><Metric label="回调风险" value={`${fmt(o.pullbackRiskRate*100,2)}%`}/><Metric label="预计持有" value={`${fmt(o.expectedHoldMinutes,0)} 分钟`}/><Metric label="市场适配" value={fmt(o.marketFit,0)}/></div></div><p>{o.reason}</p></div>}
  </details>)}</div>;
}
function TradeList({trades,now,empty,compact=false}:{trades:Trade[];now:number;empty:string;compact?:boolean}){
  return <section className={compact?"":"fr-section fr-live-holdings"}>{!compact&&<div className="fr-section-head"><h2>当前持仓</h2><span>{trades.length} 笔</span></div>}
    {trades.length?<div className="fr-position-list">{trades.map(t=><TradeCard key={t.id} trade={t} now={now}/>)}</div>:<Empty title={empty} text="系统会继续扫描并实时更新候选。"/>}</section>;
}
function TradeCard({trade:t,now}:{trade:Trade;now:number}){
  const open=t.status==="OPEN",d=t.side==="LONG"?1:-1,px=open?t.lastPrice:t.exitPrice??t.lastPrice;
  const pnl=open?d*t.quantity*(px-t.entryPrice)-t.entryFee-t.quantity*px*.0007:t.netPnl??0,rate=t.notional>0?pnl/t.notional:0,ctx=t.entryContext;
  return <details className="fr-position-row"><summary><span className="fr-position-primary"><b>{t.symbol.replace("_"," / ")}</b><small>{t.side==="LONG"?"多单":"空单"} · {ctx?(ctx.reserve?"补位 · ":"")+modeName(ctx.mode):"兼容持仓"} · {fmt(t.leverage,0)}×</small>
    <b className={pnl>=0?"fr-positive":"fr-negative"}>{signed(pnl)} U</b><small>{signed(rate*100,3)}% · {duration(t.openedAt,t.closedAt,now)}</small></span>
    <span className="fr-position-entry"><b>{open?`持仓评分 ${fmt(t.holdScore,0)}`:exitName(t.exitReason)}</b><small>MFE {fmt(t.favorable*100,2)}% · MAE {fmt(t.adverse*100,2)}% · 锁利 {fmt((t.profitFloorRate??0)*100,2)}%</small>
      <small>{ctx?`入场评分 ${fmt(ctx.entryScore,0)} · 净空间 ${fmt(ctx.remainingSpaceRate*100,2)}% · 首次浮赢 ${t.firstProfitAt?time(t.firstProfitAt):"尚未"}`:"历史兼容持仓"}</small></span></summary>
    <article className="fr-trade fr-trade-unified"><dl><div><dt>入场价</dt><dd>{fmt(t.entryPrice,6)}</dd></div><div><dt>{open?"当前价":"出场价"}</dt><dd>{fmt(px,6)}</dd></div><div><dt>当前防守</dt><dd>{fmt(t.stopPrice,6)}</dd></div>
      <div><dt>名义金额</dt><dd>{fmt(t.notional)} U</dd></div><div><dt>保证金 / 杠杆</dt><dd>{fmt(t.margin)} U / {fmt(t.leverage,0)}×</dd></div><div><dt>计划风险</dt><dd>{fmt(t.plannedRisk)} U</dd></div>
      <div><dt>进场时间</dt><dd>{time(t.openedAt)}</dd></div><div><dt>持仓时长</dt><dd>{duration(t.openedAt,t.closedAt,now)}</dd></div><div><dt>预计持有</dt><dd>{fmt(t.expectedHoldMinutes,0)} 分钟</dd></div></dl>
      {ctx&&<p className="fr-trade-reason">入场依据：{ctx.reason}</p>}{t.exitReason&&<p className="fr-trade-reason">退出依据：{exitName(t.exitReason)}</p>}</article></details>;
}
function ExecStep({index,title,status,text}:{index:string;title:string;status:string;text:string}){return <article className="fr-exec-step"><span>{index}</span><div><header><b>{title}</b><em>{status}</em></header><p>{text}</p></div></article>;}
function Metric({label,value}:{label:string;value:string}){return <span><small>{label}</small><b>{value}</b></span>;}
function Stat({label,value,note}:{label:string;value:string;note:string}){return <article><small>{label}</small><strong>{value}</strong><p>{note}</p></article>;}
function Empty({title,text}:{title:string;text:string}){return <div className="fr-empty"><span>◎</span><h3>{title}</h3><p>{text}</p></div>;}
function PageTitle({eyebrow,title,text}:{eyebrow:string;title:string;text:string}){return <section className="fr-page-title"><small>{eyebrow}</small><h1>{title}</h1><p>{text}</p></section>;}
function Setting({title,value,text}:{title:string;value:string;text:string}){return <div className="fr-setting"><div><h3>{title}</h3><p>{text}</p></div><b>{value}</b></div>;}
