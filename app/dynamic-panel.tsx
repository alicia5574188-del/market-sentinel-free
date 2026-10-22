"use client";
/** 大脑 tab, dynamic-v1.4: the one scheme. Every playbook (pool playbooks, the market-wide burst leader, the daily breakout) is a member
 * of one pool, and the cycle predictor decides which may open paper trades (switch 10). This module draws the parts of the brain
 * page that follow that scheme: the summary, the playbooks ranked by P(good in 6 h), the families, the latest gate decisions and
 * pool trades, and the research detail (backfill, BTC/ETH state, rules, events) folded away. Display only; switch 10 is the only
 * control here. Price numbers are price moves (%), never ROE. */
import {bj,coinName,sideCn,type BrainStatus,type DynamicView,type PoolStatus} from "../lib/brain-view.ts";

export const pc=(x:number|null|undefined,d=2)=>x==null||!Number.isFinite(x)?"—":`${x>0?"+":""}${(x*100).toFixed(d)}%`;
const pct=(x:number|null|undefined)=>x==null||!Number.isFinite(x)?"—":`${Math.round(x*100)}%`;
const toneOf=(x:number|null|undefined)=>x==null||!Number.isFinite(x)||Math.abs(x)<1e-9?"":x>0?"fr-positive":"fr-negative";
const ivCn:Record<string,string>={"1d":"日线","4h":"4小时","1h":"1小时","15m":"15分钟","5m":"5分钟","1m":"1分钟"};
const sessCn:Record<string,string>={ASIA:"亚洲盘",EU:"欧洲盘",US:"美国盘",LATE:"美盘尾段"};
/** hours → "5 小时" / "2 天" / "2 天 8 小时" */
export const dur=(h:number|null|undefined)=>{if(h==null||!Number.isFinite(h))return"—";const x=Math.max(0,Math.round(h));
  return x<1?"不到 1 小时":x<48?`${x} 小时`:x%24?`${Math.floor(x/24)} 天 ${x%24} 小时`:`${x/24} 天`;};
export const phaseCn=(l:string|null|undefined)=>l==="GOOD"?"赚钱期":l==="BAD"?"亏钱期":"还看不清";
export const DECISION_CN:Record<string,string>={ORDER:"发出开单",ALLOW:"允许开单",DENY:"不允许（只记录）",CUT:"暂停（预测被打脸）",SWITCH_OFF:"开关 10 关着（只记录）",
  BUSY:"位置满了（只记录）",WAIT:"研究层在等（只记录）",STOP_CROSSED:"现价已越过止损（不开）",
  NOT_LIVE:"不在实时报价币池（只记录）",NO_QUOTE:"没有实时盘口（没开）",REJECTED:"模拟账户拒单（没开）"};
const KIND_CN:Record<string,string>={pool:"打法池信号",burst:"爆发选币",htf:"日线突破"};
type Pb=DynamicView["playbooks"][number];
export function dynOf(s:BrainStatus):DynamicView|null{const raw=s.dynamic;return raw&&!("error" in raw&&!("backfill" in raw))?raw as DynamicView:null;}
export function labelsOf(d:DynamicView|null){return new Map((d?.playbooks??[]).map(p=>[p.id,p.label]));}
/** a playbook may open on paper at all (short tier, or the daily breakout); the other long-tier ones are record-only */
const tradable=(p:Pb)=>p.tier==="short"||p.id==="htf-donch20";
const shortWhy=(w:string|null|undefined,n=70)=>!w?"":w.length>n?`${w.slice(0,n)}…`:w;
/** the gate's reason in plain words, without the probability the line already shows */
export function gateWords(why:string|null|undefined,pMin=.58){
  if(!why)return"";
  return why.replace(/^分配器不允许（只记录）— /,"").replace(/^分配器允许：/,"")
    .replace(/未来 6 小时处在赚钱期的概率 \d+%（要 ≥(\d+)%）【[^】]*】/,"概率没到门槛 $1%，只记录")
    .replace(/^预测：未来 6 小时在赚钱期的概率 \d+%（[^）]*）【[^】]*】；/,`概率过了门槛 ${Math.round(pMin*100)}%；`)
    .replace(/^概率 \d+% 够，但/,"概率够，但");
}

