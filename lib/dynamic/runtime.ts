/**
 * dynamic-v1 runtime: owns the research layer's history, shadow trades, state, cycles and allocator gates. The worker calls
 * step() off the trading clock (never awaited by a tick, one at a time, everything in try/catch); plan inputs and the dashboard
 * view are synchronous reads of memory. Requests: external public venues only (Bybit / OKX / KuCoin), at most one per
 * BACKFILL.minGapMs. Storage: D1 only (store-d1.ts).
 *
 * Learning starts at once with whatever exists (no waiting for the download to finish):
 *  - the worker's daily candles (already in memory, external) seed the daily series and the daily state at boot;
 *  - live: the worker's own external 5m bars (strategyCandles, no extra request) are appended, 15m / 1h are built from them;
 *    each series is evaluated only when it got a new closed bar, on its memory window, entries from `liveFrom` (= the newest bar
 *    when its first history page arrived) on;
 *  - history arrives newest first; every stored chunk with enough warm-up below it is replayed as one "unit" (one chunk, ±1
 *    chunk for warm-up and exits, BTC's matching window for cross-asset rules), newest units first, one per step, entries before
 *    `liveFrom` — so the phase tracker, the forecasts and the allocator update chunk by chunk while the download continues.
 * Daily / 4h (record-only tier): full history in memory, replayed whole when it changes.
 * Shadow trades are stored grouped (dyn_trade_chunks: one row per unit / live day / long series), loaded gradually at boot.
 * dynamic-v1.2 cycle predictor (predictor.ts) runs inside every analysis: phase line per playbook, timing / BTC-state learners,
 * P(good) at +6 / +24 / +72 h with a plain-words trigger; one forecast row per hour is logged to D1 (dyn_forecasts) and scored
 * once its horizon passed; the per-playbook track record feeds the predictor gate of the allocator (allocatePred).
 */
import type {D1Like} from "../run-log-archive.ts";
import {Series,IV_SEC,aggregate,isShortIv,Memo,type Iv,type Bar} from "./series.ts";
import {pageUrl,parsePage,HttpStatusError} from "./venues.ts";
import {BACKFILL,initialBackfill,normalizeBackfill,nextJob,onPage,onFailure,backfillView,trackedSymbols,trackedSeries,seriesKey,noteFeed,depthOf,type BackfillState} from "./backfill.ts";
import {emptyDynStore,writeChunks,readSeries,readMeta,writeMeta,ensureDynSchema,chunkStart,chunkStarts,pruneBars,writeTradeChunks,readTradeChunks,
  writeForecasts,readForecasts,pruneForecasts,
  CHUNK_SEC,type DynStoreStatus,type TradeRow} from "./store-d1.ts";
import {POOL,POOL_BY_ID,simulate,manageLive,btcRegime,tierOf,applies,type OpenShadow,type ShadowTrade,type Playbook,type Ctx} from "./playbooks.ts";
import {dailyStates,stateChanges,bucketLabel,intradayStates,sessionOf,SESSION_LABEL,TREND_LABEL,VOL_LABEL,type DayState,type IntraState} from "./state.ts";
import {analyzePlaybook,phaseChanges,type PlaybookCycle,type TradeLite} from "./cycles.ts";
import {allocate,allocatePred,contradicted,ALLOC,PRED_ALLOC,type Gate,type LiveCheck} from "./allocator.ts";
import {btcFeatures,phaseInfo,hazardCounts,addHazard,predictPlaybook,scoreRows,forecastLine,trackView,emptyTrack,PRED,
  type PbForecast,type Track,type FcRow,type Lab,type Hazard} from "./predictor.ts";
