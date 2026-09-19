"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FEATURES, type Rule, type Trade, type forwardSummary } from "../lib/forward-relations.ts";
import {recordWindows,archivePage} from "../lib/record-view.ts";
import {ArchivePagination} from "./record-controls.tsx";
import EquityCurve from "./equity-curve.tsx";
import {EquityHistoryCache} from "../lib/equity-cache.ts";
type View = ReturnType<typeof forwardSummary>;
type Tab = "overview" | "relations" | "orders" | "live" | "journal" | "settings";
const fmt = (v: number | null | undefined, digits=2) => typeof v==="number"&&Number.isFinite(v)?v.toLocaleString("en-US",{minimumFractionDigits:digits,maximumFractionDigits:digits}):"—";
const signed = (v: number | null | undefined, digits=2) => typeof v==="number"?`${v>=0?"+":""}${fmt(v,digits)}`:"—";
const time = (v?:number|null) => v?new Date(v).toLocaleString("zh-CN",{timeZone:"Asia/Vientiane",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}):"—";
const condition = (r:Rule) => r.conditions.map(c=>`${FEATURES[c.feature]} ${c.op==="GE"?"≥":"≤"} ${fmt(c.threshold)}`).join(" ＋ ");

export default function ForwardDashboard({data,healthy,feedAt,error,livePanel,liveEnabled,accountPanel,memberName,cacheScope="owner"}:{data:View|null;healthy:boolean;feedAt:number|null;error:string|null;livePanel:ReactNode;liveEnabled:boolean;accountPanel?:ReactNode;memberName?:string;cacheScope?:string}) {
  const [equityCache]=useState(()=>new EquityHistoryCache());
  useEffect(()=>()=>equityCache.cancel(),[equityCache]);
  const [tab,setTab]=useState<Tab>("overview"),[now,setNow]=useState(0),[showDormant,setShowDormant]=useState(false);
  const [paperTab,setPaperTab]=useState<"positions"|"history"|"archive">("positions"),[paperPage,setPaperPage]=useState(0);
  const paperRecords=recordWindows(data?.history??[],t=>t.closedAt??0),paperArchive=archivePage(paperRecords.archive,paperPage);
  const scroll=useRef<Record<Tab,number>>({overview:0,relations:0,orders:0,live:0,journal:0,settings:0});
  useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id);},[]);
  useLayoutEffect(()=>{window.scrollTo({top:tab==="live"?0:scroll.current[tab],behavior:"auto"});},[tab]);
  const select=(next:Tab)=>{scroll.current[tab]=window.scrollY;setTab(next);};
  const active=data?.rules.filter(r=>r.status==="EXPERIMENTAL")??[],dormant=data?.rules.filter(r=>r.status==="DORMANT")??[];
  const elapsed=data&&now?Math.max(0,(now-data.startedAt)/3600000):null;
  const stage=!data||!healthy?0:!data.measured?1:!active.length?2:data.positions.length?4:3;
  const stages=["接入行情","观察反应","生成规则","匹配机会","执行复盘"];
  const title=!data?"正在连接前向实验":!healthy?"行情连接恢复中":data.positions.length?"交易正在接受市场检验":active.length?"新的交易规则已生成":"先观察变化，再形成交易办法";
  const nav:[Tab,string,string][]=[["overview","◉","总览"],["relations","⌘","规则"],["orders","⇄","模拟"],["live","◈","实盘"],["journal","≋","演变"],["settings","⊙","系统"]];
  return <main className="fr-app" data-ui-version="dark-live-v1" data-record-view="compact-records-pnl-v1">
    <header className="fr-header"><div className="fr-brand"><span className="fr-emblem">↗</span><div><b>哨兵 · 关系引擎</b><small>FORWARD LAB / 01</small></div></div><span className={`fr-status ${healthy?"is-on":""}`}><i/>{healthy?"真实行情在线":"连接中"}</span></header>
    <div className="fr-subhead"><span>Gate USDT 永续 · 关系引擎</span><span>实盘{liveEnabled?"已请求开启":"关闭"} · 所有者控制</span></div>
    {memberName&&<p className="fr-note">{memberName} · 共用同一模拟策略，实盘账户独立，开关只由你控制。</p>}

    {tab==="overview"&&<>
      <section className="fr-hero"><div className="fr-hero-copy"><span className="fr-kicker">市场在变化，规则随证据更新</span><h1>{title}</h1><p>{data?.latestReason??"读取已持久化的账户、规则和观测记录；连接前不显示虚构成交或收益。"}</p><div className="fr-hero-tags"><span>连续运行 {elapsed==null?"—":fmt(elapsed,1)} 小时</span><span>5分钟行情</span><span>实盘由所有者开启</span></div></div>
      <div className="fr-equity"><small>当前模拟净值 · USDT</small><strong>{fmt(data?.equity)}</strong><div className={(data?.netPnl??0)>=0?"fr-positive":"fr-negative"}>{signed(data?.netPnl)} <span>U · {signed(data?data.netPnl/data.initialEquity*100:null)}%</span></div><div className="fr-progress"><i style={{width:`${data?Math.max(0,Math.min(100,data.netPnl/data.initialEquity*100)):0}%`}}/></div><footer><span>起点 {fmt(data?.initialEquity,0)}</span><span>月度目标 {fmt(data?.targetEquity,0)}</span></footer><p>目标不是收益预测，尚未证明月翻倍。</p></div></section>

      <section className="fr-stats"><Stat label="正在测量的反应" value={fmt(data?.pending,0)} note={`已完成 ${fmt(data?.measured,0)} 次市场测量`}/><Stat label="当前实验规则" value={data?String(active.length):"—"} note="查看入场与退出条件"/><Stat label="模拟持仓 / 已平仓" value={data?`${data.positions.length} / ${data.resolved}`:"—"} note="测量数量不计入交易数量"/><Stat label="已扣交易费用" value={`${fmt(data?.fees)} U`} note={`资金费占位 ${fmt(data?.fundingAllowance)} U`}/></section>

      <section className="fr-section"><div className="fr-section-head"><div><small>运行进程</small><h2>系统此刻在做什么</h2></div><span>{time(data?.updatedAt)}</span></div><div className="fr-pipeline">{stages.map((name,i)=><div key={name} className={i===stage?"current":i<stage?"done":""}><span>{i<stage?"✓":String(i+1).padStart(2,"0")}</span><b>{name}</b></div>)}</div><div className="fr-insight"><span className="fr-dot"/><p>{data?.latestReason??"等待后台的首个持久化快照。"}</p></div>
      <div className="fr-three"><div><small>用于特征的市场</small><b>{fmt(data?.marketCount,0)} / 30</b></div><div><small>最近规则更新</small><b>{time(data?.lastFitAt)}</b></div><div><small>状态已保存</small><b>{time(data?.storage.persistedAt)}</b></div></div></section>

      <section className="fr-section"><div className="fr-section-head"><h2>机会与执行</h2><span>统计自 {time(data?.participation?.since)}</span></div><div className="fr-three"><div><small>匹配次数（非订单）</small><b>{fmt(data?.participation?.matches,0)}</b></div><div><small>当前等待报价</small><b>{fmt(data?.quoteRetries?.length,0)}</b></div><div><small>新开仓 / 重试成交</small><b>{fmt(data?.participation?.opened,0)} / {fmt(data?.participation?.retryFills,0)}</b></div></div><p className="fr-note">报价暂缺会在当前5分钟信号剩余窗口内重试；超时作废，不补成交，不设强制交易数。同一币同一根K线不重复开仓。</p></section>
      <div className="fr-two"><section className="fr-section"><div className="fr-section-head"><div><small>账户结果</small><h2>净值曲线</h2></div><span>含模拟成本</span></div><EquityCurve data={data} healthy={healthy} cache={equityCache} cacheScope={cacheScope}/><div className="fr-three"><div><small>已实现价格损益</small><b>{signed(data?.grossPnl)} U</b></div><div><small>含退出成本浮盈</small><b>{signed(data?.floating)} U</b></div><div><small>已观测最大回撤</small><b>{fmt(data?data.maxDrawdown*100:null)}%</b></div></div></section>
      <section className="fr-section"><div className="fr-section-head"><div><small>响应样本</small><h2>观察多长时间的反应</h2></div></div><div className="fr-horizons">{[15,60,180].map(h=><div key={h}><b>{h<60?`${h} 分钟`:`${h/60} 小时`}</b><div><i style={{width:`${data?Math.min(100,(data.sampleCounts[h]??0)/384*100):0}%`}}/></div><strong>{fmt(data?.sampleCounts[h],0)}</strong></div>)}</div><p className="fr-note">样本来自已完成的市场反应，不计入交易次数。</p><button className="fr-text-button" onClick={()=>select("relations")}>查看规则如何生成 <span>↗</span></button></section></div>
      <section className="fr-section"><div className="fr-section-head"><div><small>最近变化</small><h2>每次改变都有依据</h2></div><button className="fr-text-button" onClick={()=>select("journal")}>全部记录 ↗</button></div><Journal data={data} limit={4}/></section>
    </>}

    {tab==="relations"&&<><PageTitle eyebrow="RELATION → RULE" title="交易规则" text="查看当前入场条件、适用市场与退出设置。"/>
      <section className="fr-section"><div className="fr-section-head"><div><small>当前规则</small><h2>{data?active.length:"—"} 条前向实验</h2></div><span>模拟为决策源 · 尚未验证盈利</span></div>{!active.length?<Empty title="正在积累可比较的条件—反应关系" text={data?.latestReason??"后台快照尚未返回。"}/>:<div className="fr-rule-grid">{active.map(r=><RuleCard key={r.id} rule={r}/>)}</div>}</section>
      <section className="fr-section"><div className="fr-three"><div><small>本轮表达检查</small><b>{fmt(data?.fitDiagnostics.tested,0)}</b></div><div><small>较早时间组</small><b>{fmt(data?.fitDiagnostics.trainGroups,0)}</b></div><div><small>较晚检查时间组</small><b>{fmt(data?.fitDiagnostics.checkGroups,0)}</b></div></div><p className="fr-note">统计估计不等于胜率，需结合后续交易结果评估。</p></section>
      <section className="fr-section"><div className="fr-section-head"><h2>关系与成交校准</h2><span>不是胜率</span></div><div className="fr-three"><div><small>单币集中度提示</small><b>{fmt(data?.evidenceDiagnostics?.concentrationWarnings,0)}</b></div><div><small>成交偏差提示</small><b>{fmt(data?.evidenceDiagnostics?.calibrationWarnings,0)}</b></div><div><small>保留的已平仓反馈</small><b>{fmt(data?.feedbackCount,0)}</b></div></div><p className="fr-note">集中度和成交偏差用于风险评估；统计估计并非收益承诺。</p></section>
      <section className="fr-section"><button className="fr-expand" aria-expanded={showDormant} onClick={()=>setShowDormant(!showDormant)}><div><h2>休眠规则</h2><p>仅展示不参与当前开仓的规则。</p></div><span>{dormant.length} {showDormant?"−":"+"}</span></button>{showDormant&&<div className="fr-rule-grid">{dormant.map(r=><RuleCard key={r.id} rule={r}/>)}</div>}</section></>}

    {tab==="orders"&&<><PageTitle eyebrow="REAL-FEED PAPER" title="模拟账户" text="成交价来自新鲜的买卖盘口，含模型手续费、滑点和资金费用占位。这里不是Gate真实成交记录。"/>
      <section className="fr-stats"><Stat label="模拟净值" value={`${fmt(data?.equity)} U`} note={`起始 ${fmt(data?.initialEquity)} U`}/><Stat label="已完成交易" value={fmt(data?.resolved,0)} note={`盈利 ${fmt(data?.wins,0)} 笔`}/><Stat label="模拟成交额" value={`${fmt(data?.turnover)} U`} note="按模拟实际执行金额统计"/><Stat label="最大观测回撤" value={`${fmt(data?data.maxDrawdown*100:null)}%`} note="按已观测净值计算"/></section>
      <nav className="fr-live-tabs fr-paper-tabs" aria-label="模拟子导航">{([["positions","当前持仓"],["history","最近记录"],["archive","归档"]] as const).map(([id,label])=><button key={id} className={paperTab===id?"selected":""} aria-current={paperTab===id?"page":undefined} onClick={()=>setPaperTab(id)}>{label}</button>)}</nav>
      {paperTab==="positions"?<section className="fr-section" data-testid="paper-positions"><div className="fr-section-head"><h2>当前持仓</h2><span>{data?.positions.length??"—"} 笔</span></div>{data?.positions.length?<div className="fr-rule-grid">{data.positions.map(t=><TradeCard key={t.id} trade={t} now={now}/>)}</div>:<Empty title="当前没有模拟持仓" text="符合条件的订单将在这里显示。"/>}</section>:
      <section className="fr-section" data-testid={paperTab==="history"?"paper-history":"paper-archive"}><div className="fr-section-head"><h2>{paperTab==="history"?"最近记录":"归档记录"}</h2><span>{paperTab==="history"?"最新10条":"再往前最新50条"}</span></div>
        {(paperTab==="history"?paperRecords.recent:paperArchive.items).length?<div className="fr-rule-grid">{(paperTab==="history"?paperRecords.recent:paperArchive.items).map(t=><TradeCard key={t.id} trade={t} now={now}/>)}</div>:<Empty title="暂无已平仓记录" text="订单平仓后自动归入记录。"/>}
        {paperTab==="archive"&&<ArchivePagination page={paperArchive.page} pages={paperArchive.pages} onPage={setPaperPage}/>}
      </section>}</>}

    {tab==="journal"&&<>
      <section className="fr-section"><h2>数据导出</h2><p className="fr-note">导出当前研究数据与账户快照。</p><a className="fr-button" href="/api/forward/export" download="forward-research-snapshot.json">导出当前研究快照 ↗</a></section>
      <PageTitle eyebrow="AUDITABLE ADAPTATION" title="运行记录" text="查看规则变化、成交与运行异常。"/>
      <section className="fr-section"><div className="fr-section-head"><h2>演变记录</h2><span>最近 {data?.events.length??"—"} 条</span></div><Journal data={data} limit={80}/></section></>}

    {tab==="settings"&&<>{accountPanel}<PageTitle eyebrow="OPERATIONAL BOUNDARIES" title="系统设置" text="管理访问权限、实盘连接和运行设置。"/>
      <section className="fr-section"><Setting title="当前主系统" value={data?.policyVersion??data?.version??"读取中"} text="行情驱动的交易规则与执行。"/><Setting title="月度研究目标" value="本金 × 2" text="目标不代表收益承诺；净值包含浮动盈亏和模拟成本。"/><Setting title="规则自动适应" value="在线运行" text="每5分钟整理行情，按后续反应更新规则。"/><Setting title="执行权限" value="所有者实盘复制" text="模拟提供交易决策，实盘按权益比例复制；开关由账户本人控制。"/><Setting title="初始实验风险预算" value="权益随动" text={data?.boundaries.risk??"读取中"}/><Setting title="成本口径" value="显式假设" text={data?.cost.assumption??"读取中"}/><Setting title="连续性" value="持久化" text="状态保存后才提交新订单；重启恢复原账户。"/></section>
      <section className="fr-section"><div className="fr-section-head"><div><h2>所有者与实盘管理</h2><p>查看实盘账户并管理API和交易开关。</p></div></div><button className="fr-button" onClick={()=>select("live")}>打开实盘控制台 ↗</button></section></>}

    <div hidden={tab!=="live"}>{livePanel}</div>

    {(error||data?.storage.error)&&<aside className="fr-error" role="status"><b>运行提示</b><p>{data?.storage.error??error}</p><small>保留最近数据；不会把未保存的交易发布为已成交。</small></aside>}
    <footer className="fr-footer"><span>行情心跳 {time(feedAt)}</span><span>{data?.version??"FORWARD LAB"} · Asia/Vientiane</span></footer>
    <nav className="fr-nav" aria-label="主导航">{nav.map(([id,icon,label])=><button key={id} className={id===tab?"selected":""} aria-current={id===tab?"page":undefined} onClick={()=>select(id)}><span>{icon}</span><b>{label}</b>{id==="orders"&&!!data?.positions.length&&<i>{data.positions.length}</i>}</button>)}</nav>
  </main>;
}
function Stat({label,value,note}:{label:string;value:string;note:string}){return<article><small>{label}</small><strong>{value}</strong><p>{note}</p></article>;}
function Empty({title,text}:{title:string;text:string}){return<div className="fr-empty"><span>◎</span><h3>{title}</h3><p>{text}</p></div>;}
function PageTitle({eyebrow,title,text}:{eyebrow:string;title:string;text:string}){return<section className="fr-page-title"><small>{eyebrow}</small><h1>{title}</h1><p>{text}</p></section>;}
function Setting({title,value,text}:{title:string;value:string;text:string}){return<div className="fr-setting"><div><h3>{title}</h3><p>{text}</p></div><b>{value}</b></div>;}
function RuleCard({rule:r}:{rule:Rule}){return<article className="fr-rule"><header><span>{r.horizon}分钟反应 · v{r.version}</span><b className={r.side==="LONG"?"fr-positive":"fr-negative"}>{r.side==="LONG"?"做多":"做空"}</b></header><h3>{condition(r)}</h3><details className="fr-details"><summary>规则依据与风险</summary><p>{r.reason}</p>{r.evidence&&<p className="fr-note">{r.evidence.scope==="SINGLE_ASSET"?"仅限本币":"跨币实验范围（尚未证明通用）"}：{r.evidence.symbols.slice(0,6).join("、")}{r.evidence.symbols.length>6?` 等${r.evidence.symbols.length}个已观测标的`:""}。稳健估计 {signed(r.evidence.boundedNet==null?null:r.evidence.boundedNet*100,3)}%，成交校准后 {signed((r.evidence.calibratedNet??r.estimatedNetRate)*100,3)}%。这些估计可能为负；保留实验不等于承诺盈利。</p>}{r.evidence?.warnings?.length?<p className="fr-note">{r.evidence.warnings.join("；")}</p>:null}</details><div className="fr-rule-numbers"><div><small>原始净反应假设</small><b>{signed(r.estimatedNetRate*100,3)}%</b></div><div><small>已见市场样本</small><b>{r.samples}</b></div><div><small>生成止损距离</small><b>{fmt(r.stopRate*100)}%</b></div></div><footer><span>{r.status==="EXPERIMENTAL"?"前向实验中":"已休眠 / 被替代"}</span><span>{time(r.createdAt)}</span></footer></article>;}
function TradeCard({trade:t,now}:{trade:Trade;now:number}){const open=t.status==="OPEN",d=t.side==="LONG"?1:-1;
  const pnl=open?d*t.quantity*(t.lastPrice-t.entryPrice)-t.entryFee-t.quantity*t.lastPrice*.0007-t.notional*.0002*Math.max(0,now-t.openedAt)/86400000:t.netPnl;
  return<article className="fr-trade"><header><div><small>{open?"持仓中":"已平仓"} · {t.side==="LONG"?"多单":"空单"}</small><h3>{t.symbol.replace("_"," / ")}</h3></div><strong className={(pnl??0)>=0?"fr-positive":"fr-negative"}>{signed(pnl)} <small>U</small></strong></header><p className="fr-trade-rule">规则 v{t.rule.version} · {condition(t.rule)}</p><dl>{[["入场价",fmt(t.entryPrice,5)],[open?"最近退出估值":"出场价",fmt(open?t.lastPrice:t.exitPrice,5)],["保护止损",fmt(t.stopPrice,5)],["名义金额",`${fmt(t.notional)} U`],["保证金 / 杠杆",`${fmt(t.margin)} U / ${fmt(t.leverage,0)}×`],["张数",fmt(t.contracts,0)]].map(([a,b])=><div key={a}><dt>{a}</dt><dd>{b}</dd></div>)}</dl><p className="fr-trade-reason">{t.exitReason??`持仓依据：${t.rule.exitMode==="REACTION_DECAY"?"反应回吐保护":"反应期限"}；相反新证据连续确认后可退出。`}</p><footer><span>入场 {time(t.openedAt)}</span><span>{open?`已持有 ${fmt(Math.max(0,now-t.openedAt)/60000,0)} 分钟`:`出场 ${time(t.closedAt)}`}</span></footer></article>;}
function Journal({data,limit}:{data:View|null;limit:number}){const events=data?.events.filter(e=>e.kind!=="UPGRADE").slice(0,limit)??[];const names={START:"启动",RULE:"生成 / 修订",DORMANT:"休眠",ENTRY:"模拟开仓",EXIT:"模拟平仓",PROTECTION:"保护更新",DATA_GAP:"样本作废",FIT:"关系检查",UPGRADE:"连续升级"};return events.length?<div className="fr-journal">{events.map(e=><article key={e.id}><time>{time(e.at)}</time><div><b>{names[e.kind]}</b><p>{e.reason}</p></div></article>)}</div>:<Empty title="等待第一条运行记录" text="暂无运行事件。"/>;}
