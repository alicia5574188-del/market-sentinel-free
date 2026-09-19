"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ForwardDashboard from "./forward-dashboard.tsx";
import LiveConsole from "./live-console.tsx";
import { LoginGate, MemberAccess } from "./member-access.tsx";
import { runtimeBackendOperational } from "../lib/runtime-health.ts";
import { operatorRequest, type AuthSession, type LiveRuntime, type OperatorRuntime } from "../lib/operator-ui.ts";

const RUNTIME_REQUEST_TIMEOUT_MS = 12_000;
const RUNTIME_REFRESH_MS = 10_000;
const RUNTIME_RETRY_MS = 3_000;

export default function Home() {
  const [runtime,setRuntime] = useState<OperatorRuntime|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [auth,setAuth] = useState<AuthSession|null>(null);
  const [refresh,setRefresh] = useState(0);
  const epoch=useRef(0);
  const reload=useCallback(() => { epoch.current++; setRefresh(v=>v+1); },[]);
  const sessionChanged=useCallback((session:AuthSession) => {
    // Closing the app or renewing a login must not erase saved chart history.
    // The authenticated Dashboard unmounts below; no cache is read while logged out.
    epoch.current++; setAuth(session);
    // Remove private snapshots immediately and invalidate any in-flight response.
    setRuntime(null);setRefresh(v=>v+1);
  },[]);
  const liveChanged=useCallback((live:LiveRuntime) => {
    epoch.current++;
    setRuntime(current=>current?{...current,live,liveMode:{requestedEnabled:live.requestedEnabled,operational:live.operational}}:null);
    setRefresh(v=>v+1);
  },[]);
  useEffect(() => {
    let active=true;
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
        const response=await fetch("/api/runtime",{cache:"no-store",credentials:"same-origin",signal:controller.signal});
        if(response.status===401){if(active&&requestEpoch===epoch.current)sessionChanged({...auth,authenticated:false});return false;}
        if(!response.ok)throw new Error(`HTTP ${response.status}`);
        const value=await response.json() as OperatorRuntime;
        if(active&&requestEpoch===epoch.current){setRuntime(value);setError(null);
          if(auth?.authenticated&&!value.live)sessionChanged({...auth,authenticated:false});}
        return true;
      }catch(failure){if(active&&requestEpoch===epoch.current)setError(failure instanceof Error?failure.message:"读取失败");return false;}
      finally{clearTimeout(timeout);inFlight=false;controller=null;}
    };
    const cycle=async()=>{const succeeded=await read();if(active&&!document.hidden)timer=setTimeout(cycle,succeeded?RUNTIME_REFRESH_MS:RUNTIME_RETRY_MS);};
    const resume=()=>{if(timer)clearTimeout(timer);timer=null;if(document.hidden){controller?.abort();return;}if(!inFlight)void cycle();};
    void cycle();document.addEventListener("visibilitychange",resume);
    window.addEventListener("focus",resume);window.addEventListener("online",resume);window.addEventListener("pageshow",resume);
    return()=>{active=false;controller?.abort();if(timer)clearTimeout(timer);document.removeEventListener("visibilitychange",resume);
      window.removeEventListener("focus",resume);window.removeEventListener("online",resume);window.removeEventListener("pageshow",resume);};
  },[refresh,auth,sessionChanged]);
  if(!auth?.authenticated)return <LoginGate auth={auth} onSession={sessionChanged}/>;
  return <ForwardDashboard key={auth.memberId??"owner"} cacheScope={auth.memberId??"owner"} data={runtime?.forward?.startedAt?runtime.forward:null}
    healthy={runtimeBackendOperational(runtime)} feedAt={runtime?.lastSuccessAt??null}
    error={runtime?.forward?.storage?.error??error} liveEnabled={runtime?.liveMode?.requestedEnabled??false}
    liveOverview={{equity:runtime?.live?.equity??null,available:runtime?.live?.available??null,
      positionCount:Object.values(runtime?.live?.positions??{}).filter(p=>p?.status==="OPEN").length,
      operational:runtime?.liveMode?.operational??false,lastSyncAt:runtime?.live?.lastSyncAt??null,
      copied:runtime?.live?.mirror?.eligibleCopiedCount??runtime?.liveMirror?.eligibleCopiedCount??null,
      eligible:runtime?.live?.mirror?.eligibleSourceCount??runtime?.liveMirror?.eligibleSourceCount??null,
      missing:runtime?.live?.mirror?.eligibleMissingCount??runtime?.liveMirror?.eligibleMissingCount??null}}
    livePanel={<LiveConsole view="trade" auth={auth} runtime={runtime} onSession={sessionChanged} onLive={liveChanged} onRefresh={reload}/>}
    liveSystemPanel={<LiveConsole view="system" auth={auth} runtime={runtime} onSession={sessionChanged} onLive={liveChanged} onRefresh={reload}/>}
    accountPanel={<MemberAccess auth={auth}/>} memberName={auth.role==="member"?auth.username:undefined}/>;
}