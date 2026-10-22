/**
 * Living research layer orchestrator (spec C7/C8). Owns all living state in memory, persists it in its own keys
 * (living:v1:*, each ≤ 96KB, never in the 4MB forward state), and produces at most one directive per forward tick.
 *
 * Hooks (worker):
 *  - onHub(points, now)       after each existing multi-source refresh (~2s): feed the tape, step the fast lane.
 *  - plan(ctx)                before advanceForward: 5m-close research (probes → thesis → selection → watches), watches,
 *                             fast follow, protections and thesis exits → LivingDirective | undefined.
 *  - afterForward(res, state) log opened/rejected, learn from closed living trades.
 *  - writes(now)              dirty own keys under a small daily budget.
 * Mode off: none of this runs. Compute-only: everything runs and is logged, plan() returns undefined.
 * Any exception or stale data → automatic fallback to compute-only for 1 hour (C8).
 */
import {FAST,STEPS,SIZING,LIVING_CONFIG_KEY,LIVING_KEY_PREFIX,LIVING_MAX_VALUE_BYTES,LIVING_ITEM_LABELS,LIVING_RULE_EPOCH,
  type LivingConfig,type LivingItems,normalizeLivingConfig,effectiveLiving,withFallback,LIVING_ITEMS} from "./config.ts";
import {LivingTape,BAR_PAGES,BAR_PAGE_PREFIX,M1_PAGES,M1_PAGE_PREFIX,selectBasket,basketDue,pruneBasket,type Basket,type TapePoint,type MidBar} from "./tape.ts";
import {stepFast,initialFast,normalizeFast,fastFollowBlocked,matureRecords,fastMultiple,weeklyAdjust,noteMissed,bucketOf,
  type FastState,type EpisodeRecord,type FastEvent,type Episode} from "./fast-lane.ts";
import {detectProbes,registerObservations,matureObservations,allScores,noteSeries,fitProbes,initialProbes,normalizeProbes,
  PROBE_META,type ProbeState,type ProbeScore,type ProbeId,type Trigger} from "./probes.ts";
import {thesisInputs,noteBasketIndex,judge,advanceThesis,notePredictions,initialThesis,normalizeThesis,PLAYBOOK_PROBE,PLAYBOOK_LABEL,
  type ThesisState} from "./thesis.ts";
import {learnSelection,initialSelect,normalizeSelect,type SelectState,type Market} from "./select.ts";
import {stopCheck,newWatch,stepWatch,fastFollowPicks,type Watch} from "./entry.ts";
import {layerOne,evidenceFactor,normalRisk,fastRisk} from "./conviction.ts";
import {fastProtection,thesisExits,surgeGuard,type PositionView} from "./exits.ts";
import {FlowBook,FLOW_PAGES,FLOW_PAGE_PREFIX,type FlowPoint} from "./flow.ts";
import {followAtEdge} from "./intent.ts";
import {features,readCoin,readMarket,marketSizing,healthOf,sizeModulator,intentEvidence,burstFlow,holdCheck,planIntent,noTradeReason,evidenceLine,
  type CoinIntent,type MarketIntent} from "./intent.ts";
import {coinEnv,marketEnv,basketAutocorr,basketDir24,envDecide,envSetup,envTag,envHead,ENV_LABEL,type CoinEnv,type MarketEnv,type EnvDecision} from "./regime.ts";
import type {IntentPlaybook,Playbook} from "./thesis.ts";
import type {LivingDirective,LivingOrder,LivingTradeAction,LivingResult,LivingNote} from "./directive.ts";
import {bytesOf,r6,r4,corr} from "./util.ts";
import {dynHold,volUnit,type DynState} from "./hold-dyn.ts";
import {LEADER,closesOf,burstCheck,rankLeaders,leaderStop,leaderHold,vol6Of} from "./burst-leader.ts";
import {HTF,closedDaily,dailyCheck,htfExitLevel,htfOrder,freshThrough,dayKey,dayStartSec,signalCell,trailLow,type DailyBar} from "./htf-trend.ts";
import {RunLog,CASES_KEY,CASE_PAGE_KEYS,type Gate,type Layer,type CaseInput,type MarketSample} from "./runlog.ts";

export const LIVING_KEYS={config:LIVING_CONFIG_KEY,basket:`${LIVING_KEY_PREFIX}basket`,fast:`${LIVING_KEY_PREFIX}fast`,
  episodes:`${LIVING_KEY_PREFIX}episodes`,probes:`${LIVING_KEY_PREFIX}probes`,thesis:`${LIVING_KEY_PREFIX}thesis`,
  select:`${LIVING_KEY_PREFIX}select`,trades:`${LIVING_KEY_PREFIX}trades`,logIndex:`${LIVING_KEY_PREFIX}log:index`,
  intent:`${LIVING_KEY_PREFIX}intent`,cases:CASES_KEY} as const;
export const LOG_PAGE_PREFIX=`${LIVING_KEY_PREFIX}log:`;
export const LOG_PAGES_KEPT=30;
const LOG_PAGE_BYTES=LIVING_MAX_VALUE_BYTES-2048;
/** Own daily write budget (rows), well inside the shared 100k optional guard. */
export const LIVING_WRITES_PER_DAY=4_000;
const HOT_EVERY_MS=120_000,HEAVY_EVERY_MS=15*60_000,BARS_EVERY_MS=60*60_000;
/** Warm-restart cadence: recent 1m bars, flow pages and the market-read history (so a deploy resumes in ~1-2 minutes, not 15-60). */
const WARM_EVERY_MS=10*60_000,FAST_BASELINE_EVERY_MS=6*60_000;
const INTENT_HIST_BYTES=72_000;
const STALE_MS=30_000; // spec C8: quotes older than 30s → compute-only for 1h

/** Minimal views of the forward core the engine reads (no runtime import of forward-relations). */
/** 60 min after a LIVING_STOP on a coin, the same coin + playbook is not traded again (NEAR faded 3× in 30 min on 10-21).
 * Derived from the persisted forward history, so it survives restarts. */
export const STOP_COOLDOWN_MS=60*60_000;
export function stopCooldown(history:ForwardView["history"],symbol:string,pb:string,now:number):string|null{
  for(const t of history){
    if(t.symbol!==symbol||t.closedAt==null||now-t.closedAt>=STOP_COOLDOWN_MS||now<t.closedAt)continue;
    if(t.exitReason!=="LIVING_STOP")continue;
    const n=t.entryContext?.living;const tpb=n?(n.k==="F"?"follow":n.pb):null;if(tpb!==pb)continue;
    return`止损后冷却：${Math.ceil((STOP_COOLDOWN_MS-(now-t.closedAt))/60_000)} 分钟内同币同打法不再做`;
  }
  return null;
}
export type ForwardView={positions:{id:string;symbol:string;side:"LONG"|"SHORT";entryPrice:number;stopPrice:number;liquidationPrice?:number|null;
  openedAt:number;favorable:number;adverse?:number;livingGuard?:{stop:number}|undefined;entryContext?:{living?:LivingNote}|undefined;inverseCopy?:unknown}[];
  history:{id:string;symbol:string;side:"LONG"|"SHORT";netPnl:number|null;plannedRisk:number;notional:number;closedAt:number|null;exitReason:string|null;
    openedAt:number;entryContext?:{living?:LivingNote}|undefined}[];
  opportunities:{symbol:string;side:"LONG"|"SHORT";eligible?:boolean}[]};
export type QuoteView={bestBid:number;bestAsk:number;observedAt:number;entryReady?:boolean};
/** Gate bulk radar row the worker already fetched every 15s (no request of the living layer). */
export type RadarView={symbol:string;openInterest?:number;fundingRate?:number;markPrice?:number;indexPrice?:number};
/** Hub flow row (MarketDataHub.peekFlow): Bybit OI / funding / basis / turnover and the venues' aggressor proxy. */
export type HubFlowView={symbol:string;at:number;oi:number|null;funding:number|null;basis:number|null;taker:number|null;turnover:number|null};
export type ContractView={maintenanceRate:number;leverageMax:number};
export type PlanContext={now:number;forward:ForwardView;quotes:Record<string,QuoteView>;contracts:Record<string,ContractView>;
  funding:Record<string,number>;candles:Record<string,{time:number;open:number;high:number;low:number;close:number}[]>;
  /** htf-donch20: daily candles the worker already keeps (external venues only), the hub's 24h volume, the universe (coins with
   * external daily data) and the universe coins the external venues do not cover (skipped, never fetched from Gate). */
  htf?:HtfInput};
export type HtfInput={daily:Record<string,DailyBar[]>;volume:Record<string,number|null>;universe:string[];notExternal:string[]};
export type LogRow={at:number;k:string;[x:string]:string|number|boolean|null};
type TradesState={v:1;watches:Watch[];liveNet:Record<string,number[]>;seen:string[];handedOff:string[];peaks:[string,number][];
  recentTriggers:{at:number;t:Trigger[]}[];lastBarAt:number;lastMinuteAt:number;counts:Record<string,number>;
  pendingEvents:FastEvent[];lastEnd:{id:string;end:string;at:number}|null;fastEntries:Record<string,number>;
  /** burst-leader-v1: last trigger bar per side (seconds) and the trigger waiting 2 minutes for its leader ranking */
  bl?:BurstLeaderState;
  /** htf-donch20: last checked UTC day, picks waiting for a Gate quote (entry window), the last check's summary */
  hx?:HtfState};
type HtfPending={id:string;sym:string;day:string;close:number;brk:number;atr:number;rank:number|null;vol:number|null;why:string;until:number};
type HtfSummary={day:string;at:number;regime:"ON"|"OFF"|"UNKNOWN";btc:number|null;sma:number|null;universe:number;fresh:number;
  breakouts:string[];picks:string[];skipped:string[];text:string};
type HtfState={day:string;pending:HtfPending[];last:HtfSummary|null};
type BurstLeaderState={last:{LONG:number;SHORT:number};pending:{id:string;side:"LONG"|"SHORT";bar:number;z:number;why:string}|null};
const initialTrades=():TradesState=>({v:1,watches:[],liveNet:{},seen:[],handedOff:[],peaks:[],recentTriggers:[],lastBarAt:0,lastMinuteAt:0,
  counts:{},pendingEvents:[],lastEnd:null,fastEntries:{}});
const FAST_CODES=new Set(["LIVING_FAST_LIQ_GUARD","LIVING_FAST_TIGHTEN","LIVING_FAST_CONFIRM_EXIT","LIVING_FAST_BREAKEVEN","LIVING_FAST_GIVEBACK"]);
const d=(s:"LONG"|"SHORT")=>s==="LONG"?1:-1;
const fx=(v:number)=>Number(v.toPrecision(6)).toString();
const hhmm=(ms:number)=>new Date(ms).toISOString().slice(11,16);

export class LivingEngine{
  config:LivingConfig;
  tape=new LivingTape();
  basket:Basket|null=null;
  fast:FastState=initialFast();
  episodes:EpisodeRecord[]=[];
  probes:ProbeState=initialProbes();
  thesis:ThesisState=initialThesis();
  select:SelectState=initialSelect();
  trades:TradesState=initialTrades();
  log:LogRow[]=[];
  logSeq=0;logPages:number[]=[];
  loaded=false;
  lastError:string|null=null;
  private dirty=new Set<string>();
  private lastHot=0;private lastHeavy=0;private lastBars=0;private lastWarm=0;private lastCasesWrite=0;private lastFastWrite=0;private lastIndexSig="";
  /** Market read from before a restart: shown until the first fresh read, never used to trade. */
  restoredMarket:MarketIntent|null=null;loadedAt=0;
  writesToday={day:"",n:0};
  lastPlanAt=0;lastPlanMs=0;maxPlanMs=0;lastHubMs=0;
  // v2 intent layer
  flow=new FlowBook();
  marketIntent:MarketIntent|null=null;
  marketHist:MarketIntent[]=[];
  coins=new Map<string,CoinIntent>();
  /** v3 environment read (lib/living/regime.ts): per coin, and the market env (switches after 3 equal reads in a row) */
  envs=new Map<string,CoinEnv>();
  menv:MarketEnv|null=null;
  private menvPending:{state:string;n:number}={state:"",n:0};
  private coinHist=new Map<string,CoinIntent[]>();
  holds=new Map<string,{why:string;code:string;at:number}>();
  decisions:LogRow[]=[];
  private lastIntentAt=0;
  intentCounts:Record<string,number>={};
  /** Run log v3 (lib/living/runlog.ts): timeline buckets, funnel and research cases. Review only. */
  runlog:RunLog;
  constructor(now:number,config?:unknown){this.config=normalizeLivingConfig(config,now);this.runlog=new RunLog(now);}