export const DYN_VERSION="dynamic-v1.2";
/** forecast rows kept in memory (scoring needs t + 72 h + the 3-day "never known" expiry) and in D1 */
export const FC_KEEP_SEC=7*86_400,FC_DB_KEEP_SEC=30*86_400;
/** live entries must reach the engine within this long after the signal bar closed */
export const FRESH_MS:Record<Iv,number>={"1d":240*60_000,"4h":60*60_000,"1h":20*60_000,"15m":10*60_000,"5m":6*60_000,"1m":2*60_000};
/** bars kept in memory per series (BTC/ETH 1h: the whole history, for the intraday state) */
export const MEM_KEEP:Record<Iv,number>={"1d":1600,"4h":4500,"1h":700,"15m":700,"5m":700,"1m":1500};
export const MAJOR_1H_KEEP=4500;
/** per step: series loads, live evaluations, history units, trade-row writes */
export const STEP={loads:3,live:6,units:1,tradeRows:20,tradeLoad:300,liveFlushMs:30*60_000,pruneEveryMs:24*3_600_000} as const;
export type DynSignal={id:string;pb:string;label:string;sym:string;side:"LONG"|"SHORT";iv:Iv;et:number;ep:number;stop:number;target:number|null;maxBars:number|null;why:string;until:number};
export type DynExit={tradeId:string;act:"GUARD"|"EXIT";stop?:number;why:string;code:string};
export type DynPlanInput={ready:boolean;gates:Record<string,Pick<Gate,"ok"|"risk"|"conf"|"why">>|null;signals:DynSignal[];exits:DynExit[];state:string|null};
export type DynEvent={at:number;k:"BACKFILL"|"STATE"|"PHASE"|"ALLOC"|"ERROR"|"BOOT"|"FORECAST"|"SCORE";text:string};
export type ScoreRec={t:number;pb:string;h:number;p:number;y:0|1};
export type DynPosition={id:string;symbol:string;side:"LONG"|"SHORT";entryPrice:number;stopPrice:number;openedAt:number;guard:number|null;pb:string;inv:number;target:number|null;maxBars:number|null};
/** the worker's 5m bars (time = open, seconds) */
export type FeedBar={time:number;open:number;high:number;low:number;close:number;volume:number};
type Fetch=(url:string)=>Promise<unknown>;
type TSrc={k:string;sym:string;iv:Iv;t0:number;pbs:string[];rows:TradeRow[];dirty:boolean};
const safe=(e:unknown)=>String((e as Error)?.message??e).slice(0,160);
const keepOf=(sym:string,iv:Iv)=>iv==="1h"&&(sym==="BTC_USDT"||sym==="ETH_USDT")?MAJOR_1H_KEEP:MEM_KEEP[iv];
const PB_BY_IV=new Map<Iv,Playbook[]>();for(const pb of POOL)(PB_BY_IV.get(pb.iv)??PB_BY_IV.set(pb.iv,[]).get(pb.iv)!).push(pb);
const needsBtc=(iv:Iv)=>(PB_BY_IV.get(iv)??[]).some(p=>p.only==="alts");
export class DynamicResearch{
  series=new Map<string,Series>();loaded=new Set<string>();bf:BackfillState=initialBackfill();store:DynStoreStatus=emptyDynStore();
  /** trade sources: u|sym|iv|t0 (history unit), l|sym|iv|day (live), f|sym|iv (daily / 4h whole series) */
  tsrc=new Map<string,TSrc>();tradesLoaded=false;tradeCursor="";tradeCount=0;
  opens=new Map<string,OpenShadow>();dirty=new Set<string>();liveNew=new Set<string>();unsaved=new Map<string,Set<number>>();
  liveBars=new Map<string,Set<number>>();lastLiveFlushAt=0;lastPruneAt=0;
  /** bar end (s) from which a series is evaluated live; history units cover entries before it */
  liveFrom:Record<string,number>={};
  unitsDone:Record<string,1>={};unitsPending=new Set<string>();unitQueue:string[]=[];unitsTotal:Record<string,number>={};
  states:DayState[]=[];intra:IntraState[]=[];cycles:Record<string,PlaybookCycle>={};gates:Record<string,Gate>|null=null;
  events:DynEvent[]=[];booted=false;bootError:string|null=null;lastStepAt=0;lastStepMs=0;lastAnalyzeAt=0;lastMetaAt=0;lastError:string|null=null;
  universe:string[]=[];replays=0;analyses=0;liveEvals=0;unitsRun=0;lastBucket:string|null=null;lastIntraBucket:string|null=null;maxStepMs=0;
  /** per playbook × symbol: end (s) of the last bar evaluated and the entry time of the trade open then — later evaluations only
   * add trades that start after it (or that one), so a window that starts elsewhere (trimmed memory, a reload) adds nothing old */
  wm:Record<string,[number,number|null]>={};
  // cycle predictor
  forecasts:Record<string,PbForecast>={};track:Record<string,Track>={};fcRows:FcRow[]=[];fcDirty=new Set<number>();
  predLive:Record<string,{since:number|null;cutUntil:number}>={};recentScores:ScoreRec[]=[];scoreAcc={n:0,hits:0,brier:0,since:0};
  lastFcLogAt=0;lastTop="";predMs=0;predAt=0;
  private manageCache=new Map<string,{key:string;m:ReturnType<typeof manageLive>}>();
  opts:{minGapMs?:number;analyzeEveryMs?:number;metaEveryMs?:number};
  constructor(opts:{minGapMs?:number;analyzeEveryMs?:number;metaEveryMs?:number}={}){this.opts=opts;}
  private log(at:number,k:DynEvent["k"],text:string){this.events.push({at,k,text:text.slice(0,300)});if(this.events.length>200)this.events.splice(0,this.events.length-200);}
  drainEvents(){return this.events.slice();}
  get(sym:string,iv:Iv){return this.series.get(seriesKey(sym,iv))??null;}
  /** one bounded piece of work. Never throws. */
  async step(now:number,input:{universe:readonly string[];db:D1Like|null;fetch:Fetch;feed?:Record<string,readonly FeedBar[]|undefined>;daily?:Record<string,readonly FeedBar[]|undefined>}):Promise<void>{
    const t0=Date.now();
    try{
      const db=input.db;if(!db){this.lastError="D1 binding missing";return;}
      this.universe=trackedSymbols(input.universe);
      if(!this.booted){await this.boot(db,now);return;}
      // 1) stored shadow trades, a few hundred rows a step
      if(!this.tradesLoaded)await this.loadTrades(db);
      // 2) stored series: short intervals only their newest chunks, daily / 4h whole
      let loads=0;for(const {sym,iv} of trackedSeries(this.universe)){const k=seriesKey(sym,iv);if(this.loaded.has(k)||loads>=STEP.loads)continue;
        const s=await readSeries(db,this.store,sym,iv,isShortIv(iv)?{lastChunks:keepOf(sym,iv)>MEM_KEEP[iv]?Math.ceil(keepOf(sym,iv)/600)+1:2}:{});
        s.trim(keepOf(sym,iv));this.series.set(k,s);this.loaded.add(k);loads++;
        if(s.n&&this.bf.series[k]?.done)(isShortIv(iv)?this.liveNew:this.dirty).add(k);}
      // 3) the worker's live 5m bars (no request) → 5m, 15m, 1h
      if(input.feed)this.ingest(input.feed,now);
      if(input.daily)this.seedDaily(input.daily,now);
      // 4) deferred writes
      for(const [k,ts] of [...this.unsaved]){const s=this.series.get(k);if(!s){this.unsaved.delete(k);continue;}
        if(await this.writeBars(db,s.sym,s.iv,[],[...ts],now))this.unsaved.delete(k);else break;}
      if(now-this.lastLiveFlushAt>=STEP.liveFlushMs)await this.flushLive(db,now);
      // 5) one request (paced)
      const job=nextJob(this.bf,now,this.universe,{minGapMs:this.opts.minGapMs});
      if(job&&this.loaded.has(job.key)){
        const url=pageUrl(job.venue,job.sym,job.iv,job.endSec,job.limit);
        try{if(!url)throw new Error("symbol");
          const body=await input.fetch(url),bars=parsePage(job.venue,job.iv,body,Math.floor(now/1000));
          const s=this.series.get(job.key)!,lastBefore=s.last,finished=onPage(this.bf,job,bars,now);
          s.merge(bars);
          if(bars.length&&!await this.writeBars(db,job.sym,job.iv,bars,[],now)){const u=this.unsaved.get(job.key)??new Set();for(const b of bars)u.add(chunkStart(s.iv,b.t));this.unsaved.set(job.key,u);}
          s.trim(keepOf(job.sym,job.iv));
          if(job.kind==="back"&&bars.length){
            if(isShortIv(job.iv)){if(this.liveFrom[job.key]==null&&s.last!=null){this.liveFrom[job.key]=s.last+IV_SEC[job.iv];this.liveNew.add(job.key);}this.unitQueue.length=0;}// re-plan units (newest first)
            else this.dirty.add(job.key);}
          if(finished){this.log(now,"BACKFILL",`${job.sym.replace("_USDT","")} ${job.iv} 历史下载完：${this.bf.series[job.key]?.bars??s.n} 根，从 ${this.bf.series[job.key]?.oldest?new Date(this.bf.series[job.key]!.oldest!*1000).toISOString().slice(0,10):"-"}（${job.venue}）`);
            if(isShortIv(job.iv)){this.liveFrom[job.key]??=(s.last??Math.floor(now/1000))+IV_SEC[job.iv];this.liveNew.add(job.key);}else this.dirty.add(job.key);}
          else if(job.kind==="tail"&&this.bf.series[job.key]?.done&&s.last!==lastBefore)(isShortIv(job.iv)?this.liveNew:this.dirty).add(job.key);
          if(bars.length&&job.sym==="BTC_USDT"&&job.iv==="1d")for(const sym of this.universe)if(this.bf.series[seriesKey(sym,"1d")]?.done)this.dirty.add(seriesKey(sym,"1d"));
        }catch(error){onFailure(this.bf,job,error,now);
          const p=this.bf.series[job.key];if(p&&p.fails%3===0)this.log(now,"ERROR",`${job.sym} ${job.iv} ${job.venue} 下载失败 ${p.fails} 次：${safe(error)}`);}
      }
      // 6) live evaluation of series that got a new closed bar
      let lives=0;for(const k of [...this.liveNew]){if(lives>=STEP.live)break;this.liveNew.delete(k);const s=this.series.get(k);if(!s||this.liveFrom[k]==null)continue;this.evalLive(s);lives++;}
      // 7) history units (one chunk each) once a series is complete
      this.planUnits();let units=0;
      for(;units<STEP.units&&this.unitQueue.length;units++)await this.runUnit(db,this.unitQueue.shift()!,now);
      // 8) daily / 4h whole-series replays
      let replays=0;for(const k of [...this.dirty]){if(replays>=2)break;this.dirty.delete(k);const s=this.series.get(k);if(!s)continue;this.replayLong(s);replays++;}
      await this.flushTrades(db,now);
      // 9) analysis (hourly, or soon after new trades)
      if(this.tradesLoaded&&(now-this.lastAnalyzeAt>=(this.opts.analyzeEveryMs??3_600_000)||((replays||lives||units)&&now-this.lastAnalyzeAt>=10*60_000)))this.analyze(now);
      if(this.fcDirty.size)await this.flushForecasts(db,now);
      // 10) prune short history beyond its depth (+20 %), once a day
      if(now-this.lastPruneAt>=STEP.pruneEveryMs){this.lastPruneAt=now;
        for(const iv of ["5m","15m","1h","1m"] as Iv[]){const d=Math.max(depthOf("BTC_USDT",iv),depthOf("SOL_USDT",iv));await pruneBars(db,this.store,iv,Math.floor(now/1000-d*1.2*86_400),now);}
        await pruneForecasts(db,this.store,Math.floor(now/1000)-FC_DB_KEEP_SEC);}
      // 11) small meta
      if(now-this.lastMetaAt>=(this.opts.metaEveryMs??120_000)){this.lastMetaAt=now;await this.saveMeta(db,now);}
      this.lastError=null;
    }catch(error){this.lastError=safe(error);this.store.failures++;this.store.error=this.lastError;}
    finally{this.lastStepAt=now;this.lastStepMs=Date.now()-t0;this.maxStepMs=Math.max(this.maxStepMs,this.lastStepMs);}
  }
  private async saveMeta(db:D1Like,now:number){
    const dirtyLive=[...this.tsrc.values()].some(s=>s.dirty);
    const units:Record<string,1>={};for(const k of Object.keys(this.unitsDone))if(!this.unitsPending.has(k))units[k]=1;
    // watermarks only once every trade below them is stored (a restart then re-evaluates and re-finds the unstored ones)
    const all:Record<string,unknown>={backfill:this.bf,events:this.events.slice(-120),liveFrom:this.liveFrom,units,
      track:this.track,predLive:this.predLive,fcRecent:this.recentScores.slice(-40),...(dirtyLive?{}:{watermarks:this.wm})};
    // only values that changed since the last write (rows and bytes stay small)
    const out:Record<string,unknown>={},js:Record<string,string>={};for(const [k,v] of Object.entries(all)){const j=JSON.stringify(v);if(this.metaSent[k]!==j){out[k]=v;js[k]=j;}}
    if(Object.keys(out).length&&await writeMeta(db,this.store,out,now))Object.assign(this.metaSent,js);
  }
  private metaSent:Record<string,string>={};
  private async boot(db:D1Like,now:number){
    try{await ensureDynSchema(db,this.store);
      this.bf=normalizeBackfill(await readMeta(db,this.store,"backfill"));
      const ev=await readMeta<DynEvent[]>(db,this.store,"events");if(Array.isArray(ev))this.events=ev.slice(-120);
      const wm=await readMeta<Record<string,[number,number|null]>>(db,this.store,"watermarks");if(wm&&typeof wm==="object")this.wm=wm;
      const lf=await readMeta<Record<string,number>>(db,this.store,"liveFrom");if(lf&&typeof lf==="object")this.liveFrom=lf;
      const un=await readMeta<Record<string,1>>(db,this.store,"units");if(un&&typeof un==="object")this.unitsDone=un;
      const tr=await readMeta<Record<string,Track>>(db,this.store,"track");if(tr&&typeof tr==="object")this.track=tr;
      const pl=await readMeta<Record<string,{since:number|null;cutUntil:number}>>(db,this.store,"predLive");if(pl&&typeof pl==="object")this.predLive=pl;
      const rs=await readMeta<ScoreRec[]>(db,this.store,"fcRecent");if(Array.isArray(rs))this.recentScores=rs.slice(-40);
      this.fcRows=(await readForecasts(db,this.store,Math.floor(now/1000)-FC_KEEP_SEC,400)).map(r=>({t:r.t,f:r.f,y:r.y}));
      // a series with history but no liveFrom (older state): live from its newest stored bar
      for(const [k,p] of Object.entries(this.bf.series))if(p.pages>0&&isShortIv(p.iv)&&this.liveFrom[k]==null&&p.newest!=null)this.liveFrom[k]=p.newest+IV_SEC[p.iv];
      this.booted=true;this.bootError=null;
      this.log(now,"BOOT",`研究层启动（${DYN_VERSION}）：${POOL.length} 套打法，历史下载进度 ${Object.values(this.bf.series).filter(s=>s.done).length} 条序列完成，已回放历史块 ${Object.keys(this.unitsDone).length} 个；影子交易分批读取中`);
    }catch(error){this.bootError=safe(error);}
  }
  private async loadTrades(db:D1Like){
    const rows=await readTradeChunks(db,this.store,this.tradeCursor,STEP.tradeLoad);
    for(const r of rows){this.tradeCursor=r.k;const cur=this.tsrc.get(r.k);
      if(cur){this.mergeRows(cur,r.pbs,r.trades);continue;}// a live day already touched in memory: union
      this.tsrc.set(r.k,{k:r.k,sym:r.sym,iv:r.iv,t0:r.t0,pbs:r.pbs,rows:r.trades,dirty:false});}
    if(rows.length<STEP.tradeLoad){this.tradesLoaded=true;this.recount();}
  }
  private recount(){let n=0;for(const s of this.tsrc.values())n+=s.rows.length;this.tradeCount=n;}
  private mergeRows(dst:TSrc,pbs:readonly string[],rows:readonly TradeRow[]){
    const have=new Set(dst.rows.map(r=>`${dst.pbs[r[0]]}|${r[1]}`));
    for(const r of rows){const pb=pbs[r[0]];if(pb==null||have.has(`${pb}|${r[1]}`))continue;let i=dst.pbs.indexOf(pb);if(i<0){i=dst.pbs.length;dst.pbs.push(pb);}
      dst.rows.push([i,r[1],r[2],r[3],r[4],r[5]]);have.add(`${pb}|${r[1]}`);dst.dirty=true;}
  }
  /** trades of one source: replace (history unit, long series) or add (live day) */
  private putTrades(k:string,sym:string,iv:Iv,t0:number,trades:readonly ShadowTrade[],replace:boolean){
    const pbs:string[]=[],rows:TradeRow[]=[];
    for(const t of trades){let i=pbs.indexOf(t.pb);if(i<0){i=pbs.length;pbs.push(t.pb);}rows.push([i,t.et,t.xt,Math.round(t.net*1e6),p8(t.ep),p8(t.xp)]);}
    const cur=this.tsrc.get(k);
    if(replace||!cur){const same=cur&&JSON.stringify(cur.rows)===JSON.stringify(rows)&&JSON.stringify(cur.pbs)===JSON.stringify(pbs);
      if(!same&&(rows.length||cur))this.tsrc.set(k,{k,sym,iv,t0,pbs,rows,dirty:true});}
    else this.mergeRows(cur,pbs,rows);
  }
  private async flushForecasts(db:D1Like,now:number){
    const rows=this.fcRows.filter(r=>this.fcDirty.has(r.t)).slice(0,20);if(!rows.length){this.fcDirty.clear();return;}
    if(await writeForecasts(db,this.store,rows,now))for(const r of rows)this.fcDirty.delete(r.t);
  }
  private async flushTrades(db:D1Like,now:number){
    const ds=[...this.tsrc.values()].filter(s=>s.dirty).slice(0,STEP.tradeRows);if(!ds.length)return;
    if(await writeTradeChunks(db,this.store,ds.map(s=>({k:s.k,sym:s.sym,iv:s.iv,t0:s.t0,pbs:s.pbs,trades:s.rows})),now)){
      for(const s of ds){s.dirty=false;if(s.k.startsWith("u|"))this.unitsPending.delete(s.k.slice(2));}this.recount();}
  }
  /** rewrite the chunks touched by `bars` (and/or the given chunk starts), merging what D1 already holds (memory is trimmed) */
  private async writeBars(db:D1Like,sym:string,iv:Iv,bars:readonly Bar[],starts0:readonly number[],now:number){
    const starts=[...new Set([...bars.map(b=>chunkStart(iv,b.t)),...starts0])];if(!starts.length)return true;
    const tmp=new Series(sym,iv),mem=this.get(sym,iv);
    for(const t0 of starts){
      const r=await db.prepare(`SELECT json FROM dyn_bars WHERE sym=? AND iv=? AND t0=?`).bind(sym,iv,t0).first<{json:string}>();
      if(r)try{tmp.merge((JSON.parse(r.json) as number[][]).map(x=>({t:x[0]!,o:x[1]!,h:x[2]!,l:x[3]!,c:x[4]!,v:x[5]!})));}catch{/* 坏块覆盖 */}}
    if(mem)tmp.merge(mem.rows().filter(b=>starts.includes(chunkStart(iv,b.t))));
    tmp.merge(bars as Bar[]);
    return await writeChunks(db,this.store,tmp,starts,now);
  }
  private async flushLive(db:D1Like,now:number){
    this.lastLiveFlushAt=now;
    for(const [k,ts] of [...this.liveBars]){const s=this.series.get(k);if(!s){this.liveBars.delete(k);continue;}
      if(!await this.writeBars(db,s.sym,s.iv,[],[...ts],now))break;this.liveBars.delete(k);}
  }
  /** append the worker's closed external 5m bars; build 15m / 1h from 5m; only series whose download has started */
  ingest(feed:Record<string,readonly FeedBar[]|undefined>,now:number){
    const nowSec=Math.floor(now/1000);
    for(const sym of this.universe){const rows=feed[sym];if(!rows?.length)continue;
      const k5=seriesKey(sym,"5m"),s5=this.series.get(k5);if(!s5||!this.loaded.has(k5))continue;
      const bars:Bar[]=[];for(const r of rows)if(r.time+300<=nowSec)bars.push({t:r.time,o:r.open,h:r.high,l:r.low,c:r.close,v:r.volume});
      const last=s5.last??-Infinity,fresh=bars.filter(b=>b.t>last);if(!fresh.length)continue;
      // only continue a series that is gap-free with the feed (else the request tail fills the gap first)
      if(s5.n&&fresh[0]!.t>last+300&&!bars.some(b=>b.t===last))continue;
      if(!s5.append(fresh))continue;this.noteLive(k5,s5,fresh);
      for(const iv of ["15m","1h"] as Iv[]){const k=seriesKey(sym,iv),s=this.series.get(k);if(!s||!this.loaded.has(k))continue;
        const from=(s.last??-Infinity)+IV_SEC[iv],agg=aggregate(s5,iv,from).filter(b=>b.t+IV_SEC[iv]<=nowSec);
        if(agg.length&&(s.last==null||agg[0]!.t===s.last+IV_SEC[iv])&&s.append(agg))this.noteLive(k,s,agg);}
    }
  }
  private noteLive(k:string,s:Series,bars:readonly Bar[]){
    noteFeed(this.bf,s.sym,s.iv,bars[0]!.t,bars.at(-1)!.t);
    const u=this.liveBars.get(k)??new Set();for(const b of bars)u.add(chunkStart(s.iv,b.t));this.liveBars.set(k,u);
    s.trim(keepOf(s.sym,s.iv));if(this.liveFrom[k]!=null)this.liveNew.add(k);
  }
  private ctxFor(s:Series,btc:Series|null):Ctx{
    const b1d=this.get("BTC_USDT","1d");return {...btcRegime(b1d),btc:s.sym==="BTC_USDT"?s:btc,memo:new Memo()};
  }
  /** live: evaluate one series' playbooks on its memory window; trades from liveFrom on, deduplicated by watermark */
  evalLive(s:Series){
    const k=seriesKey(s.sym,s.iv),from=this.liveFrom[k]??Infinity,last=s.last;if(last==null)return;this.liveEvals++;
    const ctx=this.ctxFor(s,needsBtc(s.iv)?this.get("BTC_USDT",s.iv):null),byDay=new Map<number,ShadowTrade[]>();
    for(const pb of PB_BY_IV.get(s.iv)??[]){if(!applies(pb,s.sym))continue;
      const r=simulate(pb,s,ctx,{fromT:from}),wk=`${pb.id}|${s.sym}`,w=this.wm[wk];
      const fresh=(et:number)=>!w||et>w[0]||et===w[1];
      const open=r.open&&fresh(r.open.et)?r.open:null;if(open)this.opens.set(wk,open);else this.opens.delete(wk);
      for(const t of r.trades){if(!fresh(t.et))continue;const d=Math.floor(t.et/86_400)*86_400;(byDay.get(d)??byDay.set(d,[]).get(d)!).push(t);}
      this.wm[wk]=[last+IV_SEC[s.iv],open?.et??null];}
    for(const [d,ts] of byDay)this.putTrades(`l|${s.sym}|${s.iv}|${d}`,s.sym,s.iv,d,ts,false);
  }
  /** queue every stored chunk that is ready (warm-up below it downloaded, or the series complete) and not replayed yet, newest
   * first across all series; BTC's same window must be there first for the cross-asset rules. Pure memory, no query. */
  planUnits(){
    if(this.unitQueue.length)return;const out:{u:string;t0:number}[]=[];this.unitsTotal={};
    const ready=(k:string,t0:number,span:number)=>{const p=this.bf.series[k];if(!p||p.oldest==null)return false;return p.done?t0+span>p.oldest:p.oldest<=t0-span/4;};
    for(const {sym,iv} of trackedSeries(this.universe)){if(!isShortIv(iv)||!PB_BY_IV.get(iv)?.length)continue;const k=seriesKey(sym,iv),lf=this.liveFrom[k],p=this.bf.series[k];
      if(lf==null||!p||p.oldest==null||this.unsaved.has(k))continue;const span=CHUNK_SEC[iv];let n=0;
      for(let t0=chunkStart(iv,lf-1);t0+span>p.oldest;t0-=span){n++;const u=`${sym}|${iv}|${t0}`;if(this.unitsDone[u]||!ready(k,t0,span))continue;
        if(needsBtc(iv)&&sym!=="BTC_USDT"&&!ready(seriesKey("BTC_USDT",iv),t0,span)&&!this.bf.series[seriesKey("BTC_USDT",iv)]?.done)continue;
        out.push({u,t0});}
      this.unitsTotal[k]=n;}
    out.sort((a,b)=>b.t0-a.t0);this.unitQueue=out.map(x=>x.u);
  }
  /** the worker's daily candles (external, already in memory): merged into the daily series so the daily state and the daily /
   * 4h tier start at boot; the download later replaces them with its own rows */
  seedDaily(daily:Record<string,readonly FeedBar[]|undefined>,now:number){
    const nowSec=Math.floor(now/1000);
    for(const sym of this.universe){const rows=daily[sym];const k=seriesKey(sym,"1d"),s=this.series.get(k);if(!rows?.length||!s||!this.loaded.has(k))continue;
      const fresh=rows.filter(r=>r.time+86_400<=nowSec&&(s.first==null||r.time<s.first||r.time>s.last!));if(!fresh.length)continue;
      const added=s.merge(fresh.map(r=>({t:r.time,o:r.open,h:r.high,l:r.low,c:r.close,v:Number.isFinite(r.volume)?r.volume:0})));if(added)this.dirty.add(k);}
  }
  /** one history unit: chunk t0 of one series, with the chunk before (warm-up) and after (exits of trades still open) */
  private async runUnit(db:D1Like,u:string,now:number){
    const [sym,ivs,t0s]=u.split("|") as [string,Iv,string];const iv=ivs as Iv,t0=Number(t0s),span=CHUNK_SEC[iv],lf=this.liveFrom[seriesKey(sym,iv)]??Infinity;
    const range={from:t0-span,to:t0+2*span};
    const s=await readSeries(db,this.store,sym,iv,range),btc=needsBtc(iv)&&sym!=="BTC_USDT"?await readSeries(db,this.store,"BTC_USDT",iv,range):null;
    // bars not flushed to D1 yet (the newest unit's exits)
    const inRange=(x:Series|null)=>x?x.rows().filter(b=>b.t>=range.from&&b.t<range.to):[];
    s.merge(inRange(this.get(sym,iv)));if(btc)btc.merge(inRange(this.get("BTC_USDT",iv)));
    const ctx=this.ctxFor(s,btc),out:ShadowTrade[]=[];
    for(const pb of PB_BY_IV.get(iv)??[]){if(!applies(pb,sym))continue;out.push(...simulate(pb,s,ctx,{fromT:t0,toT:Math.min(t0+span,lf)}).trades);}
    this.putTrades(`u|${u}`,sym,iv,t0,out,true);this.unitsDone[u]=1;if(this.tsrc.get(`u|${u}`)?.dirty)this.unitsPending.add(u);this.unitsRun++;void now;
  }
  /** daily / 4h: the whole series is in memory — replay it whole (trades replace the series' row) */
  private replayLong(s:Series){
    const ctx=this.ctxFor(s,null),out:ShadowTrade[]=[];this.replays++;
    for(const pb of PB_BY_IV.get(s.iv)??[]){const r=simulate(pb,s,ctx),key=`${pb.id}|${s.sym}`;out.push(...r.trades);
      if(r.open)this.opens.set(key,r.open);else this.opens.delete(key);}
    this.putTrades(`f|${s.sym}|${s.iv}`,s.sym,s.iv,0,out,true);
  }
  /** every stored shadow trade, light (for the analysis) */
  tradesLite():TradeLite[]{const out:TradeLite[]=[];
    for(const s of this.tsrc.values())for(const r of s.rows){const pb=s.pbs[r[0]];if(pb)out.push({pb,sym:s.sym,et:r[1],xt:r[2],net:r[3]/1e6});}
    return out;}
  analyze(now:number){
    this.lastAnalyzeAt=now;this.analyses++;const nowSec=now/1000;
    const btc=this.get("BTC_USDT","1d"),eth=this.get("ETH_USDT","1d");
    const alts=this.universe.filter(s=>s!=="BTC_USDT"&&s!=="ETH_USDT").map(s=>this.get(s,"1d")).filter((x):x is Series=>!!x&&x.n>=60);
    const prevBucket=this.states.at(-1)?.bucket??this.lastBucket;
    this.states=btc&&btc.n>=120?dailyStates(btc,eth,alts):[];
    const cur=this.states.at(-1)??null;
    if(cur&&cur.bucket!==prevBucket){const ch=stateChanges(this.states).at(-1);
      this.log(now,"STATE",`BTC/ETH 日线状态：${prevBucket?bucketLabel(prevBucket):"-"} → ${bucketLabel(cur.bucket)}；${ch?.why??""}`);}
    this.lastBucket=cur?.bucket??null;
    const b1=this.get("BTC_USDT","1h");this.intra=b1&&b1.n?intradayStates(b1,this.get("ETH_USDT","1h")):[];
    const ic=this.currentIntra(now);
    if(ic&&ic.bucket!==this.lastIntraBucket)this.log(now,"STATE",`BTC/ETH 日内状态：${this.lastIntraBucket?bucketLabel(this.lastIntraBucket):"-"} → ${bucketLabel(ic.bucket)}（1 小时趋势，24 小时波动分位 ${Math.round(ic.volPct*100)}%）`);
    this.lastIntraBucket=ic?.bucket??null;
    const by=new Map<string,TradeLite[]>();for(const t of this.tradesLite())(by.get(t.pb)??by.set(t.pb,[]).get(t.pb)!).push(t);
    const next:Record<string,PlaybookCycle>={};
    for(const pb of POOL)next[pb.id]=analyzePlaybook(pb.id,by.get(pb.id)??[],this.states,nowSec,{tier:tierOf(pb),intra:this.intra});
    for(const c of phaseChanges(Object.keys(this.cycles).length?this.cycles:null,next)){if(!this.cycles[c.pb]&&c.to==null&&!c.pattern)continue;
      this.log(now,"PHASE",`${POOL_BY_ID[c.pb]?.label??c.pb}：${c.from??"-"} → ${c.to??"-"}${c.pattern?"（规律已确认）":""}`);}
    this.cycles=next;
    const live=this.predict(now,by);
    const prev=this.gates;this.gates=live?allocatePred(next,cur,ic,{forecasts:this.forecasts,track:this.track,live,nowSec:Math.floor(nowSec)}):allocate(next,cur,ic);
    // gate opened → shadow results are checked against the forecast from now on; closed → forget
    for(const [pb,g] of Object.entries(this.gates)){if(!live||!(pb in this.forecasts))continue;const pl=(this.predLive[pb]??={since:null,cutUntil:0});
      if(g.ok&&pl.since==null)pl.since=Math.floor(nowSec);else if(!g.ok&&pl.cutUntil<=nowSec)pl.since=null;}
    for(const [pb,g] of Object.entries(this.gates))if(prev&&prev[pb]?.ok!==g.ok||!prev&&g.ok)this.log(now,"ALLOC",`${POOL_BY_ID[pb]?.label??pb}：${g.ok?"允许开单":"只记录"} — ${g.why}`);
  }
  /** the cycle predictor (pure learners in predictor.ts): forecasts for every playbook with trades, the hourly forecast row,
   * scoring of due rows, the run-log lines, and the contradiction cut. Returns the live checks for the allocator, or null when
   * BTC 1h is not there yet (the old gate then stays in charge). */
  private predict(now:number,by:Map<string,TradeLite[]>):Record<string,LiveCheck>|null{
    const t0=Date.now(),nowSec=Math.floor(now/1000),b1=this.get("BTC_USDT","1h");
    if(!b1||b1.n<130){this.forecasts={};return null;}
    const alts=this.universe.filter(s=>s!=="BTC_USDT"&&s!=="ETH_USDT").map(s=>this.get(s,"1h")).filter((x):x is Series=>!!x&&x.n>=60);
    const feats=btcFeatures(b1,this.get("ETH_USDT","1h"),alts);if(!feats.rows.length){this.forecasts={};return null;}
    const pre=new Map<string,ReturnType<typeof phaseInfo>>(),z=():Hazard=>({events:Array(PRED.hazEdges.length-1).fill(0),exposure:Array(PRED.hazEdges.length-1).fill(0)});
    const pool={GOOD:z(),BAD:z()};
    for(const pb of POOL){const ts=by.get(pb.id);if(!ts?.length)continue;const x=phaseInfo(ts,nowSec);pre.set(pb.id,x);
      pool.GOOD=addHazard(pool.GOOD,hazardCounts(x.phases,"GOOD"));pool.BAD=addHazard(pool.BAD,hazardCounts(x.phases,"BAD"));}
    const fc:Record<string,PbForecast>={};
    for(const [pb,x] of pre)fc[pb]=predictPlaybook({pb,trades:by.get(pb)!,feats,nowSec,pool},x);
    this.forecasts=fc;this.predAt=now;
    // one row per hour (the first analysis of the hour), then score every due row against the labels known now
    const hourT=Math.floor(nowSec/3600)*3600;
    if(Object.keys(fc).length&&!this.fcRows.some(r=>r.t===hourT)){
      const f:FcRow["f"]={};for(const [pb,x] of Object.entries(fc))f[pb]=[r3(x.p["6"]),r3(x.p["24"]),r3(x.p["72"])];
      this.fcRows.push({t:hourT,f,y:{}});this.fcDirty.add(hourT);}
    const labelAt=(pb:string,t:number):Lab|null=>{const L=pre.get(pb)?.L;if(!L)return null;const i=Math.round((t-L.t0)/3600);return i>=0&&i<L.n?L.lab[i] as Lab:null;};
    for(const r of scoreRows(this.fcRows,labelAt,nowSec,this.track,x=>{this.recentScores.push(x);const a=this.scoreAcc;a.n++;if((x.p>=.5?1:0)===x.y)a.hits++;a.brier+=(x.p-x.y)**2;}))this.fcDirty.add(r.t);
    this.recentScores=this.recentScores.slice(-40);
    this.fcRows=this.fcRows.filter(r=>r.t>=nowSec-FC_KEEP_SEC);
    // run log: the top predictions (when they change, at least every 6 h) and the scoring summary (every 6 h)
    const top=this.topNow(3),key=top.map(x=>`${x.pb}:${Math.round(x.p6*20)}`).join(",");
    if(top.length&&(key!==this.lastTop||now-this.lastFcLogAt>=6*3_600_000)){this.lastTop=key;this.lastFcLogAt=now;
      this.log(now,"FORECAST",`最看好：${top.map(x=>`${x.label} ${Math.round(x.p6*100)}%（6 小时）【${x.sampleLabel}】`).join("；")}`);}
    const a=this.scoreAcc;if(a.n&&now-a.since>=6*3_600_000){
      this.log(now,"SCORE",`过去一段评了 ${a.n} 个到期预测：命中 ${Math.round(a.hits/a.n*100)}%，Brier ${(a.brier/a.n).toFixed(3)}`);this.scoreAcc={n:0,hits:0,brier:0,since:now};}
    else if(!a.since)a.since=now;
    // contradiction cut: the first trades after the gate opened all lost (or the last five) → pause the playbook
    const live:Record<string,LiveCheck>={};
    for(const pb of Object.keys(fc)){const pl=(this.predLive[pb]??={since:null,cutUntil:0});
      const res=pl.since==null?[]:(by.get(pb)??[]).filter(t=>t.et>=pl.since!).sort((x,y)=>x.et-y.et).map(t=>t.net);
      const why=pl.since!=null?contradicted(res):null;
      if(why){pl.cutUntil=nowSec+PRED_ALLOC.cutHours*3600;pl.since=null;
        this.log(now,"ALLOC",`${POOL_BY_ID[pb]?.label??pb}：预测说赚钱期，但${why}，暂停 ${PRED_ALLOC.cutHours} 小时（只记录）`);}
      live[pb]={since:pl.since,cutUntil:pl.cutUntil,results:res};}
    this.predMs=Date.now()-t0;return live;
  }
  /** the playbooks the predictor likes most right now (P(good in 6 h), evidence > 0, not the record-only long tier) */
  topNow(n=5){return Object.values(this.forecasts).filter(f=>f.sample>0&&(tierOf(POOL_BY_ID[f.pb]!)==="short"||ALLOC.longAllowed.includes(f.pb)))
    .sort((a,b)=>b.p["6"]-a.p["6"]).slice(0,n).map(f=>({pb:f.pb,label:POOL_BY_ID[f.pb]?.label??f.pb,p6:f.p["6"],p24:f.p["24"],sampleLabel:f.label,line:forecastLine(f,this.track[f.pb])}));}
  /** the intraday state now (the last BTC 1h bar, if it is recent) */
  currentIntra(now:number){const s=this.intra.at(-1);return s&&now/1000-(s.t+3600)<=3*3600?s:null;}
  /** synchronous plan input for the living engine */
  planInput(now:number,positions:readonly DynPosition[]):DynPlanInput{
    const ready=this.booted&&this.gates!=null&&this.tradesLoaded&&(this.states.length>0||this.intra.length>0);
    const signals:DynSignal[]=[];
    for(const o of this.opens.values()){if(!o.fresh||o.pb==="htf-donch20")continue;const pb=POOL_BY_ID[o.pb];if(!pb)continue;
      const until=(o.et*1000)+FRESH_MS[o.iv];if(now>until)continue;
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
    return {ready,gates:g?Object.fromEntries(Object.entries(g).map(([k,v])=>[k,{ok:v.ok,risk:v.risk,conf:v.conf,why:v.why}])):null,signals,exits,
      state:[this.currentIntra(now)?.bucket?`日内 ${bucketLabel(this.currentIntra(now)!.bucket)}`:null,this.states.at(-1)?.bucket?`日线 ${bucketLabel(this.states.at(-1)!.bucket)}`:null].filter(Boolean).join("｜")||null};
  }
  view(now:number){
    const cur=this.states.at(-1)??null,ic=this.currentIntra(now),bv=backfillView(this.bf,this.universe,now,this.opts.minGapMs??BACKFILL.minGapMs);
    const counts:Record<string,number>={};for(const s of this.tsrc.values())for(const r of s.rows){const pb=s.pbs[r[0]];if(pb)counts[pb]=(counts[pb]??0)+1;}
    const unitsAll=Object.values(this.unitsTotal).reduce((a,b)=>a+b,0),unitsDone=Object.keys(this.unitsDone).length;
    return {version:DYN_VERSION,booted:this.booted,bootError:this.bootError,lastError:this.lastError,lastStepAt:this.lastStepAt||null,lastStepMs:this.lastStepMs,maxStepMs:this.maxStepMs,
      lastAnalyzeAt:this.lastAnalyzeAt||null,store:{...this.store},backfill:bv,shadowTrades:this.tradeCount,tradesLoaded:this.tradesLoaded,
      replay:{unitsDone,unitsQueued:this.unitQueue.length,unitsKnown:unitsAll,liveSeries:Object.keys(this.liveFrom).length,liveEvals:this.liveEvals},
      state:cur?{day:new Date(cur.t*1000).toISOString().slice(0,10),bucket:cur.bucket,label:bucketLabel(cur.bucket),trend:cur.trend,strength:r4(cur.strength),
        atrPct:r4(cur.atrPct),volPct:r4(cur.volPct),dd90:r4(cur.dd90),eff20:r4(cur.eff20),eth:cur.eth,altVsBtc:cur.altVsBtc==null?null:r4(cur.altVsBtc),lead:cur.lead,corr30:cur.corr30==null?null:r4(cur.corr30)}:null,
      intraday:ic?{hour:new Date(ic.t*1000).toISOString().slice(0,13)+":00",bucket:ic.bucket,label:bucketLabel(ic.bucket),trend:TREND_LABEL[ic.trend],trend4h:TREND_LABEL[ic.trend4h],
        vol:VOL_LABEL[ic.vol],atrPct:r4(ic.atrPct),volPct:r4(ic.volPct),eth:ic.eth?TREND_LABEL[ic.eth]:null,session:SESSION_LABEL[sessionOf(now/1000)]}:null,
      stateHistory:stateChanges(this.states).slice(-12).map(c=>({day:new Date(c.t*1000).toISOString().slice(0,10),to:bucketLabel(c.to),why:c.why})),
      playbooks:POOL.map(pb=>{const c=this.cycles[pb.id],g=this.gates?.[pb.id];return {id:pb.id,label:pb.label,iv:pb.iv,side:pb.side,rule:pb.rule,tier:tierOf(pb),
        family:pb.family??pb.id,familyLabel:pb.familyLabel??pb.label,only:pb.only??null,trades:counts[pb.id]??0,
        all:c?.all??null,rolling:c?.rolling??null,counts:c?.counts??null,unit:c?.unit??"week",good:c?.good??0,bad:c?.bad??0,meanGoodWeeks:c?r1(c.meanGoodWeeks):0,meanBadWeeks:c?r1(c.meanBadWeeks):0,
        persistence:c?.persistence??null,current:c?.current??null,pattern:c?.pattern??false,patternWhy:c?.patternWhy??"还没分析",
        stage:c?.stage??"none",sample:c?.sample??0,forecast:c?.forecast?{...c.forecast,prob:r4(c.forecast.prob),raw:r4(c.forecast.raw),sample:r4(c.forecast.sample)}:null,
        byBucket:c?.byBucket??{},bySession:c?.bySession??{},gate:g?{ok:g.ok,risk:g.risk,conf:g.conf,why:g.why}:null,
        pred:this.predView(pb.id),
        open:[...this.opens.values()].filter(o=>o.pb===pb.id).length};}),
      allowed:this.gates?Object.values(this.gates).filter(g=>g.ok).map(g=>({pb:g.pb,label:POOL_BY_ID[g.pb]?.label??g.pb,risk:g.risk,why:g.why})):[],
      limits:{maxPoolOpen:ALLOC.maxPoolOpen,maxPerPlaybook:ALLOC.maxPerPlaybook,baseRisk:ALLOC.baseRisk,shortRisk:ALLOC.shortRisk},
      predictor:this.predictorView(),
      events:this.events.slice(-40).reverse()};
  }
  private predView(pb:string){const f=this.forecasts[pb];if(!f)return null;const tv=trackView(this.track[pb]);
    return {line:forecastLine(f,this.track[pb]),cur:f.cur,elapsedH:f.elapsedH,p6:r3(f.p["6"]),p24:r3(f.p["24"]),p72:r3(f.p["72"]),trigger:f.trigger,label:f.label,sample:r3(f.sample),
      phases:{good:f.phases.good,bad:f.phases.bad,meanGoodH:r1(f.phases.meanGoodH),meanBadH:r1(f.phases.meanBadH)},period:f.period,profile:f.profile,wLog:r3(f.wLog),
      track:{n:tv.n,hit:r3(tv.hit),brier:r3(tv.brier)},hist:{n:f.hist.n,hit:r3(f.hist.hit)},live:this.predLive[pb]??null};}
  private predictorView(){
    const all=emptyTrack();for(const t of Object.values(this.track)){all.n+=t.n;all.hits+=t.hits;all.brier+=t.brier;t.bins.forEach((b,i)=>{all.bins[i]![0]+=b[0];all.bins[i]![1]+=b[1];all.bins[i]![2]+=b[2];});}
    const tv=trackView(all);
    return {ready:Object.keys(this.forecasts).length>0,at:this.predAt||null,ms:this.predMs,playbooks:Object.keys(this.forecasts).length,hourRows:this.fcRows.length,pMin:PRED_ALLOC.pMin,
      track:{n:tv.n,hit:r3(tv.hit),brier:r3(tv.brier),calib:tv.calib.map(c=>c&&{n:c.n,p:r3(c.p),y:r3(c.y)})},
      topNow:this.topNow(5),
      recent:this.recentScores.slice(-12).reverse().map(x=>({...x,label:POOL_BY_ID[x.pb]?.label??x.pb,hit:(x.p>=.5?1:0)===x.y}))};
  }
}
const r3=(x:number)=>Math.round(x*1e3)/1e3,r4=(x:number)=>Math.round(x*1e4)/1e4,r1=(x:number)=>Math.round(x*10)/10,p8=(x:number)=>Number(x.toPrecision(8));
const fmt=(x:number)=>x>=100?x.toFixed(2):x>=1?x.toFixed(4):x.toPrecision(4);
/** fetch for the worker: JSON, 8 s timeout, non-2xx → HttpStatusError (429 / 403 skip that venue for a while) */
export async function venueFetch(url:string):Promise<unknown>{
  const res=await fetch(url,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(8_000)});
  if(!res.ok){await res.body?.cancel().catch(()=>undefined);throw new HttpStatusError(res.status);}
  return await res.json();
}
export {IV_SEC,CHUNK_SEC};
