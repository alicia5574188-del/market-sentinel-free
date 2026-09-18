"use client";
import {useEffect,useRef,useState} from "react";
import {operatorRequest,numberText,operatorTime,type AuthSession} from "../lib/operator-ui.ts";
type Overview={version:string;current:{id:string;loginKey:string}|null;memberLimit:number;activeLimit:number;activeCount:number;
 members:{id:string;label:string;createdAt:number;activatedAt:number|null;usage:{notional:number|null;fills:number;through:number|null;reportedAt:number;partial:boolean;error:boolean}|null}[]};
export function LoginGate({auth,onSession}:{auth:AuthSession|null;onSession:(s:AuthSession)=>void}) {
  const[owner,setOwner]=useState(false),[key,setKey]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const lock=useRef(false);
  const submit=async(e:React.FormEvent)=>{e.preventDefault();if(lock.current)return;lock.current=true;setBusy(true);setError(null);
    try {const session=await operatorRequest<AuthSession>(owner?"/api/auth/login":"/api/members/login","POST",owner?{username:"owner",password:key}:{key});setKey("");onSession(session);}
    catch(e){setError(e instanceof Error?e.message:"登录失败");}finally{lock.current=false;setBusy(false);}};
  return <main className="fr-app fr-access" data-access="login"><header className="fr-header"><div className="fr-brand"><span className="fr-emblem">↗</span><div><b>哨兵 · 关系引擎</b><small>PRIVATE ACCESS</small></div></div></header>
    <section className="fr-section"><div className="fr-section-head"><div><small>独立账户 · 同一策略源</small><h1>{owner?"主账户登录":"登录密钥"}</h1></div></div>
      <p className="fr-note">{auth===null?"正在检查已有登录状态…":owner?"沿用你的原主账户密码，登录不会改变实盘开关。":"使用主账户发给你的专属登录密钥。每把密钥固定对应一个账户，生成下一把不影响已发出的密钥。"}</p>
      <form className="fr-form" onSubmit={submit}><label>{owner?"主账户密码":"个人登录密钥"}<input type="password" autoComplete={owner?"current-password":"off"} spellCheck={false} value={key} onChange={e=>setKey(e.target.value)} placeholder={owner?"填写原主账户密码":"MS-…"} disabled={busy||auth===null}/></label>
        <button className="fr-button" type="submit" disabled={busy||auth===null||!key.trim()}>{busy?"正在登录…":"登录程序"}</button></form>
      <button className="fr-text-button" onClick={()=>{setOwner(v=>!v);setKey("");setError(null);}} disabled={busy}>{owner?"使用会员登录密钥":"我是主账户所有者"}</button>
      {!owner&&<p className="fr-note">密钥等同于账号密码，请勿转发。实盘API和开关只属于本人，默认关闭；邀请人只查看本程序产生的成交额汇总，不查看你的余额、盈亏或API。</p>}
      {error&&<p className="fr-error" role="status">{error}</p>}
    </section></main>;
}
export function MemberAccess({auth}:{auth:AuthSession}) {
  const[overview,setOverview]=useState<Overview|null>(null),[label,setLabel]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[copied,setCopied]=useState(false);
  const pending=useRef<string|null>(null),lock=useRef(false),isOwner=auth.authenticated&&auth.role!=="member";
  useEffect(()=>{if(!isOwner)return;let active=true;void operatorRequest<Overview>("/api/members/admin").then(v=>{if(active)setOverview(v);}).catch(e=>{if(active)setError(e instanceof Error?e.message:"读取失败");});return()=>{active=false;};},[isOwner]);
  const issue=async()=>{if(lock.current||!isOwner)return;lock.current=true;setBusy(true);setError(null);setCopied(false);
    pending.current??=crypto.randomUUID();
    try {await operatorRequest("/api/members/issue","POST",{label,requestId:pending.current});pending.current=null;setLabel("");setOverview(await operatorRequest<Overview>("/api/members/admin"));}
    catch(e){setError(e instanceof Error?e.message:"未收到确认，请先刷新核对，不会自动重复发放");}finally{lock.current=false;setBusy(false);}};
  if(!isOwner)return <section className="fr-section"><h2>我的使用资格</h2><p className="fr-note">账户：{auth.username}。你的登录密钥长期对应本账户，主账户生成其他会员的密钥不会使它失效。你不能创建新用户，也不能查看其他会员的账户。</p><p className="fr-note">共享模拟订单源。实盘由你自己配置和开启，仅复制开启后的新模拟单；成交价格与数量仍以你的Gate回报为准。</p></section>;
  return <section className="fr-section" data-testid="member-admin"><div className="fr-section-head"><div><small>仅主账户可见</small><h2>会员与登录密钥</h2></div><span>{overview?.members.length??"—"} 位</span></div>
    <p className="fr-note">每把密钥对应一个会员账户。生成下一位的密钥不影响已发放密钥。</p>
    {overview?.current&&<div className="fr-form"><label>当前待发放／最近生成的登录密钥<input type="text" readOnly value={overview.current.loginKey} spellCheck={false} aria-label="当前登录密钥"/></label><button className="fr-text-button" onClick={async()=>{try{await navigator.clipboard.writeText(overview.current!.loginKey);setCopied(true);}catch{setError("请长按密钥文字复制");}}}>{copied?"已复制":"复制登录密钥"}</button></div>}
    <div className="fr-form"><label>会员备注<input value={label} maxLength={60} onChange={e=>setLabel(e.target.value)} placeholder="例如：小王" disabled={busy}/></label>
    <button className="fr-button" type="button" onClick={issue} disabled={busy||!overview||overview.members.length>=overview.memberLimit}>{busy?"生成中…":overview?.current?"生成下一位的登录密钥":"生成第一位的登录密钥"}</button></div>
    <p className="fr-note">最多{overview?.memberLimit??20}个会员登录账户，同时最多{overview?.activeLimit??2}个会员实盘执行账户（不包括你）。当前占用{overview?.activeCount??"—"}个。已运行账户不被抢占。</p>
    <button className="fr-text-button" type="button" disabled={busy} onClick={async()=>{if(lock.current)return;lock.current=true;setBusy(true);setError(null);try{setOverview(await operatorRequest<Overview>("/api/members/admin"));}catch(e){setError(e instanceof Error?e.message:"读取失败");}finally{lock.current=false;setBusy(false);}}}>刷新会员成交额 ↻</button>
    {error&&<p className="fr-error" role="status">{error}</p>}
    <div className="fr-member-list">{overview?.members.length?overview.members.map(m=><article className="fr-rule" key={m.id}><header><h3>{m.label}</h3><span>{m.activatedAt?"已激活":"待首次登录"}</span></header><p className="fr-note">{m.id}</p>
      <div className="fr-three"><div><small>本程序实盘成交额</small><b>{numberText(m.usage?.notional)} U</b></div><div><small>统计截至</small><b>{operatorTime(m.usage?.through)}</b></div><div><small>数据状态</small><b>{!m.usage?"等待本人配置":m.usage.error?"最近值·待核对":m.usage.partial?"部分已确认":"已核对"}</b></div></div></article>):<p className="fr-note">尚未发放登录密钥。这里不会显示会员的余额、盈亏、密钥或实盘开关。</p>}</div>
  </section>;
}