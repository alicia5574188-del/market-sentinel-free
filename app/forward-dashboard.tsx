"use client";

import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from "react";
import {type Trade,type forwardSummary} from "../lib/forward-relations.ts";
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
const modeName=(mode:string)=>({RELATION:"市场关系",BREAKOUT:"市场关系 · 突破执行",RETEST:"市场关系 · 回踩执行",FAILED_BREAKOUT:"市场关系 · 失败突破执行",RANGE:"市场关系 · 区域执行"}[mode]??mode);
const exitName=(reason:string|null)=>reason?({STRUCTURE_STOP:"结构止损",PROFIT_GIVEBACK:"利润保护",MARKET_FLIP:"独立反向关系",RELATION_DEGRADED:"关系降级",NO_POSITIVE_FEEDBACK:"无正向反馈",TIME_DECAY:"持仓超时",OPPORTUNITY_REPLACED:"更优机会替换",ACCOUNT_RESET:"手动重置"}[reason]??reason):"—";

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
    const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`forward-path-relation-v3-snapshot-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);setExportStatus("已开始下载。");
  }catch{setExportStatus("导出失败，请重试。");}finally{setExporting(false);}};

  const positions=data?.positions??[],opportunities=[...(data?.opportunities??[])].sort((a,b)=>Number(b.eligible)-Number(a.eligible)||Number(b.premium)-Number(a.premium)||b.score-a.score);
  const eligible=opportunities.filter(o=>o.eligible&&(!now||o.expiresAt>now)),premium=eligible.filter(o=>o.premium),
    reserve=eligible.filter(o=>o.reserve),ordinary=eligible.filter(o=>!o.premium&&!o.reserve);
  const blockers=Object.entries(data?.entryDiagnostics?.reasons??{}).sort((a,b)=>b[1]-a[1]),mainBlocker=blockers[0]?.[0]??"当前没有额外阻塞";
  const pulse=data?.marketPulse,relation=data?.relationEngine?.diagnostics,records=recordWindows(data?.history??[],t=>t.closedAt??0),archive=archivePage(records.archive,paperPage);
  const paperMargin=positions.reduce((n,t)=>n+t.margin,0),plannedRisk=positions.reduce((n,t)=>n+Math.max(t.plannedRisk,t.entryContext?.portfolioRiskCharge??((t.forecast?.sizingEquity??0)*(t.entryContext?.reserve===true?.003:.006))),0),riskUse=data?.equity?plannedRisk/data.equity:0,elapsed=data&&now?Math.max(0,(now-data.startedAt)/3600000):null;
  const systemStatus=statusLabel==="后台运行中"?"正常":statusLabel?.startsWith("后台运行中 · ")?statusLabel.slice(8):statusLabel??(healthy?"正常":"行情恢复中");
  const nav:[Tab,string,string][]=[["overview","◉","总览"],["execution","⌘","执行"],["paper","⇄","模拟"],["live","◈","实盘"],["journal","≋","记录"],["settings","⊙","系统"]];
  return <main className="fr-app" style={fontVars as CSSProperties} data-ui-version="forward-path-relation-v3">
    <header className="fr-header"><div className="fr-brand"><span className="fr-emblem">↗</span><div><b>哨兵 · Forward Path Relation 3.0</b><small>CAUSAL RESPONSE · LIFECYCLE · RISK MIGRATION</small></div></div><span className={`fr-status ${healthy?"is-on":""}`}><i/>{healthy?"真实行情在线":"连接中"}</span></header>
    <div className="fr-subhead"><span>Gate USDT 永续 · 30市场扫描 · 无席位数量上限 · 30执行BBO</span><span>实盘{liveEnabled?"已请求开启":"关闭"} · 所有者控制</span></div>
    {memberName&&<p className="fr-note">{memberName} · 共用同一策略事件源，实盘账户与API完全独立。</p>}

    {tab==="overview"&&<>
      <section className="fr-hero"><div className="fr-hero-copy"><span className="fr-kicker">FORWARD PATH RELATION 3.0</span><h1>{systemStatus==="正常"?"系统正在正常运行":`系统状态：${systemStatus}`}</h1>
        <p>{data?.latestReason??"正在读取交易核心。"}</p>
        <div className="fr-hero-tags"><span>连续运行 {elapsed==null?"—":fmt(elapsed,1)} 小时</span><span>5–60m完整路径</span><span>同根样本多检查点</span><span>风险决定持仓数量</span><span>旧关系快速降权</span><span>反向独立确认</span></div></div>
        <div className="fr-equity"><small>模拟账户权益 · USDT</small><strong>{fmt(data?.equity)}</strong><div className={(data?.netPnl??0)>=0?"fr-positive":"fr-negative"}>{signed(data?.netPnl)} <span>U · {signed(data?data.netPnl/data.initialEquity*100:null)}%</span></div>
          <footer><span>起点 {fmt(data?.initialEquity,0)}</span><span>最大回撤 {fmt(data?data.maxDrawdown*100:null)}%</span></footer></div></section>
      <section className="fr-stats">
        <Stat label="当前持仓" value={data?`${positions.length} 笔`:"—"} note={`组合风险预算已用 ${fmt(riskUse*100,1)}% · 不设固定席位`}/>
        <Stat label="可参与机会" value={data?`${eligible.length} 个`:"—"} note={`主机会 ${ordinary.length} · 补位 ${reserve.length} · 高级 ${premium.length}`}/>
        <Stat label="市场状态" value={pulse?.bias==="UP"?"偏多":pulse?.bias==="DOWN"?"偏空":pulse?"分化":"—"} note={pulse?`上涨 ${pulse.up} · 下跌 ${pulse.down} · 中性 ${pulse.neutral}`:"等待5m数据"}/>
        <Stat label="实盘账户" value={`${fmt(liveOverview?.equity)} U`} note={`${liveOverview?.positionCount??"—"} 笔持仓 · 可用 ${fmt(liveOverview?.available)} U`}/>
      </section>
      <div className="fr-two">
        <section className="fr-section"><div className="fr-section-head"><div><small>模拟账户</small><h2>净值变化</h2></div><span>含模型成本</span></div><EquityCurve data={data} healthy={healthy} cache={equityCache} cacheScope={cacheScope}/>
          <div className="fr-three"><div><small>累计成交额</small><b>{fmt(data?.turnover)} U</b></div><div><small>已扣费用</small><b>{fmt(data?.fees)} U</b></div><div><small>完成订单</small><b>{fmt(data?.resolved,0)}</b></div></div></section>
        <section className="fr-section fr-now-card"><div className="fr-section-head"><div><small>现在</small><h2>系统正在做什么</h2></div><span>{time(data?.updatedAt)}</span></div>
          <div className="fr-three"><div><small>持仓</small><b>{positions.length} 笔</b></div><div><small>候选</small><b>{eligible.length}</b></div><div><small>组合风险</small><b>{fmt(riskUse*100,1)}%</b></div></div>
          <div className="fr-insight"><span className="fr-dot"/><p>{data?.latestReason??"等待运行状态。"}</p></div>
          <button className="fr-button" onClick={()=>select("execution")}>查看实时执行 →</button></section>
      </div>
      <section className="fr-section"><div className="fr-section-head"><div><small>TOP OPPORTUNITIES</small><h2>当前最优机会</h2></div><span>{eligible.length} 个可参与</span></div>
        <OpportunityGrid rows={opportunities.slice(0,6)}/></section>
    </>}

    {tab==="execution"&&<>
      <PageTitle eyebrow="FORWARD PATH RELATION 3.0" title="执行" text="系统每5分钟记录根样本，15分钟起逐步成熟并补全至60分钟；方向、最佳持仓与退出计划来自同一条真实路径，反方向仍必须靠自己的成熟样本获得资格。"/>
      <section className="fr-section fr-exec-flow-section"><div className="fr-section-head"><div><small>当前执行层</small><h2>Forward Path Relation 3.0 闭环</h2></div><span>{time(data?.updatedAt)}</span></div>
        <div className="fr-exec-flow">
          <ExecStep index="01" title="真实条件采样" status={(relation?.markets??0)>0?"运行中":"等待5m"} text={`30市场持续记录条件；当前 ${fmt(relation?.matureSamples,0)} 份反应已经成熟，不用历史结果伪造冷启动成交。`}/>
          <ExecStep index="02" title="15 / 60 / 180 分钟关系" status={(relation?.rules??0)>0?"已生成":"积累中"} text={`当前关系 ${fmt(relation?.rules,0)} 条：15m ${fmt(relation?.qualified15,0)} · 60m ${fmt(relation?.qualified60,0)} · 180m ${fmt(relation?.qualified180,0)}。`}/>
          <ExecStep index="03" title="六级路径检查" status={(relation?.liveAnomalies??0)>0?"发现偏离":"持续核对"} text="5/10/15/30/60/180分钟只比较正在发生的真实反应是否仍像历史赚钱路径，用于快速降权，不负责预测反向。"/>
          <ExecStep index="04" title="关系生命周期" status={(relation?.degraded??0)>0?"正在迁移风险":"正常"} text={`ACTIVE ${fmt(relation?.active,0)} · 承压 ${fmt(relation?.pressured,0)} · 降级 ${fmt(relation?.degraded,0)} · 恢复中 ${fmt(relation?.recovering,0)}。`}/>
          <ExecStep index="05" title="独立反向确认" status="只认成熟样本" text="旧多头关系失效只降低多头权重；空头必须由自己的已成熟真实反应证明扣成本后有效，禁止失效即反手。"/>
          <ExecStep index="06" title="风险驱动持仓" status={riskUse>=.09?"接近风险上限":"持续竞争"} text={`当前 ${positions.length} 笔持仓，组合预算已用 ${fmt(riskUse*100,1)}%；主仓/探测仓分预算，同一关系≤2.5%，每个5m周期新增≤2.5%，风险越高新仓门槛越高。`}/>
          <ExecStep index="07" title="执行与利润保护" status={positions.length?"持续保护":"等待持仓"} text="成熟区域与1m只优化执行位置；关系恶化优先退出没有正向反馈的弱仓，已有利润先收紧MFE保护。"/>
        </div></section>
      <section className="fr-stats">
        <Stat label="关系状态" value={relation?`${relation.active} / ${relation.rules}`:"—"} note={relation?`ACTIVE / 总关系 · 承压 ${relation.pressured} · 降级 ${relation.degraded}`:"等待样本"}/>
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
      {paperTab==="account"&&<><section className="fr-stats fr-paper-summary"><Stat label="模拟权益" value={`${fmt(data?.equity)} U`} note={`起始 ${fmt(data?.initialEquity)} U`}/><Stat label="保证金占用" value={`${fmt(paperMargin)} U`} note={`${positions.length} 笔持仓 · 无席位数量上限`}/><Stat label="浮动盈亏" value={`${signed(data?.floating)} U`} note="按当前可执行价估值"/><Stat label="累计成交额" value={`${fmt(data?.turnover)} U`} note={`已完成 ${fmt(data?.resolved,0)} 笔`}/></section>
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
      <section className="fr-section"><div className="fr-section-head"><h2>当前系统边界</h2><span>forward-path-relation-v3</span></div>
        <Setting title="学习周期" value="15m / 60m / 180m" text="每个周期只使用已经真实成熟的市场反应形成关系；不根据固定指标直接预测未来方向。"/>
        <Setting title="切换检测" value="5/10/15/30/60/180m" text="路径检查点只负责尽早发现旧关系正在失效；旧方向失效绝不自动等于反方向成立。"/>
        <Setting title="组合" value="无席位数量上限" text="持仓数量由10%组合计划风险、6.5%同向风险、75%保证金和单币一仓共同决定；ACTIVE关系正常竞争风险。"/>
        <Setting title="市场变化" value="长期资格 + 近期交易权" text="长期样本保留有效关系，近期成熟样本和正在发生的真实路径决定它现在还能用多大风险。"/>
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
  if(!rows.length)return <Empty title="当前没有成熟可参与关系" text="系统继续扫描30个市场并积累真实反应；已有持仓保护不会停止。"/>;
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
  return <details className="fr-position-row"><summary><span className="fr-position-primary"><b>{t.symbol.replace("_"," / ")}</b><small>{t.side==="LONG"?"多单":"空单"} · {ctx?(ctx.reserve?"低风险 · ":"")+modeName(ctx.mode):"兼容持仓"}{ctx?.relationHorizon?` · ${ctx.relationHorizon}m关系`:""} · {fmt(t.leverage,0)}×</small>
    <b className={pnl>=0?"fr-positive":"fr-negative"}>{signed(pnl)} U</b><small>{signed(rate*100,3)}% · {duration(t.openedAt,t.closedAt,now)}</small></span>
    <span className="fr-position-entry"><b>{open?`持仓评分 ${fmt(t.holdScore,0)}`:exitName(t.exitReason)}</b><small>MFE {fmt(t.favorable*100,2)}% · MAE {fmt(t.adverse*100,2)}% · 锁利 {fmt((t.profitFloorRate??0)*100,2)}%</small>
      <small>{ctx?`入场评分 ${fmt(ctx.entryScore,0)} · 关系 ${ctx.relationStatus??"—"} ${fmt((ctx.relationHealth??0)*100,0)} · 净空间 ${fmt(ctx.remainingSpaceRate*100,2)}% · 首次浮赢 ${t.firstProfitAt?time(t.firstProfitAt):"尚未"}`:"历史兼容持仓"}</small></span></summary>
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
