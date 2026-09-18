"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { OperatorRequestError, operatorRequest, numberText as num, signedText as signed, operatorTime as time, contractText,
  holdingTime, livePositionMark, type AuthSession, type CredentialStatus, type CredentialVerification,
  type LivePosition, type LiveRuntime, type OperatorRuntime } from "../lib/operator-ui.ts";

type Props = { auth: AuthSession|null; runtime: OperatorRuntime|null; onSession: (session:AuthSession)=>void;
  onLive: (live:LiveRuntime)=>void; onRefresh: ()=>void };
type Section = "account" | "positions" | "history" | "api";

export default function LiveConsole({auth,runtime,onSession,onLive,onRefresh}:Props) {
  const [section,setSection]=useState<Section>("account"),[clock,setClock]=useState(0);
  const [password,setPassword]=useState(""),[apiKey,setApiKey]=useState(""),[apiSecret,setApiSecret]=useState("");
  const [credential,setCredential]=useState<CredentialStatus|null>(null),[verification,setVerification]=useState<CredentialVerification|null>(null);
  const [busy,setBusy]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const [confirmEnable,setConfirmEnable]=useState(false),[confirmDelete,setConfirmDelete]=useState(false);
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
  const closed=[...new Map([...(live?.history??[]),...Object.values(live?.positions??{}).filter((p):p is LivePosition=>p?.status==="CLOSED")]
    .map(p=>[p.id,p])).values()].sort((a,b)=>(b.exitAt??0)-(a.exitAt??0));
  const mirror=live?.mirror??runtime?.liveMirror;
  const entries=Object.values(live?.entries??{}).filter(e=>e&&!["FILLED","CANCELLED","FINISHED","REJECTED"].includes(e.status));
  const canControl=Boolean(auth?.authenticated&&live&&runtime);
  const canEnable=canControl&&Boolean(credential?.configured)&&!busy;
  const clearSensitive=()=>{setPassword("");setApiKey("");setApiSecret("");setCredential(null);setVerification(null);setConfirmEnable(false);setConfirmDelete(false);};
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
  const tabs:[Section,string][]=[["account","账户"],["positions","持仓"],["history","记录"],["api","API"]];

  return <div className="fr-live" data-testid="native-live-console">
    <section className="fr-page-title"><small>GATE · 实盘控制台</small><h1>实盘由你掌控</h1>
      <p>账户、持仓、执行记录和开关，都在当前页面。只有所有者能操作，登录和页面刷新都不会自动开启实盘。</p></section>
    <section className="fr-section fr-live-switch-panel" aria-label="实盘交易开关">
      <div><span className="fr-overline">实盘交易开关</span><h2>{!runtime?"读取开关状态…":enabled?live?.operational?"已开启 · 正在运行":"已请求开启 · 等待核对":"已关闭"}</h2>
        <p>{auth?.authenticated?"开关状态来自服务器，不用前端动画代替开启成功。":"所有者登录后可操作开关；访客不能更改。"}</p></div>
      <button type="button" className={`fr-switch ${enabled?"is-enabled":""}`} role="switch" aria-label="实盘交易开关"
        aria-checked={enabled} disabled={!canControl||Boolean(busy)||(!enabled&&!credential?.configured)}
        onClick={()=>enabled?setMode(false):setConfirmEnable(true)}><span/><b>{busy==="mode"?"核对中":enabled?"开启":"关闭"}</b></button>
      {confirmEnable&&auth?.authenticated&&!enabled&&<div className="fr-inline-confirm" role="group" aria-label="确认开启实盘">
        <h3>确认仅跟随开启后新产生的模拟单？</h3><p>本次开启前已存在的模拟持仓不会补开。之后的新模拟单按两账户权益比例复制，沿用杠杆和退出决定。关闭再开启会建立新的跟随起点；实际数量、成交价和费用以Gate回报为准。</p>
        <div className="fr-action-row"><button className="fr-button" type="button" disabled={!canEnable} onClick={()=>setMode(true)}>确认开启实盘</button>
          <button className="fr-button secondary" type="button" disabled={Boolean(busy)} onClick={()=>setConfirmEnable(false)}>暂不开启</button></div></div>}
    </section>
    <div className="fr-live-source"><span aria-hidden="true">ⓘ</span><p><b>当前复制源：</b>当前新版模拟账户，不是旧版组合。订单ID、完整规则、保护价格和退出决定逐单关联；仅资金规模按权益比例换算。最小张数、拒单、部分成交或报价差异会明确显示，不冒充百分百成交。</p></div>
    <section className="fr-section"><div className="fr-section-head"><h2>模拟—实盘复制一致性</h2><span>{mirror?.connected?"当前源已接入":"等待源状态"}</span></div>
      <div className="fr-three"><div><small>本次开启后已复制 / 应跟随</small><b>{num(mirror?.eligibleCopiedCount,0)} / {num(mirror?.eligibleSourceCount,0)}</b></div><div><small>应跟随但尚未复制</small><b>{num(mirror?.eligibleMissingCount,0)}</b></div><div><small>源数据或执行阻塞</small><b>{mirror?.error?"需核对":"无源阻塞"}</b></div></div>
      {mirror?.error&&<p className="fr-error">{mirror.error}</p>}
      <div className="fr-three"><div><small>当前模拟持仓</small><b>{num(mirror?.sourceCount,0)}</b></div><div><small>开启后可跟随源单</small><b>{num(mirror?.eligibleSourceCount,0)}</b></div><div><small>已核对实际持仓</small><b>{num(mirror?.copiedCount,0)}</b></div></div>
      <div className="fr-three"><div><small>开启前旧单不跟随</small><b>{num(mirror?.excludedSourceCount,0)}</b></div><div><small>低于真实最低量</small><b>{num(mirror?.minimumSizeBlockedCount,0)}</b></div><div><small>待交易所确认</small><b>{num(mirror?.pendingCount,0)}</b></div></div>
      <p className="fr-note">跟随起点 {time(mirror?.enabledAt)}。不补旧单；已有 {num(mirror?.managedBeforeEnableCount,0)} 笔实盘原仓继续管理。因此模拟总持仓数不一定等于实盘数；对开启后的订单逐单显示已复制、未成交或偏差，不用总数冒充完整复制。</p>
      <p className="fr-note">关闭时不新开仓并撤销系统入场挂单；已有仓位继续跟随源单退出并保留保护单。部署、登录、规则更新及暂时故障不会改变你的开关选择。</p>
      {auth?.authenticated&&mirror?.rows.filter(r=>r.status!=="COPIED").map(r=><p className="fr-note" key={r.sourceId}>{r.symbol} · {r.reason??r.status}</p>)}
    </section>
    {error&&<div className="fr-error" role="alert"><b>操作未完成</b><p>{error}</p></div>}
    {notice&&<div className="fr-notice" role="status">{notice}</div>}
    {!auth?.authenticated?<section className="fr-section fr-owner-login"><div className="fr-section-head"><div><small>所有者权限</small><h2>在本页登录</h2></div><span>无弹窗</span></div>
      <p className="fr-note">使用原来的owner账户和访问密码。实盘数据、API和开关仅对你开放。</p>
      <form onSubmit={login} className="fr-form"><label>账户<input value="owner" readOnly autoComplete="username"/></label>
        <label>所有者密码<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" required placeholder="输入原来的所有者密码"/></label>
        {auth?.configured===false&&<p className="fr-error">后台所有者访问码尚未配置。</p>}
        <button className="fr-button" type="submit" disabled={Boolean(busy)||!auth||!auth.configured||password.length<16}>{busy==="login"?"验证中…":"登录所有者账户"}</button>
      </form></section>:<>
      <div className="fr-owner-session"><span>● owner · 已登录</span><button className="fr-text-button" type="button" disabled={Boolean(busy)} onClick={logout}>退出登录</button></div>
      <nav className="fr-live-tabs" aria-label="实盘子导航">{tabs.map(([id,title])=><button type="button" key={id} aria-current={section===id?"page":undefined}
        className={section===id?"selected":""} onClick={()=>setSection(id)}>{title}</button>)}</nav>
      {section==="account"&&<>
        <section className="fr-stats"><LiveStat title="实盘账户权益" value={`${num(live?.equity)} U`} detail="Gate余额＋已核对持仓浮盈"/>
          <LiveStat title="可用保证金" value={`${num(live?.available)} U`} detail="不以模拟本金替代"/>
          <LiveStat title="持仓浮动盈亏" value={`${signed(floating)} U`} detail={marks.some(m=>!m.fresh)?"Gate最近回报（等待更新）；不是最终净收益":"Gate持仓实际回报；不是最终净收益"}/>
          <LiveStat title="当前持仓" value={live?`${positions.length} 笔`:"—"} detail={`待执行 ${live?entries.length:"—"} 笔`}/></section>
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
        {!live?<LiveEmpty title="正在读取所有者账户" text="未收到真实账户快照前，不显示虚构的零持仓。"/>:
          !positions.length&&!entries.length?<LiveEmpty title="当前没有实盘持仓或挂单" text="模拟订单不会在这里冒充Gate成交。"/>:
          <div className="fr-rule-grid">{positions.map(p=><LivePositionCard key={p.id} position={p} runtime={runtime} now={clock}/>)}
            {entries.map(e=>e&&<article className="fr-trade" key={e.planId}><header><h3>{e.symbol.replace("_"," / ")}</h3><span>{e.side==="LONG"?"多单":"空单"} · 待执行</span></header>
              <dl><Pair label="触发价格" value={num(e.trigger,5)}/><Pair label="保护价格" value={num(e.invalidation,5)}/><Pair label="名义金额" value={`${num(e.notional)} U`}/><Pair label="保证金 / 杠杆" value={`${num(e.margin)} U / ${num(e.leverage,0)}×`}/></dl>
              <p className="fr-note">{e.lastError??`服务器状态：${e.status}`}</p>{e.parity&&<p className="fr-note">源单 {e.parity.sourceId} · 固定复制比例 {num(e.parity.ratio,6)}</p>}</article>)}</div>}
      </section>}
      {section==="history"&&<>
        <section className="fr-section"><div className="fr-section-head"><h2>已平仓实盘记录</h2><span>关闭开关后仍可查看</span></div>
          {closed.length?<div className="fr-rule-grid">{closed.map(p=><LivePositionCard key={p.id} position={p} runtime={runtime} now={clock}/>)}</div>:<LiveEmpty title={live?"暂无已平仓实盘记录":"正在读取实盘记录"} text="仅展示服务器返回的真实账户记录，不拼接模拟成绩。"/>}</section>
        <section className="fr-section"><h2>执行与保护记录</h2><div className="fr-journal">{audits.map(e=><article key={e.id}><time>{time(e.observedAt)}</time><div><b>{e.symbol?.replace("_"," / ")??"实盘控制"} · {e.stage}</b><p>{e.reason}</p></div></article>)}</div>
          {Object.values(live?.entrySkips??{}).map(e=>e&&<div key={e.planId} className="fr-error"><b>{e.symbol} · 未成交</b><p>{e.reason}</p>{e.sizing&&<p>比例目标 {contractText(e.sizing.targetContracts)} 张 / {num(e.sizing.targetNotional,4)} U；交易所最低 {contractText(e.sizing.minimumContracts)} 张 / {num(e.sizing.minimumNotional,4)} U。仅满足此单最低量所需实盘净值约 {num(e.sizing.requiredLiveEquity,4)} U，另需可用保证金；不会擅自补大。</p>}</div>)}
          {!audits.length&&<p className="fr-note">暂无执行事件。开仓、退出、拒单和保护原因会按实际记录显示。</p>}</section>
      </>}
      {section==="api"&&<section className="fr-section"><div className="fr-section-head"><div><small>API 管理</small><h2>Gate合约连接</h2></div><span>{credential?.configured?"已加密保存":"尚未配置"}</span></div>
        <p className="fr-note">沿用现有凭据，不要求重新填写。只有更换API时才使用下方表单；Secret不会回显。</p>
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
  const open=p.status==="OPEN",mark=livePositionMark(p,runtime,now),pnl=open?mark.pnl:p.realizedPnl;
  return<article className="fr-trade"><header><div><small>{open?"持仓中":"已平仓"} · {p.side==="LONG"?"多单":"空单"}</small><h3>{p.symbol.replace("_"," / ")}</h3></div><strong className={pnl==null?"":pnl>=0?"fr-positive":"fr-negative"}>{signed(pnl)} U</strong></header>
    <p className="fr-trade-rule">{open?mark.pnl==null?"等待Gate持仓浮盈回报，不用模拟价或入场价代替":`${mark.fresh?"Gate实际浮盈浮亏":"Gate最近浮盈回报，正在更新"} · ${time(mark.at)}；不是扣除全部费用后的最终净收益`:p.actualExitPriceVerified===false?"Gate确认已平仓，真实成交价/净收益待核对，不用模拟结果代替":"服务器记录；缺失的真实净收益不以模拟盈亏代替"}</p>
    {open&&<p className={mark.rate==null?"fr-note":mark.rate>=0?"fr-positive":"fr-negative"}>浮盈 / Gate保证金：{signed(mark.rate==null?null:mark.rate*100)}%{mark.margin==null?"（保证金回报缺失，不猜测百分比）":""}</p>}
    {p.parity&&<p className="fr-note">源单 {p.parity.sourceId} · 规则 {p.parity.sourceRuleId}<br/>固定比例 {num(p.parity.ratio,6)} · 目标名义额 {num(p.parity.targetNotional)} U · 源单杠杆 {num(p.parity.sourceLeverage,0)}×<br/>张数取整差额 {num(p.parity.roundingNotional,4)} U{p.parity.discrepancy?` · ${p.parity.discrepancy}`:""}</p>}
    <dl><Pair label="入场价格" value={num(p.entryPrice,5)}/><Pair label={open?"Gate标记价格":"出场价格"} value={num(open?mark.price:p.exitPrice,5)}/>
      <Pair label="保护止损" value={num(p.stopPrice??p.currentStop,5)}/><Pair label="名义金额" value={`${num(p.notional)} U`}/>
      <Pair label="保证金 / 杠杆" value={`${num(open?mark.margin:p.margin)} U / ${num(p.leverage,0)}×`}/><Pair label="实际合约数量" value={contractText(Math.abs(p.exchangeSize))}/>
      <Pair label="进场时间" value={time(p.entryAt)}/><Pair label="出场时间" value={open?"持仓中":time(p.exitAt)}/>
      <Pair label="持仓时长" value={holdingTime(p.entryAt,open?now:p.exitAt??0)}/></dl>
    {p.exitReason&&<p className="fr-trade-reason">退出原因：{p.exitReason}</p>}
    {p.parity&&<a className="fr-text-button" href={`/api/live/source?id=${encodeURIComponent(p.parity.sourceId)}`} target="_blank" rel="noreferrer">查看完整模拟源单与复制映射 ↗</a>}</article>;
}