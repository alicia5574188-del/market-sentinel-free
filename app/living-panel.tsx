"use client";

import {memo,useRef,useState} from "react";
import {operatorRequest,type AuthSession} from "../lib/operator-ui.ts";
import {type forwardSummary} from "../lib/forward-relations.ts";
import {useBrain,MODE_LABEL,STATE_LABEL,CAPITAL_LABEL,EMOTION_LABEL,DECISION_LABEL,BRAIN_EXIT,bj,pct,sideCn,coinName,plain,
  type BrainMode,type BrainStatus} from "../lib/brain-view.ts";
import {Coin,safePnl,held,signed,tone,stamp,clock,legacyMarketLine} from "./market-intelligence-execution.tsx";
import {exitShort} from "./order-card.tsx";
import PanelStamp from "./panel-stamp.tsx";
import "./market-brain.css";

type View=ReturnType<typeof forwardSummary>;
type Trade=View["positions"][number];
type LiveOverview={operational:boolean;lastSyncAt:number|null;positionCount:number};
const fastBadge=(f:BrainStatus["fast"]|undefined)=>!f||f.state==="CALM"?"集体异动：平静":`集体异动：${f.side==="LONG"?"普涨":"普跌"} ${f.state==="ALERT"?"警报":f.state==="CONFIRMED"?"已确认":f.state}`;
const exitText=(t:Trade)=>{const code=t.exitReason??"";const why=t.exitAudit?.evidence?.reason;
  // the engine's own sentence already says it in brain terms; the code label is the fallback
  if(BRAIN_EXIT[code])return typeof why==="string"&&why?why.slice(0,70):BRAIN_EXIT[code];
  return exitShort(code,"已平仓");};

/** Owner home (大脑): what the market is doing (capital and human nature), the account at a glance, what is held and why,
 * what was closed and why. Cached on the device and shown at once; refreshed in the background every 30s while visible.
 * Paper only; the live switch is never touched here. */
type LivingProps={auth:AuthSession|null;scope?:string;data?:View|null;now?:number;liveEnabled?:boolean;liveOverview?:LiveOverview;
  healthy?:boolean;systemStatus?:string;feedAt?:number|null;floating?:number|null;onOpenOrders?:()=>void};
const tradeKey=(t:Trade)=>`${t.id}|${t.status}|${t.lastPrice}|${t.quantity}|${t.netPnl}|${t.closedAt}|${t.stopPrice}|${t.exitReason}`;
/** Redraw the home panel only when something it shows changed: the open/closed trades it lists, the tiles, or the
 * minute of the page clock (held times are in minutes). The brain read itself updates through its own hook. */
