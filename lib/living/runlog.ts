/**
 * Run log v3 for the living-v2 system (review only: nothing here is read by an entry, an exit, sizing or a stop).
 *
 *  - Timeline: one sample per minute (also while the layer is off), folded into 10-minute buckets: what the entry
 *    channel was doing (gate), the market intent, the fast lane, and a funnel of every candidate by the layer that
 *    stopped it, with reason counts. Buckets go to D1 (upserted every ~2 minutes); no Durable Object writes.
 *  - Research cases: every coin the layer had a playbook idea for and that reached a layer (blocked or not), deduped
 *    per symbol+side+playbook within 90 minutes, with the evidence at that moment. After 6 hours a one-minute forward
 *    price path is built from the layer's own minute bars (already-fetched quotes, zero requests) and the case goes to
 *    D1. Active case headers (no path) live in up to CASE_PAGES own keys (each ≤ 90KB), written on the 10-minute warm
 *    cycle (only pages that changed).
 * All price numbers are price moves (%, or basis points in paths), never ROE.
 */
import {LIVING_KEY_PREFIX,LIVING_MAX_VALUE_BYTES} from "./config.ts";
import {bytesOf} from "./util.ts";
import type {LivingTape,MidBar} from "./tape.ts";

export const RUNLOG_VERSION="living-run-log-v3" as const;
export const CASES_KEY=`${LIVING_KEY_PREFIX}cases`;
export const BUCKET_MS=10*60_000;
export const CASE_PATH_MIN=360;
/** A case is final 6h + 5min after it first appeared (the last minute bar is closed). */
export const CASE_FINAL_MS=(CASE_PATH_MIN+5)*60_000;
export const CASE_DEDUPE_MS=90*60_000;
export const CASE_ACTIVE_CAP=100;
export const CASE_DAILY_CAP=500;
/** Cases that stopped at an early layer (L1/FILTER/CLUSTER) per UTC day; later ones are only counted in the funnel. */
export const CASE_EARLY_DAILY_CAP=250;
const CASES_BYTES=LIVING_MAX_VALUE_BYTES-6*1024;
/** Active case headers are spread over this many keys (page 0 is the old single key). */
export const CASE_PAGES=4;
export const casePageKey=(i:number)=>i===0?CASES_KEY:`${CASES_KEY}:${i}`;
export const CASE_PAGE_KEYS=Array.from({length:CASE_PAGES},(_,i)=>casePageKey(i));
/** Greedy split by time into pages of ≤ CASES_BYTES; null when CASE_PAGES are not enough. */
function packCases(cases:Case[]):Case[][]|null{
  const pages:Case[][]=[];let cur:Case[]=[],bytes=0;
  for(const c of cases){const b=bytesOf(c)+1;
    if(cur.length&&bytes+b>CASES_BYTES-512){pages.push(cur);cur=[];bytes=0;}
    if(b>CASES_BYTES-512)return null;
    cur.push(c);bytes+=b;}
  if(cur.length)pages.push(cur);
  return pages.length<=CASE_PAGES?pages:null;
}
const BUCKETS_KEPT=24*6;// in memory: last 24 h (export also reads D1)

export type Gate="OPEN"|"PAUSED_OFF"|"COMPUTE_ONLY"|"FALLBACK"|"WARMING"|"FAST_OWNS"|"NO_BASKET"|"NOT_LOADED";
export const GATE_LABEL:Record<Gate,string>={OPEN:"能开单（在找机会）",PAUSED_OFF:"研究层关着",COMPUTE_ONLY:"只计算，不开单",
  FALLBACK:"出错或报价断了，自动降级为只计算",WARMING:"市场还读不出来（暖机/数据不够）",FAST_OWNS:"集体异动进行中，普通开单让给快速通道",
  NO_BASKET:"还没选出一篮子币",NOT_LOADED:"研究层还没恢复"};
export type Layer="L1_MARKET"|"FILTER"|"RANK"|"CLUSTER"|"L2_WEAK"|"BUSY"|"NO_LOCATION"|"RISK"|"WATCH"|"WATCH_END"|"CONFIRM_FAIL"|
  "NO_QUOTE"|"COMPUTE_ONLY"|"SWITCH_OFF"|"REJECTED"|"OPENED"|"FAST_FLOW_BLOCK"|"FAST_SKIP"|"FAST_PICK"|"L1_SIZED"|"FOLLOW_EDGE"|"COOLDOWN"|"ENV_MISMATCH"|"ENV_PICK"|"SPECIAL_ONLY";
