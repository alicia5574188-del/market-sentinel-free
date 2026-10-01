/** Account observations only; no exchange calls or execution authority. */
import type {LiveAccountMark} from './live-account-view.ts';
import {EQUITY_CURVE_VERSION,FIVE_MINUTES,type CurvePage,type EquityPoint} from './equity-curve.ts';
export const LIVE_EQUITY_VERSION='gate-session-equity-v1';
export const LIVE_EQUITY_PREFIX='live-equity:v1:';
export type LiveEquityHead={version:typeof LIVE_EQUITY_VERSION;sessionAt:number;accountUser:string;
  startedAt:number;initialEquity:number;lastAt:number;lastEquity:number};
type Observation={head:LiveEquityHead;point:EquityPoint};
const stamp=(at:number)=>String(at).padStart(16,'0');
export const liveEquityPrefix=(sessionAt:number)=>`${LIVE_EQUITY_PREFIX}${stamp(sessionAt)}:`;
export const validLiveEquityCursor=(s:string)=>/^live-equity:v1:\d{16}:\d{16}$/.test(s);
export function liveEquityView(head:LiveEquityHead|null|undefined,mark:LiveAccountMark|null|undefined,
  enabled:boolean,sessionAt:number,now:number){
  if(!head||head.version!==LIVE_EQUITY_VERSION||head.sessionAt!==sessionAt)return null;
  const fresh=enabled&&mark?.sessionAt===sessionAt&&mark.accountUser===head.accountUser
    &&mark.startedAt===head.startedAt&&mark.initialEquity===head.initialEquity
    &&mark.at>=head.lastAt&&mark.at<=now&&now-mark.at<=30_000;
  return {healthy:!!fresh,data:{startedAt:head.startedAt,initialEquity:head.initialEquity,
    equity:fresh?mark.equity:head.lastEquity,updatedAt:fresh?mark.at:head.lastAt,
    lastCycleAt:head.lastAt,policyVersion:LIVE_EQUITY_VERSION,engineVersion:LIVE_EQUITY_VERSION,
    storage:{persistedAt:head.lastAt}}};
}
/** A fresh native mark is sampled at most once per five minutes. The head is
 * advanced by the caller only when its row and checkpoint commit together. */
export function prepareLiveEquity(mark:LiveAccountMark|null|undefined,enabled:boolean,sessionAt:number,
  previous:LiveEquityHead|null|undefined,now:number):{head:LiveEquityHead;key:string;value:Observation}|null {
  if(!enabled||!mark||mark.sessionAt!==sessionAt||!Number.isSafeInteger(sessionAt)||sessionAt<=0
    ||!mark.accountUser||!Number.isSafeInteger(mark.at)||mark.at<sessionAt||mark.at>now
    ||now-mark.at>30_000||!Number.isFinite(mark.equity)||mark.equity<0
    ||!Number.isSafeInteger(mark.startedAt)||mark.startedAt<sessionAt||mark.startedAt>mark.at
    ||!Number.isFinite(mark.initialEquity)||mark.initialEquity<0)return null;
  const same=previous?.version===LIVE_EQUITY_VERSION&&previous.sessionAt===sessionAt
    &&previous.accountUser===mark.accountUser&&previous.startedAt===mark.startedAt
    &&previous.initialEquity===mark.initialEquity;
  if(same&&mark.at-previous.lastAt<FIVE_MINUTES)return null;
  const head:LiveEquityHead={version:LIVE_EQUITY_VERSION,sessionAt,accountUser:mark.accountUser,
    startedAt:mark.startedAt,initialEquity:mark.initialEquity,lastAt:mark.at,lastEquity:mark.equity};
  const point:EquityPoint={at:mark.at,equity:mark.equity,kind:'observed',policy:LIVE_EQUITY_VERSION,homogeneous:true};
  return {head,key:`${liveEquityPrefix(sessionAt)}${stamp(mark.at)}`,value:{head,point}};
}
type Storage={list<T>(options:{prefix:string;startAfter?:string;end?:string;limit:number;reverse:boolean}):Promise<Map<string,T>>};
/** Authenticated, account-local, bounded GET projection. Rows stay outside the
 * hot checkpoint; a long enabled session cannot grow its checkpoint body. */
export class LiveEquityReader {
  private active:{key:string;work:Promise<CurvePage>}|null=null;
  private cache=new Map<string,{page:CurvePage;at:number}>();
  async read(storage:Storage,head:LiveEquityHead,cursor:string|null,now:number,after:string|null=null):Promise<CurvePage>{
    const prefix=liveEquityPrefix(head.sessionAt);
    if(cursor&&after)throw new Error('INVALID_CURSOR');
    for(const c of [cursor,after])if(c&&(!validLiveEquityCursor(c)||!c.startsWith(prefix)))throw new Error('INVALID_CURSOR');
    const key=`${head.sessionAt}:${head.accountUser}:${head.startedAt}:${head.lastAt}:${cursor??''}:${after??''}`;
    const cached=this.cache.get(key);if(cached&&now-cached.at<30_000)return {...cached.page,generatedAt:now};
    if(this.active){if(this.active.key===key)return this.active.work;throw new Error('CURVE_BUSY');}
    const work=(async()=>{
      const boundary=`${prefix}${stamp(head.lastAt+1)}`;
      const rows=await storage.list<Observation>({prefix,...(after?{startAfter:after}:{}),end:cursor&&cursor<boundary?cursor:boundary,limit:65,reverse:!after});
      const entries=[...rows.entries()],page=entries.slice(0,64);
      const points=page.flatMap(([k,v])=>v?.head?.version===LIVE_EQUITY_VERSION
        &&v.head.sessionAt===head.sessionAt&&v.head.accountUser===head.accountUser
        &&v.head.startedAt===head.startedAt&&v.head.initialEquity===head.initialEquity
        &&v.point?.kind==='observed'&&v.point.policy===LIVE_EQUITY_VERSION&&Number.isFinite(v.point.equity)
        &&v.point.at>=head.startedAt&&v.point.at<=head.lastAt&&v.point.at<=now
        &&k===`${prefix}${stamp(v.point.at)}`?[v.point]:[]).sort((a,b)=>a.at-b.at);
      const result:CurvePage={version:EQUITY_CURVE_VERSION,context:{startedAt:head.startedAt,initialEquity:head.initialEquity,
        policy:LIVE_EQUITY_VERSION,exitPolicy:LIVE_EQUITY_VERSION,comparableSince:head.startedAt,persistedAt:head.lastAt},
        points,nextCursor:!after&&entries.length>64?page.at(-1)![0]:null,
        newestCursor:after?(page.at(-1)?.[0]??after):(page[0]?.[0]??null),afterCursor:after?(page.at(-1)?.[0]??after):null,
        moreAfter:!!after&&entries.length>64,scannedTo:page.length?Number(page.at(-1)![0].slice(prefix.length)):null,
        omitted:page.length-points.length,scanned:page.length,generatedAt:now};
      this.cache.set(key,{page:result,at:now});while(this.cache.size>64)this.cache.delete(this.cache.keys().next().value!);
      return result;
    })();this.active={key,work};
    try{return await work;}finally{this.active=null;}
  }
}
