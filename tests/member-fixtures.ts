import type { GateLiveAccount, GateLiveOrder, GateLivePosition, LiveEntryIntent, LiveStopIntent } from "../lib/gate-live.ts";
import type { Trade } from "../lib/forward-relations.ts";
export const T=1_789_612_000_000;
export function trade(id="ft-fixture-1",symbol="BTC_USDT",side:"LONG"|"SHORT"="LONG"):Trade {
  return {id,symbol,side,openedAt:T-60_000,closedAt:null,status:"OPEN",entryPrice:100,exitPrice:null,
    quantity:2,contracts:2000,quantoMultiplier:.001,notional:200,leverage:2,margin:100,
    plannedRisk:2.4,stopPrice:side==="LONG"?99:101,armPrice:side==="LONG"?100.5:99.5,
    favorable:0,adverse:0,lastPrice:100,lastQuoteAt:T,entryFee:.14,exitFee:0,fundingAllowance:0,
    grossPnl:null,netPnl:null,exitReason:null,relationFailureBars:0,lastRelationBar:T-60_000,
    execution:"REAL_QUOTE_PAPER_MODEL",liveEligible:false,
    rule:{id:"fr-fixture-1",signature:"s",parentId:null,version:7,createdAt:T-120_000,expiresAt:T+3600000,
      status:"EXPERIMENTAL",conditions:[{feature:0,op:"GE",threshold:.1}],side,horizon:60,stopRate:.01,
      armRate:.005,givebackRate:.002,exitMode:"REACTION_DECAY",samples:20,trainGroups:3,checkGroups:2,
      estimatedNetRate:.002,priorResponse:.005,recentResponse:.004,standardError:.001,
      reason:"Synthetic functional source, never a trading result",mutation:"CREATE",grammar:"fixture",liveEligible:false}};
}
export class Memory {
  data=new Map<string,unknown>();writes=0;fail=false;alarm:number|null=null;
  private tail:Promise<unknown>=Promise.resolve();
  async get<T>(key:string){return structuredClone(this.data.get(key)) as T|undefined;}
  async put(key:string|Record<string,unknown>,value?:unknown){
    if(this.fail)throw new Error("injected storage failure");
    for(const[k,v]of typeof key==="string"?[[key,value]]:Object.entries(key)){this.data.set(k as string,structuredClone(v));this.writes++;}
  }
  async transaction<T>(fn:(storage:Memory)=>Promise<T>){const oldTail=this.tail;let unlock!:()=>void;this.tail=new Promise<void>(r=>{unlock=r;});await oldTail;
    const old=new Map(this.data);try{return await fn(this);}catch(e){this.data=old;throw e;}finally{unlock();}}
  async list<T>(options:{prefix:string;reverse?:boolean;limit?:number}){
    let rows=[...this.data].filter(([k])=>k.startsWith(options.prefix)).sort(([a],[b])=>a.localeCompare(b));
    if(options.reverse)rows=rows.reverse();return new Map(rows.slice(0,options.limit??Infinity)) as Map<string,T>;
  }
  async getAlarm(){return this.alarm;}async setAlarm(value:number){this.alarm=value;}
  async deleteAlarm(){this.alarm=null;}
  async delete(key:string|string[]){let n=0;for(const k of typeof key==="string"?[key]:key)n+=Number(this.data.delete(k));return n;}
}
export class FakeGate {
  account:GateLiveAccount={user:"synthetic-member",total:100,available:100,unrealised_pnl:0,in_dual_mode:false};
  requestCount=0;placed:LiveEntryIntent[]=[];leverages:number[]=[];stops:GateLiveOrder[]=[];
  orders=new Map<string,GateLiveOrder>();holdings:Record<string,GateLivePosition>={};
  closeTags:string[]=[];onLeverage:(()=>Promise<void>)|null=null;onCreate:(()=>Promise<void>)|null=null;
  failSnapshot=false;partial=false;zero=false;ambiguous=false;omitExit=false;counter=1;
  async snapshot(){this.requestCount++;if(this.failSnapshot)throw new Error("injected Gate outage");
    return structuredClone({account:this.account,positions:Object.values(this.holdings),orders:[],priceOrders:this.stops,checkedAt:Date.now()});}
  async setLeverage(_symbol:string,n:number){this.leverages.push(n);await this.onLeverage?.();}
  async createEntry(i:LiveEntryIntent){await this.onCreate?.();this.placed.push(structuredClone(i));const id=String(this.counter++);
    if(this.ambiguous)throw new Error("injected submission timeout");
    const filled=this.zero?0:this.partial?Math.floor(i.contracts/2):i.contracts;
    this.orders.set(id,{id_string:id,contract:String(i.body.contract),text:i.tag,status:"finished",finish_as:filled===i.contracts?"filled":"ioc",size:i.size,left:(i.size>0?1:-1)*(i.contracts-filled),fill_price:100});
    if(filled)this.holdings[String(i.body.contract)]={contract:String(i.body.contract),size:Math.sign(i.size)*filled,entry_price:100,leverage:i.leverage};
    return id;
  }
  async inspectEntry(_kind:string,_symbol:string,tag:string,id:string|null){return structuredClone(this.orders.get(id??"")??[...this.orders.values()].find(o=>o.text===tag)??null);}
  async createStop(i:LiveStopIntent){const id=String(this.counter++);this.stops.push({id_string:id,text:i.tag,contract:String((i.body.initial as Record<string,unknown>).contract),status:"open"});return id;}
  async amendStop(){return;}
  async cancelOrder(_kind:string,id:string){this.stops=this.stops.filter(s=>s.id_string!==id);}
  async closePosition(symbol:string,tag:string){this.closeTags.push(tag);delete this.holdings[symbol];const id=String(this.counter++);
    if(!this.omitExit)this.orders.set(id,{id_string:id,text:tag,contract:symbol,status:"finished",finish_as:"filled",fill_price:100.4});return id;}
}