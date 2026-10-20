"use client";

import {useCallback,useEffect,useRef,useState} from "react";
import {operatorRequest, type AuthSession} from "../lib/operator-ui.ts";
import "./market-brain.css";

type Mode="off"|"compute-only"|"paper-enabled";
type Side="LONG"|"SHORT";
type Ev={p15?:number|null;oi15?:number|null;oi60?:number|null;funding?:number|null;taker15?:number|null;vol15?:number|null;basis?:number|null};
type Status={version:string;mode:Mode;configured:Mode;acting:boolean;fallback:{at:number;until:number;reason:string}|null;
  items:{key:string;label:string;on:boolean}[];
  market:{state:string;side:Side|null;confidence:number;sentence:string;at:number;ev?:Record<string,unknown>;allowed:{pb:string;label:string;side:Side}[]}|null;
  marketTimeline?:{at:number;state:string;side:Side|null;sentence:string}[];
  board?:{symbol:string;capital:string;emotion:string;crowd:string;strength:number;why:string;action:{pb:string;label:string;side:Side}|null;noTrade:string|null;ev:Ev}[];
  positions?:{id:string;symbol:string;side:Side;entry:number;stop:number;openedAt:number;living:boolean;playbook:string|null;intent:string|null;story:string|null;
    evidence:string|null;invalidation:string|number|null;hold:string|null;holdAt:number|null}[];
  thesis:{sentence:string;structure:string;side:string|null;since:number;playbooks:string[]}|null;
  probes?:{probe:string;label:string;score:number;t:number;n:number;modulator:number}[];
  fast:{state:string;side:Side|null;reason:string|null;flow?:{real:boolean|null;kind:string;why?:string}|null;episodes:number;surges7d?:number;
    last?:{id:string;side:Side;end:string|null;alertAt:number;after15:number|null}[]};
  watches:{symbol:string;side:Side;pb:string;expiresAt:number;reason:string|null;intent?:string|null;why?:string|null;zone?:[number,number];invalidation?:number}[];
  selfCheck?:{byPlaybook:{pb:string;label:string;n:number;winRate:number;avgR:number}[];fast:{alerts:number;fake:number;confirmed:number;follow30:number[]};intentReads:Record<string,number>};
  decisions?:Record<string,unknown>[];
  basket:number;flowSymbols?:number;lastFeedAt:number;flowAt?:number;cpu:{planMs:number;maxPlanMs:number;hubMs:number};writesToday:number;lastError:string|null};

const MODE_LABEL:Record<Mode,string>={"off":"关闭","compute-only":"只计算","paper-enabled":"作用于模拟盘"};
const STATE_LABEL:Record<string,string>={RISK_ON:"资金在进攻",RISK_OFF:"资金在撤退",SQUEEZE:"逼空中",PANIC:"恐慌踩踏",CAPITULATION:"投降式出清",FOMO:"追涨情绪",
  COMPLACENT:"安逸拥挤",CALM:"平静",MIXED:"分歧",WARMING:"数据刚接上"};
const CAPITAL_LABEL:Record<string,string>={DEMAND:"新多进场",SUPPLY:"新空进场",SQUEEZE_UP:"空头被逼平",FLUSH_DOWN:"多头被洗出",ABSORB_BID:"下方有人接",
  ABSORB_ASK:"上方有人压",DRIFT:"无量漂移",UNVERIFIED:"资金未核实",NONE:"无动作"};
const EMOTION_LABEL:Record<string,string>={FOMO:"追涨",PANIC:"恐慌",CAPITULATION:"投降",EXHAUSTION:"力竭",BLOWOFF:"冲顶",COMPLACENCY:"安逸",CONVICTION:"坚定",CALM:"平静",NONE:"—"};
const DECISION_LABEL:Record<string,string>={ENTRY:"开单",ENTRY_RECORD:"本该开单（只记录）",RECORD_ONLY:"只记录",WATCH:"等位置",EXIT:"出场",EXIT_RECORD:"本该出场（只记录）",
  PROTECT:"保护",PROTECT_RECORD:"本该保护（只记录）",HOLD_CHANGE:"持有判断变了",INTENT_MARKET:"市场判断变了",CLOSED:"平仓",FAST_ALERT:"集体异动",FAST_CONFIRM:"异动确认",
  FAST_END:"异动结束",FAST_SURGE:"只有价格没有资金"};