export const LAYER_LABEL:Record<Layer,string>={L1_MARKET:"第一层：市场意图不允许这个打法/方向",FILTER:"硬条件：成交额/价差/维持保证金率不合格",
  RANK:"排在前 3 名之外",CLUSTER:"和已选的币走势高度相关，只留一个",L2_WEAK:"第二层：这个币的证据不够强",BUSY:"已有持仓或在等位置",
  NO_LOCATION:"找不到合理的位置",RISK:"止损/强平检查不过",WATCH:"进入等位置",WATCH_END:"等位置结束，没开（过期/失效/不追）",
  CONFIRM_FAIL:"位置到了但复核没过（意图变了）",NO_QUOTE:"没有 Gate 实时盘口",COMPUTE_ONLY:"只计算模式：本应开的单",
  SWITCH_OFF:"对应开关关着",REJECTED:"账户层拒绝",OPENED:"开出",FAST_FLOW_BLOCK:"集体异动：资金没跟上或是逼空/踩踏，不跟",
  FAST_SKIP:"集体异动：这个币没被选上",FAST_PICK:"集体异动：选中跟进",L1_SIZED:"第一层：市场方向不清，按半仓放行（不是拦截）",FOLLOW_EDGE:"顺势不追在 4 小时区间顶部/底部",COOLDOWN:"止损后 60 分钟冷却（同币同打法）",
  ENV_MISMATCH:"环境：这个打法和币自己的环境对不上（只记录不开）",ENV_PICK:"环境：币环境选中这个打法（不是拦截，往下走）",SPECIAL_ONLY:"只在全市场突然爆发时开单：普通行情只记录"};
/** How far a case got (furthest wins). */
const DEPTH:Record<Layer,number>={RANK:0,FILTER:1,L1_MARKET:2,CLUSTER:3,L2_WEAK:4,BUSY:4,NO_LOCATION:5,RISK:6,FAST_FLOW_BLOCK:2,FAST_SKIP:5,
  WATCH:7,WATCH_END:8,CONFIRM_FAIL:9,NO_QUOTE:10,SWITCH_OFF:10,COMPUTE_ONLY:11,FAST_PICK:7,REJECTED:11,OPENED:12,L1_SIZED:2,FOLLOW_EDGE:5,COOLDOWN:4,ENV_MISMATCH:2,ENV_PICK:2,SPECIAL_ONLY:2};
const EARLY=new Set<Layer>(["L1_MARKET","FILTER","CLUSTER","RANK","ENV_MISMATCH","SPECIAL_ONLY"]);
const PRIORITY=(l:Layer)=>DEPTH[l]>=7?3:EARLY.has(l)?1:2;

export type MarketSample={state:string;side:"LONG"|"SHORT"|null;conf:number;allowed:string[];
  /** v3 market environment (TREND_UP / CHOP / …) and its clarity */env?:string;envConf?:number}|null;
export type Sample={gate:Gate;market:MarketSample;fast:string;open:number;watches:number;mode:string};
export type Bucket={v:1;id:string;at:number;end:number;boot:string;minutes:number;gate:Record<string,number>;market:Record<string,number>;
  last:MarketSample;mode:string|null;fast:Record<string,number>;
  /** v3: minutes per market environment in this bucket */env?:Record<string,number>;
  /** burst-leader-v1: every special-condition check this bucket, one per minute: "HH:MM,z,breadth%,b3bp,verdict" joined by ";" */burst?:string;funnel:Record<string,number>;reasons:Record<string,number>;
  open:number;watches:number;opened:{at:number;sym:string;side:string;pb:string;trade:string}[];
  events:{at:number;k:string;text:string}[];blocker:string|null;firstSampleAt:number|null;lastSampleAt:number|null};
export type CaseEv={p15:number|null;p60:number|null;oi15:number|null;oi60:number|null;funding:number|null;taker15:number|null;vol15:number|null;basis:number|null};
export type CaseInput={at:number;sym:string;side:"LONG"|"SHORT";pb:string;pbLabel:string;kind:"normal"|"fast";intent:string|null;strength:number|null;
  why:string;ev:CaseEv|null;market:MarketSample;px:number|null;
  /** v3 environment: "<coin env>|M:<market env>" */env?:string|null};
export type CaseStage={at:number;layer:Layer;reason:string;px:number|null};
export type CaseTrade={id:string;openedAt:number;entry:number|null;stop:number|null;closedAt?:number|null;exit?:number|null;exitReason?:string|null;netPnl?:number|null;
  /** Holding reads, one row per minute while open (HOLD_READ_FIELDS, ";"-separated rows, "," fields); hr_drop = older rows dropped. */
  hr?:string;hr_drop?:number};
/** Fields of one holding-read row (≈60 bytes): minute since open, health h, capital, emotion, strength, OI 15m %, taker 5m,
 * funding %, 5m ATR %, market intent, brain verdict code (empty = hold). */