  /** Keys to read at start (one batched get). */
  static loadKeys(){return[...Object.values(LIVING_KEYS),...CASE_PAGE_KEYS.slice(1),...Array.from({length:BAR_PAGES},(_,i)=>`${BAR_PAGE_PREFIX}${i}`),
    ...Array.from({length:FLOW_PAGES},(_,i)=>`${FLOW_PAGE_PREFIX}${i}`),...Array.from({length:M1_PAGES},(_,i)=>`${M1_PAGE_PREFIX}${i}`)];}
  restore(values:Map<string,unknown>,now:number,logPage?:unknown){
    this.config=normalizeLivingConfig(values.get(LIVING_KEYS.config),now);
    const b=values.get(LIVING_KEYS.basket) as Basket|undefined;this.basket=b&&Array.isArray(b.members)?b:null;
    this.fast=normalizeFast(values.get(LIVING_KEYS.fast));
    // an episode from before a restart has a stale anchor: drop it (cooldowns stay)
    if(this.fast.episode&&now-this.fast.lastSampleAt>30_000)this.fast.episode=null;
    this.fast.streak=null;
    const e=values.get(LIVING_KEYS.episodes);this.episodes=Array.isArray(e)?e as EpisodeRecord[]:[];
    this.probes=normalizeProbes(values.get(LIVING_KEYS.probes));
    this.thesis=normalizeThesis(values.get(LIVING_KEYS.thesis));
    this.select=normalizeSelect(values.get(LIVING_KEYS.select));
    const t=values.get(LIVING_KEYS.trades) as TradesState|undefined;
    this.trades=t?.v===1?{...initialTrades(),...t,pendingEvents:[],watches:(t.watches??[]).filter(w=>w.status==="WAITING"&&w.expiresAt>now)}:initialTrades();
    const idx=values.get(LIVING_KEYS.logIndex) as {seq?:number;pages?:number[]}|undefined;
    this.logSeq=Number.isFinite(idx?.seq)?idx!.seq!:0;this.logPages=Array.isArray(idx?.pages)?idx!.pages!:[];
    const lp=logPage as {rows?:LogRow[]}|undefined;this.log=Array.isArray(lp?.rows)?lp!.rows!:[];
    this.tape.restore(Array.from({length:BAR_PAGES},(_,i)=>values.get(`${BAR_PAGE_PREFIX}${i}`)).filter(Boolean));
    this.flow.restore(Array.from({length:FLOW_PAGES},(_,i)=>values.get(`${FLOW_PAGE_PREFIX}${i}`)).filter(Boolean));
    const m1=this.tape.restore1(Array.from({length:M1_PAGES},(_,i)=>values.get(`${M1_PAGE_PREFIX}${i}`)).filter(Boolean),now);
    const iv=values.get(LIVING_KEYS.intent) as {v?:number;hist?:MarketIntent[];decisions?:LogRow[]}|undefined;
    if(iv?.v===1){
      this.marketHist=(Array.isArray(iv.hist)?iv.hist:[]).filter(x=>x&&typeof x.at==="number"&&now-x.at<=90*60_000&&x.at<=now);
      this.decisions=Array.isArray(iv.decisions)?iv.decisions.slice(-60):[];
      const last=this.marketHist.at(-1);this.restoredMarket=last&&now-last.at<=20*60_000?last:null;
    }
    this.lastIndexSig=JSON.stringify({seq:this.logSeq,pages:this.logPages});
    let cases=0;try{cases=this.runlog.restore(values.get(LIVING_KEYS.cases),now,CASE_PAGE_KEYS.slice(1).map(k=>values.get(k)));}catch{cases=0;}
    this.loaded=true;this.loadedAt=now;
    this.note(now,"RESTART",{bars:this.tape.m5.size,bars1m:m1,flow:this.flow.m1.size,hist:this.marketHist.length,episodes:this.episodes.length,watches:this.trades.watches.length,cases});
  }
  effective(now:number){return effectiveLiving(this.config,now);}
  setConfig(next:Partial<Pick<LivingConfig,"mode"|"items">>,now:number){
    const items={...this.config.items,...(next.items??{})} as LivingItems;
    this.config=normalizeLivingConfig({...this.config,mode:next.mode??this.config.mode,items,updatedAt:now,
      fallback:next.mode&&next.mode!==this.config.mode?null:this.config.fallback},now);
    this.dirty.add(LIVING_KEYS.config);this.note(now,"CONFIG",{mode:this.config.mode,items:LIVING_ITEMS.filter(k=>items[k]).join(",")});
    return this.config;
  }
  private fallback(now:number,reason:string){
    const before=this.config.fallback;this.config=withFallback(this.config,now,reason);
    if(this.config.fallback!==before){this.dirty.add(LIVING_KEYS.config);this.note(now,"FALLBACK",{reason:reason.slice(0,160)});}
  }
  note(at:number,k:string,data:Record<string,string|number|boolean|null>={}){
    this.log.push({at,k,...data});
    if(/^(ENTRY|ENTRY_RECORD|RECORD_ONLY|WATCH|EXIT|EXIT_RECORD|PROTECT|PROTECT_RECORD|HOLD_CHANGE|INTENT_MARKET|ENV_MARKET|CLOSED|FAST_|SURGE|BURST_ONSET|BURST_RANK|HTF_)/.test(k)){
      this.decisions.push({at,k,...data});if(this.decisions.length>60)this.decisions.splice(0,this.decisions.length-60);}
    const ck=typeof data.reason==="string"?`${k}:${String(data.reason).replace(/[0-9.+\-%]+/g,"#").slice(0,40)}`:k;
    this.trades.counts[ck]=(this.trades.counts[ck]??0)+1;
    if(this.log.length%25===0&&bytesOf(this.log)>LOG_PAGE_BYTES)this.rollLog();
    this.dirty.add("log");
    if(/^(INTENT_MARKET|ENV_MARKET|FALLBACK|CONFIG|RESTART|BASKET|FAST_(ALERT|CONFIRM|FAKE|EXHAUST|TIMEOUT|REVERSED|SURGE))$/.test(k)){
      const text=String(data.sentence??data.reason??data.mode??data.why??data.flowWhy??data.side??"");
      try{this.runlog.event(at,k,`${k==="INTENT_MARKET"||k==="ENV_MARKET"?`${data.state}${data.side?`/${data.side}`:""} `:""}${text}`);}catch{/* 只是记录 */}
    }
  }
  private once=new Set<string>();
  /** Same row only once per key (per-tick repeats of an unchanged decision are not new information). */
  noteOnce(key:string,at:number,k:string,data:Record<string,string|number|boolean|null>={}){
    if(this.once.has(key))return false;this.once.add(key);if(this.once.size>2000)this.once=new Set([...this.once].slice(-1000));this.note(at,k,data);return true;
  }
  // ------------------------------------------------------------------ run log v3 hooks (never throw into trading)
  /** One sample a minute, whatever the mode (an off layer is recorded as off, so the timeline has no holes). */
  tickLog(now:number,forward?:ForwardView){
    try{
      const eff=this.effective(now),m=this.marketIntent;
      const gate:Gate=!this.loaded?"NOT_LOADED":this.config.mode==="off"?"PAUSED_OFF":eff.fallback?"FALLBACK":!eff.acting?"COMPUTE_ONLY"
        :!this.basket?"NO_BASKET":!m||m.state==="WARMING"?"WARMING":this.fast.episode?"FAST_OWNS":"OPEN";
      this.runlog.sample(now,{gate,market:this.marketSample(),fast:this.fast.episode?this.fast.episode.phase:"CALM",
        open:(forward?.positions??[]).filter(p=>!p.inverseCopy).length,watches:this.trades.watches.length,mode:eff.mode});
    }catch{/* 只是记录 */}
  }
  private marketSample():MarketSample{
    const m=this.marketIntent;if(!m)return null;
    const e=this.menv;
    return {state:m.state,side:m.side,conf:Math.round(m.confidence*100)/100,allowed:m.allowed.map(a=>`${a.pb}${a.side?`/${a.side}`:""}`),
      ...(e?{env:`${e.state}${e.side?`/${e.side}`:""}`,envConf:e.clarity}:{})};
  }
  private caseInput(now:number,sym:string,side:"LONG"|"SHORT",pb:string,kind:"normal"|"fast",why?:string):CaseInput{
    const ci=this.coins.get(sym),f=ci?.f,p=(v:number|null|undefined)=>v==null||!Number.isFinite(v)?null:Math.round(v*1e5)/1e3;
    return {at:now,sym,side,pb,pbLabel:PLAYBOOK_LABEL[pb as Playbook]??(pb==="fast"?"集体异动快速跟进":pb===HTF.pb?HTF.label:pb),kind,
      intent:ci?`${ci.capital}/${ci.emotion}`:null,strength:ci?.action?.strength??ci?.strength??null,why:why??ci?.action?.why??ci?.why??"",
      ev:f?{p15:p(f.p15),p60:p(f.p60),oi15:p(f.oi15),oi60:p(f.oi60),funding:f.funding==null?null:Math.round(f.funding*1e7)/1e5,taker15:f.taker15==null?null:Math.round(f.taker15*1e3)/1e3,
        vol15:f.vol15==null?null:Math.round(f.vol15*100)/100,basis:p(f.basis)}:null,
      market:this.marketSample(),px:this.tape.last(sym)?.mid??null,env:envTag(this.envs.get(sym),this.menv)};
  }
  private logCase(now:number,sym:string,side:"LONG"|"SHORT",pb:string,layer:Layer,reason:string,kind:"normal"|"fast"="normal",why?:string){
    try{this.runlog.noteCase(this.caseInput(now,sym,side,pb,kind,why),layer,reason);}catch{/* 只是记录 */}
  }
  private logCount(now:number,layer:Layer|"reads"|"ideas"|"no_idea",reason?:string|null,n=1){try{this.runlog.count(now,layer,reason,n);}catch{/* 只是记录 */}}
  private sealed:{seq:number;rows:LogRow[]}[]=[];
  private rollLog(){this.sealed.push({seq:this.logSeq,rows:this.log});this.logPages=[...this.logPages.filter(p=>p!==this.logSeq),this.logSeq];this.logSeq++;this.log=[];}

  // ------------------------------------------------------------------ fast path (every hub refresh)
  onHub(points:TapePoint[],now:number,gateListed:(s:string)=>boolean,flowRows:HubFlowView[]=[]){
    if(this.config.mode==="off"||!this.loaded)return;
    const t0=Date.now();
    try{
      if(flowRows.length)this.flow.feed(flowRows.map((r):FlowPoint=>({symbol:r.symbol,at:r.at,src:"B",oi:r.oi,funding:r.funding,basis:r.basis,taker:r.taker,
        volUsd:r.turnover!=null?this.flow.volFromTurnover(r.symbol,r.at,r.turnover):null})),now);
      if(basketDue(this.basket,now)&&points.length>=40){
        const rows=points.map(p=>({symbol:p.symbol,volume24hUsd:p.volume24hUsd??0,sources:p.sources??1,gate:gateListed(p.symbol)}));
        const b=selectBasket(rows,now);if(b.members.length>=20){this.basket=b;this.dirty.add(LIVING_KEYS.basket);this.note(now,"BASKET",{n:b.members.length,top:b.top10.slice(0,5).join(",")});}
      }else if(this.basket){const nb=pruneBasket(this.basket,gateListed);if(nb!==this.basket){this.basket=nb;this.dirty.add(LIVING_KEYS.basket);}}
      this.tape.feed(points,now);
      if(!this.basket)return;
      const members=this.basket.members;
      const r=stepFast(this.fast,this.tape,this.basket,now,side=>burstFlow(this.flow,members,side,now));this.fast=r.state;
      for(const e of r.events){
        this.trades.pendingEvents.push(e);
        this.note(now,`FAST_${e.type}`,{ep:e.episodeId,side:e.side,...Object.fromEntries(Object.entries(e.detail).slice(0,12))});
      }
      if(r.ended){this.episodes.push(r.ended);if(this.episodes.length>200)this.episodes.splice(0,this.episodes.length-200);
        this.trades.lastEnd={id:r.ended.id,end:r.ended.end,at:now};this.dirty.add(LIVING_KEYS.episodes);}
      if(r.events.length){this.dirty.add(LIVING_KEYS.fast);this.dirty.add("fastNow");}
      if(this.trades.pendingEvents.length>40)this.trades.pendingEvents.splice(0,this.trades.pendingEvents.length-40);
      if(now-this.trades.lastMinuteAt>=60_000){
        this.trades.lastMinuteAt=now;
        if(matureRecords(this.episodes,this.tape,this.basket.members,now))this.dirty.add(LIVING_KEYS.episodes);
        noteMissed(this.fast,this.tape,this.basket.members,now);
        if(weeklyAdjust(this.fast,now))this.note(now,"FAST_ADJUST",{z:this.fast.adjust.z,why:this.fast.adjust.log.at(-1)?.why??""});
        this.dirty.add(LIVING_KEYS.fast);
      }
      if(now-this.lastIntentAt>=60_000){this.lastIntentAt=now;this.readIntents(now,[]);}
    }catch(error){this.lastError=String((error as Error)?.message??error).slice(0,200);this.fallback(now,`快速通道出错：${this.lastError}`);}
    finally{this.lastHubMs=Date.now()-t0;}
  }

  /** Gate bulk radar rows the worker already fetched (15s): Gate open interest, funding, mark/index basis. */
  onRadar(rows:RadarView[],now:number){
    if(this.config.mode==="off"||!this.loaded)return;
    try{
      this.flow.feed(rows.filter(r=>r&&r.symbol).map((r):FlowPoint=>({symbol:r.symbol,at:now,src:"G",oi:Number.isFinite(r.openInterest)?r.openInterest!:null,
        funding:Number.isFinite(r.fundingRate)?r.fundingRate!:null,
        basis:r.markPrice&&r.indexPrice&&r.indexPrice>0?r.markPrice/r.indexPrice-1:null})),now);
    }catch(error){this.lastError=String((error as Error)?.message??error).slice(0,200);}
  }
  /** Warm-up after a restart from the worker's existing 15-minute Gate OI snapshots (lib/oi-anchor.ts). */
  seedOi(ring:readonly {at:number;oi:Record<string,number>}[]){try{return this.flow.seedOi(ring);}catch{return 0;}}
  /** Per-coin and market-wide intent read (about once a minute, ~60 coins, pure). */
  readIntents(now:number,extra:string[]){
    if(!this.basket)return;
    const syms=[...new Set([...this.basket.members,"BTC_USDT","ETH_USDT",...extra])],basketReads:CoinIntent[]=[];
    for(const s of syms){
      const hist=this.coinHist.get(s)??[];
      const ci=readCoin(s,features(this.tape,this.flow,s,now),now,hist);
      this.coins.set(s,ci);hist.push({...ci,f:undefined as never,why:""} as CoinIntent);
      while(hist.length&&now-hist[0]!.at>65*60_000)hist.shift();this.coinHist.set(s,hist);
      if(this.basket.members.includes(s))basketReads.push(ci);
      const k=`${ci.capital}/${ci.emotion}`;this.intentCounts[k]=(this.intentCounts[k]??0)+1;
    }
    for(const s of [...this.coins.keys()])if(!syms.includes(s))this.coins.delete(s);
    try{this.readEnvs(now,syms);}catch(error){this.lastError=`环境读数出错：${String((error as Error)?.message??error).slice(0,160)}`;}
    const m=readMarket(basketReads,this.coins.get("BTC_USDT")??null,this.coins.get("ETH_USDT")??null,now,this.marketHist);
    const prev=this.marketIntent??this.restoredMarket;this.marketIntent=m;this.restoredMarket=null;this.dirty.add(LIVING_KEYS.intent);this.marketHist.push(m);while(this.marketHist.length&&now-this.marketHist[0]!.at>90*60_000)this.marketHist.shift();
    if(!prev||prev.state!==m.state||prev.side!==m.side)this.note(now,"INTENT_MARKET",{state:m.state,side:m.side,conf:m.confidence,sentence:m.sentence.slice(0,200),
      oi15:m.ev.oi15,p15:m.ev.p15,funding:m.ev.funding,breadth:m.ev.breadth});
  }

