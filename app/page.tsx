"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ForwardDashboard from "./forward-dashboard.tsx";
import MemberDashboard from "./member-dashboard.tsx";
import LiveConsole from "./live-console.tsx";
import { LoginGate, MemberAccess } from "./member-access.tsx";
import PaperAccountReset from "./paper-account-reset.tsx";
import { runtimeBackendOperational, runtimeStatusLabel } from "../lib/runtime-health.ts";
import { operatorRequest, type AuthSession, type LiveRuntime, type OperatorRuntime } from "../lib/operator-ui.ts";
import { clearPanels } from "../lib/panel-cache.ts";
import { prefetchSystemPanels } from "../lib/system-panels.ts";
import { readHome, saveHome, startHomeEarly, takeHomeEarly } from "../lib/owner-home.ts";
import { runtimeRefreshMs } from "../lib/member-view.ts";

const IDENTITY_KEY="sentinel-panel-identity-v1";
const identityOf=(s:AuthSession)=>s.authenticated?`${s.role??"owner"}:${s.memberId??s.username}`:null;
/** System-tab snapshots belong to one signed-in identity: logged out or a different account = wipe them. */
function guardPanelCache(session:AuthSession){
  const next=identityOf(session);
  let prev:string|null=null;try{prev=localStorage.getItem(IDENTITY_KEY);}catch{/* optional */}
  if(!next||prev!==next)clearPanels();
  try{if(next)localStorage.setItem(IDENTITY_KEY,next);else localStorage.removeItem(IDENTITY_KEY);}catch{/* optional */}
}

const RUNTIME_REQUEST_TIMEOUT_MS = 12_000;
const RUNTIME_RETRY_MS = 3_000;