export const HOLD_READ_FIELDS=["min","h","capital","emotion","strength","oi15_pct","taker5","funding_pct","atr5_pct","market","verdict","env"] as const;
export const HOLD_READ_MAX=240;
const CAP_CODE:Record<string,string>={DEMAND:"DM",SUPPLY:"SP",SQUEEZE_UP:"SQ",FLUSH_DOWN:"FL",ABSORB_BID:"AB",ABSORB_ASK:"AA",DRIFT:"DR",UNVERIFIED:"UV",NONE:"-"};
const EMO_CODE:Record<string,string>={FOMO:"FO",PANIC:"PA",CAPITULATION:"CA",EXHAUSTION:"EX",BLOWOFF:"BO",COMPLACENCY:"CO",CONVICTION:"CV",CALM:"CL",NONE:"-"};
const MKT_CODE:Record<string,string>={RISK_ON:"ON",RISK_OFF:"OFF",SQUEEZE:"SQ",PANIC:"PA",CAPITULATION:"CA",FOMO:"FO",COMPLACENT:"CO",CALM:"CL",MIXED:"MX",WARMING:"WM"};
export const HOLD_READ_CODES={capital:CAP_CODE,emotion:EMO_CODE,market:MKT_CODE};
type HoldReadCoin={capital:string;emotion:string;strength:number;f:{oi15:number|null;taker5:number|null;funding:number|null;atr5:number|null;last:number|null}}|null;
const fx=(v:number|null|undefined,k:number)=>typeof v==="number"&&Number.isFinite(v)?String(Math.round(v*10**k)/10**k):"";
export function holdReadRow(min:number,x:{coin:HoldReadCoin;h:number|null;market:string|null;code:string;env?:string|null}){
  const c=x.coin,f=c?.f;
  return [min,fx(x.h,2),c?CAP_CODE[c.capital]??c.capital:"",c?EMO_CODE[c.emotion]??c.emotion:"",fx(c?.strength,2),fx(f?.oi15!=null?f.oi15*100:null,2),
    fx(f?.taker5,2),fx(f?.funding!=null?f.funding*100:null,4),fx(f?.atr5!=null&&f.last?f.atr5/f.last*100:null,2),x.market?MKT_CODE[x.market]??x.market:"",
    x.code.replace(/^LIVING_/,""),(x.env??"").replace(/[,;]/g,"")].join(",");
}
export type Case={v:1;id:string;at:number;sym:string;side:"LONG"|"SHORT";pb:string;pb_label:string;kind:"normal"|"fast";intent:string|null;
  strength:number|null;why:string;ev:CaseEv|null;market:MarketSample;env?:string|null;layer:Layer;reason:string;furthest:Layer;stages:CaseStage[];
  ref:number|null;seen:number;last:number;trade:CaseTrade|null};
export type CasePath={t0:number;step:60;ref:number;bps:string;minutes:number;missing:number;coarse:[number,number][]};
export type CaseOutcome={mfe:number|null;mae:number|null;mfe_min:number|null;mae_min:number|null;mae_before_mfe:number|null;
  r15:number|null;r30:number|null;r60:number|null;r120:number|null;r240:number|null;r360:number|null;hit_1pct_first:"UP"|"DOWN"|"SAME_MINUTE"|"NONE"|null;
  from_open:{mfe:number|null;mae:number|null;r60:number|null;r360:number|null}|null};
export type FinalCase=Case&{final:boolean;path:CasePath|null;out:CaseOutcome|null};

const day=(t:number)=>new Date(t).toISOString().slice(0,10);
const reasonKey=(s:string)=>s.replace(/[0-9]+(\.[0-9]+)?/g,"#").replace(/[+\-%]/g,"").slice(0,48);
const short=(s:string,n:number)=>s.length>n?s.slice(0,n):s;
const inc=(o:Record<string,number>,k:string,n=1)=>{o[k]=(o[k]??0)+n;};
const r2=(v:number)=>Math.round(v*100)/100;
const MARKET_KEY=(m:MarketSample)=>m?`${m.state}${m.side?`/${m.side}`:""}`:"NONE";

export class RunLog{
  boot:string;
  bucket:Bucket|null=null;
  /** Closed buckets not yet confirmed in D1, plus the in-memory history for the export. */
  closed:Bucket[]=[];
  private unsaved=new Set<string>();
  cases=new Map<string,Case>();
  private byKey=new Map<string,string>();
  daily={day:"",n:0,early:0,dropped:0};
  dirty=false;
  lastSampleMinute=0;
  constructor(now:number){this.boot=Math.floor(now/1000).toString(36);}

