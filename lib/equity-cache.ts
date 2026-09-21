import {EQUITY_CURVE_VERSION,type CurveContext,type CurvePage,type EquityPoint} from "./equity-curve.ts";

/** Browser-only projection cache. Never imports the Worker, trading or credentials.
 * A Dashboard owns one instance; destroying a chart tab does not destroy history.
 * localStorage retains the projection across app/browser restarts. Authentication
 * is still required before configure; no session, API key or LIVE state is stored. */
export const EQUITY_CACHE_VERSION="incremental-persistent-v2";
const PERSISTENT_V1="incremental-persistent-v1";
const LEGACY_VERSION="incremental-session-v1";
const PREFIX="sentinel:equity-cache:v1:";
// Bound parsing of untrusted browser data, not the age/number of saved points.
// A failed/quota-exceeded write retains the last good snapshot and its cursors.
const LIMIT=8_000_000;
type BrowserStorage=Pick<Storage,"getItem"|"setItem"|"removeItem"|"key"|"length">;
type Options={fetch?:typeof fetch;now?:()=>number;pause?:()=>Promise<void>;storage?:()=>BrowserStorage|null;legacyStorage?:()=>BrowserStorage|null};
export type EquityHistory={account:number;points:EquityPoint[];cursor:string|null;done:boolean;
  coveredTo:number|null;loaded:boolean;newestCursor:string|null;checkedCycle:number;
  latestAt:number;catchingUp:boolean;loading:boolean;error:string|null;cacheNotice:string|null};
const empty=():EquityHistory=>({account:0,points:[],cursor:null,done:false,coveredTo:null,loaded:false,
  newestCursor:null,checkedCycle:0,latestAt:0,catchingUp:false,loading:false,error:null,cacheNotice:null});
const browserStorage=()=>{try{return typeof window==="undefined"?null:window.localStorage;}catch{return null;}};
const legacyBrowserStorage=()=>{try{return typeof window==="undefined"?null:window.sessionStorage;}catch{return null;}};
const cursorOK=(s:unknown):s is string=>typeof s==="string"&&/^forward-relations:v1:archive:\d{16}:\d+(?::part:\d{2})?$/.test(s);
const finite=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n);
export function clearEquityBrowserCache(storage:BrowserStorage|null=browserStorage()){
  try{if(storage)for(let i=storage.length-1;i>=0;i--){const k=storage.key(i);if(k?.startsWith(PREFIX))storage.removeItem(k);}}catch{/* Optional cache, never block logout. */}
}

