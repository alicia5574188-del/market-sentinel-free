"use client";

import {type forwardSummary} from "../lib/forward-relations.ts";

type View=ReturnType<typeof forwardSummary>;
const fmt=(v:number|null|undefined,d=1)=>typeof v==="number"&&Number.isFinite(v)?v.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}):"—";
const bias=(v?:string)=>v==="BULLISH"?"偏多":v==="BEARISH"?"偏空":"中性";
const phase=(v?:string)=>({
  BULL_EXPANSION:"扩张阶段",BEAR_CONTRACTION:"收缩阶段",RECOVERY_UNCONFIRMED:"修复中·底部未确认",
  DISTRIBUTION_RISK:"分化/分配风险",BASE_BUILDING:"筑底修复",UNCERTAIN:"周期未确认",
  ADVANCING:"短期推进",PULLBACK_BUILDING:"回调正在形成",DECLINING:"短期下行",
  REBOUND_BUILDING:"反弹正在形成",DIVERGING:"市场分化",BALANCED:"均衡"
}[v??""]??v??"—");
const age=(ms?:number)=>typeof ms!=="number"?"—":ms<3600000?String(Math.max(0,Math.round(ms/60000)))+" 分钟":(ms/3600000).toFixed(1)+" 小时";
const side=(v:string)=>v==="LONG"?"做多":"做空";
const clock=(v?:number)=>v?new Date(v).toLocaleTimeString("zh-CN",{timeZone:"Asia/Vientiane",hour12:false}):"—";