  private open(at:number):Bucket{
    const aligned=Math.floor(at/BUCKET_MS)*BUCKET_MS,start=this.wipedAt!=null&&this.wipedAt>aligned&&this.wipedAt<=at?this.wipedAt:aligned;
    return {v:1,id:`b:${start}:${this.boot}`,at:start,end:aligned+BUCKET_MS,boot:this.boot,minutes:0,gate:{},market:{},last:null,mode:null,fast:{},
      funnel:{},reasons:{},open:0,watches:0,opened:[],events:[],blocker:null,firstSampleAt:null,lastSampleAt:null};
  }
  private cur(now:number){
    if(this.bucket&&now>=this.bucket.end){this.seal(this.bucket);this.bucket=null;}
    if(!this.bucket)this.bucket=this.open(now);
    return this.bucket;
  }
  private seal(b:Bucket){
    b.blocker=blockerOf(b);this.closed.push(b);this.unsaved.add(b.id);
    if(this.closed.length>BUCKETS_KEPT){const gone=this.closed.splice(0,this.closed.length-BUCKETS_KEPT);for(const g of gone)this.unsaved.delete(g.id);}
  }
  /** Once a minute (the caller guards the minute). */
  sample(now:number,s:Sample){
    const minute=Math.floor(now/60_000);if(minute===this.lastSampleMinute)return false;this.lastSampleMinute=minute;
    const b=this.cur(now);
    b.minutes++;inc(b.gate,s.gate);inc(b.market,MARKET_KEY(s.market));inc(b.fast,s.fast);if(s.market?.env)inc(b.env??={},s.market.env);
    b.last=s.market;b.mode=s.mode;b.open=s.open;b.watches=s.watches;b.firstSampleAt??=now;b.lastSampleAt=now;
    return true;
  }
  count(now:number,layer:Layer|"reads"|"ideas"|"no_idea",reason?:string|null,n=1){
    const b=this.cur(now);inc(b.funnel,layer,n);
    if(reason&&layer!=="reads"&&layer!=="ideas")inc(b.reasons,`${layer}:${reasonKey(reason)}`,n);
  }
  event(now:number,k:string,text:string){
    const b=this.cur(now);if(b.events.length<12)b.events.push({at:now,k,text:short(text,160)});else inc(b.reasons,`EVENTS_DROPPED`);
  }
  /** burst-leader-v1: one special-condition check (once a minute, whatever the verdict). */
  burstCheck(now:number,c:{bar:number;z:number|null;breadth:number|null;b3:number|null;verdict:string}){
    const b=this.cur(now),hm=new Date(c.bar*1000).toISOString().slice(11,16),ok=(v:number|null):v is number=>v!=null&&Number.isFinite(v);
    const row=[hm,ok(c.z)?c.z.toFixed(1):"",ok(c.breadth)?String(Math.round(c.breadth*100)):"",ok(c.b3)?String(Math.round(c.b3*1e4)):"",c.verdict].join(",");
    b.burst=b.burst?`${b.burst};${row}`:row;
  }
  opened(now:number,o:{sym:string;side:string;pb:string;trade:string}){const b=this.cur(now);if(b.opened.length<20)b.opened.push({at:now,...o});}

  /** A candidate reached `layer`: counts it, and creates/updates its research case (deduped, capped). */
  noteCase(input:CaseInput,layer:Layer,reason:string){
    this.count(input.at,layer,reason);
    if(layer==="BUSY"||layer==="RANK")return null;
    const key=`${input.sym}|${input.side}|${input.pb}`,id=this.byKey.get(key),c=id?this.cases.get(id):undefined;
    const stage:CaseStage={at:input.at,layer,reason:short(reason,70),px:input.px};
    if(c&&input.at-c.at<=CASE_DEDUPE_MS){
      c.seen++;c.last=input.at;
      const prev=c.stages.at(-1);
      if(!prev||prev.layer!==layer){c.stages.push(stage);if(c.stages.length>6)c.stages.splice(1,c.stages.length-6);this.dirty=true;}
      if(DEPTH[layer]>DEPTH[c.furthest]){c.furthest=layer;this.dirty=true;}
      return c;
    }
    const d=day(input.at);if(this.daily.day!==d)this.daily={day:d,n:0,early:0,dropped:0};
    const prio=PRIORITY(layer);
    if(prio===1&&this.daily.early>=CASE_EARLY_DAILY_CAP||prio<3&&this.daily.n>=CASE_DAILY_CAP){this.daily.dropped++;return null;}
    if(this.activeCount()>=CASE_ACTIVE_CAP){
      if(prio<3){this.daily.dropped++;return null;}
      // a watch / trade / fast pick always gets a case: the newest early-layer case gives way
      const victim=[...this.cases.values()].filter(x=>!x.trade&&DEPTH[x.furthest]<7).sort((a,b)=>b.at-a.at)[0];
      if(!victim){this.daily.dropped++;return null;}
      this.drop(victim.id);
    }
    const nc:Case={v:1,id:`c:${input.sym}:${input.side[0]}:${input.pb}:${input.at}`,at:input.at,sym:input.sym,side:input.side,pb:input.pb,
      pb_label:input.pbLabel,kind:input.kind,intent:input.intent,strength:input.strength==null?null:Math.round(input.strength*1000)/1000,
      why:short(input.why,90),ev:input.ev,market:input.market,...(input.env?{env:input.env}:{}),layer,reason:short(reason,70),furthest:layer,stages:[stage],ref:input.px,seen:1,last:input.at,trade:null};
    this.cases.set(nc.id,nc);this.byKey.set(key,nc.id);this.daily.n++;if(prio===1)this.daily.early++;this.dirty=true;
    return nc;
  }
  /** The forward core opened a trade for this symbol/side (and playbook when known). */
  /** Once a minute per open living trade: append its holding read to the linked case's trade (review only). */
  holdRead(tradeId:string,now:number,openedAt:number,x:{coin:HoldReadCoin;h:number|null;market:string|null;code:string;env?:string|null}){
    let c:Case|undefined;const id=this.byTrade.get(tradeId);if(id)c=this.cases.get(id);
    if(!c||c.trade?.id!==tradeId){c=[...this.cases.values()].find(k=>k.trade?.id===tradeId);if(!c)return false;this.byTrade.set(tradeId,c.id);}
    const t=c.trade!,min=Math.max(0,Math.floor((now-openedAt)/60_000));
    const rows=t.hr?t.hr.split(";"):[];const last=rows.at(-1);
    if(last!=null&&Number(last.split(",")[0])>=min)return false;
    rows.push(holdReadRow(min,x));
    if(rows.length>HOLD_READ_MAX){const n=rows.length-HOLD_READ_MAX;rows.splice(0,n);t.hr_drop=(t.hr_drop??0)+n;}
    t.hr=rows.join(";");this.dirty=true;return true;
  }
  private byTrade=new Map<string,string>();
  linkTrade(sym:string,side:"LONG"|"SHORT",pb:string|null,t:CaseTrade){
    let best:Case|null=null;
    for(const c of this.cases.values())if(c.sym===sym&&c.side===side&&(!pb||c.pb===pb)&&!c.trade&&(!best||c.at>best.at))best=c;
    if(best){best.trade=t;if(DEPTH.OPENED>DEPTH[best.furthest])best.furthest="OPENED";best.stages.push({at:t.openedAt,layer:"OPENED",reason:"开出",px:t.entry});
      if(best.stages.length>6)best.stages.splice(1,best.stages.length-6);this.dirty=true;}
    return best;
  }
  closeTrade(id:string,x:{closedAt:number|null;exit:number|null;exitReason:string|null;netPnl:number|null}){
    for(const c of this.cases.values())if(c.trade?.id===id){Object.assign(c.trade,x);this.dirty=true;return c;}
    return null;
  }
  activeCount(){return this.cases.size;}
  private drop(id:string){const c=this.cases.get(id);if(!c)return;this.cases.delete(id);const key=`${c.sym}|${c.side}|${c.pb}`;if(this.byKey.get(key)===id)this.byKey.delete(key);this.dirty=true;}