export class EquityHistoryCache {
  private state=empty();private context:CurveContext|null=null;private key="";private epoch=0;
  private listeners=new Set<()=>void>();private flight:Promise<void>|null=null;private controller:AbortController|null=null;
  private lastAttempt=-Infinity;private blocked=false;
  private request:typeof fetch;private now:()=>number;private pause:()=>Promise<void>;private storage:()=>BrowserStorage|null;private legacyStorage:()=>BrowserStorage|null;
  constructor(options:Options={}){
    this.request=options.fetch??((...args)=>fetch(...args));this.now=options.now??Date.now;
    this.pause=options.pause??(()=>new Promise(r=>setTimeout(r,700)));this.storage=options.storage??browserStorage;
    this.legacyStorage=options.legacyStorage??legacyBrowserStorage;
  }
  getSnapshot=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private set(change:Partial<EquityHistory>){this.state={...this.state,...change};for(const listener of this.listeners)listener();}
  /** Called only after existing program authentication. Identity does NOT include
   * strategy version: old real points must survive a read-only feature release. */
  configure(context:CurveContext,scope:string){
    const key=`${PREFIX}${encodeURIComponent(scope)}:${context.startedAt}:${context.initialEquity}`;
    this.context=context;
    if(this.key!==key){
      this.cancel();this.key=key;this.blocked=false;this.lastAttempt=-Infinity;this.state={...empty(),account:context.startedAt};
      // Hydrate synchronously before the chart can start its first HTTP request.
      // Keep the stable account key; a UI release or renewed login is not a reset.
      let migratedLegacy=false,projectionUpgrade=false;
      for(const [index,source] of [this.storage,this.legacyStorage].entries()){
      try{
        const raw=source()?.getItem(key);
        if(raw&&raw.length<=LIMIT){
          const s=JSON.parse(raw);
          const validCursor=(v:unknown)=>v===null||(cursorOK(v)&&Number(v.split(":")[3])>=context.startedAt);
          if((s.version===EQUITY_CACHE_VERSION||s.version===PERSISTENT_V1||s.version===LEGACY_VERSION)
            &&s.account===context.startedAt&&s.initialEquity===context.initialEquity
            &&Array.isArray(s.points)&&validCursor(s.cursor)&&validCursor(s.newestCursor)
            &&typeof s.done==="boolean"&&typeof s.loaded==="boolean"&&typeof s.catchingUp==="boolean"
            &&finite(s.latestAt)&&s.latestAt<=this.now()&&finite(s.checkedCycle)&&s.checkedCycle<=this.now()
            &&(s.coveredTo===null||finite(s.coveredTo)&&s.coveredTo>=context.startedAt)){
            let last=context.startedAt;
            const points:EquityPoint[]=s.points.map((p:unknown)=>{
              if(!Array.isArray(p)||(p.length!==4&&p.length!==5)||!finite(p[0])||p[0]<=last||p[0]>this.now()
                ||!finite(p[1])||typeof p[2]!=="string"||typeof p[3]!=="boolean"
                ||(p.length===5&&typeof p[4]!=="boolean"))throw new Error("Invalid local point");
              last=p[0];return{at:p[0],equity:p[1],policy:p[2],homogeneous:p[3],kind:"observed",
                ...(p.length===5&&p[4]?{stale:true}:{})};
            });
            const oldProjection=s.version!==EQUITY_CACHE_VERSION;
            this.state={...this.state,points,cursor:oldProjection?null:s.cursor,newestCursor:oldProjection?null:s.newestCursor,
              done:oldProjection?false:s.done,loaded:oldProjection?false:s.loaded,coveredTo:oldProjection?null:s.coveredTo,
              latestAt:oldProjection?0:s.latestAt,checkedCycle:oldProjection?0:s.checkedCycle,
              catchingUp:oldProjection?false:s.catchingUp};
            if(!oldProjection&&finite(s.lastAttempt)&&s.lastAttempt<=this.now())this.lastAttempt=s.lastAttempt;
            migratedLegacy=index===1;projectionUpgrade=oldProjection;break;
          }
        }
      }catch{/* Damaged, blocked or unavailable browser cache falls back to actual saved history. */}
      }
      // Projection v2 re-reads the archive while retaining old points, so marks
      // previously omitted only because one position quote was stale can reappear.
      // Never remove the old tab copy until the durable browser write succeeds.
      if((migratedLegacy||projectionUpgrade)&&this.persist()&&migratedLegacy)
        try{this.legacyStorage()?.removeItem(key);}catch{/* Optional */}
    }
    // Notify on configure, including after account reset; never show another account's points.
    for(const listener of this.listeners)listener();
  }
  cancel(){this.epoch++;this.controller?.abort();this.controller=null;this.flight=null;this.state={...this.state,loading:false};}
  private persist(){
    if(!this.context)return false;
    try{
      const s=this.state,raw=JSON.stringify({version:EQUITY_CACHE_VERSION,account:s.account,initialEquity:this.context.initialEquity,
        points:s.points.map(p=>[p.at,p.equity,p.policy,p.homogeneous,!!p.stale]),cursor:s.cursor,newestCursor:s.newestCursor,
        done:s.done,loaded:s.loaded,coveredTo:s.coveredTo,latestAt:s.latestAt,checkedCycle:s.checkedCycle,catchingUp:s.catchingUp,lastAttempt:this.lastAttempt});
      const storage=this.storage();if(!storage||raw.length>LIMIT)throw new Error("Browser cache unavailable");
      storage.setItem(this.key,raw);
      if(this.state.cacheNotice)this.set({cacheNotice:null});
      return true;
    }catch{
      this.set({cacheNotice:"本机未能保存新增曲线缓存；已有历史保留，重新打开时可能需要补读。"});
      return false;
    }
  }
  /** Idempotent per-tab loader. Calls made while a request is running share it.
   * An unmounted chart lets only its current GET settle, then stops. Parent logout
   * aborts and invalidates it, so late responses cannot repopulate a cleared cache. */
  load(target:number,cycle:number,active:()=>boolean):Promise<void>{
    if(this.flight)return this.flight.then(()=>this.load(target,cycle,active));
    if(!this.context||this.blocked||!active())return Promise.resolve();
    if(this.state.error&&this.now()-this.lastAttempt<60_000)return Promise.resolve();
    const epoch=this.epoch;
    const work=this.run(target,cycle,active,epoch);
    this.flight=work;
    void work.finally(()=>{if(epoch===this.epoch&&this.flight===work)this.flight=null;});
    return work;
  }
  needsHistory(target:number){const s=this.state;return !s.loaded||!s.done&&(s.coveredTo===null||s.coveredTo>target);}
  private async run(target:number,cycle:number,active:()=>boolean,epoch:number){
    // Preserve the last successful projection while fetching; never replace it with an empty chart.
    try{
      for(let n=0;n<32&&active()&&epoch===this.epoch;n++){
        const s=this.state,now=this.now();let mode:"latest"|"after"|"older";
        if(!s.loaded)mode="latest";
        else if(s.catchingUp)mode="after";
        else if(cycle>s.checkedCycle&&now-s.latestAt>=60_000)mode=s.newestCursor?"after":"latest";
        else if(this.needsHistory(target)&&s.cursor)mode="older";
        else break;
        if(now-this.lastAttempt<600){await this.pause();if(!active()||epoch!==this.epoch)break;}
        if(epoch!==this.epoch)break;
        const cursor=mode==="older"?s.cursor:mode==="after"?s.newestCursor:null;
        if(mode==="after"&&!cursor)throw new Error("新增净值游标缺失，请刷新后重试。");
        const query=cursor?`?${mode==="older"?"cursor":"after"}=${encodeURIComponent(cursor)}`:"";
        this.set({loading:true,error:null});this.lastAttempt=this.now();
        const controller=new AbortController();this.controller=controller;
        const timeout=setTimeout(()=>controller.abort(),12_000);
        let response:Response;
        try{response=await this.request(`/api/forward/equity${query}`,{credentials:"same-origin",cache:"no-store",signal:controller.signal});}
        finally{clearTimeout(timeout);if(this.controller===controller)this.controller=null;}
        if(epoch!==this.epoch)return;
        if(response.status===401||response.status===403){
          // Expired login hides the projection and stops requests, but does not
          // delete valid history. A fresh authenticated Dashboard may restore it.
          this.blocked=true;
          this.set({...empty(),account:s.account,error:"登录已失效，请重新登录。"});return;
        }
        if(!response.ok)throw new Error(response.status===429?"净值历史读取繁忙；保留已有曲线，稍后继续。":"新增净值暂未取得；已加载历史保留，交易不受图表影响。");
        const page=await response.json() as CurvePage;
        if(epoch!==this.epoch)return;
        const ctx=this.context!;
        if(page.version!==EQUITY_CURVE_VERSION||page.context?.startedAt!==ctx.startedAt||page.context.initialEquity!==ctx.initialEquity
          ||!Array.isArray(page.points)||!finite(page.generatedAt)||page.generatedAt>this.now()+60_000)
          throw new Error("净值历史与当前账户不匹配。");
        // Immutable saved marks cannot change amount just because a response overlaps.
        const points=new Map(s.points.map(p=>[p.at,p]));
        for(const p of page.points){
          if(p.at===ctx.startedAt&&p.equity===ctx.initialEquity)continue;
          if(!finite(p.at)||p.at<=ctx.startedAt||p.at>page.generatedAt||!finite(p.equity)||p.kind!=="observed"
            ||typeof p.policy!=="string"||typeof p.homogeneous!=="boolean")throw new Error("净值记录格式异常。");
          const old=points.get(p.at);if(old&&old.equity!==p.equity)throw new Error("历史净值核对不一致；保留原记录，暂不更新建议。");
          if(!old)points.set(p.at,p);
        }
        const validCursor=(v:unknown)=>v===null||(cursorOK(v)&&Number(v.split(":")[3])>=ctx.startedAt);
        if(!validCursor(page.nextCursor)||!validCursor(page.newestCursor??null)
          ||(page.scannedTo!==null&&(!finite(page.scannedTo)||page.scannedTo<ctx.startedAt)))throw new Error("净值分页无效。");
        const change:Partial<EquityHistory>={points:[...points.values()].sort((a,b)=>a.at-b.at),loaded:true};
        if(mode==="after"){
          if(!cursorOK(page.afterCursor)||page.afterCursor<cursor!||(page.moreAfter&&page.afterCursor===cursor))throw new Error("新增净值游标未推进。");
          change.newestCursor=page.afterCursor;change.catchingUp=!!page.moreAfter;
          if(!page.moreAfter){change.latestAt=this.now();change.checkedCycle=cycle;}
        }else if(mode==="older"){
          if(page.nextCursor&&page.nextCursor>=cursor!)throw new Error("历史净值游标未推进。");
          change.cursor=page.nextCursor;change.done=!page.nextCursor;change.coveredTo=page.scannedTo??s.coveredTo;
        }else{
          change.newestCursor=page.newestCursor??null;change.latestAt=this.now();change.checkedCycle=cycle;
          if(!s.loaded||!s.newestCursor){change.cursor=page.nextCursor;change.done=!page.nextCursor;change.coveredTo=page.scannedTo;}
        }
        this.set(change);this.persist();
        if(n<31&&active()){await this.pause();}
      }
    }catch(e){if(epoch===this.epoch)this.set({error:e instanceof Error?e.message:"净值读取失败；保留已加载曲线。"});}
    finally{if(epoch===this.epoch)this.set({loading:false});}
  }
}