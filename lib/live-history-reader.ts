/** Private, lazy read model: no strategy/switch/position writes, one API page/minute. */
import { matchSettlements, SETTLEMENT_VERSION, type Settlement, type SettlementPosition, type GatePositionClose } from "./live-settlement.ts";
import { recordWindows, RECORD_VIEW_VERSION } from "./record-view.ts";
type Reader={get<T>(key:string):Promise<T|undefined>;list<T>(options:{prefix:string;reverse:boolean;limit:number}):Promise<Map<string,T>>;
  transaction<T>(fn:(tx:{put(entries:Record<string,unknown>):Promise<void>})=>Promise<T>):Promise<T>};
type Client={credentials:{environment:string;apiKey:string};positionCloseHistory(from:number,to:number,offset:number):Promise<GatePositionClose[]>};
export class LiveHistoryReader<T extends SettlementPosition> {
  private history:T[]=[]; private values:Record<string,Settlement>={}; private cacheKey="";
  private at=0; private work:Promise<void>|null=null; private error:string|null=null;
  private window:{from:number;to:number;offset:number}|null=null;
  view(current:readonly T[]) {
    const windows=recordWindows([...current,...this.history].filter(p=>p.status==="CLOSED"),p=>p.exitAt??0);
    const decorate=(p:T)=>({...p,...(this.values[p.id]?{settlement:this.values[p.id],realizedPnl:this.values[p.id].pnl,
      exitPrice:this.values[p.id].exitPrice,actualExitPriceVerified:true}:{})});
    return {version:RECORD_VIEW_VERSION,history:[...windows.recent,...windows.archive].map(decorate),
      checkedAt:this.at||null,pending:[...windows.recent,...windows.archive].filter(p=>!this.values[p.id]).length,
      error:this.error,updating:!!this.work};
  }
  launch(input:{storage:Reader;client:Client|null;current:readonly T[];now:number;
    valid:()=>boolean;reserve:()=>boolean;committed:(writes:number)=>void;waitUntil:(work:Promise<void>)=>void}) {

    // No client after credential removal: do not return another account's cache.
    const client=input.client;
    if(!client){
      this.values={};this.cacheKey="";
      if(!this.work&&input.now-this.at>=60000){
        this.at=input.now;
        const task=input.storage.list<{position:T}>({prefix:"live-parity:v1:closed:",reverse:true,limit:60})
          .then(rows=>{if(input.valid())this.history=[...rows.values()].map(r=>r.position);})
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
  private async refresh(input:{storage:Reader;current:readonly T[];now:number;valid:()=>boolean;reserve:()=>boolean;committed:(n:number)=>void},client:Client,identity:string) {
    const hash=[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(identity)))].map(x=>x.toString(16).padStart(2,"0")).join("");
    const key=`live-history-settlement:v1:${hash}`;
    const persisted=await input.storage.get<{version:string;values:Record<string,Settlement>}>(key);
    if(persisted&&(persisted.version!==SETTLEMENT_VERSION||!persisted.values||Object.values(persisted.values).some(v=>
      v.version!==SETTLEMENT_VERSION||![v.pnl,v.checkedAt,v.closedAt,v.openedAt,v.entryPrice,v.exitPrice].every(Number.isFinite)
      ||v.entryPrice<=0||v.exitPrice<=0||v.openedAt>v.closedAt||v.closedAt>input.now)))throw new Error("Invalid settlement cache");
    const rows=await input.storage.list<{position:T}>({prefix:"live-parity:v1:closed:",reverse:true,limit:60});
    if(!input.valid())return;
    const windows=recordWindows([...input.current,...[...rows.values()].map(r=>r.position)].filter(p=>p.status==="CLOSED"),p=>p.exitAt??0);
    const history=[...windows.recent,...windows.archive];
    this.history=history;this.values=persisted?.values??{};
    const pending=history.filter(p=>!this.values[p.id]&&p.entryAt&&p.exitAt);
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
      await input.storage.transaction(async tx=>{await tx.put({[key]:{version:SETTLEMENT_VERSION,values:kept}});});
      input.committed(1);
      if(!input.valid())return;
    }
    this.values=kept;this.error=null;
    this.window=native.length===100&&w.offset<1000?{...w,offset:w.offset+100}:null;
    if(native.length===100&&w.offset>=1000)this.error="结算查询超出单轮范围，部分记录待核对";
  }
}