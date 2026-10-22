"use client";
/** 大脑 tab: the dynamic-v1 research layer (history download, BTC/ETH daily + intraday state, the short-term playbook pool grouped by
 * family with each one's good/bad cycles, what the allocator allows now and why, recent events). Display only; switch 10 is the
 * only control. */
import {bj,type BrainStatus,type DynamicView} from "../lib/brain-view.ts";

const pc=(x:number|null|undefined,d=1)=>x==null||!Number.isFinite(x)?"—":`${x>0?"+":""}${(x*100).toFixed(d)}%`;
const ivCn:Record<string,string>={"1d":"日线","4h":"4小时","1h":"1小时","15m":"15分钟","5m":"5分钟","1m":"1分钟"};
const phaseCn=(l:string|null|undefined)=>l==="GOOD"?"赚钱段":l==="BAD"?"亏钱段":"未定";
const day=(t:number|null|undefined)=>t?new Date(t*1000).toISOString().slice(0,10):"—";
type Pb=DynamicView["playbooks"][number];
function Row({p,bucket}:{p:Pb;bucket:string|null}){
  const u=p.unit==="day"?"天":"周",win=p.unit==="day"?["1w","2w","4w"]:["2w","4w","8w"],b=bucket?p.byBucket[bucket]:undefined;
  return <li>
    <b>{p.gate?.ok?"✓ ":"· "}{p.stage!=="confirmed"?"【数据少】":""}{p.label}（{ivCn[p.iv]??p.iv}）{p.trades} 笔{p.all?`，平均 ${pc(p.all.mean,2)}/笔，胜率 ${Math.round(p.all.win*100)}%`:""}</b>
    <span>近 {win.map(k=>k.replace("w",""))
      .join("/")} 周：{p.rolling?win.map(k=>`${pc(p.rolling![k]?.net)}（${p.rolling![k]?.n??0} 笔）`).join(" / "):"—"}
      {p.counts&&Object.keys(p.counts).length?`；最近 ${Object.entries(p.counts).map(([n,x])=>`${n} 笔 ${pc(x.net)}`).join(" / ")}`:""}；
      周期：{p.good} 段赚钱、{p.bad} 段亏钱（平均 {p.meanGoodWeeks} / {p.meanBadWeeks} {u}），持续性 {p.persistence==null?"—":`${Math.round(p.persistence*100)}%`}；
      现在 {phaseCn(p.current?.label)}{p.current?.weeks?` 第 ${p.current.weeks} ${u}`:""}；{p.pattern?"规律已确认":p.patternWhy}</span>
    <span>预测：{p.forecast?`下一段${p.forecast.next==="GOOD"?"赚钱":"亏钱"}（${Math.round(p.forecast.prob*100)}%，【${p.forecast.label}】）— ${p.forecast.why}`:`还没有（${p.trades?"只看到不明朗的段":"还没有影子交易"}，【数据少】）`}
      {p.stage==="confirmed"?"；规律已确认":p.stage==="early"?"；早期规律（小仓位）":""}</span>
    <span>{p.gate?(p.gate.ok?`允许：${p.gate.why}`:`不开：${p.gate.why}`):"分配器还没算"}</span>
    {b&&<span>当前状态下：{b.n} 笔{b.days!=null?`/${b.days} 天`:""}，平均 {pc(b.mean,2)}，t={b.t.toFixed(1)}{b.tDay!=null?`，t(按天)=${b.tDay.toFixed(1)}`:""}</span>}
  </li>;
}
export default function DynamicPanel({s,busy,onToggle}:{s:BrainStatus;busy:boolean;onToggle:(on:boolean)=>void}){
  const raw=s.dynamic;if(!raw)return null;
  if("error" in raw&&!("backfill" in raw))return <details className="mb-fold"><summary>研究层：周期与分配</summary><p className="mb-hint">读取失败：{raw.error}</p></details>;
  const d=raw as DynamicView,b=d.backfill,item=s.items.find(i=>i.key==="dynAllocator");
  const short=d.playbooks.filter(p=>p.tier==="short"),long=d.playbooks.filter(p=>p.tier!=="short");
  const fams=new Map<string,Pb[]>();for(const p of short)(fams.get(p.familyLabel)??fams.set(p.familyLabel,[]).get(p.familyLabel)!).push(p);
  const ib=d.intraday?.bucket??null;
  return <details className="mb-fold" open>
    <summary>研究层：短线打法池（{short.length} 套）周期与分配（{d.allowed.length?`允许 ${d.allowed.length} 套`:"全部只记录"}）</summary>
    <p className="mb-hint">历史下载（先短线 5/15 分钟、1 小时，后 4 小时/日线）：{b.done}/{b.total} 条序列完成（{Math.round(b.pct*100)}%）{b.working?`，正在下 ${b.working.replace("_USDT","")}`:""}
      {b.etaMin?`，预计还要约 ${b.etaMin>=120?`${Math.round(b.etaMin/60)} 小时`:`${b.etaMin} 分钟`}`:""}；
      {Object.entries(b.byIv).map(([iv,x])=>`${ivCn[iv]??iv} ${x.done}/${x.total}（${x.bars} 根，最早 ${x.from??"—"}）`).join("，")}；
      今天外部请求 {b.reqToday} 次，失败累计 {b.errTotal}{b.blocked.length?`，${b.blocked.join("/")} 限流中（先用别的交易所）`:""}{b.pausedUntil?`，三家都限流，暂停到 ${bj(b.pausedUntil)}`:""}。
      历史回放 {d.replay.unitsDone}/{Math.max(d.replay.unitsKnown,d.replay.unitsDone)} 块{d.replay.unitsQueued?`（排队 ${d.replay.unitsQueued}）`:""}，实时评估 {d.replay.liveSeries} 条序列；
      影子交易 {d.shadowTrades} 笔{d.tradesLoaded?"":"（读取中）"}；单步最长 {d.maxStepMs} 毫秒。</p>
    {d.intraday?<p className="mb-hint">BTC/ETH 日内状态（{d.intraday.hour} UTC 收盘）：<b>{d.intraday.label}</b>；1 小时 {d.intraday.trend}，4 小时 {d.intraday.trend4h}，ETH 1 小时 {d.intraday.eth??"—"}；
      24 小时波动 {pc(d.intraday.atrPct,2)}/小时（30 天分位 {Math.round(d.intraday.volPct*100)}%）；现在 {d.intraday.session}。短线打法按这个状态分组统计和分配。</p>
      :<p className="mb-hint">BTC/ETH 日内状态：等 BTC 1 小时历史下载完再算。</p>}
    {d.state?<p className="mb-hint">BTC/ETH 日线状态（{d.state.day} 收盘）：<b>{d.state.label}</b>；BTC 距 100 日均线 {pc(d.state.strength)}，日波动 {pc(d.state.atrPct,2)}（1 年分位 {Math.round(d.state.volPct*100)}%），
      距 90 日高点 {pc(d.state.dd90)}；山寨相对 BTC（20 日）{pc(d.state.altVsBtc)}（{d.state.lead==="ALT"?"山寨更强":d.state.lead==="BTC"?"BTC 更强":"—"}）</p>
      :<p className="mb-hint">BTC/ETH 日线状态：等 BTC 日线历史下载完再算。</p>}
    {[...fams].map(([f,ps])=><details key={f} className="mb-fold" open={ps.some(p=>p.gate?.ok)}>
      <summary>{f}（{ps.length} 套，{ps.reduce((a,p)=>a+p.trades,0)} 笔{ps.some(p=>p.gate?.ok)?"，有允许的":""}）</summary>
      <ol className="mb-list">{ps.map(p=><Row key={p.id} p={p} bucket={ib}/>)}</ol></details>)}
    <details className="mb-fold"><summary>日线 / 4 小时打法（只记录，不参与分配；日线突破做多除外）（{long.length} 套）</summary>
      <ol className="mb-list">{long.map(p=><Row key={p.id} p={p} bucket={d.state?.bucket??null}/>)}</ol></details>
    {!!d.stateHistory.length&&<p className="mb-hint">日线状态变化：{d.stateHistory.slice(-6).map(x=>`${x.day} → ${x.to}`).join("；")}</p>}
    {!!d.events.length&&<details className="mb-fold"><summary>研究层记录（{d.events.length}）</summary><ol className="mb-list">{d.events.map((e,i)=><li key={i}><b>{bj(e.at)} {e.k}</b><span>{e.text}</span></li>)}</ol></details>}
    <p className="mb-hint">规则：每套打法先在历史和实时 K 线上只做影子交易（扣 0.19% 手续费，止损至少 0.8% 或 1 倍 15 分钟波动，最长拿 24 小时）；
      学习不等下载完：现有日线、实时 5 分钟 K 线和每块新到的历史（从最近往前）一到就回放进来；短线按天看周期（近 7 天合计）。见到 ≥1 段赚钱和 ≥1 段亏钱、≥15 笔就开始预测（标【数据少】，证据越多信心越高），
      这时允许的单子仓位按证据缩小（×0.25–1）；赚钱段和亏钱段各 ≥3 次、≥40 笔后算规律确认；当前日内状态下 ≥20 笔、平均 ≥+0.2%/笔、t≥1.5，按天算 t≥{2}、≥10 天，
      且不在会延续的亏钱段，才允许开模拟单，风险 {pc(d.limits.shortRisk*.5,2)}–{pc(d.limits.shortRisk,2)}/笔（按信心）；打法池最多 {d.limits.maxPoolOpen} 笔、每套最多 {d.limits.maxPerPlaybook} 笔。
      {d.lastError?` 最近错误：${d.lastError}`:""}{d.lastAnalyzeAt?` 最近分析 ${bj(d.lastAnalyzeAt)}。`:""}</p>
    {item&&<div className="fr-owner-session"><button className="fr-text-button" type="button" disabled={busy} onClick={()=>onToggle(!item.on)}>
      {item.on?"关掉 10 动态分配（打法池只记录；日线突破回到开关 9 单独控制）":"打开 10 动态分配"}</button></div>}
    <p className="mb-hint">起始 {day(d.backfill.startedAt?d.backfill.startedAt/1000:null)} · {d.version}</p>
  </details>;
}
