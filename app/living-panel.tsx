"use client";

import {memo,useRef,useState} from "react";
import {operatorRequest,type AuthSession} from "../lib/operator-ui.ts";
import {type forwardSummary} from "../lib/forward-relations.ts";
import {useBrain,MODE_LABEL,STATE_LABEL,CAPITAL_LABEL,EMOTION_LABEL,DECISION_LABEL,BRAIN_EXIT,bj,pct,sideCn,coinName,plain,
  type BrainMode,type BrainStatus} from "../lib/brain-view.ts";
import {Coin,safePnl,held,signed,tone,stamp,clock,legacyMarketLine} from "./market-intelligence-execution.tsx";
import {exitShort} from "./order-card.tsx";
import PanelStamp from "./panel-stamp.tsx";
import {SchemeSummary,Ranked,Families,GateLog,PoolTrades,ForecastRecord,ResearchDetail,dynOf,labelsOf,pc} from "./dynamic-panel.tsx";
import "./market-brain.css";
import "./brain-scheme.css";

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
  const s=panel.value;
  const setMode=async(mode:BrainMode)=>{
    if(submitting.current||busy)return;submitting.current=true;setBusy(true);
    try{panel.set(await operatorRequest<BrainStatus>("/api/living/mode","POST",{mode}));setError(null);}
    catch(e){setError(e instanceof Error?e.message:"切换失败");}
    finally{submitting.current=false;setBusy(false);}
  };
  const setItem=async(key:string,on:boolean)=>{
    if(submitting.current||busy)return;submitting.current=true;setBusy(true);
    try{panel.set(await operatorRequest<BrainStatus>("/api/living/mode","POST",{items:{[key]:on}}));setError(null);}
    catch(e){setError(e instanceof Error?e.message:"切换失败");}
    finally{submitting.current=false;setBusy(false);}
  };
  return <BrainBody s={s} data={data} now={now} liveEnabled={liveEnabled} liveOverview={liveOverview} healthy={healthy} systemStatus={systemStatus}
    feedAt={feedAt} floating={floating} onOpenOrders={onOpenOrders} busy={busy} error={error} stamp={{at:panel.at,refreshing:panel.refreshing,failed:panel.failed}}
    setMode={m=>void setMode(m)} setItem={(k,on)=>void setItem(k,on)}/>;
}
type BodyProps={s:BrainStatus|null|undefined;data?:View|null;now?:number;liveEnabled?:boolean;liveOverview?:LiveOverview;healthy?:boolean;systemStatus?:string;
  feedAt?:number|null;floating?:number|null;onOpenOrders?:()=>void;busy:boolean;error:string|null;stamp:{at:number|null;refreshing:boolean;failed:boolean};
  setMode:(m:BrainMode)=>void;setItem:(key:string,on:boolean)=>void};
/** The page itself (pure; the screenshot harness and tests render it with a fixture). dynamic-v1.4 layout: the one scheme first
 * (summary, ranked playbooks, holdings, gate decisions, pool trades, families), the older read-outs folded under 旧系统/只记录. */
