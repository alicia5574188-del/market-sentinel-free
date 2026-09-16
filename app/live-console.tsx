"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { OperatorRequestError, operatorRequest, numberText as num, signedText as signed, operatorTime as time,
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
  const closed=Object.values(live?.positions??{}).filter((p):p is LivePosition=>p?.status==="CLOSED").sort((a,b)=>(b.exitAt??0)-(a.exitAt??0));
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
        <h3>确认开启现有实盘执行连接？</h3><p>可能立即核对和管理已有实盘订单。关系引擎的新规则目前仍只在模拟运行，本次开关不会把它们自动接入实盘。</p>
        <div className="fr-action-row"><button className="fr-button" type="button" disabled={!canEnable} onClick={()=>setMode(true)}>确认开启实盘</button>
          <button className="fr-button secondary" type="button" disabled={Boolean(busy)} onClick={()=>setConfirmEnable(false)}>暂不开启</button></div></div>}
    </section>
    <div className="fr-live-source"><span aria-hidden="true">ⓘ</span><p><b>当前执行范围：</b>这里接入现有Gate账户与所有者开关。关系引擎生成的规则仍是模拟交易，没有在这次页面更新中接入实盘复制。</p></div>
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
        <section className="fr-stats"><LiveStat title="实盘账户权益" value={`${num(live?.equity)} U`} detail="Gate最近核对余额"/>
          <LiveStat title="可用保证金" value={`${num(live?.available)} U`} detail="不以模拟本金替代"/>
          <LiveStat title="持仓浮动盈亏" value={`${signed(floating)} U`} detail="新鲜退出报价估值，未扣平仓费用"/>
          <LiveStat title="当前持仓" value={live?`${positions.length} 笔`:"—"} detail={`待执行 ${live?entries.length:"—"} 笔`}/></section>
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
              <p className="fr-note">{e.lastError??`服务器状态：${e.status}`}</p></article>)}</div>}
      </section>}
      {section==="history"&&<>
        <section className="fr-section"><div className="fr-section-head"><h2>已平仓实盘记录</h2><span>关闭开关后仍可查看</span></div>
          {closed.length?<div className="fr-rule-grid">{closed.map(p=><LivePositionCard key={p.id} position={p} runtime={runtime} now={clock}/>)}</div>:<LiveEmpty title={live?"暂无已平仓实盘记录":"正在读取实盘记录"} text="仅展示服务器返回的真实账户记录，不拼接模拟成绩。"/>}</section>
        <section className="fr-section"><h2>执行与保护记录</h2><div className="fr-journal">{audits.map(e=><article key={e.id}><time>{time(e.observedAt)}</time><div><b>{e.symbol?.replace("_"," / ")??"实盘控制"} · {e.stage}</b><p>{e.reason}</p></div></article>)}</div>
          {Object.values(live?.entrySkips??{}).map(e=>e&&<div key={e.planId} className="fr-error"><b>{e.symbol} · 未成交</b><p>{e.reason}</p></div>)}
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
    <p className="fr-trade-rule">{open?mark.fresh?"按可执行侧报价估值，未扣平仓费用":"当前报价未就绪，不用入场价冒充最新盈亏":"服务器记录的已实现盈亏"}</p>
    <dl><Pair label="入场价格" value={num(p.entryPrice,5)}/><Pair label={open?"最新退出报价":"出场价格"} value={num(open?mark.price:p.exitPrice,5)}/>
      <Pair label="保护止损" value={num(p.stopPrice??p.currentStop,5)}/><Pair label="名义金额" value={`${num(p.notional)} U`}/>
      <Pair label="实际保证金 / 杠杆" value={`${num(p.margin)} U / ${num(p.leverage,0)}×`}/><Pair label="张数" value={num(Math.abs(p.exchangeSize),0)}/>
      <Pair label="进场时间" value={time(p.entryAt)}/><Pair label="出场时间" value={open?"持仓中":time(p.exitAt)}/>
      <Pair label="持仓时长" value={holdingTime(p.entryAt,open?now:p.exitAt??0)}/></dl>
    {p.exitReason&&<p className="fr-trade-reason">退出原因：{p.exitReason}</p>}</article>;
}