/** 总方案: switch 10, pool slots, today's opens / closes / net price move, live score, hit rate, backfill. */
export function SchemeSummary({s,pool,busy,onToggle,liveEnabled}:{s:BrainStatus;pool:PoolStatus|undefined;busy:boolean;onToggle:(on:boolean)=>void;liveEnabled:boolean}){
  const d=dynOf(s),item=s.items.find(i=>i.key==="dynAllocator"),on=!!item?.on,b=d?.backfill,pr=d?.predictor;
  const open=pool?.open??[],float=open.reduce((a,p)=>a+(p.move??0),0),t=pool?.today;
  const r6=pr?.real?.find(x=>x.h===6)??pr?.real?.[0],g=r6?.good,o=r6?.other;
  const allowed=d?.playbooks.filter(p=>p.gate?.ok).length??0,withFc=d?.playbooks.filter(p=>p.pred).length??0;
  const state=!s.acting?(s.fallback?"研究层降级中，只计算":"研究层只计算，不开单"):on?"按预测开模拟单":"只记录，不开单";
  return <section className="pg-card bs-scheme" data-testid="brain-scheme">
    <header className="bs-head"><div><small>总方案 · 一个打法池，周期预测器决定开不开</small>
      <strong className="pg-title">{state}</strong></div>
      <span className={`bs-switch${on?" is-on":""}`}>开关 10 {on?"开":"关"}</span></header>
    <p className="bs-lead">{on?`未来 6 小时处在赚钱期的概率 ≥${pct(pr?.pMin??.58)}、预测记录不差的打法才开小模拟单；其余只记录。`:"所有打法只做影子交易和预测，不开模拟单。"}
      实盘{liveEnabled?"开着":"关着"}，这里只作用于模拟账户。</p>
    <div className="bs-tiles">
      <div><small>打法池持仓</small><b>{pool?(pool.max==null?`${open.length} 笔`:`${open.length}/${pool.max}`):"—"}</b><p className={toneOf(float)}>{open.length?`浮动 ${pc(float)}（价格）`:"空仓"}</p></div>
      <div><small>今天 开/平</small><b>{t?`${t.opened} / ${t.closed}`:"—"}</b><p>{t&&t.closed?`赚 ${t.win} 笔，亏 ${t.closed-t.win} 笔`:"今天还没平仓"}</p></div>
      <div><small>今天平仓净涨跌</small><b className={toneOf(t?.move)}>{t?pc(t.move):"—"}</b><p>{t&&t.closed?`价格涨跌合计，平均 ${pc(t.move/t.closed)}/笔`:"价格涨跌，不是 ROE"}</p></div>
      <div><small>允许开单的打法</small><b>{d?`${allowed}/${withFc||d.playbooks.length}`:"—"}</b><p>{d?`${withFc} 套有预测`:"研究层读取中"}</p></div>
    </div>
    <div className="bs-score" data-testid="brain-live-score">
      <div><small>实盘检验 · 预测看好后 6 小时</small><b className={toneOf(g?.avg)}>{g?.trades?`${pc(g.avg)}/笔`:"还没有"}</b><p>{g?`${g.forecasts} 次预测，后续 ${g.trades} 笔影子交易`:"等第一批 6 小时预测到期"}</p></div>
      <div><small>预测不看好后 6 小时</small><b className={toneOf(o?.avg)}>{o?.trades?`${pc(o.avg)}/笔`:"还没有"}</b><p>{o?`${o.forecasts} 次预测，后续 ${o.trades} 笔`:"—"}</p></div>
      <div><small>预测命中率</small><b>{pr?.track.n?pct(pr.track.hit):"—"}</b><p>{pr?.track.n?`${pr.track.n} 次到期预测，Brier ${pr.track.brier.toFixed(3)}`:"还没有到期的预测"}</p></div>
    </div>
    {g&&o&&g.trades>0&&o.trades>0&&<p className="bs-hint">{(g.avg??0)>(o.avg??0)?"看好时跟着来的交易比不看好时好，预测有用。":"看好时并没有比不看好时好，预测还没证明自己（只记录，不影响开单）。"}</p>}
    {b?<p className="bs-hint" data-testid="brain-backfill">历史下载：<b>{b.done}/{b.total}</b> 条序列（{pct(b.pct)}）{b.working?`，正在下 ${b.working.replace("_USDT","")}`:""} · Bybit / OKX / KuCoin（不用 Gate）·
      {b.pages!=null?`已下 ${b.pages} 页 · 近 1 小时 ${b.reqLastHour??0} 次 · `:""}{b.lastProgressAt?`上次有新数据 ${bj(b.lastProgressAt)} · `:""}{d!.booted===false?"启动中，进度读取后再显示 · ":""}今天请求 {b.reqToday} 次 · 失败累计 {b.errTotal}{b.blocked.length?` · ${b.blocked.join("/")} 限流中`:""}{b.pausedUntil?` · 暂停到 ${bj(b.pausedUntil)}`:""} · 影子交易 {d!.shadowTrades} 笔</p>
      :<p className="bs-hint">研究层还没读到。</p>}
    {s.fallback&&<p className="bs-hint mb-warn">自动降级为只计算（到 {bj(s.fallback.until)}）：{s.fallback.reason}</p>}
    {item&&<div className="fr-owner-session"><button className="fr-text-button" type="button" disabled={busy} onClick={()=>onToggle(!on)}>
      {on?"关掉开关 10（全部打法只记录；已开的单照常按各自的出场管）":"打开开关 10（按预测开模拟单）"}</button></div>}
  </section>;
}