export default function Home() {
  const [runtime,setRuntime] = useState<OperatorRuntime|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [auth,setAuth] = useState<AuthSession|null>(null);
  const [refresh,setRefresh] = useState(0);
  const epoch=useRef(0),runtimeReadFailures=useRef(0),hasRuntimeSnapshot=useRef(false),lastRuntime=useRef<OperatorRuntime|null>(null);
  // Which owner tab is shown: the home refresh is faster only where data on screen moves quickly.
  const ownerTab=useRef<string|null>(null),retune=useRef<(()=>void)|null>(null);
  const tabChanged=useCallback((tab:string)=>{ownerTab.current=tab;retune.current?.();},[]);
  const [cachedAt,setCachedAt] = useState<number|null>(null);
  const deferredPrefetch=useRef<string|null>(null);
  const reload=useCallback(() => { epoch.current++; setRefresh(v=>v+1); },[]);
  const sessionChanged=useCallback((session:AuthSession) => {
    // Closing the app or renewing a login must not erase saved chart history.
    // The authenticated Dashboard unmounts below; no cache is read while logged out.
    epoch.current++;runtimeReadFailures.current=0;hasRuntimeSnapshot.current=false;lastRuntime.current=null;guardPanelCache(session);setAuth(session);
    // Owner: system-tab reads wait until the first screen is drawn. The brain research read is not fetched.
    const owner=session.authenticated&&session.role!=="member"&&(session.memberId??"owner")==="owner";
    deferredPrefetch.current=null;
    if(owner){deferredPrefetch.current="owner";}
    else if(session.authenticated)prefetchSystemPanels(session.memberId??"owner",session.role!=="member");
    // Remove private snapshots immediately and invalidate any in-flight response.
    setRuntime(null);setError(null);setCachedAt(null);
    // Same owner as last time: show the last home read from this device at once, stamped, until the fresh one lands.
    if(owner){const saved=readHome<OperatorRuntime>();if(saved){lastRuntime.current=saved.value;setRuntime(saved.value);setCachedAt(saved.at);}}
    setRefresh(v=>v+1);
  },[]);
  const liveChanged=useCallback((live:LiveRuntime) => {
    epoch.current++;
    setRuntime(current=>current?{...current,live,liveMode:{requestedEnabled:live.requestedEnabled,operational:live.operational}}:null);
    setRefresh(v=>v+1);
  },[]);
  useEffect(() => {
    let active=true;
    startHomeEarly(); // in parallel with the session check (owner device only)
    void operatorRequest<AuthSession>("/api/auth/session").then(value=>{if(active)sessionChanged(value);})
      .catch(()=>{if(active)setAuth({configured:true,authenticated:false,username:"owner"});});
    return()=>{active=false;};
  },[sessionChanged]);
  useEffect(() => {
    if(!auth?.authenticated)return;
    let active=true,inFlight=false,controller:AbortController|null=null;
    let timer:ReturnType<typeof setTimeout>|null=null;
    const read=async()=>{
      if(!active||document.hidden||inFlight)return true;
      inFlight=true;controller=new AbortController();const requestEpoch=epoch.current;
      const timeout=setTimeout(()=>controller?.abort(),RUNTIME_REQUEST_TIMEOUT_MS);
      try{
        const owner=auth.role!=="member"&&(auth.memberId??"owner")==="owner";
        // Owner: the slim home read (the early one if it is still fresh). Members keep their own /api/runtime.
        const early=owner?takeHomeEarly():null,signal=controller.signal;
        const response=await (early?Promise.race([early,new Promise<never>((_,reject)=>signal.addEventListener("abort",()=>reject(new Error("timeout")),{once:true}))]):fetch(owner?"/api/home":"/api/runtime",{cache:"no-store",credentials:"same-origin",signal}));
        if(response.status===401){if(active&&requestEpoch===epoch.current)sessionChanged({...auth,authenticated:false});return false;}
        if(!response.ok)throw new Error(`HTTP ${response.status}`);
        const value=await response.json() as OperatorRuntime;
        if(active&&requestEpoch===epoch.current){runtimeReadFailures.current=0;hasRuntimeSnapshot.current=true;lastRuntime.current=value;setRuntime(value);setError(null);setCachedAt(null);
          if(auth?.authenticated&&!value.live){sessionChanged({...auth,authenticated:false});return true;}
          if(owner)saveHome(value);
          // First screen is drawn: now warm the System tab (run log status, API status, members).
          const scope=deferredPrefetch.current;
          if(scope){deferredPrefetch.current=null;setTimeout(()=>{if(active)prefetchSystemPanels(scope,true,"deferred");},1_500);}}
        return true;
      }catch{
        if(active&&requestEpoch===epoch.current&&!document.hidden){
          runtimeReadFailures.current+=1;
          if(!hasRuntimeSnapshot.current||runtimeReadFailures.current>=3)
            setError("页面连续读取失败；保留最近一次成功数据并自动重试。");
        }
        return false;
      }
      finally{clearTimeout(timeout);inFlight=false;controller=null;}
    };
    // Owner: 10s on 实盘, with real money active, or with an open position on the tab shown; 20s otherwise.
    // Member: 10s while copying or holding, 30s when copy is off and nothing is open.
    let lastOkAt=0;
    const cadence=()=>runtimeRefreshMs(auth.role,lastRuntime.current,ownerTab.current);
    const cycle=async()=>{const succeeded=await read();if(succeeded)lastOkAt=Date.now();
      if(active&&!document.hidden)timer=setTimeout(cycle,succeeded?cadence():RUNTIME_RETRY_MS);};
    const resume=()=>{if(timer)clearTimeout(timer);timer=null;if(document.hidden){controller?.abort();return;}if(!inFlight)void cycle();};
    // Tab switch: re-aim the pending timer at the new cadence measured from the last good read (no extra read).
    retune.current=()=>{if(!active||inFlight||!timer||!lastOkAt||document.hidden)return;
      clearTimeout(timer);timer=setTimeout(cycle,Math.max(0,lastOkAt+cadence()-Date.now()));};
    void cycle();document.addEventListener("visibilitychange",resume);
    window.addEventListener("focus",resume);window.addEventListener("online",resume);window.addEventListener("pageshow",resume);
    return()=>{active=false;retune.current=null;controller?.abort();if(timer)clearTimeout(timer);document.removeEventListener("visibilitychange",resume);
      window.removeEventListener("focus",resume);window.removeEventListener("online",resume);window.removeEventListener("pageshow",resume);};
  },[refresh,auth,sessionChanged]);
  if(!auth?.authenticated)return <LoginGate auth={auth} onSession={sessionChanged}/>;
  // Members get their own slim page (own live copy account only); the owner page below is untouched.
  if(auth.role==="member")return <MemberDashboard key={auth.memberId??"member"} memberName={auth.username}
    healthy={runtimeBackendOperational(runtime)} statusLabel={runtimeStatusLabel(runtime)} feedAt={runtime?.lastSuccessAt??null}
    error={runtime?.forward?.storage?.error??error} liveEnabled={runtime?.liveMode?.requestedEnabled??false}
    liveOperational={runtime?.liveMode?.operational??false}
    livePositions={Object.values(runtime?.live?.positions??{}).filter(p=>p?.status==="OPEN").length}
    livePanel={<LiveConsole view="trade" auth={auth} runtime={runtime} onSession={sessionChanged} onLive={liveChanged} onRefresh={reload}/>}
    liveSystemPanel={<LiveConsole view="system" auth={auth} runtime={runtime} onSession={sessionChanged} onLive={liveChanged} onRefresh={reload}/>}/>;
  // A device snapshot is shown with its time until the first fresh read lands; it never claims the system is healthy.
  const cachedLabel=cachedAt?`更新于 ${new Date(cachedAt).toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})} · 刷新中`:null;
  return <ForwardDashboard key={auth.memberId??"owner"} cacheScope={auth.memberId??"owner"} onTabChange={tabChanged} data={runtime?.forward?.startedAt?runtime.forward:null}
    healthy={cachedLabel?false:runtimeBackendOperational(runtime)} statusLabel={cachedLabel??runtimeStatusLabel(runtime)} feedAt={runtime?.lastSuccessAt??null}
    error={runtime?.forward?.storage?.error??error} liveEnabled={runtime?.liveMode?.requestedEnabled??false}
    liveOverview={{equity:runtime?.live?.equity??null,available:runtime?.live?.available??null,
      accountMark:runtime?.live?.accountMark?.sessionAt===(runtime?.live?.activation?.enabledAt??0)?runtime.live.accountMark:null,
      positionCount:Object.values(runtime?.live?.positions??{}).filter(p=>p?.status==="OPEN").length,
      operational:runtime?.liveMode?.operational??false,lastSyncAt:runtime?.live?.lastSyncAt??null,
      copied:runtime?.live?.mirror?.eligibleCopiedCount??runtime?.liveMirror?.eligibleCopiedCount??null,
      eligible:runtime?.live?.mirror?.eligibleSourceCount??runtime?.liveMirror?.eligibleSourceCount??null,
      missing:runtime?.live?.mirror?.eligibleMissingCount??runtime?.liveMirror?.eligibleMissingCount??null}}
    livePanel={<LiveConsole view="trade" auth={auth} runtime={runtime} onSession={sessionChanged} onLive={liveChanged} onRefresh={reload}/>}
    liveSystemPanel={<LiveConsole view="system" auth={auth} runtime={runtime} onSession={sessionChanged} onLive={liveChanged} onRefresh={reload}/>}
    accountPanel={<><MemberAccess auth={auth}/><PaperAccountReset auth={auth} runtime={runtime} onReset={reload}/></>}
    ntsView={(runtime as {nts?:import("./nts-panel.tsx").NtsView}|null)?.nts??null}
    cachedAt={cachedAt}/>;
}
