"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { OperatorRequestError, operatorRequest, numberText as num, signedText as signed, operatorTime as time, contractText,
  holdingTime, livePositionMark, type AuthSession, type CredentialStatus, type CredentialVerification,
  type LivePosition, type LiveRuntime, type OperatorRuntime } from "../lib/operator-ui.ts";

import {recordWindows,archivePage} from "../lib/record-view.ts";
import {ArchivePagination} from "./record-controls.tsx";
type HistoryView={history:LivePosition[];checkedAt:number|null;error:string|null;pending:number;updating:boolean};
type Props = { auth: AuthSession|null; runtime: OperatorRuntime|null; onSession: (session:AuthSession)=>void;
  onLive: (live:LiveRuntime)=>void; onRefresh: ()=>void };
type Section = "account" | "positions" | "history" | "archive" | "logs" | "api";

export default function LiveConsole({auth,runtime,onSession,onLive,onRefresh}:Props) {
  // A newly opened LIVE tab starts with account equity, not an old scroll offset.
  useEffect(()=>{window.scrollTo({top:0,behavior:"auto"});},[]);
  const [section,setSection]=useState<Section>("account"),[clock,setClock]=useState(0);
  const [password,setPassword]=useState(""),[apiKey,setApiKey]=useState(""),[apiSecret,setApiSecret]=useState("");
  const [credential,setCredential]=useState<CredentialStatus|null>(null),[verification,setVerification]=useState<CredentialVerification|null>(null);
  const [busy,setBusy]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const [confirmEnable,setConfirmEnable]=useState(false),[confirmDelete,setConfirmDelete]=useState(false);
  const [archiveIndex,setArchiveIndex]=useState(0),[historyView,setHistoryView]=useState<HistoryView|null>(null),[historyError,setHistoryError]=useState<string|null>(null);
  useEffect(()=>{
    if(!auth?.authenticated||(section!=="history"&&section!=="archive"))return;
    let active=true,reading=false;
    const load=async()=>{if(reading)return;reading=true;try{const value=await operatorRequest<HistoryView>("/api/live/history");if(active){setHistoryView(value);setHistoryError(null);}}
      catch(e){if(active)setHistoryError(e instanceof Error?e.message:"历史记录读取失败");}finally{reading=false;}};
    void load();const timer=setInterval(()=>void load(),10000);return()=>{active=false;clearInterval(timer);};
  },[auth?.authenticated,auth?.memberId,section]);
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
  const tabs:[Section,string][]=[["account","账户"],["positions","持仓"],["history","记录"],["archive","归档"],["logs","日志"],["api","API"]];

  return <div className="fr-live" data-testid="native-live-console">
    <div className="fr-live-heading"><h1>实盘账户</h1><span>{auth?.username??"未登录"} · {enabled?live?.operational?"运行中":"等待核对":"已关闭"}</span></div>
    {auth?.authenticated&&<>
        <section className="fr-stats fr-live-summary" data-testid="live-equity-first"><LiveStat title="实盘账户权益" value={`${num(live?.equity)} U`} detail="Gate余额＋已核对持仓浮盈"/>
          <LiveStat title="可用保证金" value={`${num(live?.available)} U`} detail="Gate可用余额"/>
          <LiveStat title="持仓浮动盈亏" value={`${signed(floating)} U`} detail={marks.some(m=>!m.fresh)?"Gate最近回报（等待更新）；不是最终净收益":"Gate持仓实际回报；不是最终净收益"}/>
          <LiveStat title="当前持仓" value={live?`${positions.length} 笔`:"—"} detail={`待执行 ${live?entries.length:"—"} 笔`}/></section>
      <p className="fr-live-check-time">账户核对 {time(live?.lastSyncAt)} · <a href="#live-control" onClick={()=>setSection("account")}>管理实盘开关</a></p>
      {live?.lastError&&<p className="fr-error" role="status">执行提示：{live.lastError}</p>}
    </>}
    {error&&<div className="fr-error" role="alert"><b>操作未完成</b><p>{error}</p></div>}
    {notice&&<div className="fr-notice" role="status">{notice}</div>}
    {!auth?.authenticated?<section className="fr-section fr-owner-login"><div className="fr-section-head"><div><small>所有者权限</small><h2>在本页登录</h2></div></div>
      <p className="fr-note">使用本人的登录凭据访问账户。</p>
      <form onSubmit={login} className="fr-form"><label>账户<input value="owner" readOnly autoComplete="username"/></label>
        <label>所有者密码<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" required placeholder="输入原来的所有者密码"/></label>
        {auth?.configured===false&&<p className="fr-error">后台所有者访问码尚未配置。</p>}
        <button className="fr-button" type="submit" disabled={Boolean(busy)||!auth||!auth.configured||password.length<16}>{busy==="login"?"验证中…":"登录所有者账户"}</button>
      </form></section>:<>
      <nav className="fr-live-tabs fr-live-record-tabs" aria-label="实盘子导航">{tabs.map(([id,title])=><button type="button" key={id} aria-current={section===id?"page":undefined}
        className={section===id?"selected":""} onClick={()=>setSection(id)}>{title}</button>)}</nav>
      {section==="account"&&<>
        <section className="fr-section fr-live-holdings" data-testid="live-holdings-first">
          <div className="fr-section-head"><h2>当前实盘持仓</h2><span>{live?`${positions.length} 笔`:"读取中"}</span></div>
          {!live?<LiveEmpty title="正在读取实盘账户" text="仅显示本账户的实际持仓。"/>:!positions.length?<p className="fr-note">当前没有实盘持仓；待执行 {entries.length} 笔。</p>:
            <div className="fr-position-list">{positions.map(p=>{const m=livePositionMark(p,runtime,clock);return <details key={p.id} className="fr-position-row"><summary>
              <span><b>{p.symbol.replace("_"," / ")}</b><small>{p.side==="LONG"?"多单":"空单"} · {num(p.leverage,0)}× · 保证金 {num(m.margin)} U</small></span>
              <span className={m.pnl==null?"":m.pnl>=0?"fr-positive":"fr-negative"}><b>{m.pnl==null?"待更新":`${signed(m.pnl)} U`}</b><small>{m.rate==null?"—":`${signed(m.rate*100)}%`} · 展开</small></span>
              </summary><LivePositionCard position={p} runtime={runtime} now={clock}/></details>;})}</div>}
          {!!entries.length&&<button type="button" className="fr-text-button" onClick={()=>setSection("positions")}>查看 {entries.length} 笔待执行挂单及完整持仓详情 →</button>}
        </section>
    <section id="live-control" className="fr-section fr-live-switch-panel" aria-label="实盘交易开关">
      <div><span className="fr-overline">实盘交易开关</span><h2>{!runtime?"读取开关状态…":enabled?live?.operational?"已开启 · 正在运行":"已请求开启 · 等待核对":"已关闭"}</h2>
        <p>{auth?.authenticated?"仅跟随本次开启后产生的新模拟单。":"所有者登录后可操作开关；访客不能更改。"}</p></div>
      <button type="button" className={`fr-switch ${enabled?"is-enabled":""}`} role="switch" aria-label="实盘交易开关"
        aria-checked={enabled} disabled={!canControl||Boolean(busy)||(!enabled&&!credential?.configured)}
        onClick={()=>enabled?setMode(false):setConfirmEnable(true)}><span/><b>{busy==="mode"?"核对中":enabled?"开启":"关闭"}</b></button>
      {confirmEnable&&auth?.authenticated&&!enabled&&<div className="fr-inline-confirm" role="group" aria-label="确认开启实盘">
        <h3>确认仅跟随开启后新产生的模拟单？</h3><p>本次开启前已存在的模拟持仓不会补开。之后的新模拟单按两账户权益比例复制，沿用杠杆和退出决定。关闭再开启会建立新的跟随起点；实际数量、成交价和费用以Gate回报为准。</p>
        <div className="fr-action-row"><button className="fr-button" type="button" disabled={!canEnable} onClick={()=>setMode(true)}>确认开启实盘</button>
          <button className="fr-button secondary" type="button" disabled={Boolean(busy)} onClick={()=>setConfirmEnable(false)}>暂不开启</button></div></div>}
    </section>
    <details className="fr-section fr-copy-details" data-testid="live-copy-details"><summary>复制状态与未跟随原因</summary>
    <div className="fr-live-source"><span aria-hidden="true">ⓘ</span><p><b>当前复制源：</b>当前模拟账户。按权益比例复制，沿用源单杠杆、保护和退出依据。实际成交以Gate回报为准。</p></div>
    <section className="fr-section"><div className="fr-section-head"><h2>模拟—实盘复制一致性</h2><span>{mirror?.connected?"当前源已接入":"等待源状态"}</span></div>
      <div className="fr-three"><div><small>本次开启后已复制 / 应跟随</small><b>{num(mirror?.eligibleCopiedCount,0)} / {num(mirror?.eligibleSourceCount,0)}</b></div><div><small>应跟随但尚未复制</small><b>{num(mirror?.eligibleMissingCount,0)}</b></div><div><small>源数据或执行阻塞</small><b>{mirror?.error?"需核对":"无源阻塞"}</b></div></div>
      {mirror?.error&&<p className="fr-error">{mirror.error}</p>}
      <div className="fr-three"><div><small>当前模拟持仓</small><b>{num(mirror?.sourceCount,0)}</b></div><div><small>开启后可跟随源单</small><b>{num(mirror?.eligibleSourceCount,0)}</b></div><div><small>已核对实际持仓</small><b>{num(mirror?.copiedCount,0)}</b></div></div>
      <div className="fr-three"><div><small>开启前旧单不跟随</small><b>{num(mirror?.excludedSourceCount,0)}</b></div><div><small>低于真实最低量</small><b>{num(mirror?.minimumSizeBlockedCount,0)}</b></div><div><small>待交易所确认</small><b>{num(mirror?.pendingCount,0)}</b></div></div>
      <p className="fr-note">跟随起点 {time(mirror?.enabledAt)}。不补旧单；已有 {num(mirror?.managedBeforeEnableCount,0)} 笔实盘原仓继续管理。模拟与实盘总持仓数可能不同。</p>
      <p className="fr-note">关闭停止新开仓并撤销系统入场挂单；已有仓位保留保护，继续跟随源单退出，不立即强平。</p>
      {auth?.authenticated&&mirror?.rows.filter(r=>r.status!=="COPIED").map(r=><p className="fr-note" key={r.sourceId}>{r.symbol} · {r.reason??r.status}</p>)}
    </section>
    </details>
        <div className="fr-owner-session"><span>● {auth.username} · 已登录</span><button className="fr-text-button" type="button" disabled={Boolean(busy)} onClick={logout}>退出登录</button></div>
        <section className="fr-section" data-testid="live-turnover"><div className="fr-section-head"><h2>实盘累计成交额</h2><span>USDT · Gate已确认成交</span></div>
          <div className="fr-three"><div><small>开仓＋平仓合计</small><b>{num(live?.turnover?.total)} U</b></div><div><small>开仓成交额</small><b>{num(live?.turnover?.opening)} U</b></div><div><small>平仓成交额</small><b>{num(live?.turnover?.closing)} U</b></div></div>
          <p className="fr-note">统计自 {time(live?.turnover?.startedAt)}，按实际成交ID去重；同一Gate USDT账户含手工成交，不是模拟金额或保证金。失败、挂单和未成交部分不计入。</p>
          <p className="fr-note">其中系统标记成交 {num(live?.turnover?.systemTagged)} U · 已核对 {num(live?.turnover?.fillCount,0)} 笔成交明细（一次订单可分多次成交）。核对至 {time(live?.turnover?.checkedThrough)}{live?.turnover?.catchingUp?" · 仍在分批核对，当前为已确认部分":""}。</p>
          {!!live?.turnover?.unclassified&&<p className="fr-note">另有 {num(live.turnover.unclassified)} U 实际成交开平属性待核对，已计入合计，不猜测分类。</p>}
          {live?.turnover?.error&&<p className="fr-error">成交额更新：{live.turnover.error}。保留此前数值，不影响交易保护。</p>}
        </section>
        <section className="fr-section"><div className="fr-section-head"><h2>连接与权限</h2><button type="button" className="fr-text-button" onClick={onRefresh}>刷新状态 ↻</button></div>
          <div className="fr-setting"><div><h3>API 状态</h3><p>{credential?.keyHint??"密钥内容不会回显"}</p></div><b>{credential?credential.configured?"已保存":"未配置":"读取中"}</b></div>
          <div className="fr-setting"><div><h3>最近账户核对</h3><p>关闭状态也保留最近结果；不会伪装成实时余额。</p></div><b>{time(live?.lastSyncAt)}</b></div>
          <div className="fr-setting"><div><h3>服务器执行状态</h3><p>{live?.lastError??(enabled?"以Gate核对结果为准。":"实盘保持关闭。")}</p></div><b>{live?.operational?"运行中":enabled?"核对中":"未运行"}</b></div>
          <button className="fr-button secondary" type="button" disabled={!canControl||Boolean(busy)||enabled} onClick={()=>setMode(false)}>关闭并撤销系统遗留挂单</button>
          <p className="fr-note">只处理本系统标记的入场挂单，不撤销你的手工订单。持仓及保护状态以服务器核对结果为准。</p></section>
      </>}
      {section==="positions"&&<section className="fr-section"><div className="fr-section-head"><h2>实盘持仓与挂单</h2><span>Gate真实记录</span></div>
        {!live?<LiveEmpty title="正在读取所有者账户" text="正在读取Gate账户状态。"/>:
          !positions.length&&!entries.length?<LiveEmpty title="当前没有实盘持仓或挂单" text="仅显示实际实盘持仓与挂单。"/>:
          <div className="fr-rule-grid">{positions.map(p=><LivePositionCard key={p.id} position={p} runtime={runtime} now={clock}/>)}
            {entries.map(e=>e&&<article className="fr-trade" key={e.planId}><header><h3>{e.symbol.replace("_"," / ")}</h3><span>{e.side==="LONG"?"多单":"空单"} · 待执行</span></header>
              <dl><Pair label="触发价格" value={num(e.trigger,5)}/><Pair label="保护价格" value={num(e.invalidation,5)}/><Pair label="名义金额" value={`${num(e.notional)} U`}/><Pair label="保证金 / 杠杆" value={`${num(e.margin)} U / ${num(e.leverage,0)}×`}/></dl>
              <p className="fr-note">{e.lastError??`服务器状态：${e.status}`}</p>{e.parity&&<p className="fr-note">源单 {e.parity.sourceId} · 固定复制比例 {num(e.parity.ratio,6)}</p>}</article>)}</div>}
      </section>}
      {(section==="history"||section==="archive")&&<section className="fr-section" data-testid={section==="history"?"live-history":"live-archive"}>
        <div className="fr-section-head"><h2>{section==="history"?"已平仓实盘记录":"归档记录"}</h2><span>{section==="history"?"最新10条":"再往前最新50条"}</span></div>
        {(section==="history"?records.recent:archive.items).length?<div className="fr-rule-grid">{(section==="history"?records.recent:archive.items).map(p=><LivePositionCard key={p.id} position={p} runtime={runtime} now={clock}/>)}</div>:<LiveEmpty title="暂无已平仓记录" text="已平仓订单会自动保留在这里。"/>}
        {(historyError||historyView?.error)&&<p className="fr-error">{historyError??historyView?.error}</p>}
        {!!historyView?.pending&&<p className="fr-note">{historyView.pending}条结算待核对。已确认值保留，缺失值不计为零。</p>}
        {section==="archive"&&<ArchivePagination page={archive.page} pages={archive.pages} onPage={setArchiveIndex}/>}
      </section>}
      {section==="logs"&&<>
        <section className="fr-section"><h2>执行与保护记录</h2><div className="fr-journal">{audits.slice(0,10).map(e=><article key={e.id}><time>{time(e.observedAt)}</time><div><b>{e.symbol?.replace("_"," / ")??"实盘控制"} · {e.stage}</b><p>{e.reason}</p></div></article>)}</div>
          {Object.values(live?.entrySkips??{}).map(e=>e&&<div key={e.planId} className="fr-error"><b>{e.symbol} · 未成交</b><p>{e.reason}</p>{e.sizing&&<p>比例目标 {contractText(e.sizing.targetContracts)} 张 / {num(e.sizing.targetNotional,4)} U；交易所最低 {contractText(e.sizing.minimumContracts)} 张 / {num(e.sizing.minimumNotional,4)} U。仅满足此单最低量所需实盘净值约 {num(e.sizing.requiredLiveEquity,4)} U，另需可用保证金；不会擅自补大。</p>}</div>)}
          {!audits.length&&<p className="fr-note">暂无执行事件。开仓、退出、拒单和保护原因会按实际记录显示。</p>}</section>
      </>}
      {section==="api"&&<section className="fr-section"><div className="fr-section-head"><div><small>API 管理</small><h2>Gate合约连接</h2></div><span>{credential?.configured?"已加密保存":"尚未配置"}</span></div>
        <p className="fr-note">仅在添加或更换API时填写；Secret不会回显。</p>
        <div className="fr-setting"><div><h3>{credential?.keyHint??"没有已保存的密钥"}</h3><p>最近验证 {time(credential?.lastVerifiedAt)}</p></div></div>
        <form className="fr-form" onSubmit={saveCredential}><label>API Key<input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="填写新的Gate API Key" disabled={enabled}/></label>
          <label>API Secret<input type="password" autoComplete="new-password" spellCheck={false} value={apiSecret} onChange={e=>setApiSecret(e.target.value)} placeholder="填写新的Gate API Secret" disabled={enabled}/></label>
          <p className="fr-note">保存API不会开启实盘；实盘开启时不能更换或删除。不要为此配置提现权限。</p>
          <button className="fr-button" type="submit" disabled={Boolean(busy)||enabled||apiKey.trim().length<8||apiSecret.trim().length<8}>{busy==="credential"?"验证中…":credential?.configured?"验证并更换 API":"验证并保存 API"}</button></form>
        {verification&&<p className="fr-notice">最近验证：权益 {num(verification.equity)} U · 持仓 {verification.positions} · 普通挂单 {verification.orders} · 条件单 {verification.conditionalOrders}</p>}
        {credential?.configured&&<button className="fr-text-button danger" type="button" disabled={Boolean(busy)||enabled||positions.length>0||entries.length>0} onClick={()=>setConfirmDelete(true)}>删除已保存 API</button>}
        {confirmDelete&&<div className="fr-inline-confirm"><h3>删除API会移除这组连接凭据</h3><p>服务器只有在实盘关闭、Gate无持仓和挂单时才允许删除。</p>
          <div className="fr-action-row"><button className="fr-button danger" type="button" disabled={Boolean(busy)||enabled||positions.length>0||entries.length>0} onClick={deleteCredential}>确认删除 API</button><button className="fr-button secondary" type="button" disabled={Boolean(busy)} onClick={()=>setConfirmDelete(false)}>保留 API</button></div></div>}
      </section>}
    </>}
  </div>;
}
function Pair({label,value}:{label:string;value:string}){return<div><dt>{label}</dt><dd>{value}</dd></div>;}
function LiveStat({title,value,detail}:{title:string;value:string;detail:string}){return<article><small>{title}</small><strong>{value}</strong><p>{detail}</p></article>;}
function LiveEmpty({title,text}:{title:string;text:string}){return<div className="fr-empty"><span aria-hidden="true">◎</span><h3>{title}</h3><p>{text}</p></div>;}
function LivePositionCard({position:p,runtime,now}:{position:LivePosition;runtime:OperatorRuntime|null;now:number}){
  const open=p.status==="OPEN",mark=livePositionMark(p,runtime,now),settlement=p.settlement,pnl=open?mark.pnl:settlement?.pnl??p.realizedPnl;
  return<article className="fr-trade"><header><div><small>{open?"持仓中":"已平仓"} · {p.side==="LONG"?"多单":"空单"}</small><h3>{p.symbol.replace("_"," / ")}</h3></div><strong className={pnl==null?"":pnl>=0?"fr-positive":"fr-negative"}>{pnl==null?open?"待更新":"待结算":`${signed(pnl)} U`}</strong></header>
    <p className="fr-trade-rule">{open?`${mark.fresh?"Gate浮动盈亏":"Gate最近回报"} · ${time(mark.at)}`:settlement?`Gate已实现盈亏 · 核对于 ${time(settlement.checkedAt)}`:"已平仓，等待Gate结算核对"}</p>
    {!open&&pnl!=null&&<p className={`fr-settlement-pnl ${pnl>=0?"fr-positive":"fr-negative"}`}>已实现盈亏：{signed(pnl)} U{p.margin>0?` · ${signed(pnl/p.margin*100)}%（记录保证金）`:""}</p>}
    {!open&&settlement&&<details className="fr-details"><summary>结算明细</summary><dl><Pair label="仓位盈亏" value={`${signed(settlement.pricePnl)} U`}/><Pair label="手续费收支" value={`${signed(settlement.fees)} U`}/><Pair label="资金费收支" value={`${signed(settlement.funding)} U`}/><Pair label="交易所平仓时间" value={time(settlement.closedAt)}/></dl><p className="fr-note">金额直接采用Gate结算回报，费用不重复扣减；百分比按本条记录保证金计算。</p></details>}
    {open&&<p className={mark.rate==null?"fr-note":mark.rate>=0?"fr-positive":"fr-negative"}>浮盈 / Gate保证金：{signed(mark.rate==null?null:mark.rate*100)}%{mark.margin==null?"（保证金回报缺失，不猜测百分比）":""}</p>}
    <dl><Pair label="入场价格" value={num(p.entryPrice,5)}/><Pair label={open?"Gate标记价格":"出场价格"} value={num(open?mark.price:p.exitPrice,5)}/>
      <Pair label="保护止损" value={num(p.stopPrice??p.currentStop,5)}/><Pair label="名义金额" value={`${num(p.notional)} U`}/>
      <Pair label="保证金 / 杠杆" value={`${num(open?mark.margin:p.margin)} U / ${num(p.leverage,0)}×`}/><Pair label="实际合约数量" value={contractText(Math.abs(p.exchangeSize))}/>
      <Pair label="进场时间" value={time(p.entryAt)}/><Pair label="出场时间" value={open?"持仓中":time(p.exitAt)}/>
      <Pair label="持仓时长" value={holdingTime(p.entryAt,open?now:p.exitAt??0)}/></dl>
    {p.exitReason&&<p className="fr-trade-reason">退出原因：{p.exitReason}</p>}
    {p.parity&&<details className="fr-details"><summary>复制详情</summary>{p.parity&&<p className="fr-note">源单 {p.parity.sourceId} · 规则 {p.parity.sourceRuleId}<br/>固定比例 {num(p.parity.ratio,6)} · 目标名义额 {num(p.parity.targetNotional)} U · 源单杠杆 {num(p.parity.sourceLeverage,0)}×<br/>张数取整差额 {num(p.parity.roundingNotional,4)} U{p.parity.discrepancy?` · ${p.parity.discrepancy}`:""}</p>}{p.parity&&<a className="fr-text-button" href={`/api/live/source?id=${encodeURIComponent(p.parity.sourceId)}`} target="_blank" rel="noreferrer">查看完整模拟源单与复制映射 ↗</a>}</details>}</article>;
}