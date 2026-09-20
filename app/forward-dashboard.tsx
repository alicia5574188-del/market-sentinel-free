"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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

export default function ForwardDashboard({data,healthy,feedAt,error,livePanel,liveSystemPanel,liveEnabled,liveOverview,accountPanel,memberName,cacheScope="owner"}:{data:View|null;healthy:boolean;feedAt:number|null;error:string|null;livePanel:ReactNode;liveSystemPanel?:ReactNode;liveEnabled:boolean;liveOverview?:{equity:number|null;available:number|null;positionCount:number;operational:boolean;lastSyncAt:number|null;copied:number|null;eligible:number|null;missing:number|null};accountPanel?:ReactNode;memberName?:string;cacheScope?:string}) {
  const [equityCache]=useState(()=>new EquityHistoryCache());
  useEffect(()=>()=>equityCache.cancel(),[equityCache]);
  const [tab,setTab]=useState<Tab>("overview"),[now,setNow]=useState(0),[showDormant,setShowDormant]=useState(false);
  const [fontScale,setFontScale]=useState(92);
  const [exporting,setExporting]=useState(false),[exportStatus,setExportStatus]=useState<string|null>(null);
  const [paperTab,setPaperTab]=useState<"account"|"positions"|"history"|"archive">("account"),[paperPage,setPaperPage]=useState(0);
  const paperRecords=recordWindows(data?.history??[],t=>t.closedAt??0),paperArchive=archivePage(paperRecords.archive,paperPage);
  const scroll=useRef<Record<Tab,number>>({overview:0,relations:0,orders:0,live:0,journal:0,settings:0});
  const fontControl=useRef<HTMLElement|null>(null),fontAnchor=useRef<{top:number;scrollY:number}|null>(null);
  useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id);},[]);
  useEffect(()=>{let frame=0;try{const saved=Number(window.localStorage.getItem("sentinel-ui-font-scale-v1"));if(saved>=70&&saved<=110){const options=[70,80,90,100,110];const nearest=options.reduce((best,n)=>Math.abs(n-saved)<Math.abs(best-saved)?n:best,90);frame=window.requestAnimationFrame(()=>setFontScale(nearest));}}catch{}return()=>{if(frame)window.cancelAnimationFrame(frame);};},[]);
  const selectFontScale=(value:number)=>{const anchor=fontControl.current;fontAnchor.current={top:anchor?.getBoundingClientRect().top??0,scrollY:window.scrollY};setFontScale(value);try{window.localStorage.setItem("sentinel-ui-font-scale-v1",String(value));}catch{}};
  useLayoutEffect(()=>{const pending=fontAnchor.current;if(!pending)return;const anchor=fontControl.current;if(anchor){const after=anchor.getBoundingClientRect().top;window.scrollBy({top:after-pending.top,left:0,behavior:"auto"});}else window.scrollTo({top:pending.scrollY,left:0,behavior:"auto"});fontAnchor.current=null;},[fontScale]);
  const fontVars:Record<string,string>={};for(let px=10;px<=64;px++)fontVars[`--fr-fs${px}`]=`${(px*fontScale/100).toFixed(2)}px`;
  const fontStyle=fontVars as CSSProperties;
  useLayoutEffect(()=>{window.scrollTo({top:tab==="live"?0:scroll.current[tab],behavior:"auto"});},[tab]);
  const select=(next:Tab)=>{scroll.current[tab]=window.scrollY;setTab(next);};
  const exportSnapshot=async()=>{
    if(exporting)return;
    setExporting(true);setExportStatus(null);
    try{
      const response=await fetch("/api/forward/export",{cache:"no-store",credentials:"same-origin"});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const blob=await response.blob(),url=URL.createObjectURL(blob);
      const anchor=document.createElement("a");
      anchor.href=url;anchor.download=`forward-research-snapshot-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(anchor);anchor.click();anchor.remove();
      window.setTimeout(()=>URL.revokeObjectURL(url),1000);
      setExportStatus("已开始下载，仍停留在当前页面。");
    }catch{
      setExportStatus("导出失败，请重试。");
    }finally{setExporting(false);}
  };
  const active=data?.rules.filter(r=>r.status==="EXPERIMENTAL")??[],dormant=data?.rules.filter(r=>r.status==="DORMANT")??[];
  const paperMargin=data?.positions.reduce((sum,t)=>sum+t.margin,0)??null;
  const elapsed=data&&now?Math.max(0,(now-data.startedAt)/3600000):null;
  const nav:[Tab,string,string][]=[["overview","◉","总览"],["relations","⌘","规则"],["orders","⇄","模拟"],["live","◈","实盘"],["journal","≋","演变"],["settings","⊙","系统"]];
  return <main className="fr-app" style={fontStyle} data-ui-version="dark-live-v1" data-record-view="compact-records-pnl-v1">
    <header className="fr-header"><div className="fr-brand"><span className="fr-emblem">↗</span><div><b>哨兵 · 关系引擎</b><small>FORWARD LAB / 01</small></div></div><span className={`fr-status ${healthy?"is-on":""}`}><i/>{healthy?"真实行情在线":"连接中"}</span></header>
    <div className="fr-subhead"><span>Gate USDT 永续 · 关系引擎</span><span>实盘{liveEnabled?"已请求开启":"关闭"} · 所有者控制</span></div>
    {memberName&&<p className="fr-note">{memberName} · 共用同一模拟策略，实盘账户独立，开关只由你控制。</p>}

    {tab==="overview"&&<>
      <section className="fr-hero"><div className="fr-hero-copy"><span className="fr-kicker">账户驾驶舱</span><h1>{healthy?"系统正在正常运行":"系统正在恢复连接"}</h1>
        <p>{data?.latestReason??"正在读取已持久化账户和真实行情状态。"}</p>
        <div className="fr-hero-tags"><span>连续运行 {elapsed==null?"—":fmt(elapsed,1)} 小时</span><span>5分钟行情</span><span>动态市场范围</span><span>实盘{liveEnabled?"已开启":"关闭"}</span></div></div>
        <div className="fr-equity"><small>模拟账户权益 · USDT</small><strong>{fmt(data?.equity)}</strong><div className={(data?.netPnl??0)>=0?"fr-positive":"fr-negative"}>{signed(data?.netPnl)} <span>U · {signed(data?data.netPnl/data.initialEquity*100:null)}%</span></div>
          <footer><span>起点 {fmt(data?.initialEquity,0)}</span><span>最大回撤 {fmt(data?data.maxDrawdown*100:null)}%</span></footer></div></section>

      <section className="fr-stats">
        <Stat label="模拟账户" value={`${fmt(data?.equity)} U`} note={`${data?.positions.length??"—"} 笔持仓 · 浮盈 ${signed(data?.floating)} U`}/>
        <Stat label="实盘账户" value={`${fmt(liveOverview?.equity)} U`} note={`${liveOverview?.positionCount??"—"} 笔持仓 · 可用 ${fmt(liveOverview?.available)} U`}/>
        <Stat label="复制一致性" value={liveOverview?.eligible==null?"—":`${liveOverview.copied??0} / ${liveOverview.eligible}`} note={liveOverview?.missing?`${liveOverview.missing} 笔需要核对`:"当前无漏复制提示"}/>
        <Stat label="系统状态" value={healthy?"正常":"恢复中"} note={`行情心跳 ${time(feedAt)}`}/>
      </section>

      <div className="fr-two">
        <section className="fr-section"><div className="fr-section-head"><div><small>模拟账户</small><h2>净值变化</h2></div><span>含模拟成本</span></div>
          <EquityCurve data={data} healthy={healthy} cache={equityCache} cacheScope={cacheScope}/>
          <div className="fr-three"><div><small>累计模拟成交额</small><b>{fmt(data?.turnover)} U</b></div><div><small>已扣模拟费用</small><b>{fmt(data?.fees)} U</b></div><div><small>已完成订单</small><b>{fmt(data?.resolved,0)}</b></div></div>
        </section>
        <section className="fr-section"><div className="fr-section-head"><div><small>当前状态</small><h2>现在需要看什么</h2></div><span>{time(data?.updatedAt)}</span></div>
          <div className="fr-three"><div><small>模拟持仓</small><b>{fmt(data?.positions.length,0)}</b></div><div><small>实盘持仓</small><b>{liveOverview?.positionCount??"—"}</b></div><div><small>实盘执行</small><b>{!liveEnabled?"关闭":liveOverview?.operational?"正常":"核对中"}</b></div></div>
          <div className="fr-insight"><span className="fr-dot"/><p>{data?.latestReason??"等待运行状态。"}</p></div>
          <div className="fr-action-row"><button className="fr-button" onClick={()=>select("orders")}>查看模拟账户</button><button className="fr-button secondary" onClick={()=>select("live")}>查看实盘账户</button></div>
        </section>
      </div>

      {(liveOverview?.missing??0)>0&&<section className="fr-section fr-parity-alert"><div className="fr-section-head"><div><small>需要关注</small><h2>模拟—实盘复制存在差异</h2></div><span>{liveOverview?.missing} 笔</span></div>
        <p className="fr-note">这里仅提示存在需要核对的订单，不用不同资金规模账户的绝对盈亏做比较。进入实盘页查看标准化收益率、入场偏差、复制延迟和按实盘名义额折算后的执行结果。</p>
        <button className="fr-text-button" onClick={()=>select("live")}>查看实盘差异 →</button></section>}

      <section className="fr-section"><div className="fr-section-head"><div><small>最近变化</small><h2>需要留意的运行记录</h2></div><button className="fr-text-button" onClick={()=>select("journal")}>全部记录 ↗</button></div><Journal data={data} limit={3}/></section>
    </>}

    {tab==="relations"&&<><PageTitle eyebrow="RELATION → RULE" title="交易规则" text="查看当前入场条件、适用市场与退出设置。"/>
      <section className="fr-section"><div className="fr-section-head"><div><small>当前规则</small><h2>{data?active.length:"—"} 条前向实验</h2></div><span>模拟为决策源 · 尚未验证盈利</span></div>{!active.length?<Empty title="正在积累可比较的条件—反应关系" text={data?.latestReason??"后台快照尚未返回。"}/>:<div className="fr-rule-grid">{active.map(r=><RuleCard key={r.id} rule={r}/>)}</div>}</section>
      <section className="fr-section"><div className="fr-three"><div><small>本轮表达检查</small><b>{fmt(data?.fitDiagnostics.tested,0)}</b></div><div><small>较早时间组</small><b>{fmt(data?.fitDiagnostics.trainGroups,0)}</b></div><div><small>较晚检查时间组</small><b>{fmt(data?.fitDiagnostics.checkGroups,0)}</b></div></div><p className="fr-note">统计估计不等于胜率，需结合后续交易结果评估。</p></section>
      <section className="fr-section"><div className="fr-section-head"><h2>关系与成交校准</h2><span>不是胜率</span></div><div className="fr-three"><div><small>单币集中度提示</small><b>{fmt(data?.evidenceDiagnostics?.concentrationWarnings,0)}</b></div><div><small>成交偏差提示</small><b>{fmt(data?.evidenceDiagnostics?.calibrationWarnings,0)}</b></div><div><small>保留的已平仓反馈</small><b>{fmt(data?.feedbackCount,0)}</b></div></div><p className="fr-note">集中度和成交偏差用于风险评估；统计估计并非收益承诺。</p></section>
      <section className="fr-section"><button className="fr-expand" aria-expanded={showDormant} onClick={()=>setShowDormant(!showDormant)}><div><h2>休眠规则</h2><p>仅展示不参与当前开仓的规则。</p></div><span>{dormant.length} {showDormant?"−":"+"}</span></button>{showDormant&&<div className="fr-rule-grid">{dormant.map(r=><RuleCard key={r.id} rule={r}/>)}</div>}</section></>}

    {tab==="orders"&&<><PageTitle eyebrow="REAL-FEED PAPER" title="模拟账户" text="与实盘使用同一套观察结构。模拟成交含模型手续费、滑点和资金费用占位，不冒充Gate真实成交。"/>
      <nav className="fr-live-tabs fr-paper-tabs" aria-label="模拟子导航">{([["account","账户"],["positions","持仓"],["history","记录"],["archive","归档"]] as const).map(([id,label])=><button key={id} className={paperTab===id?"selected":""} aria-current={paperTab===id?"page":undefined} onClick={()=>setPaperTab(id)}>{label}</button>)}</nav>
      {paperTab==="account"&&<>
        <section className="fr-stats fr-paper-summary" data-testid="paper-account-summary"><Stat label="模拟账户权益" value={`${fmt(data?.equity)} U`} note={`起始 ${fmt(data?.initialEquity)} U`}/><Stat label="保证金占用" value={`${fmt(paperMargin)} U`} note="当前模拟持仓合计"/><Stat label="持仓浮动盈亏" value={`${signed(data?.floating)} U`} note="已包含模型退出成本口径"/><Stat label="当前持仓" value={data?`${data.positions.length} 笔`:"—"} note={`已完成 ${fmt(data?.resolved,0)} 笔`}/></section>
        <div className="fr-account-line"><span>模拟成交额 {fmt(data?.turnover)} U · 已扣费用 {fmt(data?.fees)} U</span><b>最大回撤 {fmt(data?data.maxDrawdown*100:null)}%</b></div>
        <section className="fr-section fr-live-holdings" data-testid="paper-account-holdings"><div className="fr-section-head"><h2>当前持仓</h2><span>{data?.positions.length??"—"} 笔</span></div>
          {data?.positions.length?<div className="fr-position-list">{data.positions.map(t=>{const pnl=tradePnl(t,now),rate=t.notional>0&&pnl!=null?pnl/t.notional:null;return <details key={t.id} className="fr-position-row"><summary>
            <span><b>{t.symbol.replace("_"," / ")}</b><small>{t.side==="LONG"?"多单":"空单"} · {fmt(t.leverage,0)}× · 保证金 {fmt(t.margin)} U</small></span>
            <span className={(pnl??0)>=0?"fr-positive":"fr-negative"}><b>{signed(pnl)} U</b><small>{rate==null?"—":`${signed(rate*100,3)}%`} · 展开</small></span>
          </summary><TradeCard trade={t} now={now}/></details>;})}</div>:<Empty title="当前没有模拟持仓" text="符合条件的新订单会显示在这里。"/>}
        </section>
      </>}
      {paperTab==="positions"&&<section className="fr-section" data-testid="paper-positions"><div className="fr-section-head"><h2>当前持仓</h2><span>{data?.positions.length??"—"} 笔</span></div>{data?.positions.length?<div className="fr-rule-grid">{data.positions.map(t=><TradeCard key={t.id} trade={t} now={now}/>)}</div>:<Empty title="当前没有模拟持仓" text="符合条件的新订单会显示在这里。"/>}</section>}
      {(paperTab==="history"||paperTab==="archive")&&<section className="fr-section" data-testid={paperTab==="history"?"paper-history":"paper-archive"}><div className="fr-section-head"><h2>{paperTab==="history"?"最近记录":"归档记录"}</h2><span>{paperTab==="history"?"最新10条":"更早记录"}</span></div>
        {(paperTab==="history"?paperRecords.recent:paperArchive.items).length?<div className="fr-rule-grid">{(paperTab==="history"?paperRecords.recent:paperArchive.items).map(t=><TradeCard key={t.id} trade={t} now={now}/>)}</div>:<Empty title="暂无已平仓记录" text="订单平仓后自动归入记录。"/>}
        {paperTab==="archive"&&<ArchivePagination page={paperArchive.page} pages={paperArchive.pages} onPage={setPaperPage}/>}
      </section>}</>}

    {tab==="journal"&&<>
      <section className="fr-section"><h2>数据导出</h2><p className="fr-note">导出当前研究数据与账户快照，不会离开当前页面。</p><button className="fr-button" type="button" onClick={exportSnapshot} disabled={exporting}>{exporting?"正在导出…":"导出当前研究快照 ↗"}</button>{exportStatus&&<p className="fr-note" role="status">{exportStatus}</p>}</section>
      <PageTitle eyebrow="AUDITABLE ADAPTATION" title="运行记录" text="查看规则变化、成交与运行异常。"/>
      <section className="fr-section"><div className="fr-section-head"><h2>演变记录</h2><span>最近 {data?.events.length??"—"} 条</span></div><Journal data={data} limit={80}/></section></>}

    {tab==="settings"&&<><PageTitle eyebrow="SYSTEM & ACCESS" title="系统" text="日常交易观察留在模拟和实盘页；这里集中放权限、API、复制诊断和运行边界。"/>
      {accountPanel}
      {liveSystemPanel}
      <section ref={fontControl} className="fr-section fr-font-control"><div className="fr-section-head"><div><small>界面显示</small><h2>界面字号</h2></div><b>{fontScale}%</b></div>
        <p className="fr-note">只调整这个浏览器里的页面字号，不影响交易、账户或其他设备。改用固定档位，点击后保持当前页面位置不动。</p>
        <div className="fr-font-options" role="group" aria-label="界面字号">{[70,80,90,100,110].map(value=><button key={value} type="button" className={fontScale===value?"selected":""} aria-pressed={fontScale===value} onClick={()=>selectFontScale(value)}>{value}%</button>)}</div>
      </section>
      <section className="fr-section"><div className="fr-section-head"><div><small>运行边界</small><h2>当前系统设置</h2></div></div>
        <Setting title="当前主系统" value={data?.policyVersion??data?.version??"读取中"} text="行情驱动的交易规则与执行。"/><Setting title="规则自动适应" value="在线运行" text="每5分钟整理行情，按后续反应更新规则。"/><Setting title="执行权限" value="模拟决策 / 实盘复制" text="模拟提供交易决定；实盘按固定比例复制并使用Gate真实成交。"/><Setting title="风险预算" value="权益随动" text={data?.boundaries.risk??"读取中"}/><Setting title="成本口径" value="显式假设" text={data?.cost.assumption??"读取中"}/><Setting title="连续性" value="持久化" text="状态保存后才提交新订单；重启恢复原账户。"/>
      </section></>}

    {tab==="live"&&livePanel}


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
function tradePnl(t:Trade,now:number){const open=t.status==="OPEN",d=t.side==="LONG"?1:-1;
  return open?d*t.quantity*(t.lastPrice-t.entryPrice)-t.entryFee-t.quantity*t.lastPrice*.0007-t.notional*.0002*Math.max(0,now-t.openedAt)/86400000:t.netPnl;
}
function duration(start:number,end:number|null|undefined,now:number){const ms=Math.max(0,(end??now)-start),minutes=Math.floor(ms/60000);return minutes>=60?`${Math.floor(minutes/60)}小时${minutes%60}分`:`${minutes}分钟`;}
function TradeCard({trade:t,now}:{trade:Trade;now:number}){const open=t.status==="OPEN",pnl=tradePnl(t,now),rate=t.notional>0&&pnl!=null?pnl/t.notional:null;
  return <article className="fr-trade fr-trade-unified"><header><div><small>{open?"持仓中":"已平仓"} · {t.side==="LONG"?"多单":"空单"}</small><h3>{t.symbol.replace("_"," / ")}</h3></div>
    <strong className={(pnl??0)>=0?"fr-positive":"fr-negative"}>{signed(pnl)} <small>U{rate==null?"":` · ${signed(rate*100,3)}%`}</small></strong></header>
    <dl><div><dt>入场价</dt><dd>{fmt(t.entryPrice,5)}</dd></div><div><dt>{open?"当前价格":"出场价"}</dt><dd>{fmt(open?t.lastPrice:t.exitPrice,5)}</dd></div>
      <div><dt>保护止损</dt><dd>{fmt(t.stopPrice,5)}</dd></div><div><dt>名义金额</dt><dd>{fmt(t.notional)} U</dd></div>
      <div><dt>保证金 / 杠杆</dt><dd>{fmt(t.margin)} U / {fmt(t.leverage,0)}×</dd></div><div><dt>合约数量</dt><dd>{fmt(t.contracts,0)}</dd></div>
      <div><dt>进场时间</dt><dd>{time(t.openedAt)}</dd></div><div><dt>出场时间</dt><dd>{open?"持仓中":time(t.closedAt)}</dd></div>
      <div><dt>持仓时长</dt><dd>{duration(t.openedAt,t.closedAt,now)}</dd></div></dl>
    {t.exitReason&&<p className="fr-trade-reason">退出原因：{t.exitReason}</p>}
    <details className="fr-details"><summary>策略与模拟成本</summary><p className="fr-note">规则 v{t.rule.version} · {condition(t.rule)}。{t.exitReason??`退出依据：${t.rule.exitMode==="REACTION_DECAY"?"反应回吐保护":"反应期限"}；相反新证据连续确认后可退出。`}</p>
      <p className="fr-note">模拟成交使用新鲜盘口并计入模型手续费、滑点和资金费占位；实盘实际结果请在实盘页对照。</p></details>
  </article>;
}
function Journal({data,limit}:{data:View|null;limit:number}){const events=data?.events.filter(e=>e.kind!=="UPGRADE").slice(0,limit)??[];const names={START:"启动",RULE:"生成 / 修订",DORMANT:"休眠",ENTRY:"模拟开仓",EXIT:"模拟平仓",PROTECTION:"保护更新",DATA_GAP:"样本作废",FIT:"关系检查",UPGRADE:"连续升级"};return events.length?<div className="fr-journal">{events.map(e=><article key={e.id}><time>{time(e.at)}</time><div><b>{names[e.kind]}</b><p>{e.reason}</p></div></article>)}</div>:<Empty title="等待第一条运行记录" text="暂无运行事件。"/>;}