const bj=(ms:number|null|undefined)=>ms?new Date(ms+8*3_600_000).toISOString().slice(5,16).replace("T"," "):"—";
const pct=(v:number|null|undefined,d=2)=>v==null||!Number.isFinite(v)?"—":`${v>=0?"+":""}${(v*100).toFixed(d)}%`;
const sideCn=(s:Side|null|undefined)=>s==="LONG"?"多":s==="SHORT"?"空":"";
const coin=(s:string)=>s.replace("_USDT","");
const text=(v:unknown)=>v==null?"":typeof v==="number"?(Math.abs(v)<1&&v!==0?v.toPrecision(3):String(Math.round(v*1e4)/1e4)):String(v);

/** Owner-only 市场大脑: what the market is doing (capital and human nature), what the research layer opens, holds and exits, and why.
 * Polls /api/living/status every 30s only while this tab is mounted and the page is visible. Paper only; live is never touched. */
export default function LivingPanel({auth}:{auth:AuthSession|null}){
  const owner=Boolean(auth?.authenticated&&auth.username==="owner"&&!auth.memberId&&auth.role!=="member");
  const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const submitting=useRef(false);
  const load=useCallback(async()=>{
    if(typeof document!=="undefined"&&document.hidden)return;
    try{setStatus(await operatorRequest<Status>("/api/living/status"));setError(null);}catch(e){setError(e instanceof Error?e.message:"读取失败");}
  },[]);
  useEffect(()=>{if(!owner)return;const first=setTimeout(()=>void load(),0);const id=setInterval(()=>void load(),30_000);
    const vis=()=>{if(!document.hidden)void load();};document.addEventListener("visibilitychange",vis);
    return()=>{clearTimeout(first);clearInterval(id);document.removeEventListener("visibilitychange",vis);};},[owner,load]);
  if(!owner)return null;
  const setMode=async(mode:Mode)=>{
    if(submitting.current||busy)return;submitting.current=true;setBusy(true);
    try{setStatus(await operatorRequest<Status>("/api/living/mode","POST",{mode}));setError(null);}
    catch(e){setError(e instanceof Error?e.message:"切换失败");}
    finally{submitting.current=false;setBusy(false);}
  };
  const s=status,m=s?.market,sc=s?.selfCheck;
  return <div className="mb" data-testid="owner-living-research">
    <section className="fr-section mb-hero">
      <div className="fr-section-head"><h2>市场大脑</h2><b>{s?MODE_LABEL[s.mode]:"读取中"}</b></div>
      <p className="fr-note">不带情绪，只看价格、资金和人性（追涨、恐慌、投降、力竭、拥挤、安逸），决定开、拿、走。百分比都是价格涨跌，不是收益率。</p>
      {error&&<div className="fr-error" role="alert"><p>{error}</p></div>}
      {s?.fallback&&<p className="fr-note mb-warn"><b>自动降级为只计算</b>（到 {bj(s.fallback.until)}）：{s.fallback.reason}</p>}
      {s&&<>
        <div className={`mb-state mb-${(m?.state??"WARMING").toLowerCase()}`}>
          <small>现在的市场</small>
          <strong>{m?STATE_LABEL[m.state]??m.state:"还没读到"}{m?.side?` · 偏${sideCn(m.side)}`:""}</strong>
          <p>{m?.sentence??"行情刚接上，几分钟内会给出第一句判断。"}</p>
          {m&&<span>把握 {Math.round(m.confidence*100)}% · {bj(m.at)} · 允许的打法：{m.allowed.length?m.allowed.map(a=>`${a.label}（${sideCn(a.side)}）`).join("、"):"无，现在不开新单"}</span>}
        </div>
        {!!s.marketTimeline?.length&&<details className="fr-details"><summary>市场判断的变化（{s.marketTimeline.length}）</summary>
          <ol className="mb-list">{[...s.marketTimeline].reverse().map((x,i)=><li key={i}><b>{bj(x.at)} {STATE_LABEL[x.state]??x.state}{x.side?` 偏${sideCn(x.side)}`:""}</b><span>{x.sentence}</span></li>)}</ol></details>}
      </>}
    </section>

    {s&&<section className="fr-section">
      <div className="fr-section-head"><h2>集体异动</h2><b>{s.fast.state==="CALM"?"平静":`${s.fast.state} ${s.fast.side==="LONG"?"普涨":"普跌"}`}</b></div>
      <p className="fr-note">{s.fast.flow?`资金：${s.fast.flow.real===true?"真钱在动":s.fast.flow.real===false?"只有价格在动，资金没跟":"资金未核实"}（${s.fast.flow.kind}）${s.fast.flow.why?`，${s.fast.flow.why}`:""}`:"没有正在进行的集体异动。"}{s.fast.reason?` · ${s.fast.reason}`:""}</p>
      <p className="fr-note">已记录 {s.fast.episodes} 段{s.fast.surges7d!=null?`，其中被判为只有价格、没有资金的 ${s.fast.surges7d} 次`:""}。</p>
      {!!s.fast.last?.length&&<ul className="mb-chips">{s.fast.last.map(e=><li key={e.id}>{bj(e.alertAt)} {e.side==="LONG"?"普涨":"普跌"} · {e.end??"进行中"}{e.after15!=null?` · 15分钟后 ${pct(e.after15)}`:""}</li>)}</ul>}
    </section>}

    {s&&<section className="fr-section">
      <div className="fr-section-head"><h2>每个币在发生什么</h2><b>{s.board?.length??0}</b></div>
      {!s.board?.length?<p className="fr-note">还没有币的读数。</p>:<div className="mb-board">{s.board.map(c=><article key={c.symbol} className={c.action?"is-act":""}>
        <header><b>{coin(c.symbol)}</b><i>{CAPITAL_LABEL[c.capital]??c.capital}</i><i>{EMOTION_LABEL[c.emotion]??c.emotion}</i><em>{Math.round(c.strength*100)}</em></header>
        <p>{c.why}</p>
        <small>15分钟 {pct(c.ev.p15)} · 持仓量15分 {pct(c.ev.oi15,1)} / 60分 {pct(c.ev.oi60,1)} · 资金费 {pct(c.ev.funding,3)} · 主动买卖 {c.ev.taker15==null?"—":c.ev.taker15.toFixed(2)} · 量能 {c.ev.vol15==null?"—":`${c.ev.vol15.toFixed(1)}倍`}</small>
        <p className="mb-act">{c.action?`→ ${c.action.label}（${sideCn(c.action.side)}）`:`不做：${c.noTrade??"没有清楚的意图"}`}</p>
      </article>)}</div>}
    </section>}

    {s&&<section className="fr-section">
      <div className="fr-section-head"><h2>在拿的单</h2><b>{s.positions?.length??0}</b></div>
      {!s.positions?.length?<p className="fr-note">现在没有持仓。</p>:<ul className="mb-list">{s.positions.map(p=><li key={p.id}>
        <b>{coin(p.symbol)} {sideCn(p.side)} · {p.playbook??"老流程"} · 开在 {text(p.entry)}，止损 {text(p.stop)}</b>
        {p.story&&<span>为什么开：{p.story}</span>}{p.evidence&&<span>证据：{p.evidence}</span>}
        {p.invalidation!=null&&<span>什么情况算错：{text(p.invalidation)}</span>}
        <span>为什么还拿着：{p.hold??"—"}{p.holdAt?`（${bj(p.holdAt)}）`:""}</span></li>)}</ul>}
    </section>}

    {s&&<section className="fr-section">
      <div className="fr-section-head"><h2>在等位置</h2><b>{s.watches.length}</b></div>
      {!s.watches.length?<p className="fr-note">没有在等的单。</p>:<ul className="mb-list">{s.watches.map((w,i)=><li key={i}>
        <b>{coin(w.symbol)} {sideCn(w.side)} · {w.pb}{w.zone?` · 等 ${text(w.zone[0])}–${text(w.zone[1])}`:""}</b>
        {w.why&&<span>{w.why}</span>}<span>{w.invalidation!=null?`跌破/升破 ${text(w.invalidation)} 就不做 · `:""}{bj(w.expiresAt)} 过期</span></li>)}</ul>}
    </section>}

    {s&&<section className="fr-section">
      <div className="fr-section-head"><h2>最近的决定</h2><b>{s.decisions?.length??0}</b></div>
      {!s.decisions?.length?<p className="fr-note">还没有决定。</p>:<ol className="mb-list mb-decisions">{s.decisions.map((d,i)=>{const k=String(d.k);return <li key={i}>
        <b>{bj(d.at as number)} {DECISION_LABEL[k]??k}{d.sym?` · ${coin(String(d.sym))}`:""}{d.side?` ${sideCn(d.side as Side)}`:""}</b>
        <span>{text(d.story??d.reason??d.why??d.sentence??"")}</span></li>;})}</ol>}
    </section>}

    {s&&<section className="fr-section">
      <div className="fr-section-head"><h2>自检</h2></div>
      <p className="fr-note">集体异动 {sc?.fast.alerts??0} 段：资金跟上确认 {sc?.fast.confirmed??0}，假动作 {sc?.fast.fake??0}{sc?.fast.follow30.length?`；跟进 30 分钟平均 ${pct(sc.fast.follow30.reduce((a,b)=>a+b,0)/sc.fast.follow30.length)}`:""}。</p>
      {!!sc?.byPlaybook.length&&<ul className="mb-chips">{sc.byPlaybook.map(b=><li key={b.pb}>{b.label}：{b.n} 笔，胜率 {Math.round(b.winRate*100)}%，平均 {b.avgR.toFixed(2)}R</li>)}</ul>}
      {!!s.probes?.length&&<p className="fr-note">近期打法表现只调仓位（0.7–1.2 倍），不卡开单：{s.probes.map(p=>`${p.label} ×${p.modulator}`).join("，")}</p>}
      {s.thesis&&<p className="fr-note">结构背景：{s.thesis.sentence}</p>}
      <p className="fr-note">读数次数：{sc?Object.entries(sc.intentReads).map(([k,v])=>`${EMOTION_LABEL[k]??CAPITAL_LABEL[k]??STATE_LABEL[k]??k} ${v}`).join("，")||"—":"—"}</p>
    </section>}

    {s&&<section className="fr-section">
      <div className="fr-section-head"><h2>开关</h2><b>{s.version}</b></div>
      <p className="fr-note">{s.items.map(i=>`${i.label}${i.on?"✓":"✗"}`).join("　")}</p>
      <p className="fr-note">一篮子 {s.basket} 个币 · 资金数据 {s.flowSymbols??0} 个币（{bj(s.flowAt)}）· 最近报价 {bj(s.lastFeedAt)} · 每轮 {s.cpu.planMs}ms（峰值 {s.cpu.maxPlanMs}ms）· 今天写入 {s.writesToday} 次{s.lastError?` · 最近错误：${s.lastError.slice(0,80)}`:""}</p>
      <div className="fr-owner-session">
        {(["off","compute-only","paper-enabled"] as Mode[]).map(x=><button key={x} className={x===s.configured?"fr-button":"fr-text-button"} type="button"
          disabled={busy||x===s.configured} onClick={()=>void setMode(x)}>{MODE_LABEL[x]}</button>)}
      </div>
      <p className="fr-note">只作用于模拟账户；实盘开关不受这里影响。</p>
    </section>}
  </div>;
}
