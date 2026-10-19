/** Stale-while-revalidate cache for System-tab panels. Display data only.
 * Memory keeps the last good value for the open app (survives tab switches); localStorage keeps a sanitized copy so a
 * fresh app open renders at once. Nothing here authorizes trading, and no request here reaches Gate. */
import {useCallback,useEffect,useRef,useState} from "react";

export const PANEL_CACHE_PREFIX="sentinel-panel-v1:";
export const PANEL_FRESH_MS=60_000;
/** Snapshots older than this are not shown from localStorage at all. */
export const PANEL_MAX_AGE_MS=7*86_400_000;

export type PanelEntry<T>={value:T;at:number};
type Store=Pick<Storage,"getItem"|"setItem"|"removeItem"|"key"|"length">;

const memory=new Map<string,PanelEntry<unknown>>();
const inflight=new Map<string,Promise<unknown>>();
const listeners=new Map<string,Set<(e:PanelEntry<unknown>)=>void>>();
let generation=0;

const storage=():Store|null=>{try{return typeof localStorage==="undefined"?null:localStorage;}catch{return null;}};
const slot=(scope:string,key:string)=>`${PANEL_CACHE_PREFIX}${encodeURIComponent(scope)}:${key}`;

export function readPanel<T>(scope:string,key:string,now=Date.now()):PanelEntry<T>|null{
  const id=slot(scope,key),hot=memory.get(id);
  if(hot)return hot as PanelEntry<T>;
  try{
    const raw=storage()?.getItem(id);if(!raw)return null;
    const saved=JSON.parse(raw) as {v?:number;at?:unknown;value?:unknown};
    if(saved?.v!==1||typeof saved.at!=="number"||!Number.isFinite(saved.at)||saved.at>now+60_000||now-saved.at>PANEL_MAX_AGE_MS||saved.value==null)return null;
    const entry={value:saved.value as T,at:saved.at};memory.set(id,entry);return entry;
  }catch{return null;}
}

/** Memory gets the full value; localStorage only what `persist` returns (null = do not persist). */
export function writePanel<T>(scope:string,key:string,value:T,persist:((v:T)=>unknown)|null,at=Date.now()){
  const id=slot(scope,key),entry={value,at};memory.set(id,entry);
  if(persist){try{const kept=persist(value);if(kept!=null)storage()?.setItem(id,JSON.stringify({v:1,at,value:kept}));}catch{/* optional cache */}}
  for(const fn of listeners.get(id)??[])fn(entry);
  return entry;
}

/** Forget one snapshot (e.g. an export moved a cursor, so the old count is wrong). */
export function dropPanel(scope:string,key:string){
  const id=slot(scope,key);memory.delete(id);try{storage()?.removeItem(id);}catch{/* optional cache */}
}

/** Logout / account switch: drop every panel snapshot, in memory and on the device. */
export function clearPanels(){
  generation++;memory.clear();inflight.clear();
  const s=storage();if(!s)return;
  try{for(let i=s.length-1;i>=0;i--){const k=s.key(i);if(k?.startsWith(PANEL_CACHE_PREFIX))s.removeItem(k);}}catch{/* optional cache */}
}

/** One request per key at a time; a prefetch and a mounting panel share it. */
export function loadPanel<T>(scope:string,key:string,fetcher:()=>Promise<T>,persist:((v:T)=>unknown)|null):Promise<PanelEntry<T>>{
  const id=slot(scope,key),running=inflight.get(id);
  if(running)return running as Promise<PanelEntry<T>>;
  const born=generation;
  const work=fetcher().then(value=>{
    // A logout in the meantime: the answer belongs to the old session and is dropped.
    if(born!==generation)throw new Error("session changed");
    return writePanel(scope,key,value,persist);
  }).finally(()=>{if(inflight.get(id)===work)inflight.delete(id);});
  inflight.set(id,work);
  return work;
}

export function prefetchPanel<T>(scope:string,key:string,fetcher:()=>Promise<T>,persist:((v:T)=>unknown)|null,fresh=PANEL_FRESH_MS){
  const cached=readPanel<T>(scope,key);
  if(cached&&Date.now()-cached.at<fresh&&memory.has(slot(scope,key)))return;
  void loadPanel(scope,key,fetcher,persist).catch(()=>undefined);
}

export type PanelState<T>={value:T|null;at:number|null;refreshing:boolean;failed:boolean;
  refresh:()=>Promise<T|null>;set:(value:T)=>void};

/** Render the cached value first, refresh in the background, swap in silently. Loading only without any cache. */
export function usePanel<T>(scope:string,key:string,fetcher:()=>Promise<T>,options:{persist?:((v:T)=>unknown)|null;fresh?:number;every?:number;enabled?:boolean}={}):PanelState<T>{
  const {persist=null,fresh=PANEL_FRESH_MS,every,enabled=true}=options;
  const [entry,setEntry]=useState<PanelEntry<T>|null>(()=>enabled?readPanel<T>(scope,key):null);
  const [refreshing,setRefreshing]=useState(false),[failed,setFailed]=useState(false);
  const fetchRef=useRef(fetcher),persistRef=useRef(persist);
  useEffect(()=>{fetchRef.current=fetcher;persistRef.current=persist;});
  const refresh=useCallback(async()=>{
    setRefreshing(true);
    try{const next=await loadPanel(scope,key,()=>fetchRef.current(),persistRef.current);setFailed(false);return next.value;}
    catch(e){setFailed(true);throw e;}
    finally{setRefreshing(false);}
  },[scope,key]);
  useEffect(()=>{
    if(!enabled)return;
    const id=slot(scope,key),fn=(e:PanelEntry<unknown>)=>setEntry(e as PanelEntry<T>);
    if(!listeners.has(id))listeners.set(id,new Set());
    listeners.get(id)!.add(fn);
    const cached=readPanel<T>(scope,key);
    const tick=()=>{void refresh().catch(()=>undefined);};
    // Fresh enough (e.g. just switched back to this tab, or prefetched): no request now.
    if(!cached||Date.now()-cached.at>=fresh)tick();
    const timer=every?setInterval(tick,every):null;
    return()=>{listeners.get(id)?.delete(fn);if(timer)clearInterval(timer);};
  },[scope,key,enabled,fresh,every,refresh]);
  const set=useCallback((value:T)=>{writePanel(scope,key,value,persistRef.current);},[scope,key]);
  return {value:entry?.value??null,at:entry?.at??null,refreshing,failed,refresh,set};
}

/* ---- What may be written to the device. Secrets and secret-like fields never are. ---- */

type CredentialLike={configured?:unknown;environment?:unknown;status?:unknown;lastVerifiedAt?:unknown;[k:string]:unknown};
/** API status: whether it is configured and when it was checked. No key, hint, secret or error text. */
export function persistableCredential<T extends CredentialLike>(c:T|null|undefined){
  if(!c||typeof c!=="object")return null;
  return {configured:c.configured===true,environment:typeof c.environment==="string"?c.environment:null,keyHint:null,
    status:typeof c.status==="string"?c.status:"",lastVerifiedAt:typeof c.lastVerifiedAt==="number"?c.lastVerifiedAt:null,lastError:null};
}
/** Member overview without the invite code (it is a live credential for registration). */
export function persistableMembers<T extends {invite?:unknown}>(o:T|null|undefined){
  if(!o||typeof o!=="object")return null;
  return {...o,invite:null};
}