/** one playbook in one line: phase, forecast + probability + data label, gate decision + reason, size */
export function PbLine({p}:{p:Pb}){
  const f=p.pred,g=p.gate,ok=!!g?.ok&&tradable(p);
  const verdict=!tradable(p)?"只记录（长线）":ok?"允许开单":"只记录";
  return <li className={`bs-pb${ok?" is-ok":""}`}>
    <div className="bs-pb-top"><b>{p.label}</b><span className="bs-iv">{ivCn[p.iv]??p.iv}</span>
      <span className={`bs-tag${ok?" is-ok":""}`}>{verdict}{ok&&g?` · 风险 ${(g.risk*100).toFixed(2)}%`:""}</span></div>
    <div className="bs-pb-mid">
      {f?<><span className={f.cur==="GOOD"?"fr-positive":f.cur==="BAD"?"fr-negative":""}>{phaseCn(f.cur)}{f.cur?`（已 ${dur(f.elapsedH)}）`:""}</span>
        <span>6 小时赚钱期概率 <b>{pct(f.p6)}</b>【{f.label}】</span>
        <span className="bs-dim">24 小时 {pct(f.p24)}</span></>
        :<span>还没有预测（{p.trades?`${p.trades} 笔影子交易，段数不够`:"还没有影子交易"}）</span>}
    </div>
    <p className="bs-why">{g?shortWhy(gateWords(g.why),90):"分配器还没算"}{f?.track.n&&!/命中率/.test(g?.why??"")?` · 这套的预测命中 ${pct(f.track.hit)}（${f.track.n} 次）`:""}</p>
  </li>;
}

/** 现在最看好 / 现在不看好: playbooks that may trade, ranked by P(good 6 h) */
export function Ranked({s}:{s:BrainStatus}){
  const d=dynOf(s);if(!d)return null;
  const xs=d.playbooks.filter(p=>p.pred&&tradable(p)).sort((a,b)=>b.pred!.p6-a.pred!.p6);
  if(!xs.length)return <section className="pg-section" data-testid="brain-ranked"><h2>现在最看好</h2>
    <div className="pg-empty">预测器还在等 BTC 1 小时历史和第一批影子交易（一到就开始，先标【数据少】）。</div></section>;
  const n=Math.min(5,Math.ceil(xs.length/2)),top=xs.slice(0,n),bottom=xs.slice(-Math.min(5,xs.length-n)).reverse();
  return <>
    <section className="pg-section" data-testid="brain-ranked">
      <h2>现在最看好<small>按未来 6 小时赚钱期概率</small></h2>
      <ol className="bs-list">{top.map(p=><PbLine key={p.id} p={p}/>)}</ol>
    </section>
    {!!bottom.length&&<section className="pg-section" data-testid="brain-ranked-low">
      <h2>现在不看好<small>概率最低的 {bottom.length} 套</small></h2>
      <ol className="bs-list">{bottom.map(p=><PbLine key={p.id} p={p}/>)}</ol>
    </section>}
  </>;
}

/** every playbook by family (burst leader and daily breakout are normal members), collapsible */
export function Families({s}:{s:BrainStatus}){
  const d=dynOf(s);if(!d)return null;
  const fams=new Map<string,Pb[]>();for(const p of d.playbooks)(fams.get(p.familyLabel)??fams.set(p.familyLabel,[]).get(p.familyLabel)!).push(p);
  const rows=[...fams].map(([f,ps])=>({f,ps:[...ps].sort((a,b)=>(b.pred?.p6??-1)-(a.pred?.p6??-1)),ok:ps.filter(p=>p.gate?.ok&&tradable(p)).length,
    best:Math.max(-1,...ps.map(p=>p.pred?.p6??-1)),trades:ps.reduce((a,p)=>a+p.trades,0),rec:ps.every(p=>!tradable(p))}))
    .sort((a,b)=>Number(a.rec)-Number(b.rec)||b.ok-a.ok||b.best-a.best);
  return <section className="pg-section" data-testid="brain-families">
    <h2>所有打法<small>{d.playbooks.length} 套 · {rows.length} 类</small></h2>
    {rows.map(({f,ps,ok,best,trades,rec})=><details key={f} className="bs-fam">
      <summary><span>{f}</span><small>{ps.length} 套 · {trades} 笔{best>=0?` · 最高 ${pct(best)}`:""}{rec?" · 只记录":ok?` · 允许 ${ok} 套`:""}</small></summary>
      <ol className="bs-list">{ps.map(p=><PbLine key={p.id} p={p}/>)}</ol>
    </details>)}
  </section>;
}

