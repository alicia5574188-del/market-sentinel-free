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
import {LivingTape,BAR_PAGES,BAR_PAGE_PREFIX,selectBasket,basketDue,pruneBasket,type Basket,type TapePoint,type MidBar} from "./tape.ts";
import {stepFast,initialFast,normalizeFast,fastFollowBlocked,matureRecords,fastMultiple,weeklyAdjust,noteMissed,bucketOf,
  type FastState,type EpisodeRecord,type FastEvent,type Episode} from "./fast-lane.ts";
import {detectProbes,registerObservations,matureObservations,allScores,noteSeries,fitProbes,initialProbes,normalizeProbes,
  PROBE_META,type ProbeState,type ProbeScore,type ProbeId,type Trigger} from "./probes.ts";
import {thesisInputs,noteBasketIndex,judge,advanceThesis,notePredictions,initialThesis,normalizeThesis,PLAYBOOK_PROBE,PLAYBOOK_LABEL,
  type ThesisState} from "./thesis.ts";
import {selectCandidates,notePick,learnSelection,initialSelect,normalizeSelect,type SelectState,type Market} from "./select.ts";
import {planPosition,stopCheck,newWatch,stepWatch,fastFollowPicks,type Watch} from "./entry.ts";
import {layerOne,layerTwo,evidenceFactor,normalRisk,fastRisk} from "./conviction.ts";
import {fastProtection,thesisExits,type PositionView} from "./exits.ts";
import type {LivingDirective,LivingOrder,LivingTradeAction,LivingResult,LivingNote} from "./directive.ts";
import {bytesOf,r6,r4,corr} from "./util.ts";

export const LIVING_KEYS={config:LIVING_CONFIG_KEY,basket:`${LIVING_KEY_PREFIX}basket`,fast:`${LIVING_KEY_PREFIX}fast`,
  episodes:`${LIVING_KEY_PREFIX}episodes`,probes:`${LIVING_KEY_PREFIX}probes`,thesis:`${LIVING_KEY_PREFIX}thesis`,
  select:`${LIVING_KEY_PREFIX}select`,trades:`${LIVING_KEY_PREFIX}trades`,logIndex:`${LIVING_KEY_PREFIX}log:index`} as const;
export const LOG_PAGE_PREFIX=`${LIVING_KEY_PREFIX}log:`;
export const LOG_PAGES_KEPT=30;
const LOG_PAGE_BYTES=LIVING_MAX_VALUE_BYTES-2048;
/** Own daily write budget (rows), well inside the shared 100k optional guard. */
export const LIVING_WRITES_PER_DAY=4_000;
const HOT_EVERY_MS=120_000,HEAVY_EVERY_MS=15*60_000,BARS_EVERY_MS=60*60_000;
const STALE_MS=90_000;

/** Minimal views of the forward core the engine reads (no runtime import of forward-relations). */
export type ForwardView={positions:{id:string;symbol:string;side:"LONG"|"SHORT";entryPrice:number;stopPrice:number;liquidationPrice?:number|null;
  openedAt:number;favorable:number;livingGuard?:{stop:number}|undefined;entryContext?:{living?:LivingNote}|undefined;inverseCopy?:unknown}[];
  history:{id:string;symbol:string;side:"LONG"|"SHORT";netPnl:number|null;plannedRisk:number;notional:number;closedAt:number|null;exitReason:string|null;
    openedAt:number;entryContext?:{living?:LivingNote}|undefined}[];
  opportunities:{symbol:string;side:"LONG"|"SHORT";eligible?:boolean}[]};
export type QuoteView={bestBid:number;bestAsk:number;observedAt:number;entryReady?:boolean};
export type ContractView={maintenanceRate:number;leverageMax:number};
export type PlanContext={now:number;forward:ForwardView;quotes:Record<string,QuoteView>;contracts:Record<string,ContractView>;
  funding:Record<string,number>;candles:Record<string,{time:number;open:number;high:number;low:number;close:number}[]>};
export type LogRow={at:number;k:string;[x:string]:string|number|boolean|null};
type TradesState={v:1;watches:Watch[];liveNet:Record<string,number[]>;seen:string[];handedOff:string[];peaks:[string,number][];
  recentTriggers:{at:number;t:Trigger[]}[];lastBarAt:number;lastMinuteAt:number;counts:Record<string,number>;
  pendingEvents:FastEvent[];lastEnd:{id:string;end:string;at:number}|null;fastEntries:Record<string,number>};