export function BrainBody({s,data=null,now=0,liveEnabled=false,liveOverview,healthy,systemStatus,feedAt,floating,onOpenOrders,busy,error,stamp:st,setMode,setItem}:BodyProps){
  const m=s?.market,sc=s?.selfCheck,pool=s?.pool;
  const htfItem=s?.items.find(i=>i.key==="htfTrend");
  const positions=[...(data?.positions??[])].filter(t=>!t.inverseCopy);
  const why=new Map((s?.positions??[]).map(p=>[p.id,p]));
  const poolPos=new Map((pool?.open??[]).map(p=>[p.id,p]));
  const labels=labelsOf(s?dynOf(s):null);
  const clockNow=now||data?.updatedAt||0;
  const liveText=!liveEnabled?"关闭":liveOverview?.operational?"运行中":"核对中";
  const board=s?.board??[];
  const otherRecent=[...(data?.history??[])].filter(t=>!t.inverseCopy&&!pool?.recent.some(x=>x.id===t.id)).sort((a,b)=>(b.closedAt??0)-(a.closedAt??0)).slice(0,5);
  return <div className="mb pg-exec bs" data-testid="owner-living-research">
    {s?<SchemeSummary s={s} pool={pool} busy={busy} onToggle={on=>setItem("dynAllocator",on)} liveEnabled={liveEnabled}/>
      :<section className="pg-card bs-scheme" data-testid="brain-scheme"><strong className="pg-title">{st.failed?"读取失败":"读取中"}</strong><p className="mb-hint">正在读取研究层……</p></section>}
    {error&&<p className="mb-hint mb-warn" role="alert">{error}</p>}
    <PanelStamp at={st.at} refreshing={st.refreshing} failed={st.failed}/>

    <div className="pg-tiles" data-testid="execution-status">
      <div><small>实盘</small><b className={liveEnabled&&liveOverview?.operational?"fr-positive":undefined}>{liveText}</b><p>{!liveEnabled?"只跑模拟，不下单":`实盘持仓 ${liveOverview?.positionCount??0} 笔`}</p></div>
      <div><small>模拟持仓</small><b>{data?`${positions.length} 笔`:"—"}</b><p className={tone(floating)}>{positions.length?`浮动 ${signed(floating)} U`:"空仓"}</p></div>
      <div><small>系统</small><b className={healthy?"fr-positive":healthy===false?"fr-negative":undefined}>{systemStatus??"—"}</b><p>行情 {clock(feedAt)}</p></div>
    </div>

    {s&&<Ranked s={s}/>}

    <section className="pg-section" data-testid="execution-positions">
      <h2>正在持仓<small>{positions.length} 笔{pool?` · 打法池 ${pool.open.length}/${pool.max}`:""}</small></h2>
      {positions.length?<div className="pg-list">{positions.map(t=>{const pnl=safePnl(t),b=why.get(t.id),pp=poolPos.get(t.id),u=typeof pnl==="number"&&Number.isFinite(pnl);return <article className="pg-row" key={t.id}>
        <div className="oc-line"><Coin symbol={t.symbol} side={t.side}/><b className={`oc-pnl ${tone(pp?.move??pnl)}`}>{pp?pc(pp.move):`${signed(pnl)} U`}</b></div>
        <div className="oc-line oc-sub"><span>{pp?labels.get(pp.pb)??b?.playbook??pp.pb:b?.playbook??"老流程"} · 已拿 {held(t.openedAt,clockNow)||"—"}{pp?.risk!=null?` · 风险 ${(pp.risk*100).toFixed(2)}%`:""}{pp&&u?` · ${signed(pnl)} U`:""}</span></div>
        {b?.story&&<p className="pg-watch"><b>为什么开</b>{b.story}</p>}
        <p className="pg-watch"><b>为什么还拿着</b>{b?.hold??"—"}</p>
        <p className="pg-plan">{b?.invalidation!=null&&b.invalidation!==(b?.stop??t.stopPrice)?`错了的标志：${plain(b.invalidation)} · `:""}错了就走：止损 {plain(b?.stop??t.stopPrice)}{b?.evidence?` · ${b.evidence}`:""}</p>
      </article>;})}</div>:<div className="pg-empty">现在空仓。{s?.items.find(i=>i.key==="dynAllocator")?.on?"预测看好的打法出现信号时会开。":"开关 10 关着，只记录。"}</div>}
    </section>

    {s&&<GateLog s={s} pool={pool}/>}
    {s&&<PoolTrades s={s} pool={pool} onOpenOrders={onOpenOrders}/>}
    {s&&<Families s={s}/>}

    <section className="pg-section mb-folds">
    {s&&<ForecastRecord s={s}/>}
    {s&&<details className="mb-fold"><summary>开关与模式（{MODE_LABEL[s.mode]}）</summary>
      <p className="mb-hint">{s.items.map(i=>`${i.label}${i.on?"✓":"✗"}`).join("　")}</p>
      {s.htf&&<p className="mb-hint">{htfLine(s.htf)}</p>}
      {htfItem&&<div className="fr-owner-session"><button className="fr-text-button" type="button" disabled={busy}
        onClick={()=>setItem("htfTrend",!htfItem.on)}>{htfItem.on?"关掉 9 日线突破做多（已开的单继续按止损/跟踪管）":"打开 9 日线突破做多"}</button></div>}
      <p className="mb-hint">{s.version} · 一篮子 {s.basket} 个币 · 资金数据 {s.flowSymbols??0} 个 · 报价 {bj(s.lastFeedAt)} · 每轮 {s.cpu.planMs}ms · 今天写入 {s.writesToday} 次</p>
      <div className="fr-owner-session">{(["off","compute-only","paper-enabled"] as BrainMode[]).map(x=><button key={x} className={x===s.configured?"fr-button":"fr-text-button"} type="button"
        disabled={busy||x===s.configured} onClick={()=>setMode(x)}>{MODE_LABEL[x]}</button>)}</div>
      <p className="mb-hint">只作用于模拟账户；实盘开关不受这里影响。</p>
    </details>}
    {s&&<details className="mb-fold"><summary>研究细节（历史下载、BTC/ETH 状态、每套打法的周期、规则）</summary><ResearchDetail s={s}/></details>}

    <details className="mb-fold mb-legacy" data-testid="brain-legacy"><summary>旧系统 / 只记录（不再决定开单）</summary>
      <p className="mb-hint">下面是旧的市场意图、每个币的资金/情绪读数、等位置、集体异动和老流程的决定。数据照常记录，只是不再决定开不开单。</p>
      {s&&<div className={`mb-state mb-${(m?.state??"WARMING").toLowerCase()}`} data-testid="brain-market">
        <p className="mb-hint"><b>旧市场意图：{m?STATE_LABEL[m.state]??m.state:"读取中"}{m?.side?` · 偏${sideCn(m.side)}`:""}</b> · {fastBadge(s.fast)}{m?` · 把握 ${Math.round(m.confidence*100)}%`:""}</p>
        {m?.sentence&&<p className="mb-hint">{m.sentence}</p>}
        {m&&<p className="mb-hint">旧流程能做：{m.allowed.length?m.allowed.map(a=>`${a.label}${a.side?sideCn(a.side):""}`).join("、"):"不开新单"}</p>}
        {m?.restored&&<p className="mb-hint">这是重启前最后一次判断，正在用最新行情重读。</p>}
      </div>}
      {s&&!!board.length&&<details className="mb-more"><summary>每个币在发生什么（{board.length}）</summary><div className="mb-board" data-testid="brain-board">{board.map(c=><Read key={c.symbol} c={c}/>)}</div></details>}
      {s&&!!s.watches.length&&<details className="mb-more"><summary>在等位置（{s.watches.length}）</summary>
        <ul className="mb-list">{s.watches.map((w,i)=><li key={i}><b>{coinName(w.symbol)} {sideCn(w.side)} · {w.pb}{w.zone?` · 等 ${plain(w.zone[0])}–${plain(w.zone[1])}`:""}</b>
          {w.why&&<span>{w.why}</span>}<span>{w.invalidation!=null?`到 ${plain(w.invalidation)} 就不做 · `:""}{bj(w.expiresAt)} 过期</span></li>)}</ul></details>}
      {s&&<details className="mb-more"><summary>全部决定（{s.decisions?.length??0}）</summary>
        {!s.decisions?.length?<p className="mb-hint">还没有决定。</p>:<ol className="mb-list">{s.decisions.map((d,i)=>{const k=String(d.k);return <li key={i}>
          <b>{bj(d.at as number)} {DECISION_LABEL[k]??k}{d.sym?` · ${coinName(String(d.sym))}`:""}{d.side?` ${sideCn(String(d.side))}`:""}</b>
          <span>{plain(d.story??d.reason??d.why??d.sentence??"")}</span></li>;})}</ol>}
      </details>}
      {s&&<details className="mb-more"><summary>集体异动与判断变化</summary>
        <p className="mb-hint">{s.fast.flow?`资金：${s.fast.flow.real===true?"真钱在动":s.fast.flow.real===false?"只有价格在动，资金没跟":"资金未核实"}（${s.fast.flow.kind}）`:"没有正在进行的集体异动。"}{s.fast.reason?` ${s.fast.reason}`:""}</p>
        <p className="mb-hint">已记录 {s.fast.episodes} 段{s.fast.surges7d!=null?`，只有价格没资金 ${s.fast.surges7d} 次`:""}。集体异动 {sc?.fast.alerts??0} 段：确认 {sc?.fast.confirmed??0}，假动作 {sc?.fast.fake??0}。</p>
        {!!sc?.byPlaybook.length&&<p className="mb-hint">{sc.byPlaybook.map(b=>`${b.label} ${b.n} 笔 胜率 ${Math.round(b.winRate*100)}% 平均 ${b.avgR.toFixed(2)}R`).join("；")}</p>}
        {!!s.probes?.length&&<p className="mb-hint">近期表现只调仓位（0.7–1.2 倍）：{s.probes.map(p=>`${p.label}×${p.modulator}`).join("，")}</p>}
        {!!s.marketTimeline?.length&&<ol className="mb-list">{[...s.marketTimeline].reverse().map((x,i)=><li key={i}><b>{bj(x.at)} {STATE_LABEL[x.state]??x.state}{x.side?` 偏${sideCn(x.side)}`:""}</b><span>{x.sentence}</span></li>)}</ol>}
      </details>}
      {!!otherRecent.length&&<details className="mb-more"><summary>其他最近平仓（{otherRecent.length}）</summary><div className="pg-recent">{otherRecent.map(t=><div key={t.id}>
        <span><Coin symbol={t.symbol} side={t.side}/><small>{exitText(t)} · {stamp(t.closedAt)}</small></span>
        <strong className={tone(t.netPnl)}>{signed(t.netPnl)} U<small>{held(t.openedAt,t.closedAt)}</small></strong>
      </div>)}</div></details>}
      {data&&<p className="mb-hint">{legacyMarketLine(data)}</p>}
    </details>
    </section>
  </div>;
}
function htfLine(h:NonNullable<BrainStatus["htf"]>){
  const l=h.last,reg=l?(l.regime==="ON"?"BTC 在 100 日均线上":l.regime==="OFF"?"BTC 在 100 日均线下（不做）":"BTC 均线算不出"):"";
  const head=l?`${l.day} 检查：${reg}（${l.btc??"-"} / ${l.sma??"-"}），突破 ${l.breakouts.length} 个，选中 ${l.picks.map(coinName).join("、")||"无"}`:"今天还没检查";
  const wait=h.pending.length?`，等开 ${h.pending.map(x=>coinName(x.sym)).join("、")}`:"";
  return `日线突破做多：${head}；持有 ${h.open}/${h.maxOpen} 笔${wait}`;
}
function Read({c}:{c:NonNullable<BrainStatus["board"]>[number]}){
  return <article className={c.action?"is-act":""}>
    <header><b>{coinName(c.symbol)}</b><i>{CAPITAL_LABEL[c.capital]??c.capital}</i>{c.emotion!=="NONE"&&<i>{EMOTION_LABEL[c.emotion]??c.emotion}</i>}</header>
    <p>{c.why}</p>
    <small>15分 {pct(c.ev.p15)} · 持仓量 {pct(c.ev.oi15,1)} · 资金费 {pct(c.ev.funding,3)}{c.ev.vol15!=null?` · 量 ${c.ev.vol15.toFixed(1)}倍`:""}</small>
    <p className={c.action?"mb-act":"mb-act mb-no"}>{c.action?`→ ${c.action.label}（${sideCn(c.action.side)}）`:`不做：${c.noTrade??"没有清楚的意图"}`}</p>
  </article>;
}