  /** v3 environment read (pure, from the tape's own 5-minute bars); market env switches after 3 equal reads in a row. */
  private readEnvs(now:number,syms:string[]){
    const members=this.basket?.members??[],rows:MidBar[][]=[],envs:CoinEnv[]=[];
    for(const s of syms){const r5=this.tape.closed5(s,now),e=coinEnv(r5);this.envs.set(s,e);if(members.includes(s)){rows.push(r5);envs.push(e);}}
    for(const s of [...this.envs.keys()])if(!syms.includes(s))this.envs.delete(s);
    const raw=marketEnv(envs,this.envs.get("BTC_USDT")??null,basketAutocorr(rows),basketDir24(rows),now),cur=this.menv;
    if(!cur||cur.state===raw.state||cur.state==="WARMING"){this.menv=raw;this.menvPending={state:"",n:0};}
    else{
      this.menvPending=this.menvPending.state===raw.state?{state:raw.state,n:this.menvPending.n+1}:{state:raw.state,n:1};
      if(this.menvPending.n>=3){this.menv=raw;this.menvPending={state:"",n:0};}
      else this.menv={...cur,ev:raw.ev,at:now};
    }
    const m=this.menv!;
    if(!cur||cur.state!==m.state||cur.side!==m.side)this.note(now,"ENV_MARKET",{state:m.state,side:m.side,conf:m.clarity,sentence:m.sentence.slice(0,200),
      ac15:m.ev.ac15,dir24:m.ev.dir24,breadth:m.ev.breadth,btc:m.ev.btc});
  }
  /** Small public env summary (health / status). */
  envSummary(){
    const m=this.menv,members=this.basket?.members??[];
    const coins=["BTC_USDT","ETH_USDT",...members.filter(s=>s!=="BTC_USDT"&&s!=="ETH_USDT")].slice(0,10).map(s=>{const e=this.envs.get(s);return e?{s,env:e.state,c:e.clarity}:null;}).filter(Boolean);
    const counts:Record<string,number>={};for(const s of members){const e=this.envs.get(s);if(e)counts[e.state]=(counts[e.state]??0)+1;}
    const eff=this.effective(Date.now());
    return {brain:{mode:eff.mode,acting:eff.acting,fallback:!!eff.fallback,watches:this.trades.watches.length,lastError:this.lastError?this.lastError.slice(0,120):null},
      market:m?{state:m.state,label:ENV_LABEL[m.state],side:m.side,clarity:m.clarity,at:m.at,ac15:m.ev.ac15,dir24:m.ev.dir24,breadth:m.ev.breadth,btc:m.ev.btc}:null,
      counts,coins};
  }

  // ------------------------------------------------------------------ plan (before advanceForward)
  plan(ctx:PlanContext):LivingDirective|undefined{
    if(this.config.mode==="off"||!this.loaded)return undefined;
    const t0=Date.now(),now=ctx.now;
    try{
      if(this.tape.feeds>0&&now-this.tape.lastFeedAt>STALE_MS)this.fallback(now,`实时报价 ${Math.round((now-this.tape.lastFeedAt)/1000)} 秒没更新`);
      const eff=this.effective(now),items=eff.items;
      const bar=Math.floor((now-5_000)/300_000)*300_000;
      if(bar>this.trades.lastBarAt&&this.basket){this.trades.lastBarAt=bar;this.onBar(ctx,bar,items);}
      const minute=Math.floor(now/60_000)*60_000;
      if(minute!==this.lastWatchMinute&&this.basket&&this.marketIntent){this.lastWatchMinute=minute;this.intentWatches(ctx,items);}
      const actions:LivingTradeAction[]=[],orders:LivingOrder[]=[];
      const events=this.trades.pendingEvents.splice(0);
      const views=this.positionViews(ctx);
      // B4 protection
      const peaks=new Map(this.trades.peaks);
      const ep=this.fast.episode;
      const protScale=this.protectionScale();
      if(ep||events.length){
        const epForEvents=ep??null;
        const prot=fastProtection({positions:views,ep:epForEvents,events,tape:this.tape,now,scale:protScale,peaks});
        for(const a of prot){actions.push(a);this.noteOnce(`p|${a.tradeId}|${a.code}|${a.stop??""}`,now,eff.acting&&items.fastProtect?"PROTECT":"PROTECT_RECORD",{trade:a.tradeId,code:a.code,reason:a.reason,ep:ep?.id??null});}
        if(prot.length){const rec=this.episodes.find(r=>r.id===ep?.id);if(rec)rec.protections+=prot.length;}
      }
      this.trades.peaks=[...peaks].filter(([id])=>views.some(v=>v.id===id));
      for(const a of surgeGuard({positions:views,events,tape:this.tape,now})){actions.push(a);
        this.noteOnce(`p|${a.tradeId}|${a.code}`,now,eff.acting&&items.fastProtect?"PROTECT":"PROTECT_RECORD",{trade:a.tradeId,code:a.code,reason:a.reason});}
      // v2 hold / exit from the live intent read (normal trades and handed-off fast trades)
      for(const a of this.intentHolds(views,now)){actions.push(a);
        this.noteOnce(`h|${a.tradeId}|${a.code}|${a.stop??""}`,now,eff.acting&&items.thesisExit?"EXIT":"EXIT_RECORD",{trade:a.tradeId,code:a.code,reason:a.reason});}
      // C5 thesis exits
      const scores=this.scoreMap(now);
      const th=thesisExits({positions:views,thesis:this.thesis.current,scores,tape:this.tape,now,episode:this.fast.episode,
        handedOff:new Set(this.trades.handedOff),lastEnd:this.trades.lastEnd,
        intentSupports:side=>!!this.marketIntent&&this.marketIntent.side===side&&(this.marketIntent.state==="RISK_ON"||this.marketIntent.state==="RISK_OFF")});
      for(const a of th){
        if(a.action==="HANDOFF")this.trades.handedOff=[...this.trades.handedOff,a.tradeId].slice(-100);
        actions.push(a);this.noteOnce(`x|${a.tradeId}|${a.code}`,now,eff.acting&&items.thesisExit?"EXIT":"EXIT_RECORD",{trade:a.tradeId,code:a.code,reason:a.reason});
      }
      // C4 watches
      const oppositeAlert=(side:"LONG"|"SHORT")=>!!this.fast.episode&&this.fast.episode.side!==side;
      const keep:Watch[]=[];
      for(const w of this.trades.watches){
        const n=stepWatch(w,this.tape,now,oppositeAlert(w.side),items.noChase);
        if(n.status==="DONE"){this.logCase(now,w.symbol,w.side,w.playbook,"WATCH_END",n.reason??"放弃");this.note(now,"RECORD_ONLY",{sym:w.symbol,side:w.side,pb:w.playbook,reason:n.reason??"放弃"});continue;}
        if(n.status==="READY"){
          const o=this.normalOrder(ctx,n,scores,items);
          if(typeof o==="string"){this.logCase(now,w.symbol,w.side,w.playbook,"CONFIRM_FAIL",o);this.note(now,"RECORD_ONLY",{sym:w.symbol,side:w.side,pb:w.playbook,reason:o});continue;}
          orders.push(o);keep.push({...n,status:"WAITING"});continue;
        }
        keep.push(n);
      }
      this.trades.watches=keep;
      // B5 fast follow
      for(const o of this.fastOrders(ctx,items))orders.push(o);
      // burst-leader-v1: once a minute the special-condition check; 2 minutes after a trigger the leader ranking → 1–3 orders
      for(const o of this.burstOrders(ctx,items))orders.push(o);
      // htf-donch20: daily check once per UTC day, its picks while their entry window lasts, the daily trail of open ones
      const hx=this.htfStep(ctx,views,items,eff.acting);
      for(const a of hx.actions)actions.push(a);
      for(const o of hx.orders)orders.push(o);
      if(items.burstLeader){
        // only special conditions open: every other entry is recorded, not sent (htf-donch20 is its own rule, not an ordinary entry)
        for(let k=orders.length-1;k>=0;k--){const o=orders[k]!;if(o.note.bh||o.note.hx)continue;orders.splice(k,1);
          this.logCase(now,o.symbol,o.side,o.note.pb,"SPECIAL_ONLY","只在全市场突然爆发时开单：普通行情只记录",o.kind==="F"?"fast":"normal");
          this.note(now,"RECORD_ONLY",{sym:o.symbol,side:o.side,pb:o.note.pb,kind:o.kind,reason:"只在全市场突然爆发时开单，这张只记录"});this.endOrder(o,true);}
      }
      // execution filter: only symbols with a fresh entry-ready Gate quote (no new request)
      const exec=orders.filter(o=>{
        const q=ctx.quotes[o.symbol],ok=!!q&&now-q.observedAt<=10_000&&q.entryReady!==false&&q.bestBid>0&&q.bestAsk>=q.bestBid;
        if(!ok){if(this.noteOnce(`q|${o.id}`,now,"RECORD_ONLY",{sym:o.symbol,side:o.side,pb:o.note.pb,kind:o.kind,reason:"没有 Gate 实时盘口（不新增请求）"}))
            this.logCase(now,o.symbol,o.side,o.note.pb,"NO_QUOTE","没有 Gate 实时盘口",o.kind==="F"?"fast":"normal");
          this.endOrder(o,false);}
        return ok;
      });
      this.dirty.add(LIVING_KEYS.trades);
      if(!eff.acting){
        for(const o of exec){const px=this.tape.last(o.symbol)?.mid??null;this.logCase(now,o.symbol,o.side,o.note.pb,"COMPUTE_ONLY",`只计算模式：${o.reason.slice(0,60)}`,o.kind==="F"?"fast":"normal");
          this.note(now,"ENTRY_RECORD",{sym:o.symbol,side:o.side,pb:o.note.pb,kind:o.kind,mult:r4(o.multiple),px,stop:o.stop,hold:o.note.hold,
            intent:o.note.in??null,market:o.note.mk??null,story:(o.note.nar??"").slice(0,200),evd:(o.note.evd??"").slice(0,160),reason:`只计算模式：${o.reason.slice(0,80)}`});this.endOrder(o,true);}
        return undefined;
      }
      const directive:LivingDirective={version:"living-v2",items:{...items},
        // htf trail always passes (switch 9 only stops new daily-breakout entries; open ones keep their trail)
        actions:actions.filter(a=>a.code.startsWith("LIVING_HTF_")?true:a.code.startsWith("LIVING_BURST_")?!!items.burstLeader:FAST_CODES.has(a.code)?items.fastProtect:items.thesisExit),
        orders:exec.filter(o=>o.note.hx?!!items.htfTrend:o.note.bh?!!items.burstLeader:o.kind==="F"?items.fastFollow:items.newSource).sort((a,b)=>(a.kind==="F"?0:1)-(b.kind==="F"?0:1)),
        legacyGate:items.newSource?"note":"open"};
      for(const o of exec)if(!directive.orders.includes(o)){this.logCase(now,o.symbol,o.side,o.note.pb,"SWITCH_OFF","对应开关关着",o.kind==="F"?"fast":"normal");this.note(now,"RECORD_ONLY",{sym:o.symbol,side:o.side,pb:o.note.pb,reason:"对应开关关着，只记录"});this.endOrder(o,true);}
      if(this.config.epochStartedAt==null&&(directive.orders.length||directive.actions.length||directive.legacyGate==="note")){
        this.config={...this.config,epochStartedAt:now};this.dirty.add(LIVING_KEYS.config);
      }
      return directive;
    }catch(error){
      this.lastError=String((error as Error)?.stack??error).slice(0,300);this.fallback(now,`研究层出错：${String((error as Error)?.message??error).slice(0,120)}`);
      return undefined;
    }finally{this.lastPlanAt=now;this.lastPlanMs=Date.now()-t0;this.maxPlanMs=Math.max(this.maxPlanMs*.999,this.lastPlanMs);}
  }
  private protectionScale(){
    // B7: if the last 10 protections net cost money (protected trades would have done better unprotected), halve the tightening.
    const recent=this.episodes.filter(r=>r.protections>0&&r.after["15"]?.[0]!=null).slice(-10);
    if(recent.length<10)return 1;
    const wrong=recent.filter(r=>(r.after["15"]![0] as number)<0).length;// basket went back: protection was unnecessary
    return wrong>=6?.5:1;
  }
  scoreMap(now:number){
    const tag=this.thesis.current?.dirTag;
    return Object.fromEntries(allScores(this.probes,now,tag).map(s=>[s.probe,s])) as Record<ProbeId,ProbeScore>;
  }
  private positionViews(ctx:PlanContext):PositionView[]{
    return ctx.forward.positions.filter(p=>!p.inverseCopy).map(p=>{
      const q=ctx.quotes[p.symbol],fresh=!!q&&ctx.now-q.observedAt<=10_000,px=fresh?(p.side==="LONG"?q!.bestBid:q!.bestAsk):null;
      return {id:p.id,symbol:p.symbol,side:p.side,entryPrice:p.entryPrice,stopPrice:p.stopPrice,liquidationPrice:p.liquidationPrice??null,
        openedAt:p.openedAt,favorable:p.favorable,adverse:p.adverse??0,guard:p.livingGuard?.stop??null,living:p.entryContext?.living,price:px};
    });
  }
  private market(ctx:PlanContext,at:number):Market{
    return {bars:s=>this.tape.closed5(s,at),spread:s=>this.tape.meta.get(s)?.spread??null,volume:s=>this.tape.meta.get(s)?.volume24hUsd??0,
      mmr:s=>ctx.contracts[s]?.maintenanceRate??null,funding:s=>ctx.funding[s]??null};
  }

  // ------------------------------------------------------------------ 5m close: steps 1-3
  private onBar(ctx:PlanContext,at:number,items:LivingItems){
    const basket=this.basket!,members=[...new Set([...basket.members,"BTC_USDT","ETH_USDT"])];
    for(const [s,rows] of Object.entries(ctx.candles))if(members.includes(s)&&rows?.length)this.tape.seed5(s,rows.filter(r=>(r.time+300)*1000<=at));
    const bars=(s:string)=>this.tape.closed5(s,at);
    const done=matureObservations(this.probes,bars,members,ctx.funding,at);
    if(learnSelection(this.select,done,at))this.note(at,"SELECT_LEARN",{excess30:r6(this.select.excess.slice(-30).reduce((a,b)=>a+b,0)),w:JSON.stringify(this.select.weights)});
    const momentum=ctx.forward.opportunities.filter(o=>o.eligible!==false).map(o=>({symbol:o.symbol,side:o.side}));
    const triggers=detectProbes({at,members:basket.members,bars,funding:ctx.funding,oi1h:{},momentum});
    const tag=this.thesis.current?.dirTag??"F";
    registerObservations(this.probes,triggers,at,tag);
    this.trades.recentTriggers=[...this.trades.recentTriggers.filter(x=>at-x.at<15*60_000),{at,t:triggers}];
    noteBasketIndex(this.thesis,basket.members,bars,at);
    const change24h:Record<string,number>={};for(const s of basket.members){const m=this.tape.meta.get(s);if(m)change24h[s]=m.change24h;}
    const inputs=thesisInputs(basket.members,bars,change24h,ctx.funding,{},this.thesis);
    const scores=this.scoreMap(at);
    const burst=this.fast.episode?{side:this.fast.episode.side}:null;
    const cand=judge(inputs,scores,burst,at,this.thesis);
    if(advanceThesis(this.thesis,cand,at))this.note(at,"THESIS",{kind:cand.kind,side:cand.side,structure:cand.structure,sentence:cand.sentence.slice(0,200)});
    notePredictions(this.thesis,at);noteSeries(this.probes,at,tag);
    this.dirty.add(LIVING_KEYS.probes);this.dirty.add(LIVING_KEYS.thesis);this.dirty.add(LIVING_KEYS.select);
    // v2: the v1 probes / thesis above keep running as context and as the 0.7–1.2x size modulator; opening is decided by
    // the live intent read (intentWatches), never by a sample count.
    void items;
  }

