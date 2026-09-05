import { completeFiveMinutes } from './analog-path-strategy.ts';
import type { Hte31Candle } from './hte31-types.ts';
import { completeMinutes, minuteTime } from './scalp-strategy.ts';
export type MinuteCache = { rows:Hte31Candle[]; attemptedBucket:number; failures:number; retryAt:number; error:string|null };
export type MinuteStorage = {get<T>(key:string):Promise<T|undefined>;put<T>(key:string,value:T):Promise<unknown>};
/** One request per coin/minute, restart-safe backoff, and bounded bootstrap/gap repair. */
export async function loadMinuteFeed(storage:MinuteStorage, fetchRows:(symbol:string,limit:number)=>Promise<Hte31Candle[]>, symbol:string, now:number) {
  const key=`minute:${symbol}`, bucket=Math.floor(now/60_000);
  let cache=await storage.get<MinuteCache>(key)??{rows:[],attemptedBucket:-1,failures:0,retryAt:0,error:null};
  if(cache.attemptedBucket===bucket||cache.retryAt>now) return cache;
  // Persist intent before network IO: retries/restarts never hammer the endpoint.
  cache={...cache,attemptedBucket:bucket}; await storage.put(key,cache);
  try {
    const last=cache.rows.at(-1), repair=!last||now-minuteTime(last)>6*60_000||cache.rows.length<195;
    const fresh=await fetchRows(symbol,repair?390:8), rows=completeMinutes([...cache.rows,...fresh],now);
    if(!rows.length||now-minuteTime(rows.at(-1)!)>=120_000) throw new Error('一分钟行情过期或为空');
    cache={rows,attemptedBucket:bucket,failures:0,retryAt:0,error:null};
  } catch(error) {
    const failures=cache.failures+1;
    cache={...cache,failures,retryAt:now+Math.min(10*60_000,60_000*2**Math.min(4,failures-1)),error:error instanceof Error?error.message:'行情读取失败'};
  }
  await storage.put(key,cache); return cache;
}
export async function boundedMap<T,R>(items:T[], concurrency:number, task:(item:T,index:number)=>Promise<R>) {
  const results:PromiseSettledResult<R>[]=new Array(items.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{for(;;){const i=cursor++;if(i>=items.length)return;try{results[i]={status:'fulfilled',value:await task(items[i],i)}}catch(reason){results[i]={status:'rejected',reason}}}}));
  return results;
}
export const nextMinuteScan = (now:number) => (Math.floor(now/60_000)+1)*60_000+2_000;

/** One five-minute producer per coin; old minute cache remains readable for legacy positions. */
export async function loadHourFeed(storage:MinuteStorage,fetchRows:(symbol:string,limit:number)=>Promise<Hte31Candle[]>,symbol:string,now:number) {
 const key=`hour:${symbol}`,bucket=Math.floor(now/300_000);
 let cache=await storage.get<MinuteCache>(key)??{rows:[],attemptedBucket:-1,failures:0,retryAt:0,error:null};
 if(cache.attemptedBucket===bucket||cache.retryAt>now)return cache;
 cache={...cache,attemptedBucket:bucket};await storage.put(key,cache);
 try {
  const last=cache.rows.at(-1),repair=!last||now-minuteTime(last)>30*60_000||cache.rows.length<39;
  const rows=completeFiveMinutes([...cache.rows,...await fetchRows(symbol,repair?400:8)],now);
  if(rows.length<39||now-minuteTime(rows.at(-1)!)>=600_000)throw new Error('五分钟行情不足或过期');
  cache={rows,attemptedBucket:bucket,failures:0,retryAt:0,error:null};
 }catch(error){const failures=cache.failures+1;cache={...cache,failures,retryAt:Math.max(now+Math.min(30*60_000,300_000*2**Math.min(failures-1,3)),Number((error as {retryAt?:number})?.retryAt)||0),error:error instanceof Error?error.message:'行情读取失败'};}
 await storage.put(key,cache);return cache;
}
