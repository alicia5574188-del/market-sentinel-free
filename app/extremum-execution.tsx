import type {Trade,forwardSummary} from "../lib/forward-relations.ts";

type View=ReturnType<typeof forwardSummary>;
const fmt=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?v.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}):"—";
const signed=(v:number|null|undefined,d=2)=>typeof v==="number"&&Number.isFinite(v)?`${v>=0?"+":""}${fmt(v,d)}`:"—";
const duration=(start:number,end:number|null|undefined,now:number)=>{const m=Math.floor(Math.max(0,(end??now)-start)/60000);return m<1?"<1分钟":m>=60?`${Math.floor(m/60)}小时${m%60}分`:`${m}分钟`;};
const modeName=(mode:string)=>({SWING:"峰谷反转",TREND_PULLBACK:"趋势回调进攻",IMPULSE:"单边推进追击"}[mode]??mode);
const exitName=(reason:string|null)=>reason?({STRUCTURE_STOP:"结构止损",PROFIT_GIVEBACK:"利润保护",ENTRY_FEEDBACK_FAILED:"入场后未获得正反馈",
  OPPOSITE_EXTREMUM:"相反峰谷确认",TREND_DEATH:"趋势死亡",EXTREMUM_PROFIT_EXIT:"极值利润退出",NO_PROGRESS:"长时间无进展",MAX_HOLD:"最大持仓时间"}[reason]??reason):"—";

export default function ExtremumExecution({data,now}:{data:View|null;now:number}){
  const regime=data?.extremumRegime,rows=regime?.symbols??[],positions=data?.positions??[],
    opportunities=[...(data?.opportunities??[])].sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.score-a.score),
    eligible=opportunities.filter(o=>o.eligible&&(!now||o.expiresAt>now)),
    blockers=Object.entries(data?.entryDiagnostics?.reasons??{}).sort((a,b)=>b[1]-a[1]);
  return <div className="fr-extremum-execution">
    <section className="fr-page-title"><small>EXTREMUM REGIME V1</small><h1>执行</h1>
      <p>同一套状态机完成峰谷确认、趋势进攻、入场后验证和退出。极值决定位置，趋势生命决定止盈还是反手。</p></section>
    <section className="fr-stats">
      <Stat label="趋势多" value={fmt(regime?.counts.trendUp,0)} note="只做回调谷和强势延续，不逆势猜顶"/>
      <Stat label="趋势空" value={fmt(regime?.counts.trendDown,0)} note="只做反弹峰和强势延续，不逆势抄底"/>
      <Stat label="震荡" value={fmt(regime?.counts.swing,0)} note="顶部可做空，底部可做多"/>
      <Stat label="弱化 / 切换" value={fmt((regime?.counts.weakening??0)+(regime?.counts.transition??0),0)} note="先退出旧方向，再等待新方向确认"/>
    </section>
    <section className="fr-section"><div className="fr-section-head"><div><small>REALTIME STATE MACHINE</small><h2>30市场当前状态</h2>
      <p>这些分数不是胜率，只表示当前位置与趋势结构的实时强弱。</p></div><span>{rows.length} 个状态</span></div>
      {rows.length?<div className="fr-rule-grid">{rows.slice(0,30).map(row=><article className="fr-setting" key={row.symbol}><div>
        <h3>{row.symbol.replace("_"," / ")} · {row.regime}</h3><p>{row.nextAction}</p>
        <small>{row.stage} · {row.sourceCount}源 · 分歧 {fmt(row.disagreementRate*100,3)}%</small></div>
        <div className="fr-score-detail-grid"><Metric label="顶部压力" value={fmt(row.topPressure,0)}/><Metric label="底部压力" value={fmt(row.bottomPressure,0)}/>
          <Metric label="上涨生命" value={fmt(row.upSurvival,0)}/><Metric label="下跌生命" value={fmt(row.downSurvival,0)}/></div></article>)}</div>
        :<Empty title="正在建立市场状态" text="5分钟结构不足时不会伪造峰谷或趋势判断。"/>}
    </section>
    <section className="fr-section fr-scoreboard-section"><div className="fr-section-head"><div><small>READY / WATCH</small><h2>当前交易机会</h2>
      <p>只有完成状态事件并通过新鲜Gate盘口、合约规格和风险预算后才会形成订单。</p></div><span>{eligible.length} 可参与</span></div>
      {opportunities.length?<div className="fr-scoreboard">{opportunities.slice(0,16).map((o,index)=><details className={`fr-score-row ${o.eligible?"is-eligible":""}`} key={o.id}>
        <summary><span className="fr-score-rank">#{index+1}</span><span className="fr-score-value">{fmt(o.score,0)}</span>
          <span className="fr-score-symbol"><b>{o.symbol.replace("_"," / ")}</b><small>{o.side==="LONG"?"做多":"做空"} · {modeName(o.mode)}</small></span>
          <span><small>极值压力</small><b>{fmt(o.side==="LONG"?o.bottomPressure:o.topPressure,0)}</b></span>
          <span><small>趋势生命</small><b>{fmt(o.side==="LONG"?o.upSurvival:o.downSurvival,0)}</b></span>
          <span><small>阶段</small><b>{o.confirmationStage??"—"}</b></span><em>{o.eligible?"可参与":"观察"}</em></summary>
        <div className="fr-score-details"><div><h3>执行条件</h3><div className="fr-score-detail-grid">
          <Metric label="净空间" value={`${fmt(o.netRemainingSpaceRate*100,2)}%`}/><Metric label="结构风险" value={`${fmt(o.pullbackRiskRate*100,2)}%`}/>
          <Metric label="空间/风险" value={`${fmt(o.edgeRatio,2)}×`}/><Metric label="多源分歧" value={`${fmt((o.disagreementRate??0)*100,3)}%`}/></div></div><p>{o.reason}</p></div>
      </details>)}</div>:<Empty title="当前没有完成确认的机会" text="系统仍在扫描30个市场；TREND状态会等待回调/反弹或强势延续，SWING状态等待峰谷确认。"/>}
    </section>
    <section className="fr-section"><div className="fr-section-head"><div><small>OPEN LIFECYCLE</small><h2>持仓正在等待什么</h2></div><span>{positions.length} 笔</span></div>
      {positions.length?<div className="fr-position-list">{positions.map(t=><Position key={t.id} trade={t} now={now}/>)}</div>
        :<Empty title="当前没有模拟持仓" text="出现完整确认并通过实时执行检查后才会开仓。"/>}</section>
    {blockers.length>0&&<section className="fr-section"><div className="fr-section-head"><h2>本轮未开仓原因</h2><span>真实执行检查</span></div>
      <div className="fr-rule-grid">{blockers.slice(0,8).map(([reason,count])=><article className="fr-setting" key={reason}><div><h3>{reason}</h3>
        <p>只统计这一轮真正进入执行检查的候选。</p></div><b>{count}</b></article>)}</div></section>}
  </div>;
}