  /** Buckets to upsert into D1 now: closed ones not yet confirmed + the current one (partial). */
  bucketsDue(now:number){
    this.cur(now);
    return [...this.closed.filter(b=>this.unsaved.has(b.id)),{...this.bucket!,blocker:blockerOf(this.bucket!)}];
  }
  bucketsSaved(ids:string[]){for(const id of ids)this.unsaved.delete(id);}
  /** Cases whose 6 h are over, with their path and outcome (built from the tape). */
  casesDue(now:number,tape:LivingTape,limit=40):FinalCase[]{
    const out:FinalCase[]=[];
    for(const c of [...this.cases.values()].sort((a,b)=>a.at-b.at)){
      if(now-c.at<CASE_FINAL_MS||out.length>=limit)break;
      if(c.trade&&c.trade.closedAt==null&&now-c.at<24*3_600_000)continue;// an open trade keeps its case until it closes (max 24 h)
      out.push(finalize(c,tape,now,true));
    }
    return out;
  }
  casesSaved(ids:string[]){for(const id of ids)this.drop(id);}
  /** Active cases with the path so far (export view). */
  activeView(now:number,tape:LivingTape){return[...this.cases.values()].sort((a,b)=>a.at-b.at).map(c=>finalize(c,tape,now,false));}
  // ---------------------------------------------------------------- own keys (paged)
  /** Last committed JSON of each case page (key -> json). A page is rewritten only when its content changed. */
  private pageSig=new Map<string,string>();
  private pendingSig=new Map<string,string>();
  /**
   * Active case headers split over up to CASE_PAGES keys (each ≤ CASES_BYTES). Only when all pages are full is text
   * trimmed and, last, the oldest early-layer case dropped — before this, one key's cap evicted cases hours before
   * they could finish their 6 h and reach D1. Returns only the pages that changed (an emptied page is written empty).
   */
  values():Record<string,unknown>{
    const cases=[...this.cases.values()].sort((a,b)=>a.at-b.at);
    let pages=packCases(cases),guard=0;
    while(!pages&&guard++<200){
      const early=cases.filter(c=>DEPTH[c.furthest]<7);
      const long=early.find(c=>c.why.length>30||c.stages.length>2);
      if(long){long.why=short(long.why,30);long.stages=[long.stages[0]!,...long.stages.slice(-1)];}
      else{const victim=early[0]??cases[0];if(!victim)break;cases.splice(cases.indexOf(victim),1);this.drop(victim.id);}
      pages=packCases(cases);
    }
    pages??=[cases.slice(-1)];
    const out:Record<string,unknown>={};this.pendingSig.clear();
    for(let i=0;i<CASE_PAGES;i++){
      const key=casePageKey(i),xs=pages[i]??[];
      const v=i===0?{v:1 as const,boot:this.boot,daily:this.daily,pages:pages.length,cases:xs}:{v:1 as const,cases:xs};
      const sig=JSON.stringify(v),prev=this.pageSig.get(key);
      if(prev!==sig&&!(i>0&&prev==null&&!xs.length)){out[key]=v;this.pendingSig.set(key,sig);}
    }
    if(!Object.keys(out).length)this.dirty=false;
    return out;
  }
  /** The put of these keys succeeded. */
  committed(keys:string[]){
    for(const k of keys){const sig=this.pendingSig.get(k);if(sig!=null){this.pageSig.set(k,sig);this.pendingSig.delete(k);}}
    if(!this.pendingSig.size)this.dirty=false;
  }
  /** Back-compat single value (page 0 only); tests and old callers. */
  value(){return this.values()[CASES_KEY]??{v:1,boot:this.boot,daily:this.daily,cases:[]};}
  /** Restore from page 0 (old single key) plus the extra pages. */
  restore(value:unknown,now:number,extra:unknown[]=[]){
    const head=value as {v?:number;daily?:RunLog["daily"];cases?:Case[]}|undefined;
    const all=[value,...extra];
    all.forEach((raw,i)=>{const v=raw as {v?:number;cases?:Case[]}|undefined;if(v?.v===1&&Array.isArray(v.cases))this.pageSig.set(casePageKey(i),JSON.stringify(v));});
    for(const raw of all){
      const v=raw as {v?:number;cases?:Case[]}|undefined;if(v?.v!==1||!Array.isArray(v.cases))continue;
      for(const c of v.cases){if(!c||typeof c.id!=="string"||!(c.at>0)||now-c.at>48*3_600_000)continue;this.cases.set(c.id,c);this.byKey.set(`${c.sym}|${c.side}|${c.pb}`,c.id);}
    }
    if(head?.v===1&&head.daily&&head.daily.day===day(now))this.daily={...this.daily,...head.daily};
    return this.cases.size;
  }
  /** Run-log wipe: forget every case, closed bucket and counter; recording continues from `now` in a fresh bucket. */
  wipe(now:number){
    const n={cases:this.cases.size,buckets:this.closed.length+(this.bucket?1:0)};
    this.cases.clear();this.byKey.clear();this.closed=[];this.unsaved.clear();this.bucket=null;
    this.daily={day:day(now),n:0,early:0,dropped:0};this.dirty=true;this.lastSampleMinute=0;this.wipedAt=now;
    return n;
  }
  /** Set by wipe(): the first bucket after a wipe starts at the wipe time, not at the 10-minute boundary before it. */
  wipedAt:number|null=null;
}

