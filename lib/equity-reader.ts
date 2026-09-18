import {FORWARD_STORAGE} from "./forward-store.ts";
import {archivedEquity,EQUITY_CURVE_VERSION,type CurveContext,type CurvePage} from "./equity-curve.ts";
type Storage={list<T>(options:{prefix:string;start:string;end?:string;limit:number;reverse:boolean}):Promise<Map<string,T>>};
const PREFIX=`${FORWARD_STORAGE}archive:`;
export const validCurveCursor=(s:string)=>/^forward-relations:v1:archive:\d{16}:\d+(?::part:\d{2})?$/.test(s);
/** Optional, demand-driven read projection. NO writes, alarms, private requests
 * or calls into the trading loop. Shared bounded cache and single-flight reads. */
export class EquityReader {
  private cache=new Map<string,{page:Omit<CurvePage,"context"|"generatedAt">;at:number}>();
  private active:{key:string;work:Promise<Omit<CurvePage,"context"|"generatedAt">>}|null=null;
  private lastRead=-Infinity;
  status={version:EQUITY_CURVE_VERSION,readOnly:true,automaticLive:false,pagesRead:0,lastReadAt:0};
  async read(storage:Storage,context:CurveContext,cursor:string|null,now:number):Promise<CurvePage>{
    if(cursor&&(!validCurveCursor(cursor)||cursor<`${PREFIX}${String(context.startedAt).padStart(16,"0")}`))throw new Error("INVALID_CURSOR");
    const key=`${context.startedAt}:${context.policy}:${context.exitPolicy}:${context.comparableSince}:${cursor??"latest"}`;
    const cached=this.cache.get(key);
    if(cached&&(cursor||now-cached.at<30_000))return {...cached.page,context,generatedAt:now};
    if(this.active){if(this.active.key===key)return {...await this.active.work,context,generatedAt:now};throw new Error("CURVE_BUSY");}
    if(now-this.lastRead<500)throw new Error("CURVE_BUSY");
    this.lastRead=now;
    const work=(async()=>{
      const rows=await storage.list<unknown>({prefix:PREFIX,start:`${PREFIX}${String(context.startedAt).padStart(16,"0")}`,
        ...(cursor?{end:cursor}:{}),limit:65,reverse:true});
      const entries=[...rows.entries()],page=entries.slice(0,64);
      const points=page.flatMap(([,v])=>{const p=archivedEquity(v,context,now);return p?[p]:[];}).sort((a,b)=>a.at-b.at);
      const result={version:EQUITY_CURVE_VERSION,points,nextCursor:entries.length>64?page.at(-1)![0]:null,
        scannedTo:page.length?Number(page.at(-1)![0].slice(PREFIX.length,PREFIX.length+16)):null,
        omitted:page.length-points.length,scanned:page.length};
      this.cache.set(key,{page:result,at:now});while(this.cache.size>64)this.cache.delete(this.cache.keys().next().value!);
      this.status={...this.status,pagesRead:this.status.pagesRead+1,lastReadAt:now};return result;
    })();
    this.active={key,work};
    try{return {...await work,context,generatedAt:now};}finally{this.active=null;}
  }
}