"use client";
/** 大脑 tab: the dynamic-v1 research layer (history download, BTC/ETH state, each playbook's good/bad cycles, what the allocator
 * allows now and why, recent events). Display only; switch 10 is the only control. */
import {bj,type BrainStatus,type DynamicView} from "../lib/brain-view.ts";

const pc=(x:number|null|undefined,d=1)=>x==null||!Number.isFinite(x)?"—":`${x>0?"+":""}${(x*100).toFixed(d)}%`;
const ivCn:Record<string,string>={"1d":"日线","4h":"4小时","1h":"1小时"};
const phaseCn=(l:string|null|undefined)=>l==="GOOD"?"赚钱段":l==="BAD"?"亏钱段":"未定";
const day=(t:number|null|undefined)=>t?new Date(t*1000).toISOString().slice(0,10):"—";
export default function DynamicPanel({s,busy,onToggle}:{s:BrainStatus;busy:boolean;onToggle:(on:boolean)=>void}){
  const raw=s.dynamic;if(!raw)return null;
  if("error" in raw&&!("backfill" in raw))return <details className="mb-fold"><summary>研究层：周期与分配</summary><p className="mb-hint">读取失败：{raw.error}</p></details>;
  const d=raw as DynamicView,b=d.backfill,item=s.items.find(i=>i.key==="dynAllocator");
  return <details className="mb-fold" open>
    <summary>研究层：周期与分配（{d.allowed.length?`允许 ${d.allowed.length} 套打法`:"全部只记录"}）</summary>
    <p className="mb-hint">历史下载：{b.done}/{b.total} 条序列完成（{Math.round(b.pct*100)}%）{b.working?`，正在下 ${b.working.replace("_USDT","")}`:""}
      {b.etaMin?`，预计还要约 ${b.etaMin>=120?`${Math.round(b.etaMin/60)} 小时`:`${b.etaMin} 分钟`}`:""}；
      {Object.entries(b.byIv).map(([iv,x])=>`${ivCn[iv]??iv} ${x.done}/${x.total}（${x.bars} 根，最早 ${x.from??"—"}）`).join("，")}；
      今天外部请求 {b.reqToday} 次，失败累计 {b.errTotal}{b.blocked.length?`，${b.blocked.join("/")} 限流中（先用别的交易所）`:""}{b.pausedUntil?`，三家都限流，暂停到 ${bj(b.pausedUntil)}`:""}；影子交易 {d.shadowTrades} 笔。</p>
    {d.state?<p className="mb-hint">BTC/ETH 状态（{d.state.day} 收盘）：<b>{d.state.label}</b>；BTC 距 100 日均线 {pc(d.state.strength)}，日波动 {pc(d.state.atrPct,2)}（1 年分位 {Math.round(d.state.volPct*100)}%），
      距 90 日高点 {pc(d.state.dd90)}，20 日走势效率 {d.state.eff20.toFixed(2)}；ETH {d.state.eth?d.state.eth.trend==="UP"?"上涨":d.state.eth.trend==="DOWN"?"下跌":"震荡":"—"}；
      山寨相对 BTC（20 日）{pc(d.state.altVsBtc)}（{d.state.lead==="ALT"?"山寨更强":d.state.lead==="BTC"?"BTC 更强":"—"}），和 BTC 相关性 {d.state.corr30?.toFixed(2)??"—"}</p>
      :<p className="mb-hint">BTC/ETH 状态：等 BTC 日线历史下载完再算。</p>}
    <ol className="mb-list">{d.playbooks.map(p=><li key={p.id}>
      <b>{p.gate?.ok?"✓ ":"· "}{p.label}（{ivCn[p.iv]??p.iv}）{p.trades} 笔{p.all?`，平均 ${pc(p.all.mean,2)}/笔，胜率 ${Math.round(p.all.win*100)}%`:""}</b>
      <span>近 2/4/8 周：{p.rolling?["2w","4w","8w"].map(k=>`${pc(p.rolling![k]?.net)}（${p.rolling![k]?.n??0} 笔）`).join(" / "):"—"}；
        周期：{p.good} 段赚钱、{p.bad} 段亏钱（平均 {p.meanGoodWeeks} / {p.meanBadWeeks} 周），持续性 {p.persistence==null?"—":`${Math.round(p.persistence*100)}%`}；
        现在 {phaseCn(p.current?.label)}{p.current?.weeks?` 第 ${p.current.weeks} 周`:""}；{p.pattern?"规律已确认":p.patternWhy}</span>
      <span>{p.gate?(p.gate.ok?`允许：${p.gate.why}`:`不开：${p.gate.why}`):"分配器还没算"}</span>
      {d.state&&p.byBucket[d.state.bucket]&&<span>当前状态下：{p.byBucket[d.state.bucket]!.n} 笔，平均 {pc(p.byBucket[d.state.bucket]!.mean,2)}，t={p.byBucket[d.state.bucket]!.t.toFixed(1)}</span>}
    </li>)}</ol>
    {!!d.stateHistory.length&&<p className="mb-hint">状态变化：{d.stateHistory.slice(-6).map(x=>`${x.day} → ${x.to}`).join("；")}</p>}
    {!!d.events.length&&<details className="mb-fold"><summary>研究层记录（{d.events.length}）</summary><ol className="mb-list">{d.events.map((e,i)=><li key={i}><b>{bj(e.at)} {e.k}</b><span>{e.text}</span></li>)}</ol></details>}
    <p className="mb-hint">规则：每套打法先在历史和实时 K 线上只做影子交易（扣 0.19% 手续费）；赚钱段和亏钱段各出现 ≥3 次、≥40 笔后才算有规律；
      当前 BTC/ETH 状态下 ≥20 笔、平均 ≥+0.2%/笔、t≥1.5，且不在会延续的亏钱段，才允许开模拟单，风险 0.375%–0.75%/笔（按信心），打法池最多 {d.limits.maxPoolOpen} 笔、每套最多 {d.limits.maxPerPlaybook} 笔。
      {d.lastError?` 最近错误：${d.lastError}`:""}{d.lastAnalyzeAt?` 最近分析 ${bj(d.lastAnalyzeAt)}。`:""}</p>
    {item&&<div className="fr-owner-session"><button className="fr-text-button" type="button" disabled={busy} onClick={()=>onToggle(!item.on)}>
      {item.on?"关掉 10 动态分配（打法池只记录；日线突破回到开关 9 单独控制）":"打开 10 动态分配"}</button></div>}
    <p className="mb-hint">起始 {day(d.backfill.startedAt?d.backfill.startedAt/1000:null)} · {d.version}</p>
  </details>;
}