/** The single most important reason this bucket did not open (Chinese, for a reviewer). */
export function blockerOf(b:Bucket):string|null{
  if(b.opened.length)return`开了 ${b.opened.length} 笔`;
  if(!b.minutes)return"没有采样（程序停了）";
  const g=Object.entries(b.gate).sort((x,y)=>y[1]-x[1])[0];
  // compute-only / fallback still runs the whole funnel: say the mode, then what the funnel stopped
  const soft=g&&(g[0]==="COMPUTE_ONLY"||g[0]==="FALLBACK")&&g[1]*2>=b.minutes?`${GATE_LABEL[g[0] as Gate]}（${g[1]}/${b.minutes} 分钟）；`:"";
  if(g&&g[0]!=="OPEN"&&!soft&&g[1]*2>=b.minutes)return`${GATE_LABEL[g[0] as Gate]??g[0]}（${g[1]}/${b.minutes} 分钟）`;
  return soft+funnelBlocker(b);
}
function funnelBlocker(b:Bucket):string{
  const f=b.funnel,layers=Object.entries(f).filter(([k])=>k in DEPTH&&k!=="OPENED"&&k!=="WATCH"&&k!=="FAST_PICK").sort((x,y)=>y[1]-x[1]);
  if(!(f.ideas??0)&&!(f.FAST_PICK??0)){
    const top=Object.entries(b.reasons).filter(([k])=>k.startsWith("no_idea:")).sort((x,y)=>y[1]-x[1])[0];
    return(f.reads??0)?`读了 ${f.reads} 次币，没有一个有打法想法${top?`（最多的是：${top[0].slice(8)}）`:""}`:"这段没有读币（研究层没在找机会）";
  }
  const top=layers[0];
  if(!top)return(f.WATCH??0)?"在等位置，位置还没到":"有想法但都没走到下一层";
  const why=Object.entries(b.reasons).filter(([k])=>k.startsWith(`${top[0]}:`)).sort((x,y)=>y[1]-x[1])[0];
  return`${LAYER_LABEL[top[0] as Layer]}（${top[1]} 次）${why?`：${why[0].slice(top[0].length+1)}`:""}`;
}