export function sameLivingProps(a:LivingProps,b:LivingProps){
  if(a.auth!==b.auth||a.scope!==b.scope||a.liveEnabled!==b.liveEnabled||a.healthy!==b.healthy||a.systemStatus!==b.systemStatus
    ||a.floating!==b.floating||Math.floor((a.feedAt??0)/60_000)!==Math.floor((b.feedAt??0)/60_000)
    ||Math.floor((a.now??0)/60_000)!==Math.floor((b.now??0)/60_000))return false;
  const lo=(o?:LiveOverview)=>o?`${o.operational}|${o.positionCount}|${o.lastSyncAt}`:"";
  if(lo(a.liveOverview)!==lo(b.liveOverview))return false;
  if(!!a.data!==!!b.data)return false;
  const rows=(d?:View|null)=>d?`${(d.positions??[]).map(tradeKey).join(";")}#${(d.history??[]).length}:${(d.history??[]).slice(-1).concat((d.history??[]).slice(0,1)).map(tradeKey).join(";")}`:"";
  return rows(a.data)===rows(b.data);
}
export default memo(LivingPanel,sameLivingProps);
function LivingPanel({auth,scope="owner",data=null,now=0,liveEnabled=false,liveOverview,healthy,systemStatus,feedAt,floating,onOpenOrders}:{
  auth:AuthSession|null;scope?:string;data?:View|null;now?:number;liveEnabled?:boolean;liveOverview?:LiveOverview;
  healthy?:boolean;systemStatus?:string;feedAt?:number|null;floating?:number|null;onOpenOrders?:()=>void;
}){
  const owner=Boolean(auth?.authenticated&&auth.username==="owner"&&!auth.memberId&&auth.role!=="member");
  const panel=useBrain(scope,owner);
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const submitting=useRef(false);
  if(!owner)return null;
  const s=panel.value,m=s?.market,sc=s?.selfCheck;
  const setMode=async(mode:BrainMode)=>{
    if(submitting.current||busy)return;submitting.current=true;setBusy(true);
    try{panel.set(await operatorRequest<BrainStatus>("/api/living/mode","POST",{mode}));setError(null);}
    catch(e){setError(e instanceof Error?e.message:"切换失败");}
    finally{submitting.current=false;setBusy(false);}
  };
  const positions=[...(data?.positions??[])].filter(t=>!t.inverseCopy);
  const recent=[...(data?.history??[])].filter(t=>!t.inverseCopy).sort((a,b)=>(b.closedAt??0)-(a.closedAt??0)).slice(0,5);
  const why=new Map((s?.positions??[]).map(p=>[p.id,p]));
  const clockNow=now||data?.updatedAt||0;
  const liveText=!liveEnabled?"关闭":liveOverview?.operational?"运行中":"核对中";
  const board=s?.board??[];
  const warming=!m||m.state==="WARMING";
  return <div className="mb pg-exec" data-testid="owner-living-research">
    <section className={`pg-card mb-state mb-${(m?.state??"WARMING").toLowerCase()}`} data-testid="brain-market">
      <header><small>现在的市场</small><span className="mb-badge">{fastBadge(s?.fast)}</span></header>
      <strong className="pg-title">{m?STATE_LABEL[m.state]??m.state:panel.failed?"读取失败":"读取中"}{m?.side?` · 偏${sideCn(m.side)}`:""}</strong>
      <p className="mb-sentence">{m?.sentence??(s?"行情刚接上，一两分钟内给出第一句判断。":"正在读取研究层……")}</p>
      {m&&<div className="pg-chips">
        <span className="pg-chip"><small>把握</small>{Math.round(m.confidence*100)}%</span>
        <span className="pg-chip mb-allowed"><small>能做</small>{m.allowed.length?m.allowed.map(a=>`${a.label}${a.side?sideCn(a.side):""}`).join("、"):"现在不开新单"}</span>
      </div>}
      {m?.restored&&<p className="mb-hint">这是重启前最后一次判断，正在用最新行情重读。</p>}
      {!m?.restored&&warming&&s?.loadedAt?<p className="mb-hint">刚重启（{bj(s.loadedAt)}），在补数据。</p>:null}
      {s?.fallback&&<p className="mb-hint mb-warn">自动降级为只计算（到 {bj(s.fallback.until)}）：{s.fallback.reason}</p>}
      {error&&<p className="mb-hint mb-warn" role="alert">{error}</p>}
      <PanelStamp at={panel.at} refreshing={panel.refreshing} failed={panel.failed}/>
    </section>

    <div className="pg-tiles" data-testid="execution-status">
      <div><small>实盘</small><b className={liveEnabled&&liveOverview?.operational?"fr-positive":undefined}>{liveText}</b><p>{!liveEnabled?"只跑模拟，不下单":`实盘持仓 ${liveOverview?.positionCount??0} 笔`}</p></div>
      <div><small>模拟持仓</small><b>{data?`${positions.length} 笔`:"—"}</b><p className={tone(floating)}>{positions.length?`浮动 ${signed(floating)} U`:"空仓"}</p></div>
      <div><small>系统</small><b className={healthy?"fr-positive":healthy===false?"fr-negative":undefined}>{systemStatus??"—"}</b><p>行情 {clock(feedAt)}</p></div>
    </div>

    <section className="pg-section" data-testid="execution-positions">
      <h2>正在持仓<small>{positions.length} 笔</small></h2>
      {positions.length?<div className="pg-list">{positions.map(t=>{const pnl=safePnl(t),b=why.get(t.id);return <article className="pg-row" key={t.id}>
        <div className="oc-line"><Coin symbol={t.symbol} side={t.side}/><b className={`oc-pnl ${tone(pnl)}`}>{signed(pnl)} U</b></div>
        <div className="oc-line oc-sub"><span>{b?.playbook??"老流程"} · 已拿 {held(t.openedAt,clockNow)||"—"}</span></div>
        {b?.story&&<p className="pg-watch"><b>为什么开</b>{b.story}</p>}
        <p className="pg-watch"><b>为什么还拿着</b>{b?.hold??"—"}</p>
        <p className="pg-plan">{b?.invalidation!=null&&b.invalidation!==(b?.stop??t.stopPrice)?`错了的标志：${plain(b.invalidation)} · `:""}错了就走：止损 {plain(b?.stop??t.stopPrice)}{b?.evidence?` · ${b.evidence}`:""}</p>
      </article>;})}</div>:<div className="pg-empty">现在空仓。{m&&m.allowed.length?"市场允许的打法出现位置时会开。":"市场意图不清楚，不开新单。"}</div>}
    </section>

    <section className="pg-section" data-testid="execution-recent">
      <h2>最近平仓<small>最新 {recent.length} 笔</small></h2>
      {recent.length?<div className="pg-recent">{recent.map(t=><div key={t.id}>
        <span><Coin symbol={t.symbol} side={t.side}/><small>{exitText(t)} · {stamp(t.closedAt)}</small></span>
        <strong className={tone(t.netPnl)}>{signed(t.netPnl)} U<small>{held(t.openedAt,t.closedAt)}</small></strong>
      </div>)}</div>:<div className="pg-empty">还没有已平订单。</div>}
      {onOpenOrders&&<button type="button" className="pg-link" onClick={onOpenOrders}>查看全部模拟订单 →</button>}
    </section>

    {s&&<section className="pg-section" data-testid="brain-board">
      <h2>每个币在发生什么<small>{board.length}</small></h2>
      {!board.length?<div className="pg-empty">还没有币的读数。</div>:<div className="mb-board">{board.slice(0,6).map(c=><Read key={c.symbol} c={c}/>)}</div>}
      {board.length>6&&<details className="mb-more"><summary>再看 {board.length-6} 个</summary><div className="mb-board">{board.slice(6).map(c=><Read key={c.symbol} c={c}/>)}</div></details>}
    </section>}

    {s&&!!s.watches.length&&<section className="pg-section">
      <h2>在等位置<small>{s.watches.length}</small></h2>
      <ul className="mb-list">{s.watches.map((w,i)=><li key={i}><b>{coinName(w.symbol)} {sideCn(w.side)} · {w.pb}{w.zone?` · 等 ${plain(w.zone[0])}–${plain(w.zone[1])}`:""}</b>
        {w.why&&<span>{w.why}</span>}<span>{w.invalidation!=null?`到 ${plain(w.invalidation)} 就不做 · `:""}{bj(w.expiresAt)} 过期</span></li>)}</ul>
    </section>}

    <section className="pg-section mb-folds">
    {s&&<details className="mb-fold"><summary>最近的决定（{s.decisions?.length??0}）</summary>
      {!s.decisions?.length?<p className="mb-hint">还没有决定。</p>:<ol className="mb-list">{s.decisions.map((d,i)=>{const k=String(d.k);return <li key={i}>
        <b>{bj(d.at as number)} {DECISION_LABEL[k]??k}{d.sym?` · ${coinName(String(d.sym))}`:""}{d.side?` ${sideCn(String(d.side))}`:""}</b>
        <span>{plain(d.story??d.reason??d.why??d.sentence??"")}</span></li>;})}</ol>}
    </details>}

    {s&&<details className="mb-fold"><summary>集体异动与判断变化</summary>
      <p className="mb-hint">{s.fast.flow?`资金：${s.fast.flow.real===true?"真钱在动":s.fast.flow.real===false?"只有价格在动，资金没跟":"资金未核实"}（${s.fast.flow.kind}）`:"没有正在进行的集体异动。"}{s.fast.reason?` ${s.fast.reason}`:""}</p>
      <p className="mb-hint">已记录 {s.fast.episodes} 段{s.fast.surges7d!=null?`，只有价格没资金 ${s.fast.surges7d} 次`:""}。</p>
      {!!s.marketTimeline?.length&&<ol className="mb-list">{[...s.marketTimeline].reverse().map((x,i)=><li key={i}><b>{bj(x.at)} {STATE_LABEL[x.state]??x.state}{x.side?` 偏${sideCn(x.side)}`:""}</b><span>{x.sentence}</span></li>)}</ol>}
    </details>}

    {s&&<details className="mb-fold"><summary>自检与开关（{MODE_LABEL[s.mode]}）</summary>
      <p className="mb-hint">集体异动 {sc?.fast.alerts??0} 段：确认 {sc?.fast.confirmed??0}，假动作 {sc?.fast.fake??0}。</p>
      {!!sc?.byPlaybook.length&&<p className="mb-hint">{sc.byPlaybook.map(b=>`${b.label} ${b.n} 笔 胜率 ${Math.round(b.winRate*100)}% 平均 ${b.avgR.toFixed(2)}R`).join("；")}</p>}
      {!!s.probes?.length&&<p className="mb-hint">近期表现只调仓位（0.7–1.2 倍）：{s.probes.map(p=>`${p.label}×${p.modulator}`).join("，")}</p>}
      <p className="mb-hint">{s.items.map(i=>`${i.label}${i.on?"✓":"✗"}`).join("　")}</p>
      <p className="mb-hint">{s.version} · 一篮子 {s.basket} 个币 · 资金数据 {s.flowSymbols??0} 个 · 报价 {bj(s.lastFeedAt)} · 每轮 {s.cpu.planMs}ms · 今天写入 {s.writesToday} 次</p>
      <div className="fr-owner-session">{(["off","compute-only","paper-enabled"] as BrainMode[]).map(x=><button key={x} className={x===s.configured?"fr-button":"fr-text-button"} type="button"
        disabled={busy||x===s.configured} onClick={()=>void setMode(x)}>{MODE_LABEL[x]}</button>)}</div>
      <p className="mb-hint">只作用于模拟账户；实盘开关不受这里影响。</p>
    </details>}

    {data&&<details className="mb-fold mb-legacy"><summary>旧系统参考</summary><p className="mb-hint">{legacyMarketLine(data)}</p></details>}
    </section>
  </div>;
}
function Read({c}:{c:NonNullable<BrainStatus["board"]>[number]}){
  return <article className={c.action?"is-act":""}>
    <header><b>{coinName(c.symbol)}</b><i>{CAPITAL_LABEL[c.capital]??c.capital}</i>{c.emotion!=="NONE"&&<i>{EMOTION_LABEL[c.emotion]??c.emotion}</i>}</header>
    <p>{c.why}</p>
    <small>15分 {pct(c.ev.p15)} · 持仓量 {pct(c.ev.oi15,1)} · 资金费 {pct(c.ev.funding,3)}{c.ev.vol15!=null?` · 量 ${c.ev.vol15.toFixed(1)}倍`:""}</small>
    <p className={c.action?"mb-act":"mb-act mb-no"}>{c.action?`→ ${c.action.label}（${sideCn(c.action.side)}）`:`不做：${c.noTrade??"没有清楚的意图"}`}</p>
  </article>;
}