const initialTrades=():TradesState=>({v:1,watches:[],liveNet:{},seen:[],handedOff:[],peaks:[],recentTriggers:[],lastBarAt:0,lastMinuteAt:0,
  counts:{},pendingEvents:[],lastEnd:null,fastEntries:{}});
const FAST_CODES=new Set(["LIVING_FAST_LIQ_GUARD","LIVING_FAST_TIGHTEN","LIVING_FAST_CONFIRM_EXIT","LIVING_FAST_BREAKEVEN","LIVING_FAST_GIVEBACK"]);
const d=(s:"LONG"|"SHORT")=>s==="LONG"?1:-1;

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
  private lastHot=0;private lastHeavy=0;private lastBars=0;
  writesToday={day:"",n:0};
  lastPlanAt=0;lastPlanMs=0;maxPlanMs=0;lastHubMs=0;
  constructor(now:number,config?:unknown){this.config=normalizeLivingConfig(config,now);}

  /** Keys to read at start (one batched get). */
  static loadKeys(){return[...Object.values(LIVING_KEYS),...Array.from({length:BAR_PAGES},(_,i)=>`${BAR_PAGE_PREFIX}${i}`)];}
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
    this.loaded=true;
    this.note(now,"RESTART",{bars:this.tape.m5.size,episodes:this.episodes.length,watches:this.trades.watches.length});
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
    const ck=typeof data.reason==="string"?`${k}:${String(data.reason).replace(/[0-9.+\-%]+/g,"#").slice(0,40)}`:k;
    this.trades.counts[ck]=(this.trades.counts[ck]??0)+1;
    if(this.log.length%25===0&&bytesOf(this.log)>LOG_PAGE_BYTES)this.rollLog();
    this.dirty.add("log");
  }
  private once=new Set<string>();
  /** Same row only once per key (per-tick repeats of an unchanged decision are not new information). */
  noteOnce(key:string,at:number,k:string,data:Record<string,string|number|boolean|null>={}){
    if(this.once.has(key))return;this.once.add(key);if(this.once.size>2000)this.once=new Set([...this.once].slice(-1000));this.note(at,k,data);
  }
  private sealed:{seq:number;rows:LogRow[]}[]=[];
  private rollLog(){this.sealed.push({seq:this.logSeq,rows:this.log});this.logPages=[...this.logPages.filter(p=>p!==this.logSeq),this.logSeq];this.logSeq++;this.log=[];}

  // ------------------------------------------------------------------ fast path (every hub refresh)
  onHub(points:TapePoint[],now:number,gateListed:(s:string)=>boolean){
    if(this.config.mode==="off"||!this.loaded)return;
    const t0=Date.now();
    try{
      if(basketDue(this.basket,now)&&points.length>=40){
        const rows=points.map(p=>({symbol:p.symbol,volume24hUsd:p.volume24hUsd??0,sources:p.sources??1,gate:gateListed(p.symbol)}));
        const b=selectBasket(rows,now);if(b.members.length>=20){this.basket=b;this.dirty.add(LIVING_KEYS.basket);this.note(now,"BASKET",{n:b.members.length,top:b.top10.slice(0,5).join(",")});}
      }else if(this.basket){const nb=pruneBasket(this.basket,gateListed);if(nb!==this.basket){this.basket=nb;this.dirty.add(LIVING_KEYS.basket);}}
      this.tape.feed(points,now);
      if(!this.basket)return;
      const r=stepFast(this.fast,this.tape,this.basket,now);this.fast=r.state;
      for(const e of r.events){
        this.trades.pendingEvents.push(e);
        this.note(now,`FAST_${e.type}`,{ep:e.episodeId,side:e.side,...Object.fromEntries(Object.entries(e.detail).slice(0,8))});
      }
      if(r.ended){this.episodes.push(r.ended);if(this.episodes.length>200)this.episodes.splice(0,this.episodes.length-200);
        this.trades.lastEnd={id:r.ended.id,end:r.ended.end,at:now};this.dirty.add(LIVING_KEYS.episodes);}
      if(r.events.length)this.dirty.add(LIVING_KEYS.fast);
      if(this.trades.pendingEvents.length>40)this.trades.pendingEvents.splice(0,this.trades.pendingEvents.length-40);
      if(now-this.trades.lastMinuteAt>=60_000){
        this.trades.lastMinuteAt=now;
        if(matureRecords(this.episodes,this.tape,this.basket.members,now))this.dirty.add(LIVING_KEYS.episodes);
        noteMissed(this.fast,this.tape,this.basket.members,now);
        if(weeklyAdjust(this.fast,now))this.note(now,"FAST_ADJUST",{z:this.fast.adjust.z,why:this.fast.adjust.log.at(-1)?.why??""});
        this.dirty.add(LIVING_KEYS.fast);
      }
    }catch(error){this.lastError=String((error as Error)?.message??error).slice(0,200);this.fallback(now,`快速通道出错：${this.lastError}`);}
    finally{this.lastHubMs=Date.now()-t0;}
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
      // C5 thesis exits
      const scores=this.scoreMap(now);
      const th=thesisExits({positions:views,thesis:this.thesis.current,scores,tape:this.tape,now,episode:this.fast.episode,
        handedOff:new Set(this.trades.handedOff),lastEnd:this.trades.lastEnd});
      for(const a of th){
        if(a.action==="HANDOFF")this.trades.handedOff=[...this.trades.handedOff,a.tradeId].slice(-100);
        actions.push(a);this.noteOnce(`x|${a.tradeId}|${a.code}`,now,eff.acting&&items.thesisExit?"EXIT":"EXIT_RECORD",{trade:a.tradeId,code:a.code,reason:a.reason});
      }
      // C4 watches
      const oppositeAlert=(side:"LONG"|"SHORT")=>!!this.fast.episode&&this.fast.episode.side!==side;
      const keep:Watch[]=[];
      for(const w of this.trades.watches){
        const n=stepWatch(w,this.tape,now,oppositeAlert(w.side),items.noChase);
        if(n.status==="DONE"){this.note(now,"RECORD_ONLY",{sym:w.symbol,side:w.side,pb:w.playbook,reason:n.reason??"放弃"});continue;}
        if(n.status==="READY"){
          const o=this.normalOrder(ctx,n,scores,items);
          if(typeof o==="string"){this.note(now,"RECORD_ONLY",{sym:w.symbol,side:w.side,pb:w.playbook,reason:o});continue;}
          orders.push(o);keep.push({...n,status:"WAITING"});continue;
        }
        keep.push(n);
      }
      this.trades.watches=keep;
      // B5 fast follow
      for(const o of this.fastOrders(ctx,items))orders.push(o);
      // execution filter: only symbols with a fresh entry-ready Gate quote (no new request)
      const exec=orders.filter(o=>{
        const q=ctx.quotes[o.symbol],ok=!!q&&now-q.observedAt<=10_000&&q.entryReady!==false&&q.bestBid>0&&q.bestAsk>=q.bestBid;
        if(!ok){this.noteOnce(`q|${o.id}`,now,"RECORD_ONLY",{sym:o.symbol,side:o.side,pb:o.note.pb,kind:o.kind,reason:"没有 Gate 实时盘口（不新增请求）"});
          this.endOrder(o,false);}
        return ok;
      });
      this.dirty.add(LIVING_KEYS.trades);
      if(!eff.acting){
        for(const o of exec){this.note(now,"ENTRY_RECORD",{sym:o.symbol,side:o.side,pb:o.note.pb,kind:o.kind,mult:r4(o.multiple),reason:`只计算模式：${o.reason.slice(0,80)}`});this.endOrder(o,true);}
        return undefined;
      }
      const directive:LivingDirective={version:"living-v1",items:{...items},
        actions:actions.filter(a=>FAST_CODES.has(a.code)?items.fastProtect:items.thesisExit),
        orders:exec.filter(o=>o.kind==="F"?items.fastFollow:items.newSource).sort((a,b)=>(a.kind==="F"?0:1)-(b.kind==="F"?0:1)),
        legacyGate:items.newSource?"note":"open"};
      for(const o of exec)if(!directive.orders.includes(o)){this.note(now,"RECORD_ONLY",{sym:o.symbol,side:o.side,pb:o.note.pb,reason:"对应开关关着，只记录"});this.endOrder(o,true);}
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
        openedAt:p.openedAt,favorable:p.favorable,guard:p.livingGuard?.stop??null,living:p.entryContext?.living,price:px};
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
    const th=this.thesis.current;
    if(!th||!th.playbooks.length){this.note(at,"NO_REWARD",{reason:"现在市场不给钱：没有被奖励的做法，不开新单"});return;}
    if(th.structure==="BURST")return;// fast lane owns bursts
    const recent=this.trades.recentTriggers.filter(x=>at-x.at<=10*60_000).flatMap(x=>x.t);
    const market=this.market(ctx,at);
    const busy=new Set([...ctx.forward.positions.map(p=>p.symbol),...this.trades.watches.map(w=>w.symbol)]);
    for(const p of th.playbooks){
      const pb=p.pb,directional=pb!=="range-revert"&&pb!=="extension-fade"&&pb!=="crowding-fade";
      const picked=selectCandidates(market,this.select,pb,recent,directional?th.side:null,items.liqSafety);
      notePick(this.select,PLAYBOOK_PROBE[pb],at,picked.filter(c=>c.trigger&&triggers.includes(c.trigger)));
      const score=scores[PLAYBOOK_PROBE[pb]];
      for(const c of picked){
        if(c.reject){if(c.rank===0&&!/排在前/.test(c.reject))this.note(at,"RECORD_ONLY",{sym:c.symbol,side:c.side,pb,reason:c.reject});continue;}
        if(busy.has(c.symbol))continue;
        const l1=layerOne(score),l2=layerTwo(th,pb,c.side,c);
        if(!l1.ok||!l2.ok){this.note(at,"RECORD_ONLY",{sym:c.symbol,side:c.side,pb,reason:`研究层没开：${!l1.ok?l1.why:l2.why}`});continue;}
        const rows=bars(c.symbol),plan=planPosition(c,rows);
        if(!plan){this.note(at,"RECORD_ONLY",{sym:c.symbol,side:c.side,pb,reason:"找不到合理的位置"});continue;}
        const mid=(plan.lo+plan.hi)/2,ct=ctx.contracts[c.symbol];
        const chk=stopCheck({side:c.side,price:mid,stop:plan.inv,min:STEPS.stopMin,max:STEPS.stopMax,leverageMax:ct?.leverageMax??10,mmr:ct?.maintenanceRate??null,liqSafety:items.liqSafety});
        if(!chk.ok){this.note(at,"RECORD_ONLY",{sym:c.symbol,side:c.side,pb,reason:chk.reason});continue;}
        const w=newWatch(c,{...plan,inv:chk.stop},at,PROBE_META[PLAYBOOK_PROBE[pb]].horizon,{l1:true,l2:true,probeSize:l1.probeSize,why1:l1.why,why2:l2.why});
        this.trades.watches.push(w);busy.add(c.symbol);
        this.note(at,"WATCH",{sym:c.symbol,side:c.side,pb,rank:c.rank,score:c.score,lo:w.zoneLo,hi:w.zoneHi,inv:w.invalidation});
      }
    }
    if(this.trades.watches.length>12)this.trades.watches.splice(0,this.trades.watches.length-12);
  }
  private normalOrder(ctx:PlanContext,w:Watch,scores:Record<ProbeId,ProbeScore>,items:LivingItems):LivingOrder|string{
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
  private fastOrders(ctx:PlanContext,items:LivingItems):LivingOrder[]{
    const ep=this.fast.episode,now=ctx.now;if(!ep||ep.phase!=="CONFIRMED"||ep.confirmAt==null||!this.basket)return[];
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
    for(const s of skipped.slice(0,3))this.noteOnce(`f|${ep.id}|${s.symbol}`,now,"RECORD_ONLY",{sym:s.symbol,side:ep.side,pb:"fast",reason:s.why});
    const out:LivingOrder[]=[];
    for(const p of picks){
      const last=this.tape.last(p.symbol);if(!last)continue;const ct=ctx.contracts[p.symbol];
      const chk=stopCheck({side:p.side,price:last.mid,stop:p.stop,min:FAST.stopMin,max:FAST.stopMax,leverageMax:ct?.leverageMax??10,mmr:ct?.maintenanceRate??null,liqSafety:true});
      if(!chk.ok){this.noteOnce(`f|${ep.id}|${p.symbol}`,now,"RECORD_ONLY",{sym:p.symbol,side:p.side,pb:"fast",reason:chk.reason});continue;}
      const mult=items.sizing?fastMultiple(this.episodes,bucketOf(ep.peakZ)):1,risk=fastRisk({fastMultiple:mult,probe:p.mode==="PROBE"});
      const why=`集体异动${ep.side==="LONG"?"普涨":"普跌"}确认后跟进（${p.mode==="PROBE"?"试探 1/3":"回调后再创新"}）：${p.why}`;
      out.push({id:`lf-${ep.id}-${p.symbol}`,symbol:p.symbol,side:p.side,stop:chk.stop,riskRate:risk.riskRate,multiple:risk.multiple,kind:"F",episodeId:ep.id,
        episodeCap:SIZING.episodeRiskCap,winner:true,reason:why,
        note:{v:"living-v1",k:"F",pb:"fast",th:this.thesis.current?.id??null,ep:ep.id,ev:"fast",mult:r4(risk.multiple),sc:null,t:null,n:null,per:null,rk:null,
          inv:chk.stop,ref:null,hold:30,why:why.slice(0,200)}});
    }
    return out;
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
          this.trades.watches=this.trades.watches.filter(w=>w.id!==o.orderId);
          const f=o.orderId.startsWith("lf-")?o.orderId.slice(3,o.orderId.lastIndexOf("-")):null;
          if(f){this.trades.fastEntries[f]=(this.trades.fastEntries[f]??0)+1;const rec=this.episodes.find(r=>r.id===f);if(rec)rec.entries++;}
        }
        for(const r of result.rejected){
          const transient=/每轮最多一笔|老流程已开过|路径还在恢复/.test(r.reason);
          if(!transient){this.noteOnce(`r|${r.orderId}`,now,"RECORD_ONLY",{sym:r.symbol,reason:`开单被拒：${r.reason}`});this.trades.watches=this.trades.watches.filter(w=>w.id!==r.orderId);
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
      }
      this.trades.seen=[...seen].slice(-300);
      this.dirty.add(LIVING_KEYS.trades);
    }catch(error){this.lastError=String((error as Error)?.message??error).slice(0,200);this.fallback(now,`研究层记录出错：${this.lastError}`);}
  }

  // ------------------------------------------------------------------ persistence
  /** Dirty own keys due now, each ≤ 96KB. Returns {} when nothing is due or the own daily budget is used. */
  writes(now:number,force=false):Record<string,unknown>{
    const day=new Date(now).toISOString().slice(0,10);if(this.writesToday.day!==day)this.writesToday={day,n:0};
    const out:Record<string,unknown>={};
    if(this.dirty.has(LIVING_KEYS.config)){out[LIVING_KEYS.config]=this.config;}
    const hot=force||now-this.lastHot>=HOT_EVERY_MS,heavy=force||now-this.lastHeavy>=HEAVY_EVERY_MS,barsDue=force||now-this.lastBars>=BARS_EVERY_MS;
    if(hot){
      if(this.dirty.has(LIVING_KEYS.fast))out[LIVING_KEYS.fast]=this.fast;
      if(this.dirty.has(LIVING_KEYS.trades))out[LIVING_KEYS.trades]=this.fitTrades();
      if(this.dirty.has("log")||this.sealed.length){
        for(const p of this.sealed)out[`${LOG_PAGE_PREFIX}${p.seq}`]={v:1,seq:p.seq,rows:p.rows};
        out[`${LOG_PAGE_PREFIX}${this.logSeq}`]={v:1,seq:this.logSeq,rows:this.log};
        const pages=[...new Set([...this.logPages,this.logSeq])].slice(-LOG_PAGES_KEPT);
        out[LIVING_KEYS.logIndex]={v:1,seq:this.logSeq,pages};
      }
    }
    if(heavy){
      if(this.dirty.has(LIVING_KEYS.basket)&&this.basket)out[LIVING_KEYS.basket]=this.basket;
      if(this.dirty.has(LIVING_KEYS.episodes))out[LIVING_KEYS.episodes]=this.fitEpisodes();
      if(this.dirty.has(LIVING_KEYS.probes))out[LIVING_KEYS.probes]=fitProbes(this.probes);
      if(this.dirty.has(LIVING_KEYS.thesis))out[LIVING_KEYS.thesis]=this.fitThesis();
      if(this.dirty.has(LIVING_KEYS.select))out[LIVING_KEYS.select]=this.fitSelect();
    }
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
    if(keys.includes(LIVING_KEYS.logIndex))this.dirty.delete("log");
    if(keys.some(k=>k===LIVING_KEYS.fast||k===LIVING_KEYS.trades||k.startsWith(LOG_PAGE_PREFIX)))this.lastHot=now;
    if(keys.some(k=>k===LIVING_KEYS.probes||k===LIVING_KEYS.thesis||k===LIVING_KEYS.select||k===LIVING_KEYS.episodes||k===LIVING_KEYS.basket))this.lastHeavy=now;
    if(keys.some(k=>k.startsWith(BAR_PAGE_PREFIX)))this.lastBars=now;
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
  status(now:number){
    const eff=this.effective(now),scores=allScores(this.probes,now,this.thesis.current?.dirTag);
    return {version:LIVING_RULE_EPOCH,mode:eff.mode,configured:eff.configured,acting:eff.acting,fallback:eff.fallback,
      items:LIVING_ITEMS.map(k=>({key:k,label:LIVING_ITEM_LABELS[k],on:eff.items[k]})),epochStartedAt:this.config.epochStartedAt,
      thesis:this.thesis.current?{sentence:this.thesis.current.sentence,structure:this.thesis.current.structure,side:this.thesis.current.side,
        since:this.thesis.current.since,playbooks:this.thesis.current.playbooks.map(p=>PLAYBOOK_LABEL[p.pb])}:null,
      rewarded:scores.filter(s=>s.rewarded).map(s=>({probe:s.probe,label:PROBE_META[s.probe].label,score:s.score,t:s.t,n:s.n,persistence:s.persistence})),
      probes:scores.map(s=>({probe:s.probe,score:s.score,t:s.t,n:s.n,rewarded:s.rewarded})),
      fast:{state:this.fast.episode?this.fast.episode.phase:"CALM",side:this.fast.episode?.side??null,reason:this.fast.lastReason,
        cooldowns:this.fast.cooldowns.filter(c=>c.until>now),adjustZ:this.fast.adjust.z,episodes:this.episodes.length,
        last:this.episodes.slice(-5).map(e=>({id:e.id,side:e.side,end:e.end,alertAt:e.alertAt,confirmAt:e.confirmAt,endAt:e.endAt}))},
      watches:this.trades.watches.map(w=>({symbol:w.symbol,side:w.side,pb:PLAYBOOK_LABEL[w.playbook],expiresAt:w.expiresAt,reason:w.reason})),
      basket:this.basket?.members.length??0,tapeSymbols:this.tape.symbols().length,lastFeedAt:this.tape.lastFeedAt,
      cpu:{planMs:this.lastPlanMs,maxPlanMs:Math.round(this.maxPlanMs),hubMs:this.lastHubMs},writesToday:this.writesToday.n,lastError:this.lastError,
      recent:this.log.slice(-12)};
  }
  exportSection(now:number,olderPages:{seq:number;rows:LogRow[]}[]=[]){
    return {version:LIVING_RULE_EPOCH,note:"研究层（living-v1）独立记录：配置、市场判断、各做法奖励分、快速通道每一段、等位置、保护、开单与只记录的原因。",
      status:this.status(now),counts:this.trades.counts,
      thesisHistory:this.thesis.history.slice(-100),probeSeries:this.probes.series.slice(-600),
      selection:{weights:this.select.weights,excess:this.select.excess},episodes:this.episodes,
      fastAdjust:this.fast.adjust.log,liveNet:this.trades.liveNet,
      log:[...olderPages.sort((a,b)=>a.seq-b.seq).flatMap(p=>p.rows),...this.sealed.flatMap(p=>p.rows),...this.log]};
  }
  /** Symbols the tape should follow beyond the basket (positions, watches). */
  followSymbols(forward:ForwardView){return[...new Set([...(this.basket?.members??[]),"BTC_USDT","ETH_USDT",...forward.positions.map(p=>p.symbol),...this.trades.watches.map(w=>w.symbol)])];}
  /** Only when acting (paper-enabled, no fallback): compute-only must not change the legacy loop cadence. */
  wantsUrgent(now:number){return this.effective(now).acting&&(!!this.fast.episode||this.trades.watches.some(w=>w.status==="WAITING"&&w.expiresAt>now));}
}
export type {Episode,MidBar};
