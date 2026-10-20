/** System-tab panel sources (all cheap Worker/DO/D1 reads; none of them calls Gate) and their cache keys. */
import {operatorRequest,type CredentialStatus} from "./operator-ui.ts";
import {persistableCredential,persistableMembers,prefetchPanel} from "./panel-cache.ts";
import {prefetchBrain} from "./brain-view.ts";

export const PANEL_KEYS={logStatus:"log-status",credential:"credential",members:"members",archivePlanSince:"archive-plan-since",systemStatus:"system-status"} as const;

export async function fetchLogStatus<T>():Promise<T>{
  const r=await fetch(`/api/forward/log-status?t=${Date.now()}`,{cache:"no-store",credentials:"same-origin"});
  if(!r.ok)throw new Error("status");return await r.json() as T;
}
export async function fetchCredential():Promise<CredentialStatus>{
  const p=await operatorRequest<{credential:CredentialStatus}>("/api/live/credentials");
  if(!p?.credential)throw new Error("未收到API状态");return p.credential;
}
export async function fetchMembers<T>():Promise<T>{return await operatorRequest<T>("/api/members/admin");}

export const persistLogStatus=<T>(v:T)=>v;
export const persistCredential=persistableCredential;
export const persistMembers=persistableMembers;

/** At app start: warm what the System tab shows, so opening it needs no wait. Skips keys fresh in memory.
 * `deferred` = the System-tab reads only (run after the first screen is drawn); the brain read is not in it. */
export function prefetchSystemPanels(scope:string,owner:boolean,only:"all"|"deferred"="all"){
  // The run log and the member list are owner panels; a member page never shows them, so never fetch them for members.
  if(owner)prefetchPanel(scope,PANEL_KEYS.logStatus,fetchLogStatus,persistLogStatus);
  prefetchPanel(scope,PANEL_KEYS.credential,fetchCredential,persistCredential);
  if(owner)prefetchPanel<{invite?:unknown}>(scope,PANEL_KEYS.members,fetchMembers,persistMembers);
  // the owner home tab (大脑): first open shows the read at once
  if(only==="all"&&owner&&scope==="owner")prefetchBrain(scope);
}
