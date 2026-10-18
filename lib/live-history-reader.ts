/** Private, lazy read model: no strategy/switch/position writes, one API page/minute. */
import { matchSettlements, SETTLEMENT_VERSION, type Settlement, type SettlementPosition, type GatePositionClose } from "./live-settlement.ts";
import { recordWindows, RECORD_VIEW_VERSION } from "./record-view.ts";
type Reader={get<T>(key:string):Promise<T|undefined>;list<T>(options:{prefix:string;reverse:boolean;limit:number}):Promise<Map<string,T>>;
  transaction<T>(fn:(tx:{put(entries:Record<string,unknown>):Promise<void>})=>Promise<T>):Promise<T>};
type Client={credentials:{environment:string;apiKey:string};positionCloseHistory(from:number,to:number,offset:number):Promise<GatePositionClose[]>};
type Persisted={version:string;values:Record<string,Settlement>};
const settlementKey=async(identity:string)=>`live-history-settlement:v1:${[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(identity)))].map(x=>x.toString(16).padStart(2,"0")).join("")}`;
/** Same acceptance rule the refresh path has always used; a bad cache is never shown. */
const cacheValid=(persisted:Persisted|undefined,now:number)=>!persisted||persisted.version===SETTLEMENT_VERSION&&!!persisted.values&&Object.values(persisted.values).every(v=>
  v.version===SETTLEMENT_VERSION&&[v.pnl,v.checkedAt,v.closedAt,v.openedAt,v.entryPrice,v.exitPrice].every(Number.isFinite)
  &&v.entryPrice>0&&v.exitPrice>0&&v.openedAt<=v.closedAt&&v.closedAt<=now);
