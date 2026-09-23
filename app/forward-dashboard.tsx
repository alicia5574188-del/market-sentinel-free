"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { FEATURES, type Rule, type Trade, type forwardSummary } from "../lib/forward-relations.ts";
import {recordWindows,archivePage} from "../lib/record-view.ts";
import {ArchivePagination} from "./record-controls.tsx";
import EquityCurve from "./equity-curve.tsx";
import {EquityHistoryCache} from "../lib/equity-cache.ts";
import { REGION_LIFECYCLE_VERSION, type RegionLifecycleState } from "../lib/region-lifecycle.ts";
import { ANCHOR_FLOW_VERSION } from "../lib/anchor-flow.ts";
type View = ReturnType<typeof forwardSummary>;
type Tab = "overview" | "relations" | "orders" | "live" | "journal" | "settings";
const fmt = (v: number | null | undefined, digits=2) => typeof v==="number"&&Number.isFinite(v)?v.toLocaleString("en-US",{minimumFractionDigits:digits,maximumFractionDigits:digits}):"—";
const signed = (v: number | null | undefined, digits=2) => typeof v==="number"?`${v>=0?"+":""}${fmt(v,digits)}`:"—";
const time = (v?:number|null) => v?new Date(v).toLocaleString("zh-CN",{timeZone:"Asia/Vientiane",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}):"—";
const condition = (r:Rule) => r.grammar===ANCHOR_FLOW_VERSION?"AnchorFlow · 15m管理":r.grammar===REGION_LIFECYCLE_VERSION?"5m 区域拒绝":r.authority==="MULTI_TURN"?`${r.turnTimeframe??"—"} 旧版转折记录`:r.conditions.map(c=>`${FEATURES[c.feature]} ${c.op==="GE"?"≥":"≤"} ${fmt(c.threshold)}`).join(" ＋ ");
const REGION_STATUS:Record<RegionLifecycleState["status"],string>={NO_REGION:"未形成区域",IN_REGION:"区域内",PROBE_UP:"上沿试探",PROBE_DOWN:"下沿试探",ACCEPTED_UP:"上方接受",ACCEPTED_DOWN:"下方接受",DETACHED_UP:"上方已远离",DETACHED_DOWN:"下方已远离"};