export default function MarketIntelligenceExecution({data,now:_,liveEnabled,liveOverview}:{
  data:View|null;now:number;liveEnabled:boolean;liveOverview?:{operational:boolean;lastSyncAt:number|null;positionCount:number};
}){
  const mi=data?.marketIntelligence,n=mi?.narrative,evidence=mi?.evidence??[],symbols=mi?.symbols??[],
    opportunities=[...(data?.opportunities??[])].sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.score-a.score),
    positions=data?.positions??[];
  return <div className="fr-execution-page">
    <section className="fr-page-title"><small>MARKET INTELLIGENCE V1</small><h1>实时市场理解与决策</h1>
      <p>系统持续分析整个市场的共同运动、分化、相关组、相对残差和跨交易所共识。细节实时更新，但只有持续证据才会改变市场叙事。</p></section>

    <section className="fr-stats">
      <article><small>超大周期</small><strong>{bias(n?.macro.bias)}</strong><p>{phase(n?.macro.phase)} · 已维持 {age(n?.macro.ageMs)}</p></article>
      <article><small>大方向</small><strong>{bias(n?.major.bias)}</strong><p>置信 {fmt((n?.major.confidence??0)*100,0)}% · 已维持 {age(n?.major.ageMs)}</p></article>
      <article><small>短期优势</small><strong>{bias(n?.short.bias)}</strong><p>{phase(n?.short.phase)} · 预计 {n?.expectedShortMinutes?.[0]??"—"}–{n?.expectedShortMinutes?.[1]??"—"} 分钟</p></article>
      <article><small>尾部风险</small><strong>{n?.tailRisk.level==="HIGH"?"高":n?.tailRisk.level==="MEDIUM"?"中":"低"}</strong><p>风险强度 {fmt(n?.tailRisk.score,0)} / 100</p></article>
    </section>
    <p className="fr-note">数据覆盖：5m市场 {mi?.coverage?.intradayMarkets??0} · 日线市场 {mi?.coverage?.dailyMarkets??0} · 有实时跨所报价 {mi?.coverage?.quoteMarkets??0} · 多交易所共同确认 {mi?.coverage?.multiVenueMarkets??0}。超大周期至少需要3个真实日线市场才会开始形成牛熊判断。</p>

    <section className="fr-section">
      <div className="fr-section-head"><div><small>CURRENT NARRATIVE</small><h2>系统现在如何理解市场</h2></div><span>{clock(mi?.updatedAt)}</span></div>
      <div className="fr-insight"><span className="fr-dot"/><p>{n?.summary??"正在建立市场基线。"}</p></div>
      <div className="fr-three">
        <div><small>超大周期解释</small><b>{n?.macro.detail??"—"}</b></div>
        <div><small>大方向解释</small><b>{n?.major.detail??"—"}</b></div>
        <div><small>短期解释</small><b>{n?.short.detail??"—"}</b></div>
      </div>
      <p className="fr-note"><b>市场变化猜测：</b>{n?.transition.detail??"—"} · 压力 {fmt(n?.transition.pressure,0)}/100</p>
      <p className="fr-note"><b>风险背景：</b>{n?.tailRisk.detail??"—"}</p>
      <p className="fr-trade-reason"><b>当前计划：</b>{n?.plan??"继续观察。"}</p>
    </section>

    <section className="fr-section">
      <div className="fr-section-head"><div><small>LIVE EVIDENCE</small><h2>系统刚刚发现的细节</h2></div><span>{evidence.length} 条有效证据</span></div>
      {evidence.length?<div className="fr-journal">{evidence.slice(0,12).map(e=><article key={e.id}><time>{clock(e.at)}</time>
        <div><b>{e.direction==="BULLISH"?"偏多细节":e.direction==="BEARISH"?"偏空细节":"分化细节"} · {fmt(e.severity*100,0)}</b><p>{e.summary}</p></div></article>)}</div>
        :<p className="fr-note">当前没有足够持续的新细节改变市场理解。</p>}
    </section>

    <section className="fr-section">
      <div className="fr-section-head"><div><small>RELATIVE MAP</small><h2>全市场异类与相关组</h2></div><span>{mi?.clusters?.length??0} 个动态相关组</span></div>
      {symbols.length?<div className="fr-scoreboard">{symbols.slice(0,16).map((s,index)=><details className="fr-score-row" key={s.symbol}>
        <summary><span className="fr-score-rank">#{index+1}</span><span className="fr-score-value">{fmt(s.watchScore,0)}</span>
          <span className="fr-score-symbol"><b>{s.symbol.replace("_"," / ")}</b><small>{s.regime} · {s.clusterId.replace("corr:","组 ")}</small></span>
          <span><small>多头适配</small><b>{fmt(s.longScore,0)}</b></span><span><small>空头适配</small><b>{fmt(s.shortScore,0)}</b></span>
          <em>{s.residual>=0?"强于理论 +"+fmt(s.residual*100,2)+"%":"弱于理论 "+fmt(s.residual*100,2)+"%"}</em></summary>
        <div className="fr-score-details"><div><h3>相对关系</h3><div className="fr-score-detail-grid">
          <span><small>与市场相关</small><b>{fmt(s.correlation*100,0)}%</b></span><span><small>残差持续</small><b>{fmt(s.residualPersistence*100,0)}%</b></span>
          <span><small>跨所数据</small><b>{s.sourceCount} 路</b></span><span><small>数据可信</small><b>{fmt(s.dataConfidence,0)}</b></span>
        </div></div></div></details>)}</div>:<p className="fr-note">等待足够的全市场完成K线建立相对关系。</p>}
    </section>

    <section className="fr-section">
      <div className="fr-section-head"><div><small>TRADE HYPOTHESES</small><h2>当前交易假设</h2></div><span>{opportunities.filter(o=>o.eligible).length} 个可参与</span></div>
      {opportunities.length?<div className="fr-scoreboard">{opportunities.slice(0,12).map((o,index)=><details className={"fr-score-row "+(o.eligible?"is-eligible":"")} key={o.id}>
        <summary><span className="fr-score-rank">#{index+1}</span><span className="fr-score-value">{fmt(o.score,0)}</span>
          <span className="fr-score-symbol"><b>{o.symbol.replace("_"," / ")}</b><small>{side(o.side)} · {o.mode}</small></span>
          <span><small>净空间</small><b>{fmt(o.netRemainingSpaceRate*100,2)}%</b></span><span><small>空间/回撤</small><b>{fmt(o.edgeRatio,2)}×</b></span>
          <em>{o.eligible?"主候选":"观察"}</em></summary>
        <div className="fr-score-details"><p>{o.thesisSummary??o.reason}</p><p><b>失效：</b>{o.invalidationSummary??"按独立交易假设与结构止损退出。"}</p></div></details>)}</div>
        :<p className="fr-note">当前没有形成可执行的独立交易假设。</p>}
    </section>

    <section className="fr-section">
      <div className="fr-section-head"><div><small>OPEN THESES</small><h2>持仓自己的理由</h2></div><span>{positions.length} 笔</span></div>
      {positions.length?<div className="fr-journal">{positions.map(t=><article key={t.id}><time>{side(t.side)}</time><div><b>{t.symbol.replace("_"," / ")} · 持仓评分 {fmt(t.holdScore,0)}</b>
        <p>{t.entryContext?.thesisSummary??t.entryContext?.reason??"历史兼容持仓"}</p><p>失效条件：{t.entryContext?.invalidationSummary??"沿用冻结的历史退出规则。"}</p></div></article>)}</div>
        :<p className="fr-note">当前没有持仓。系统仍会持续更新市场叙事和异类候选。</p>}
    </section>

    <section className="fr-section"><div className="fr-section-head"><h2>实盘执行链</h2><span>{liveEnabled?"已请求开启":"关闭"}</span></div>
      <p className="fr-note">策略只生成标准 PAPER 源单；现有串行 PAPER→LIVE→Gate 复制链保持独立。实盘运行 {liveOverview?.operational?"正常":"未运行"}，当前 {liveOverview?.positionCount??"—"} 笔。</p></section>
  </div>;
}