export class LiveHistoryReader<T extends SettlementPosition> {
  private history:T[]=[]; private values:Record<string,Settlement>={}; private cacheKey="";
  private at=0; private work:Promise<void>|null=null; private error:string|null=null;
  private window:{from:number;to:number;offset:number}|null=null; private epochAt=0; private hydratedKey="";
  reset(epochAt=0){this.history=[];this.values={};this.cacheKey="";this.at=0;this.window=null;this.error=null;this.epochAt=Math.max(0,epochAt);this.hydratedKey="";}
  /** Attach already-settled values to any list (e.g. the runtime's closed records). In-memory only, current account only. */
  decorate<P extends {id:string}>(rows:readonly P[],client:Client|null):P[] {
    if(!client||this.cacheKey!==`private:${client.credentials.environment}:${client.credentials.apiKey}`)return [...rows];
    return rows.map(p=>this.values[p.id]?{...p,settlement:this.values[p.id],realizedPnl:this.values[p.id].pnl,
      exitPrice:this.values[p.id].exitPrice,actualExitPriceVerified:true}:p);
  }
  /** Load the durable settlement cache once per account and DO lifetime, before the first view is returned.
   * Storage reads only: no Gate request. Any failure keeps the previous behaviour (refresh fills it later). */
  async hydrate(input:{storage:Reader;client:Client|null;now:number;sinceAt?:number;valid:()=>boolean}) {
    const sinceAt=Math.max(0,input.sinceAt??0);
    if(this.epochAt!==sinceAt)this.reset(sinceAt);
    const client=input.client;if(!client)return;
    const identity=`${client.credentials.environment}:${client.credentials.apiKey}`,cacheKey=`private:${identity}`;
    if(this.cacheKey!==cacheKey){this.values={};this.history=[];this.window=null;this.at=0;this.error=null;this.cacheKey=cacheKey;this.hydratedKey="";}
    if(this.hydratedKey===cacheKey)return;
    try{
      const key=await settlementKey(identity);
      const [persisted,rows]=await Promise.all([input.storage.get<Persisted>(key),
        input.storage.list<{position:T}>({prefix:"live-parity:v1:closed:",reverse:true,limit:60})]);
      if(!input.valid()||this.cacheKey!==cacheKey||this.epochAt!==sinceAt)return;
      if(!this.history.length)this.history=[...rows.values()].map(r=>r.position).filter(p=>p.status==="CLOSED"&&(p.exitAt??0)>=sinceAt);
      if(persisted&&cacheValid(persisted,input.now))this.values={...persisted.values,...this.values};
      this.hydratedKey=cacheKey;
    }catch{/* optional display cache; the regular refresh path still runs */}
  }
  view(current:readonly T[],sinceAt=this.epochAt) {
    const cutoff=Math.max(0,sinceAt);
    const windows=recordWindows([...current,...this.history].filter(p=>p.status==="CLOSED"&&(p.exitAt??0)>=cutoff),p=>p.exitAt??0);
    const decorate=(p:T)=>({...p,...(this.values[p.id]?{settlement:this.values[p.id],realizedPnl:this.values[p.id].pnl,
      exitPrice:this.values[p.id].exitPrice,actualExitPriceVerified:true}:{})});
    return {version:RECORD_VIEW_VERSION,history:[...windows.recent,...windows.archive].map(decorate),
      checkedAt:this.at||null,pending:[...windows.recent,...windows.archive].filter(p=>!this.values[p.id]).length,
      error:this.error,updating:!!this.work};
  }
  needsRefresh(current:readonly T[],sinceAt=this.epochAt) {
    return this.view(current,sinceAt).pending>0;
  }
  launch(input:{storage:Reader;client:Client|null;current:readonly T[];now:number;sinceAt?:number;
    valid:()=>boolean;reserve:()=>boolean;persist:(entries:Record<string,unknown>)=>Promise<void>;waitUntil:(work:Promise<void>)=>void}) {

    const sinceAt=Math.max(0,input.sinceAt??0);
    if(this.epochAt!==sinceAt)this.reset(sinceAt);
    // No client after credential removal: do not return another account's cache.
    const client=input.client;
    if(!client){
      this.values={};this.cacheKey="";
      if(!this.work&&input.now-this.at>=60000){
        this.at=input.now;
        const task=input.storage.list<{position:T}>({prefix:"live-parity:v1:closed:",reverse:true,limit:60})
          .then(rows=>{if(input.valid())this.history=[...rows.values()].map(r=>r.position).filter(p=>(p.exitAt??0)>=sinceAt);})
          .catch(()=>{this.error="历史记录读取失败，保留最近记录";});
        this.work=task;input.waitUntil(task.finally(()=>{if(this.work===task)this.work=null;}));
      }
      return;
    }
    const identity=`${client.credentials.environment}:${client.credentials.apiKey}`;
    if(this.cacheKey!==`private:${identity}`){this.values={};this.history=[];this.window=null;this.at=0;this.error=null;}
    if(this.work||input.now-this.at<60000)return;
    this.at=input.now;this.cacheKey=`private:${identity}`;
    const task=this.refresh(input,client,identity).catch(()=>{this.error="历史结算暂不可用，保留已核对记录";});
    this.work=task;input.waitUntil(task.finally(()=>{if(this.work===task)this.work=null;}));
  }
  private async refresh(input:{storage:Reader;current:readonly T[];now:number;valid:()=>boolean;reserve:()=>boolean;persist:(entries:Record<string,unknown>)=>Promise<void>},client:Client,identity:string) {
    const key=await settlementKey(identity);
    const persisted=await input.storage.get<Persisted>(key);
    if(!cacheValid(persisted,input.now))throw new Error("Invalid settlement cache");
    const rows=await input.storage.list<{position:T}>({prefix:"live-parity:v1:closed:",reverse:true,limit:60});
    if(!input.valid())return;
    const windows=recordWindows([...input.current,...[...rows.values()].map(r=>r.position)]
      .filter(p=>p.status==="CLOSED"&&(p.exitAt??0)>=this.epochAt),p=>p.exitAt??0);
    const history=[...windows.recent,...windows.archive];
    this.history=history;this.values={...this.values,...persisted?.values};
    // Settled records are never queried again. A record without a copy receipt can never match a Gate
    // close row (see candidate()), so it does not keep the page asking Gate every minute either.
    const pending=history.filter(p=>!this.values[p.id]&&p.entryAt&&p.exitAt&&p.parity);
    if(!pending.length){this.error=null;return;}
    if(!input.reserve())throw new Error("No optional write reserve");
    this.window??={from:Math.max(0,Math.floor(Math.min(...pending.map(p=>p.entryAt!))/1000)-120),to:Math.floor(input.now/1000)-5,offset:0};
    const w={...this.window};if(w.to<w.from)return;
    const native=await client.positionCloseHistory(w.from,w.to,w.offset);
    if(!input.valid())return;
    const found=matchSettlements(history,native,input.now);
    const values={...this.values,...found};
    // Bounded private display cache; original close ledger and accounting untouched.
    const kept=Object.fromEntries(history.flatMap(p=>values[p.id]?[[p.id,values[p.id]]]:[]));
    if(Object.keys(found).length){
      if(!input.reserve())throw new Error("No optional write reserve");
      await input.persist({[key]:{version:SETTLEMENT_VERSION,values:kept}});
      if(!input.valid())return;
    }
    this.values=kept;this.error=null;
    this.window=native.length===100&&w.offset<1000?{...w,offset:w.offset+100}:null;
    if(native.length===100&&w.offset>=1000)this.error="结算查询超出单轮范围，部分记录待核对";
  }
}
