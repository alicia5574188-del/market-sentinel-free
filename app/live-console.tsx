"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { OperatorRequestError, operatorRequest, numberText as num, signedText as signed, operatorTime as time, contractText,
  holdingTime, livePositionMark, type AuthSession, type CredentialStatus, type CredentialVerification,
  type LivePosition, type LiveRuntime, type OperatorRuntime } from "../lib/operator-ui.ts";

import {recordWindows,archivePage} from "../lib/record-view.ts";
import {ArchivePagination} from "./record-controls.tsx";
type HistoryView={history:LivePosition[];checkedAt:number|null;error:string|null;pending:number;updating:boolean};
type Props = { auth: AuthSession|null; runtime: OperatorRuntime|null; onSession: (session:AuthSession)=>void;
  onLive: (live:LiveRuntime)=>void; onRefresh: ()=>void; view?:"trade"|"system" };
type Section = "account" | "positions" | "history" | "archive";

export default function LiveConsole({auth,runtime,onSession,onLive,onRefresh,view="trade"}:Props) {
  // A newly opened LIVE tab starts with account equity, not an old scroll offset.
  useEffect(()=>{window.scrollTo({top:0,behavior:"auto"});},[]);
  const [section,setSection]=useState<Section>("account"),[clock,setClock]=useState(0);
  const [password,setPassword]=useState(""),[apiKey,setApiKey]=useState(""),[apiSecret,setApiSecret]=useState("");
  const [credential,setCredential]=useState<CredentialStatus|null>(null),[verification,setVerification]=useState<CredentialVerification|null>(null);
  const [busy,setBusy]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const [confirmEnable,setConfirmEnable]=useState(false),[confirmDelete,setConfirmDelete]=useState(false);
  const [archiveIndex,setArchiveIndex]=useState(0),[historyView,setHistoryView]=useState<HistoryView|null>(null),[historyError,setHistoryError]=useState<string|null>(null);
  useEffect(()=>{
    if(view!=="trade"||!auth?.authenticated||(section!=="history"&&section!=="archive"))return;
    let active=true,reading=false;
    const load=async()=>{if(reading)return;reading=true;try{const value=await operatorRequest<HistoryView>("/api/live/history");if(active){setHistoryView(value);setHistoryError(null);}}
      catch(e){if(active)setHistoryError(e instanceof Error?e.message:"历史记录读取失败");}finally{reading=false;}};
    void load();const timer=setInterval(()=>void load(),10000);return()=>{active=false;clearInterval(timer);};
  },[auth?.authenticated,auth?.memberId,section,view]);
  const submitting=useRef(false);
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    let active=true;
    if(!auth?.authenticated)return;
    void operatorRequest<{credential:CredentialStatus}>("/api/live/credentials").then(p=>{if(active)setCredential(p.credential);})
      .catch(e=>{if(active){setError(e instanceof Error?e.message:"读取API状态失败");if(e instanceof OperatorRequestError&&e.status===401)onSession({...auth,authenticated:false});}});
    return()=>{active=false;};
  },[auth,onSession]);

  const live=auth?.authenticated?runtime?.live:undefined;
  const enabled=live?.requestedEnabled??runtime?.liveMode?.requestedEnabled??false;
  const positions=Object.values(live?.positions??{}).filter((p):p is LivePosition=>p?.status==="OPEN");
  const closed=[...new Map([...(live?.history??[]),...Object.values(live?.positions??{}).filter((p):p is LivePosition=>p?.status==="CLOSED"),...(historyView?.history??[])]
    .map(p=>[p.id,p])).values()].sort((a,b)=>(b.exitAt??0)-(a.exitAt??0));
  const records=recordWindows(closed,p=>p.exitAt??0),archive=archivePage(records.archive,archiveIndex);
  const mirror=live?.mirror??runtime?.liveMirror;
  const entries=Object.values(live?.entries??{}).filter(e=>e&&!["FILLED","CANCELLED","FINISHED","REJECTED"].includes(e.status));
  const canControl=Boolean(auth?.authenticated&&live&&runtime);
  const canEnable=canControl&&Boolean(credential?.configured)&&!busy;
  const clearSensitive=()=>{setHistoryView(null);setHistoryError(null);setPassword("");setApiKey("");setApiSecret("");setCredential(null);setVerification(null);setConfirmEnable(false);setConfirmDelete(false);};
  async function action(name:string,task:()=>Promise<void>){
    if(submitting.current)return;
    submitting.current=true;setBusy(name);setError(null);setNotice(null);
    try{await task();}catch(e){setError(e instanceof Error?e.message:"操作失败");
      if(e instanceof OperatorRequestError&&e.status===401){clearSensitive();onSession({configured:auth?.configured??true,authenticated:false,username:"owner"});}}
    finally{submitting.current=false;setBusy(null);onRefresh();}
  }
  const login=(event:FormEvent)=>{event.preventDefault();void action("login",async()=>{
    const session=await operatorRequest<AuthSession>("/api/auth/login","POST",{username:"owner",password});
    if(!session.authenticated)throw new Error("登录未得到确认");
    setPassword("");onSession({...session,configured:true});setNotice("所有者已登录。登录不会改变实盘开关。");
  });};
  const logout=()=>void action("logout",async()=>{
    await operatorRequest("/api/auth/logout","POST");clearSensitive();onSession({configured:true,authenticated:false,username:"owner"});
    setNotice("已退出所有者账户；实盘开关保持原状态。");
  });
  const setMode=(value:boolean)=>{
    if(!canControl||(value&&!canEnable))return;
    void action("mode",async()=>{
      const result=await operatorRequest<{live?:LiveRuntime}>("/api/live/mode","POST",{enabled:value});
      if(!result.live)throw new Error("未收到完整实盘状态，请核对服务器结果，不重复提交。");
      onLive(result.live);setConfirmEnable(false);
      setNotice(result.live.requestedEnabled?"服务器已确认你的开启请求；运行状态以账户核对结果为准。":"服务器已确认关闭；撤单结果请查看执行记录。");
    });
  };
  const saveCredential=(event:FormEvent)=>{event.preventDefault();if(!auth?.authenticated||enabled)return;
    void action("credential",async()=>{
      const result=await operatorRequest<{credential:CredentialStatus;verification?:CredentialVerification}>("/api/live/credentials","PUT",{apiKey,apiSecret});
      if(!result.credential)throw new Error("未收到API保存结果");
      setCredential(result.credential);setVerification(result.verification??null);setApiKey("");setApiSecret("");
      setNotice("API已验证并加密保存。实盘不会自动开启。");
    });
  };
  const deleteCredential=()=>{if(!auth?.authenticated||enabled||positions.length||entries.length)return;
    void action("delete",async()=>{const result=await operatorRequest<{credential:CredentialStatus}>("/api/live/credentials","DELETE");
      setCredential(result.credential);setVerification(null);setConfirmDelete(false);setNotice("API已删除，实盘保持关闭。");});
  };
  const marks=positions.map(p=>livePositionMark(p,runtime,clock));
  const floating=live&&marks.every(m=>m.pnl!==null)?marks.reduce((sum,m)=>sum+(m.pnl??0),0):null;
  const audits=[...(live?.auditEvents??[])].sort((a,b)=>b.observedAt-a.observedAt);
  const tabs:[Section,string][]=[["account","账户"],["positions","持仓"],["history","记录"],["archive","归档"]];
  const copied=mirror?.eligibleCopiedCount??0,eligible=mirror?.eligibleSourceCount??0,missing=mirror?.eligibleMissingCount??0;
  const copyHealthy=Boolean(mirror?.connected&&!mirror?.error&&missing===0);
  const copyLabel=!mirror?"读取中":copyHealthy?`${copied} / ${eligible} · 正常`:`${copied} / ${eligible} · ${missing}笔待核对`;

  if(!auth?.authenticated)return <div className="fr-live" data-testid="native-live-console">
    <div className="fr-live-heading"><h1>{view==="system"?"账户与实盘管理":"实盘账户"}</h1><span>未登录</span></div>
    <section className="fr-section fr-owner-login"><div className="fr-section-head"><div><small>所有者权限</small><h2>在本页登录</h2></div></div>
      <p className="fr-note">使用本人的登录凭据访问账户。</p>
      <form onSubmit={login} className="fr-form"><label>账户<input value="owner" readOnly autoComplete="username"/></label>
        <label>所有者密码<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" required placeholder="输入原来的所有者密码"/></label>
        {auth?.configured===false&&<p className="fr-error">后台所有者访问码尚未配置。</p>}
        <button className="fr-button" type="submit" disabled={Boolean(busy)||!auth||!auth.configured||password.length<16}>{busy==="login"?"验证中…":"登录所有者账户"}</button>
      </form></section></div>;

  if(view==="system")return <div className="fr-live fr-live-system" data-testid="live-system-console">
    <div className="fr-live-heading"><h1>账户与实盘管理</h1><span>{auth.username} · {enabled?live?.operational?"实盘运行中":"实盘等待核对":"实盘已关闭"}</span></div>
    {error&&<div className="fr-error" role="alert"><b>操作未完成</b><p>{error}</p></div>}
    {notice&&<div className="fr-notice" role="status">{notice}</div>}
    <section className="fr-section"><div className="fr-section-head"><div><small>复制诊断</small><h2>模拟 → 实盘</h2></div><span className={copyHealthy?"fr-positive":missing||mirror?.error?"fr-negative":""}>{copyLabel}</span></div>
      <div className="fr-four"><Metric label="应跟随" value={num(mirror?.eligibleSourceCount,0)}/><Metric label="已复制" value={num(mirror?.eligibleCopiedCount,0)}/><Metric label="待确认" value={num(mirror?.pendingCount,0)}/><Metric label="最低量阻塞" value={num(mirror?.minimumSizeBlockedCount,0)}/></div>
      {mirror?.error&&<p className="fr-error">{mirror.error}</p>}
      {mirror?.rows.filter(r=>r.status!=="COPIED"&&r.status!=="EXCLUDED_BEFORE_ENABLE").map(r=><p className="fr-diagnostic-row" key={r.sourceId}><b>{r.symbol.replace("_"," / ")}</b><span>{r.reason??r.status}</span></p>)}
      <details className="fr-details"><summary>复制规则与边界</summary><p className="fr-note">当前模拟账户。按权益比例复制，沿用源单杠杆、保护和退出依据。实际成交以Gate回报为准。</p><p className="fr-note">跟随起点 {time(mirror?.enabledAt)}。开启前旧单不补开；之后的新模拟单按固定账户比例复制。交易所最低张数、真实可用保证金、价格越过止损或不利入场偏差过大时会明确阻止，不会伪装成已复制。</p></details>
    </section>
    <section className="fr-section"><div className="fr-section-head"><div><small>Gate成交</small><h2>实盘累计成交额</h2></div><span>已确认成交</span></div>
      <div className="fr-three"><Metric label="系统标记成交" value={`${num(live?.turnover?.systemTagged)} U`}/><Metric label="全账户成交" value={`${num(live?.turnover?.total)} U`}/><Metric label="核对成交明细" value={num(live?.turnover?.fillCount,0)}/></div>
      <p className="fr-note">全账户成交可能包含手工成交；日常交易观察以系统标记成交和订单记录为准。核对至 {time(live?.turnover?.checkedThrough)}。</p>
      {live?.turnover?.error&&<p className="fr-error">{live.turnover.error}</p>}
    </section>
    <section className="fr-section"><div className="fr-section-head"><div><small>诊断</small><h2>最近执行记录</h2></div><span>最近10条</span></div>
      {audits.length?<div className="fr-journal">{audits.slice(0,10).map(e=><article key={e.id}><time>{time(e.observedAt)}</time><div><b>{e.symbol?.replace("_"," / ")??"实盘控制"} · {e.stage}</b><p>{e.reason}</p></div></article>)}</div>:<p className="fr-note">暂无执行异常或保护事件。</p>}
      {Object.values(live?.entrySkips??{}).map(e=>e&&<div key={e.planId} className="fr-error"><b>{e.symbol} · 未成交</b><p>{e.reason}</p>{e.sizing&&<p>比例目标 {contractText(e.sizing.targetContracts)} 张 / {num(e.sizing.targetNotional,4)} U；交易所最低 {contractText(e.sizing.minimumContracts)} 张 / {num(e.sizing.minimumNotional,4)} U。</p>}</div>)}
    </section>
    <section className="fr-section"><div className="fr-section-head"><div><small>API 管理</small><h2>Gate API</h2></div><button type="button" className="fr-text-button" onClick={onRefresh}>刷新状态 ↻</button></div>
      <div className="fr-setting"><div><h3>API状态</h3><p>{credential?.keyHint??"密钥内容不会回显"}</p></div><b>{credential?credential.configured?"已保存":"未配置":"读取中"}</b></div>
      <div className="fr-setting"><div><h3>最近账户核对</h3><p>{live?.lastError??"以Gate账户回报为准。"}</p></div><b>{time(live?.lastSyncAt)}</b></div>
      <form className="fr-form" onSubmit={saveCredential}><label>API Key<input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="填写新的Gate API Key" disabled={enabled}/></label>
        <label>API Secret<input type="password" autoComplete="new-password" spellCheck={false} value={apiSecret} onChange={e=>setApiSecret(e.target.value)} placeholder="填写新的Gate API Secret" disabled={enabled}/></label>
        <p className="fr-note">只有添加或更换API时需要填写。保存API不会自动开启实盘；实盘开启时不能更换或删除。</p>
        <button className="fr-button" type="submit" disabled={Boolean(busy)||enabled||apiKey.trim().length<8||apiSecret.trim().length<8}>{busy==="credential"?"验证中…":credential?.configured?"验证并更换 API":"验证并保存 API"}</button></form>
      {verification&&<p className="fr-notice">验证：权益 {num(verification.equity)} U · 持仓 {verification.positions} · 普通挂单 {verification.orders} · 条件单 {verification.conditionalOrders}</p>}
      {credential?.configured&&<button className="fr-text-button danger" type="button" disabled={Boolean(busy)||enabled||positions.length>0||entries.length>0} onClick={()=>setConfirmDelete(true)}>删除已保存 API</button>}
      {confirmDelete&&<div className="fr-inline-confirm"><h3>删除API会移除这组连接凭据</h3><p>服务器只有在实盘关闭、Gate无持仓和挂单时才允许删除。</p>
        <div className="fr-action-row"><button className="fr-button danger" type="button" disabled={Boolean(busy)||enabled||positions.length>0||entries.length>0} onClick={deleteCredential}>确认删除 API</button><button className="fr-button secondary" type="button" disabled={Boolean(busy)} onClick={()=>setConfirmDelete(false)}>保留 API</button></div></div>}
    </section>
    <div className="fr-owner-session"><span>● {auth.username} · 已登录</span><button className="fr-text-button" type="button" disabled={Boolean(busy)} onClick={logout}>退出登录</button></div>
  </div>;

  return <div className="fr-live" data-testid="native-live-console">
    <div className="fr-live-heading"><h1>实盘账户</h1><span>{enabled?live?.operational?"运行中":"等待核对":"已关闭"}</span></div>
    <section className="fr-stats fr-live-summary" data-testid="live-equity-first"><LiveStat title="实盘账户权益" value={`${num(live?.equity)} U`} detail="Gate余额＋持仓浮盈"/>
      <LiveStat title="可用保证金" value={`${num(live?.available)} U`} detail="Gate可用余额"/>
      <LiveStat title="持仓浮动盈亏" value={`${signed(floating)} U`} detail="Gate实际回报"/>
      <LiveStat title="当前持仓" value={live?`${positions.length} 笔`:"—"} detail={entries.length?`待执行 ${entries.length} 笔`:"无待执行订单"}/></section>
    <div className="fr-account-line"><span>账户核对 {time(live?.lastSyncAt)}</span><b className={copyHealthy?"fr-positive":missing||mirror?.error?"fr-negative":""}>复制一致性 {copyLabel}</b></div>
    {live?.lastError&&<p className="fr-error" role="status">执行提示：{live.lastError}</p>}
    {error&&<div className="fr-error" role="alert"><b>操作未完成</b><p>{error}</p></div>}
    {notice&&<div className="fr-notice" role="status">{notice}</div>}
    <nav className="fr-live-tabs fr-live-record-tabs" aria-label="实盘子导航">{tabs.map(([id,title])=><button type="button" key={id} aria-current={section===id?"page":undefined}
      className={section===id?"selected":""} onClick={()=>setSection(id)}>{title}</button>)}</nav>

    {section==="account"&&<>
      <section className="fr-section fr-live-holdings" data-testid="live-holdings-first">
        <div className="fr-section-head"><h2>当前持仓</h2><span>{positions.length} 笔</span></div>
        {!live?<LiveEmpty title="正在读取实盘账户" text="仅显示本账户的实际持仓。"/>:!positions.length?<LiveEmpty title="当前没有实盘持仓" text={entries.length?`有 ${entries.length} 笔待执行订单。`:"等待新的模拟订单。"} />:
          <div className="fr-position-list">{positions.map(p=>{const m=livePositionMark(p,runtime,clock);return <details key={p.id} className="fr-position-row"><summary>
            <span><b>{p.symbol.replace("_"," / ")}</b><small>{p.side==="LONG"?"多单":"空单"} · {num(p.leverage,0)}× · 保证金 {num(m.margin)} U</small></span>
            <span className={m.pnl==null?"":m.pnl>=0?"fr-positive":"fr-negative"}><b>{m.pnl==null?"待更新":`${signed(m.pnl)} U`}</b><small>{entryDeltaText(p)} · 展开</small></span>
            </summary><LivePositionCard position={p} runtime={runtime} now={clock}/></details>;})}</div>}
        {!!entries.length&&<button type="button" className="fr-text-button" onClick={()=>setSection("positions")}>查看 {entries.length} 笔待执行订单 →</button>}
      </section>
      <section id="live-control" className="fr-section fr-live-switch-panel" aria-label="实盘交易开关">
        <div><span className="fr-overline">实盘交易开关</span><h2>{!runtime?"读取状态…":enabled?live?.operational?"已开启 · 正在运行":"已请求开启 · 等待核对":"已关闭"}</h2>
          <p>只复制本次开启后新产生的模拟单；已有实盘持仓继续保留保护并跟随源单退出。</p></div>
        <button type="button" className={`fr-switch ${enabled?"is-enabled":""}`} role="switch" aria-label="实盘交易开关"
          aria-checked={enabled} disabled={!canControl||Boolean(busy)||(!enabled&&!credential?.configured)}
          onClick={()=>enabled?setMode(false):setConfirmEnable(true)}><span/><b>{busy==="mode"?"核对中":enabled?"开启":"关闭"}</b></button>
        {confirmEnable&&!enabled&&<div className="fr-inline-confirm" role="group" aria-label="确认开启实盘">
          <h3>确认只跟随开启后的新模拟单？</h3><p>开启前已有模拟持仓不会补开。新订单按固定比例复制；实际数量、成交价和费用以Gate回报为准。</p>
          <div className="fr-action-row"><button className="fr-button" type="button" disabled={!canEnable} onClick={()=>setMode(true)}>确认开启实盘</button>
            <button className="fr-button secondary" type="button" disabled={Boolean(busy)} onClick={()=>setConfirmEnable(false)}>取消</button></div></div>}
      </section>
      {(missing>0||mirror?.error)&&<section className="fr-section fr-parity-alert"><div className="fr-section-head"><h2>复制需要核对</h2><span>{missing} 笔</span></div>
        {mirror?.rows.filter(r=>r.status!=="COPIED"&&r.status!=="EXCLUDED_BEFORE_ENABLE").slice(0,4).map(r=><p className="fr-diagnostic-row" key={r.sourceId}><b>{r.symbol.replace("_"," / ")}</b><span>{r.reason??r.status}</span></p>)}
      </section>}
    </>}

    {section==="positions"&&<section className="fr-section"><div className="fr-section-head"><h2>当前持仓与待执行</h2><span>Gate真实记录</span></div>
      {!live?<LiveEmpty title="正在读取实盘账户" text="正在读取Gate账户状态。"/>:
        !positions.length&&!entries.length?<LiveEmpty title="当前没有实盘持仓或待执行订单" text="新的模拟订单产生后会按复制规则执行。"/>:
        <div className="fr-rule-grid">{positions.map(p=><LivePositionCard key={p.id} position={p} runtime={runtime} now={clock}/>)}
          {entries.map(e=>e&&<article className="fr-trade" key={e.planId}><header><div><small>待执行 · {e.side==="LONG"?"多单":"空单"}</small><h3>{e.symbol.replace("_"," / ")}</h3></div><strong>等待Gate</strong></header>
            <dl><Pair label="模拟入场价" value={num(e.parity?.sourceEntryPrice,5)}/><Pair label="当前复制盘口" value={num(e.parity?.copyQuotePrice??e.trigger,5)}/><Pair label="保护止损" value={num(e.invalidation,5)}/><Pair label="名义金额" value={`${num(e.notional)} U`}/>
              <Pair label="保证金 / 杠杆" value={`${num(e.margin)} U / ${num(e.leverage,0)}×`}/><Pair label="复制延迟" value={latency(e.parity?.copyDelayMs)}/></dl>
            <p className="fr-note">{e.lastError??`服务器状态：${e.status}`}</p></article>)}</div>}
    </section>}

    {(section==="history"||section==="archive")&&<section className="fr-section" data-testid={section==="history"?"live-history":"live-archive"}>
      <div className="fr-section-head"><h2>{section==="history"?"已平仓实盘记录":"归档记录"}</h2><span>{section==="history"?"最新10条":"更早记录"}</span></div>
      {(section==="history"?records.recent:archive.items).length?<div className="fr-rule-grid">{(section==="history"?records.recent:archive.items).map(p=><LivePositionCard key={p.id} position={p} runtime={runtime} now={clock}/>)}</div>:<LiveEmpty title="暂无已平仓记录" text="订单平仓后自动保留。"/>}
      {(historyError||historyView?.error)&&<p className="fr-error">{historyError??historyView?.error}</p>}
      {!!historyView?.pending&&<p className="fr-note">{historyView.pending}条Gate结算待核对；缺失值不会当成零。</p>}
      {section==="archive"&&<ArchivePagination page={archive.page} pages={archive.pages} onPage={setArchiveIndex}/>}
    </section>}
  </div>;
}
function Pair({label,value}:{label:string;value:string}){return<div><dt>{label}</dt><dd>{value}</dd></div>;}
function Metric({label,value}:{label:string;value:string}){return<div><small>{label}</small><b>{value}</b></div>;}
function LiveStat({title,value,detail}:{title:string;value:string;detail:string}){return<article><small>{title}</small><strong>{value}</strong><p>{detail}</p></article>;}
function LiveEmpty({title,text}:{title:string;text:string}){return<div className="fr-empty"><span aria-hidden="true">◎</span><h3>{title}</h3><p>{text}</p></div>;}
function latency(value:number|undefined){return typeof value==="number"&&Number.isFinite(value)?value<1000?`${Math.round(value)} ms`:`${(value/1000).toFixed(2)} s`:"—";}
function paperSource(position:LivePosition,runtime:OperatorRuntime|null){
  const forward=runtime?.forward;return forward?.positions.find(t=>t.id===position.id)??forward?.history.find(t=>t.id===position.id)??null;
}
function adverseEntryDelta(position:LivePosition){
  const source=position.parity?.sourceEntryPrice;if(!(source&&position.entryPrice>0))return null;
  const d=position.side==="LONG"?1:-1;return d*(position.entryPrice/source-1);
}
function entryDeltaText(position:LivePosition){
  const v=adverseEntryDelta(position);if(v==null)return "入场偏差 —";
  return `入场 ${v>0?"+":""}${(v*100).toFixed(3)}%${v>0?" 不利":v<0?" 更优":""}`;
}
function comparison(position:LivePosition,runtime:OperatorRuntime|null,now:number){
  const source=paperSource(position,runtime),open=position.status==="OPEN",mark=livePositionMark(position,runtime,now);
  const d=position.side==="LONG"?1:-1,entryAdverse=adverseEntryDelta(position);
  if(!source)return {source:null,entryAdverse,paperRate:null,liveRate:null,rateGap:null,expected:null,actual:null,loss:null,exitAdverse:null};
  if(open){
    const paperRate=d*(source.lastPrice/source.entryPrice-1);
    const liveRate=mark.price&&position.entryPrice>0?d*(mark.price/position.entryPrice-1):null;
    return {source,entryAdverse,paperRate,liveRate,rateGap:liveRate==null?null:liveRate-paperRate,expected:null,actual:mark.pnl,loss:null,exitAdverse:null};
  }
  const actual=position.settlement?.pnl??position.realizedPnl??null;
  const paperRate=source.netPnl!=null&&source.notional>0?source.netPnl/source.notional:null;
  const liveRate=actual!=null&&position.notional>0?actual/position.notional:null;
  const expected=paperRate!=null?paperRate*position.notional:null;
  const exitAdverse=source.exitPrice&&position.exitPrice?(position.side==="LONG"?-1:1)*(position.exitPrice/source.exitPrice-1):null;
  return {source,entryAdverse,paperRate,liveRate,rateGap:paperRate!=null&&liveRate!=null?liveRate-paperRate:null,
    expected,actual,loss:expected!=null&&actual!=null?actual-expected:null,exitAdverse};
}
function CompareBlock({position,runtime,now}:{position:LivePosition;runtime:OperatorRuntime|null;now:number}){
  const c=comparison(position,runtime,now),p=position.parity,closed=position.status==="CLOSED";
  if(!c.source&&!p)return null;
  const cls=(v:number|null,adversePositive=false)=>v==null?"":(adversePositive?v<=0:v>=0)?"fr-positive":"fr-negative";
  return <div className="fr-compare">
    <div className="fr-compare-head"><b>模拟 ↔ 实盘</b><span>{closed?"已平仓标准化对照":"当前价格对照"}</span></div>
    {closed&&c.paperRate!=null&&c.liveRate!=null?<div className="fr-compare-grid">
      <Metric label="模拟净收益率" value={`${signed(c.paperRate*100,3)}%`}/><Metric label="实盘净收益率" value={`${signed(c.liveRate*100,3)}%`}/>
      <div><small>收益率偏差</small><b className={cls(c.rateGap)}>{c.rateGap==null?"—":`${signed(c.rateGap*100,3)}个百分点`}</b></div>
      <Metric label="按实盘名义额折算应得" value={c.expected==null?"—":`${signed(c.expected)} U`}/>
      <Metric label="Gate实际结算" value={c.actual==null?"待结算":`${signed(c.actual)} U`}/>
      <div><small>执行损耗 / 改善</small><b className={cls(c.loss)}>{c.loss==null?"—":`${signed(c.loss)} U`}</b></div>
    </div>:c.paperRate!=null?<div className="fr-compare-grid">
      <Metric label="模拟价格收益" value={`${signed(c.paperRate*100,3)}%`}/><Metric label="实盘价格收益" value={c.liveRate==null?"待更新":`${signed(c.liveRate*100,3)}%`}/>
      <div><small>价格表现偏差</small><b className={cls(c.rateGap)}>{c.rateGap==null?"—":`${signed(c.rateGap*100,3)}个百分点`}</b></div>
    </div>:null}
    <div className="fr-compare-prices"><span>模拟入场 <b>{num(p?.sourceEntryPrice??c.source?.entryPrice,5)}</b></span><span>实盘入场 <b>{num(position.entryPrice,5)}</b></span>
      <span className={cls(c.entryAdverse,true)}>入场偏差 <b>{c.entryAdverse==null?"—":`${signed(c.entryAdverse*100,3)}%`}</b></span>
      {closed&&c.source?.exitPrice&&<><span>模拟出场 <b>{num(c.source.exitPrice,5)}</b></span><span>实盘出场 <b>{num(position.exitPrice,5)}</b></span><span className={cls(c.exitAdverse,true)}>出场偏差 <b>{c.exitAdverse==null?"—":`${signed(c.exitAdverse*100,3)}%`}</b></span></>}
      <span>复制延迟 <b>{latency(p?.submitDelayMs??p?.copyDelayMs)}</b></span></div>
  </div>;
}
function LivePositionCard({position:p,runtime,now}:{position:LivePosition;runtime:OperatorRuntime|null;now:number}){
  const open=p.status==="OPEN",mark=livePositionMark(p,runtime,now),settlement=p.settlement,pnl=open?mark.pnl:settlement?.pnl??p.realizedPnl;
  const pnlRate=!open&&pnl!=null&&p.notional>0?pnl/p.notional:null;
  return <article className="fr-trade fr-trade-unified"><header><div><small>{open?"持仓中":"已平仓"} · {p.side==="LONG"?"多单":"空单"}</small><h3>{p.symbol.replace("_"," / ")}</h3></div>
    <strong className={pnl==null?"":pnl>=0?"fr-positive":"fr-negative"}>{pnl==null?open?"待更新":"待结算":`${signed(pnl)} U`}<small>{pnlRate==null?"":` · ${signed(pnlRate*100,3)}%`}</small></strong></header>
    <CompareBlock position={p} runtime={runtime} now={now}/>
    <dl><Pair label="入场价" value={num(p.entryPrice,5)}/><Pair label={open?"当前价格":"出场价"} value={num(open?mark.price:p.exitPrice,5)}/>
      <Pair label="保护止损" value={num(p.stopPrice??p.currentStop,5)}/><Pair label="名义金额" value={`${num(p.notional)} U`}/>
      <Pair label="保证金 / 杠杆" value={`${num(open?mark.margin:p.margin)} U / ${num(p.leverage,0)}×`}/><Pair label="合约数量" value={contractText(Math.abs(p.exchangeSize))}/>
      <Pair label="进场时间" value={time(p.entryAt)}/><Pair label="出场时间" value={open?"持仓中":time(p.exitAt)}/>
      <Pair label="持仓时长" value={holdingTime(p.entryAt,open?now:p.exitAt??0)}/></dl>
    {!open&&settlement&&<details className="fr-details"><summary>Gate结算明细</summary><dl><Pair label="仓位盈亏" value={`${signed(settlement.pricePnl)} U`}/><Pair label="手续费收支" value={`${signed(settlement.fees)} U`}/><Pair label="资金费收支" value={`${signed(settlement.funding)} U`}/><Pair label="交易所平仓时间" value={time(settlement.closedAt)}/></dl></details>}
    {p.exitReason&&<p className="fr-trade-reason">退出原因：{p.exitReason}</p>}
    {p.parity&&<details className="fr-details"><summary>执行与复制详情</summary><p className="fr-note">源单 {p.parity.sourceId} · 规则 {p.parity.sourceRuleId}<br/>固定比例 {num(p.parity.ratio,6)} · 目标名义额 {num(p.parity.targetNotional)} U · 源单杠杆 {num(p.parity.sourceLeverage,0)}×<br/>
      首次复制盘口 {num(p.parity.copyQuotePrice,5)} · 提交盘口 {num(p.parity.submitQuotePrice,5)} · Gate成交 {num(p.parity.exchangeEntryPrice??p.entryPrice,5)}<br/>
      首次识别 {latency(p.parity.copyDelayMs)} · 提交 {latency(p.parity.submitDelayMs)}{p.parity.discrepancy?` · ${p.parity.discrepancy}`:""}</p>
      <a className="fr-text-button" href={`/api/live/source?id=${encodeURIComponent(p.parity.sourceId)}`} target="_blank" rel="noreferrer">查看完整模拟源单映射 ↗</a></details>}
  </article>;
}