/** Minute path from the tape: 1m bars, 5m bars where the 1m bars are gone (marked coarse), empty where nothing exists. */
export function buildPath(tape:LivingTape,sym:string,t0:number,ref:number,minutes:number):CasePath{
  const start=Math.floor(t0/60_000)*60;// seconds, minute of the decision
  const m1=new Map<number,MidBar>();for(const r of tape.m1.get(sym)??[])if(r.time>=start&&r.time<start+minutes*60)m1.set(r.time,r);
  const m5=new Map<number,MidBar>();for(const r of tape.m5.get(sym)??[])if(r.time+300>start&&r.time<start+minutes*60)m5.set(r.time,r);
  const parts:string[]=[],coarse:[number,number][]=[];let missing=0;
  const bp=(x:number)=>Math.round((x/ref-1)*1e4);
  for(let i=0;i<minutes;i++){
    const t=start+i*60,a=m1.get(t);
    if(a){parts.push(`${bp(a.close)},${bp(a.high)},${bp(a.low)}`);continue;}
    const b=m5.get(Math.floor(t/300)*300);
    if(b){parts.push(`${bp(b.close)},${bp(b.high)},${bp(b.low)}`);const last=coarse.at(-1);if(last&&last[1]===i-1)last[1]=i;else coarse.push([i,i]);continue;}
    parts.push("");missing++;
  }
  // trailing minutes that have not happened yet are not "missing"
  while(parts.length&&parts.at(-1)===""){parts.pop();missing--;}
  return {t0:start*1000,step:60,ref,bps:parts.join(";"),minutes:parts.length,missing:Math.max(0,missing),coarse};
}
export function decodePath(p:Pick<CasePath,"bps">):([number,number,number]|null)[]{
  if(!p.bps)return[];
  return p.bps.split(";").map(x=>{if(!x)return null;const [c,h,l]=x.split(",").map(Number);return [c!,h!,l!];});
}
/** Outcome in the case's direction (price %, not ROE). `fromMin`: start minute (e.g. the trade's open). */
export function outcome(p:CasePath,side:"LONG"|"SHORT",fromMin=0,fromRef?:number):Omit<CaseOutcome,"from_open">{
  const rows=decodePath(p),d=side==="LONG"?1:-1,base=fromRef??p.ref,k=p.ref/base;
  const move=(bps:number)=>d*((1+bps/1e4)*k-1)*100;
  let mfe:number|null=null,mae:number|null=null,mfeMin:number|null=null,maeMin:number|null=null,maeAtMfe:number|null=null,first:"UP"|"DOWN"|"SAME_MINUTE"|null=null;
  let worst=0;
  for(let i=fromMin;i<rows.length;i++){const r=rows[i];if(!r)continue;
    const fav=d>0?move(r[1]):move(r[2]),adv=d>0?move(r[2]):move(r[1]);
    worst=Math.min(worst,adv);
    if(mfe==null||fav>mfe){mfe=fav;mfeMin=i-fromMin;maeAtMfe=worst;}
    if(mae==null||adv<mae){mae=adv;maeMin=i-fromMin;}
    if(!first){if(fav>=1&&adv<=-1)first="SAME_MINUTE";else if(fav>=1)first="UP";else if(adv<=-1)first="DOWN";}
  }
  const at=(m:number)=>{const i=fromMin+m-1;if(i>=rows.length)return null;for(let j=i;j>=Math.max(fromMin,i-4);j--){const r=rows[j];if(r)return r2(move(r[0]));}return null;};
  return {mfe:mfe==null?null:r2(mfe),mae:mae==null?null:r2(mae),mfe_min:mfeMin,mae_min:maeMin,mae_before_mfe:maeAtMfe==null?null:r2(maeAtMfe),
    r15:at(15),r30:at(30),r60:at(60),r120:at(120),r240:at(240),r360:at(360),
    hit_1pct_first:mfe==null?null:first??"NONE"};
}
function finalize(c:Case,tape:LivingTape,now:number,final:boolean):FinalCase{
  const ref=c.ref??tape.m1.get(c.sym)?.find(r=>r.time*1000>=Math.floor(c.at/60_000)*60_000)?.open??null;
  if(!ref||!(ref>0))return {...c,final,path:null,out:null};
  const mins=Math.min(CASE_PATH_MIN,Math.max(0,Math.floor((now-Math.floor(c.at/60_000)*60_000)/60_000)));
  const path=buildPath(tape,c.sym,c.at,ref,mins);
  const o=outcome(path,c.side);
  let fromOpen:CaseOutcome["from_open"]=null;
  if(c.trade&&c.trade.entry&&c.trade.openedAt>=c.at){
    const m=Math.floor((c.trade.openedAt-Math.floor(c.at/60_000)*60_000)/60_000);const f=outcome(path,c.side,m,c.trade.entry);
    fromOpen={mfe:f.mfe,mae:f.mae,r60:f.r60,r360:f.r360};
  }
  return {...c,final,path,out:{...o,from_open:fromOpen}};
}