function Position({trade:t,now}:{trade:Trade;now:number}){
  const open=t.status==="OPEN",d=t.side==="LONG"?1:-1,px=open?t.lastPrice:t.exitPrice??t.lastPrice,
    pnl=open?d*t.quantity*(px-t.entryPrice)-t.entryFee-t.quantity*px*.0007:t.netPnl??0,ctx=t.entryContext;
  return <details className="fr-position-row"><summary><span className="fr-position-primary"><b>{t.symbol.replace("_"," / ")}</b>
    <small>{t.side==="LONG"?"多单":"空单"} · {modeName(ctx?.mode??"")} · {fmt(t.leverage,0)}×</small>
    <b className={pnl>=0?"fr-positive":"fr-negative"}>{signed(pnl)} U</b><small>{duration(t.openedAt,t.closedAt,now)}</small></span>
    <span className="fr-position-entry"><b>{open?`趋势生命 ${fmt(t.side==="LONG"?ctx?.upSurvival:ctx?.downSurvival,0)} · 反向极值 ${fmt(t.side==="LONG"?ctx?.topPressure:ctx?.bottomPressure,0)}`:exitName(t.exitReason)}</b>
      <small>MFE {fmt(t.favorable*100,2)}% · MAE {fmt(t.adverse*100,2)}% · 锁利 {fmt((t.profitFloorRate??0)*100,2)}%</small>
      <small>入场验证 {ctx?.postEntryState??"旧仓兼容"} · 阶段 {ctx?.confirmationStage??"—"} · 数据 {ctx?.sourceCount??0}源</small></span></summary>
    <article className="fr-trade fr-trade-unified"><dl><div><dt>入场价</dt><dd>{fmt(t.entryPrice,6)}</dd></div><div><dt>{open?"当前价":"出场价"}</dt><dd>{fmt(px,6)}</dd></div>
      <div><dt>当前防守</dt><dd>{fmt(t.stopPrice,6)}</dd></div><div><dt>名义金额</dt><dd>{fmt(t.notional)} U</dd></div>
      <div><dt>保证金 / 杠杆</dt><dd>{fmt(t.margin)} U / {fmt(t.leverage,0)}×</dd></div><div><dt>计划风险</dt><dd>{fmt(t.plannedRisk)} U</dd></div></dl>
      {ctx&&<p className="fr-trade-reason">入场依据：{ctx.reason}</p>}</article></details>;
}
function Stat({label,value,note}:{label:string;value:string;note:string}){return <article><small>{label}</small><strong>{value}</strong><p>{note}</p></article>;}
function Metric({label,value}:{label:string;value:string}){return <span><small>{label}</small><b>{value}</b></span>;}
function Empty({title,text}:{title:string;text:string}){return <div className="fr-empty"><span>◎</span><h3>{title}</h3><p>{text}</p></div>;}
