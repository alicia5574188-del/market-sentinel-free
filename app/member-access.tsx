"use client";
import {useEffect,useRef,useState} from "react";
import {operatorRequest,numberText,operatorTime,type AuthSession} from "../lib/operator-ui.ts";

type MemberRow={
  id:string;label:string;username:string|null;authVersion:string;createdAt:number;activatedAt:number|null;
  followBlockedAt:number|null;revokedAt:number|null;
  usage:{notional:number|null;fills:number;through:number|null;reportedAt:number;partial:boolean;error:boolean}|null
};
type Overview={
  version:string;authVersion:string;invite:{code:string;createdAt:number};memberLimit:number;activeLimit:number;activeCount:number;
  members:MemberRow[]
};
type LoginMode="login"|"register"|"owner";
type AdminAction={id:string;kind:"stop"|"resume"|"delete";label:string};

export function LoginGate({auth,onSession}:{auth:AuthSession|null;onSession:(s:AuthSession)=>void}) {
  const[mode,setMode]=useState<LoginMode>("login");
  const[username,setUsername]=useState(""),[password,setPassword]=useState(""),[confirm,setConfirm]=useState("");
  const[invite,setInvite]=useState("");
  const[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const lock=useRef(false),registrationId=useRef<string|null>(null);
  const changeMode=(next:LoginMode)=>{
    setMode(next);setUsername("");setPassword("");setConfirm("");setInvite("");setError(null);
  };
  const submit=async(e:React.FormEvent)=>{
    e.preventDefault();if(lock.current)return;setError(null);
    if(mode==="register"&&password!==confirm){setError("两次输入的密码不一致");return;}
    lock.current=true;setBusy(true);
    try{
      let session:AuthSession;
      if(mode==="owner")session=await operatorRequest<AuthSession>("/api/auth/login","POST",{username:"owner",password});
      else if(mode==="register"){
        registrationId.current??=crypto.randomUUID();
        session=await operatorRequest<AuthSession>("/api/members/register","POST",
          {inviteCode:invite,username,password,requestId:registrationId.current});
        registrationId.current=null;
      }else session=await operatorRequest<AuthSession>("/api/members/login","POST",{username,password});
      setUsername("");setPassword("");setConfirm("");setInvite("");onSession(session);
    }catch(e){setError(e instanceof Error?e.message:"登录失败");}
    finally{lock.current=false;setBusy(false);}
  };
  const title=mode==="owner"?"主账户登录":mode==="register"?"注册会员账户":"会员登录";
  return <main className="fr-app fr-access" data-access="login">
    <header className="fr-header"><div className="fr-brand"><span className="fr-emblem">↗</span><div><b>哨兵 · 多周期转折引擎</b><small>PRIVATE ACCESS</small></div></div></header>
    <section className="fr-section">
      <div className="fr-section-head"><div><small>独立账户 · 同一策略源</small><h1>{title}</h1></div></div>
      <p className="fr-note">{auth===null?"正在检查已有登录状态…":
        mode==="register"?"填写主账户提供的一次性邀请码，再自行设置用户名和密码。注册成功后该邀请码立即失效。":
        mode==="login"?"使用注册时设置的用户名和密码登录。":
        "沿用你的原主账户密码，登录不会改变实盘开关。"}</p>
      <form className="fr-form" onSubmit={submit}>
        {mode==="register"&&<label>邀请码<input value={invite} onChange={e=>setInvite(e.target.value)} placeholder="INV-…" autoComplete="off" spellCheck={false} disabled={busy||auth===null}/></label>}
        {(mode==="login"||mode==="register")&&<label>用户名<input value={username} onChange={e=>setUsername(e.target.value)} placeholder="2–32位用户名" autoComplete="username" spellCheck={false} disabled={busy||auth===null}/></label>}
        <label>{mode==="owner"?"主账户密码":"密码"}<input type="password" value={password} onChange={e=>setPassword(e.target.value)}
          placeholder={mode==="register"?"至少8位":"输入密码"} autoComplete={mode==="register"?"new-password":"current-password"} disabled={busy||auth===null}/></label>
        {mode==="register"&&<label>确认密码<input type="password" value={confirm} onChange={e=>setConfirm(e.target.value)}
          placeholder="再次输入密码" autoComplete="new-password" disabled={busy||auth===null}/></label>}
        <button className="fr-button" type="submit" disabled={busy||auth===null
          ||!password
          ||((mode==="login"||mode==="register")&&!username.trim())
          ||(mode==="register"&&(!invite.trim()||!confirm))}>
          {busy?"正在处理…":mode==="register"?"注册并登录":"登录程序"}
        </button>
      </form>
      <div className="fr-action-row">
        {mode!=="login"&&<button className="fr-text-button" type="button" onClick={()=>changeMode("login")} disabled={busy}>会员登录</button>}
        {mode!=="register"&&<button className="fr-text-button" type="button" onClick={()=>changeMode("register")} disabled={busy}>使用邀请码注册</button>}
        {mode!=="owner"&&<button className="fr-text-button" type="button" onClick={()=>changeMode("owner")} disabled={busy}>我是主账户所有者</button>}
      </div>
      {mode!=="owner"&&<p className="fr-note">每个邀请码只能成功注册一个账户。用户名不可重复；以后只需要用户名和密码登录。</p>}
      {error&&<p className="fr-error" role="status">{error}</p>}
    </section>
  </main>;
}

export function MemberAccess({auth}:{auth:AuthSession}) {
  const[overview,setOverview]=useState<Overview|null>(null),[busy,setBusy]=useState(false);
  const[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[copied,setCopied]=useState(false);
  const[confirmAction,setConfirmAction]=useState<AdminAction|null>(null);
  const lock=useRef(false),isOwner=auth.authenticated&&auth.role!=="member";
  const refresh=async()=>{const value=await operatorRequest<Overview>("/api/members/admin");setOverview(value);return value;};
  useEffect(()=>{if(!isOwner)return;let active=true;
    void operatorRequest<Overview>("/api/members/admin").then(v=>{if(active)setOverview(v);})
      .catch(e=>{if(active)setError(e instanceof Error?e.message:"读取失败");});
    return()=>{active=false;};
  },[isOwner]);
  const rotate=async()=>{
    if(lock.current)return;lock.current=true;setBusy(true);setError(null);setNotice(null);setCopied(false);
    try{await operatorRequest("/api/members/invite/rotate","POST",{});await refresh();setNotice("邀请码已手动重置，旧邀请码立即失效。");}
    catch(e){setError(e instanceof Error?e.message:"邀请码重置失败");}
    finally{lock.current=false;setBusy(false);}
  };
  const runAction=async(action:AdminAction)=>{
    if(lock.current)return;lock.current=true;setBusy(true);setError(null);setNotice(null);
    const path=action.kind==="stop"?"/api/members/stop":action.kind==="resume"?"/api/members/resume":"/api/members/delete";
    try{
      await operatorRequest(path,"POST",{id:action.id});await refresh();
      setNotice(action.kind==="stop"
        ?`${action.label} 已停止新的实盘跟随；已有持仓继续保留保护，并按原模拟源正常退出。`
        :action.kind==="resume"
          ?`${action.label} 已允许再次开启实盘；不会自动替该会员开启。`
          :`${action.label} 已安全删除，原登录资格已失效并释放会员名额。`);
    }catch(e){await refresh().catch(()=>undefined);setError(e instanceof Error?e.message:"操作未完成");}
    finally{setConfirmAction(null);lock.current=false;setBusy(false);}
  };
  if(!isOwner)return <section className="fr-section">
    <h2>我的使用资格</h2>
    <p className="fr-note">账户：{auth.username}。新注册账户以后使用用户名和密码登录。</p>
    <p className="fr-note">共享同一模拟订单源。实盘由你自己配置和开启；如果主账户停止你的跟随权限，系统不会再复制新单，但已经成交的实盘持仓仍继续保护并按原模拟源正常退出。</p>
  </section>;
  return <section className="fr-section" data-testid="member-admin">
    <div className="fr-section-head"><div><small>仅主账户可见</small><h2>会员与邀请码</h2></div><span>{overview?.members.length??"—"} 位</span></div>
    <p className="fr-note">把当前邀请码发给下一位用户。对方使用邀请码、用户名和密码自行注册；注册成功后该邀请码立即失效，后台自动生成下一枚邀请码。</p>
    {overview?.invite&&<div className="fr-form">
      <label>当前一次性邀请码<input type="text" readOnly value={overview.invite.code} spellCheck={false} aria-label="当前邀请码"/></label>
      <div className="fr-action-row">
        <button className="fr-text-button" type="button" disabled={busy} onClick={async()=>{
          try{await navigator.clipboard.writeText(overview.invite.code);setCopied(true);}catch{setError("请长按邀请码文字复制");}
        }}>{copied?"已复制":"复制邀请码"}</button>
        <button className="fr-text-button danger" type="button" disabled={busy} onClick={rotate}>手动重置邀请码</button>
      </div>
    </div>}
    <p className="fr-note">当前最多{overview?.memberLimit??50}个注册会员；同时最多{overview?.activeLimit??2}个会员实盘执行账户（不包括你），当前占用{overview?.activeCount??"—"}个。注册本身不会启动后台交易任务。</p>
    <button className="fr-text-button" type="button" disabled={busy} onClick={async()=>{
      if(lock.current)return;lock.current=true;setBusy(true);setError(null);
      try{await refresh();}catch(e){setError(e instanceof Error?e.message:"读取失败");}
      finally{lock.current=false;setBusy(false);}
    }}>刷新会员状态 ↻</button>
    {notice&&<p className="fr-notice" role="status">{notice}</p>}
    {error&&<p className="fr-error" role="status">{error}</p>}
    <div className="fr-member-list">
      {overview?.members.length?overview.members.map(m=><article className="fr-rule" key={m.id}>
        <header><h3>{m.username??m.label}</h3><span>{m.revokedAt?"删除处理中":m.followBlockedAt?"禁止开启实盘":m.username?"已激活":"旧账户不可登录"}</span></header>
        <p className="fr-note">{m.username?`用户名：${m.username}`:"旧密钥账户已停用登录，请删除后用邀请码重新注册。"}</p>
        <div className="fr-three">
          <div><small>本程序实盘成交额</small><b>{numberText(m.usage?.notional)} U</b></div>
          <div><small>统计截至</small><b>{operatorTime(m.usage?.through)}</b></div>
          <div><small>数据状态</small><b>{!m.usage?"等待本人配置":m.usage.error?"最近值·待核对":m.usage.partial?"部分已确认":"已核对"}</b></div>
        </div>
        {!m.revokedAt&&<div className="fr-action-row">
          {m.followBlockedAt
            ?<button className="fr-button secondary" type="button" disabled={busy}
              onClick={()=>setConfirmAction({id:m.id,kind:"resume",label:m.username??m.label})}>允许开启实盘</button>
            :<button className="fr-button secondary" type="button" disabled={busy}
              onClick={()=>setConfirmAction({id:m.id,kind:"stop",label:m.username??m.label})}>强制停止实盘跟随</button>}
          <button className="fr-button danger" type="button" disabled={busy}
            onClick={()=>setConfirmAction({id:m.id,kind:"delete",label:m.username??m.label})}>删除账户</button>
        </div>}
        {confirmAction?.id===m.id&&<div className="fr-inline-confirm">
          <h3>{confirmAction.kind==="delete"?"确认删除账户":confirmAction.kind==="stop"?"确认强制停止跟随":"确认允许重新开启实盘"}</h3>
          <p>{confirmAction.kind==="delete"
            ?"系统会先禁止新跟随并撤销未成交的系统入场单。若仍有实盘持仓，账户不会被删除，持仓会继续正常保护和退出；全部退出后再点删除即可完成。"
            :confirmAction.kind==="stop"
              ?"停止后该会员不能自行重新开启实盘，也不会再复制新的模拟单；已经成交的实盘持仓不会强平，会继续按原保护和模拟源退出。"
              :"只恢复该会员自己开启实盘的权限，不会自动打开实盘，也不会补开停止期间出现的模拟单。"}</p>
          <div className="fr-action-row">
            <button className={confirmAction.kind==="delete"?"fr-button danger":"fr-button"} type="button" disabled={busy} onClick={()=>runAction(confirmAction)}>
              {busy?"处理中…":confirmAction.kind==="delete"?"确认安全删除":confirmAction.kind==="stop"?"确认停止":"确认允许"}
            </button>
            <button className="fr-button secondary" type="button" disabled={busy} onClick={()=>setConfirmAction(null)}>取消</button>
          </div>
        </div>}
      </article>):<p className="fr-note">尚无会员。把上方邀请码发给下一位用户即可。</p>}
    </div>
  </section>;
}