/** Per playbook × furthest layer: how the ideas actually moved (price %, in the case's direction). */
export function caseStats(cases:FinalCase[]){
  const groups=new Map<string,FinalCase[]>();
  for(const c of cases){if(!c.out||c.out.mfe==null)continue;const k=`${c.pb}|${c.furthest}`;const xs=groups.get(k)??[];xs.push(c);groups.set(k,xs);}
  const med=(xs:number[])=>{const a=xs.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?r2(a.length%2?a[a.length>>1]!:(a[a.length/2-1]!+a[a.length/2]!)/2):null;};
  const avg=(xs:(number|null)[])=>{const a=xs.filter((x):x is number=>x!=null);return a.length?r2(a.reduce((n,x)=>n+x,0)/a.length):null;};
  return [...groups.entries()].map(([k,xs])=>{const [pb,furthest]=k.split("|");
    return {pb,pb_label:xs[0]!.pb_label,furthest,furthest_label:LAYER_LABEL[furthest as Layer]??furthest,n:xs.length,final:xs.filter(x=>x.final).length,
      avg_r60:avg(xs.map(x=>x.out!.r60)),avg_r360:avg(xs.map(x=>x.out!.r360)),med_mfe:med(xs.map(x=>x.out!.mfe!)),med_mae:med(xs.map(x=>x.out!.mae!)),
      up_1pct_first:r2(xs.filter(x=>x.out!.hit_1pct_first==="UP").length/xs.length),down_1pct_first:r2(xs.filter(x=>x.out!.hit_1pct_first==="DOWN").length/xs.length)};
  }).sort((a,b)=>b.n-a.n);
}
/** Window summary for "why no trades": gate minutes, funnel totals, top reasons, last open and the longest stretch without one. */
export function whyNoTrades(buckets:Bucket[],now:number){
  const gate:Record<string,number>={},funnel:Record<string,number>={},reasons:Record<string,number>={};let minutes=0,lastOpen:number|null=null;
  const sorted=[...buckets].sort((a,b)=>a.at-b.at);
  for(const b of sorted){minutes+=b.minutes;for(const [k,v] of Object.entries(b.gate))inc(gate,k,v);for(const [k,v] of Object.entries(b.funnel))inc(funnel,k,v);
    for(const [k,v] of Object.entries(b.reasons))inc(reasons,k,v);for(const o of b.opened)lastOpen=Math.max(lastOpen??0,o.at);}
  // longest stretch of buckets with no open
  let best:{from:number;to:number;buckets:Bucket[]}|null=null,run:Bucket[]=[];
  const flush=()=>{if(run.length&&(!best||run.at(-1)!.end-run[0]!.at>best.to-best.from))best={from:run[0]!.at,to:run.at(-1)!.end,buckets:run};run=[];};
  for(const b of sorted){if(b.opened.length)flush();else run.push(b);}flush();
  let stretch=null as null|{from:number;to:number;hours:number;main:string|null;gate:Record<string,number>};
  if(best){const b=best as {from:number;to:number;buckets:Bucket[]};const merged=mergeBuckets(b.buckets);
    stretch={from:b.from,to:Math.min(b.to,now),hours:r2((Math.min(b.to,now)-b.from)/3_600_000),main:blockerOf(merged),gate:merged.gate};}
  return {from:sorted[0]?.at??null,to:now,minutes,gate_minutes:gate,gate_labels:GATE_LABEL,funnel,layer_labels:LAYER_LABEL,
    // what stopped ideas (the actionable part), and separately why most coins had no idea at all
    top_reasons:Object.entries(reasons).filter(([k])=>!k.startsWith("no_idea:")).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([k,n])=>({reason:k,n})),
    no_idea_reasons:Object.entries(reasons).filter(([k])=>k.startsWith("no_idea:")).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,n])=>({reason:k.slice(8),n})),last_open_at:lastOpen,longest_no_open:stretch};
}
/** Merge several bucket rows into one (same window from two boots, or a whole stretch). */
export function mergeBuckets(rows:Bucket[]):Bucket{
  const sorted=[...rows].sort((a,b)=>a.at-b.at||(a.lastSampleAt??0)-(b.lastSampleAt??0)),first=sorted[0]!,lastRow=sorted.at(-1)!;
  const m:Bucket={...structuredClone(first),env:undefined,gate:{},market:{},fast:{},funnel:{},reasons:{},opened:[],events:[],minutes:0,end:Math.max(...sorted.map(r=>r.end))};
  for(const r of sorted){m.minutes+=r.minutes;for(const [k,v] of Object.entries(r.gate))inc(m.gate,k,v);for(const [k,v] of Object.entries(r.market))inc(m.market,k,v);
    for(const [k,v] of Object.entries(r.fast))inc(m.fast,k,v);for(const [k,v] of Object.entries(r.funnel))inc(m.funnel,k,v);for(const [k,v] of Object.entries(r.reasons))inc(m.reasons,k,v);
    if(r.env)for(const [k,v] of Object.entries(r.env))inc(m.env??={},k,v);
    m.opened.push(...r.opened);m.events.push(...r.events);}
  m.last=lastRow.last;m.open=lastRow.open;m.watches=lastRow.watches;m.mode=lastRow.mode;m.lastSampleAt=lastRow.lastSampleAt;
  m.boot=[...new Set(sorted.map(r=>r.boot))].join(",");m.events=m.events.slice(0,24);m.blocker=blockerOf(m);
  return m;
}
