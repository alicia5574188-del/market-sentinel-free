"use client";
/* 会员页：只做一件事——自己的实盘跟单。两个标签：执行（自己的实盘账户、开关、持仓、记录）和 系统（账户、Gate API、跟单状态、退出）。
 * 共享模拟账户、研究、运行日志、归档和会员管理都不在这里，也不会为它们发请求。主账户页面不经过这个组件。 */
import {useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from "react";
import {BEIJING_TIME_ZONE} from "../lib/beijing-time.ts";
import "./account-first.css";
import "./pages.css";
import "./member-dashboard.css";

type Tab="execution"|"settings";
const time=(v?:number|null)=>v?new Date(v).toLocaleString("zh-CN",{timeZone:BEIJING_TIME_ZONE,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}):"—";
const FONT_KEY="sentinel-ui-font-scale-v1";

export default function MemberDashboard({memberName,healthy,statusLabel,feedAt,error,liveEnabled,liveOperational,livePositions,livePanel,liveSystemPanel,initialTab="execution"}:{
  memberName:string;healthy:boolean;statusLabel?:string;feedAt:number|null;error:string|null;
  liveEnabled:boolean;liveOperational:boolean;livePositions:number;livePanel:ReactNode;liveSystemPanel:ReactNode;initialTab?:Tab;
}){
  const [tab,setTab]=useState<Tab>(initialTab);
  const [fontScale,setFontScale]=useState(()=>{if(typeof window==="undefined")return 92;try{const saved=Number(localStorage.getItem(FONT_KEY));return saved>=70&&saved<=110?saved:92;}catch{return 92;}});
  const scroll=useRef<Record<Tab,number>>({execution:0,settings:0});
  useLayoutEffect(()=>{window.scrollTo({top:scroll.current[tab]??0,behavior:"auto"});},[tab]);
  const select=(next:Tab)=>{scroll.current[tab]=window.scrollY;setTab(next);};
  const fontVars:Record<string,string>={};for(let px=10;px<=64;px++)fontVars[`--fr-fs${px}`]=`${(px*fontScale/100).toFixed(2)}px`;
  const systemStatus=statusLabel==="后台运行中"?"正常":statusLabel?.startsWith("后台运行中 · ")?statusLabel.slice(8):statusLabel??(healthy?"正常":"行情恢复中");
  const liveText=liveEnabled?liveOperational?"运行中":"核对中":"关闭";
  const liveTone=liveEnabled?liveOperational?"is-ok":"is-warn":"is-off";
  const nav:[Tab,string,string][]=[["execution","◉","执行"],["settings","⊙","系统"]];
  return <main className="fr-app fr-member-app" style={fontVars as CSSProperties} data-ui-version="member-slim-v1" data-testid="member-dashboard">
    <header className="fr-compact-header pg-head"><b>哨兵 · 实盘跟单</b><span>
      <i className={`pg-pill ${healthy?"is-ok":"is-warn"}`} role="status">{systemStatus}</i>
      <i className={`pg-pill ${liveTone}`}>实盘{liveText}</i>
      <i className="pg-pill is-plain">{memberName}</i></span></header>

    {/* The live console stays mounted so its record tab, form state and history poll survive a tab switch. */}
    <div className="fr-live-panel-host" data-testid="member-execution" hidden={tab!=="execution"}>{livePanel}</div>

    {tab==="settings"&&<div className="pg-system" data-testid="member-system">
      <section className="pg-card" data-testid="member-account">
        <header><small>我的账户</small><i className={`pg-pill ${liveTone}`}>跟单{liveText}</i></header>
        <dl className="pg-kv">
          <div><dt>账户</dt><dd>{memberName}</dd></div>
          <div><dt>实盘持仓</dt><dd>{livePositions} 笔</dd></div>
          <div><dt>跟随信号</dt><dd className={healthy?"fr-positive":undefined}>{systemStatus}</dd></div>
          <div><dt>信号更新</dt><dd>{time(feedAt)}</dd></div>
        </dl>
      </section>
      {liveSystemPanel}
      <section className="fr-section fr-font-control"><div className="fr-section-head"><h2>界面字号</h2><b>{fontScale}%</b></div>
        <div className="fr-font-options">{[70,80,90,100,110].map(value=><button key={value} className={fontScale===value?"selected":""} onClick={()=>{setFontScale(value);try{localStorage.setItem(FONT_KEY,String(value));}catch{}}}>{value}%</button>)}</div></section>
    </div>}

    {error&&<aside className="fr-error" role="alert"><b>运行提示</b><p>{error}</p></aside>}
    <nav className="fr-nav fr-nav-two">{nav.map(([id,icon,label])=><button key={id} className={id===tab?"selected":""} onClick={()=>select(id)}><span>{icon}</span><b>{label}</b>{id==="execution"&&livePositions>0&&<i>{livePositions}</i>}</button>)}</nav>
  </main>;
}