  private dyn=new Map<string,DynState>();
  private lastWatchMinute=0;
  /** v2 steps 1-3 every minute: market intent clear → coins whose own read best expresses an allowed playbook → a watch at
   * the playbook's location (step 4 confirms). All from live evidence; no sample-count gate. */
  private intentWatches(ctx:PlanContext,items:LivingItems){
    const now=ctx.now,m=this.marketIntent!,basket=this.basket!;
    if(this.fast.episode)return;// the fast lane owns bursts
    const scores=this.scoreMap(now);
    const busy=new Set([...ctx.forward.positions.map(p=>p.symbol),...this.trades.watches.map(w=>w.symbol)]);
    type Act={pb:IntentPlaybook;side:"LONG"|"SHORT";strength:number;why:string};
    const cands:{ci:CoinIntent;act:Act;rank:number;score:number;mult:number;why1:string;env:string}[]=[];
    // v3: the coin env picks the playbook family, the market env decides the side and the size (replaces the L1 MIXED half size)
    for(const s of basket.members){
      const ci=this.coins.get(s);if(!ci)continue;this.logCount(now,"reads");
      const env=this.envs.get(s)??null,tag=envTag(env,this.menv);
      let a:Act|null=null,d:EnvDecision|null=null;
      const miss=(x:Act,dd:EnvDecision)=>{this.logCase(now,s,x.side,x.pb,dd.layer,dd.why,"normal",x.why);
        this.noteOnce(`env|${s}|${x.pb}|${x.side}|${tag}`,now,"RECORD_ONLY",{sym:s,side:x.side,pb:x.pb,intent:`${ci.capital}/${ci.emotion}`,env:tag,reason:`没开：${dd.why.slice(0,120)}`});};
      if(ci.action){this.logCount(now,"ideas");const dd=envDecide(env,this.menv,ci.action.pb,ci.action.side);if(dd.ok){a=ci.action;d=dd;}else miss(ci.action,dd);}
      if(!a&&env){
        const st=envSetup(env,this.tape.closed5(s,now),ci.capital);
        if(st){if(!ci.action)this.logCount(now,"ideas");const dd=envDecide(env,this.menv,st.pb,st.side);if(dd.ok){a=st;d=dd;}else miss(st,dd);}
        else if(!ci.action)this.logCount(now,"no_idea",env.state==="UNCLEAR"||env.state==="WARMING"?`环境${ENV_LABEL[env.state]}`:noTradeReason(ci));
      }else if(!a&&!ci.action)this.logCount(now,"no_idea",noTradeReason(ci));
      if(!a||!d)continue;
      // the market intent's hard states still block: PANIC (no knife catching / no selling into panic), WARMING (flow not readable)
      if(m.state==="PANIC"||m.state==="WARMING"){const why=`第一层：${m.sentence.slice(0,100)}`;this.logCase(now,s,a.side,a.pb,"L1_MARKET",why);
        this.noteOnce(`l1|${s}|${a.pb}|${a.side}|${m.state}`,now,"RECORD_ONLY",{sym:s,side:a.side,pb:a.pb,intent:`${ci.capital}/${ci.emotion}`,reason:`没开：${why}`});continue;}
      this.logCount(now,"ENV_PICK",`${env?.state??"-"}:${a.pb}`);
      const mod=sizeModulator(scores[PLAYBOOK_PROBE[a.pb]]);
      cands.push({ci,act:a,rank:0,score:a.strength*(.85+.15*mod),mult:d.mult,why1:d.why,
        env:`${d.why}｜${envHead(env?.sentence)}｜${envHead(this.menv?.sentence)}`.slice(0,260)});
    }
    cands.sort((x,y)=>y.score-x.score);
    const used:string[]=[];let rank=0;
    for(const c of cands){
      const s=c.ci.symbol,a=c.act;
      if(rank>=STEPS.selectTop){this.logCount(now,"RANK",null,cands.length-cands.indexOf(c));break;}
      const why=this.hardFilter(ctx,s,items);
      if(why){this.logCase(now,s,a.side,a.pb,"FILTER",why);this.noteOnce(`hf|${s}|${a.pb}`,now,"RECORD_ONLY",{sym:s,side:a.side,pb:a.pb,reason:why});continue;}
      const cl=this.clusterOf(s,used);if(used.includes(cl)&&cl!==s){this.logCase(now,s,a.side,a.pb,"CLUSTER",`和 ${cl} 走势高度相关`);this.noteOnce(`cl|${s}|${a.pb}|${Math.floor(now/900_000)}`,now,"RECORD_ONLY",{sym:s,side:a.side,pb:a.pb,reason:`和 ${cl} 走势高度相关，只留一个`});continue;}
      used.push(s);rank++;
      if(a.strength<.35){this.logCase(now,s,a.side,a.pb,"L2_WEAK",`证据强度 ${a.strength.toFixed(2)}<0.35`);this.noteOnce(`st|${s}|${a.pb}|${Math.floor(now/900_000)}`,now,"RECORD_ONLY",{sym:s,side:a.side,pb:a.pb,reason:`第二层：这个币的证据不够强（${a.strength.toFixed(2)}<0.35）`});continue;}
      if(busy.has(s)){this.logCount(now,"BUSY","已有持仓或在等位置");continue;}
      if(a.pb==="follow"&&followAtEdge(a.side,c.ci.f.rangePos)){const why=`顺势不追在区间${a.side==="LONG"?"顶部":"底部"}（4 小时区间位置 ${((c.ci.f.rangePos??0)*100).toFixed(0)}%）`;
        this.logCase(now,s,a.side,a.pb,"FOLLOW_EDGE",why);this.noteOnce(`fe|${s}|${a.side}|${Math.floor(now/900_000)}`,now,"RECORD_ONLY",{sym:s,side:a.side,pb:a.pb,reason:why});continue;}
      const cool=stopCooldown(ctx.forward.history,s,a.pb,now);
      if(cool){this.logCase(now,s,a.side,a.pb,"COOLDOWN",cool);this.noteOnce(`cd|${s}|${a.pb}`,now,"RECORD_ONLY",{sym:s,side:a.side,pb:a.pb,reason:cool});continue;}
      const plan=planIntent(a.pb,a.side,c.ci,this.tape.closed5(s,now),this.tape.closed1(s,now));
      if(!plan){this.logCase(now,s,a.side,a.pb,"NO_LOCATION","找不到合理的位置");this.noteOnce(`pl|${s}|${a.pb}`,now,"RECORD_ONLY",{sym:s,side:a.side,pb:a.pb,reason:"找不到合理的位置"});continue;}
      const mid=(plan.lo+plan.hi)/2,ct=ctx.contracts[s];
      const chk=stopCheck({side:a.side,price:mid,stop:plan.inv,min:STEPS.stopMin,max:STEPS.stopMax,leverageMax:ct?.leverageMax??10,mmr:ct?.maintenanceRate??null,liqSafety:items.liqSafety});
      if(!chk.ok){this.logCase(now,s,a.side,a.pb,"RISK",chk.reason);this.noteOnce(`sc|${s}|${a.pb}`,now,"RECORD_ONLY",{sym:s,side:a.side,pb:a.pb,reason:chk.reason});continue;}
      const cand={symbol:s,side:a.side,playbook:a.pb,probe:PLAYBOOK_PROBE[a.pb],score:r4(c.score),rank,factors:{eff:0,fit:0,early:0,funding:0,edge:0},
        trigger:{probe:PLAYBOOK_PROBE[a.pb],symbol:s,side:a.side,strength:a.strength,ref:plan.ref},reject:null};
      const w=newWatch(cand,{lo:plan.lo,hi:plan.hi,inv:chk.stop,target:plan.target},now,plan.hold,{l1:true,l2:true,probeSize:false,why1:c.why1,why2:a.why});
      w.intent={state:`${c.ci.capital}/${c.ci.emotion}`,market:m.state,why:a.why.slice(0,200),ev:evidenceLine(c.ci.f).slice(0,200),strength:a.strength,...(c.mult<1?{mult:c.mult}:{}),env:c.env};
      this.trades.watches.push(w);busy.add(s);this.logCase(now,s,a.side,a.pb,"WATCH",`等 ${r6(w.zoneLo)}–${r6(w.zoneHi)}，失效 ${r6(w.invalidation)}`);
      this.note(now,"WATCH",{sym:s,side:a.side,pb:a.pb,rank,score:r4(c.score),lo:w.zoneLo,hi:w.zoneHi,inv:w.invalidation,intent:w.intent.state,market:m.state,env:envTag(this.envs.get(s),this.menv),mult:c.mult,why:a.why.slice(0,160)});
    }
    if(this.trades.watches.length>12)this.trades.watches.splice(0,this.trades.watches.length-12);
  }
  private hardFilter(ctx:PlanContext,s:string,items:LivingItems){
    const meta=this.tape.meta.get(s),mmr=ctx.contracts[s]?.maintenanceRate??null;
    if((meta?.volume24hUsd??0)<STEPS.selectVolume)return`成交额 ${((meta?.volume24hUsd??0)/1e6).toFixed(0)}M<20M`;
    if(meta&&meta.spread>STEPS.selectSpread)return`价差 ${(meta.spread*1e4).toFixed(1)}bp>${(STEPS.selectSpread*1e4).toFixed(0)}bp`;
    if(items.liqSafety&&(mmr==null||mmr>STEPS.selectMmr))return`维持保证金率 ${mmr==null?"未知":(mmr*100).toFixed(1)+"%"}>2%`;
    return null;
  }
  /** v2 step 5 for open living trades: is the reason to hold still there? (normal trades and handed-off fast trades) */
  private intentHolds(views:PositionView[],now:number):LivingTradeAction[]{
    const out:LivingTradeAction[]=[],handed=new Set(this.trades.handedOff),seen=new Set<string>();
    for(const p of views){
      const n=p.living;if(!n||p.price==null)continue;
      const v2=n.v==="living-v2";if(!v2)continue;
      if(n.hx){seen.add(p.id);continue;}// htf-donch20: only its stop / daily trail (htfStep) — no intent / lock / dynamic exits
      if(n.bh){
        // burst-leader-v1: stop + breakeven after +0.8% + 70% trail from +1.5% + 4 hours; nothing else closes it
        seen.add(p.id);
        const stop=p.guard!=null?(p.side==="LONG"?Math.max(p.stopPrice,p.guard):Math.min(p.stopPrice,p.guard)):p.stopPrice;
        const v=leaderHold({side:p.side,entry:p.entryPrice,price:p.price,peak:p.favorable??0,ageMin:(now-p.openedAt)/60_000,stop});
        try{this.runlog.holdRead(p.id,now,p.openedAt,{coin:null,h:null,market:this.marketIntent?.state??null,code:v.code,env:envTag(this.envs.get(p.symbol),this.menv)});}catch{/* 只是记录 */}
        if(v.act!=="HOLD"){const prev=this.holds.get(p.id);if(!prev||prev.why!==v.why)this.holds.set(p.id,{why:v.why,code:v.code,at:now});}
        if(v.act==="EXIT")out.push({tradeId:p.id,action:"EXIT",code:v.code,reason:v.why.slice(0,160)});
        else if(v.act==="GUARD"&&v.stop!=null)out.push({tradeId:p.id,action:"GUARD",stop:r6(v.stop),code:v.code,reason:v.why.slice(0,160)});
        continue;
      }
      if(n.k==="F"&&!handed.has(p.id))continue;
      seen.add(p.id);
      const pb=(n.k==="F"?"follow":n.pb) as IntentPlaybook;
      const coin=this.coins.get(p.symbol)??(this.basket?readCoin(p.symbol,features(this.tape,this.flow,p.symbol,now),now,this.coinHist.get(p.symbol)??[]):null);
      const stop=p.guard!=null?(p.side==="LONG"?Math.max(p.stopPrice,p.guard):Math.min(p.stopPrice,p.guard)):p.stopPrice;
      const stopDist=n.inv>0&&p.entryPrice>0?Math.abs(n.inv/p.entryPrice-1):null;
      // brain exits first (market flip, intent gone, climax take, targets, locks); time is owned by the dynamic rules below
      let v:{act:"HOLD"|"EXIT"|"GUARD";code:string;why:string;stop?:number}=holdCheck({pb,side:p.side,entry:p.entryPrice,price:p.price,stop,coin,market:this.marketIntent,ageMin:(now-p.openedAt)/60_000,holdMin:0,cost:STEPS.cost,stopDist,target:typeof n.tg==="number"?n.tg:null});
      const h=healthOf(p.side,coin,this.marketIntent);
      if(v.act!=="EXIT"){
        let st=this.dyn.get(p.id);if(!st){st={revN:0,lastMin:0};this.dyn.set(p.id,st);}
        const dv=dynHold({side:p.side,entry:p.entryPrice,price:p.price,peak:p.favorable??0,trough:p.adverse??0,ageMin:(now-p.openedAt)/60_000,holdMin:n.hold,
          a:volUnit(this.tape.closed1(p.symbol,now).slice(-16).map(r=>r.close)),h,now},st);
        if(dv.act==="EXIT")v={act:"EXIT",code:dv.code,why:dv.why};
        else if(v.act==="HOLD"&&dv.extended)v={act:"HOLD",code:dv.code,why:dv.why};
      }
      try{this.runlog.holdRead(p.id,now,p.openedAt,{coin,h,market:this.marketIntent?.state??null,code:v.act==="HOLD"?v.code:v.code,env:envTag(this.envs.get(p.symbol),this.menv)});}catch{/* 只是记录 */}
      const prev=this.holds.get(p.id);
      if(!prev||prev.why!==v.why){this.holds.set(p.id,{why:v.why,code:v.code,at:now});if(v.act==="HOLD")this.note(now,"HOLD_CHANGE",{trade:p.id,sym:p.symbol,why:v.why.slice(0,160)});}
      if(v.act==="EXIT")out.push({tradeId:p.id,action:"EXIT",code:v.code,reason:v.why.slice(0,160)});
      else if(v.act==="GUARD"&&v.stop!=null)out.push({tradeId:p.id,action:"GUARD",stop:r6(v.stop),code:v.code,reason:v.why.slice(0,160)});
    }
    for(const id of [...this.holds.keys()])if(!seen.has(id))this.holds.delete(id);
    for(const id of [...this.dyn.keys()])if(!seen.has(id))this.dyn.delete(id);
    return out;
  }
  private normalOrder(ctx:PlanContext,w:Watch,scores:Record<ProbeId,ProbeScore>,items:LivingItems):LivingOrder|string{
    if(w.intent)return this.intentOrder(ctx,w,scores,items);
    const last=this.tape.last(w.symbol);if(!last)return"没有新鲜报价";
    const score=scores[PLAYBOOK_PROBE[w.playbook]];
    const l1=layerOne(score);if(!l1.ok)return`研究层没开：${l1.why}`;
    const th=this.thesis.current;
    if(!th||!th.playbooks.some(p=>p.pb===w.playbook))return"研究层没开：等位置期间判断变了，不再支持这个打法";
    const ct=ctx.contracts[w.symbol];
    const chk=stopCheck({side:w.side,price:last.mid,stop:w.invalidation,min:STEPS.stopMin,max:STEPS.stopMax,leverageMax:ct?.leverageMax??10,mmr:ct?.maintenanceRate??null,liqSafety:items.liqSafety});
    if(!chk.ok)return chk.reason;
    const ev=evidenceFactor(score,l1.probeSize,this.trades.liveNet[w.playbook]??[]);
    const premium=w.selectScore>=.8&&score.t>=3;
    const risk=normalRisk({premium,evidence:ev.factor,sizingItem:items.sizing});
    const why=`${PLAYBOOK_LABEL[w.playbook]}：${th.sentence.slice(0,90)}；选币第 ${w.rank}（${w.selectScore.toFixed(2)}）；${l1.why}；位置到了且确认`;
    const note:LivingNote={v:"living-v1",k:"N",pb:w.playbook,th:th.id,ep:null,ev:ev.label,mult:r4(risk.multiple),sc:score.score,t:score.t,n:score.n,
      per:score.persistence,rk:w.rank,inv:chk.stop,ref:w.ref,hold:w.holdMin,why:why.slice(0,200)};
    return {id:w.id,symbol:w.symbol,side:w.side,stop:chk.stop,riskRate:risk.riskRate,multiple:risk.multiple,kind:"N",episodeId:null,episodeCap:null,
      winner:true,note,reason:why};
  }
  /** v2 order at READY: layers 1 and 2 re-read live (the market or the coin may have changed while waiting). */
  private intentOrder(ctx:PlanContext,w:Watch,scores:Record<ProbeId,ProbeScore>,items:LivingItems):LivingOrder|string{
    const last=this.tape.last(w.symbol);if(!last)return"没有新鲜报价";
    const pb=w.playbook as IntentPlaybook,m=this.marketIntent;
    let lm:number,envNote:string|undefined;
    if(w.intent!.env){
      // v3 watch: re-read the env. A clearly-against market or a coin env that now points the other way cancels; a coin env that
      // merely went unclear keeps the size chosen at the watch.
      if(!m||m.state==="PANIC"||m.state==="WARMING")return`等位置期间市场意图变了：${(m?.sentence??"还没有市场意图").slice(0,100)}`;
      const env=this.envs.get(w.symbol)??null,dd=envDecide(env,this.menv,pb,w.side);
      if(!dd.ok&&(dd.layer==="L1_MARKET"||(env?.side!=null&&env.side!==w.side)))return`等位置期间环境变了：${dd.why.slice(0,100)}`;
      lm=dd.ok?dd.mult:w.intent!.mult??1;envNote=dd.ok?`${dd.why}｜${envHead(env?.sentence)}｜${envHead(this.menv?.sentence)}`.slice(0,260):w.intent!.env;
    }else{
      const l1=marketSizing(m,pb,w.side);if(!l1.ok)return`等位置期间市场意图变了：${l1.why.slice(0,100)}`;lm=l1.mult;
    }
    const ci=this.coins.get(w.symbol);
    if(!ci||!ci.action||ci.action.pb!==pb||ci.action.side!==w.side){
      // the setup emotion may have moved on (e.g. capitulation → rebound under way); keep it only if nothing contradicts
      const contra=ci&&(w.side==="LONG"?ci.capital==="SUPPLY"||ci.capital==="FLUSH_DOWN":ci.capital==="DEMAND"||ci.capital==="SQUEEZE_UP");
      if(contra)return`第二层：等位置期间这个币的资金反了（${ci!.why.slice(0,80)}）`;
    }
    const ct=ctx.contracts[w.symbol];
    const chk=stopCheck({side:w.side,price:last.mid,stop:w.invalidation,min:STEPS.stopMin,max:STEPS.stopMax,leverageMax:ct?.leverageMax??10,mmr:ct?.maintenanceRate??null,liqSafety:items.liqSafety});
    if(!chk.ok)return chk.reason;
    const strength=w.intent!.strength,ev=intentEvidence(strength,m!.confidence),mod=items.sizing?sizeModulator(scores[PLAYBOOK_PROBE[pb]]):1;
    const risk=normalRisk({premium:ev.label==="strong"&&w.rank===1&&lm>=1,evidence:ev.factor*mod*lm,sizingItem:items.sizing});
    const why=envNote?`${PLAYBOOK_LABEL[pb]}：${w.intent!.why.slice(0,110)}；${envNote.split("｜")[0]!.slice(0,70)}；位置到了且确认`
      :`${lm<1?`市场方向不清，半仓（${lm}×）·`:""}${PLAYBOOK_LABEL[pb]}：${w.intent!.why.slice(0,110)}；位置到了且确认`;
    const note:LivingNote={v:"living-v2",k:"N",pb,...(lm<1?{lm}:{}),...(envNote?{env:envNote}:{}),...(pb==="sweep-reclaim"&&w.target!=null?{tg:r6(w.target)}:{}),th:this.thesis.current?.id??null,ep:null,ev:ev.label,mult:r4(risk.multiple),sc:r4(strength),t:null,n:null,
      per:mod===1?null:`x${mod}`,rk:w.rank,inv:chk.stop,ref:w.ref,hold:w.holdMin,why:why.slice(0,200),
      in:w.intent!.state,mk:m!.state,nar:`${m!.sentence.slice(0,80)}｜${w.intent!.why.slice(0,100)}`,evd:w.intent!.ev.slice(0,160)};
    return {id:w.id,symbol:w.symbol,side:w.side,stop:chk.stop,riskRate:risk.riskRate,multiple:risk.multiple,kind:"N",episodeId:null,episodeCap:null,
      winner:true,note,reason:why};
  }
  private fastOrders(ctx:PlanContext,items:LivingItems):LivingOrder[]{
    const ep=this.fast.episode,now=ctx.now;if(!ep||ep.phase!=="CONFIRMED"||ep.confirmAt==null||!this.basket)return[];
    if(ep.flow&&ep.flow.kind!=="NEW_POSITIONS"&&ep.flow.kind!=="VOLUME"&&ep.flow.kind!=="UNKNOWN"){
      const why=ep.flow.kind==="SQUEEZE"?"这一段是空头被逼回补（持仓量在降），不是新买盘：不追，等衰竭后反做"
        :ep.flow.kind==="FLUSH"?"这一段是多头踩踏（持仓量在降）：不追空，等恐慌出尽再抄反弹"
        :"价格很猛但资金数据没跟上：只做保护，不跟";
      if(this.noteOnce(`ff|${ep.id}`,now,"RECORD_ONLY",{pb:"fast",side:ep.side,ep:ep.id,reason:why}))this.logCount(now,"FAST_FLOW_BLOCK",why);return[];
    }
    if(now-ep.confirmAt>FAST.followWindowMs)return[];
    if(fastFollowBlocked(this.fast,ep.side,now))return[];
    const used=this.trades.fastEntries[ep.id]??0;if(used>=FAST.followMax)return[];
    const virt=[...this.virtualFast].filter(k=>k.startsWith(ep.id+"|")).map(k=>k.slice(ep.id.length+1));
    const already=[...ctx.forward.positions.map(p=>p.symbol),...virt],
      usedClusters=[...ctx.forward.positions.filter(p=>p.entryContext?.living?.ep===ep.id).map(p=>p.symbol),...virt];
    this.clusterUsed=usedClusters;
    const z60=d(ep.side)*(this.lastZ60(now)??0);
    const p8=this.leadersPreferred();
    const {picks,skipped}=fastFollowPicks({ep,tape:this.tape,now,members:this.basket.members,already,
      mmr:s=>ctx.contracts[s]?.maintenanceRate??null,volume:s=>this.tape.meta.get(s)?.volume24hUsd??0,spread:s=>this.tape.meta.get(s)?.spread??null,
      z60,leadersPreferred:p8,clusterOf:s=>this.clusterOf(s),usedClusters});
    for(const s of skipped.slice(0,3))if(this.noteOnce(`f|${ep.id}|${s.symbol}`,now,"RECORD_ONLY",{sym:s.symbol,side:ep.side,pb:"fast",reason:s.why}))
      this.logCase(now,s.symbol,ep.side,"fast","FAST_SKIP",s.why,"fast",`集体异动${ep.side==="LONG"?"普涨":"普跌"}：${ep.flow?.why??"资金未验证"}`);
    const out:LivingOrder[]=[];
    for(const p of picks){
      const last=this.tape.last(p.symbol);if(!last)continue;const ct=ctx.contracts[p.symbol];
      const chk=stopCheck({side:p.side,price:last.mid,stop:p.stop,min:FAST.stopMin,max:FAST.stopMax,leverageMax:ct?.leverageMax??10,mmr:ct?.maintenanceRate??null,liqSafety:true});
      if(!chk.ok){if(this.noteOnce(`f|${ep.id}|${p.symbol}`,now,"RECORD_ONLY",{sym:p.symbol,side:p.side,pb:"fast",reason:chk.reason}))this.logCase(now,p.symbol,p.side,"fast","RISK",chk.reason,"fast");continue;}
      const mult=items.sizing?fastMultiple(this.episodes,bucketOf(ep.peakZ)):1,risk=fastRisk({fastMultiple:mult,probe:p.mode==="PROBE"});
      if(!this.once.has(`fp|${ep.id}|${p.symbol}`)){this.once.add(`fp|${ep.id}|${p.symbol}`);this.logCase(now,p.symbol,p.side,"fast","FAST_PICK",p.why,"fast");}
      const why=`集体异动${ep.side==="LONG"?"普涨":"普跌"}确认后跟进（${p.mode==="PROBE"?"试探 1/3":"回调后再创新"}，${ep.flow?.kind==="NEW_POSITIONS"?"新开仓推动":ep.flow?.kind==="VOLUME"?"放量推动":"资金未验证"}）：${p.why}`;
      out.push({id:`lf-${ep.id}-${p.symbol}`,symbol:p.symbol,side:p.side,stop:chk.stop,riskRate:risk.riskRate,multiple:risk.multiple,kind:"F",episodeId:ep.id,
        episodeCap:SIZING.episodeRiskCap,winner:true,reason:why,
        note:{v:"living-v2",k:"F",pb:"fast",th:this.thesis.current?.id??null,ep:ep.id,ev:"fast",mult:r4(risk.multiple),sc:null,t:null,n:null,per:null,rk:null,
          inv:chk.stop,ref:null,hold:30,why:why.slice(0,200),in:`BURST/${ep.flow?.kind??"UNKNOWN"}`,mk:this.marketIntent?.state??"WARMING",
          nar:`全市场集体${ep.side==="LONG"?"上涨":"下跌"}：${ep.flow?.why??"资金数据未到"}`.slice(0,180),evd:(ep.flow?.why??"").slice(0,160)}});
    }
    return out;
  }
  private lastBurstMinute=0;
  /**
   * burst-leader-v1. Once a minute (on the last closed 1m bar): the special-condition check, logged whatever the verdict (timeline
   * bucket `burst`; a BURST_CHECK row when anything but NONE/WARMING). On TRIGGER the side is locked for 3 hours and the ranking runs on
   * the bar 2 minutes later (BURST_RANK row with the top rows and why each other coin was not picked) → up to 3 orders, 1.5% risk each.
   */
  private burstOrders(ctx:PlanContext,items:LivingItems):LivingOrder[]{
    const now=ctx.now,mk=Math.floor((now-3_000)/60_000);if(mk===this.lastBurstMinute||!this.basket)return[];this.lastBurstMinute=mk;
    const out:LivingOrder[]=[];
    try{
      const bar=(mk-1)*60,st=(this.trades.bl??={last:{LONG:0,SHORT:0},pending:null});
      const alts=this.basket.members.filter(s=>s!=="BTC_USDT"&&s!=="ETH_USDT");
      const c=closesOf(s=>this.tape.closed1(s,now),alts,bar-(LEADER.sigmaMin+LEADER.quietMin+LEADER.win+2)*60);
      const open=ctx.forward.positions.filter(p=>p.entryContext?.living?.bh).length;
      const p=st.pending;
      if(p&&bar>=p.bar+LEADER.enterAfterMin*60){
        st.pending=null;
        const originBar=p.bar-LEADER.win*60,nowBar=p.bar+LEADER.enterAfterMin*60;
        if(bar>nowBar+120){this.note(now,"BURST_RANK",{ep:p.id,side:p.side,reason:"选币时间已过（程序停过），这一段不做"});}
        else{
          const busy=new Set(ctx.forward.positions.map(x=>x.symbol)),top=Math.max(0,Math.min(LEADER.top,LEADER.maxOpen-open));
          const r=rankLeaders({side:p.side,alts,c,originBar,nowBar,vol6:s=>vol6Of(this.tape.closed1(s,now),originBar),volume:s=>this.tape.meta.get(s)?.volume24hUsd??0,
            filter:s=>this.hardFilter(ctx,s,items),skip:s=>busy.has(s)?"已有持仓":null,top});
          const pc=(v:number|null)=>v==null?"-":`${v>=0?"+":""}${(v*100).toFixed(2)}`;
          const rows=r.rows.slice(0,10).map(x=>`${x.sym.replace("_USDT","")} rs${pc(x.rs)} v${x.vol6==null?"-":(x.vol6*100).toFixed(3)} ${Math.round(x.liq/1e6)}M ${x.ok?`#${x.rank}`:x.why.slice(0,24)}`).join("｜");
          const text=`${p.side==="LONG"?"做多":"做空"}爆发 ${p.id}：一篮子从起点 ${pc(r.basket)}%，${r.rows.filter(x=>x.ok).length} 个合格，选 ${r.picks.map(x=>x.sym.replace("_USDT","")).join("/")||"无"}${top<LEADER.top?`（已持有 ${open} 笔爆发单，最多 ${LEADER.maxOpen}）`:""}`;
          this.note(now,"BURST_RANK",{ep:p.id,side:p.side,basket:r.basket==null?null:r6(r.basket),eligible:r.rows.filter(x=>x.ok).length,picks:r.picks.map(x=>x.sym).join(","),top:rows.slice(0,900),reason:text.slice(0,200)});
          try{this.runlog.event(now,"BURST_RANK",text);}catch{/* 只是记录 */}
          const why0=`集体异动${p.side==="LONG"?"普涨":"普跌"}：${p.why}`.slice(0,160);
          for(const x of r.rows.slice(0,8))if(!r.picks.includes(x)&&x.rs!=null&&x.rs>0)
            this.logCase(now,x.sym,p.side,LEADER.pb,"FAST_SKIP",x.ok?`排第 ${x.rank}，只取前 ${top}`:x.why,"fast",why0);
          for(const x of r.picks){
            const last=this.tape.last(x.sym),origin=c.get(x.sym)?.get(originBar);if(!last||!origin)continue;
            const ls=leaderStop(p.side,last.mid,origin),ct=ctx.contracts[x.sym];
            const chk=stopCheck({side:p.side,price:last.mid,stop:ls.stop,min:LEADER.stopMin*.999,max:LEADER.stopMax*1.001,leverageMax:ct?.leverageMax??10,mmr:ct?.maintenanceRate??null,liqSafety:true});
            if(!chk.ok){this.logCase(now,x.sym,p.side,LEADER.pb,"RISK",chk.reason,"fast",why0);continue;}
            const why=`爆发选币第 ${x.rank}：从起点跑赢一篮子 ${pc(x.rs)}%，6 小时波动 ${((x.vol6??0)*100).toFixed(3)}%/分钟；止损在起点外 ${(chk.rate*100).toFixed(2)}%，风险 1.5%；${p.why}`;
            this.logCase(now,x.sym,p.side,LEADER.pb,"FAST_PICK",why.slice(0,70),"fast",why0);
            out.push({id:`lb-${p.id}-${x.sym}`,symbol:x.sym,side:p.side,stop:chk.stop,riskRate:LEADER.riskRate,multiple:1,kind:"F",episodeId:p.id,
              episodeCap:LEADER.episodeCap,winner:true,reason:why.slice(0,240),
              note:{v:"living-v2",k:"F",pb:LEADER.pb,th:null,ep:p.id,ev:"fast",mult:1,sc:x.score,t:null,n:null,per:null,rk:x.rank,inv:chk.stop,ref:origin,
                hold:LEADER.maxHoldMin,bh:1,why:why.slice(0,200),in:`BURST/${p.side}`,mk:this.marketIntent?.state??"WARMING",nar:p.why.slice(0,180),
                evd:`z ${p.z.toFixed(1)}｜rs ${pc(x.rs)}%｜vol6 ${((x.vol6??0)*100).toFixed(3)}%｜24h ${Math.round(x.liq/1e6)}M`}});
          }
        }
      }
      let chk=burstCheck(c,alts,bar,st.last);
      if(chk.verdict==="TRIGGER"&&(open>=LEADER.maxOpen||st.pending))chk={...chk,verdict:"BUSY",why:`${chk.why}；但爆发单已有 ${open} 笔（最多 ${LEADER.maxOpen}）`};
      try{this.runlog.burstCheck(now,chk);}catch{/* 只是记录 */}
      if(chk.verdict!=="NONE"&&chk.verdict!=="WARMING")
        this.note(now,chk.verdict==="TRIGGER"?"BURST_ONSET":"BURST_CHECK",{bar:chk.bar,side:chk.side,z:chk.z==null?null:r4(chk.z),breadth:chk.breadth==null?null:r4(chk.breadth),
          b3:chk.b3==null?null:r6(chk.b3),n:chk.n,verdict:chk.verdict,reason:chk.why.slice(0,200)});
      if(chk.verdict==="TRIGGER"&&chk.side){
        const id=`bl-${chk.bar.toString(36)}-${chk.side[0]}`;st.last={...st.last,[chk.side]:chk.bar};st.pending={id,side:chk.side,bar:chk.bar,z:chk.z!,why:chk.why};
        try{this.runlog.event(now,"BURST_ONSET",chk.why);}catch{/* 只是记录 */}
      }
      this.dirty.add(LIVING_KEYS.trades);
    }catch(error){this.lastError=String((error as Error)?.message??error).slice(0,200);this.note(now,"BURST_CHECK",{verdict:"ERROR",reason:this.lastError});}
    return out;
  }
  // ------------------------------------------------------------------ htf-donch20 (daily trend breakout, rulebook rule 1)
  /**
   * Every plan(): (1) the daily trail of open htf trades: max(initial stop, lowest low of the last 10 closed days) → GUARD (only
   * tighter) or EXIT when the live price is already below it; (2) once per UTC day, ≥2 minutes after 00:00 and once BTC's and ≥80%
   * of the universe's daily candles for yesterday are in (or 45 minutes passed): the check → HTF_CHECK row + timeline `htf` +
   * picks kept as pending; (3) pending picks → orders while their entry window lasts (only when acting and switch 9 is on).
   * Reads only what the worker passed (stored daily candles, hub volume, live quotes): no request. Never throws.
   */
  private htfStep(ctx:PlanContext,views:PositionView[],items:LivingItems,acting:boolean):{actions:LivingTradeAction[];orders:LivingOrder[]}{
    const out={actions:[] as LivingTradeAction[],orders:[] as LivingOrder[]},h=ctx.htf,now=ctx.now;if(!h)return out;
    try{
      const day=dayKey(now),minOfDay=(now-dayStartSec(now)*1000)/60_000,mk=this.marketIntent?.state??null;
      // (1) trail
      for(const p of views){
        const n=p.living;if(!n?.hx||p.side!=="LONG")continue;
        const rows=closedDaily(h.daily[p.symbol],now),cur=p.guard!=null?Math.max(p.stopPrice,p.guard):p.stopPrice;
        const lvl=htfExitLevel(n.inv,rows,p.openedAt/1000,cur),low10=trailLow(rows);
        const why=`日线突破单：止损 ${fx(cur)}（初始 ${fx(n.inv)}${low10!=null?`，近 10 日最低 ${fx(low10)}`:""}），每天收盘后只上移不下移，没有时间限制`;
        const prev=this.holds.get(p.id);if(!prev||prev.why!==why)this.holds.set(p.id,{why,code:"HTF_HOLD",at:now});
        try{this.runlog.holdRead(p.id,now,p.openedAt,{coin:null,h:null,market:mk,code:"HTF_HOLD",env:null});}catch{/* 只是记录 */}
        if(rows.length&&!freshThrough(rows,now)&&minOfDay>=HTF.waitFullMin)
          this.noteOnce(`htw|${p.id}|${day}`,now,"HTF_TRAIL_WAIT",{trade:p.id,sym:p.symbol,stop:r6(cur),reason:`${p.symbol} 昨天的日线还没拿到，止损先不动`});
        if(!(lvl>cur*(1+1e-9))||p.price==null)continue;
        const above=p.price>lvl,code=above?"LIVING_HTF_TRAIL":"LIVING_HTF_TRAIL_EXIT";
        const reason=above?`日线收盘后：10 日最低 ${fx(low10??lvl)}，止损从 ${fx(cur)} 上移到 ${fx(lvl)}`:`日线收盘后：止损上移到 ${fx(lvl)}，现价 ${fx(p.price)} 已在下方，平掉`;
        out.actions.push(above?{tradeId:p.id,action:"GUARD",stop:r6(lvl),code,reason,detail:{from:r6(cur),to:r6(lvl),low10:low10==null?null:r6(low10)}}
          :{tradeId:p.id,action:"EXIT",code,reason,detail:{level:r6(lvl),price:r6(p.price)}});
        if(this.noteOnce(`ht|${p.id}|${r6(lvl)}`,now,"HTF_TRAIL",{trade:p.id,sym:p.symbol,from:r6(cur),to:r6(lvl),low10:low10==null?null:r6(low10),px:r6(p.price),
          act:acting?(above?"GUARD":"EXIT"):"RECORD",reason:acting?reason:`只计算/降级中，没执行：${reason}`}))
          try{this.runlog.event(now,"HTF_TRAIL",`${p.symbol.replace("_USDT","")} ${reason}`);}catch{/* 只是记录 */}
      }
      // (2) the daily check
      const st=(this.trades.hx??={day:"",pending:[],last:null});
      st.pending=st.pending.filter(x=>{if(x.until>now)return true;
        this.note(now,"HTF_EXPIRE",{sym:x.sym,day:x.day,order:x.id,reason:`入场窗口过了还没开出（${!acting?"研究层没在执行":!items.htfTrend?"开关 9 关着":"没有 Gate 实时盘口或被拒"}），今天不做`});
        this.logCase(now,x.sym,"LONG",HTF.pb,"NO_QUOTE","入场窗口内没开出");return false;});
      if(st.day!==day&&minOfDay>=HTF.checkAfterMin){
        const btc=closedDaily(h.daily.BTC_USDT,now),btcOk=freshThrough(btc,now);
        const coins=h.universe.map(sym=>({sym,rows:closedDaily(h.daily[sym],now),vol:h.volume[sym]??null}));
        const fresh=coins.filter(c=>freshThrough(c.rows,now)).length,cover=coins.length?fresh/coins.length:0;
        if((!btcOk&&minOfDay<HTF.btcDeadlineMin)||(cover<HTF.coverage&&minOfDay<HTF.waitFullMin)){
          const w=`BTC 昨天的日线${btcOk?"已到":"还没到"}，${fresh}/${coins.length} 个币有昨天的日线（要 ${Math.round(HTF.coverage*100)}%）`;
          if(this.noteOnce(`hw|${day}|${btcOk?1:0}|${cover>=HTF.coverage?1:0}`,now,"HTF_WAIT",{day,fresh,universe:coins.length,btc:btcOk,reason:`日线突破做多：等数据，${w}`}))
            try{this.runlog.htfCheck(now,`WAIT ${day} ${hhmm(now)} ${w}`);}catch{/* 只是记录 */}
        }else this.htfCheck(ctx,st,day,btc,coins,h.notExternal,minOfDay);
      }
      // (3) pending → orders
      const busy=new Set(ctx.forward.positions.filter(p=>!p.inverseCopy).map(p=>p.symbol));
      let open=ctx.forward.positions.filter(p=>!p.inverseCopy&&p.entryContext?.living?.hx).length;
      for(const x of [...st.pending]){
        if(busy.has(x.sym)){st.pending=st.pending.filter(y=>y.id!==x.id);
          if(!ctx.forward.positions.some(p=>p.symbol===x.sym&&p.entryContext?.living?.hx&&p.entryContext.living.dy===x.day))
            this.note(now,"HTF_SKIP",{sym:x.sym,day:x.day,reason:"这个币已有持仓（一币一笔），今天的突破不做"});
          continue;}
        if(!acting||!items.htfTrend){this.noteOnce(`hs|${x.id}|${acting?1:0}`,now,"RECORD_ONLY",{sym:x.sym,side:"LONG",pb:HTF.pb,
          reason:!acting?"日线突破做多选中，但研究层现在只计算/降级，先等（入场窗口内恢复就开）":"日线突破做多选中，但开关 9 关着，只记录"});continue;}
        if(open>=HTF.maxOpen){this.noteOnce(`hm|${x.id}`,now,"HTF_SKIP",{sym:x.sym,day:x.day,reason:`日线突破单已有 ${open} 笔，最多 ${HTF.maxOpen}`});continue;}
        const q=ctx.quotes[x.sym],px=q&&q.bestAsk>0&&now-q.observedAt<=10_000?q.bestAsk:this.tape.last(x.sym)?.mid??null;
        if(px==null||!(px>0))continue;// no price at all: the exec filter would only log the same miss
        const z=htfOrder(px,x.atr,1);if(!z||!(z.stop>0)||z.stop>=px){this.noteOnce(`hz|${x.id}`,now,"HTF_SKIP",{sym:x.sym,day:x.day,reason:"按现价算不出有效止损"});continue;}
        open++;
        const why=`${x.why}；止损 = 入场 − 2×ATR20 = ${fx(z.stop)}（${(z.stopRate*100).toFixed(2)}%），之后按 10 日最低跟踪；风险 0.75%`;
        out.orders.push({id:x.id,symbol:x.sym,side:"LONG",stop:r6(z.stop),riskRate:HTF.riskRate,multiple:1,kind:"N",episodeId:null,episodeCap:null,winner:false,
          reason:why.slice(0,240),
          note:{v:"living-v2",k:"N",pb:HTF.pb,th:null,ep:null,ev:"normal",mult:1,sc:null,t:null,n:null,per:null,rk:x.rank,inv:r6(z.stop),ref:r6(x.brk),
            hold:HTF.holdMin,why:why.slice(0,200),in:"HTF/LONG",mk:mk??"WARMING",nar:(st.last?.text??"").slice(0,180),
            evd:`收盘 ${fx(x.close)}｜20日高 ${fx(x.brk)}｜ATR20 ${(x.atr/x.close*100).toFixed(2)}%｜24h ${x.vol==null?"-":Math.round(x.vol/1e6)+"M"}｜#${x.rank??"-"}`,
            hx:1,atr:r6(x.atr),cl:r6(x.close),dy:x.day}});
      }
      this.dirty.add(LIVING_KEYS.trades);
    }catch(error){this.lastError=String((error as Error)?.message??error).slice(0,200);this.noteOnce(`he|${Math.floor(now/3_600_000)}`,now,"HTF_ERROR",{reason:this.lastError});}
    return out;
  }
  private htfCheck(ctx:PlanContext,st:HtfState,day:string,btc:DailyBar[],coins:{sym:string;rows:DailyBar[];vol:number|null}[],notExternal:string[],minOfDay:number){
    // one per coin; and as in the research, a coin whose daily-breakout trade closed on the signal day waits for the next signal
    const sigDay=(dayStartSec(ctx.now)-86_400)*1000,closedOnSignal=ctx.forward.history.filter(t=>t.entryContext?.living?.hx&&t.closedAt!=null&&t.closedAt>=sigDay).map(t=>t.symbol);
    const now=ctx.now,held=new Set([...ctx.forward.positions.filter(p=>!p.inverseCopy).map(p=>p.symbol),...closedOnSignal]),
      open=ctx.forward.positions.filter(p=>!p.inverseCopy&&p.entryContext?.living?.hx).length;
    const c=dailyCheck({nowMs:now,btc,coins,held,open});
    const nm=(s:string)=>s.replace("_USDT","");
    const breaks=c.rows.filter(r=>r.ok),near=c.rows.filter(r=>!r.ok&&r.code==="NO_BREAK"&&r.close!=null&&r.breakout!=null)
      .sort((a,b)=>(b.close!/b.breakout!)-(a.close!/a.breakout!)).slice(0,5);
    const other=c.rows.filter(r=>r.code!=="BREAK"&&r.code!=="NO_BREAK");
    const regime=c.regime.on==null?"UNKNOWN":c.regime.on?"ON":"OFF";
    const text=`${day} 日线突破做多检查：${c.regime.on==null?"BTC 均线算不出（不开）":c.regime.on?"BTC 在 100 日均线上（可以做）":"BTC 在 100 日均线下（不做）"}，${c.regime.why}；`+
      `${coins.length} 个币（${c.fresh} 个有昨天日线），${breaks.length} 个突破 20 日新高${breaks.length?`：${breaks.map(r=>nm(r.sym)).join("/")}`:""}；`+
      `选中 ${c.picks.map(r=>nm(r.sym)).join("/")||"无"}（空名额 ${c.slots}/${HTF.maxOpen}）`;
    const summary:HtfSummary={day,at:now,regime,btc:c.regime.close,sma:c.regime.sma==null?null:r6(c.regime.sma),universe:coins.length,fresh:c.fresh,
      breakouts:breaks.map(signalCell),picks:c.picks.map(r=>r.sym),skipped:[...c.skipped.map(x=>`${nm(x.sym)}:${x.why}`),...notExternal.map(s=>`${nm(s)}:外部交易所没有日线（不向 Gate 补）`)].slice(0,30),text:text.slice(0,400)};
    this.note(now,"HTF_CHECK",{day,regime,btc:c.regime.close,sma100:summary.sma,gap:c.regime.close!=null&&c.regime.sma!=null?r4(c.regime.close/c.regime.sma-1):null,
      universe:coins.length,fresh:c.fresh,late:Math.round(minOfDay),breakouts:summary.breakouts.join("｜").slice(0,600),near:near.map(signalCell).join("｜").slice(0,400),
      picks:summary.picks.join(","),skipped:summary.skipped.join("｜").slice(0,600),
      other:other.slice(0,12).map(r=>`${nm(r.sym)}:${r.code}`).join(",").slice(0,300),notExternal:notExternal.map(nm).join(",").slice(0,200),reason:text.slice(0,240)});
    try{this.runlog.event(now,"HTF_CHECK",text);
      this.runlog.htfCheck(now,`${day} ${hhmm(now)} regime ${regime} BTC ${c.regime.close==null?"-":fx(c.regime.close)}/SMA100 ${c.regime.sma==null?"-":fx(c.regime.sma)} `+
        `${coins.length}币 ${c.fresh}新 突破[${summary.breakouts.join(" ")}] 选[${summary.picks.map(nm).join(",")}] 跳过[${summary.skipped.slice(0,8).join(" ")}]`);}catch{/* 只是记录 */}
    for(const r of c.picks)this.logCase(now,r.sym,"LONG",HTF.pb,"HTF_PICK",r.why.slice(0,70),"normal",text.slice(0,160));
    for(const x of c.skipped)this.logCase(now,x.sym,"LONG",HTF.pb,"HTF_SKIP",x.why.slice(0,70),"normal",text.slice(0,160));
    const until=Math.min(now+HTF.entryWindowMin*60_000,(dayStartSec(now)+86_400)*1000-60_000);
    st.day=day;st.last=summary;
    st.pending=[...st.pending.filter(x=>x.day!==day),...c.picks.map(r=>({id:`lh-${day}-${r.sym}`,sym:r.sym,day,close:r.close!,brk:r.breakout!,atr:r.atr!,rank:r.rank,vol:r.vol,
      why:r.why.slice(0,160),until}))];
    this.dirty.add(LIVING_KEYS.trades);
  }
  private htfOpened(o:{orderId:string;tradeId:string;symbol:string;risk:number;notional:number},forward:ForwardView,now:number){
    const st=this.trades.hx;if(st)st.pending=st.pending.filter(x=>x.id!==o.orderId);
    const p=forward.positions.find(x=>x.id===o.tradeId),n=p?.entryContext?.living;
    const lev=(p as {leverage?:number}|undefined)?.leverage??null;
    this.note(now,"HTF_OPEN",{trade:o.tradeId,sym:o.symbol,entry:p?.entryPrice??null,stop:p?.stopPrice??null,stopPct:p&&p.entryPrice?r4(1-p.stopPrice/p.entryPrice):null,
      breakout:n?.ref??null,atr:n?.atr??null,lev,risk:r4(o.risk),notional:Math.round(o.notional),reason:`日线突破做多开出：${(n?.why??"").slice(0,160)}`});
    try{this.runlog.event(now,"HTF_OPEN",`${o.symbol.replace("_USDT","")} 开多 ${p?.entryPrice??""}，止损 ${p?.stopPrice??""}${lev?`，${lev} 倍`:""}`);}catch{/* 只是记录 */}
  }
  private htfDrop(orderId:string,now:number,reason:string){
    const st=this.trades.hx;if(!st)return;const x=st.pending.find(y=>y.id===orderId);if(!x)return;
    if(/Gate 实时盘口/.test(reason))return;// the quote may come back inside the entry window
    st.pending=st.pending.filter(y=>y.id!==orderId);this.note(now,"HTF_REJECT",{sym:x.sym,day:x.day,order:orderId,reason:reason.slice(0,160)});
    this.logCase(now,x.sym,"LONG",HTF.pb,"REJECTED",reason.slice(0,70));
  }
  /** htf-donch20 summary for status / brain view */
  htfSummary(forward?:ForwardView){
    const st=this.trades.hx,open=(forward?.positions??[]).filter(p=>!p.inverseCopy&&p.entryContext?.living?.hx);
    return {last:st?.last??null,pending:(st?.pending??[]).map(x=>({sym:x.sym,day:x.day,until:x.until,why:x.why})),open:open.length,maxOpen:HTF.maxOpen,
      trades:open.map(p=>({id:p.id,sym:p.symbol,entry:p.entryPrice,stop:p.livingGuard?.stop??p.stopPrice,initial:p.entryContext?.living?.inv??null,openedAt:p.openedAt}))};
  }
  /** An order that will not be sent again: normal → its watch ends; fast → counts as used for the episode (virtual entry when `used`). */
  private endOrder(o:LivingOrder,used:boolean){
    if(o.kind==="N")this.trades.watches=this.trades.watches.filter(w=>w.id!==o.id);
    else if(o.episodeId){if(used)this.trades.fastEntries[o.episodeId]=(this.trades.fastEntries[o.episodeId]??0)+1;
      this.virtualFast.add(`${o.episodeId}|${o.symbol}`);}
  }
  private virtualFast=new Set<string>();
  private lastZ60(now:number){void now;const s=this.fast.sigma["60"];if(!s.length||!this.basket)return null;
    const xs:number[]=[];for(const m of this.basket.members){const r=this.tape.ret(m,now,60);if(r!=null)xs.push(r);}
    if(xs.length<10)return null;xs.sort((a,b)=>a-b);const b=xs[xs.length>>1]!;
    const med=[...s].sort((a,b)=>a-b),mm=med[med.length>>1]!,mad=[...s.map(x=>Math.abs(x-mm))].sort((a,b)=>a-b)[s.length>>1]!;
    return b/Math.max(FAST.sigmaFloor[60],1.4826*mad);}
  /** B6/P8: when leaders kept reversing after episodes, prefer the strongest coins less (record-only fade; parent: B6 is record-only). */
  private leadersPreferred(){
    const xs=this.episodes.filter(r=>r.leadersAfter30!=null).slice(-10).map(r=>r.leadersAfter30!);
    return xs.length>=5&&xs.filter(x=>x>0).length/xs.length>=.6;
  }
  /** Correlation group for fast entries: residual (coin minus basket median) 1m returns over the last 30 minutes, corr ≥ 0.8
   * with an already used symbol → that symbol's group. Raw returns all correlate in a market-wide burst, so residuals are used. */
  private clusterOf(s:string,used:string[]=this.clusterUsed){
    const mine=this.residual1m(s);if(mine.length<10)return s;
    for(const u of used){if(u===s)return u;const c=corr(mine,this.residual1m(u));if(Number.isFinite(c)&&c>=.8)return u;}
    return s;
  }
  private clusterUsed:string[]=[];
  private residual1m(s:string){
    const rows=this.tape.m1.get(s)??[],out:number[]=[];if(rows.length<12||!this.basket)return out;
    const n=Math.min(30,rows.length-1);
    for(let i=rows.length-n;i<rows.length;i++){
      const t=rows[i]!.time,r=rows[i]!.close/rows[i-1]!.close-1,xs:number[]=[];
      for(const m of this.basket.members.slice(0,30)){const b=this.tape.m1.get(m);const j=b?b.length-(rows.length-i):-1;if(b&&j>0&&b[j]!.time===t)xs.push(b[j]!.close/b[j-1]!.close-1);}
      xs.sort((a,b)=>a-b);out.push(r-(xs.length?xs[xs.length>>1]!:0));
    }
    return out;
  }
  // ------------------------------------------------------------------ after advanceForward
  afterForward(result:LivingResult|undefined,forward:ForwardView,now:number){
    if(this.config.mode==="off"||!this.loaded)return;
    try{
      if(result){
        for(const o of result.opened){
          this.note(now,"ENTRY",{sym:o.symbol,side:o.side,trade:o.tradeId,risk:r4(o.risk),notional:Math.round(o.notional)});
          try{const pb=o.orderId.startsWith("lf-")?"fast":o.orderId.startsWith("lb-")?LEADER.pb:o.orderId.startsWith("lh-")?HTF.pb:this.trades.watches.find(w=>w.id===o.orderId)?.playbook??null;
            const pos=forward.positions.find(p=>p.id===o.tradeId);
            this.runlog.count(now,"OPENED");this.runlog.opened(now,{sym:o.symbol,side:o.side,pb:pb??"",trade:o.tradeId});
            const linked=this.runlog.linkTrade(o.symbol,o.side,pb,{id:o.tradeId,openedAt:pos?.openedAt??now,entry:pos?.entryPrice??null,stop:pos?.stopPrice??null});
            if(!linked&&pb){this.logCase(now,o.symbol,o.side,pb,"OPENED","开出",pb==="fast"||pb===LEADER.pb?"fast":"normal");
              this.runlog.linkTrade(o.symbol,o.side,pb,{id:o.tradeId,openedAt:pos?.openedAt??now,entry:pos?.entryPrice??null,stop:pos?.stopPrice??null});}
          }catch{/* 只是记录 */}
          this.trades.watches=this.trades.watches.filter(w=>w.id!==o.orderId);
          if(o.orderId.startsWith("lh-"))this.htfOpened(o,forward,now);
          const f=o.orderId.startsWith("lf-")?o.orderId.slice(3,o.orderId.lastIndexOf("-")):null;
          if(f){this.trades.fastEntries[f]=(this.trades.fastEntries[f]??0)+1;const rec=this.episodes.find(r=>r.id===f);if(rec)rec.entries++;}
        }
        for(const r of result.rejected){
          const transient=/每轮最多一笔|老流程已开过|路径还在恢复/.test(r.reason);
          if(!transient){if(this.noteOnce(`r|${r.orderId}`,now,"RECORD_ONLY",{sym:r.symbol,reason:`开单被拒：${r.reason}`})){
              const w=this.trades.watches.find(x=>x.id===r.orderId);
              if(w)this.logCase(now,w.symbol,w.side,w.playbook,"REJECTED",r.reason);else this.logCount(now,"REJECTED",r.reason);}this.trades.watches=this.trades.watches.filter(w=>w.id!==r.orderId);
            if(r.orderId.startsWith("lh-"))this.htfDrop(r.orderId,now,`开单被拒：${r.reason}`);
            if(r.orderId.startsWith("lf-")){const ep=r.orderId.slice(3,r.orderId.lastIndexOf("-")),sym=r.orderId.slice(r.orderId.lastIndexOf("-")+1);void sym;this.virtualFast.add(`${ep}|${r.symbol}`);}}
        }
        for(const a of result.applied)this.note(now,"APPLIED",{trade:a.tradeId,code:a.code,action:a.action});
      }
      const seen=new Set(this.trades.seen);
      for(const t of forward.history){
        const n=t.entryContext?.living;if(!n||seen.has(t.id)||t.netPnl==null)continue;
        seen.add(t.id);const r=t.netPnl/Math.max(1e-9,t.plannedRisk);
        const xs=this.trades.liveNet[n.pb]??[];xs.push(r4(r));this.trades.liveNet[n.pb]=xs.slice(-60);
        this.note(now,"CLOSED",{trade:t.id,sym:t.symbol,pb:n.pb,kind:n.k,r:r4(r),exit:t.exitReason});
        try{this.runlog.closeTrade(t.id,{closedAt:t.closedAt,exit:(t as {exitPrice?:number|null}).exitPrice??null,exitReason:t.exitReason,netPnl:t.netPnl});}catch{/* 只是记录 */}
      }
      this.trades.seen=[...seen].slice(-300);
      this.dirty.add(LIVING_KEYS.trades);
    }catch(error){this.lastError=String((error as Error)?.message??error).slice(0,200);this.fallback(now,`研究层记录出错：${this.lastError}`);}
  }

  /** Market-read history (≤ 90 min) + recent decisions for the brain page, trimmed to fit one key. */
  private fitIntent(){
    let hist=this.marketHist.slice(-90);const decisions=this.decisions.slice(-60);
    let v={v:1 as const,hist,decisions};
    while(bytesOf(v)>INTENT_HIST_BYTES&&hist.length>5){hist=hist.slice(Math.ceil(hist.length*.2));v={v:1,hist,decisions};}
    if(bytesOf(v)>INTENT_HIST_BYTES)v={v:1,hist,decisions:decisions.slice(-20)};
    return v;
  }
  // ------------------------------------------------------------------ persistence
  /** Dirty own keys due now, each ≤ 96KB. Returns {} when nothing is due or the own daily budget is used. */
  writes(now:number,force=false):Record<string,unknown>{
    const day=new Date(now).toISOString().slice(0,10);if(this.writesToday.day!==day)this.writesToday={day,n:0};
    const out:Record<string,unknown>={};
    if(this.dirty.has(LIVING_KEYS.config)){out[LIVING_KEYS.config]=this.config;}
    const hot=force||now-this.lastHot>=HOT_EVERY_MS,heavy=force||now-this.lastHeavy>=HEAVY_EVERY_MS,barsDue=force||now-this.lastBars>=BARS_EVERY_MS;
    if(hot){
      // the strength baseline moves every 30s; an event (alert/confirm/end) is written at once, the baseline every 6 minutes
      if(this.dirty.has(LIVING_KEYS.fast)&&(force||this.dirty.has("fastNow")||now-this.lastFastWrite>=FAST_BASELINE_EVERY_MS))out[LIVING_KEYS.fast]=this.fast;
      if(this.dirty.has(LIVING_KEYS.trades))out[LIVING_KEYS.trades]=this.fitTrades();
      if(this.dirty.has("log")||this.sealed.length){
        for(const p of this.sealed)out[`${LOG_PAGE_PREFIX}${p.seq}`]={v:1,seq:p.seq,rows:p.rows};
        out[`${LOG_PAGE_PREFIX}${this.logSeq}`]={v:1,seq:this.logSeq,rows:this.log};
        const pages=[...new Set([...this.logPages,this.logSeq])].slice(-LOG_PAGES_KEPT);
        // the index only names pages: rewrite it only when the page set changed (the current page itself is written every time)
        if(force||this.sealed.length||JSON.stringify({seq:this.logSeq,pages})!==this.lastIndexSig)out[LIVING_KEYS.logIndex]={v:1,seq:this.logSeq,pages};
      }
    }
    if(heavy){
      if(this.dirty.has(LIVING_KEYS.basket)&&this.basket)out[LIVING_KEYS.basket]=this.basket;
      if(this.dirty.has(LIVING_KEYS.episodes))out[LIVING_KEYS.episodes]=this.fitEpisodes();
      if(this.dirty.has(LIVING_KEYS.probes))out[LIVING_KEYS.probes]=fitProbes(this.probes);
      if(this.dirty.has(LIVING_KEYS.thesis))out[LIVING_KEYS.thesis]=this.fitThesis();
      if(this.dirty.has(LIVING_KEYS.select))out[LIVING_KEYS.select]=this.fitSelect();
    }
    const warm=force||now-this.lastWarm>=WARM_EVERY_MS;
    if(warm&&this.basket){
      const syms=[...new Set([...this.basket.members,"BTC_USDT","ETH_USDT",...this.trades.watches.map(w=>w.symbol),...this.coins.keys(),...[...this.runlog.cases.values()].map(c=>c.sym)])];
      if(this.flow.m1.size)Object.assign(out,this.flow.pages(syms));
      if(this.tape.m1.size)Object.assign(out,this.tape.pages1(syms));
      if(this.dirty.has(LIVING_KEYS.intent)&&this.marketHist.length)out[LIVING_KEYS.intent]=this.fitIntent();
    }
    if((warm||now-this.lastCasesWrite>=WARM_EVERY_MS)&&this.runlog.dirty)Object.assign(out,this.runlog.values());
    if(barsDue&&this.tape.m5.size)Object.assign(out,this.tape.pages());
    const n=Object.keys(out).length;
    if(!n)return{};
    if(!force&&this.writesToday.n+n>LIVING_WRITES_PER_DAY){
      // over the own budget: keep config + log index only (log continuity first)
      for(const k of Object.keys(out))if(k!==LIVING_KEYS.config&&!k.startsWith(LOG_PAGE_PREFIX))delete out[k];
      if(this.writesToday.n+Object.keys(out).length>LIVING_WRITES_PER_DAY+400)return{};
    }
    for(const [k,v] of Object.entries(out))if(bytesOf(v)>LIVING_MAX_VALUE_BYTES)delete out[k];// never write an oversized value
    return out;
  }
  /** Call after the put succeeded. */
  committed(keys:string[],now:number){
    this.writesToday.n+=keys.length;
    for(const k of keys){this.dirty.delete(k);if(k.startsWith(LOG_PAGE_PREFIX)&&k!==LIVING_KEYS.logIndex){const seq=Number(k.slice(LOG_PAGE_PREFIX.length));this.sealed=this.sealed.filter(p=>p.seq!==seq);}}
    if(keys.includes(LIVING_KEYS.logIndex)||keys.includes(`${LOG_PAGE_PREFIX}${this.logSeq}`))this.dirty.delete("log");
    if(keys.some(k=>k===LIVING_KEYS.fast||k===LIVING_KEYS.trades||k.startsWith(LOG_PAGE_PREFIX)))this.lastHot=now;
    if(keys.some(k=>k===LIVING_KEYS.probes||k===LIVING_KEYS.thesis||k===LIVING_KEYS.select||k===LIVING_KEYS.episodes||k===LIVING_KEYS.basket))this.lastHeavy=now;
    if(keys.some(k=>k.startsWith(BAR_PAGE_PREFIX)))this.lastBars=now;
    if(keys.includes(LIVING_KEYS.fast)){this.lastFastWrite=now;this.dirty.delete("fastNow");}
    if(keys.some(k=>CASE_PAGE_KEYS.includes(k))){this.runlog.committed(keys);this.lastCasesWrite=now;}
    if(keys.some(k=>k.startsWith(M1_PAGE_PREFIX)||k.startsWith(FLOW_PAGE_PREFIX)||k===LIVING_KEYS.intent))this.lastWarm=now;
    if(keys.includes(LIVING_KEYS.logIndex))this.lastIndexSig=JSON.stringify({seq:this.logSeq,pages:[...new Set([...this.logPages,this.logSeq])].slice(-LOG_PAGES_KEPT)});
  }
  /**
   * Run-log wipe (lib/runlog-wipe.ts): the decision log pages, recent decisions, research cases and timeline buckets
   * are forgotten; recording continues at once on a fresh log page and a bucket that starts at `now`. Learning state
   * (episodes, thesis, probes, trade counters, bars) is kept. Returns the old log page keys for the caller to delete.
   */
  wipeLog(now:number){
    const old=[...new Set([...this.logPages,...this.sealed.map(p=>p.seq),this.logSeq])].map(p=>`${LOG_PAGE_PREFIX}${p}`);
    const counts={logRows:this.log.length+this.sealed.reduce((n,p)=>n+p.rows.length,0),logPages:old.length,decisions:this.decisions.length,...this.runlog.wipe(now)};
    this.logSeq++;this.logPages=[];this.sealed=[];this.log=[];this.decisions=[];this.lastIndexSig="";
    this.dirty.add("log");this.dirty.add(LIVING_KEYS.intent);
    this.note(now,"RUNLOG_WIPE",{cases:counts.cases,buckets:counts.buckets,logRows:counts.logRows});
    this.runlog.event(now,"RUNLOG_WIPE","运行日志已清空，从这里重新开始记录");
    return {counts,oldKeys:old};
  }
  /** Old log pages beyond the kept window (to delete). */
  expiredLogKeys(){const keep=new Set([...this.logPages,this.logSeq].slice(-LOG_PAGES_KEPT));return this.logPages.filter(p=>!keep.has(p)).map(p=>`${LOG_PAGE_PREFIX}${p}`);}
  private fitTrades(){
    const t={...this.trades,pendingEvents:[]};
    let guard=0;while(bytesOf(t)>LIVING_MAX_VALUE_BYTES-1024&&guard++<50){t.recentTriggers=t.recentTriggers.slice(1);t.seen=t.seen.slice(Math.ceil(t.seen.length*.2));
      const ks=Object.keys(t.counts);if(ks.length>200)for(const k of ks.slice(0,50))delete t.counts[k];}
    return t;
  }
  private fitEpisodes(){let xs=this.episodes;while(bytesOf(xs)>LIVING_MAX_VALUE_BYTES-1024&&xs.length>10)xs=xs.slice(Math.ceil(xs.length*.1));this.episodes=xs;return xs;}
  private fitThesis(){const t=this.thesis;let guard=0;
    while(bytesOf(t)>LIVING_MAX_VALUE_BYTES-1024&&guard++<50){t.history=t.history.slice(Math.ceil(t.history.length*.2));t.index=t.index.slice(Math.ceil(t.index.length*.1));
      t.predictions=t.predictions.slice(Math.ceil(t.predictions.length*.1));t.baseline=t.baseline.slice(Math.ceil(t.baseline.length*.1));}
    return t;}
  private fitSelect(){const s=this.select;let guard=0;while(bytesOf(s)>LIVING_MAX_VALUE_BYTES-1024&&guard++<50){s.rows=s.rows.slice(Math.ceil(s.rows.length*.2));s.picks=s.picks.slice(Math.ceil(s.picks.length*.2));}return s;}

  // ------------------------------------------------------------------ views
  status(now:number,forward?:ForwardView){
    const eff=this.effective(now),scores=allScores(this.probes,now,this.thesis.current?.dirTag),m=this.marketIntent??this.restoredMarket;
    const board=[...this.coins.values()].filter(c=>c.symbol!=="BTC_USDT"&&c.symbol!=="ETH_USDT")
      .sort((x,y)=>(y.action?1:0)-(x.action?1:0)||y.strength-x.strength).slice(0,14)
      .map(c=>({symbol:c.symbol,capital:c.capital,emotion:c.emotion,crowd:c.crowd,strength:c.strength,why:c.why,
        action:c.action?{pb:c.action.pb,label:PLAYBOOK_LABEL[c.action.pb],side:c.action.side}:null,noTrade:noTradeReason(c),
        ev:{p15:c.f.p15,oi15:c.f.oi15,oi60:c.f.oi60,funding:c.f.funding,taker15:c.f.taker15,vol15:c.f.vol15,basis:c.f.basis}}));
    const positions=(forward?.positions??[]).filter(p=>!p.inverseCopy).map(p=>{const n=p.entryContext?.living,h=this.holds.get(p.id);
      return {id:p.id,symbol:p.symbol,side:p.side,entry:p.entryPrice,stop:p.livingGuard?.stop??p.stopPrice,openedAt:p.openedAt,living:!!n,
        playbook:n?(PLAYBOOK_LABEL[n.pb as Playbook]??(n.pb==="fast"?"集体异动快速跟进":n.pb===HTF.pb?HTF.label:n.pb)):null,intent:n?.in??null,story:n?.nar??n?.why??null,evidence:n?.evd??null,
        invalidation:n?.inv??null,hold:h?.why??(n?null:"老流程的单：按原有出场规则管理"),holdAt:h?.at??null};});
    const closed=(forward?.history??[]).filter(t=>t.entryContext?.living&&t.closedAt!=null).slice(-200);
    const byPb:Record<string,{n:number;win:number;r:number}>={};
    for(const t of closed){const k=t.entryContext!.living!.pb,r=(t.netPnl??0)/Math.max(1e-9,t.plannedRisk);const x=byPb[k]??={n:0,win:0,r:0};x.n++;if((t.netPnl??0)>0)x.win++;x.r+=r;}
    const eps=this.episodes.slice(-50);
    return {version:LIVING_RULE_EPOCH,mode:eff.mode,configured:eff.configured,acting:eff.acting,fallback:eff.fallback,
      items:LIVING_ITEMS.map(k=>({key:k,label:LIVING_ITEM_LABELS[k],on:eff.items[k]})),epochStartedAt:this.config.epochStartedAt,
      market:m?{state:m.state,side:m.side,confidence:m.confidence,sentence:m.sentence,at:m.at,lead:m.lead,ev:m.ev,restored:!this.marketIntent,
        allowed:m.allowed.map(a=>({pb:a.pb,label:PLAYBOOK_LABEL[a.pb],side:a.side}))}:null,
      marketTimeline:this.marketHist.filter((x,i,a)=>i===0||a[i-1]!.state!==x.state||a[i-1]!.side!==x.side).slice(-12).map(x=>({at:x.at,state:x.state,side:x.side,sentence:x.sentence.slice(0,120)})),
      board,positions,env:this.envSummary(),
      thesis:this.thesis.current?{sentence:this.thesis.current.sentence,structure:this.thesis.current.structure,side:this.thesis.current.side,
        since:this.thesis.current.since,playbooks:this.thesis.current.playbooks.map(p=>PLAYBOOK_LABEL[p.pb])}:null,
      probes:scores.map(s=>({probe:s.probe,label:PROBE_META[s.probe].label,score:s.score,t:s.t,n:s.n,modulator:sizeModulator(s)})),
      fast:{state:this.fast.episode?this.fast.episode.phase:"CALM",side:this.fast.episode?.side??null,reason:this.fast.lastReason,flow:this.fast.episode?.flow??null,
        cooldowns:this.fast.cooldowns.filter(c=>c.until>now),adjustZ:this.fast.adjust.z,episodes:this.episodes.length,
        surges7d:(this.trades.counts["FAST_SURGE"]??0),
        last:this.episodes.slice(-6).map(e=>({id:e.id,side:e.side,end:e.end,alertAt:e.alertAt,confirmAt:e.confirmAt,endAt:e.endAt,after15:e.after["15"]?.[0]??null}))},
      watches:this.trades.watches.map(w=>({symbol:w.symbol,side:w.side,pb:PLAYBOOK_LABEL[w.playbook],expiresAt:w.expiresAt,reason:w.reason,
        intent:w.intent?.state??null,why:w.intent?.why??null,zone:[w.zoneLo,w.zoneHi],invalidation:w.invalidation})),
      selfCheck:{byPlaybook:Object.entries(byPb).map(([pb,x])=>({pb,label:PLAYBOOK_LABEL[pb as Playbook]??(pb==="fast"?"快速跟进":pb===HTF.pb?HTF.label:pb),n:x.n,winRate:x.n?x.win/x.n:0,avgR:x.n?x.r/x.n:0})),
        fast:{alerts:eps.length,fake:eps.filter(e=>e.end==="FAKE").length,confirmed:eps.filter(e=>e.confirmAt!=null).length,
          follow30:eps.filter(e=>e.follow30Net!=null).map(e=>e.follow30Net!)},
        intentReads:this.intentCounts},
      decisions:this.decisions.slice(-30).reverse(),
      htf:this.htfSummary(forward),
      loadedAt:this.loadedAt,basket:this.basket?.members.length??0,tapeSymbols:this.tape.symbols().length,flowSymbols:this.flow.m1.size,lastFeedAt:this.tape.lastFeedAt,flowAt:this.flow.lastAt,
      cpu:{planMs:this.lastPlanMs,maxPlanMs:Math.round(this.maxPlanMs),hubMs:this.lastHubMs},writesToday:this.writesToday.n,lastError:this.lastError,
      recent:this.log.slice(-12)};
  }
  exportSection(now:number,olderPages:{seq:number;rows:LogRow[]}[]=[]){
    return {version:LIVING_RULE_EPOCH,note:"研究层（living-v2）独立记录：资金意图（价格×持仓量、资金费、溢价、主动买卖、成交量）和人性（追涨、恐慌、出尽、拥挤、安逸）的实时读数，市场判断，快速通道每一段（资金是否跟上），等位置、持有理由、保护、开单与只记录的原因。价格幅度都是价格涨跌 %，不是 ROE。",
      marketTimeline:this.marketHist.slice(-90).map(x=>({at:x.at,state:x.state,side:x.side,conf:x.confidence,sentence:x.sentence,ev:x.ev})),
      envNow:{market:this.menv,coins:[...this.envs.entries()].map(([s,e])=>({s,env:e.state,c:e.clarity,ev:e.ev,why:e.sentence}))},
      coinReads:[...this.coins.values()].map(c=>({s:c.symbol,cap:c.capital,emo:c.emotion,crowd:c.crowd,st:c.strength,act:c.action?`${c.action.pb}/${c.action.side}`:null,why:c.why})),
      holds:[...this.holds.entries()].map(([id,h])=>({id,...h})),intentCounts:this.intentCounts,
      status:this.status(now),counts:this.trades.counts,
      thesisHistory:this.thesis.history.slice(-100),probeSeries:this.probes.series.slice(-600),
      selection:{weights:this.select.weights,excess:this.select.excess},episodes:this.episodes,
      fastAdjust:this.fast.adjust.log,liveNet:this.trades.liveNet,
      log:[...olderPages.sort((a,b)=>a.seq-b.seq).flatMap(p=>p.rows),...this.sealed.flatMap(p=>p.rows),...this.log]};
  }
  /** Symbols the tape should follow beyond the basket (positions, watches). */
  followSymbols(forward:ForwardView){return[...new Set([...(this.basket?.members??[]),"BTC_USDT","ETH_USDT",...forward.positions.map(p=>p.symbol),...this.trades.watches.map(w=>w.symbol)])];}
  /** Only when acting (paper-enabled, no fallback): compute-only must not change the legacy loop cadence. */
  /** Symbols whose Gate book must stay on the old every-loop REST fallback: waiting watches (entry fill check); a fast episode → all. */
  restCritical(now:number){const acting=this.effective(now).acting;
    return{all:acting&&!!this.fast.episode,symbols:acting?this.trades.watches.filter(w=>w.status==="WAITING"&&w.expiresAt>now).map(w=>w.symbol):[]};}
  wantsUrgent(now:number){return this.effective(now).acting&&(!!this.fast.episode||this.trades.watches.some(w=>w.status==="WAITING"&&w.expiresAt>now));}
  /** Symbols whose flow (OI / funding / aggressor) the hub should hand over: the tape's symbols. */
  flowSymbols(forward:ForwardView){return this.followSymbols(forward);}
}
export type {Episode,MidBar};
