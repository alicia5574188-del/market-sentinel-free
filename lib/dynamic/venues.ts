/**
 * dynamic-v1: history pages from the external public venues the worker already reads (Bybit, OKX, KuCoin). Never Gate.
 * Pure URL builders and parsers; the backfill driver does the (paced, sequential) fetch.
 */
import {IV_SEC,validBar,type Bar,type Iv} from "./series.ts";
export type Venue="BYBIT"|"OKX"|"KUCOIN";
export const VENUES:readonly Venue[]=["BYBIT","OKX","KUCOIN"];
/** bars per page each venue returns at most */
export const PAGE:Record<Venue,number>={BYBIT:1000,OKX:100,KUCOIN:200};
const BYBIT="https://api.bybit.com",OKX="https://www.okx.com",KUCOIN="https://api-futures.kucoin.com";
const base=(sym:string)=>sym.endsWith("_USDT")?sym.slice(0,-5):null;
/**
 * One page of closed bars ending before `endSec` (exclusive; null = up to now). Bybit/OKX page backwards from an end time;
 * KuCoin takes a [from,to] window.
 */
export function pageUrl(venue:Venue,sym:string,iv:Iv,endSec:number|null,limit:number):string|null{
  const b=base(sym);if(!b)return null;const n=Math.max(1,Math.min(PAGE[venue],Math.floor(limit))),sec=IV_SEC[iv];
  if(venue==="BYBIT"){const i=({"1d":"D","4h":"240","1h":"60","15m":"15","5m":"5","1m":"1"} as Record<Iv,string>)[iv];
    return `${BYBIT}/v5/market/kline?category=linear&symbol=${b}USDT&interval=${i}&limit=${n}${endSec!=null?`&end=${endSec*1000-1}`:""}`;}
  if(venue==="OKX"){const bar=({"1d":"1Dutc","4h":"4H","1h":"1H","15m":"15m","5m":"5m","1m":"1m"} as Record<Iv,string>)[iv];
    return `${OKX}/api/v5/market/history-candles?instId=${b}-USDT-SWAP&bar=${bar}&limit=${n}${endSec!=null?`&after=${endSec*1000}`:""}`;}
  const kb=b==="BTC"?"XBT":b,to=(endSec??Math.floor(Date.now()/1000/sec)*sec)*1000-1,from=to+1-n*sec*1000;
  return `${KUCOIN}/api/v1/kline/query?symbol=${kb}USDTM&granularity=${sec/60}&from=${from}&to=${to}`;
}
/** parse a page; only bars that are closed at `nowSec`; throws on a payload that is not a kline list */
export function parsePage(venue:Venue,iv:Iv,body:unknown,nowSec:number):Bar[]{
  const sec=IV_SEC[iv],closed=(t:number)=>t+sec<=nowSec,b=body as Record<string,unknown>;
  let rows:Bar[];
  if(venue==="BYBIT"){const r=b?.result as {list?:unknown[]}|undefined;if(b?.retCode!==0||!Array.isArray(r?.list))throw new Error("Bybit kline payload");
    rows=(r!.list as string[][]).map(x=>({t:Number(x[0])/1000,o:+x[1]!,h:+x[2]!,l:+x[3]!,c:+x[4]!,v:+x[5]!}));}
  else if(venue==="OKX"){if(b?.code!=="0"||!Array.isArray(b?.data))throw new Error("OKX kline payload");
    rows=(b.data as string[][]).filter(x=>x[8]==null||x[8]==="1").map(x=>({t:Number(x[0])/1000,o:+x[1]!,h:+x[2]!,l:+x[3]!,c:+x[4]!,v:+x[5]!}));}
  else{if(b?.code!=="200000"||!Array.isArray(b?.data))throw new Error("KuCoin kline payload");
    rows=(b.data as (string|number)[][]).map(x=>({t:Number(x[0])/1000,o:+x[1]!,h:+x[2]!,l:+x[3]!,c:+x[4]!,v:+x[5]!}));}
  return rows.filter(r=>validBar(r)&&r.t%sec===0&&closed(r.t)).sort((x,y)=>x.t-y.t);
}
export class HttpStatusError extends Error{status:number;constructor(status:number){super(`http ${status}`);this.status=status;}}