/** the latest gate decisions (allocator changes and entry signals) */
export function GateLog({s,pool}:{s:BrainStatus;pool:PoolStatus|undefined}){
  const lab=labelsOf(dynOf(s)),xs=pool?.gates??[];
  return <section className="pg-section" data-testid="brain-gates">
    <h2>最近的开单判断<small>最新 {xs.length} 条</small></h2>
    {!xs.length?<div className="pg-empty">程序这次启动后还没有新的开单判断（全部记录在运行日志里）。</div>:
    <ol className="bs-list bs-log">{xs.map((r,i)=>{const dec=String(r.decision??(r.ok?"ALLOW":"DENY")),ok=dec==="ORDER"||dec==="ALLOW",pMin=typeof r.pMin==="number"?r.pMin:.58;
      return <li key={i}>
        <div className="bs-pb-top"><span className="bs-time">{bj(r.at)}</span><b>{lab.get(String(r.pb))??String(r.pb??"")}</b>
          {r.sym?<span>{coinName(String(r.sym))} {sideCn(String(r.side??""))}</span>:<span className="bs-dim">{r.src==="allocator"?"分配器":""}</span>}
          <span className={`bs-tag${ok?" is-ok":""}`}>{DECISION_CN[dec]??dec}</span></div>
        <p className="bs-why">{typeof r.p6==="number"?`概率 ${pct(r.p6)}（门槛 ${pct(pMin)}）· `:""}
          {r.phase!==undefined?`${phaseCn(r.phase as string|null)}${typeof r.elapsedH==="number"?` 已 ${dur(r.elapsedH)}`:""} · `:""}
          {r.kind?`${KIND_CN[String(r.kind)]??r.kind} · `:""}{shortWhy(gateWords(String(r.why??""),pMin),110)}</p>
      </li>;})}</ol>}
  </section>;
}

/** the latest closed pool trades with their price move */
export function PoolTrades({s,pool,onOpenOrders}:{s:BrainStatus;pool:PoolStatus|undefined;onOpenOrders?:()=>void}){
  const lab=labelsOf(dynOf(s)),xs=pool?.recent??[],all=pool?.all;
  return <section className="pg-section" data-testid="brain-pool-trades">
    <h2>最近打法池平仓<small>{all?.closed?`共 ${all.closed} 笔，赚 ${all.win} 笔，价格合计 ${pc(all.move)}`:"最新"}</small></h2>
    {!xs.length?<div className="pg-empty">还没有平掉的打法池单。</div>:
    <div className="pg-recent">{xs.map(t=><div key={t.id}>
      <span><b>{coinName(t.sym)} {sideCn(t.side)}</b><small>{lab.get(t.pb)??t.pb} · {shortWhy(t.exitWhy??t.exitCode??"已平仓",40)} · {bj(t.closedAt)}</small></span>
      <strong className={toneOf(t.move)}>{pc(t.move)}<small>{t.risk!=null?`风险 ${(t.risk*100).toFixed(2)}% · `:""}{dur((t.closedAt-t.openedAt)/3_600_000)}</small></strong>
    </div>)}</div>}
    {onOpenOrders&&<button type="button" className="pg-link" onClick={onOpenOrders}>查看全部模拟订单 →</button>}
  </section>;
}

/** forecast outcomes (scored after the horizon) */
export function ForecastRecord({s}:{s:BrainStatus}){
  const d=dynOf(s);const pr=d?.predictor;if(!pr)return null;
  return <details className="mb-fold"><summary>预测记录（到期 {pr.track.n} 次）</summary>
    <p className="mb-hint">每小时给每套打法预测一次未来 6 / 24 / 72 小时在不在赚钱期，到期后对答案。{pr.track.n?`命中 ${pct(pr.track.hit)}，Brier ${pr.track.brier.toFixed(3)}（越小越好，瞎猜约 0.25）。`:"还没有到期的预测。"}</p>
    <p className="mb-hint">{pr.realLine}（只记录，不参与开单判断）</p>
    {!!pr.recent.length&&<ol className="mb-list">{pr.recent.map((x,i)=><li key={i}><b>{x.hit?"✓":"✗"} {x.label} · {x.h} 小时</b>
      <span>说 {pct(x.p)} → 实际{x.y?"在赚钱期":"不在赚钱期"}{x.n?`；后续 ${x.n} 笔影子交易 ${pc(x.net??0)}`:""}</span></li>)}</ol>}
  </details>;
}

