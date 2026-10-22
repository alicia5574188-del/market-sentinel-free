/**
 * dynamic-v1 runtime: owns the research layer's history, shadow trades, state, cycles and allocator gates. The worker calls
 * step() off the trading clock (never awaited by a tick, one at a time, everything in try/catch); plan inputs and the dashboard
 * view are synchronous reads of memory. Requests: external public venues only (Bybit / OKX / KuCoin), at most one per
 * BACKFILL.minGapMs. Storage: D1 only (store-d1.ts).
 */
import type {D1Like} from "../run-log-archive.ts";
import {Series,IV_SEC,type Iv} from "./series.ts";
import {pageUrl,parsePage,HttpStatusError} from "./venues.ts";
import {BACKFILL,initialBackfill,normalizeBackfill,nextJob,onPage,onFailure,backfillView,trackedSymbols,seriesKey,type BackfillState} from "./backfill.ts";
import {emptyDynStore,writeChunks,readSeries,writeTrades,readMeta,writeMeta,ensureDynSchema,chunkStart,CHUNK_SEC,type DynStoreStatus,type StoredTrade} from "./store-d1.ts";
import {POOL,POOL_BY_ID,simulate,manageLive,btcRegime,type OpenShadow,type ShadowTrade} from "./playbooks.ts";
import {dailyStates,stateChanges,bucketLabel,type DayState} from "./state.ts";
import {analyzePlaybook,phaseChanges,type PlaybookCycle,type TradeLite} from "./cycles.ts";
import {allocate,ALLOC,type Gate} from "./allocator.ts";
export const DYN_VERSION="dynamic-v1";
/** live entries must reach the engine within this long after the signal bar closed */
export const FRESH_MS:Record<Iv,number>={"1d":240*60_000,"4h":60*60_000,"1h":20*60_000};
export const TRADES_PER_STEP=200;
export const MEM_KEEP:Record<Iv,number>={"1d":1600,"4h":4500,"1h":4500};
export type DynSignal={id:string;pb:string;label:string;sym:string;side:"LONG"|"SHORT";iv:Iv;et:number;ep:number;stop:number;target:number|null;maxBars:number|null;why:string;until:number};
export type DynExit={tradeId:string;act:"GUARD"|"EXIT";stop?:number;why:string;code:string};
export type DynPlanInput={ready:boolean;gates:Record<string,Pick<Gate,"ok"|"risk"|"conf"|"why">>|null;signals:DynSignal[];exits:DynExit[];state:string|null};
export type DynEvent={at:number;k:"BACKFILL"|"STATE"|"PHASE"|"ALLOC"|"ERROR"|"BOOT";text:string};
export type DynPosition={id:string;symbol:string;side:"LONG"|"SHORT";entryPrice:number;stopPrice:number;openedAt:number;guard:number|null;pb:string;inv:number;target:number|null;maxBars:number|null};
type Fetch=(url:string)=>Promise<unknown>;
const safe=(e:unknown)=>String((e as Error)?.message??e).slice(0,160);
export class DynamicResearch{
  series=new Map<string,Series>();loaded=new Set<string>();bf:BackfillState=initialBackfill();store:DynStoreStatus=emptyDynStore();
  trades=new Map<string,TradeLite>();opens=new Map<string,OpenShadow>();dirty=new Set<string>();unsaved=new Map<string,Set<number>>();
  pendingTrades:StoredTrade[]=[];states:DayState[]=[];cycles:Record<string,PlaybookCycle>={};gates:Record<string,Gate>|null=null;
  events:DynEvent[]=[];booted=false;bootError:string|null=null;lastStepAt=0;lastStepMs=0;lastAnalyzeAt=0;lastMetaAt=0;lastError:string|null=null;
  universe:string[]=[];replays=0;analyses=0;lastBucket:string|null=null;
  /** per playbook × symbol: end (s) of the last bar replayed and the entry time of the trade open then — later replays only add
   * trades that start after it (or that one), so a replay window that starts elsewhere (trimmed memory, a reload) adds nothing old */
  wm:Record<string,[number,number|null]>={};
  /** live-management results per trade, recomputed only when its series got a new bar or its stop moved */
  private manageCache=new Map<string,{key:string;m:ReturnType<typeof manageLive>}>();
  opts:{minGapMs?:number;analyzeEveryMs?:number;metaEveryMs?:number};
  constructor(opts:{minGapMs?:number;analyzeEveryMs?:number;metaEveryMs?:number}={}){this.opts=opts;}
  private log(at:number,k:DynEvent["k"],text:string){this.events.push({at,k,text:text.slice(0,300)});if(this.events.length>200)this.events.splice(0,this.events.length-200);}
  drainEvents(){const e=this.events.slice();return e;}
  get(sym:string,iv:Iv){return this.series.get(seriesKey(sym,iv))??null;}
  /** one bounded piece of work. Never throws. */
  async step(now:number,input:{universe:readonly string[];db:D1Like|null;fetch:Fetch}):Promise<void>{
    const t0=Date.now();
    try{
      const db=input.db;if(!db){this.lastError="D1 binding missing";return;}
      this.universe=trackedSymbols(input.universe);
      if(!this.booted){await this.boot(db,now);return;}
      // 1) load stored series (up to 3 per step)
      let loads=0;for(const iv of BACKFILL.order)for(const sym of this.universe){const k=seriesKey(sym,iv);if(this.loaded.has(k)||loads>=3)continue;
        const s=await readSeries(db,this.store,sym,iv);this.series.set(k,s);this.loaded.add(k);loads++;if(s.n&&this.bf.series[k]?.done)this.dirty.add(k);}
      // 2) retry deferred chunk / trade writes
      for(const [k,ts] of [...this.unsaved]){const s=this.series.get(k);if(!s){this.unsaved.delete(k);continue;}
        if(await this.mergeWrite(db,s,[...ts],now))this.unsaved.delete(k);else break;}
      await this.flushTrades(db,now);
      // 3) one request (paced)
      const job=nextJob(this.bf,now,this.universe,{minGapMs:this.opts.minGapMs});
      if(job&&this.loaded.has(job.key)){
        const url=pageUrl(job.venue,job.sym,job.iv,job.endSec,job.limit);
        try{if(!url)throw new Error("symbol");
          const body=await input.fetch(url),bars=parsePage(job.venue,job.iv,body,Math.floor(now/1000));
          const s=this.series.get(job.key)!,added=s.merge(bars),finished=onPage(this.bf,job,bars,now);
          if(added&&!await this.mergeWrite(db,s,bars.map(b=>b.t),now)){const u=this.unsaved.get(job.key)??new Set();for(const b of bars)u.add(chunkStart(s.iv,b.t));this.unsaved.set(job.key,u);}
          if(finished){this.log(now,"BACKFILL",`${job.sym.replace("_USDT","")} ${job.iv} 历史下载完：${s.n} 根，从 ${s.first?new Date(s.first*1000).toISOString().slice(0,10):"-"}（${job.venue}）`);this.dirty.add(job.key);}
          else if(job.kind==="tail"&&added&&this.bf.series[job.key]?.done)this.dirty.add(job.key);
          if(added&&job.sym==="BTC_USDT"&&job.iv==="1d")for(const sym of this.universe)if(this.bf.series[seriesKey(sym,"1d")]?.done)this.dirty.add(seriesKey(sym,"1d"));
          if(s.n>MEM_KEEP[s.iv]&&this.bf.series[job.key]?.done)s.trim(MEM_KEEP[s.iv]);
        }catch(error){onFailure(this.bf,job,error,now);
          const p=this.bf.series[job.key];if(p&&p.fails%3===0)this.log(now,"ERROR",`${job.sym} ${job.iv} ${job.venue} 下载失败 ${p.fails} 次：${safe(error)}`);}
      }
      // 4) replay up to 2 dirty series
      let replays=0;for(const k of [...this.dirty]){if(replays>=2)break;this.dirty.delete(k);const s=this.series.get(k);if(!s)continue;this.replay(s,now);replays++;}
      await this.flushTrades(db,now);
      // 5) analysis (hourly, or soon after new trades)
      if(now-this.lastAnalyzeAt>=(this.opts.analyzeEveryMs??3_600_000)||(replays&&now-this.lastAnalyzeAt>=10*60_000&&this.dirty.size===0))this.analyze(now);
      // 6) small meta
      if(now-this.lastMetaAt>=(this.opts.metaEveryMs??120_000)){this.lastMetaAt=now;
        // watermarks only once every trade below them is stored (a restart then replays and re-finds the unstored ones)
        await writeMeta(db,this.store,{backfill:this.bf,events:this.events.slice(-120),...(this.pendingTrades.length?{}:{watermarks:this.wm})},now);}
      this.lastError=null;
    }catch(error){this.lastError=safe(error);this.store.failures++;this.store.error=this.lastError;}
    finally{this.lastStepAt=now;this.lastStepMs=Date.now()-t0;}
  }
  /** at most TRADES_PER_STEP rows a step (subrequests per invocation stay small); over the daily row budget they wait in memory */
  private async flushTrades(db:D1Like,now:number){
    if(!this.pendingTrades.length)return;const part=this.pendingTrades.slice(0,TRADES_PER_STEP);
    if(await writeTrades(db,this.store,part,now))this.pendingTrades=this.pendingTrades.slice(part.length);
  }
  private async boot(db:D1Like,now:number){
    try{await ensureDynSchema(db,this.store);
      this.bf=normalizeBackfill(await readMeta(db,this.store,"backfill"));
      const ev=await readMeta<DynEvent[]>(db,this.store,"events");if(Array.isArray(ev))this.events=ev.slice(-120);
      const wm=await readMeta<Record<string,[number,number|null]>>(db,this.store,"watermarks");if(wm&&typeof wm==="object")this.wm=wm;
      const rows=await db.prepare(`SELECT id,pb,sym,et,xt,net FROM dyn_trades`).all<{id:string;pb:string;sym:string;et:number;xt:number;net:number}>();
      for(const r of rows.results)this.trades.set(r.id,{pb:r.pb,sym:r.sym,et:r.et,xt:r.xt,net:r.net});
      this.booted=true;this.bootError=null;this.log(now,"BOOT",`研究层启动：已存影子交易 ${this.trades.size} 笔，历史下载进度 ${Object.values(this.bf.series).filter(s=>s.done).length} 条序列完成`);
    }catch(error){this.bootError=safe(error);}
  }
  /** rewrite touched chunks, merging what D1 already holds for them (memory may be trimmed). */
  private async mergeWrite(db:D1Like,s:Series,times:number[],now:number){
    const starts=[...new Set(times.map(t=>chunkStart(s.iv,t)))];
    const tmp=new Series(s.sym,s.iv);
    for(const t0 of starts){
      if(s.first!=null&&s.first<=t0)continue;// memory holds the whole chunk
      const r=await db.prepare(`SELECT json FROM dyn_bars WHERE sym=? AND iv=? AND t0=?`).bind(s.sym,s.iv,t0).first<{json:string}>();
      if(r)try{tmp.merge((JSON.parse(r.json) as number[][]).map(x=>({t:x[0]!,o:x[1]!,h:x[2]!,l:x[3]!,c:x[4]!,v:x[5]!})));}catch{/* 坏块覆盖 */}
    }
    let src=s;if(tmp.n){tmp.merge(s.rows().filter(b=>starts.includes(chunkStart(s.iv,b.t))));src=tmp;}
    return await writeChunks(db,this.store,src,times,now);
  }
  private replay(s:Series,now:number){
    const btc=this.get("BTC_USDT","1d"),ctx=btcRegime(btc);this.replays++;
    for(const pb of POOL){if(pb.iv!==s.iv)continue;
      const r=simulate(pb,s,ctx),key=`${pb.id}|${s.sym}`,w=this.wm[key],last=s.last;if(last==null)continue;
      const fresh=(et:number)=>!w||et>w[0]||et===w[1];
      const open=r.open&&fresh(r.open.et)?r.open:null;
      if(open)this.opens.set(key,open);else this.opens.delete(key);
      for(const t of r.trades){if(this.trades.has(t.id)||!fresh(t.et))continue;this.trades.set(t.id,{pb:t.pb,sym:t.sym,et:t.et,xt:t.xt,net:t.net});
        this.pendingTrades.push(roundTrade(t));}
      this.wm[key]=[last+IV_SEC[s.iv],open?.et??null];
    }
    void now;
  }
  analyze(now:number){
    this.lastAnalyzeAt=now;this.analyses++;const nowSec=now/1000;
    const btc=this.get("BTC_USDT","1d"),eth=this.get("ETH_USDT","1d");
    const alts=this.universe.filter(s=>s!=="BTC_USDT"&&s!=="ETH_USDT").map(s=>this.get(s,"1d")).filter((x):x is Series=>!!x&&x.n>=60);
    const prevBucket=this.states.at(-1)?.bucket??this.lastBucket;
    this.states=btc&&this.bf.series[seriesKey("BTC_USDT","1d")]?.done?dailyStates(btc,eth,alts):[];
    const cur=this.states.at(-1)??null;
    if(cur&&cur.bucket!==prevBucket){const ch=stateChanges(this.states).at(-1);
      this.log(now,"STATE",`BTC/ETH 状态：${prevBucket?bucketLabel(prevBucket):"-"} → ${bucketLabel(cur.bucket)}；${ch?.why??""}`);}
    this.lastBucket=cur?.bucket??null;
    const by=new Map<string,TradeLite[]>();for(const t of this.trades.values())(by.get(t.pb)??by.set(t.pb,[]).get(t.pb)!).push(t);
    const next:Record<string,PlaybookCycle>={};for(const pb of POOL)next[pb.id]=analyzePlaybook(pb.id,by.get(pb.id)??[],this.states,nowSec);
    for(const c of phaseChanges(Object.keys(this.cycles).length?this.cycles:null,next)){if(!this.cycles[c.pb]&&c.to==null&&!c.pattern)continue;
      this.log(now,"PHASE",`${POOL_BY_ID[c.pb]?.label??c.pb}：${c.from??"-"} → ${c.to??"-"}${c.pattern?"（规律已确认）":""}`);}
    this.cycles=next;
    const prev=this.gates;this.gates=allocate(next,cur);
    for(const [pb,g] of Object.entries(this.gates))if(!prev||prev[pb]?.ok!==g.ok)this.log(now,"ALLOC",`${POOL_BY_ID[pb]?.label??pb}：${g.ok?"允许开单":"只记录"} — ${g.why}`);
  }
  /** synchronous plan input for the living engine */
  planInput(now:number,positions:readonly DynPosition[]):DynPlanInput{
    const ready=this.booted&&this.gates!=null&&this.states.length>0;
    const signals:DynSignal[]=[];
    for(const o of this.opens.values()){if(!o.fresh||o.pb==="htf-donch20")continue;const pb=POOL_BY_ID[o.pb];if(!pb)continue;
      const until=o.et*1000+FRESH_MS[o.iv];if(now>until)continue;
      signals.push({id:`ld-${o.pb}-${o.sym}-${o.et}`,pb:o.pb,label:pb.label,sym:o.sym,side:o.side,iv:o.iv,et:o.et,ep:o.ep,stop:o.stop0,target:o.target,maxBars:o.maxBars,why:`${pb.label}：${o.why}`,until});}
    const exits:DynExit[]=[];
    for(const p of positions){const pb=POOL_BY_ID[p.pb];if(!pb)continue;const s=this.get(p.symbol,pb.iv);if(!s)continue;
      const cur=p.guard!=null?(p.side==="LONG"?Math.max(p.stopPrice,p.guard):Math.min(p.stopPrice,p.guard)):p.stopPrice;
      const ck=`${s.last}|${s.n}|${cur}`,hit=this.manageCache.get(p.id);
      const m=hit&&hit.key===ck?hit.m:manageLive(pb,s,{openedAtMs:p.openedAt,entry:p.entryPrice,stop0:p.inv,stop:cur,target:p.target,maxBars:p.maxBars});
      this.manageCache.set(p.id,{key:ck,m});if(!m)continue;
      if(m.exit)exits.push({tradeId:p.id,act:"EXIT",why:`${pb.label}：${m.exit.why}（${s.iv} 收盘规则）`,code:"LIVING_DYN_EXIT"});
      else if(p.side==="LONG"?m.stop>cur*(1+1e-9):m.stop<cur*(1-1e-9))exits.push({tradeId:p.id,act:"GUARD",stop:m.stop,why:`${pb.label}：跟踪止损 ${fmt(cur)} → ${fmt(m.stop)}`,code:"LIVING_DYN_TRAIL"});
    }
    for(const id of [...this.manageCache.keys()])if(!positions.some(p=>p.id===id))this.manageCache.delete(id);
    const g=this.gates;
    return {ready,gates:g?Object.fromEntries(Object.entries(g).map(([k,v])=>[k,{ok:v.ok,risk:v.risk,conf:v.conf,why:v.why}])):null,signals,exits,state:this.states.at(-1)?.bucket??null};
  }
  view(now:number){
    const cur=this.states.at(-1)??null,bv=backfillView(this.bf,this.universe,now,this.opts.minGapMs??BACKFILL.minGapMs);
    const counts:Record<string,number>={};for(const t of this.trades.values())counts[t.pb]=(counts[t.pb]??0)+1;
    return {version:DYN_VERSION,booted:this.booted,bootError:this.bootError,lastError:this.lastError,lastStepAt:this.lastStepAt||null,lastStepMs:this.lastStepMs,
      lastAnalyzeAt:this.lastAnalyzeAt||null,store:{...this.store},backfill:bv,shadowTrades:this.trades.size,
      state:cur?{day:new Date(cur.t*1000).toISOString().slice(0,10),bucket:cur.bucket,label:bucketLabel(cur.bucket),trend:cur.trend,strength:r4(cur.strength),
        atrPct:r4(cur.atrPct),volPct:r4(cur.volPct),dd90:r4(cur.dd90),eff20:r4(cur.eff20),eth:cur.eth,altVsBtc:cur.altVsBtc==null?null:r4(cur.altVsBtc),lead:cur.lead,corr30:cur.corr30==null?null:r4(cur.corr30)}:null,
      stateHistory:stateChanges(this.states).slice(-12).map(c=>({day:new Date(c.t*1000).toISOString().slice(0,10),to:bucketLabel(c.to),why:c.why})),
      playbooks:POOL.map(pb=>{const c=this.cycles[pb.id],g=this.gates?.[pb.id];return {id:pb.id,label:pb.label,iv:pb.iv,side:pb.side,rule:pb.rule,trades:counts[pb.id]??0,
        all:c?.all??null,rolling:c?.rolling??null,good:c?.good??0,bad:c?.bad??0,meanGoodWeeks:c?r1(c.meanGoodWeeks):0,meanBadWeeks:c?r1(c.meanBadWeeks):0,
        persistence:c?.persistence??null,current:c?.current??null,pattern:c?.pattern??false,patternWhy:c?.patternWhy??"还没分析",
        byBucket:c?.byBucket??{},gate:g?{ok:g.ok,risk:g.risk,conf:g.conf,why:g.why}:null,
        open:[...this.opens.values()].filter(o=>o.pb===pb.id).length};}),
      allowed:this.gates?Object.values(this.gates).filter(g=>g.ok).map(g=>({pb:g.pb,label:POOL_BY_ID[g.pb]?.label??g.pb,risk:g.risk,why:g.why})):[],
      limits:{maxPoolOpen:ALLOC.maxPoolOpen,maxPerPlaybook:ALLOC.maxPerPlaybook,baseRisk:ALLOC.baseRisk},
      events:this.events.slice(-40).reverse()};
  }
}
const r4=(x:number)=>Math.round(x*1e4)/1e4,r1=(x:number)=>Math.round(x*10)/10;
const fmt=(x:number)=>x>=100?x.toFixed(2):x>=1?x.toFixed(4):x.toPrecision(4);
function roundTrade(t:ShadowTrade):StoredTrade{const p=(x:number)=>Number(x.toPrecision(8));
  return {...t,ep:p(t.ep),xp:p(t.xp),stop0:p(t.stop0),net:r6(t.net),r:r4(t.r)};}
const r6=(x:number)=>Math.round(x*1e6)/1e6;
/** fetch for the worker: JSON, 8 s timeout, non-2xx → HttpStatusError (429 triggers the global pause) */
export async function venueFetch(url:string):Promise<unknown>{
  const res=await fetch(url,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(8_000)});
  if(!res.ok){await res.body?.cancel().catch(()=>undefined);throw new HttpStatusError(res.status);}
  return await res.json();
}
export {IV_SEC,CHUNK_SEC};