export default function ForwardDashboard({data,healthy,statusLabel,feedAt,error,livePanel,liveSystemPanel,liveEnabled,liveOverview,accountPanel,memberName,cacheScope="owner"}:{data:View|null;healthy:boolean;statusLabel?:string;feedAt:number|null;error:string|null;livePanel:ReactNode;liveSystemPanel?:ReactNode;liveEnabled:boolean;liveOverview?:{equity:number|null;available:number|null;positionCount:number;operational:boolean;lastSyncAt:number|null;copied:number|null;eligible:number|null;missing:number|null};accountPanel?:ReactNode;memberName?:string;cacheScope?:string}) {
  const [equityCache]=useState(()=>new EquityHistoryCache());
  useEffect(()=>()=>equityCache.cancel(),[equityCache]);
  const [tab,setTab]=useState<Tab>("overview"),[now,setNow]=useState(0),[liveMounted,setLiveMounted]=useState(false);
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
  const select=(next:Tab)=>{scroll.current[tab]=window.scrollY;if(next==="live")setLiveMounted(true);setTab(next);};
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
  const blockers=Object.entries(data?.entryDiagnostics?.reasons??{}).sort((a,b)=>b[1]-a[1]);
  const mainBlocker=blockers[0]?.[0]??"本轮暂无阻塞";
  const regionStates=data?.regionLifecycles??[];
  const activeRegions=regionStates.filter(row=>!!row.zone);
  const regionSignals=(data?.regionSignals??[]).filter(row=>!now||row.expiresAt>now);
  const launchSignals=(data?.regionLaunchSignals??[]).filter(row=>!now||row.expiresAt>now);
  const executableSignals=[...regionSignals,...launchSignals].sort((a,b)=>a.completedAt-b.completedAt);
  const preparedSignals=executableSignals.slice(0,6);
  const anchorFlows=(data?.anchorFlows??[]).filter(row=>row.phase!=="FAILED"&&row.phase!=="FIRED");
  const regionLaunches=data?.regionLaunches??[];
  const activeLaunches=regionLaunches.filter(row=>row.phase!=="CONSUMED");
  const armedLaunches=activeLaunches.filter(row=>row.phase==="ARMED"||row.phase==="IGNITION"||row.phase==="READY");
  const regionMap=new Map(activeRegions.map(row=>[row.symbol,row]));
  const regionPriority:Record<RegionLifecycleState["status"],number>={PROBE_UP:0,PROBE_DOWN:0,ACCEPTED_UP:1,ACCEPTED_DOWN:1,IN_REGION:2,DETACHED_UP:3,DETACHED_DOWN:3,NO_REGION:4};
  const regionRows=[...activeRegions].sort((a,b)=>(regionPriority[a.status]??9)-(regionPriority[b.status]??9)||b.observedAt-a.observedAt||a.symbol.localeCompare(b.symbol)).slice(0,18);
  const inRegionCount=activeRegions.filter(row=>row.status==="IN_REGION").length;
  const probeCount=activeRegions.filter(row=>row.status==="PROBE_UP"||row.status==="PROBE_DOWN").length;
  const acceptedCount=activeRegions.filter(row=>row.status==="ACCEPTED_UP"||row.status==="ACCEPTED_DOWN").length;
  const detachedCount=activeRegions.filter(row=>row.status==="DETACHED_UP"||row.status==="DETACHED_DOWN").length;
  const currentPositionCount=data?.positions.filter(t=>["region-lifecycle-entry-v1","anchor-flow-entry-v1","region-launch-entry-v1"].includes(t.entryContext?.version??"")).length??0;
  const legacyPositionCount=(data?.positions.length??0)-currentPositionCount;
  const paperMargin=data?.positions.reduce((sum,t)=>sum+t.margin,0)??null;
  const elapsed=data&&now?Math.max(0,(now-data.startedAt)/3600000):null;
  const nav:[Tab,string,string][]=[["overview","◉","总览"],["relations","⌘","执行"],["orders","⇄","模拟"],["live","◈","实盘"],["journal","≋","演变"],["settings","⊙","系统"]];
  const systemStatus=statusLabel==="后台运行中"?"正常":statusLabel?.startsWith("后台运行中 · ")?statusLabel.slice("后台运行中 · ".length):statusLabel??(healthy?"正常":"行情重连中");
  return <main className="fr-app" style={fontStyle} data-ui-version="dark-anchor-flow-v1" data-record-view="compact-records-pnl-v1">
    <header className="fr-header"><div className="fr-brand"><span className="fr-emblem">↗</span><div><b>哨兵 · AnchorFlow / RegionLaunch</b><small>REGION MEMORY · RETEST · IGNITION</small></div></div><span className={`fr-status ${healthy?"is-on":""}`}><i/>{healthy?"真实行情在线":"连接中"}</span></header>
    <div className="fr-subhead"><span>Gate USDT 永续 · 30市场扫描 · 11市场实时执行</span><span>实盘{liveEnabled?"已请求开启":"关闭"} · 所有者控制</span></div>
    {memberName&&<p className="fr-note">{memberName} · 共用同一模拟策略，实盘账户独立，开关只由你控制。</p>}

    {tab==="overview"&&<>
      <section className="fr-hero"><div className="fr-hero-copy"><span className="fr-kicker">账户驾驶舱</span><h1>{systemStatus==="正常"?"系统正在正常运行":`系统状态：${systemStatus}`}</h1>
        <p>{data?.latestReason??"正在读取已持久化账户和真实行情状态。"}</p>
        <div className="fr-hero-tags"><span>连续运行 {elapsed==null?"—":fmt(elapsed,1)} 小时</span><span>1h主方向</span><span>15m延续确认</span><span>30市场区域扫描</span><span>第一次回测 / 爆发追击 / 边界拒绝</span><span>实盘{liveEnabled?"已开启":"关闭"}</span></div></div>
        <div className="fr-equity"><small>模拟账户权益 · USDT</small><strong>{fmt(data?.equity)}</strong><div className={(data?.netPnl??0)>=0?"fr-positive":"fr-negative"}>{signed(data?.netPnl)} <span>U · {signed(data?data.netPnl/data.initialEquity*100:null)}%</span></div>
          <footer><span>起点 {fmt(data?.initialEquity,0)}</span><span>最大回撤 {fmt(data?data.maxDrawdown*100:null)}%</span></footer></div></section>

      <section className="fr-stats">
        <Stat label="模拟账户" value={`${fmt(data?.equity)} U`} note={`${data?.positions.length??"—"} 笔持仓 · 浮盈 ${signed(data?.floating)} U`}/>
        <Stat label="实盘账户" value={`${fmt(liveOverview?.equity)} U`} note={`${liveOverview?.positionCount??"—"} 笔持仓 · 可用 ${fmt(liveOverview?.available)} U`}/>
        <Stat label="复制一致性" value={liveOverview?.eligible==null?"—":`${liveOverview.copied??0} / ${liveOverview.eligible}`} note={liveOverview?.missing?`${liveOverview.missing} 笔需要核对`:"当前无漏复制提示"}/>
        <Stat label="系统状态" value={systemStatus} note={`行情心跳 ${time(feedAt)}`}/>
      </section>

      <div className="fr-two">
        <section className="fr-section"><div className="fr-section-head"><div><small>模拟账户</small><h2>净值变化</h2></div><span>含模拟成本</span></div>
          <EquityCurve data={data} healthy={healthy} cache={equityCache} cacheScope={cacheScope}/>
          <div className="fr-three"><div><small>累计模拟成交额</small><b>{fmt(data?.turnover)} U</b></div><div><small>已扣模拟费用</small><b>{fmt(data?.fees)} U</b></div><div><small>已完成订单</small><b>{fmt(data?.resolved,0)}</b></div></div>
        </section>
        <section className="fr-section fr-now-card"><div className="fr-section-head"><div><small>当前状态</small><h2>系统正在做什么</h2></div><span>{time(data?.updatedAt)}</span></div>
          <div className="fr-three"><div><small>待交易事件</small><b>{executableSignals.length}</b></div><div><small>成熟区域</small><b>{activeRegions.length}</b></div><div><small>模拟持仓</small><b>{fmt(data?.positions.length,0)}</b></div></div>
          <div className="fr-insight"><span className="fr-dot"/><p>{data?.latestReason??"等待运行状态。"}</p></div>
          <div className="fr-action-row"><button className="fr-button" onClick={()=>select("relations")}>查看执行流程</button><button className="fr-button secondary" onClick={()=>select("orders")}>查看模拟账户</button></div>
        </section>
      </div>

      {(liveOverview?.missing??0)>0&&<section className="fr-section fr-parity-alert"><div className="fr-section-head"><div><small>需要关注</small><h2>模拟—实盘复制存在差异</h2></div><span>{liveOverview?.missing} 笔</span></div>
        <p className="fr-note">这里仅提示存在需要核对的订单，不用不同资金规模账户的绝对盈亏做比较。进入实盘页查看标准化收益率、入场偏差、复制延迟和按实盘名义额折算后的执行结果。</p>
        <button className="fr-text-button" onClick={()=>select("live")}>查看实盘差异 →</button></section>}

      <section className="fr-section"><div className="fr-section-head"><div><small>最近变化</small><h2>需要留意的运行记录</h2></div><button className="fr-text-button" onClick={()=>select("journal")}>全部记录 ↗</button></div><Journal data={data} limit={3}/></section>
    </>}

    {tab==="relations"&&<><PageTitle eyebrow="DUAL REGION EXECUTION" title="执行" text="AnchorFlow回测后必须重新突破当前1分钟局部结构，横盘里的旧信号不能直接开仓。RegionLaunch按当前缠绕区向上或向下的实际突破追击：连续两根1分钟强突破，或强突破后小回调再启动；大周期旧方向只作背景。"/>

      <section className="fr-section fr-exec-flow-section"><div className="fr-section-head"><div><small>当前执行层</small><h2>成熟区域双通道</h2></div><span>{time(data?.updatedAt)}</span></div>
        <div className="fr-exec-flow">
          <ExecStep index="01" title="30市场扫描" status={(data?.marketCount??0)>0?"已更新":"等待"} text={`当前维护 ${fmt(data?.marketCount,0)} 个市场；已有持仓、AnchorFlow READY/RETEST 与 RegionLaunch ARMED/IGNITION 优先获得11个实时盘口槽。`}/>
          <ExecStep index="02" title="成熟母区域记忆" status={activeRegions.length?"持续识别":"扫描中"} text={`当前 ${activeRegions.length} 个区域；普通失败离区不会让 RegionLaunch 消费母区域，直到真正出现独立新结构或成功发射后回到中心再重新计次。`}/>
          <ExecStep index="03" title="子区压缩 / 提前ARMED" status={armedLaunches.length?"正在盯盘":"等待压缩"} text={armedLaunches.length?`当前 ${armedLaunches.length} 个 RegionLaunch 标的已获得高优先级；必须先观察到突破前真实盘口，禁止部署后补追已经发生的行情。`:`正在母区域边界附近寻找4–10根5m短压缩；短子区本身没有独立交易权。`}/>
          <ExecStep index="04" title="两种启动入口" status={anchorFlows.length||armedLaunches.length?"观察中":"等待机会"} text={`AnchorFlow候选 ${anchorFlows.length} 个：等回测后当前局部结构重启；RegionLaunch活跃 ${armedLaunches.length} 个：连续两根1分钟强突破即可追，或小回调后第一根重新顺向。`}/>
          <ExecStep index="05" title="真实盘口开仓" status={executableSignals.length?"检查中":"等待"} text={(data?.entryDiagnostics?.opened??0)>0?`本轮已开仓 ${fmt(data?.entryDiagnostics?.opened,0)} 笔。`:`当前执行状态：${mainBlocker}。`}/>
          <ExecStep index="06" title="快速正反馈验证" status={(data?.positions.length??0)>0?"管理中":"等待持仓"} text="RegionLaunch成交后60秒必须产生真实可执行浮赢；AnchorFlow仍按第一根完整5m验证。验证失败只结束本次启动，不删除成熟母区域。"/>
          <ExecStep index="07" title="利润保护与退出" status={(data?.positions.length??0)>0?"持续保护":"等待持仓"} text={`管理 ${fmt(data?.positions.length,0)} 笔持仓；RegionLaunch约85%峰值起步锁利，大利润5–8分钟不创新高主动兑现；AnchorFlow继续使用现有动态锁利。`}/>
        </div>
      </section>

      <section className="fr-section fr-prepared-section"><div className="fr-section-head"><div><small>EXECUTABLE EVENTS</small><h2>待交易事件</h2><p>候选成交前仍须通过当前盘口、局部结构与完整止损风险检查。爆发追击接受连续两根1分钟强突破，或强突破后小回调再启动；单独一根强K不直接开仓。</p></div><span>{executableSignals.length} 个</span></div>
        {preparedSignals.length?<div className="fr-prepared-grid">{preparedSignals.map((x,index)=><article className="fr-prepared-card" key={x.id}>
          <header><div><small>#{index+1} · {("entryModel" in x&&x.entryModel==="REGION_LAUNCH")?"爆发追击":x.kind==="MIGRATION"?"回测重启":"边界拒绝"}</small><h3>{x.symbol.replace("_"," / ")}</h3><p>5m · {x.side==="LONG"?"准备做多":"准备做空"} · {x.boundary==="UPPER"?"上沿事件":"下沿事件"}</p></div><b>待执行</b></header>
          <div className="fr-prepared-metrics"><span><small>区域下沿</small><strong>{fmt(x.regionLower,5)}</strong></span><span><small>区域中心</small><strong>{fmt(x.regionCenter,5)}</strong></span><span><small>区域上沿</small><strong>{fmt(x.regionUpper,5)}</strong></span><span><small>事件价格</small><strong>{fmt(x.signalPrice,5)}</strong></span><span><small>结构止损</small><strong>{fmt(x.stopPrice,5)}</strong></span><span><small>{x.kind==="REJECTION"?"回归目标":"有效至"}</small><strong>{x.kind==="REJECTION"?fmt(x.targetPrice,5):time(x.expiresAt)}</strong></span></div>
          <p>{x.reason}</p>
        </article>)}</div>:<Empty title="当前没有待交易事件" text={armedLaunches.length?"RegionLaunch 已提前盯住候选，等待1分钟强突破与小回调后的重新顺向确认。":anchorFlows.length?"已有 AnchorFlow 候选，正在等待第一次回测守住并重新启动。":activeRegions.length?"已有成熟区域，等待回测或爆发启动。":"正在寻找最近已经形成的成熟区域。"} />}
      </section>

      <section className="fr-section fr-prepared-section"><div className="fr-section-head"><div><small>REGIONLAUNCH WATCH</small><h2>爆发观察池</h2><p>母区域长期保留；短子区只负责提前进入实时盘口观察。WATCH没有追单权限，只有ARMED→IGNITION→READY完整走完后才可能成交。</p></div><span>{activeLaunches.length} 个</span></div>
        {activeLaunches.length?<div className="fr-prepared-grid">{activeLaunches.slice(0,8).map((x,index)=><article className="fr-prepared-card" key={`${x.symbol}:${x.motherRegionId}`}>
          <header><div><small>#{index+1} · {x.phase}</small><h3>{x.symbol.replace("_"," / ")}</h3><p>母区K线 {x.motherBars} · 失败离区 {x.failedDepartures} 次 · 质量 {fmt(x.quality*100,0)}</p></div><b>{x.phase}</b></header>
          <div className="fr-prepared-metrics"><span><small>母区下沿</small><strong>{fmt(x.motherLower,5)}</strong></span><span><small>母区中心</small><strong>{fmt(x.motherCenter,5)}</strong></span><span><small>母区上沿</small><strong>{fmt(x.motherUpper,5)}</strong></span><span><small>子区K线</small><strong>{x.compression?x.compression.bars:"—"}</strong></span><span><small>子区下沿</small><strong>{fmt(x.compression?.lower,5)}</strong></span><span><small>子区上沿</small><strong>{fmt(x.compression?.upper,5)}</strong></span></div>
          <p>{x.reason}</p>
        </article>)}</div>:<Empty title="当前没有RegionLaunch待命区域" text="成熟区域仍由AnchorFlow正常使用；RegionLaunch只在母区边界出现短压缩时提高实时观察优先级。"/>}
      </section>

      <section className="fr-section fr-scoreboard-section"><div className="fr-section-head"><div><small>REGION WATCHLIST</small><h2>区域观察池</h2><p>AnchorFlow继续维护当前有效区域；RegionLaunch另行保存长期母区域记忆。后续较短的新区域若仍属于同一价格家族，只作为子区压缩，不会抹掉母区经历。</p></div><span>{activeRegions.length} 个区域</span></div>
        {regionRows.length?<div className="fr-scoreboard">{regionRows.map((row,index)=>{const z=row.zone!;const event=regionSignals.find(signal=>signal.symbol===row.symbol);
          return <details className={`fr-score-row ${event?"is-eligible":""}`} key={`${row.symbol}:${z.id}`}>
            <summary><span className="fr-score-rank">#{index+1}</span><span className="fr-score-value">{fmt(z.widthRate*100,2)}%</span><span className="fr-score-symbol"><b>{row.symbol.replace("_"," / ")}</b><small>{REGION_STATUS[row.status]}</small></span>
              <span><small>区域上沿</small><b>{fmt(z.upper,5)}</b></span><span><small>区域中心</small><b>{fmt(z.center,5)}</b></span><span><small>区域下沿</small><b>{fmt(z.lower,5)}</b></span><em>{event?"待交易":REGION_STATUS[row.status]}</em></summary>
            <div className="fr-score-details">
              <div><h3>当前区域</h3><div className="fr-score-detail-grid"><Metric label="形成完成" value={time(z.confirmedAt)}/><Metric label="区域K线" value={`${z.bars} 根`}/><Metric label="区域宽度" value={`${fmt(z.widthRate*100,2)}%`}/><Metric label="中心穿越" value={`${z.crossings} 次`}/><Metric label="上下触及" value={`${z.touchesLower} / ${z.touchesUpper}`}/></div></div>
              <div><h3>生命周期</h3><div className="fr-score-detail-grid"><Metric label="当前状态" value={REGION_STATUS[row.status]}/><Metric label="最近处理" value={time(row.lastProcessedAt)}/><Metric label="试探极值" value={fmt(row.probeExtreme,5)}/><Metric label="接受确认" value={time(row.acceptedAt)}/><Metric label="远离确认" value={time(row.detachedAt)}/></div></div>
              <div><h3>边界交易资格</h3><div className="fr-score-detail-grid"><Metric label="上沿" value={row.upperConsumedAt?"已消费，等重置":"可观察"}/><Metric label="下沿" value={row.lowerConsumedAt?"已消费，等重置":"可观察"}/><Metric label="待交易事件" value={event?(event.kind==="MIGRATION"?"接受迁移":"边界拒绝"):"无"}/><Metric label="方向" value={event?(event.side==="LONG"?"做多":"做空"):"—"}/></div></div>
              <p>{row.reason}</p>
            </div>
          </details>;})}</div>:<Empty title="暂无成熟区域" text="系统正在轮换扫描30个市场；没有成熟区域的标的不占用交易事件。"/>}
      </section>
    </>}
    {tab==="orders"&&<><PageTitle eyebrow="REAL-FEED PAPER" title="模拟账户" text="与实盘使用同一套观察结构。模拟成交含模型手续费、滑点和资金费用占位，不冒充Gate真实成交。"/>
      <nav className="fr-live-tabs fr-paper-tabs" aria-label="模拟子导航">{([["account","账户"],["positions","持仓"],["history","记录"],["archive","归档"]] as const).map(([id,label])=><button key={id} className={paperTab===id?"selected":""} aria-current={paperTab===id?"page":undefined} onClick={()=>setPaperTab(id)}>{label}</button>)}</nav>
      {paperTab==="account"&&<>
        <section className="fr-stats fr-paper-summary" data-testid="paper-account-summary"><Stat label="模拟账户权益" value={`${fmt(data?.equity)} U`} note={`起始 ${fmt(data?.initialEquity)} U`}/><Stat label="保证金占用" value={`${fmt(paperMargin)} U`} note="当前模拟持仓合计"/><Stat label="持仓浮动盈亏" value={`${signed(data?.floating)} U`} note="已包含模型退出成本口径"/><Stat label="当前持仓" value={data?`${data.positions.length} 笔`:"—"} note={`已完成 ${fmt(data?.resolved,0)} 笔`}/></section>
        <div className="fr-account-line"><span>模拟成交额 {fmt(data?.turnover)} U · 已扣费用 {fmt(data?.fees)} U</span><b>最大回撤 {fmt(data?data.maxDrawdown*100:null)}%</b></div>
        <section className="fr-section fr-live-holdings" data-testid="paper-account-holdings"><div className="fr-section-head"><h2>当前持仓</h2><span>{data?.positions.length??"—"} 笔</span></div>
          {data?.positions.length?<div className="fr-position-list">{data.positions.map(t=>{const pnl=tradePnl(t,now),rate=t.notional>0&&pnl!=null?pnl/t.notional:null;
            const context=t.entryContext,hold=t.holdValue,tf=context?.timeframe??t.turn?.timeframe,region=regionMap.get(t.symbol);
            const isLaunch=context?.version==="region-launch-entry-v1";
            const isRegion=context?.version==="region-lifecycle-entry-v1"||context?.version==="anchor-flow-entry-v1"||isLaunch;
            const isAnchor=context?.version==="anchor-flow-entry-v1";
            const entrySpace=context?.remainingSpaceRate??t.forecast?.remainingNetRate??null;
            const pullback=hold?.pullbackRiskRate??null,best=hold?.bestHoldMinutes??context?.bestHoldMinutes??null;
            const verdict=hold?.action==="EXIT_PROFIT"?"建议止盈":hold?.action==="EXIT_RISK"?"建议退出":hold?"继续持有":"等待评估";
            const holdText=best==null?"最佳持有 —":best>=1440?`最佳持有 ${fmt(best/1440,1)}天`:best>=60?`最佳持有 ${fmt(best/60,1)}小时`:`最佳持有 ${fmt(best,0)}分钟`;
            return <details key={t.id} className="fr-position-row"><summary>
            <span className="fr-position-primary"><b>{t.symbol.replace("_"," / ")}</b><small>{t.side==="LONG"?"多单":"空单"} · {fmt(t.leverage,0)}× · 保证金 {fmt(t.margin)} U</small>
              <b className={(pnl??0)>=0?"fr-positive":"fr-negative"}>{signed(pnl)} U</b><small>{rate==null?"—":`${signed(rate*100,3)}% · 展开`}</small></span>
            <span className="fr-position-entry"><b>{isLaunch?"RegionLaunch · 爆发追击":isAnchor?"AnchorFlow · 15m管理":isRegion?"5m · 边界拒绝":tf?`${tf} · 旧版`:"入场依据"}</b>
              {isRegion?<><small>来源区域 {fmt(context?.regionLower,5)} – {fmt(context?.regionUpper,5)} · 当前 {region?REGION_STATUS[region.status]:"等待区域更新"}</small>
                <small>防守 {fmt(t.stopPrice,5)} · {isLaunch?`点火推进 ${fmt((context?.launchImpulseRate??0)*100,2)}% · 60秒验证 ${t.entryValidation?.passed===true?"通过":t.entryValidation?.passed===false?"失败":"等待"}`:isAnchor?`回测 ${time(context?.anchorRetestAt)} · 首根5m验证 ${t.entryValidation?.passed===true?"通过":t.entryValidation?.passed===false?"失败":"等待"}`:context?.regionKind==="REJECTION"?`中心目标 ${fmt(context?.regionCenter,5)}`:"结构管理"}</small></>:<><small>评分 {context?.entryScore==null?"—":fmt(context.entryScore,0)} · 空间 {entrySpace==null?"—":`${fmt(entrySpace*100,1)}%`} · 回调 {pullback==null?"—":`${fmt(pullback*100,1)}%`}</small><small>{holdText} · {verdict}</small></>}
            </span>
          </summary><TradeCard trade={t} now={now} region={region}/></details>;})}</div>:<Empty title="当前没有模拟持仓" text="符合条件的新订单会显示在这里。"/>}
        </section>
      </>}
      {paperTab==="positions"&&<section className="fr-section" data-testid="paper-positions"><div className="fr-section-head"><h2>当前持仓</h2><span>{data?.positions.length??"—"} 笔</span></div>{data?.positions.length?<div className="fr-rule-grid">{data.positions.map(t=><TradeCard key={t.id} trade={t} now={now} region={regionMap.get(t.symbol)}/>)}</div>:<Empty title="当前没有模拟持仓" text="符合条件的新订单会显示在这里。"/>}</section>}
      {(paperTab==="history"||paperTab==="archive")&&<section className="fr-section" data-testid={paperTab==="history"?"paper-history":"paper-archive"}><div className="fr-section-head"><h2>{paperTab==="history"?"最近记录":"归档记录"}</h2><span>{paperTab==="history"?"最新10条":"更早记录"}</span></div>
        {(paperTab==="history"?paperRecords.recent:paperArchive.items).length?<div className="fr-rule-grid">{(paperTab==="history"?paperRecords.recent:paperArchive.items).map(t=><TradeCard key={t.id} trade={t} now={now} region={regionMap.get(t.symbol)}/>)}</div>:<Empty title="暂无已平仓记录" text="订单平仓后自动归入记录。"/>}
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
        <Setting title="当前主系统" value="AnchorFlow + RegionLaunch" text="同一成熟区域提供两条独立入口：正常行情等第一次回测重启；提前ARMED的无回踩爆发才允许RegionLaunch追击。"/><Setting title="区域扫描" value="30个5分钟标的" text="持仓、AnchorFlow READY/RETEST、RegionLaunch ARMED/IGNITION优先保留11个实时盘口执行槽；其余成熟区域继续5分钟观察。"/><Setting title="交易事件" value="回测重启 / 爆发追击 / 边界拒绝" text="普通突破仍不追；RegionLaunch必须完整走完母区记忆→子区压缩→ARMED→IGNITION→READY。"/><Setting title="执行权限" value="模拟决策 / 实盘复制" text="模拟提供交易决定；实盘按固定比例复制并使用Gate真实成交。"/><Setting title="风险预算" value="权益随动" text={data?.boundaries.risk??"读取中"}/><Setting title="连续性" value="持久化" text="重启从已有5分钟K恢复最近区域状态，但不会补历史订单；账户和旧持仓保持连续。"/>
      </section></>}

    {liveMounted&&<div className="fr-live-panel-host" hidden={tab!=="live"} aria-hidden={tab!=="live"}>{livePanel}</div>}


    {(error||data?.storage.error)&&<aside className="fr-error" role="status"><b>运行提示</b><p>{data?.storage.error??error}</p><small>保留最近数据；不会把未保存的交易发布为已成交。</small></aside>}
    <footer className="fr-footer"><span>行情心跳 {time(feedAt)}</span><span>{data?.regionVersion??data?.strategyAuthorityVersion??data?.version??"REGION"} · Asia/Vientiane</span></footer>
    <nav className="fr-nav" aria-label="主导航">{nav.map(([id,icon,label])=><button key={id} className={id===tab?"selected":""} aria-current={id===tab?"page":undefined} onClick={()=>select(id)}><span>{icon}</span><b>{label}</b>{id==="orders"&&!!data?.positions.length&&<i>{data.positions.length}</i>}</button>)}</nav>
  </main>;
}
function ExecStep({index,title,status,text}:{index:string;title:string;status:string;text:string}){return<article className="fr-exec-step"><span>{index}</span><div><header><b>{title}</b><em>{status}</em></header><p>{text}</p></div></article>;}
function Metric({label,value}:{label:string;value:string}){return<span><small>{label}</small><b>{value}</b></span>;}
function Stat({label,value,note}:{label:string;value:string;note:string}){return<article><small>{label}</small><strong>{value}</strong><p>{note}</p></article>;}
function Empty({title,text}:{title:string;text:string}){return<div className="fr-empty"><span>◎</span><h3>{title}</h3><p>{text}</p></div>;}
function PageTitle({eyebrow,title,text}:{eyebrow:string;title:string;text:string}){return<section className="fr-page-title"><small>{eyebrow}</small><h1>{title}</h1><p>{text}</p></section>;}
function Setting({title,value,text}:{title:string;value:string;text:string}){return<div className="fr-setting"><div><h3>{title}</h3><p>{text}</p></div><b>{value}</b></div>;}
function tradePnl(t:Trade,now:number){const open=t.status==="OPEN",d=t.side==="LONG"?1:-1;
  return open?d*t.quantity*(t.lastPrice-t.entryPrice)-t.entryFee-t.quantity*t.lastPrice*.0007-t.notional*.0002*Math.max(0,now-t.openedAt)/86400000:t.netPnl;
}
function duration(start:number,end:number|null|undefined,now:number){const ms=Math.max(0,(end??now)-start),minutes=Math.floor(ms/60000);return minutes<1?`${Math.floor(ms/1000)}秒`:minutes>=60?`${Math.floor(minutes/60)}小时${minutes%60}分`:`${minutes}分钟`;}
function TradeCard({trade:t,now,region}:{trade:Trade;now:number;region?:RegionLifecycleState}){const open=t.status==="OPEN",pnl=tradePnl(t,now),rate=t.notional>0&&pnl!=null?pnl/t.notional:null,ctx=t.entryContext;
  const isAnchor=ctx?.version==="anchor-flow-entry-v1",isLaunch=ctx?.version==="region-launch-entry-v1";
  const isRegion=ctx?.version==="region-lifecycle-entry-v1"||isAnchor||isLaunch;
  return <article className="fr-trade fr-trade-unified"><header><div><small>{open?"持仓中":"已平仓"} · {t.side==="LONG"?"多单":"空单"}{isLaunch?" · RegionLaunch":isAnchor?" · AnchorFlow":isRegion?" · 5m区域":t.turn?` · ${t.turn.timeframe}旧版`:""}</small><h3>{t.symbol.replace("_"," / ")}</h3></div>
    <strong className={(pnl??0)>=0?"fr-positive":"fr-negative"}>{signed(pnl)} <small>U{rate==null?"":` · ${signed(rate*100,3)}%`}</small></strong></header>
    <dl><div><dt>入场价</dt><dd>{fmt(t.entryPrice,5)}</dd></div><div><dt>{open?"当前价格":"出场价"}</dt><dd>{fmt(open?t.lastPrice:t.exitPrice,5)}</dd></div>
      <div><dt>结构防守</dt><dd>{fmt(t.stopPrice,5)}</dd></div><div><dt>名义金额</dt><dd>{fmt(t.notional)} U</dd></div>
      <div><dt>保证金 / 杠杆</dt><dd>{fmt(t.margin)} U / {fmt(t.leverage,0)}×</dd></div><div><dt>合约数量</dt><dd>{fmt(t.contracts,0)}</dd></div>
      <div><dt>进场时间</dt><dd>{time(t.openedAt)}</dd></div><div><dt>出场时间</dt><dd>{open?"持仓中":time(t.closedAt)}</dd></div>
      <div><dt>持仓时长</dt><dd>{duration(t.openedAt,t.closedAt,now)}</dd></div></dl>
    {isRegion&&<div className="fr-rule-numbers"><Metric label="来源区域下沿" value={fmt(ctx?.regionLower,5)}/><Metric label="来源区域中心" value={fmt(ctx?.regionCenter,5)}/><Metric label="来源区域上沿" value={fmt(ctx?.regionUpper,5)}/><Metric label="入场类型" value={isLaunch?"RegionLaunch爆发追击":isAnchor?"AnchorFlow回测启动":ctx?.regionKind==="MIGRATION"?"接受迁移":"边界拒绝"}/><Metric label="当前区域状态" value={region?REGION_STATUS[region.status]:"—"}/><Metric label="退出依据" value={isLaunch?"1m确认 / 60秒正反馈 / 85%锁利":isAnchor?"5m验证 / 利润保护 / 15m管理":ctx?.regionKind==="REJECTION"?"到中心 / 结构失效":"新区防守 / 反向接受"}/></div>}
    {t.exitReason&&<p className="fr-trade-reason">退出原因：{t.exitReason}</p>}
    {ctx?.reason&&<p className="fr-trade-reason">入场依据：{ctx.reason}</p>}
    <details className="fr-details"><summary>策略与模拟成本</summary><p className="fr-note">{isLaunch?`RegionLaunch新版 · 成熟母区域长期记忆，4–10根5m子区提前ARMED；1分钟突破K必须强势且反向影线受控，后续只允许小回调，突破推进必须明显大于累计回调；第一根重新顺向1分钟K完成后才允许追击。成交后60秒仍必须产生真实浮赢，盈利后高比例锁利。来源母区 ${fmt(ctx?.regionLower,5)} – ${fmt(ctx?.regionUpper,5)}，结构防守 ${fmt(t.stopPrice,5)}。`:isAnchor?`AnchorFlow新版 · 5m区域负责位置与回测启动，15m负责持仓管理。来源区域 ${fmt(ctx?.regionLower,5)} – ${fmt(ctx?.regionUpper,5)}，中心 ${fmt(ctx?.regionCenter,5)}，结构防守 ${fmt(t.stopPrice,5)}。${region?` 当前区域状态：${REGION_STATUS[region.status]}。`:""}`:isRegion?`5分钟区域生命周期 · ${ctx?.regionKind==="MIGRATION"?"区域外连续收盘被接受后顺方向迁移":"边界外探失败重新回到区域后做中心回归"}。来源区域 ${fmt(ctx?.regionLower,5)} – ${fmt(ctx?.regionUpper,5)}，中心 ${fmt(ctx?.regionCenter,5)}，结构防守 ${fmt(t.stopPrice,5)}。${region?` 当前区域状态：${REGION_STATUS[region.status]}。`:""}`:ctx?.version==="direction-space-entry-context-v2"?`${ctx.timeframe}旧版方向—空间入场 · 总分 ${fmt(ctx.entryScore,0)} · 净剩余空间 ${fmt(ctx.remainingSpaceRate*100,2)}%。`:t.turn?`${t.turn.timeframe}旧版周期记录；继续按原持仓保护自然结束。`:`规则 v${t.rule.version} · ${condition(t.rule)}。`}{t.exitReason?` ${t.exitReason}`:""}</p>
      <p className="fr-note">模拟成交使用新鲜盘口并计入模型手续费、滑点和资金费占位；实盘实际结果请在实盘页对照。</p></details>
  </article>;
}
function Journal({data,limit}:{data:View|null;limit:number}){const events=data?.events.filter(e=>e.kind!=="UPGRADE").slice(0,limit)??[];const names={START:"启动",RULE:"生成 / 修订",DORMANT:"休眠",ENTRY:"模拟开仓",EXIT:"模拟平仓",PROTECTION:"保护更新",DATA_GAP:"样本作废",FIT:"关系检查",UPGRADE:"连续升级"};return events.length?<div className="fr-journal">{events.map(e=><article key={e.id}><time>{time(e.at)}</time><div><b>{names[e.kind]}</b><p>{e.reason}</p></div></article>)}</div>:<Empty title="等待第一条运行记录" text="暂无运行事件。"/>;}