/** research detail that no longer needs to be on top: backfill by interval, BTC/ETH state, per-playbook detail, rules, events */
export function ResearchDetail({s}:{s:BrainStatus}){
  const d=dynOf(s);if(!d)return s.dynamic&&"error" in s.dynamic?<p className="mb-hint">研究层读取失败：{(s.dynamic as {error:string}).error}</p>:null;
  const b=d.backfill;
  return <>
    <p className="mb-hint">历史下载（先短线，后 4 小时/日线）：{Object.entries(b.byIv).map(([iv,x])=>`${ivCn[iv]??iv} ${x.done}/${x.total}（${x.bars} 根，最早 ${x.from??"—"}）`).join("，")}
      {b.etaMin?`；预计还要约 ${b.etaMin>=120?`${Math.round(b.etaMin/60)} 小时`:`${b.etaMin} 分钟`}`:""}；历史回放 {d.replay.unitsDone}/{Math.max(d.replay.unitsKnown,d.replay.unitsDone)} 块，实时评估 {d.replay.liveSeries} 条序列；单步最长 {d.maxStepMs} 毫秒。</p>
    {d.intraday&&<p className="mb-hint">BTC/ETH 日内（{d.intraday.hour} UTC）：<b>{d.intraday.label}</b>；1 小时 {d.intraday.trend}，4 小时 {d.intraday.trend4h}，ETH {d.intraday.eth??"—"}；24 小时波动 {pc(d.intraday.atrPct)}/小时（分位 {pct(d.intraday.volPct)}）；{d.intraday.session}。</p>}
    {d.state&&<p className="mb-hint">BTC/ETH 日线（{d.state.day}）：<b>{d.state.label}</b>；距 100 日均线 {pc(d.state.strength,1)}，距 90 日高点 {pc(d.state.dd90,1)}，山寨相对 BTC {pc(d.state.altVsBtc,1)}。</p>}
    <ol className="mb-list">{d.playbooks.filter(p=>p.pred||p.trades).map(p=><li key={p.id}><b>{p.label}（{ivCn[p.iv]??p.iv}）{p.trades} 笔{p.all?`，平均 ${pc(p.all.mean)}/笔，胜率 ${pct(p.all.win)}`:""}</b>
      <span>{p.pred?`${p.pred.line}（${p.pred.phases.good} 段赚、${p.pred.phases.bad} 段亏，平均 ${p.pred.phases.meanGoodH}/${p.pred.phases.meanBadH} 小时${p.pred.period?`，每 ${p.pred.period.lag} 天重复`:""}${p.pred.profile.session?`，最好 ${sessCn[p.pred.profile.session]??p.pred.profile.session}`:""}）；${p.pred.realLine}`:"还没有预测"}</span>
      <span>旧周期（按{p.unit==="day"?"天":"周"}）：{p.good} 段赚 / {p.bad} 段亏；{p.pattern?"规律已确认":p.patternWhy}</span></li>)}</ol>
    {!!d.events.length&&<details className="mb-fold"><summary>研究层记录（{d.events.length}）</summary><ol className="mb-list">{d.events.map((e,i)=><li key={i}><b>{bj(e.at)} {e.k}</b><span>{e.text}</span></li>)}</ol></details>}
    <p className="mb-hint">规则：每套打法先只做影子交易（扣 0.19% 手续费）；所有打法（含全市场爆发选领涨、日线突破做多）是一个总方案，开关 10 开着时开单全由周期预测器决定：
      未来 6 小时在赚钱期的概率 ≥{pct(d.predictor.pMin)}、预测记录不差（评过不到 10 次用最小仓位）才开，风险 0.25–0.5%×记录权重×证据（爆发单最多 0.75%）；
      开闸后前 3 笔全亏或连亏 5 笔立即暂停 12 小时；打法池{d.limits.maxPoolOpen==null?"不限笔数":`最多 ${d.limits.maxPoolOpen} 笔`}、{d.limits.maxPerPlaybook==null?"每套不限":`每套最多 ${d.limits.maxPerPlaybook} 笔`}、一个币一笔（由风险预算、保证金和爆仓距离自然限制）。
      {d.lastError?` 最近错误：${d.lastError}`:""}{d.lastAnalyzeAt?` 最近分析 ${bj(d.lastAnalyzeAt)}。`:""} {d.version}</p>
  </>;
}
